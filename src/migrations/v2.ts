/* Frozen historical schema and conversion: do not use current application helpers here. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * v2 schema. Projects have a UUID id; items are keyed by (project_id, id), where id is the per-project
 * number shown as `#3`. `next_item_id` keeps numbers from being reused after a delete.
 * Full-text search keeps its own copy of title and body, keyed by the same pair.
 */
export const SCHEMA_V2 = `
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
export function migrateFromV1(db: DatabaseSync): void {
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
