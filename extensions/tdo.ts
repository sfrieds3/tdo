/**
 * Pi front-end for tdo: the `/tdo` picker, quick-add, and a footer with the open count and focused item.
 *
 * Agents (Pi, Claude Code, Codex, ...) use the `tdo` CLI through the bundled skill
 * (skills/tdo/SKILL.md), so this extension has no model-facing tool of its own.
 */
import * as os from "node:os";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, matchesKey, type KeyId, type SelectItem } from "@earendil-works/pi-tui";
import {
  PRIORITIES,
  formatItemDetail,
  formatItemLine,
  formatItemList,
  getDbPath,
  itemRef,
  loadConfig,
  openDb,
  parseQuickAdd,
  requirePriority,
  resolveProject,
  type Item,
  type ItemKey,
  type Project,
} from "../src/core.ts";

import { createAsyncStore, type Operation, type StoreOperations } from "../src/store.ts";

const STATUS_KEY = "tdo";
const FOCUS_ENTRY = "tdo-focus";
const FOCUS_TITLE_CHARS = 40;
const ALL_ARGS = new Set(["all", "--all", "-a"]);
const HELP = [
  "/tdo — pick an item in this project (--all or all: every project)",
  "  enter work on it · e edit · p priority · x done · d delete · esc close",
  "/tdo <title> [!urgent|!high|!low] [#tag] — add",
].join("\n");

/** Picker keys, beyond enter (work on it) and esc. */
export const PICKER_KEYS = { e: "edit", p: "priority", x: "done", d: "delete" } as const;
type PickerAction = "work" | (typeof PICKER_KEYS)[keyof typeof PICKER_KEYS];
type Picked = { action: PickerAction; item: Item };

type DbHandle = ReturnType<typeof openDb>;

/** Legacy local-only helper for existing consumers; extension operations use callStore. */
export function withDb<T>(fn: (db: DbHandle) => T, env: NodeJS.ProcessEnv = process.env): T {
  const db = openDb(getDbPath(env));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** One short-lived store per operation; SSH calls never block Pi's event loop. */
async function callStore<K extends Operation>(operation: K, ...args: StoreOperations[K]["args"]): Promise<StoreOperations[K]["result"]> {
  const store = createAsyncStore();
  try {
    return await store.call(operation, ...args);
  } finally {
    store.close();
  }
}

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

/** Splits editor text into a title (first line) and body (the rest). */
export function parseEditorText(text: string): { title: string; body: string | null } {
  const [first = "", ...rest] = text.replace(/\r\n/g, "\n").split("\n");
  return { title: first.trim(), body: rest.join("\n").trim() || null };
}

export default function tdoExtension(pi: ExtensionAPI) {
  const projects = new Map<string, Project>();
  /** The item this session is working on, restored from the session branch. */
  let focus: ItemKey | undefined;
  let generation = 0;
  let lifecycle = 0;
  let stopped = false;

  function project(ctx: ExtensionContext): Project {
    const cwd = ctx.cwd || ctx.sessionManager.getCwd();
    let resolved = projects.get(cwd);
    if (!resolved) {
      resolved = resolveProject(cwd, { config: loadConfig() });
      projects.set(cwd, resolved);
    }
    return resolved;
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

  async function refreshStatus(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || stopped) return;
    const current = ++generation;
    const key = focus;
    try {
      const projectKey = project(ctx).key;
      const counts = await callStore("countActive", projectKey);
      const focused = key ? await callStore("getItem", key) : undefined;
      if (current !== generation || stopped) return;
      // Only a successful lookup can invalidate the saved focus, never a transport error.
      if (key && focused?.status !== "doing" && focused?.status !== "open") setFocus(undefined);
      const parts: string[] = [];
      const urgent = counts.urgent + counts.high;
      if (counts.total) parts.push(ctx.ui.theme.fg("muted", `tdo ${counts.total}${urgent ? ` (${urgent}!)` : ""}`));
      if (focus && focused) {
        const ref = itemRef(focused, { showProject: focused.project !== projectKey });
        parts.push(ctx.ui.theme.fg("accent", `▸ ${ref} ${truncate(focused.title, FOCUS_TITLE_CHARS)}`));
      }
      ctx.ui.setStatus(STATUS_KEY, parts.length ? parts.join(" ") : undefined);
    } catch {
      if (current === generation && !stopped) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", "tdo unavailable"));
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    lifecycle++;
    stopped = false;
    generation++;
    projects.clear();
    restoreFocus(ctx);
    await refreshStatus(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    lifecycle++;
    generation++;
    restoreFocus(ctx);
    await refreshStatus(ctx);
  });
  // Agents change items through the CLI, so refresh after each run.
  pi.on("agent_end", async (_event, ctx) => refreshStatus(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    lifecycle++;
    stopped = true;
    generation++;
    if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  async function pick(ctx: ExtensionContext, items: Item[], title: string, showProject: boolean, selected?: ItemKey): Promise<Picked | undefined> {
    const entries: SelectItem[] = items.map((item) => ({ value: keyString(item), label: formatItemLine(item, { showProject }) }));
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
        if (item) done({ action, item });
      };
      list.onSelect = () => finish("work");
      list.onCancel = () => done(undefined);
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", "↑↓ move · enter work on it · e edit · p priority · x done · d delete · esc close")));
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

  async function workOn(ctx: ExtensionContext, item: Item, showProject: boolean): Promise<void> {
    const current = lifecycle;
    const started = await callStore("setStatus", item, "doing");
    if (stopped || current !== lifecycle) return;
    setFocus(started);
    await refreshStatus(ctx);
    if (stopped || current !== lifecycle) return;
    const ref = itemRef(started, { showProject });
    const close = showProject ? `tdo done ${started.id} --project ${started.project}` : `tdo done ${started.id}`;
    const message = `Let's work on tdo item ${ref} (marked as doing). When it's fixed, close it with \`${close} -m "<what changed>"\`.\n\n${formatItemDetail(started)}`;
    if (ctx.isIdle()) pi.sendUserMessage(message);
    else pi.sendUserMessage(message, { deliverAs: "followUp" });
  }

  /** Runs a picker action; returns true when the picker should reopen. */
  async function act(ctx: ExtensionContext, { action, item }: Picked, showProject: boolean): Promise<boolean> {
    const ref = itemRef(item, { showProject });
    switch (action) {
      case "work":
        await workOn(ctx, item, showProject);
        return false;
      case "edit": {
        const text = await ctx.ui.editor(`Edit ${ref} — first line is the title, the rest is the body`, [item.title, item.body ? `\n${item.body}` : ""].join("\n").trimEnd());
        if (text === undefined) return true;
        const { title, body } = parseEditorText(text);
        if (!title) {
          ctx.ui.notify("tdo: title must not be empty; nothing changed.", "warning");
          return true;
        }
        await callStore("updateItem", item, { title, body });
        return true;
      }
      case "priority": {
        const labels = PRIORITIES.map((priority) => (priority === item.priority ? `${priority} (current)` : priority));
        const picked = await ctx.ui.select(`Priority for ${ref}`, labels);
        if (picked) await callStore("updateItem", item, { priority: requirePriority(picked.replace(/ \(current\)$/, "")) });
        return true;
      }
      case "done":
        await callStore("setStatus", item, "done");
        await refreshStatus(ctx);
        ctx.ui.notify(`tdo: done ${ref} ${item.title}`, "info");
        return true;
      case "delete":
        if (await ctx.ui.confirm(`Delete ${ref}?`, item.title)) {
          await callStore("deleteItem", item);
          await refreshStatus(ctx);
          ctx.ui.notify(`tdo: deleted ${ref} ${item.title}`, "info");
        }
        return true;
    }
  }

  async function browse(ctx: ExtensionContext, allProjects: boolean): Promise<void> {
    const epoch = lifecycle;
    const current = project(ctx);
    const header = allProjects ? "all projects" : current.key;
    let selected: ItemKey | undefined;
    for (;;) {
      const items = await callStore("listItems", { project: allProjects ? undefined : current.key, limit: 200 });
      if (stopped || epoch !== lifecycle) return;
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
      const picked = await pick(ctx, items, `tdo — ${header} (${items.length})`, showProject, selected);
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
    getArgumentCompletions: (prefix) => ["--all", "help"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      try {
        if (!trimmed) return await browse(ctx, false);
        if (ALL_ARGS.has(trimmed)) return await browse(ctx, true);
        if (trimmed === "help") return ctx.ui.notify(HELP, "info");
        const quick = parseQuickAdd(trimmed);
        if (!quick.title) return ctx.ui.notify("tdo: add needs a title, e.g. /tdo fix flaky test !high #ci", "warning");
        const item = await callStore("addItem", { project: project(ctx), title: quick.title, priority: quick.priority, tags: quick.tags, source: "user", sessionId: sessionId(ctx), host: hostName() });
        await refreshStatus(ctx);
        ctx.ui.notify(`tdo: added ${formatItemLine(item)}`, "info");
      } catch (error) {
        ctx.ui.notify(`tdo: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
