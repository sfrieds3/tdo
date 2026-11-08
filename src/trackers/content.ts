/** The issue as filed or updated: current title/body plus file reference, never historical notes or tdo markers. */
import type { Item } from "../core.ts";
import type { NewIssue } from "./types.ts";

export function renderIssue(item: Item, labels: string[]): NewIssue {
  const parts = [item.body?.trim(), item.fileRef ? `\`${item.fileRef}\`` : undefined].filter(Boolean);
  return { title: item.title, body: parts.join("\n\n"), labels };
}

/**
 * Labels tdo manages on an item's issue: the configured labels plus the item's tags, except the
 * tracker's own filing tag (it marks items for filing; it isn't a label). Configured labels come first; duplicates are dropped.
 */
export function issueLabels(item: Pick<Item, "tags">, config: { labels: string[]; tag?: string }): string[] {
  const labels = new Map<string, string>();
  for (const label of [...config.labels, ...item.tags.filter((tag) => tag !== config.tag)]) {
    if (!labels.has(label.toLowerCase())) labels.set(label.toLowerCase(), label);
  }
  return [...labels.values()];
}

/**
 * The label edit that moves an issue from what tdo last applied to `desired`. Only labels tdo applied
 * are ever removed; with no record (`applied` null) nothing is removed. GitHub labels are case-insensitive.
 */
export function labelDelta(applied: string[] | null, desired: string[]): { add: string[]; remove: string[] } {
  const want = new Set(desired.map((label) => label.toLowerCase()));
  const had = new Set((applied ?? []).map((label) => label.toLowerCase()));
  return {
    add: desired.filter((label) => !had.has(label.toLowerCase())),
    remove: (applied ?? []).filter((label) => !want.has(label.toLowerCase())),
  };
}
