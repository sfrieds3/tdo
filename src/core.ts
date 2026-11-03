/**
 * tdo — per-project "fix later" backlog stored in SQLite.
 *
 * Shared by the `tdo` CLI (src/cli.ts) and the Pi extension (extensions/tdo.ts); agents use the CLI via skills/tdo.
 * Uses only erasable TypeScript syntax so Node can run it directly with type stripping.
 */
import { execFileSync } from "node:child_process";
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

export type Item = {
  id: number;
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

const SCHEMA_VERSION = 1;
const MAX_TITLE_CHARS = 200;

const SCHEMA_V1 = `
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
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
  closed_at TEXT
);
CREATE TABLE tags (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
);
CREATE INDEX items_project_status ON items(project_id, status, priority);
CREATE INDEX tags_tag ON tags(tag);
CREATE VIRTUAL TABLE items_fts USING fts5(title, body, content='items', content_rowid='id');
CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, body) VALUES (new.id, new.title, coalesce(new.body, ''));
END;
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body) VALUES ('delete', old.id, old.title, coalesce(old.body, ''));
END;
CREATE TRIGGER items_au AFTER UPDATE OF title, body ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body) VALUES ('delete', old.id, old.title, coalesce(old.body, ''));
  INSERT INTO items_fts(rowid, title, body) VALUES (new.id, new.title, coalesce(new.body, ''));
END;
`;

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
};

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
  const { db, aliases } = parsed as { db?: unknown; aliases?: unknown };
  if (db !== undefined && typeof db !== "string") throw new Error(`${file}: "db" must be a string.`);
  if (aliases !== undefined && (!aliases || typeof aliases !== "object" || Array.isArray(aliases) || Object.values(aliases).some((value) => typeof value !== "string" || !value.trim()))) {
    throw new Error(`${file}: "aliases" must map project keys to non-empty strings.`);
  }
  return { db: db?.trim() ? expandHome(db.trim(), home) : undefined, aliases: { ...(aliases as Record<string, string> | undefined) } };
}

/** Database path: `TDO_DB`, then the config's `db`, then `$XDG_DATA_HOME/tdo/tdo.db`. */
export function getDbPath(env: NodeJS.ProcessEnv = process.env, options: { home?: string; config?: Config } = {}): string {
  const home = options.home ?? os.homedir();
  if (env.TDO_DB?.trim()) return env.TDO_DB.trim();
  const config = options.config ?? loadConfig(env, home);
  return config.db ?? path.join(getDataDir(env, home), "tdo.db");
}

export function openDb(dbPath = getDbPath()): DatabaseSync {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version > SCHEMA_VERSION) throw new Error(`tdo database schema v${version} is newer than this tdo (v${SCHEMA_VERSION}).`);
  if (version === SCHEMA_VERSION) return;
  transaction(db, () => {
    if (version < 1) db.exec(SCHEMA_V1);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
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

function ensureProject(db: DatabaseSync, project: Project): number {
  db.prepare("INSERT INTO projects (key, display_name, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING").run(project.key, project.name, now());
  return Number((db.prepare("SELECT id FROM projects WHERE key = ?").get(project.key) as { id: number }).id);
}

const ITEM_SELECT = `
SELECT i.*, p.key AS project_key,
  (SELECT group_concat(tag, ',') FROM (SELECT tag FROM tags WHERE item_id = i.id ORDER BY tag)) AS tag_list
FROM items i JOIN projects p ON p.id = i.project_id`;

type ItemRow = {
  id: number;
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

export function getItem(db: DatabaseSync, id: number): Item | undefined {
  const row = db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id) as ItemRow | undefined;
  return row ? toItem(row) : undefined;
}

function requireItem(db: DatabaseSync, id: number): Item {
  const item = getItem(db, id);
  if (!item) throw new Error(`No tdo item #${id}.`);
  return item;
}

export function addItem(db: DatabaseSync, input: NewItem): Item {
  const project = typeof input.project === "string" ? projectFromKey(input.project) : input.project;
  const title = cleanTitle(input.title);
  const priority = input.priority ? requirePriority(input.priority) : "normal";
  const id = transaction(db, () => {
    const projectId = ensureProject(db, project);
    const timestamp = now();
    const result = db.prepare(`INSERT INTO items (project_id, title, body, priority, file_ref, source, session_id, host, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      projectId, title, cleanOptional(input.body), PRIORITIES.indexOf(priority), cleanOptional(input.fileRef),
      cleanOptional(input.source), cleanOptional(input.sessionId), cleanOptional(input.host), timestamp, timestamp,
    );
    const itemId = Number(result.lastInsertRowid);
    const insertTag = db.prepare("INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?, ?)");
    for (const tag of normalizeTags(input.tags)) insertTag.run(itemId, tag);
    return itemId;
  });
  return requireItem(db, id);
}

export function updateItem(db: DatabaseSync, id: number, patch: ItemPatch): Item {
  requireItem(db, id);
  transaction(db, () => {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.title !== undefined) { sets.push("title = ?"); values.push(cleanTitle(patch.title)); }
    if (patch.body !== undefined) { sets.push("body = ?"); values.push(cleanOptional(patch.body)); }
    if (patch.priority !== undefined) { sets.push("priority = ?"); values.push(PRIORITIES.indexOf(requirePriority(patch.priority))); }
    if (patch.fileRef !== undefined) { sets.push("file_ref = ?"); values.push(cleanOptional(patch.fileRef)); }
    const removeTag = db.prepare("DELETE FROM tags WHERE item_id = ? AND tag = ?");
    for (const tag of normalizeTags(patch.removeTags)) removeTag.run(id, tag);
    const insertTag = db.prepare("INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?, ?)");
    for (const tag of normalizeTags(patch.addTags)) insertTag.run(id, tag);
    sets.push("updated_at = ?");
    values.push(now());
    db.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  });
  return requireItem(db, id);
}

/** Moves an item to a new status; `note` is appended to the body with the date and new status. */
export function setStatus(db: DatabaseSync, id: number, status: Status, note?: string): Item {
  if (!(STATUSES as readonly string[]).includes(status)) throw new Error(`status must be one of: ${STATUSES.join(", ")}.`);
  const item = requireItem(db, id);
  const timestamp = now();
  const closed = status === "done" || status === "dropped";
  const trimmedNote = note?.trim();
  const body = trimmedNote ? [item.body, `[${status} ${timestamp.slice(0, 10)}] ${trimmedNote}`].filter(Boolean).join("\n\n") : item.body;
  db.prepare("UPDATE items SET status = ?, body = ?, closed_at = ?, updated_at = ? WHERE id = ?").run(
    status, body, closed ? (item.closedAt && item.status === status ? item.closedAt : timestamp) : null, timestamp, id,
  );
  return requireItem(db, id);
}

export function deleteItem(db: DatabaseSync, id: number): Item {
  const item = requireItem(db, id);
  db.prepare("DELETE FROM items WHERE id = ?").run(id);
  return item;
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
    where.push("EXISTS (SELECT 1 FROM tags t WHERE t.item_id = i.id AND t.tag = ?)");
    values.push(tag);
  }
  if (filter.minPriority !== undefined) { where.push("i.priority <= ?"); values.push(PRIORITIES.indexOf(requirePriority(filter.minPriority))); }
  const query = filter.query ? ftsQuery(filter.query) : undefined;
  if (filter.query && !query) return [];
  if (query) { where.push("i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)"); values.push(query); }
  const closedFirst = status === "closed" || status === "done" || status === "dropped";
  const order = closedFirst
    ? "i.closed_at DESC, i.id DESC"
    : "CASE i.status WHEN 'doing' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, i.priority, i.created_at, i.id";
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
  const rows = db.prepare(`SELECT t.tag AS tag, count(*) AS n FROM tags t JOIN items i ON i.id = t.item_id JOIN projects p ON p.id = i.project_id
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

export function formatItemLine(item: Item, options: { showProject?: boolean } = {}): string {
  const parts = [`#${item.id}`, item.priority.padEnd(6)];
  if (item.status !== "open") parts.push(`[${item.status}]`);
  parts.push(item.title);
  if (item.tags.length) parts.push(item.tags.map((tag) => `#${tag}`).join(" "));
  if (item.fileRef) parts.push(`@ ${item.fileRef}`);
  if (options.showProject) parts.push(`(${item.project})`);
  return parts.join("  ");
}

export function formatItemList(items: Item[], options: { showProject?: boolean; empty?: string } = {}): string {
  return items.length ? items.map((item) => formatItemLine(item, options)).join("\n") : (options.empty ?? "(nothing here)");
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
