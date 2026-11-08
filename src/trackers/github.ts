/** GitHub issues through the `gh` CLI. Arguments are passed as an array (never a shell); bodies go on stdin. */
import { spawnSync } from "node:child_process";
import type { IssueUpdate, NewIssue, Tracker, TrackerResult } from "./types.ts";

export const GH_TIMEOUT_MS = 10_000;

export type GhOptions = { destination: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };

type Run = { status: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException; signal: NodeJS.Signals | null };

function gh(args: string[], options: GhOptions, input?: string): Run {
  const result = spawnSync("gh", args, {
    input,
    encoding: "utf8",
    env: { ...(options.env ?? process.env), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
    timeout: options.timeoutMs ?? GH_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error as NodeJS.ErrnoException | undefined, signal: result.signal };
}

function describe(run: Run): string {
  if (run.error) return run.error.message;
  const detail = run.stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
  return `gh exited ${run.status ?? run.signal}${detail ? `: ${detail}` : ""}`;
}

const ISSUE_URL = /^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?$/;

export function parseGithubIssueUrl(url: string): { destination: string; id: string } | undefined {
  const match = ISSUE_URL.exec(url.trim());
  return match ? { destination: `${match[1]!.toLowerCase()}/${match[2]}/${match[3]}`, id: match[4]! } : undefined;
}

export function githubTracker(options: GhOptions): Tracker {
  const [host] = options.destination.split("/");
  const repo = options.destination;
  const sameRepo = (destination: string) => destination.toLowerCase() === repo.toLowerCase();

  function check(): TrackerResult<void> {
    const auth = gh(["auth", "status", "--hostname", host!], options);
    if (auth.error?.code === "ENOENT") return { ok: false, kind: "attention", message: "gh is not installed; see https://cli.github.com" };
    if (auth.error || auth.status !== 0) return { ok: false, kind: "attention", message: `gh is not authenticated for ${host} (run \`gh auth login --hostname ${host}\`): ${describe(auth)}` };
    return { ok: true, value: undefined };
  }

  function failure(run: Run): TrackerResult<never> {
    const message = describe(run);
    const rateLimit = /rate.?limit|429/i.test(run.stderr);
    const attention = run.error?.code === "ENOENT" || /auth|not logged|permission|forbidden|not found|could not resolve to a (?:repository|issue)|could not find (?:issue|repository)|404|401|403|transferred|deleted/i.test(run.stderr);
    return { ok: false, kind: !rateLimit && attention ? "attention" : "retryable", message };
  }

  function mutate(args: string[], body?: string): TrackerResult<void> {
    const run = gh(["issue", ...args, "--repo", repo], options, body);
    return !run.error && run.status === 0 ? { ok: true, value: undefined } : failure(run);
  }

  /** The repository's label names, keyed by lowercase (GitHub label names are case-insensitive). */
  function repoLabels(): TrackerResult<Map<string, string>> {
    const run = gh(["label", "list", "--repo", repo, "--json", "name", "--limit", "10000"], options);
    if (run.error || run.status !== 0) return failure(run);
    try {
      const names = (JSON.parse(run.stdout) as { name: string }[]).map((label) => label.name);
      return { ok: true, value: new Map(names.map((name) => [name.toLowerCase(), name])) };
    } catch {
      return { ok: false, kind: "retryable", message: `unexpected gh label list output: ${JSON.stringify(run.stdout.trim().slice(0, 200))}` };
    }
  }

  /** Creates any of `wanted` the repository lacks. Runs before the issue call, so failures never make a create uncertain. */
  function ensureLabels(wanted: string[], existing: Map<string, string>): TrackerResult<void> {
    for (const label of wanted) {
      if (existing.has(label.toLowerCase())) continue;
      const run = gh(["label", "create", label, "--repo", repo, "--description", "Synced from tdo tags"], options);
      // Losing a race with another creator is fine; the label exists either way.
      if ((run.error || run.status !== 0) && !/already exists/i.test(run.stderr)) return failure(run);
      existing.set(label.toLowerCase(), label);
    }
    return { ok: true, value: undefined };
  }

  function update(id: string, issue: IssueUpdate): TrackerResult<void> {
    const add = issue.addLabels ?? [];
    let remove = issue.removeLabels ?? [];
    if (add.length || remove.length) {
      const existing = repoLabels();
      if (!existing.ok) return existing;
      const ensured = ensureLabels(add, existing.value);
      if (!ensured.ok) return ensured;
      // gh refuses to remove a label the repository no longer has; it's already gone from the issue.
      remove = remove.filter((label) => existing.value.has(label.toLowerCase()));
    }
    return mutate(["edit", id, "--title", issue.title, "--body-file", "-", ...add.flatMap((label) => ["--add-label", label]), ...remove.flatMap((label) => ["--remove-label", label])], issue.body);
  }

  return {
    update,
    close: (id, reason) => mutate(["close", id, "--reason", reason]),
    reopen: (id) => mutate(["reopen", id]),
    comment: (id, body) => mutate(["comment", id, "--body-file", "-"], body),
    provider: "github",
    check,
    parseIssueUrl: parseGithubIssueUrl,
    create(issue: NewIssue) {
      // Everything before `issue create` is known not to create anything; everything after is uncertain
      // unless gh hands back this repo's issue URL.
      const preflight = check();
      if (!preflight.ok) return preflight;
      if (issue.labels.length) {
        const existing = repoLabels();
        if (!existing.ok) return existing;
        const ensured = ensureLabels(issue.labels, existing.value);
        if (!ensured.ok) return ensured;
      }
      const args = ["issue", "create", "--repo", repo, "--title", issue.title, "--body-file", "-", ...issue.labels.flatMap((label) => ["--label", label])];
      const run = gh(args, options, issue.body);
      if (run.error?.code === "ENOENT") return { ok: false, kind: "attention", message: "gh is not installed; see https://cli.github.com" };
      if (run.error || run.status !== 0) return { ok: false, kind: "uncertain", message: describe(run) };
      const url = run.stdout.trim().split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
      const parsed = parseGithubIssueUrl(url);
      if (!parsed || !sameRepo(parsed.destination)) return { ok: false, kind: "uncertain", message: `unexpected gh output: ${JSON.stringify(run.stdout.trim().slice(0, 200))}` };
      return { ok: true, value: { id: parsed.id, url } };
    },
  };
}
