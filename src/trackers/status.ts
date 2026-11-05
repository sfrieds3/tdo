/** Tracker status presentation kept separate from CLI dispatch. No network calls. */
import type { Item } from "../core.ts";
import { isApproved, type EffectiveTracker } from "./config.ts";

export function summarizeLinks(items: Item[], config: EffectiveTracker): { queued: number; attention: number; differentDestination: number[]; statusMismatch: number[]; delivery: string } {
  let queued = 0, attention = 0;
  const differentDestination: number[] = [], statusMismatch: number[] = [];
  for (const item of items) {
    for (const link of item.links) {
      queued += link.queued;
      attention += link.attention;
      if (link.destination !== config.destination) differentDestination.push(item.id);
      const closed = item.status === "done" || item.status === "dropped";
      if (config.closeOnDone && ["open", "closed"].includes(link.state) && closed !== (link.state === "closed")) statusMismatch.push(item.id);
    }
  }
  return { queued, attention, differentDestination, statusMismatch, delivery: isApproved(config) ? "approved; existing links keep their persisted destination" : "paused: tracker is not approved; operations stay queued" };
}

export function formatSyncSummary(summary: ReturnType<typeof summarizeLinks>): string[] {
  return [
    `operations:  ${summary.queued} queued, ${summary.attention} need attention`,
    `delivery:    ${summary.delivery}`,
    ...summary.differentDestination.map((id) => `#${id}: bound to a different repo (existing destination retained)`),
    ...summary.statusMismatch.map((id) => `#${id}: local and last-synced issue status differ`),
  ];
}
