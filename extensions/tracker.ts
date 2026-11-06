/** Tracker UI authorization. Dialogs serialize and every await is followed by fresh validation. */
import { parseArgs } from "node:util";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalJson, getDbPath, loadConfig, parseQuickAdd, resolveProject, sha256, updateConfig, type Item } from "../src/core.ts";
import { callStore } from "./store.ts";
import { createAsyncStore, parseTarget } from "../src/store.ts";
import { isApproved, resolveTracker, setApproval } from "../src/trackers/config.ts";
import { runTrackerWork } from "../src/trackers/async.ts";

export function trackerContext(ctx: ExtensionContext) {
  const config = loadConfig();
  const project = resolveProject(ctx.cwd, { config });
  const raw = getDbPath(process.env, { config });
  const parsed = parseTarget(raw);
  const target = parsed.kind === "local" ? path.resolve(raw) : raw;
  return { project, target, resolution: resolveTracker(project, config) };
}

export function createTrackerUi(active: () => boolean, epoch: () => number) {
  let dialogs: Promise<unknown> = Promise.resolve();
  const seen = new Set<string>();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = dialogs.then(fn, fn);
    // Rejections reach the original caller; the queue tail must remain usable after refusal/failure.
    dialogs = next.then(() => undefined, () => undefined);
    return next;
  }
  async function current(ctx: ExtensionContext, item: Item) {
    const state = trackerContext(ctx);
    if (state.project.key !== item.project) return undefined;
    const store = createAsyncStore(state.target);
    try { return { ...state, item: await store.call("getItem", item) }; }
    finally { store.close(); }
  }
  async function push(ctx: ExtensionContext, item: Item, awaitingOnly = false): Promise<void> {
    const stamp = epoch();
    const valid = () => active() && stamp === epoch() && !ctx.signal?.aborted;
    const identity = canonicalJson(item);
    const fingerprint = sha256(identity);
    if (awaitingOnly && seen.has(fingerprint)) return;
    if (awaitingOnly) seen.add(fingerprint);
    return serialize(async () => {
      if (!ctx.hasUI || !valid()) return;
      let state = await current(ctx, item);
      if (!valid() || !state?.item || canonicalJson(state.item) !== identity || state.resolution.kind !== "ok") return;
      if (awaitingOnly && !state.item.links.some((link) => link.state === "awaiting-approval")) return;
      const config = state.resolution.tracker;
      const fingerprint = canonicalJson(state);
      if (!isApproved(config)) {
        const details = `${state.project.key}\nprovider: ${config.provider}\ndestination: ${config.destination}\nmode: ${config.mode}\ntag: #${config.tag}\nlabels: ${config.labels.join(", ") || "none"}\ncloseOnDone: ${config.closeOnDone}\nThis approves the project config, not this item.`;
        if (!await ctx.ui.confirm("Approve project tracker configuration?", details)) return;
        const fresh = await current(ctx, item);
        if (!valid() || canonicalJson(fresh) !== fingerprint || !config.hash) return;
        updateConfig((raw) => setApproval(raw, state!.project.key, config.hash));
        state = await current(ctx, item);
      }
      if (!valid() || !state?.item || state.resolution.kind !== "ok" || !isApproved(state.resolution.tracker)) return;
      const approved = canonicalJson(state);
      const destination = state.item.links.find((link) => link.provider === "github")?.destination ?? state.resolution.tracker.destination;
      if (!await ctx.ui.confirm(`File #${item.id} as a GitHub issue on ${destination}?`, item.title)) return;
      const fresh = await current(ctx, item);
      if (!valid() || !fresh?.item || canonicalJson(fresh) !== approved || fresh.resolution.kind !== "ok") return;
      const result = await runTrackerWork({ action: "push", target: fresh.target, project: fresh.project.key, config: fresh.resolution.tracker, item: fresh.item }, ctx.cwd);
      if (!valid()) return;
      ctx.ui.notify(result.error || result.warnings || result.url || "tdo: issue filed", result.error ? "warning" : "info");
    });
  }
  async function afterMutation(ctx: ExtensionContext, item: Item): Promise<void> {
    const stamp = epoch();
    try {
      const state = trackerContext(ctx);
      if (!active() || state.project.key !== item.project) return;
      if (state.resolution.kind === "invalid" && ctx.hasUI) ctx.ui.notify(`tdo: invalid tracker config: ${state.resolution.error}`, "warning");
      if (state.resolution.kind !== "ok") return;
      if (item.links.some((link) => link.state === "awaiting-approval")) {
        if (ctx.hasUI) ctx.ui.notify(`#${item.id} awaiting approval: run 'tdo push ${item.id}'.`, "info");
        return;
      }
      if (!isApproved(state.resolution.tracker) || !item.links.length) return;
      const action = item.links.some((link) => link.state === "pending") ? "push" : "drain";
      const result = await runTrackerWork({ action, target: state.target, project: state.project.key, config: state.resolution.tracker, item }, ctx.cwd);
      if (active() && stamp === epoch() && ctx.hasUI && (result.error || result.warnings)) ctx.ui.notify(`tdo: local change saved; ${result.error || result.warnings}`, "warning");
    } catch (error) {
      if (active() && stamp === epoch() && ctx.hasUI) ctx.ui.notify(`tdo: local change saved; ${(error as Error).message}`, "warning");
    }
  }
  return { push, afterMutation, serialize };
}

/** Best effort, intentionally not a shell parser; guarded commands show their complete text. */
export function needsTrackerConsent(command: string): boolean {
  return /\btdo(?:\.ts)?[\s"'][^\n;&|]*\bpush\b|\btdo(?:\.ts)?[\s"'][^\n;&|]*\btracker\b[^\n;&|]*\bapprove\b/.test(command);
}

/** Only simple same-context mutations may trigger a post-result dialog. Reject overrides and scripts. */
export function isLocalMutation(command: string): boolean {
  return /^\s*tdo\s+(add|edit)\s/.test(command) && !/[;&|`\n<>$]/.test(command) && !/(?:--(?:db|project|config)(?:=|\s)|(?:^|\s)-C(?:\s|\S)|\bTDO_)/.test(command);
}

/** Conservative shell token subset: ambiguous quoting/expansion opts out, never guesses a target. */
export function mutationTarget(command: string): { title?: string; id?: number } | undefined {
  if (!isLocalMutation(command) || /[\\]/.test(command)) return undefined;
  const tokens = command.match(/'[^']*'|"[^"]*"|[^\s'"]+/g) ?? [];
  if (tokens.join(" ") !== command.trim().replace(/\s+/g, " ")) return undefined;
  const args = tokens.map((token) => /^["']/.test(token) ? token.slice(1, -1) : token);
  try {
    const { positionals } = parseArgs({ args: args.slice(2), allowPositionals: true, strict: true, options: {
      tags: { type: "string", short: "t", multiple: true }, priority: { type: "string", short: "p" }, body: { type: "string", short: "b" }, file: { type: "string", short: "f" }, source: { type: "string" }, title: { type: "string" }, json: { type: "boolean" }, "no-sync": { type: "boolean" },
    } });
    if (args[1] === "edit") return positionals.length === 1 && /^#?[1-9]\d*$/.test(positionals[0]!) ? { id: Number(positionals[0]!.replace(/^#/, "")) } : undefined;
    const title = parseQuickAdd(positionals.join(" ")).title;
    return title ? { title } : undefined;
  } catch { return undefined; }
}

export function trackerForItem(ctx: ExtensionContext, item: Item) {
  const state = trackerContext(ctx);
  return item.project === state.project.key && state.resolution.kind === "ok" ? state.resolution.tracker : undefined;
}

export function registerTrackerEvents(pi: ExtensionAPI, trackerUi: ReturnType<typeof createTrackerUi>, active: () => boolean, epoch: () => number, refreshStatus: (ctx: ExtensionContext) => Promise<void>) {
  const mutations = new Map<string, { baseline: Map<string, string>; context: string; epoch: number; target: { title?: string; id?: number } }>();
  const keyString = (item: Item) => `${item.projectId}#${item.id}`;
  pi.on("session_shutdown", () => { mutations.clear(); });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
    const command = event.input.command;
    if (needsTrackerConsent(command)) {
      const stamp = epoch();
      try {
        const ok = await trackerUi.serialize(async () => active() && stamp === epoch() && !ctx.signal?.aborted && ctx.hasUI && await ctx.ui.confirm("Allow GitHub tracker command?", command));
        if (!ok || !active() || stamp !== epoch() || ctx.signal?.aborted) return { block: true, reason: "tdo: tracker command not confirmed" };
      } catch { return { block: true, reason: "tdo: tracker confirmation unavailable" }; }
    }
    const target = mutationTarget(command);
    if (ctx.hasUI && target) {
      const stamp = epoch();
      try {
        const state = trackerContext(ctx);
        const items = await callStore("listItems", { project: state.project.key, status: "all", limit: 5000 });
        if (active() && stamp === epoch()) mutations.set(event.toolCallId, { baseline: new Map(items.map((item) => [keyString(item), canonicalJson(item)])), context: canonicalJson(state), epoch: stamp, target });
      } catch (error) { if (active() && stamp === epoch()) ctx.ui.notify(`tdo: cannot verify mutation: ${(error as Error).message}`, "warning"); }
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    const pending = mutations.get(event.toolCallId);
    mutations.delete(event.toolCallId);
    if (!pending || event.isError || !active() || pending.epoch !== epoch() || event.toolName !== "bash" || !isLocalMutation(String(event.input.command))) return;
    const output = event.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (!/awaiting-approval|awaiting approval|↗\?/.test(output)) return;
    try {
      const state = trackerContext(ctx);
      if (canonicalJson(state) !== pending.context) return;
      const items = await callStore("listItems", { project: state.project.key, status: "all", awaiting: true, limit: 5000 });
      for (const item of items) {
        if (!active() || pending.epoch !== epoch()) return;
        const before = pending.baseline.get(keyString(item));
        const matches = pending.target.id !== undefined ? item.id === pending.target.id : !before && item.title === pending.target.title;
        if (matches && before !== canonicalJson(item)) await trackerUi.push(ctx, item, true);
      }
      await refreshStatus(ctx);
    } catch (error) { if (active() && pending.epoch === epoch()) ctx.ui.notify(`tdo: cannot verify filing: ${(error as Error).message}`, "warning"); }
  });

}
