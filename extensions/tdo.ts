import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  PRIORITIES,
  STATUS_FILTERS,
  addItem,
  countActive,
  formatCounts,
  formatItemDetail,
  formatItemLine,
  formatItemList,
  getDbPath,
  getItem,
  listItems,
  openDb,
  parseQuickAdd,
  requirePriority,
  resolveProject,
  setStatus,
  updateItem,
  type Item,
  type Project,
  type Status,
} from "../src/core.ts";

const STATUS_KEY = "tdo";
const ACTIONS = ["add", "list", "show", "update", "start", "done", "drop", "reopen"] as const;
type Action = (typeof ACTIONS)[number];
const STATUS_ACTIONS: Partial<Record<Action, Status>> = { start: "doing", done: "done", drop: "dropped", reopen: "open" };
const SUBCOMMANDS = ["all", "done", "start", "drop", "reopen", "show", "help"];

type ToolParams = {
  action: Action;
  id?: number;
  title?: string;
  body?: string;
  priority?: string;
  tags?: string[];
  removeTags?: string[];
  file?: string;
  status?: string;
  query?: string;
  allProjects?: boolean;
  note?: string;
};

type DbHandle = ReturnType<typeof openDb>;

export function withDb<T>(fn: (db: DbHandle) => T, env: NodeJS.ProcessEnv = process.env): T {
  const db = openDb(getDbPath(env));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function hostName(): string {
  return os.hostname().split(".")[0] ?? "";
}

function sessionId(ctx: ExtensionContext): string | undefined {
  return (ctx.sessionManager as { getSessionId?: () => string | undefined }).getSessionId?.() || undefined;
}

/** Runs a tdo tool action against an open database. Exported for tests. */
export function runToolAction(db: DbHandle, project: Project, params: ToolParams, meta: { sessionId?: string; host?: string } = {}): { text: string; details: unknown } {
  const needId = () => {
    if (!Number.isInteger(params.id) || (params.id ?? 0) <= 0) throw new Error(`${params.action} requires an item id.`);
    return params.id!;
  };
  switch (params.action) {
    case "add": {
      const item = addItem(db, {
        project,
        title: params.title ?? "",
        body: params.body,
        priority: params.priority ? requirePriority(params.priority) : undefined,
        tags: params.tags,
        fileRef: params.file,
        source: "agent",
        sessionId: meta.sessionId,
        host: meta.host,
      });
      return { text: `Added ${formatItemLine(item)}`, details: { item } };
    }
    case "list": {
      const items = listItems(db, {
        project: params.allProjects ? undefined : project.key,
        status: params.status as never,
        tags: params.tags,
        minPriority: params.priority ? requirePriority(params.priority) : undefined,
        query: params.query,
        limit: 100,
      });
      const scope = params.allProjects ? "all projects" : project.key;
      return { text: `tdo items (${scope}, ${params.status || "active"}):\n${formatItemList(items, { showProject: !!params.allProjects, empty: "No matching tdo items." })}`, details: { project: project.key, items } };
    }
    case "show": {
      const item = getItem(db, needId());
      if (!item) throw new Error(`No tdo item #${params.id}.`);
      return { text: formatItemDetail(item), details: { item } };
    }
    case "update": {
      const item = updateItem(db, needId(), {
        title: params.title,
        body: params.body,
        priority: params.priority ? requirePriority(params.priority) : undefined,
        addTags: params.tags,
        removeTags: params.removeTags,
        fileRef: params.file,
      });
      return { text: `Updated ${formatItemLine(item)}`, details: { item } };
    }
    default: {
      const status = STATUS_ACTIONS[params.action];
      if (!status) throw new Error(`action must be one of: ${ACTIONS.join(", ")}.`);
      const item = setStatus(db, needId(), status, params.note);
      return { text: `${item.status}: ${formatItemLine(item)}`, details: { item } };
    }
  }
}

export default function tdoExtension(pi: ExtensionAPI) {
  const projects = new Map<string, Project>();

  function project(ctx: ExtensionContext): Project {
    const cwd = ctx.cwd || ctx.sessionManager.getCwd();
    let resolved = projects.get(cwd);
    if (!resolved) {
      resolved = resolveProject(cwd);
      projects.set(cwd, resolved);
    }
    return resolved;
  }

  function refreshStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      const counts = withDb((db) => countActive(db, project(ctx).key));
      const urgent = counts.urgent + counts.high;
      ctx.ui.setStatus(STATUS_KEY, counts.total ? ctx.ui.theme.fg("muted", `tdo ${counts.total}${urgent ? ` (${urgent}!)` : ""}`) : undefined);
    } catch {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    projects.clear();
    refreshStatus(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerTool({
    name: "tdo",
    label: "tdo",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: `Per-project persistent backlog of things to fix later (shared with the \`tdo\` CLI). The project is resolved from the cwd's git remote. Priorities: ${PRIORITIES.join(", ")}. List status filters: ${STATUS_FILTERS.join(", ")} (default active = open + doing).`,
    promptSnippet: "Park out-of-scope issues in a persistent per-project backlog (tdo) and look up previously parked items.",
    promptGuidelines: [
      "When you notice a real issue outside the current task's scope, do not fix it inline; ask the user (with the question tool when available) whether to add it to tdo, with a proposed title and priority. Add only after they agree. If the user directly asks to park or log something, add it without asking again.",
      "Write tdo items so they make sense in a future session: a specific title, a body with the why and how to reproduce, and a repo-relative file:line in `file` when there is one.",
      "Call tdo list when the user asks what's pending or when starting work where previously parked items might apply. Mark items done with a short note when you fix them.",
    ],
    parameters: Type.Object({
      action: Type.Union(ACTIONS.map((action) => Type.Literal(action))),
      id: Type.Optional(Type.Number({ description: "Item id for show/update/start/done/drop/reopen." })),
      title: Type.Optional(Type.String({ description: "Short, specific title (add, update)." })),
      body: Type.Optional(Type.String({ description: "Context: why it matters, repro, ideas (add, update)." })),
      priority: Type.Optional(Type.String({ enum: [...PRIORITIES], description: "add/update: item priority (default normal). list: this priority or more urgent." })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "add: tags. update: tags to add. list: require all of these tags." })),
      removeTags: Type.Optional(Type.Array(Type.String(), { description: "update: tags to remove." })),
      file: Type.Optional(Type.String({ description: "Repo-relative path[:line] the item refers to." })),
      status: Type.Optional(Type.String({ enum: [...STATUS_FILTERS], description: "list: status filter." })),
      query: Type.Optional(Type.String({ description: "list: full-text search over title and body." })),
      allProjects: Type.Optional(Type.Boolean({ description: "list: include every project." })),
      note: Type.Optional(Type.String({ description: "start/done/drop/reopen: note appended to the body." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = withDb((db) => runToolAction(db, project(ctx), params as ToolParams, { sessionId: sessionId(ctx), host: hostName() }));
      if (params.action !== "list" && params.action !== "show") refreshStatus(ctx);
      return { content: [{ type: "text" as const, text: result.text }], details: result.details };
    },
    renderCall(args, theme) {
      const label = [args.action, args.id ? `#${args.id}` : "", args.title ?? args.query ?? ""].filter(Boolean).join(" ");
      return new Text(theme.fg("toolTitle", theme.bold("tdo ")) + theme.fg("muted", label), 0, 0);
    },
    renderResult(result, options, theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      return new Text(theme.fg("dim", options.expanded ? text : (text.split("\n")[0] ?? "")), 0, 0);
    },
  });

  async function browse(ctx: ExtensionContext, allProjects: boolean): Promise<void> {
    const current = project(ctx);
    const items = withDb((db) => listItems(db, { project: allProjects ? undefined : current.key, limit: 200 }));
    const header = allProjects ? "all projects" : current.key;
    if (!items.length) {
      ctx.ui.notify(`tdo: nothing open for ${header}. Add one with /tdo <title> [!high] [#tag].`, "info");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(formatItemList(items, { showProject: allProjects }), "info");
      return;
    }
    const labels = items.map((item) => formatItemLine(item, { showProject: allProjects }));
    const picked = await ctx.ui.select(`tdo — ${header} (${items.length})`, labels);
    const item = picked ? items[labels.indexOf(picked)] : undefined;
    if (!item) return;
    await itemMenu(ctx, item);
  }

  async function itemMenu(ctx: ExtensionContext, item: Item): Promise<void> {
    const choices: Record<string, () => Promise<void> | void> = {
      "Work on it now": () => {
        const detail = formatItemDetail(item);
        withDb((db) => setStatus(db, item.id, "doing"));
        const message = `Let's work on tdo item #${item.id} (marked as doing). Mark it done with the tdo tool when finished.\n\n${detail}`;
        if (ctx.isIdle()) pi.sendUserMessage(message);
        else pi.sendUserMessage(message, { deliverAs: "followUp" });
      },
      "Mark done": () => { withDb((db) => setStatus(db, item.id, "done")); },
      "Mark doing": () => { withDb((db) => setStatus(db, item.id, "doing")); },
      "Change priority": async () => {
        const priority = await ctx.ui.select(`Priority for #${item.id}`, [...PRIORITIES]);
        if (priority) withDb((db) => updateItem(db, item.id, { priority: requirePriority(priority) }));
      },
      "Show details": () => ctx.ui.notify(formatItemDetail(item), "info"),
      Drop: () => { withDb((db) => setStatus(db, item.id, "dropped")); },
    };
    const choice = await ctx.ui.select(`#${item.id} ${item.title}`, Object.keys(choices));
    if (!choice) return;
    await choices[choice]!();
    refreshStatus(ctx);
  }

  pi.registerCommand("tdo", {
    description: "Per-project backlog: /tdo to browse, /tdo <title> [!high] [#tag] to add, /tdo done|start|drop|reopen|show <id>, /tdo all",
    getArgumentCompletions: (prefix) => SUBCOMMANDS.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      try {
        if (!trimmed) return await browse(ctx, false);
        if (trimmed === "all") return await browse(ctx, true);
        if (trimmed === "help") {
          ctx.ui.notify("/tdo — browse open items\n/tdo all — browse every project\n/tdo <title> [!urgent|!high|!low] [#tag] — add\n/tdo done|start|drop|reopen <id> — change status\n/tdo show <id> — details", "info");
          return;
        }
        const [verb, idText, ...rest] = trimmed.split(/\s+/);
        const id = Number(idText?.replace(/^#/, ""));
        if (verb && (verb === "show" || verb in { done: 1, start: 1, drop: 1, reopen: 1 }) && Number.isInteger(id) && id > 0) {
          const result = withDb((db) => runToolAction(db, project(ctx), { action: verb as Action, id, note: rest.join(" ") || undefined }));
          ctx.ui.notify(result.text, "info");
          refreshStatus(ctx);
          return;
        }
        const quick = parseQuickAdd(trimmed);
        if (!quick.title) {
          ctx.ui.notify("tdo: add needs a title, e.g. /tdo fix flaky test !high #ci", "warning");
          return;
        }
        const item = withDb((db) => addItem(db, { project: project(ctx), title: quick.title, priority: quick.priority, tags: quick.tags, source: "user", sessionId: sessionId(ctx), host: hostName() }));
        ctx.ui.notify(`tdo: added ${formatItemLine(item)}`, "info");
        refreshStatus(ctx);
      } catch (error) {
        ctx.ui.notify(`tdo: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
