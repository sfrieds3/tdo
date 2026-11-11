/**
 * Pi front-end for tdo: the `/tdo` picker, quick-add, and a footer with the focused item (plus open counts when
 * the user opts in with `"statusline": true`).
 *
 * Agents (Pi, Claude Code, Codex, ...) use the `tdo` CLI through the bundled skill
 * (skills/tdo/SKILL.md), so this extension has no model-facing tool of its own.
 */
import { isApproved, normalizeDestination, statusPolicy } from "../src/trackers/config.ts";
import { parseGithubIssueUrl } from "../src/trackers/github.ts";
import { autoIntent, isHumanCommand } from "../src/trackers/auto.ts";
import { createTrackerUi, registerTrackerEvents, trackerForItem, trackerContext } from "./tracker.ts";
import * as os from "node:os";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, matchesKey, type KeyId, type SelectItem } from "@earendil-works/pi-tui";
import {
  PRIORITIES,
  canonicalJson,
  editorText,
  formatItemDetail,
  formatItemLine,
  formatItemList,
  itemRef,
  issueIdsFor,
  loadConfig,
  parseEditorText,
  parseQuickAdd,
  requirePriority,
  resolveProjectAsync,
  type Item,
  type ItemKey,
  type Project,
} from "../src/core.ts";

import { callStore } from "./store.ts";

const STATUS_KEY = "tdo";
/** Text counterpart of assets/tdo.svg (U+2611); no Nerd Font or image protocol needed. */
const TDO_ICON = "☑";
const FOCUS_ENTRY = "tdo-focus";
const FOCUS_TITLE_CHARS = 40;
const PICKER_LIMIT = 200;
/** Added to the hand-off when config `worktree` is true; the agent picks the names. */
export const WORKTREE_INSTRUCTION = "Do the work in a new git worktree on a new branch (create it with `git worktree add -b <branch> <main-checkout>/.worktrees/<name>`, choosing a short descriptive branch and directory name; never put it next to the repo), not in the current checkout.";
/** tdo ids are local bookkeeping; on GitHub `#3` links to an unrelated issue or PR. */
export const NO_IDS_INSTRUCTION = "Don't put tdo ids (#3, tdo#3, name#3) in commit messages, PR text, or branch names; describe the change instead.";
/** Read saved links only; foreign-project tracker policy cannot be verified from this checkout. */
export function linkedIssueInstruction(ctx: ExtensionContext, item: Item): string {
  const tracker = trackerForItem(ctx, item);
  if (!tracker || tracker.provider !== "github" || !isApproved(tracker)) return "";
  const link = item.links.find((link) => link.provider === "github" && ["open", "closed"].includes(link.state));
  if (!link?.url || !link.externalId || !/^[1-9]\d*$/.test(link.externalId)) return "";
  const parsed = parseGithubIssueUrl(link.url);
  if (!parsed || parsed.id !== link.externalId || normalizeDestination(parsed.destination) !== parsed.destination || parsed.destination.toLowerCase() !== link.destination.toLowerCase()) return "";
  // A saved link keeps its original destination even when the configured filing repository changes.
  return ` If this work results in a PR, include \`Closes https://${parsed.destination}/issues/${parsed.id}\` in its description; this is the linked GitHub issue, not a local tdo id.`;
}

const ALL_ARGS = new Set(["all", "--all", "-a"]);
const HELP = [
  "/tdo — pick an item in this project (--all or all: every project)",
  "  enter work on it · e edit · p priority · x done · d delete · g Push to GitHub (current project tracker) · esc close",
  "/tdo <title> [!urgent|!high|!low] [#tag] — add",
].join("\n");

/** Picker keys, beyond enter (work on it) and esc. */
export const PICKER_KEYS = { g: "push", e: "edit", p: "priority", x: "done", d: "delete" } as const;
type PickerAction = "work" | (typeof PICKER_KEYS)[keyof typeof PICKER_KEYS];
type Picked = { action: PickerAction; item: Item };

export { parseEditorText };

function hostName(): string {
  return os.hostname().split(".")[0] ?? "";
}

function sessionId(ctx: ExtensionContext): string | undefined {
  return (ctx.sessionManager as { getSessionId?: () => string | undefined }).getSessionId?.() || undefined;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function keyString(key: ItemKey): string {
  return `${key.projectId}#${key.id}`;
}

function sameItem(a: ItemKey | undefined, b: ItemKey | undefined): boolean {
  return a === b || (!!a && !!b && a.projectId === b.projectId && a.id === b.id);
}

function intent(ctx: ExtensionContext, itemProject?: string) {
  const state = trackerContext(ctx);
  if (itemProject && itemProject !== state.project.key) return undefined;
  return autoIntent(state.resolution.kind === "ok" ? state.resolution.tracker : undefined, isHumanCommand(ctx.hasUI && ctx.mode !== "rpc", "user"));
}
function closeOnDone(ctx: ExtensionContext, item: Item, status: "done" | "doing"): boolean {
  const current = trackerContext(ctx);
  return statusPolicy(item, current.project.key, status, current.resolution, loadConfig());
}

function displayRef(ctx: ExtensionContext, item: Item): string {
  return itemRef(item, { showProject: item.project !== trackerContext(ctx).project.key });
}

type TrackerUi = ReturnType<typeof createTrackerUi>;
async function editItem(ctx: ExtensionContext, item: Item, valid: () => boolean, trackerUi: TrackerUi): Promise<boolean> {
  const text = await ctx.ui.editor(`Edit ${displayRef(ctx, item)} — first line is the title, the rest is the body`, editorText(item));
  if (text === undefined || !valid()) return true;
  const { title, body } = parseEditorText(text);
  if (!title) {
    ctx.ui.notify("tdo: title must not be empty; nothing changed.", "warning");
    return true;
  }
  const updated = await callStore("updateItem", item, { title, body }, intent(ctx, item.project));
  if (valid()) await trackerUi.afterMutation(ctx, updated);
  return true;
}
async function changePriority(ctx: ExtensionContext, item: Item, valid: () => boolean, trackerUi: TrackerUi): Promise<boolean> {
  const labels = PRIORITIES.map((priority) => (priority === item.priority ? `${priority} (current)` : priority));
  const picked = await ctx.ui.select(`Priority for ${displayRef(ctx, item)}`, labels);
  if (picked && valid()) {
    const updated = await callStore("updateItem", item, { priority: requirePriority(picked.replace(/ \(current\)$/, "")) }, intent(ctx, item.project));
    if (valid()) await trackerUi.afterMutation(ctx, updated);
  }
  return true;
}

async function finishItem(ctx: ExtensionContext, item: Item, valid: () => boolean, trackerUi: TrackerUi): Promise<boolean> {
  const updated = await callStore("setStatus", item, "done", undefined, closeOnDone(ctx, item, "done"));
  if (!valid()) return false;
  await trackerUi.afterMutation(ctx, updated);
  if (!valid()) return false;
  ctx.ui.notify(`tdo: done ${displayRef(ctx, item)} ${item.title}`, "info");
  return true;
}
async function deleteItem(ctx: ExtensionContext, item: Item, valid: () => boolean, refreshStatus: (ctx: ExtensionContext) => Promise<void>): Promise<boolean> {
  if (!await ctx.ui.confirm(`Delete ${displayRef(ctx, item)}?`, item.title) || !valid()) return true;
  await callStore("deleteItem", item);
  if (!valid()) return false;
  // Clears a deleted focus and drops the item from the footer counts.
  await refreshStatus(ctx);
  if (!valid()) return false;
  ctx.ui.notify(`tdo: deleted ${displayRef(ctx, item)} ${item.title}`, "info");
  return true;
}

export default function tdoExtension(pi: ExtensionAPI) {
  const projects = new Map<string, Promise<Project>>();
  /** The item this session is working on, restored from the session branch. */
  let focus: ItemKey | undefined;
  let generation = 0;
  let lifecycle = 0;
  let stopped = false;
  const trackerUi = createTrackerUi(() => !stopped, () => lifecycle);
  registerTrackerEvents(pi, trackerUi, () => !stopped, () => lifecycle, refreshStatus);

  function project(ctx: ExtensionContext): Promise<Project> {
    const cwd = ctx.cwd || ctx.sessionManager.getCwd();
    // Share in-flight I/O, but never retain settled project/tracker configuration across commands.
    let pending = projects.get(cwd);
    if (!pending) {
      pending = resolveProjectAsync(cwd);
      projects.set(cwd, pending);
      const clear = () => { if (projects.get(cwd) === pending) projects.delete(cwd); };
      void pending.then(clear, clear);
    }
    return pending;
  }

  function setFocus(key: ItemKey | undefined): void {
    if (sameItem(focus, key)) return;
    generation++;
    focus = key ? { projectId: key.projectId, id: key.id } : undefined;
    pi.appendEntry(FOCUS_ENTRY, focus ?? null);
  }

  function restoreFocus(ctx: ExtensionContext): void {
    focus = undefined;
    const manager = ctx.sessionManager as { getBranch?: () => unknown[] };
    for (const entry of manager.getBranch?.() ?? []) {
      const custom = entry as { type?: string; customType?: string; data?: Partial<ItemKey> | null };
      if (custom.type !== "custom" || custom.customType !== FOCUS_ENTRY) continue;
      const data = custom.data;
      focus = typeof data?.projectId === "string" && typeof data.id === "number" ? { projectId: data.projectId, id: data.id } : undefined;
    }
  }

  /** Counts are opt-in (`"statusline": true`); without it the footer shows only the item being worked on. */
  function fullStatus(): boolean {
    try {
      return loadConfig().statusline === true;
    } catch {
      return false;
    }
  }

  async function refreshStatus(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || stopped) return;
    const current = ++generation;
    const key = focus;
    const full = fullStatus();
    // Not opted in and not working on anything: never touch the footer or the store.
    if (!full && !key) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    try {
      const projectKey = (await project(ctx)).key;
      const counts = full ? await callStore("countActive", projectKey) : undefined;
      const links = full ? await callStore("countLinks", projectKey) : undefined;
      const focused = key ? await callStore("getItem", key) : undefined;
      if (current !== generation || stopped) return;
      // Only a successful lookup can invalidate the saved focus, never a transport error.
      if (key && focused?.status !== "doing" && focused?.status !== "open") setFocus(undefined);
      const parts: string[] = [];
      if (counts) {
        const urgent = counts.urgent + counts.high;
        if (counts.total) parts.push(ctx.ui.theme.fg("muted", `${TDO_ICON} ${counts.total}${urgent ? ` (${urgent}!)` : ""}`));
      }
      if (links?.["awaiting-approval"]?.length) parts.push(ctx.ui.theme.fg("muted", `${links["awaiting-approval"]!.length} awaiting`));
      if (focus && focused) {
        const ref = itemRef(focused, { showProject: focused.project !== projectKey });
        // Lead with the icon when there are no counts, so the focus still reads as tdo.
        if (!parts.length) parts.push(ctx.ui.theme.fg("muted", TDO_ICON));
        parts.push(ctx.ui.theme.fg("accent", `▸ ${ref} ${truncate(focused.title, FOCUS_TITLE_CHARS)}`));
      }
      ctx.ui.setStatus(STATUS_KEY, parts.length ? parts.join(" ") : undefined);
    } catch {
      if (current === generation && !stopped) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", `${TDO_ICON} unavailable`));
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    projects.clear();
    lifecycle++;
    stopped = false;
    generation++;
    restoreFocus(ctx);
    await refreshStatus(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    projects.clear();
    lifecycle++;
    generation++;
    restoreFocus(ctx);
    await refreshStatus(ctx);
  });
  // Agents change items through the CLI, so refresh after each run.
  pi.on("agent_end", async (_event, ctx) => refreshStatus(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    projects.clear();
    lifecycle++;
    stopped = true;
    generation++;
    if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  async function pick(ctx: ExtensionContext, items: Item[], title: string, showProject: boolean, selected?: ItemKey): Promise<Picked | undefined> {
    const config = loadConfig();
    const entries: SelectItem[] = items.map((item) => ({ value: keyString(item), label: formatItemLine(item, { showProject, issueIds: issueIdsFor(config, item.project) }) }));
    const byKey = new Map(items.map((item) => [keyString(item), item]));
    return ctx.ui.custom<Picked | undefined>((tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title))));
      const list = new SelectList(entries, Math.min(entries.length, 12), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      const start = items.findIndex((item) => sameItem(item, selected));
      if (start > 0) list.setSelectedIndex(start);
      const finish = (action: PickerAction) => {
        const item = byKey.get(list.getSelectedItem()?.value ?? "");
        if (action === "push" && (!item || !canPush(ctx, item))) return;
        if (item) done({ action, item });
      };
      list.onSelect = () => finish("work");
      list.onCancel = () => done(undefined);
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", `↑↓ move · enter work on it · e edit · p priority · x done · d delete${items.some((item) => canPush(ctx, item)) ? " · g Push to GitHub" : ""} · esc close`)));
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      return {
        capturesViewportInput: list.capturesViewportInput,
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput(data: string) {
          const key = (Object.keys(PICKER_KEYS) as (keyof typeof PICKER_KEYS)[]).find((name) => matchesKey(data, name as KeyId));
          if (key) return finish(PICKER_KEYS[key]);
          list.handleInput(data);
          tui.requestRender();
        },
      };
    }, { blocked: { kind: "question", message: title } });
  }

  function canPush(ctx: ExtensionContext, item: Item): boolean {
    return !!trackerForItem(ctx, item);
  }

  async function workOn(ctx: ExtensionContext, item: Item, showProject: boolean): Promise<void> {
    const current = lifecycle;
    const started = await callStore("setStatus", item, "doing", undefined, closeOnDone(ctx, item, "doing"));
    if (stopped || current !== lifecycle) return;
    await trackerUi.afterMutation(ctx, started);
    if (stopped || current !== lifecycle) return;
    setFocus(started);
    await refreshStatus(ctx);
    if (stopped || current !== lifecycle) return;
    const ref = itemRef(started, { showProject });
    const close = showProject ? `tdo done ${started.id} --project ${started.project}` : `tdo done ${started.id}`;
    const worktree = loadConfig().worktree ? ` ${WORKTREE_INSTRUCTION}` : "";
    const message = `Let's work on tdo item ${ref} (marked as doing).${worktree} ${NO_IDS_INSTRUCTION}${linkedIssueInstruction(ctx, started)} When it's fixed, close it with \`${close} -m "<what changed>"\`.\n\n${formatItemDetail(started)}`;
    if (ctx.isIdle()) pi.sendUserMessage(message);
    else pi.sendUserMessage(message, { deliverAs: "followUp" });
  }

  /** Runs a picker action; returns true when the picker should reopen. */
  async function act(ctx: ExtensionContext, { action, item }: Picked, showProject: boolean): Promise<boolean> {
    const stamp = lifecycle;
    const context = canonicalJson(trackerContext(ctx));
    const valid = () => !stopped && stamp === lifecycle && context === canonicalJson(trackerContext(ctx));
    switch (action) {
      case "push":
        if (canPush(ctx, item)) await trackerUi.push(ctx, item);
        return true;
      case "work":
        await workOn(ctx, item, showProject);
        return false;
      case "edit": return editItem(ctx, item, valid, trackerUi);
      case "priority": return changePriority(ctx, item, valid, trackerUi);
      case "done": return finishItem(ctx, item, valid, trackerUi);
      case "delete": return deleteItem(ctx, item, valid, refreshStatus);

    }
  }

  async function browse(ctx: ExtensionContext, allProjects: boolean): Promise<void> {
    const epoch = lifecycle;
    const current = await project(ctx);
    if (stopped || epoch !== lifecycle) return;
    const header = allProjects ? "all projects" : current.key;
    let selected: ItemKey | undefined;
    let warned = false;
    for (;;) {
      const found = await callStore("listItems", { project: allProjects ? undefined : current.key, limit: PICKER_LIMIT + 1 });
      if (stopped || epoch !== lifecycle) return;
      const truncated = found.length > PICKER_LIMIT;
      const items = found.slice(0, PICKER_LIMIT);
      if (truncated && !warned) {
        ctx.ui.notify(`tdo: showing only the first ${PICKER_LIMIT} active items. Use tdo ls${allProjects ? " -a" : ""} -n 0 to show all, or the CLI browser to search everything.`, "warning");
        warned = true;
      }
      // Show project names whenever other projects are in view.
      const showProject = allProjects && items.some((item) => item.project !== current.key);
      if (!items.length) {
        ctx.ui.notify(`tdo: nothing open for ${header}. Add one with /tdo <title> [!high] [#tag].`, "info");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(formatItemList(items, { showProject }), "info");
        return;
      }
      const picked = await pick(ctx, items, `tdo — ${header} (${items.length}${truncated ? "+" : ""})`, showProject, selected);
      if (!picked || stopped || epoch !== lifecycle) return;
      selected = picked.item;
      const again = await act(ctx, picked, showProject);
      if (stopped || epoch !== lifecycle) return;
      await refreshStatus(ctx);
      if (!again) return;
    }
  }

  pi.registerCommand("tdo", {
    description: "Per-project backlog: /tdo to pick an item (--all for every project), /tdo <title> [!high] [#tag] to add",
    // No suggestions for an empty prefix: pi-tui's Enter accepts the highlighted completion before
    // submitting, so offering `--all` there would turn `/tdo ` + Enter into `/tdo --all`.
    getArgumentCompletions: (prefix) => {
      if (!prefix.trim()) return null;
      const matches = ["--all", "help"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const stamp = lifecycle;
      const trimmed = args.trim();
      try {
        if (!trimmed) return await browse(ctx, false);
        if (ALL_ARGS.has(trimmed)) return await browse(ctx, true);
        if (trimmed === "help") return ctx.ui.notify(HELP, "info");
        const quick = parseQuickAdd(trimmed);
        if (!quick.title) return ctx.ui.notify("tdo: add needs a title, e.g. /tdo fix flaky test !high #ci", "warning");
        const session = sessionId(ctx);
        const current = await project(ctx);
        if (stopped || stamp !== lifecycle) return;
        const item = await callStore("addItem", { project: current, title: quick.title, priority: quick.priority, tags: quick.tags, source: "user", sessionId: session, host: hostName(), createdByHuman: isHumanCommand(ctx.hasUI && ctx.mode !== "rpc", "user") }, intent(ctx));
        if (stopped || stamp !== lifecycle) return;
        await trackerUi.afterMutation(ctx, item);
        if (stopped || stamp !== lifecycle) return;
        await refreshStatus(ctx);
        if (stopped || stamp !== lifecycle) return;
        ctx.ui.notify(`tdo: added ${formatItemLine(item)}`, "info");
      } catch (error) {
        if (stopped || stamp !== lifecycle) return;
        ctx.ui.notify(`tdo: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
