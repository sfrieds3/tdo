/**
 * tdo — per-project "fix later" backlog stored in SQLite.
 *
 * Shared by the `tdo` CLI (src/cli.ts) and the Pi extension (extensions/tdo.ts); agents use the CLI via skills/tdo.
 * Uses only erasable TypeScript syntax so Node can run it directly with type stripping.
 */
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type * as Sqlite from "node:sqlite";
import { promisify } from "node:util";
import { migrateDb } from "./migrations/index.ts";

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

type ProjectRead = { kind: "git"; args: string[] } | { kind: "file" | "realpath"; path: string };
type ProjectOptions = { env?: NodeJS.ProcessEnv; home?: string; config?: Config };

/** One set of precedence rules, driven by either synchronous or asynchronous I/O. */
function* detectProject(cwd: string, env: NodeJS.ProcessEnv, home: string): Generator<ProjectRead, Project, string | undefined> {
  if (env.TDO_PROJECT?.trim()) return projectFromKey(env.TDO_PROJECT);
  const top = yield { kind: "git", args: ["rev-parse", "--show-toplevel"] };
  const root = top || path.resolve(cwd);
  if (top) {
    const file = yield { kind: "file", path: path.join(top, PROJECT_FILE) };
    const override = file?.split("\n")[0]?.trim();
    if (override) return { ...projectFromKey(override), root };
    const remotes = ((yield { kind: "git", args: ["remote"] }) ?? "").split("\n").map((name) => name.trim()).filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    const key = remote ? normalizeRemote((yield { kind: "git", args: ["remote", "get-url", remote] }) ?? "") : undefined;
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

function aliasProject(project: Project, config: Config): Project {
  const alias = config.aliases[project.key];
  return alias ? { ...projectFromKey(alias), root: project.root } : project;
}

/**
 * Resolves the project for a directory: `TDO_PROJECT`, then a `.tdo-project` file at the repo root,
 * then the normalized git remote (origin first), then `local:<home-relative main worktree path>`.
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
      value = read.kind === "git" ? git(cwd, read.args) : read.kind === "file" ? fs.readFileSync(read.path, "utf8") : fs.realpathSync(read.path);
    } catch {
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
        value = read.kind === "file" ? await fs.promises.readFile(read.path, "utf8") : await fs.promises.realpath(read.path);
      }
    } catch {
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

function expandHome(value: string, home: string): string {
  return value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

/** Optional user config at `$XDG_CONFIG_HOME/tdo/config.json`. */
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
};

export const DEFAULT_PER_PROJECT = 5;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Config {
  const file = getConfigPath(env, home);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { aliases: {} };
    throw error;
  }
  return parseConfig(raw, file, home);
}

export async function loadConfigAsync(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<Config> {
  const file = getConfigPath(env, home);
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { aliases: {} };
    throw error;
  }
  return parseConfig(raw, file, home);
}

function parseConfig(raw: string, file: string, home: string): Config {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} must contain a JSON object.`);
  const { db, aliases, perProject, floating, worktree } = parsed as { db?: unknown; aliases?: unknown; perProject?: unknown; floating?: unknown; worktree?: unknown };
  if (floating !== undefined && typeof floating !== "boolean") throw new Error(`${file}: "floating" must be a boolean.`);
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
  };
}

/** Database path: `TDO_DB`, then the config's `db`, then `$XDG_DATA_HOME/tdo/tdo.db`. */
export function getDbPath(env: NodeJS.ProcessEnv = process.env, options: { home?: string; config?: Config } = {}): string {
  const home = options.home ?? os.homedir();
  if (env.TDO_DB?.trim()) return env.TDO_DB.trim();
  const config = options.config ?? loadConfig(env, home);
  return config.db ?? path.join(getDataDir(env, home), "tdo.db");
}

export { SCHEMA, schemaVersion, planMigration, backupDb, migrateDb } from "./migrations/index.ts";
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

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
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

function toItem(row: ItemRow): Item {
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
  };
}

export function getItem(db: DatabaseSync, key: ItemKey): Item | undefined {
  const row = db.prepare(`${ITEM_SELECT} WHERE i.project_id = ? AND i.id = ?`).get(key.projectId, key.id) as ItemRow | undefined;
  return row ? toItem(row) : undefined;
}

/** Looks an item up by project key and per-project number. */
export function getItemByNumber(db: DatabaseSync, project: string, id: number): Item | undefined {
  const row = db.prepare(`${ITEM_SELECT} WHERE p.key = ? AND i.id = ?`).get(project, id) as ItemRow | undefined;
  return row ? toItem(row) : undefined;
}

/**
 * Resolves an item reference: `3` or `#3` in `project`, or `KEY#3` / `NAME#3` in another project
 * (a bare project name must match exactly one project).
 */
export function findItem(db: DatabaseSync, ref: string, project: string): Item {
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

function requireItem(db: DatabaseSync, key: ItemKey): Item {
  const item = getItem(db, key);
  if (!item) throw new Error(`No tdo item #${key.id} in project ${key.projectId}.`);
  return item;
}

export function addItem(db: DatabaseSync, input: NewItem): Item {
  const project = typeof input.project === "string" ? projectFromKey(input.project) : input.project;
  const title = cleanTitle(input.title);
  const priority = input.priority ? requirePriority(input.priority) : "normal";
  const key = transaction(db, (): ItemKey => {
    const projectId = ensureProject(db, project);
    const id = Number((db.prepare("UPDATE projects SET next_item_id = next_item_id + 1 WHERE id = ? RETURNING next_item_id - 1 AS id").get(projectId) as { id: number }).id);
    const timestamp = now();
    db.prepare(`INSERT INTO items (project_id, id, title, body, priority, file_ref, source, session_id, host, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      projectId, id, title, cleanOptional(input.body), PRIORITIES.indexOf(priority), cleanOptional(input.fileRef),
      cleanOptional(input.source), cleanOptional(input.sessionId), cleanOptional(input.host), timestamp, timestamp,
    );
    const insertTag = db.prepare("INSERT OR IGNORE INTO tags (project_id, item_id, tag) VALUES (?, ?, ?)");
    for (const tag of normalizeTags(input.tags)) insertTag.run(projectId, id, tag);
    return { projectId, id };
  });
  return requireItem(db, key);
}

export function updateItem(db: DatabaseSync, key: ItemKey, patch: ItemPatch): Item {
  transaction(db, () => {
    // Read under the write lock so a concurrent delete can't slip in between.
    const { projectId, id } = requireItem(db, key);
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.title !== undefined) { sets.push("title = ?"); values.push(cleanTitle(patch.title)); }
    if (patch.body !== undefined) { sets.push("body = ?"); values.push(cleanOptional(patch.body)); }
    if (patch.priority !== undefined) { sets.push("priority = ?"); values.push(PRIORITIES.indexOf(requirePriority(patch.priority))); }
    if (patch.fileRef !== undefined) { sets.push("file_ref = ?"); values.push(cleanOptional(patch.fileRef)); }
    const removeTag = db.prepare("DELETE FROM tags WHERE project_id = ? AND item_id = ? AND tag = ?");
    for (const tag of normalizeTags(patch.removeTags)) removeTag.run(projectId, id, tag);
    const insertTag = db.prepare("INSERT OR IGNORE INTO tags (project_id, item_id, tag) VALUES (?, ?, ?)");
    for (const tag of normalizeTags(patch.addTags)) insertTag.run(projectId, id, tag);
    sets.push("updated_at = ?");
    values.push(now());
    db.prepare(`UPDATE items SET ${sets.join(", ")} WHERE project_id = ? AND id = ?`).run(...values, projectId, id);
  });
  return requireItem(db, key);
}

/** Moves an item to a new status; `note` is appended to the body with the date and new status. */
export function setStatus(db: DatabaseSync, key: ItemKey, status: Status, note?: string): Item {
  if (!(STATUSES as readonly string[]).includes(status)) throw new Error(`status must be one of: ${STATUSES.join(", ")}.`);
  const trimmedNote = note?.trim();
  const closed = status === "done" || status === "dropped";
  // BEGIN IMMEDIATE takes the write lock before the read, so concurrent notes can't overwrite each other.
  transaction(db, () => {
    const item = requireItem(db, key);
    const timestamp = now();
    const body = trimmedNote ? [item.body, `[${status} ${timestamp.slice(0, 10)}] ${trimmedNote}`].filter(Boolean).join("\n\n") : item.body;
    db.prepare("UPDATE items SET status = ?, body = ?, closed_at = ?, updated_at = ? WHERE project_id = ? AND id = ?").run(
      status, body, closed ? (item.closedAt && item.status === status ? item.closedAt : timestamp) : null, timestamp, item.projectId, item.id,
    );
  });
  return requireItem(db, key);
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
  const closedFirst = status === "closed" || status === "done" || status === "dropped";
  const order = closedFirst
    ? "i.closed_at DESC, i.created_at DESC"
    : "CASE i.status WHEN 'doing' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, i.priority, i.created_at, p.key, i.id";
  const sql = `${ITEM_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ?`;
  return (db.prepare(sql).all(...values, limit === 0 ? -1 : limit) as ItemRow[]).map(toItem);
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
};

export function formatItemLine(item: Item, options: FormatOptions = {}): string {
  const { color } = options;
  const parts = [paint(itemRef(item, options), color, "bold"), paint(item.priority, color, ...PRIORITY_STYLE[item.priority]) + " ".repeat(6 - item.priority.length)];
  if (item.status !== "open") parts.push(paint(`[${item.status}]`, color, item.status === "doing" ? "cyan" : "dim"));
  parts.push(item.title);
  if (item.tags.length) parts.push(paint(item.tags.map((tag) => `#${tag}`).join(" "), color, "cyan"));
  if (item.fileRef) parts.push(paint(`@ ${item.fileRef}`, color, "dim"));
  return parts.join("  ");
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
export function formatGroupedList(items: Item[], options: { perProject?: number; color?: boolean; empty?: string } = {}): string {
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
    const lines = shown.map((item) => `  ${formatItemLine(item, { color })}`);
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
  if (item.body) lines.push("", item.body);
  return lines.join("\n");
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
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n") + (sections.length ? "\n" : "");
}
