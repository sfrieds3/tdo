/**
 * Tracker configuration: the repo's committed `.tdo/config.json` `tracker` block, merged with the
 * user's `projects.<key>.tracker` overrides, normalized, and checked against the user's approval.
 */
import { canonicalJson, normalizeTag, projectFromKey, readConfigLayer, readRepoConfig, sha256, updateConfig, type Config, type Item, type Project, type Status } from "../core.ts";

export const PROVIDERS = ["github"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const MODES = ["manual", "auto-on-tag"] as const;
export type Mode = (typeof MODES)[number];

/** What one source (repo file or user entry) may set. Every key optional. */
export type TrackerOverride = { provider?: Provider; repo?: string; mode?: Mode; tag?: string; labels?: string[]; closeOnDone?: boolean };

export type Approval = "approved" | "unapproved" | "changed" | "user-only";

export type EffectiveTracker = {
  provider: Provider;
  /** `host/owner/repo` new issues go to. */
  destination: string;
  mode: Mode;
  tag: string;
  labels: string[];
  closeOnDone: boolean;
  origin: "repo" | "user" | "both";
  approval: Approval;
  /** Hash of the repo block that `tdo tracker approve` records; undefined for user-only trackers. */
  hash?: string;
  /** Which source set each key, for `tracker status`. */
  sources: Partial<Record<keyof TrackerOverride, "repo" | "user">>;
};

export type TrackerResolution =
  | { kind: "none" }
  | { kind: "disabled" }
  | { kind: "invalid"; error: string }
  | { kind: "ok"; tracker: EffectiveTracker };

const DEFAULTS = { mode: "manual" as Mode, tag: "issue", labels: [] as string[], closeOnDone: true };
const REPO = /^(?:([A-Za-z0-9.-]+\.[A-Za-z]{2,}(?::\d+)?)\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

/** `OWNER/REPO` or `HOST/OWNER/REPO` → `host/owner/repo` (github.com when no host). */
export function normalizeDestination(value: string): string | undefined {
  const match = REPO.exec(value.trim().replace(/\.git$/i, ""));
  if (!match) return undefined;
  return `${(match[1] ?? "github.com").toLowerCase()}/${match[2]}/${match[3]}`;
}

/** Validates one source. Unknown keys are dropped so they never change behavior or the hash. */
export function parseOverride(value: unknown, where: string): TrackerOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: "tracker" must be an object${where.includes(".tdo") ? "" : " or false"}.`);
  const raw = value as Record<string, unknown>;
  const out: TrackerOverride = {};
  const fail = (key: string, expected: string) => { throw new Error(`${where}: tracker.${key} must be ${expected}.`); };
  if (raw.provider !== undefined) {
    if (!(PROVIDERS as readonly unknown[]).includes(raw.provider)) fail("provider", `one of: ${PROVIDERS.join(", ")}`);
    out.provider = raw.provider as Provider;
  }
  if (raw.repo !== undefined) {
    if (typeof raw.repo !== "string" || !normalizeDestination(raw.repo)) fail("repo", "OWNER/REPO or HOST/OWNER/REPO");
    out.repo = (raw.repo as string).trim();
  }
  if (raw.mode !== undefined) {
    if (!(MODES as readonly unknown[]).includes(raw.mode)) fail("mode", `one of: ${MODES.join(", ")}`);
    out.mode = raw.mode as Mode;
  }
  if (raw.tag !== undefined) {
    const tag = typeof raw.tag === "string" ? normalizeTag(raw.tag) : undefined;
    if (!tag) fail("tag", "a non-empty tag");
    out.tag = tag;
  }
  if (raw.labels !== undefined) {
    if (!Array.isArray(raw.labels) || !raw.labels.every((label) => typeof label === "string" && label.trim())) fail("labels", "an array of non-empty strings");
    out.labels = (raw.labels as string[]).map((label) => label.trim());
  }
  if (raw.closeOnDone !== undefined) {
    if (typeof raw.closeOnDone !== "boolean") fail("closeOnDone", "a boolean");
    out.closeOnDone = raw.closeOnDone as boolean;
  }
  return out;
}

/** Where issues go when `repo` is unset: the project key, if it is `github.com/OWNER/REPO`. Other hosts must set `repo`. */
function defaultDestination(project: Project): string | undefined {
  const match = /^github\.com\/([^/]+)\/([^/]+)$/i.exec(project.key);
  return match ? `github.com/${match[1]}/${match[2]}` : undefined;
}

function resolveDestination(override: TrackerOverride, project: Project): string {
  const destination = override.repo ? normalizeDestination(override.repo) : defaultDestination(project);
  if (!destination) throw new Error(`can't derive a GitHub repo from project ${project.key}; set tracker.repo.`);
  return destination;
}

/** The value approval pins: the repo block with defaults applied and its destination resolved. */
export function approvalHash(repo: TrackerOverride, project: Project): string {
  const provider = repo.provider ?? "github";
  return sha256(canonicalJson({
    provider,
    destination: resolveDestination(repo, project),
    mode: repo.mode ?? DEFAULTS.mode,
    tag: repo.tag ?? DEFAULTS.tag,
    labels: [...(repo.labels ?? DEFAULTS.labels)].sort(),
    closeOnDone: repo.closeOnDone ?? DEFAULTS.closeOnDone,
  }));
}

type UserEntry = { override?: TrackerOverride; approved?: string; disabled: boolean };

function userEntry(config: Config, project: Project, where: string): UserEntry {
  const raw = config.projects?.[project.key]?.tracker;
  if (raw === undefined) return { disabled: false };
  if (raw === false) return { disabled: true };
  const approved = (raw as { approved?: unknown })?.approved;
  if (approved !== undefined && typeof approved !== "string") throw new Error(`${where}: tracker.approved must be a string.`);
  const override = parseOverride(raw, where);
  // An approval-only entry (from `tdo tracker approve`) is not an override.
  return { override: Object.keys(override).length ? override : undefined, approved: approved as string | undefined, disabled: false };
}

/** Merges repo and user tracker config for a project. Never throws; problems come back as `invalid`. */
export function resolveTracker(project: Project, config: Config, options: { configPath?: string } = {}): TrackerResolution {
  try {
    const repoConfig = project.root ? readRepoConfig(project.root) : undefined;
    const user = userEntry(config, project, options.configPath ?? "config");
    if (user.disabled) return { kind: "disabled" };
    const repo = repoConfig?.tracker !== undefined ? parseOverride(repoConfig.tracker, repoConfig.file) : undefined;
    if (!repo && !user.override) return { kind: "none" };
    const merged: TrackerOverride = { ...repo, ...user.override };
    if (!merged.provider) throw new Error("tracker.provider is required.");
    const sources: EffectiveTracker["sources"] = {};
    for (const key of Object.keys(merged) as (keyof TrackerOverride)[]) sources[key] = user.override && key in user.override ? "user" : "repo";
    const hash = repo ? approvalHash(repo, project) : undefined;
    const approval: Approval = !repo ? "user-only" : user.approved === hash ? "approved" : user.approved ? "changed" : "unapproved";
    return {
      kind: "ok",
      tracker: {
        provider: merged.provider,
        destination: resolveDestination(merged, project),
        mode: merged.mode ?? DEFAULTS.mode,
        tag: merged.tag ?? DEFAULTS.tag,
        labels: merged.labels ?? DEFAULTS.labels,
        closeOnDone: merged.closeOnDone ?? DEFAULTS.closeOnDone,
        origin: repo && user.override ? "both" : repo ? "repo" : "user",
        approval,
        hash,
        sources,
      },
    };
  } catch (error) {
    return { kind: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

export function isApproved(tracker: EffectiveTracker): boolean {
  return tracker.approval === "approved" || tracker.approval === "user-only";
}

/** Records approval of the current repo block (`hash`), or removes it (`undefined`). Preserves everything else. */
export function setApproval(raw: Record<string, unknown>, projectKey: string, hash: string | undefined): Record<string, unknown> {
  const projects = { ...(raw.projects as Record<string, Record<string, unknown>> | undefined) };
  const entry = { ...projects[projectKey] };
  const tracker = { ...(entry.tracker as Record<string, unknown> | undefined) };
  if (hash) tracker.approved = hash;
  else delete tracker.approved;
  if (Object.keys(tracker).length) entry.tracker = tracker;
  else delete entry.tracker;
  if (Object.keys(entry).length) projects[projectKey] = entry;
  else delete projects[projectKey];
  const { projects: _previous, ...rest } = raw;
  return Object.keys(projects).length ? { ...rest, projects } : rest;
}

/**
 * Saves (`hash`) or revokes (`undefined`) an approval. Approvals are machine state, so they live in
 * `config.local.json`; a revoke also clears any legacy approval in `config.json`, which is only
 * rewritten when it actually holds one.
 */
export function saveApproval(projectKey: string, hash: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  updateConfig((raw) => setApproval(raw, projectKey, hash), env, undefined, { local: true });
  if (hash) return;
  const main = readConfigLayer("main", env) as { projects?: Record<string, { tracker?: unknown }> } | undefined;
  const tracker = main?.projects?.[projectKey]?.tracker;
  if (tracker && typeof tracker === "object" && "approved" in tracker) updateConfig((raw) => setApproval(raw, projectKey, undefined), env);
}

/** Foreign links need their own known user policy; approval hashes imply missing repository policy. */
export function statusPolicy(item: Item, current: string, status: Status, resolution: TrackerResolution, config: Config): boolean {
  if (item.project === current) return resolution.kind === "ok" ? resolution.tracker.closeOnDone : true;
  if (status === "doing" || !item.links.some((link) => ["open", "closed"].includes(link.state))) return false;
  const raw = config.projects?.[item.project]?.tracker;
  const foreign = resolveTracker(projectFromKey(item.project), config);
  if (raw && typeof raw === "object" && !("approved" in raw) && foreign.kind === "ok") return foreign.tracker.closeOnDone;
  throw new Error(`${item.project}#${item.id}: tracker lifecycle policy is unknown; run from its project checkout or configure project tracker in your user config.`);
}
