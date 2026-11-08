/** Durable lifecycle intent. Enqueue helpers run inside the caller's item transaction; network IO never does. */
import type { DatabaseSync } from "node:sqlite";
import type { ItemKey, Link } from "./core.ts";
import { transaction } from "./transaction.ts";

export type LinkOp = { seq: number; op: "update" | "close" | "reopen" | "comment"; reason: string | null; noteSeq: number | null; status: "queued" | "attention"; attempts: number; lastError: string | null };
type OpRow = { seq: number; op: LinkOp["op"]; reason: string | null; note_seq: number | null; status: LinkOp["status"]; attempts: number; last_error: string | null };
const WHERE = "project_id = ? AND item_id = ? AND provider = ?";
const LEASE_MS = 60_000;
const args = (key: ItemKey, provider: string) => [key.projectId, key.id, provider] as const;

/** Only consecutive updates on an entirely unleased link coalesce. Never rewrite an in-flight row. */
export function enqueueOp(db: DatabaseSync, key: ItemKey, provider: string, op: LinkOp["op"], reason: string | null = null, noteSeq: number | null = null): void {
  const target = args(key, provider);
  if (op === "update") {
    const tail = db.prepare(`SELECT op, status FROM link_ops WHERE ${WHERE} ORDER BY seq DESC LIMIT 1`).get(...target) as { op: string; status: string } | undefined;
    const lease = db.prepare(`SELECT drain_owner FROM links WHERE ${WHERE}`).get(...target) as { drain_owner: string | null };
    if (!lease.drain_owner && tail?.op === "update" && tail.status === "queued") return;
  }
  const row = db.prepare(`UPDATE links SET next_op_seq = next_op_seq + 1 WHERE ${WHERE} RETURNING next_op_seq - 1 AS seq`).get(...target) as { seq: number };
  db.prepare("INSERT INTO link_ops (project_id,item_id,provider,seq,op,reason,note_seq,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(...target, row.seq, op, reason, noteSeq, new Date().toISOString());
}

/** Called in the same transaction as the item change. Uncreated links deliberately receive no historical notes. */
export function enqueueLinked(db: DatabaseSync, key: ItemKey, op: LinkOp["op"], reason: string | null = null, noteSeq: number | null = null): void {
  const links = db.prepare("SELECT provider FROM links WHERE project_id = ? AND item_id = ? AND state IN ('open','closed')").all(key.projectId, key.id) as { provider: string }[];
  for (const link of links) enqueueOp(db, key, link.provider, op, reason, noteSeq);
}

export function leaseLinkOps(db: DatabaseSync, key: ItemKey, provider: string, owner: string, expected?: Pick<Link, "destination" | "externalId" | "url" | "createdAt">): boolean {
  const now = new Date().toISOString();
  return !!db.prepare(`UPDATE links SET drain_owner = ?, drain_until = ? WHERE ${WHERE} AND state IN ('open','closed') AND (drain_owner IS NULL OR drain_until < ?)${expected ? " AND destination = ? AND external_id IS ? AND url IS ? AND created_at = ?" : ""}`)
    .run(owner, new Date(Date.now() + LEASE_MS).toISOString(), ...args(key, provider), now, ...(expected ? [expected.destination, expected.externalId, expected.url, expected.createdAt] : [])).changes;
}

/** Renew before every operation, then fetch only the ordered head. Expired/stolen owners cannot renew. */
export function nextLinkOp(db: DatabaseSync, key: ItemKey, provider: string, owner: string): LinkOp | undefined {
  return transaction(db, () => {
    const renewed = db.prepare(`UPDATE links SET drain_until = ? WHERE ${WHERE} AND drain_owner = ? AND drain_until >= ?`)
      .run(new Date(Date.now() + LEASE_MS).toISOString(), ...args(key, provider), owner, new Date().toISOString()).changes;
    if (!renewed) return undefined;
    const row = db.prepare(`SELECT * FROM link_ops WHERE ${WHERE} ORDER BY seq LIMIT 1`).get(...args(key, provider)) as OpRow | undefined;
    return row ? { seq: row.seq, op: row.op, reason: row.reason, noteSeq: row.note_seq, status: row.status, attempts: row.attempts, lastError: row.last_error } : undefined;
  });
}

function ownsHead(db: DatabaseSync, key: ItemKey, provider: string, owner: string, seq: number): boolean {
  return !!db.prepare(`SELECT 1 FROM links WHERE ${WHERE} AND drain_owner = ? AND drain_until >= ? AND ? = (SELECT min(seq) FROM link_ops WHERE ${WHERE})`)
    .get(...args(key, provider), owner, new Date().toISOString(), seq, ...args(key, provider));
}

/** `labels`, when given, replaces the record of labels tdo applied (sent with a delivered update). */
export function ackOp(db: DatabaseSync, key: ItemKey, provider: string, owner: string, seq: number, labels?: string[]): boolean {
  return transaction(db, () => {
    if (!ownsHead(db, key, provider, owner, seq)) return false;
    const row = db.prepare(`SELECT op FROM link_ops WHERE ${WHERE} AND seq = ?`).get(...args(key, provider), seq) as { op: string };
    if (row.op === "close" || row.op === "reopen") db.prepare(`UPDATE links SET state = ? WHERE ${WHERE}`).run(row.op === "close" ? "closed" : "open", ...args(key, provider));
    db.prepare(`UPDATE links SET synced_at = ? WHERE ${WHERE}`).run(new Date().toISOString(), ...args(key, provider));
    if (labels) db.prepare(`UPDATE links SET labels = ? WHERE ${WHERE}`).run(JSON.stringify(labels), ...args(key, provider));
    db.prepare(`DELETE FROM link_ops WHERE ${WHERE} AND seq = ?`).run(...args(key, provider), seq);
    return true;
  });
}

export function failOp(db: DatabaseSync, key: ItemKey, provider: string, owner: string, seq: number, attention: boolean, message: string): boolean {
  return transaction(db, () => {
    if (!ownsHead(db, key, provider, owner, seq)) return false;
    db.prepare(`UPDATE link_ops SET attempts = attempts + 1, last_error = ?, status = CASE WHEN ? OR attempts + 1 >= 5 THEN 'attention' ELSE 'queued' END WHERE ${WHERE} AND seq = ?`)
      .run(message, attention ? 1 : 0, ...args(key, provider), seq);
    return true;
  });
}

export function releaseLinkOps(db: DatabaseSync, key: ItemKey, provider: string, owner: string): boolean {
  return !!db.prepare(`UPDATE links SET drain_owner = NULL, drain_until = NULL WHERE ${WHERE} AND drain_owner = ? AND drain_until >= ?`)
    .run(...args(key, provider), owner, new Date().toISOString()).changes;
}

/** Explicit reset only, scoped to the current project. Never reset an active drainer's operations. */
export function retryLinkOps(db: DatabaseSync, project: string): number {
  return Number(db.prepare(`UPDATE link_ops SET status = 'queued', attempts = 0, last_error = NULL WHERE status = 'attention' AND project_id IN (SELECT id FROM projects WHERE key = ?) AND EXISTS (SELECT 1 FROM links l WHERE l.project_id = link_ops.project_id AND l.item_id = link_ops.item_id AND l.provider = link_ops.provider AND (l.drain_owner IS NULL OR l.drain_until < ?))`)
    .run(project, new Date().toISOString()).changes);
}

export function queueCounts(db: DatabaseSync, key: ItemKey, provider: string): { queued: number; attention: number; syncError: string | null } {
  const rows = db.prepare(`SELECT status, count(*) AS n FROM link_ops WHERE ${WHERE} GROUP BY status`).all(...args(key, provider)) as { status: string; n: number }[];
  const error = db.prepare(`SELECT last_error FROM link_ops WHERE ${WHERE} AND last_error IS NOT NULL ORDER BY seq LIMIT 1`).get(...args(key, provider)) as { last_error: string } | undefined;
  return { syncError: error?.last_error ?? null, queued: Number(rows.find((row) => row.status === "queued")?.n ?? 0), attention: Number(rows.find((row) => row.status === "attention")?.n ?? 0) };
}
