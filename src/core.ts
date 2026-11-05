/**
 * tdo — per-project "fix later" backlog stored in SQLite.
 *
 * Shared by the `tdo` CLI (src/cli.ts) and the Pi extension (extensions/tdo.ts); agents use the CLI via skills/tdo.
 * Uses only erasable TypeScript syntax so Node can run it directly with type stripping.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type * as Sqlite from "node:sqlite";

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
  limit?: number;
};

const SCHEMA_VERSION = 2;
const MAX_TITLE_CHARS = 200;

/**
 * v2 schema. Projects have a UUID id; items are keyed by (project_id, id), where id is the per-project
 * number shown as `#3`. `next_item_id` keeps numbers from being reused after a delete.
 * Full-text search keeps its own copy of title and body, keyed by the same pair.
 */
const SCHEMA_V2 = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  display_name TEXT,
  next_item_id INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE items (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id INTEGER NOT NULL CHECK (id > 0),
  title TEXT NOT NULL,
  body TEXT,
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','doing','done','dropped')),
  file_ref TEXT,
  source TEXT,
  session_id TEXT,
  host TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (project_id, id)
) WITHOUT ROWID;
CREATE TABLE tags (
  project_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (project_id, item_id, tag),
  FOREIGN KEY (project_id, item_id) REFERENCES items(project_id, id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX items_project_status ON items(project_id, status, priority);
CREATE INDEX tags_tag ON tags(tag);
CREATE VIRTUAL TABLE items_fts USING fts5(project_id UNINDEXED, item_id UNINDEXED, title, body);
CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(project_id, item_id, title, body) VALUES (new.project_id, new.id, new.title, coalesce(new.body, ''));
END;
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
  DELETE FROM items_fts WHERE project_id = old.project_id AND item_id = old.id;
END;
CREATE TRIGGER items_au AFTER UPDATE OF title, body ON items BEGIN
  UPDATE items_fts SET title = new.title, body = coalesce(new.body, '') WHERE project_id = old.project_id AND item_id = old.id;
END;
`;

/** v1 had integer project ids and one global item id sequence; renumber items per project in creation order. */
function migrateFromV1(db: DatabaseSync): void {
  const projects = db.prepare("SELECT id, key, display_name, created_at FROM projects ORDER BY id").all() as { id: number; key: string; display_name: string | null; created_at: string }[];
  const items = db.prepare("SELECT * FROM items ORDER BY project_id, id").all() as Record<string, string | number | null>[];
  const tags = db.prepare("SELECT item_id, tag FROM tags").all() as { item_id: number; tag: string }[];
  db.exec(`DROP TRIGGER IF EXISTS items_ai; DROP TRIGGER IF EXISTS items_ad; DROP TRIGGER IF EXISTS items_au;
    DROP TABLE IF EXISTS items_fts; DROP TABLE tags; DROP TABLE items; DROP TABLE projects;`);
  db.exec(SCHEMA_V2);
  const projectIds = new Map<number, string>();
  const insertProject = db.prepare("INSERT INTO projects (id, key, display_name, created_at) VALUES (?, ?, ?, ?)");
  for (const project of projects) {
    const id = randomUUID();
    projectIds.set(Number(project.id), id);
    insertProject.run(id, project.key, project.display_name, project.created_at);
  }
  const itemKeys = new Map<number, [string, number]>();
  const nextIds = new Map<string, number>();
  const insertItem = db.prepare(`INSERT INTO items (project_id, id, title, body, priority, status, file_ref, source, session_id, host, created_at, updated_at, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const item of items) {
    const projectId = projectIds.get(Number(item.project_id))!;
    const id = nextIds.get(projectId) ?? 1;
    nextIds.set(projectId, id + 1);
    itemKeys.set(Number(item.id), [projectId, id]);
    insertItem.run(projectId, id, item.title, item.body, item.priority, item.status, item.file_ref, item.source, item.session_id, item.host, item.created_at, item.updated_at, item.closed_at);
  }
  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (project_id, item_id, tag) VALUES (?, ?, ?)");
  for (const tag of tags) {
    const key = itemKeys.get(Number(tag.item_id));
    if (key) insertTag.run(key[0], key[1], tag.tag);
  }
  const setNext = db.prepare("UPDATE projects SET next_item_id = ? WHERE id = ?");
  for (const [projectId, next] of nextIds) setNext.run(next, projectId);
}

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
  const tag = value.trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, "-");
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
  const relative = path.relative(realpath(home), realpath(target));
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

function detectProject(cwd: string, env: NodeJS.ProcessEnv, home: string): Project {
  if (env.TDO_PROJECT?.trim()) return projectFromKey(env.TDO_PROJECT);
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return { ...projectFromKey(`local:${homeRelative(path.resolve(cwd), home)}`), root: path.resolve(cwd) };
  try {
    const override = fs.readFileSync(path.join(top, PROJECT_FILE), "utf8").split("\n")[0]?.trim();
    if (override) return { ...projectFromKey(override), root: top };
  } catch {
    // No override file.
  }
  const remotes = (git(cwd, ["remote"]) ?? "").split("\n").map((name) => name.trim()).filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  const key = remote ? normalizeRemote(git(cwd, ["remote", "get-url", remote]) ?? "") : undefined;
  if (key) return { ...projectFromKey(key), root: top };
  // Worktrees share their main checkout's backlog.
  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const mainRoot = commonDir && path.basename(commonDir) === ".git" ? path.dirname(commonDir) : top;
  return { ...projectFromKey(`local:${homeRelative(mainRoot, home)}`), root: top };
}

/**
 * Resolves the project for a directory: `TDO_PROJECT`, then a `.tdo-project` file at the repo root,
 * then the normalized git remote (origin first), then `local:<home-relative main worktree path>`.
 * The result is then mapped through the config's `aliases`.
 */
export function resolveProject(cwd: string, options: { env?: NodeJS.ProcessEnv; home?: string; config?: Config } = {}): Project {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const project = detectProject(cwd, env, home);
  const alias = (options.config ?? loadConfig(env, home)).aliases[project.key];
  return alias ? { ...projectFromKey(alias), root: project.root } : project;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} must contain a JSON object.`);
  const { db, aliases, perProject, floating } = parsed as { db?: unknown; aliases?: unknown; perProject?: unknown; floating?: unknown };
  if (floating !== undefined && typeof floating !== "boolean") throw new Error(`${file}: "floating" must be a boolean.`);
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
  };
}

/** Database path: `TDO_DB`, then the config's `db`, then `$XDG_DATA_HOME/tdo/tdo.db`. */
export function getDbPath(env: NodeJS.ProcessEnv = process.env, options: { home?: string; config?: Config } = {}): string {
  const home = options.home ?? os.homedir();
  if (env.TDO_DB?.trim()) return env.TDO_DB.trim();
  const config = options.config ?? loadConfig(env, home);
  return config.db ?? path.join(getDataDir(env, home), "tdo.db");
}

export const SCHEMA = SCHEMA_VERSION;

export function schemaVersion(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

export type OpenOptions = {
  /** Upgrade an older schema (default true). With false, the caller must run `migrateDb`. */
  migrate?: boolean;
};

export function openDb(dbPath = getDbPath(), options: OpenOptions = {}): DatabaseSync {
  if (/^[a-z][a-z0-9+.-]*:/i.test(dbPath) && dbPath !== ":memory:") throw new Error("openDb accepts local paths only; use the operation-level store for remote targets.");
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  if (options.migrate !== false) migrateDb(db, dbPath);
  return db;
}

/** One row per item whose id changes in a v1 -> v2 upgrade. */
export type IdChange = { project: string; from: number; to: number; title: string };

/** Previews how a v1 database's global item ids map to per-project ids. Empty for other versions. */
export function planMigration(db: DatabaseSync): IdChange[] {
  if (schemaVersion(db) !== 1) return [];
  const rows = db.prepare("SELECT i.id AS id, i.title AS title, p.key AS project FROM items i JOIN projects p ON p.id = i.project_id ORDER BY i.project_id, i.id").all() as { id: number; title: string; project: string }[];
  const next = new Map<string, number>();
  return rows.map((row) => {
    const to = next.get(row.project) ?? 1;
    next.set(row.project, to + 1);
    return { project: row.project, from: Number(row.id), to, title: row.title };
  });
}

/** Writes a consistent copy of the database next to it, e.g. `tdo.db.v1-backup-20261104T120000`. */
export function backupDb(db: DatabaseSync, dbPath: string): string {
  const stamp = now().replace(/[-:]/g, "").replace(/\..*$/, "");
  const target = `${dbPath}.v${schemaVersion(db)}-backup-${stamp}`;
  db.prepare("VACUUM INTO ?").run(target);
  return target;
}

export type MigrationResult = { from: number; to: number; backup?: string; changes: IdChange[] };

/**
 * Brings the schema up to date. A file database on an older schema is backed up first
 * (see `backupDb`), since the v2 upgrade renumbers items.
 */
export function migrateDb(db: DatabaseSync, dbPath?: string): MigrationResult {
  const version = schemaVersion(db);
  if (version > SCHEMA_VERSION) throw new Error(`tdo database schema v${version} is newer than this tdo (v${SCHEMA_VERSION}).`);
  if (version === SCHEMA_VERSION) return { from: version, to: version, changes: [] };
  const changes = planMigration(db);
  // VACUUM INTO can't run inside a transaction, so the backup is taken before the write lock.
  // If another process finished the upgrade meanwhile, our backup is redundant and is removed.
  let backup = version > 0 && dbPath && dbPath !== ":memory:" ? backupDb(db, dbPath) : undefined;
  const migrated = transaction(db, () => {
    // Another process may have upgraded it while we waited for the write lock.
    const locked = schemaVersion(db);
    if (locked === SCHEMA_VERSION) return false;
    if (locked < 1) db.exec(SCHEMA_V2);
    else if (locked < 2) migrateFromV1(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return true;
  });
  if (!migrated && backup) {
    fs.rmSync(backup, { force: true });
    backup = undefined;
  }
  return { from: version, to: SCHEMA_VERSION, backup, changes: migrated ? changes : [] };
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
  const limit = Math.max(1, Math.min(filter.limit ?? 500, 5000));
  const sql = `${ITEM_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ${limit}`;
  return (db.prepare(sql).all(...values) as ItemRow[]).map(toItem);
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

export function formatItemList(items: Item[], options: FormatOptions & { empty?: string } = {}): string {
  return items.length ? items.map((item) => formatItemLine(item, options)).join("\n") : (options.empty ?? "(nothing here)");
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
    if (hidden > 0) lines.push(paint(`  … ${hidden} more (tdo ls --project ${key})`, color, "dim"));
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
