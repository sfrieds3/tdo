/**
 * tdo — per-project "fix later" backlog stored in SQLite.
 *
 * Shared by the `tdo` CLI (src/cli.ts) and the Pi extension (extensions/tdo.ts); agents use the CLI via skills/tdo.
 * Uses only erasable TypeScript syntax so Node can run it directly with type stripping.
 */
import type { AutoIntent } from "./trackers/auto.ts";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type * as Sqlite from "node:sqlite";
import { transaction } from "./transaction.ts";
import { enqueueLinked, enqueueOp, queueCounts } from "./link-ops.ts";
import { promisify } from "node:util";
import { migrateDb } from "./migrations/index.ts";
import { parseGithubIssueUrl } from "./trackers/github.ts";

type DatabaseSync = Sqlite.DatabaseSync;

/**
 * Loads node:sqlite without its one-time ExperimentalWarning (printed on Node < 23.4),
 * which would otherwise end up on stderr of every CLI call. Other warnings pass through.
 */
function loadSqlite(): typeof Sqlite {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning?.message;
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type ?? (warning as Error)?.name;
    if (type === "ExperimentalWarning" && /SQLite/i.test(String(message))) return;
    return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)("node:sqlite") as typeof Sqlite;
  } finally {
    process.emitWarning = emitWarning;
  }
}

const { DatabaseSync } = loadSqlite();

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const STATUSES = ["open", "doing", "done", "dropped"] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_FILTERS = ["active", "closed", "all", ...STATUSES] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

/** Identifies an item: its project's UUID plus the per-project number. */
export type ItemKey = { projectId: string; id: number };

/** A note on an item: a status-change note (`done -m`) or a plain one (`tdo note`). Append-only. */
export type Note = { seq: number; status: Status | null; body: string; createdAt: string };

export const LINK_STATES = ["awaiting-approval", "creating", "unknown", "pending", "open", "closed", "error"] as const;
export type LinkState = (typeof LINK_STATES)[number];

/** An item's issue on an external tracker. The destination is fixed when the link is first claimed. */
export type Link = {
  provider: string;
  /** `host/owner/repo` the issue lives in. */
  destination: string;
  state: LinkState;
  /** Issue number once created. */
  externalId: string | null;
  url: string | null;
  error: string | null;
  claimedAt: string | null;
  createdAt: string;
  syncedAt: string | null;
  /** Labels tdo itself applied to the issue; null when unknown (filed before tag sync or attached). */
  labels: string[] | null;
  queued: number;
  attention: number;
  syncError: string | null;
};

/** A `creating` link older than this is treated as an interrupted attempt with an unknown outcome. */
export const LINK_STALE_MS = 2 * 60_000;

export type Item = {
  /** Per-project item number, as shown in `#3`. */
  id: number;
  /** UUID of the item's project; with `id`, the item's primary key. */
  projectId: string;
  /** The project's key, e.g. `github.com/owner/repo`. */
  project: string;
  title: string;
  body: string | null;
  priority: Priority;
  status: Status;
  tags: string[];
  fileRef: string | null;
  source: string | null;
  sessionId: string | null;
  host: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Oldest first. */
  notes: Note[];
  links: Link[];
};

export type Project = { key: string; name: string; root?: string };

export type NewItem = {
  project: Project | string;
  title: string;
  body?: string;
  priority?: Priority;
  tags?: string[];
  fileRef?: string;
  source?: string;
  sessionId?: string;
  host?: string;
  /** Added by a person at a terminal (not an agent or script); gates automatic issue filing. */
  createdByHuman?: boolean;
};

export type ItemPatch = {
  title?: string;
  body?: string | null;
  priority?: Priority;
  addTags?: string[];
  removeTags?: string[];
  fileRef?: string | null;
};

export type ListFilter = {
  /** Project key; omit to list across all projects. */
  project?: string;
  status?: StatusFilter;
  tags?: string[];
  /** Include this priority and anything more urgent. */
  minPriority?: Priority;
  query?: string;
  /** Maximum rows (default 500); 0 returns all matching rows. */
  limit?: number;
  /** Only items with a tracker link. */
  linked?: boolean;
  awaiting?: boolean;
};

export const DEFAULT_LIST_LIMIT = 500;
export const LIST_TRUNCATED = "… more items (use -n 0 to show all, or -s / -q to narrow)";

const MAX_TITLE_CHARS = 200;

// ---------------------------------------------------------------------------
// Parsing helpers

export function parsePriority(value: unknown): Priority | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return PRIORITIES[value];
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (!text) return undefined;
  if (/^[0-3]$/.test(text)) return PRIORITIES[Number(text)];
  return PRIORITIES.find((name) => name === text) ?? PRIORITIES.find((name) => name.startsWith(text));
}

export function requirePriority(value: unknown): Priority {
  const priority = parsePriority(value);
  if (!priority) throw new Error(`priority must be one of: ${PRIORITIES.join(", ")}.`);
  return priority;
}

export function parseStatusFilter(value: unknown): StatusFilter {
  if (value === undefined || value === null || value === "") return "active";
  const text = String(value).trim().toLowerCase();
  const match = (STATUS_FILTERS as readonly string[]).includes(text) ? text as StatusFilter : undefined;
  if (!match) throw new Error(`status must be one of: ${STATUS_FILTERS.join(", ")}.`);
  return match;
}

export function normalizeTag(value: string): string | undefined {
  const tag = value.trim().replace(/^[#=]+/, "").toLowerCase().replace(/\s+/g, "-");
  return tag || undefined;
}

export function normalizeTags(values: Iterable<string> | undefined): string[] {
  const tags = new Set<string>();
  for (const value of values ?? []) {
    for (const part of value.split(",")) {
      const tag = normalizeTag(part);
      if (tag) tags.add(tag);
    }
  }
  return [...tags].sort();
}

/** Parses quick-add text such as `fix flaky test !high #ci #tests` into title, priority, and tags. */
export function parseQuickAdd(text: string): { title: string; priority?: Priority; tags: string[] } {
  let priority: Priority | undefined;
  const tags: string[] = [];
  const words: string[] = [];
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const bang = /^!(\w+)$/.exec(word);
    const bangPriority = bang ? parsePriority(bang[1]) : undefined;
    if (bangPriority && !/^[0-3]$/.test(bang![1])) {
      priority = bangPriority;
      continue;
    }
    if (/^#[A-Za-z][\w./-]*$/.test(word)) {
      tags.push(word);
      continue;
    }
    words.push(word);
  }
  return { title: words.join(" "), priority, tags: normalizeTags(tags) };
}

// ---------------------------------------------------------------------------
// Project identity

/**
 * Normalizes a git remote URL to `host/owner/repo`, so clones on different machines share a key.
 * Returns undefined for local-path remotes.
 */
export function normalizeRemote(url: string): string | undefined {
  const text = url.trim();
  if (!text) return undefined;
  let host: string;
  let repoPath: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      return undefined;
    }
    if (parsed.protocol === "file:") return undefined;
    host = parsed.hostname;
    repoPath = decodeURIComponent(parsed.pathname);
  } else {
    // scp-like syntax: [user@]host:path (a host needs 2+ chars so `C:\repo` is not a remote).
    const scp = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/\/)(.+)$/.exec(text);
    if (!scp) return undefined;
    host = scp[1];
    repoPath = scp[2];
  }
  repoPath = repoPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").replace(/^~[^/]*\//, "");
  if (!host || !repoPath) return undefined;
  return `${host.toLowerCase()}/${repoPath}`;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    const output = execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

function realpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export function homeRelative(target: string, home = os.homedir()): string {
  return homeRelativePaths(target, realpath(home), realpath(target));
}

function homeRelativePaths(target: string, home: string, resolved: string): string {
  const relative = path.relative(home, resolved);
  if (!relative) return "~";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return target;
  return `~/${relative.split(path.sep).join("/")}`;
}

function nameFromKey(key: string): string {
  return key.replace(/\/+$/, "").split(/[/:]/).filter(Boolean).at(-1) || key;
}

export function projectFromKey(key: string): Project {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("project key must not be empty.");
  return { key: trimmed, name: nameFromKey(trimmed) };
}

/** Repo-root file whose first line overrides the project key (for example, so a fork shares upstream's backlog). */
export const PROJECT_FILE = ".tdo-project";

/** Committed per-repo config, at the repo root. */
export const REPO_CONFIG_FILE = path.join(".tdo", "config.json");

/** `.tdo/config.json`: `project` is validated here; `tracker` is validated by its consumers so a bad block only breaks tracker commands. */
export type RepoConfig = { file: string; project?: string; tracker?: unknown };

export function readRepoConfig(root: string): RepoConfig | undefined {
  const file = path.join(root, REPO_CONFIG_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw error;
  }
  return parseRepoConfig(file, raw);
}

function parseRepoConfig(file: string, raw: string): RepoConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} must contain a JSON object.`);
  const { project, tracker } = parsed as { project?: unknown; tracker?: unknown };
  if (project !== undefined && (typeof project !== "string" || !project.trim())) throw new Error(`${file}: "project" must be a non-empty string.`);
  return { file, ...(project !== undefined ? { project: (project as string).trim() } : {}), ...(tracker !== undefined ? { tracker } : {}) };
}

type ProjectRead = { kind: "git"; args: string[] } | { kind: "file" | "repo-config" | "realpath"; path: string };
type ProjectOptions = { env?: NodeJS.ProcessEnv; home?: string; config?: Config };

/** One set of precedence rules, driven by either synchronous or asynchronous I/O. */
function* detectProject(cwd: string, env: NodeJS.ProcessEnv, home: string): Generator<ProjectRead, Project, string | undefined> {
  const top = yield { kind: "git", args: ["rev-parse", "--show-toplevel"] };
  const root = top || path.resolve(cwd);
  const forced = env.TDO_PROJECT?.trim();
  if (forced) {
    const project = projectFromKey(forced);
    // Only the checkout's own project may inherit its tracker config.
    let repoProject: string | undefined;
    let repoError: unknown;
    if (top) {
      const configFile = path.join(top, REPO_CONFIG_FILE);
      const rawConfig = yield { kind: "file", path: configFile };
      try { repoProject = rawConfig === undefined ? undefined : parseRepoConfig(configFile, rawConfig).project; }
      catch (error) { repoError = error; }
    }
    const checkout = yield* checkoutProject(cwd, top, home);
    const own = [checkout.key, ...(repoProject ? [projectFromKey(repoProject).key] : [])];
    if (!own.includes(project.key)) return project;
    if (repoError) throw repoError;
    return { ...project, root };
  }
  if (top) {
    const configFile = path.join(top, REPO_CONFIG_FILE);
    const rawConfig = yield { kind: "repo-config", path: configFile };
    const repoProject = rawConfig === undefined ? undefined : parseRepoConfig(configFile, rawConfig).project;
    if (repoProject) return { ...projectFromKey(repoProject), root };
  }
  return yield* checkoutProject(cwd, top, home);
}

/** Resolve the checkout identity without the committed tracker/project configuration. */
function* checkoutProject(cwd: string, top: string | undefined, home: string): Generator<ProjectRead, Project, string | undefined> {
  const root = top || path.resolve(cwd);
  if (top) {
    const file = yield { kind: "file", path: path.join(top, PROJECT_FILE) };
    const override = file?.split("\n")[0]?.trim();
    if (override) return { ...projectFromKey(override), root };
    // One spawn for every remote's fetch URL (with insteadOf rewrites applied, like `remote get-url`).
    const remotes = parseRemotes((yield { kind: "git", args: ["remote", "-v"] }) ?? "");
    const remote = remotes.has("origin") ? "origin" : remotes.keys().next().value;
    const url = remote ? remotes.get(remote) : undefined;
    const key = url ? normalizeRemote(url) : undefined;
    if (key) return { ...projectFromKey(key), root };
  }
  // Worktrees share their main checkout's backlog.
  const commonDir = top ? yield { kind: "git", args: ["rev-parse", "--path-format=absolute", "--git-common-dir"] } : undefined;
  const mainRoot = commonDir && path.basename(commonDir) === ".git" ? path.dirname(commonDir) : root;
  const realHome = (yield { kind: "realpath", path: home }) ?? path.resolve(home);
  const realRoot = (yield { kind: "realpath", path: mainRoot }) ?? path.resolve(mainRoot);
  const local = homeRelativePaths(mainRoot, realHome, realRoot);
  return { ...projectFromKey(`local:${local}`), root };
}

/**
 * Maps each remote name to its fetch URL from `git remote -v`, in git's (alphabetical) order.
 * Remotes without a URL map to undefined, so selection matches `git remote` + `git remote get-url`.
 */
function parseRemotes(output: string): Map<string, string | undefined> {
  const remotes = new Map<string, string | undefined>();
  for (const line of output.split("\n")) {
    const tab = line.indexOf("\t");
    const name = (tab < 0 ? line : line.slice(0, tab)).trim();
    if (!name) continue;
    const fetch = tab < 0 ? undefined : /^(.+) \(fetch\)$/.exec(line.slice(tab + 1).trim())?.[1];
    if (!remotes.has(name) || (fetch && remotes.get(name) === undefined)) remotes.set(name, fetch);
  }
  return remotes;
}

function aliasProject(project: Project, config: Config): Project {
  const alias = config.aliases[project.key];
  return alias ? { ...projectFromKey(alias), root: project.root } : project;
}

/**
 * Resolves the project for a directory: `TDO_PROJECT`, then `project` in `.tdo/config.json`, then a
 * `.tdo-project` file at the repo root, then the normalized git remote (origin first), then `local:<home-relative main worktree path>`.
 * The result is then mapped through the config's `aliases`.
 */
export function resolveProject(cwd: string, options: ProjectOptions = {}): Project {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const detection = detectProject(cwd, env, home);
  let step = detection.next();
  while (!step.done) {
    const read = step.value;
    let value: string | undefined;
    try {
      value = read.kind === "git" ? git(cwd, read.args) : read.kind !== "realpath" ? fs.readFileSync(read.path, "utf8") : fs.realpathSync(read.path);
    } catch (error) {
      if (read.kind === "repo-config" && !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // Missing override files and unresolved realpaths fall back in detectProject.
    }
    step = detection.next(value);
  }
  return aliasProject(step.value, options.config ?? loadConfig(env, home));
}

const execFileAsync = promisify(execFile);

/** Nonblocking equivalent of resolveProject for event-loop consumers such as Pi. */
export async function resolveProjectAsync(cwd: string, options: ProjectOptions = {}): Promise<Project> {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const detection = detectProject(cwd, env, home);
  let step = detection.next();
  while (!step.done) {
    const read = step.value;
    let value: string | undefined;
    try {
      if (read.kind === "git") {
        const { stdout } = await execFileAsync("git", ["-C", cwd, ...read.args], { encoding: "utf8", timeout: 5000 });
        value = stdout.trim() || undefined;
      } else {
        value = read.kind !== "realpath" ? await fs.promises.readFile(read.path, "utf8") : await fs.promises.realpath(read.path);
      }
    } catch (error) {
      if (read.kind === "repo-config" && !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // Match the sync resolver's fallback on git or filesystem errors.
    }
    step = detection.next(value);
  }
  return aliasProject(step.value, options.config ?? await loadConfigAsync(env, home));
}

// ---------------------------------------------------------------------------
// Database

/** Resolves an XDG base directory; the spec says relative values are invalid and must be ignored. */
function xdgDir(env: NodeJS.ProcessEnv, name: "XDG_DATA_HOME" | "XDG_CONFIG_HOME", fallback: string, home: string): string {
  const value = env[name]?.trim();
  return value && path.isAbsolute(value) ? value : path.join(home, fallback);
}

export function getDataDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(xdgDir(env, "XDG_DATA_HOME", path.join(".local", "share"), home), "tdo");
}

export function getConfigDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(xdgDir(env, "XDG_CONFIG_HOME", ".config", home), "tdo");
}

export function getConfigPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.TDO_CONFIG?.trim() || path.join(getConfigDir(env, home), "config.json");
}

/** Machine-local overrides beside the config file: `config.json` → `config.local.json`. */
export function getLocalConfigPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const file = getConfigPath(env, home);
  const ext = path.extname(file);
  return ext ? `${file.slice(0, -ext.length)}.local${ext}` : `${file}.local`;
}

function expandHome(value: string, home: string): string {
  return value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

/** Optional user config at `$XDG_CONFIG_HOME/tdo/config.json`, with `config.local.json` merged over it. */
export type Config = {
  /** Database path; `TDO_DB` takes precedence. */
  db?: string;
  /** Maps a resolved project key to the key to use instead, e.g. a fork to its upstream. */
  aliases: Record<string, string>;
  /** Items shown per project by `tdo ls -a`; 0 shows all. */
  perProject?: number;
  /** Open the CLI browser in a tmux popup or Rex floating pane when available. */
  floating?: boolean;
  /** Pi "work on it" asks the agent to do the work in a new git worktree and branch. */
  worktree?: boolean;
  /** Lead list rows of filed items with their issue ref (`gh#45`); per-project `issueIds` overrides it. */
  issueIds?: boolean;
  /** Per-project settings keyed by resolved project key; `tracker` is validated by its consumers. */
  projects?: Record<string, { tracker?: unknown; issueIds?: boolean }>;
};

/** Whether list rows in `project` lead with issue refs. */
export function issueIdsFor(config: Config, project: string): boolean {
  return config.projects?.[project]?.issueIds ?? config.issueIds ?? false;
}

export const DEFAULT_PER_PROJECT = 5;

/**
 * Rewrites the user config atomically. `fn` gets the raw JSON object (unknown keys included) and
 * returns the new one. The current file is validated first so a broken config is never clobbered.
 */
export function updateConfig(fn: (config: Record<string, unknown>) => Record<string, unknown>, env: NodeJS.ProcessEnv = process.env, home = os.homedir(), options: { local?: boolean } = {}): void {
  loadConfig(env, home);
  // Write through symlinks (e.g. a stow-managed config) instead of replacing the link with a file.
  const file = realConfigFile(options.local ? getLocalConfigPath(env, home) : getConfigPath(env, home));
  const current: Record<string, unknown> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(fn(current), null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function realConfigFile(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    // A dangling link: write its target rather than replacing the link.
    const target = fs.readlinkSync(file);
    return path.resolve(path.dirname(file), target);
  } catch {
    return file;
  }
}

/** Raw JSON of the main or local config file alone, without merging; undefined when absent. */
export function readConfigLayer(layer: "main" | "local", env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Record<string, unknown> | undefined {
  const file = layer === "local" ? getLocalConfigPath(env, home) : getConfigPath(env, home);
  return readConfigFile(readOptional(file), file);
}

/** JSON with object keys sorted, so equal values always serialize (and hash) the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** Reads one config file as a raw JSON object; undefined when it does not exist. */
function readConfigFile(raw: string | undefined, file: string): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${(error as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${file} must contain a JSON object.`);
  return parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Objects merge key by key; anything else in `over` (scalars, arrays, `false`) replaces. */
function mergeConfig(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(over)) merged[key] = isPlainObject(value) && isPlainObject(merged[key]) ? mergeConfig(merged[key] as Record<string, unknown>, value) : value;
  return merged;
}

/** Whether the local config file sets top-level `key`, i.e. overrides the main file's value. */
export function localConfigSets(key: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): boolean {
  const file = getLocalConfigPath(env, home);
  const raw = readConfigFile(readOptional(file), file);
  return !!raw && Object.hasOwn(raw, key);
}

function readOptional(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readOptionalAsync(file: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Validates each file on its own (so errors name the right file), then merges local over main. */
function combineConfig(main: string | undefined, local: string | undefined, env: NodeJS.ProcessEnv, home: string): Config {
  const mainFile = getConfigPath(env, home);
  const localFile = getLocalConfigPath(env, home);
  const mainRaw = readConfigFile(main, mainFile);
  const localRaw = readConfigFile(local, localFile);
  if (mainRaw) parseConfig(mainRaw, mainFile, home);
  if (localRaw) parseConfig(localRaw, localFile, home);
  if (!mainRaw && !localRaw) return { aliases: {} };
  return parseConfig(mergeConfig(mainRaw ?? {}, localRaw ?? {}), localRaw ? `${mainFile} + ${localFile}` : mainFile, home);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Config {
  return combineConfig(readOptional(getConfigPath(env, home)), readOptional(getLocalConfigPath(env, home)), env, home);
}

export async function loadConfigAsync(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<Config> {
  const [main, local] = await Promise.all([readOptionalAsync(getConfigPath(env, home)), readOptionalAsync(getLocalConfigPath(env, home))]);
  return combineConfig(main, local, env, home);
}

function parseConfig(parsed: Record<string, unknown>, file: string, home: string): Config {
  const { db, aliases, perProject, floating, worktree, issueIds, projects } = parsed as { db?: unknown; aliases?: unknown; perProject?: unknown; floating?: unknown; worktree?: unknown; issueIds?: unknown; projects?: unknown };
  const isObject = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value);
  if (projects !== undefined && (!isObject(projects) || !Object.values(projects as object).every(isObject))) throw new Error(`${file}: "projects" must map project keys to objects.`);
  if (floating !== undefined && typeof floating !== "boolean") throw new Error(`${file}: "floating" must be a boolean.`);
  if (issueIds !== undefined && typeof issueIds !== "boolean") throw new Error(`${file}: "issueIds" must be a boolean.`);
  for (const [key, entry] of Object.entries((projects ?? {}) as Record<string, { issueIds?: unknown }>)) {
    if (entry.issueIds !== undefined && typeof entry.issueIds !== "boolean") throw new Error(`${file}: "projects.${key}.issueIds" must be a boolean.`);
  }
  if (worktree !== undefined && typeof worktree !== "boolean") throw new Error(`${file}: "worktree" must be a boolean.`);
  if (perProject !== undefined && !(Number.isInteger(perProject) && (perProject as number) >= 0)) throw new Error(`${file}: "perProject" must be a non-negative integer.`);
  if (db !== undefined && typeof db !== "string") throw new Error(`${file}: "db" must be a string.`);
  if (aliases !== undefined && (!aliases || typeof aliases !== "object" || Array.isArray(aliases) || Object.values(aliases).some((value) => typeof value !== "string" || !value.trim()))) {
    throw new Error(`${file}: "aliases" must map project keys to non-empty strings.`);
  }
  return {
    db: db?.trim() ? expandHome(db.trim(), home) : undefined,
    aliases: { ...(aliases as Record<string, string> | undefined) },
    ...(perProject !== undefined ? { perProject: perProject as number } : {}),
    ...(floating !== undefined ? { floating: floating as boolean } : {}),
    ...(worktree !== undefined ? { worktree: worktree as boolean } : {}),
    ...(issueIds !== undefined ? { issueIds: issueIds as boolean } : {}),
    ...(projects !== undefined ? { projects: projects as Record<string, { tracker?: unknown; issueIds?: boolean }> } : {}),
  };
}

/** Database path: `TDO_DB`, then the config's `db`, then `$XDG_DATA_HOME/tdo/tdo.db`. */
export function getDbPath(env: NodeJS.ProcessEnv = process.env, options: { home?: string; config?: Config } = {}): string {
  const home = options.home ?? os.homedir();
  if (env.TDO_DB?.trim()) return env.TDO_DB.trim();
  const config = options.config ?? loadConfig(env, home);
  return config.db ?? path.join(getDataDir(env, home), "tdo.db");
}

export { SCHEMA, schemaVersion, planMigration, planNoteExtraction, backupDb, migrateDb } from "./migrations/index.ts";
export type { IdChange, MigrationResult } from "./migrations/index.ts";

export type OpenOptions = {
  /** Upgrade an older schema (default true). With false, the caller must run `migrateDb`. */
  migrate?: boolean;
};

export function openDb(dbPath = getDbPath(), options: OpenOptions = {}): DatabaseSync {
  if (/^[a-z][a-z0-9+.-]*:/i.test(dbPath) && dbPath !== ":memory:") throw new Error("openDb accepts local paths only; use the operation-level store for remote targets.");
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
    if (options.migrate !== false) migrateDb(db, dbPath);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}



function now(): string {
  return new Date().toISOString();
}

function cleanTitle(value: unknown): string {
  const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!title) throw new Error("title must not be empty.");
  return title.slice(0, MAX_TITLE_CHARS);
}

function cleanOptional(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function ensureProject(db: DatabaseSync, project: Project): string {
  db.prepare("INSERT INTO projects (id, key, display_name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING").run(randomUUID(), project.key, project.name, now());
  return String((db.prepare("SELECT id FROM projects WHERE key = ?").get(project.key) as { id: string }).id);
}

const ITEM_SELECT = `
SELECT i.*, p.key AS project_key,
  (SELECT group_concat(tag, ',') FROM (SELECT tag FROM tags t WHERE t.project_id = i.project_id AND t.item_id = i.id ORDER BY tag)) AS tag_list
FROM items i JOIN projects p ON p.id = i.project_id`;

type ItemRow = {
  id: number;
  project_id: string;
  project_key: string;
  title: string;
  body: string | null;
  priority: number;
  status: Status;
  tag_list: string | null;
  file_ref: string | null;
  source: string | null;
  session_id: string | null;
  host: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

type NoteRow = { seq: number; status: Status | null; body: string; created_at: string };
type LinkRow = { provider: string; destination: string; state: LinkState; attempt: string | null; external_id: string | null; url: string | null; error: string | null; claimed_at: string | null; created_at: string; synced_at: string | null; labels: string | null };

function toLink(db: DatabaseSync, key: ItemKey, row: LinkRow): Link {
  return { provider: row.provider, destination: row.destination, state: row.state, externalId: row.external_id, url: row.url, error: row.error, claimedAt: row.claimed_at, createdAt: row.created_at, syncedAt: row.synced_at, labels: row.labels ? JSON.parse(row.labels) as string[] : null, ...queueCounts(db, key, row.provider) };
}

/** Adds notes and links to items read from `ITEM_SELECT`. */
function withExtras(db: DatabaseSync, rows: ItemRow[]): Item[] {
  const notes = db.prepare("SELECT seq, status, body, created_at FROM notes WHERE project_id = ? AND item_id = ? ORDER BY seq");
  const links = db.prepare("SELECT * FROM links WHERE project_id = ? AND item_id = ? ORDER BY provider");
  return rows.map((row) => toItem(
    row,
    (notes.all(row.project_id, row.id) as NoteRow[]).map((note) => ({ seq: Number(note.seq), status: note.status, body: note.body, createdAt: note.created_at })),
    (links.all(row.project_id, row.id) as LinkRow[]).map((link) => toLink(db, { projectId: row.project_id, id: row.id }, link)),
  ));
}

function toItem(row: ItemRow, notes: Note[], links: Link[]): Item {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    project: row.project_key,
    title: row.title,
    body: row.body,
    priority: PRIORITIES[Number(row.priority)] ?? "normal",
    status: row.status,
    tags: row.tag_list ? row.tag_list.split(",") : [],
    fileRef: row.file_ref,
    source: row.source,
    sessionId: row.session_id,
    host: row.host,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    notes,
    links,
  };
}

export function getItem(db: DatabaseSync, key: ItemKey): Item | undefined {
  const row = db.prepare(`${ITEM_SELECT} WHERE i.project_id = ? AND i.id = ?`).get(key.projectId, key.id) as ItemRow | undefined;
  return row ? withExtras(db, [row])[0] : undefined;
}

/** Looks an item up by project key and per-project number. */
export function getItemByNumber(db: DatabaseSync, project: string, id: number): Item | undefined {
  const row = db.prepare(`${ITEM_SELECT} WHERE p.key = ? AND i.id = ?`).get(project, id) as ItemRow | undefined;
  return row ? withExtras(db, [row])[0] : undefined;
}

/**
 * Resolves an item reference: `3` or `#3` in `project`, or `KEY#3` / `NAME#3` in another project
 * (a bare project name must match exactly one project). A linked issue also names its item: `gh#45`
 * in `project`, or the issue URL from anywhere.
 */
export function findItem(db: DatabaseSync, ref: string, project: string): Item {
  const issue = parseIssueRef(ref);
  if (issue) {
    const found = findByIssue(db, issue, project);
    // `gh#3` could also name item 3 of a project called "gh"; that only applies when no issue matches.
    const projectNamed = !issue.destination && db.prepare("SELECT 1 FROM projects WHERE key = ? OR display_name = ?").get(ref.split("#")[0]!, ref.split("#")[0]!);
    if (!(found instanceof Error)) return found;
    if (!projectNamed) throw found;
  }
  const match = /^(?:(.+?)#|#)?(\d+)$/.exec(ref.trim());
  const number = match ? Number(match[2]) : NaN;
  if (!match || !Number.isInteger(number) || number <= 0) throw new Error(`expected an item id, got ${JSON.stringify(ref)}.`);
  let key = project;
  if (match[1]) {
    const named = match[1];
    const keys = (db.prepare("SELECT key FROM projects WHERE key = ? OR display_name = ?").all(named, named) as { key: string }[]).map((row) => row.key);
    if (keys.includes(named)) key = named;
    else if (keys.length === 1) key = keys[0]!;
    else if (keys.length > 1) throw new Error(`${named} matches several projects: ${keys.join(", ")}.`);
    else throw new Error(`No tdo project ${named}.`);
  }
  const item = getItemByNumber(db, key, number);
  if (!item) throw new Error(`No tdo item #${number} in ${key}.`);
  return item;
}

/** Short provider prefixes for issue refs; `gh#45` is GitHub issue 45. */
const ISSUE_PREFIX: Record<string, string> = { github: "gh" };
const PREFIX_PROVIDER = Object.fromEntries(Object.entries(ISSUE_PREFIX).map(([provider, prefix]) => [prefix, provider]));

export type IssueRef = { provider: string; externalId: string; destination?: string };

/** `gh#45` or a GitHub issue URL; undefined for anything else (including plain tdo ids). */
export function parseIssueRef(ref: string): IssueRef | undefined {
  const text = ref.trim();
  const short = /^([a-z]+)#(\d+)$/i.exec(text);
  const provider = short ? PREFIX_PROVIDER[short[1]!.toLowerCase()] : undefined;
  if (short && provider && Number(short[2]) > 0) return { provider, externalId: String(Number(short[2])) };
  const url = parseGithubIssueUrl(text);
  return url ? { provider: "github", externalId: url.id, destination: url.destination } : undefined;
}

/** `gh#45` for a filed link; undefined while it has no issue yet. */
export function issueRef(link: Pick<Link, "provider" | "externalId" | "state">): string | undefined {
  if (!link.externalId || (link.state !== "open" && link.state !== "closed")) return undefined;
  return `${ISSUE_PREFIX[link.provider] ?? link.provider}#${link.externalId}`;
}

/** URLs name their repository, so they match in any project; short refs match in `project` only. */
function findByIssue(db: DatabaseSync, issue: IssueRef, project: string): Item | Error {
  const rows = (issue.destination
    ? db.prepare("SELECT l.project_id, l.item_id FROM links l WHERE l.provider = ? AND l.external_id = ? AND lower(l.destination) = lower(?) AND l.state IN ('open','closed')").all(issue.provider, issue.externalId, issue.destination)
    : db.prepare("SELECT l.project_id, l.item_id FROM links l JOIN projects p ON p.id = l.project_id WHERE l.provider = ? AND l.external_id = ? AND p.key = ? AND l.state IN ('open','closed')").all(issue.provider, issue.externalId, project)) as { project_id: string; item_id: number }[];
  const label = issue.destination ? `${issue.destination}#${issue.externalId}` : `${ISSUE_PREFIX[issue.provider] ?? issue.provider}#${issue.externalId}`;
  if (!rows.length) return new Error(`No tdo item is linked to ${label}${issue.destination ? "" : ` in ${project}`}.`);
  if (rows.length > 1) return new Error(`${label} is linked to several tdo items; use a tdo id instead.`);
  return requireItem(db, { projectId: rows[0]!.project_id, id: Number(rows[0]!.item_id) });
}

function requireItem(db: DatabaseSync, key: ItemKey): Item {
  const item = getItem(db, key);
  if (!item) throw new Error(`No tdo item #${key.id} in project ${key.projectId}.`);
  return item;
}

export function addItem(db: DatabaseSync, input: NewItem, intent?: AutoIntent): Item {
  const project = typeof input.project === "string" ? projectFromKey(input.project) : input.project;
  const title = cleanTitle(input.title);
  const priority = input.priority ? requirePriority(input.priority) : "normal";
  const key = transaction(db, (): ItemKey => {
    const projectId = ensureProject(db, project);
    const id = Number((db.prepare("UPDATE projects SET next_item_id = next_item_id + 1 WHERE id = ? RETURNING next_item_id - 1 AS id").get(projectId) as { id: number }).id);
    const timestamp = now();
    db.prepare(`INSERT INTO items (project_id, id, title, body, priority, file_ref, source, session_id, host, created_at, updated_at, created_by_human)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      projectId, id, title, cleanOptional(input.body), PRIORITIES.indexOf(priority), cleanOptional(input.fileRef),
      cleanOptional(input.source), cleanOptional(input.sessionId), cleanOptional(input.host), timestamp, timestamp, input.createdByHuman ? 1 : 0,
    );
    const insertTag = db.prepare("INSERT OR IGNORE INTO tags (project_id, item_id, tag) VALUES (?, ?, ?)");
    for (const tag of normalizeTags(input.tags)) insertTag.run(projectId, id, tag);
    const key = { projectId, id };
    persistAutoIntent(db, key, intent);
    return key;
  });
  return requireItem(db, key);
}

export function updateItem(db: DatabaseSync, key: ItemKey, patch: ItemPatch, intent?: AutoIntent): Item {
  transaction(db, () => {
    // Read under the write lock so a concurrent delete can't slip in between.
    const { projectId, id } = requireItem(db, key);
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.title !== undefined) { sets.push("title = ?"); values.push(cleanTitle(patch.title)); }
    if (patch.body !== undefined) { sets.push("body = ?"); values.push(cleanOptional(patch.body)); }
    if (patch.priority !== undefined) { sets.push("priority = ?"); values.push(PRIORITIES.indexOf(requirePriority(patch.priority))); }
    if (patch.fileRef !== undefined) { sets.push("file_ref = ?"); values.push(cleanOptional(patch.fileRef)); }
    let tagsChanged = false;
    const removeTag = db.prepare("DELETE FROM tags WHERE project_id = ? AND item_id = ? AND tag = ?");
    for (const tag of normalizeTags(patch.removeTags)) tagsChanged = Number(removeTag.run(projectId, id, tag).changes) > 0 || tagsChanged;
    const insertTag = db.prepare("INSERT OR IGNORE INTO tags (project_id, item_id, tag) VALUES (?, ?, ?)");
    for (const tag of normalizeTags(patch.addTags)) tagsChanged = Number(insertTag.run(projectId, id, tag).changes) > 0 || tagsChanged;
    sets.push("updated_at = ?");
    values.push(now());
    db.prepare(`UPDATE items SET ${sets.join(", ")} WHERE project_id = ? AND id = ?`).run(...values, projectId, id);
    if (patch.title !== undefined || patch.body !== undefined || patch.fileRef !== undefined || tagsChanged) enqueueLinked(db, key, "update");
    persistAutoIntent(db, key, intent);
  });
  return requireItem(db, key);
}

/** Runs under the item transaction; existing links are never promoted or retargeted. */
function persistAutoIntent(db: DatabaseSync, key: ItemKey, intent?: AutoIntent): void {
  if (!intent) return;
  const item = db.prepare("SELECT created_by_human FROM items WHERE project_id = ? AND id = ?").get(key.projectId, key.id) as { created_by_human: number };
  const tagged = db.prepare("SELECT 1 FROM tags WHERE project_id = ? AND item_id = ? AND tag = ?").get(key.projectId, key.id, intent.tag);
  if (!tagged) return;
  const state = intent.authorized && item.created_by_human === 1 ? "pending" : "awaiting-approval";
  db.prepare("INSERT OR IGNORE INTO links (project_id, item_id, provider, destination, state, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(key.projectId, key.id, intent.provider, intent.destination, state, now());
}

function insertNote(db: DatabaseSync, key: ItemKey, status: Status | null, body: string, timestamp: string): number {
  const seq = Number((db.prepare("SELECT coalesce(max(seq), 0) + 1 AS seq FROM notes WHERE project_id = ? AND item_id = ?").get(key.projectId, key.id) as { seq: number }).seq);
  db.prepare("INSERT INTO notes (project_id, item_id, seq, status, body, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(key.projectId, key.id, seq, status, body, timestamp);
  return seq;
}

/** Moves an item to a new status; `note` is recorded as a note tagged with the new status. */
export function setStatus(db: DatabaseSync, key: ItemKey, status: Status, note?: string, closeOnDone = true): Item {
  if (!(STATUSES as readonly string[]).includes(status)) throw new Error(`status must be one of: ${STATUSES.join(", ")}.`);
  const trimmedNote = note?.trim();
  const closed = status === "done" || status === "dropped";
  transaction(db, () => {
    const item = requireItem(db, key);
    const timestamp = now();
    db.prepare("UPDATE items SET status = ?, closed_at = ?, updated_at = ? WHERE project_id = ? AND id = ?").run(
      status, closed ? (item.closedAt && item.status === status ? item.closedAt : timestamp) : null, timestamp, item.projectId, item.id,
    );
    if (trimmedNote) enqueueLinked(db, key, "comment", null, insertNote(db, item, status, trimmedNote, timestamp));
    // Sync the transition, not the target: done -> doing reopens, doing -> open does nothing.
    const wasClosed = item.status === "done" || item.status === "dropped";
    if (closeOnDone && closed && item.status !== status) enqueueLinked(db, key, "close", status === "done" ? "completed" : "not planned");
    if (closeOnDone && wasClosed && !closed) enqueueLinked(db, key, "reopen");
  });
  return requireItem(db, key);
}

/** Adds a note without changing the item's status. */
export function addNote(db: DatabaseSync, key: ItemKey, note: string): Item {
  const body = note.trim();
  if (!body) throw new Error("note must not be empty.");
  transaction(db, () => {
    const item = requireItem(db, key);
    const timestamp = now();
    enqueueLinked(db, key, "comment", null, insertNote(db, item, null, body, timestamp));
    db.prepare("UPDATE items SET updated_at = ? WHERE project_id = ? AND id = ?").run(timestamp, item.projectId, item.id);
  });
  return requireItem(db, key);
}

// ---------------------------------------------------------------------------
// Tracker links

export function getLink(db: DatabaseSync, key: ItemKey, provider: string): Link | undefined {
  const row = db.prepare("SELECT * FROM links WHERE project_id = ? AND item_id = ? AND provider = ?").get(key.projectId, key.id, provider) as LinkRow | undefined;
  return row ? toLink(db, key, row) : undefined;
}

export function isStaleClaim(link: Pick<Link, "state" | "claimedAt">, at = Date.now()): boolean {
  return link.state === "creating" && (!link.claimedAt || at - Date.parse(link.claimedAt) > LINK_STALE_MS);
}

export type ClaimMode = "create" | "force";
export type Claim = { token?: string; link: Link };

/** States a plain create may claim from; `force` also takes over unknown and stale attempts. */
const CREATABLE: readonly LinkState[] = ["awaiting-approval", "pending", "error"];
const CLAIMABLE: Record<ClaimMode, readonly LinkState[]> = { create: CREATABLE, force: [...CREATABLE, "unknown", "creating"] };

/**
 * Atomically claims the right to create an issue for an item. Returns a token only to the one
 * caller that wins; completion must present it. A new link fixes its destination here.
 */
export function claimLinkCreate(db: DatabaseSync, key: ItemKey, provider: string, destination: string, mode: ClaimMode): Claim {
  return transaction(db, () => {
    requireItem(db, key);
    const token = randomUUID();
    const timestamp = now();
    const existing = getLink(db, key, provider);
    if (!existing) {
      db.prepare("INSERT INTO links (project_id, item_id, provider, destination, state, attempt, claimed_at, created_at) VALUES (?, ?, ?, ?, 'creating', ?, ?, ?)")
        .run(key.projectId, key.id, provider, destination, token, timestamp, timestamp);
      return { token, link: getLink(db, key, provider)! };
    }
    const allowed = CLAIMABLE[mode].includes(existing.state) && (existing.state !== "creating" || isStaleClaim(existing));
    if (!allowed) return { link: existing };
    db.prepare("UPDATE links SET state = 'creating', attempt = ?, claimed_at = ?, error = NULL, error_kind = NULL WHERE project_id = ? AND item_id = ? AND provider = ? AND state = ?")
      .run(token, timestamp, key.projectId, key.id, provider, existing.state);
    return { token, link: getLink(db, key, provider)! };
  });
}

/** The item content a create rendered; `tags` is optional for callers that predate tag sync. */
export type CreateSnapshot = Pick<Item, "title" | "body" | "fileRef"> & { tags?: string[] };

export type CreateOutcome =
  | { ok: true; externalId: string; url: string; snapshot?: CreateSnapshot; labels?: string[] }
  | { ok: false; kind: "attention" | "retryable" | "uncertain"; message: string };

/** Records a create attempt's result; a no-op (returns undefined) if the attempt was superseded. */
export function finishLinkCreate(db: DatabaseSync, key: ItemKey, provider: string, token: string, outcome: CreateOutcome, closeOnDone = true): Link | undefined {
  return transaction(db, () => {
    const timestamp = now();
    const sql = outcome.ok
      ? "UPDATE links SET state = 'open', external_id = ?, url = ?, error = NULL, error_kind = NULL, attempt = NULL, synced_at = ?, labels = ?"
      : "UPDATE links SET state = ?, error = ?, error_kind = ?, attempt = NULL";
    const values = outcome.ok
      ? [outcome.externalId, outcome.url, timestamp, outcome.labels ? JSON.stringify(outcome.labels) : null]
      : [outcome.kind === "uncertain" ? "unknown" : outcome.kind === "retryable" ? "pending" : "error", outcome.message, outcome.kind];
    const changed = db.prepare(`${sql} WHERE project_id = ? AND item_id = ? AND provider = ? AND attempt = ? AND state = 'creating'`)
      .run(...values, key.projectId, key.id, provider, token).changes;
    if (!Number(changed)) return undefined;
    if (outcome.ok) reconcileCreatedLink(db, key, provider, closeOnDone, outcome.snapshot);
    return getLink(db, key, provider);
  });
}

/** Reconcile under the create completion's write lock; notes preceding completion are not comments. */
function reconcileCreatedLink(db: DatabaseSync, key: ItemKey, provider: string, closeOnDone: boolean, snapshot?: CreateSnapshot): void {
  const current = requireItem(db, key);
  const tagsChanged = snapshot?.tags !== undefined && normalizeTags(snapshot.tags).join(",") !== current.tags.join(",");
  if (!snapshot || current.title !== snapshot.title || current.body !== snapshot.body || current.fileRef !== snapshot.fileRef || tagsChanged) enqueueOp(db, key, provider, "update");
  if (closeOnDone && (current.status === "done" || current.status === "dropped")) enqueueOp(db, key, provider, "close", current.status === "done" ? "completed" : "not planned");
}

/** All linked items for a project, without the interactive listing's row cap. */
export function listLinkedItems(db: DatabaseSync, project: string): Item[] {
  return withExtras(db, db.prepare(`${ITEM_SELECT} WHERE p.key = ? AND EXISTS (SELECT 1 FROM links l WHERE l.project_id = i.project_id AND l.item_id = i.id) ORDER BY i.id`).all(project) as ItemRow[]);
}

/** Marks interrupted create attempts (crash, lost local write) as unknown so they are never auto-retried. */
export function expireStaleClaims(db: DatabaseSync, project: string): number {
  const cutoff = new Date(Date.now() - LINK_STALE_MS).toISOString();
  return Number(db.prepare(`UPDATE links SET state = 'unknown', attempt = NULL, error = 'create was interrupted; check the tracker, then use --attach or --force'
    WHERE state = 'creating' AND (claimed_at IS NULL OR claimed_at < ?) AND project_id IN (SELECT id FROM projects WHERE key = ?)`).run(cutoff, project).changes);
}

/** States from which a known issue URL may be attached. */
const ATTACHABLE: readonly LinkState[] = ["awaiting-approval", "pending", "error", "unknown"];

/** Records an issue the user created or found; the destination must match an existing link's. */
export function attachLink(db: DatabaseSync, key: ItemKey, provider: string, destination: string, externalId: string, url: string): Link {
  return transaction(db, () => {
    requireItem(db, key);
    const timestamp = now();
    const existing = getLink(db, key, provider);
    if (!existing) {
      db.prepare("INSERT INTO links (project_id, item_id, provider, destination, state, external_id, url, created_at, synced_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)")
        .run(key.projectId, key.id, provider, destination, externalId, url, timestamp, timestamp);
      return getLink(db, key, provider)!;
    }
    if (existing.destination.toLowerCase() !== destination.toLowerCase()) throw new Error(`#${key.id} is bound to ${existing.destination}; the URL points at ${destination}.`);
    if (!ATTACHABLE.includes(existing.state) && !isStaleClaim(existing)) throw new Error(`#${key.id} is ${existing.state}${existing.url ? ` (${existing.url})` : ""}; nothing to attach.`);
    db.prepare("UPDATE links SET state = 'open', external_id = ?, url = ?, error = NULL, error_kind = NULL, attempt = NULL, synced_at = ? WHERE project_id = ? AND item_id = ? AND provider = ?")
      .run(externalId, url, timestamp, key.projectId, key.id, provider);
    return getLink(db, key, provider)!;
  });
}

/** Forgets an item's link (the issue itself is left alone). Refuses while a create is in flight. */
export function detachLink(db: DatabaseSync, key: ItemKey, provider: string): Link | undefined {
  return transaction(db, () => {
    const existing = getLink(db, key, provider);
    if (!existing) return undefined;
    if (existing.state === "creating" && !isStaleClaim(existing)) throw new Error(`#${key.id} is being filed right now; try again in a couple of minutes.`);
    db.prepare("DELETE FROM links WHERE project_id = ? AND item_id = ? AND provider = ?").run(key.projectId, key.id, provider);
    return existing;
  });
}

export function countLinks(db: DatabaseSync, project: string): Partial<Record<LinkState, number[]>> {
  const rows = db.prepare("SELECT l.state AS state, l.item_id AS id FROM links l JOIN projects p ON p.id = l.project_id WHERE p.key = ? ORDER BY l.item_id").all(project) as { state: LinkState; id: number }[];
  const result: Partial<Record<LinkState, number[]>> = {};
  for (const row of rows) (result[row.state] ??= []).push(Number(row.id));
  return result;
}

export function deleteItem(db: DatabaseSync, key: ItemKey): Item {
  return transaction(db, () => {
    const item = requireItem(db, key);
    db.prepare("DELETE FROM items WHERE project_id = ? AND id = ?").run(item.projectId, item.id);
    return item;
  });
}

/** Turns free text into a safe FTS5 prefix query: every word must match. */
export function ftsQuery(text: string): string | undefined {
  const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.length ? words.map((word) => `"${word}"*`).join(" ") : undefined;
}

export function listItems(db: DatabaseSync, filter: ListFilter = {}): Item[] {
  const limit = filter.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("limit must be a non-negative safe integer.");
  const where: string[] = [];
  const values: (string | number)[] = [];
  if (filter.project !== undefined) { where.push("p.key = ?"); values.push(filter.project); }
  const status = parseStatusFilter(filter.status);
  if (status === "active") where.push("i.status IN ('open', 'doing')");
  else if (status === "closed") where.push("i.status IN ('done', 'dropped')");
  else if (status !== "all") { where.push("i.status = ?"); values.push(status); }
  for (const tag of normalizeTags(filter.tags)) {
    where.push("EXISTS (SELECT 1 FROM tags t WHERE t.project_id = i.project_id AND t.item_id = i.id AND t.tag = ?)");
    values.push(tag);
  }
  if (filter.minPriority !== undefined) { where.push("i.priority <= ?"); values.push(PRIORITIES.indexOf(requirePriority(filter.minPriority))); }
  const query = filter.query ? ftsQuery(filter.query) : undefined;
  if (filter.query && !query) return [];
  if (query) { where.push("(i.project_id, i.id) IN (SELECT project_id, item_id FROM items_fts WHERE items_fts MATCH ?)"); values.push(query); }
  if (filter.awaiting) where.push("EXISTS (SELECT 1 FROM links l WHERE l.project_id = i.project_id AND l.item_id = i.id AND l.state = 'awaiting-approval')");
  if (filter.linked) where.push("EXISTS (SELECT 1 FROM links l WHERE l.project_id = i.project_id AND l.item_id = i.id)");
  const closedFirst = status === "closed" || status === "done" || status === "dropped";
  const order = closedFirst
    ? "i.closed_at DESC, i.created_at DESC"
    : "CASE i.status WHEN 'doing' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, i.priority, i.created_at, p.key, i.id";
  const sql = `${ITEM_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ?`;
  return withExtras(db, db.prepare(sql).all(...values, limit === 0 ? -1 : limit) as ItemRow[]);
}

export type ActiveCounts = { total: number; doing: number } & Record<Priority, number>;

export function countActive(db: DatabaseSync, project: string): ActiveCounts {
  const counts: ActiveCounts = { total: 0, doing: 0, urgent: 0, high: 0, normal: 0, low: 0 };
  const rows = db.prepare(`SELECT i.priority AS priority, i.status AS status, count(*) AS n FROM items i JOIN projects p ON p.id = i.project_id
    WHERE p.key = ? AND i.status IN ('open', 'doing') GROUP BY i.priority, i.status`).all(project) as { priority: number; status: Status; n: number }[];
  for (const row of rows) {
    const n = Number(row.n);
    counts.total += n;
    counts[PRIORITIES[Number(row.priority)] ?? "normal"] += n;
    if (row.status === "doing") counts.doing += n;
  }
  return counts;
}

export function listTags(db: DatabaseSync, project?: string): { tag: string; count: number }[] {
  const rows = db.prepare(`SELECT t.tag AS tag, count(*) AS n FROM tags t JOIN items i ON i.project_id = t.project_id AND i.id = t.item_id JOIN projects p ON p.id = i.project_id
    WHERE i.status IN ('open', 'doing')${project !== undefined ? " AND p.key = ?" : ""} GROUP BY t.tag ORDER BY n DESC, t.tag`).all(...(project !== undefined ? [project] : [])) as { tag: string; n: number }[];
  return rows.map((row) => ({ tag: row.tag, count: Number(row.n) }));
}

export function listProjects(db: DatabaseSync): { key: string; name: string; active: number; total: number }[] {
  const rows = db.prepare(`SELECT p.key AS key, p.display_name AS name,
      sum(CASE WHEN i.status IN ('open', 'doing') THEN 1 ELSE 0 END) AS active, count(i.id) AS total
    FROM projects p LEFT JOIN items i ON i.project_id = p.id GROUP BY p.id ORDER BY active DESC, p.key`).all() as { key: string; name: string | null; active: number | null; total: number }[];
  return rows.map((row) => ({ key: row.key, name: row.name ?? nameFromKey(row.key), active: Number(row.active ?? 0), total: Number(row.total) }));
}

// ---------------------------------------------------------------------------
// Formatting

export function formatCounts(counts: ActiveCounts): string {
  if (!counts.total) return "no open items";
  const urgentish = [counts.urgent ? `${counts.urgent} urgent` : "", counts.high ? `${counts.high} high` : ""].filter(Boolean).join(", ");
  return `${counts.total} open${urgentish ? ` (${urgentish})` : ""}`;
}

/** `#3`, or `widgets#3` when other projects are in view. */
export function itemRef(item: Item, options: { showProject?: boolean } = {}): string {
  return options.showProject ? `${nameFromKey(item.project)}#${item.id}` : `#${item.id}`;
}

/** The item's filed issue ref (`gh#45`), if any. */
function filedRef(item: Item): string | undefined {
  for (const link of item.links ?? []) {
    const ref = issueRef(link);
    if (ref) return ref;
  }
  return undefined;
}

const ANSI = { bold: [1, 22], dim: [2, 22], red: [31, 39], yellow: [33, 39], cyan: [36, 39] } as const;
type Style = keyof typeof ANSI;

function paint(text: string, color: boolean | undefined, ...styles: Style[]): string {
  return color ? styles.reduce((out, style) => `\x1b[${ANSI[style][0]}m${out}\x1b[${ANSI[style][1]}m`, text) : text;
}

const PRIORITY_STYLE: Record<Priority, Style[]> = { urgent: ["red", "bold"], high: ["yellow"], normal: [], low: ["dim"] };

export type FormatOptions = {
  /** Prefix ids with the project name (`widgets#3`). */
  showProject?: boolean;
  /** Emit ANSI colors. */
  color?: boolean;
  /** Lead filed items with their issue ref (`gh#45`); the tdo id moves to the marker slot. */
  issueIds?: boolean;
};

export function formatItemLine(item: Item, options: FormatOptions = {}): string {
  const { color } = options;
  const filed = options.issueIds ? filedRef(item) : undefined;
  const lead = filed ? (options.showProject ? `${nameFromKey(item.project)} ${filed}` : filed) : itemRef(item, options);
  const parts = [paint(lead, color, "bold"), paint(item.priority, color, ...PRIORITY_STYLE[item.priority]) + " ".repeat(6 - item.priority.length)];
  if (item.status !== "open") parts.push(paint(`[${item.status}]`, color, item.status === "doing" ? "cyan" : "dim"));
  parts.push(item.title);
  const marker = linkMarker(item.links);
  // With the issue leading, the marker slot keeps the tdo id visible; sync state still shows when it isn't settled.
  if (filed) parts.push(paint(marker?.startsWith("↗") && marker !== `↗${filed}` ? `${marker} #${item.id}` : `#${item.id}`, color, marker && marker.endsWith("!") ? "red" : "dim"));
  else if (marker) parts.push(paint(marker, color, marker.endsWith("!") ? "red" : "dim"));
  if (item.tags.length) parts.push(paint(item.tags.map((tag) => `#${tag}`).join(" "), color, "cyan"));
  if (item.fileRef) parts.push(paint(`@ ${item.fileRef}`, color, "dim"));
  return parts.join("  ");
}

/** `↗gh#42` filed, `↗…` in progress or pending, `↗?` awaiting approval, `↗!` needs attention. */
export function linkMarker(links: Link[] | undefined): string | undefined {
  const link = links?.[0];
  if (!link) return undefined;
  if (link.attention) return "↗!";
  if (link.queued) return "↗…";
  switch (link.state) {
    case "open":
    case "closed":
      return `↗${issueRef(link) ?? "!"}`;
    case "creating":
    case "pending":
      return "↗…";
    case "awaiting-approval":
      return "↗?";
    default:
      return "↗!";
  }
}

export function formatItemList(items: Item[], options: FormatOptions & { empty?: string; truncated?: boolean } = {}): string {
  const text = items.length ? items.map((item) => formatItemLine(item, options)).join("\n") : (options.empty ?? "(nothing here)");
  return options.truncated ? `${text}\n${paint(LIST_TRUNCATED, options.color, "dim")}` : text;
}

const STATUS_RANK: Record<Status, number> = { doing: 0, open: 1, done: 2, dropped: 3 };

/** Most urgent first; within a priority, doing before open, then oldest first. */
export function byPriority(a: Item, b: Item): number {
  return PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority)
    || STATUS_RANK[a.status] - STATUS_RANK[b.status]
    || a.createdAt.localeCompare(b.createdAt)
    || a.id - b.id;
}

/**
 * Renders items grouped by project under a bold header, most urgent first, showing at most
 * `perProject` items per project (0 = all). Projects with the most urgent items come first.
 */
export function formatGroupedList(items: Item[], options: { perProject?: number; color?: boolean; empty?: string; issueIds?: (project: string) => boolean } = {}): string {
  if (!items.length) return options.empty ?? "(nothing here)";
  const { color } = options;
  const perProject = options.perProject ?? DEFAULT_PER_PROJECT;
  const groups = new Map<string, Item[]>();
  for (const item of items) groups.set(item.project, [...(groups.get(item.project) ?? []), item]);
  for (const group of groups.values()) group.sort(byPriority);
  const ordered = [...groups.entries()].sort(([keyA, a], [keyB, b]) => byPriority(a[0]!, b[0]!) || b.length - a.length || keyA.localeCompare(keyB));
  return ordered.map(([key, group]) => {
    const urgent = group.filter((item) => item.priority === "urgent" || item.priority === "high").length;
    const summary = `${group.length} item${group.length === 1 ? "" : "s"}${urgent ? `, ${urgent}!` : ""}`;
    const header = `${paint(nameFromKey(key), color, "bold")}  ${paint(`${key} · ${summary}`, color, "dim")}`;
    const shown = perProject > 0 ? group.slice(0, perProject) : group;
    const lines = shown.map((item) => `  ${formatItemLine(item, { color, issueIds: options.issueIds?.(key) })}`);
    const hidden = group.length - shown.length;
    if (hidden > 0) lines.push(paint(`  … ${hidden} more (tdo ls --project ${key} -n 0)`, color, "dim"));
    return [header, ...lines].join("\n");
  }).join("\n\n");
}

/** Splits editor text into a title (first line) and body (the rest). */
export function parseEditorText(text: string): { title: string; body: string | null } {
  const [first = "", ...rest] = text.replace(/\r\n/g, "\n").split("\n");
  return { title: first.trim(), body: rest.join("\n").trim() || null };
}

/** The editor text for an item: title, blank line, body. */
export function editorText(item: Item): string {
  return item.body ? `${item.title}\n\n${item.body}` : item.title;
}

export function formatItemDetail(item: Item): string {
  const lines = [
    `#${item.id} ${item.title}`,
    `project:  ${item.project}`,
    `status:   ${item.status}${item.closedAt ? ` (${item.closedAt.slice(0, 10)})` : ""}`,
    `priority: ${item.priority}`,
  ];
  if (item.tags.length) lines.push(`tags:     ${item.tags.join(", ")}`);
  if (item.fileRef) lines.push(`file:     ${item.fileRef}`);
  lines.push(`created:  ${item.createdAt.slice(0, 16).replace("T", " ")}${item.host ? ` on ${item.host}` : ""}${item.source ? ` via ${item.source}` : ""}`);
  lines.push(...formatLinkDetails(item.links ?? []));
  if (item.body) lines.push("", item.body);
  if (item.notes?.length) lines.push("", "notes:", ...item.notes.map(formatNote));
  return lines.join("\n");
}

function formatLinkDetails(links: Link[]): string[] {
  return links.flatMap((link) => [
    `issue:    ${issueRef(link) ? `${issueRef(link)} ` : ""}${link.url ?? link.destination} (${link.state})`,
    ...(link.syncError ? [`          ${link.syncError}`] : []),
    ...(link.queued || link.attention ? [`          ${link.queued} queued, ${link.attention} need attention`] : []),
    ...(link.error && link.state !== "open" && link.state !== "closed" ? [`          ${link.error}`] : []),
  ]);
}

export function formatNote(note: Note): string {
  const [first = "", ...rest] = note.body.split("\n");
  const head = `  ${note.createdAt.slice(0, 10)} ${(note.status ?? "note").padEnd(7)} `;
  return [head + first, ...rest.map((line) => `${" ".repeat(head.length)}${line}`)].join("\n");
}

function formatMarkdownNotes(notes: Note[] = []): string[] {
  return notes.map((note) => `  - ${note.createdAt.slice(0, 10)}${note.status ? ` ${note.status}` : ""}: ${note.body.replace(/\n/g, " ")}`);
}

export function formatMarkdown(items: Item[]): string {
  const byProject = new Map<string, Item[]>();
  for (const item of items) byProject.set(item.project, [...(byProject.get(item.project) ?? []), item]);
  const sections: string[] = [];
  for (const [project, projectItems] of byProject) {
    const lines = [`## ${project}`, ""];
    for (const item of projectItems) {
      const checked = item.status === "done" || item.status === "dropped" ? "x" : " ";
      const meta = [item.priority, ...item.tags.map((tag) => `#${tag}`), item.fileRef ? `\`${item.fileRef}\`` : "", item.status === "dropped" ? "dropped" : ""].filter(Boolean).join(" ");
      lines.push(`- [${checked}] #${item.id} ${item.title} (${meta})`);
      lines.push(...formatMarkdownNotes(item.notes));
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n") + (sections.length ? "\n" : "");
}
