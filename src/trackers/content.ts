/** The issue as filed or updated: current title/body plus file reference, never historical notes or tdo markers. */
import type { Item } from "../core.ts";
import type { NewIssue } from "./types.ts";

export function renderIssue(item: Item, labels: string[]): NewIssue {
  const parts = [item.body?.trim(), item.fileRef ? `\`${item.fileRef}\`` : undefined].filter(Boolean);
  return { title: item.title, body: parts.join("\n\n"), labels };
}
