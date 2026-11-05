/* Frozen historical schema and conversion: do not use current application helpers here. */
import type { DatabaseSync } from "node:sqlite";

/**
 * v2 -> v3 schema change. Adds notes (status notes move out of item bodies), tracker links, and
 * the link operation queue, and rebuilds full-text search with one row per item holding title,
 * body, and all notes. Each FTS trigger rewrites only its own columns.
 */
const V3_TABLES = `
ALTER TABLE items ADD COLUMN created_by_human INTEGER NOT NULL DEFAULT 0;
CREATE TABLE notes (
  project_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT CHECK (status IN ('open','doing','done','dropped')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, item_id, seq),
  FOREIGN KEY (project_id, item_id) REFERENCES items(project_id, id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE TABLE links (
  project_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  destination TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('awaiting-approval','creating','unknown','pending','open','closed','error')),
  attempt TEXT,
  external_id TEXT,
  url TEXT,
  error TEXT,
  error_kind TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  synced_at TEXT,
  next_op_seq INTEGER NOT NULL DEFAULT 1,
  drain_owner TEXT,
  drain_until TEXT,
  PRIMARY KEY (project_id, item_id, provider),
  FOREIGN KEY (project_id, item_id) REFERENCES items(project_id, id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE TABLE link_ops (
  project_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  seq INTEGER NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('update','close','reopen','comment')),
  reason TEXT,
  note_seq INTEGER,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','attention')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, item_id, provider, seq),
  FOREIGN KEY (project_id, item_id, provider) REFERENCES links(project_id, item_id, provider) ON DELETE CASCADE
) WITHOUT ROWID;
DROP TRIGGER IF EXISTS items_ai;
DROP TRIGGER IF EXISTS items_ad;
DROP TRIGGER IF EXISTS items_au;
DROP TABLE IF EXISTS items_fts;
`;

const NOTES_OF = (alias: string) => `coalesce((SELECT group_concat(body, char(10)) FROM (SELECT body FROM notes WHERE project_id = ${alias}.project_id AND item_id = ${alias}.item_id ORDER BY seq)), '')`;

const V3_FTS = `
CREATE VIRTUAL TABLE items_fts USING fts5(project_id UNINDEXED, item_id UNINDEXED, title, body, notes);
CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(project_id, item_id, title, body, notes) VALUES (new.project_id, new.id, new.title, coalesce(new.body, ''), '');
END;
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
  DELETE FROM items_fts WHERE project_id = old.project_id AND item_id = old.id;
END;
CREATE TRIGGER items_au AFTER UPDATE OF title, body ON items BEGIN
  UPDATE items_fts SET title = new.title, body = coalesce(new.body, '') WHERE project_id = old.project_id AND item_id = old.id;
END;
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  UPDATE items_fts SET notes = ${NOTES_OF("new")} WHERE project_id = new.project_id AND item_id = new.item_id;
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  UPDATE items_fts SET notes = ${NOTES_OF("old")} WHERE project_id = old.project_id AND item_id = old.item_id;
END;
`;

/** A status note as v2 appended it to the body: `[done 2026-11-04] text`. */
const BODY_NOTE = /^\[(open|doing|done|dropped) (\d{4}-\d{2}-\d{2})\] (\S[\s\S]*)$/;

type BodyNote = { status: string; date: string; body: string };

/**
 * Peels v2 status notes off the end of a body. Stops at the first trailing paragraph that isn't a
 * note, so anything ambiguous (a multi-paragraph note, user text) stays in the body.
 */
export function splitBodyNotes(body: string | null): { body: string | null; notes: BodyNote[] } {
  if (!body) return { body, notes: [] };
  const paragraphs = body.split("\n\n");
  const notes: BodyNote[] = [];
  while (paragraphs.length) {
    const match = BODY_NOTE.exec(paragraphs.at(-1)!);
    if (!match) break;
    paragraphs.pop();
    notes.unshift({ status: match[1]!, date: match[2]!, body: match[3]!.trim() });
  }
  return { body: paragraphs.join("\n\n").trim() || null, notes };
}

/** How many status notes the v3 conversion would move out of item bodies (run on a v2 database). */
export function planNoteExtraction(db: DatabaseSync): number {
  const rows = db.prepare("SELECT body FROM items WHERE body IS NOT NULL").all() as { body: string }[];
  return rows.reduce((total, row) => total + splitBodyNotes(row.body).notes.length, 0);
}

export function migrateToV3(db: DatabaseSync): void {
  db.exec(V3_TABLES);
  const rows = db.prepare("SELECT project_id, id, body FROM items WHERE body IS NOT NULL").all() as { project_id: string; id: number; body: string }[];
  const setBody = db.prepare("UPDATE items SET body = ? WHERE project_id = ? AND id = ?");
  const insertNote = db.prepare("INSERT INTO notes (project_id, item_id, seq, status, body, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const row of rows) {
    const split = splitBodyNotes(row.body);
    if (!split.notes.length) continue;
    setBody.run(split.body, row.project_id, row.id);
    split.notes.forEach((note, index) => insertNote.run(row.project_id, row.id, index + 1, note.status, note.body, `${note.date}T00:00:00.000Z`));
  }
  // Index after extraction so moved notes are indexed once, under `notes`.
  db.exec(V3_FTS);
  db.exec(`INSERT INTO items_fts(project_id, item_id, title, body, notes)
    SELECT i.project_id, i.id, i.title, coalesce(i.body, ''),
      coalesce((SELECT group_concat(body, char(10)) FROM (SELECT body FROM notes n WHERE n.project_id = i.project_id AND n.item_id = i.id ORDER BY seq)), '')
    FROM items i`);
}
