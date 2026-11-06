/** Caller-side bounded queue delivery. All store operations finish their transactions before gh starts. */
import { randomUUID } from "node:crypto";
import type { Item, Link } from "../core.ts";
import type { LinkOp } from "../link-ops.ts";
import type { Store } from "../store.ts";
import { isApproved, type EffectiveTracker } from "./config.ts";
import { renderIssue } from "./content.ts";
import { githubTracker } from "./github.ts";
import type { Tracker, TrackerResult } from "./types.ts";

export type DrainOptions = { warn: (message: string) => void; env?: NodeJS.ProcessEnv; tracker?: (destination: string) => Tracker; limit?: number };
export type DrainResult = { id: number; sent: number; attempted: number; error?: string };

function deliver(tracker: Tracker, link: Link, item: Item, op: LinkOp): TrackerResult<void> {
  const id = link.externalId!;
  switch (op.op) {
    case "update": {
      const { title, body } = renderIssue(item, []);
      return tracker.update(id, { title, body });
    }
    case "close": return tracker.close(id, op.reason === "not planned" ? "not planned" : "completed");
    case "reopen": return tracker.reopen(id);
    case "comment": {
      const note = item.notes.find((note) => note.seq === op.noteSeq);
      return note ? tracker.comment(id, note.body) : { ok: false, kind: "attention", message: "queued note is missing" };
    }
  }
}

/** Failure never undoes or fails a local item command, including transport/ack failures. */
export function drainLink(store: Store, item: Item, link: Link, config: EffectiveTracker, options: DrainOptions): DrainResult {
  const result: DrainResult = { id: item.id, sent: 0, attempted: 0 };
  if (!isApproved(config) || link.provider !== config.provider || !link.externalId || !["open", "closed"].includes(link.state)) return result;
  const owner = randomUUID();
  let leased = false;
  try {
    leased = store.call("leaseLinkOps", item, link.provider, owner, { destination: link.destination, externalId: link.externalId, url: link.url, createdAt: link.createdAt });
    if (!leased) return result;
    const tracker = (options.tracker ?? ((destination) => githubTracker({ destination, env: options.env })))(link.destination);
    while (result.attempted < (options.limit ?? Infinity)) {
      const op = store.call("nextLinkOp", item, link.provider, owner);
      if (!op) break;
      if (op.status === "attention") { result.error = op.lastError ?? "queued operation needs attention; run tdo sync --retry"; break; }
      const current = store.call("getItem", item);
      if (!current) break;
      result.attempted++;
      const delivered = deliver(tracker, link, current, op);
      if (!delivered.ok) {
        store.call("failOp", item, link.provider, owner, op.seq, delivered.kind === "attention", delivered.message);
        result.error = delivered.message;
        break;
      }
      if (!store.call("ackOp", item, link.provider, owner, op.seq)) { result.error = "sync lease lost; operation remains queued"; break; }
      result.sent++;
    }
  } catch (error) {
    result.error = (error as Error).message;
  } finally {
    if (leased) {
      try { store.call("releaseLinkOps", item, link.provider, owner); }
      catch (error) { result.error ??= (error as Error).message; }
    }
  }
  if (result.error) options.warn(`tdo: #${item.id}: sync paused: ${result.error}; remaining operations are saved for tdo sync.`);
  return result;
}

/** One budget for the whole ordinary command, not five per selected item. */
export function drainItems(store: Store, items: Item[], config: EffectiveTracker, options: DrainOptions): DrainResult[] {
  let remaining = options.limit ?? 5;
  const results: DrainResult[] = [];
  for (const item of items) {
    for (const link of item.links) {
      if (!["open", "closed"].includes(link.state) || !link.externalId) continue;
      if (remaining <= 0) return results;
      const result = drainLink(store, item, link, config, { ...options, limit: remaining });
      remaining -= result.attempted;
      results.push(result);
    }
  }
  return results;
}
