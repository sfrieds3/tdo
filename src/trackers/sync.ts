/**
 * Filing items as issues. Runs on the caller's machine (never in the SSH helper): the store only
 * persists links, and every network call happens with no database transaction open.
 */
import { drainItems, drainLink, type DrainResult } from "./drain.ts";
import { isApproved } from "./config.ts";
import type { Item, Link } from "../core.ts";
import type { Store } from "../store.ts";
import type { EffectiveTracker } from "./config.ts";
import { githubTracker } from "./github.ts";
import { renderIssue } from "./content.ts";
export { renderIssue } from "./content.ts";
import type { Tracker } from "./types.ts";

export type PushResult = { id: number; state: Link["state"] | "skipped"; url?: string; error?: string; ok: boolean };

export function trackerFor(destination: string, env?: NodeJS.ProcessEnv): Tracker {
  return githubTracker({ destination, env });
}

function linkOf(item: Item, provider: string): Link | undefined {
  return item.links.find((link) => link.provider === provider);
}

const RECOVER = "check the tracker: `tdo push ID --attach URL` if the issue exists, `tdo push ID --force` if it doesn't";

function report(item: Item, link: Link): PushResult {
  switch (link.state) {
    case "open":
    case "closed":
      return { id: item.id, state: link.state, url: link.url ?? undefined, ok: true };
    case "unknown":
      return { id: item.id, state: link.state, error: `#${item.id}: earlier attempt has an unknown outcome; ${RECOVER.replaceAll("ID", String(item.id))}.`, ok: false };
    case "creating":
      return { id: item.id, state: link.state, error: `#${item.id} is being filed right now.`, ok: false };
    default:
      return { id: item.id, state: link.state, error: link.error ?? `#${item.id} is ${link.state}.`, ok: false };
  }
}

export type PushOptions = { force?: boolean; noSync?: boolean; env?: NodeJS.ProcessEnv; warn: (message: string) => void; tracker?: (destination: string) => Tracker };

/** Files one item. Returns a result rather than throwing, so multi-item pushes continue past failures. */
export function pushItem(store: Store, item: Item, config: EffectiveTracker, options: PushOptions): PushResult {
  if (!isApproved(config)) return { id: item.id, state: "skipped", error: "tracker is not approved", ok: false };
  const provider = config.provider;
  const existing = linkOf(item, provider);
  if (options.force && (!existing || (existing.state !== "unknown" && existing.state !== "creating"))) {
    return { id: item.id, state: existing?.state ?? "skipped", error: `#${item.id}: --force only applies to an unknown or interrupted attempt.`, ok: false };
  }
  if (existing && (existing.state === "open" || existing.state === "closed")) return report(item, existing);
  if (existing?.state === "unknown" && !options.force) return report(item, existing);
  // Existing links keep their destination; only new links take the current config's.
  const destination = existing?.destination ?? config.destination;
  const claim = store.call("claimLinkCreate", item, provider, destination, options.force ? "force" : "create");
  if (!claim.token) return report(item, claim.link);
  const tracker = (options.tracker ?? ((target) => trackerFor(target, options.env)))(destination);
  const issue = renderIssue(item, config.labels);
  const result = tracker.create(issue);
  const outcome = result.ok
    ? { ok: true as const, externalId: result.value.id, url: result.value.url, snapshot: { title: item.title, body: item.body, fileRef: item.fileRef } }
    : { ok: false as const, kind: result.kind, message: result.message };
  let link: Link | undefined;
  try {
    link = store.call("finishLinkCreate", item, provider, claim.token, outcome, config.closeOnDone);
  } catch (error) {
    // The issue exists but we couldn't record it; leave a trail so --attach can recover it.
    if (result.ok) options.warn(`#${item.id}: filed ${result.value.url} but couldn't record it (${(error as Error).message}); run \`tdo push ${item.id} --attach ${result.value.url}\` later.`);
    throw error;
  }
  if (!link) {
    if (result.ok) options.warn(`#${item.id}: filed ${result.value.url}, but this attempt was superseded; close it or \`tdo push ${item.id} --attach ${result.value.url}\`.`);
    return { id: item.id, state: "skipped", url: result.ok ? result.value.url : undefined, error: `#${item.id}: attempt was superseded.`, ok: false };
  }
  if (result.ok) {
    if (!options.noSync) drainLink(store, item, link, config, { ...options, limit: 5 });
    return { id: item.id, state: store.call("getLink", item, provider)?.state ?? link.state, url: link.url ?? undefined, ok: true };
  }
  const hint = result.kind === "uncertain" ? ` (${RECOVER.replaceAll("ID", String(item.id))})` : "";
  return { id: item.id, state: link.state, error: `#${item.id}: ${result.message}${hint}`, ok: false };
}

/** Current-project explicit sync; it never creates awaiting, error, or unknown links. */
export function syncProject(store: Store, project: string, config: EffectiveTracker, options: PushOptions & { retry?: boolean }): (PushResult | DrainResult)[] {
  if (!isApproved(config)) throw new Error("tracker is not approved; run tdo tracker approve");
  store.call("expireStaleClaims", project);
  if (options.retry) store.call("retryLinkOps", project);
  const pending = store.call("listLinkedItems", project).filter((item) => item.links.some((link) => link.state === "pending"));
  const creates = pending.map((item) => pushItem(store, item, config, { ...options, noSync: true }));
  const drained = drainItems(store, store.call("listLinkedItems", project), config, { ...options, limit: Infinity });
  const results = new Map<number, PushResult | DrainResult>();
  for (const row of [...creates, ...drained]) results.set(row.id, { ...results.get(row.id), ...row });
  return [...results.values()];
}
