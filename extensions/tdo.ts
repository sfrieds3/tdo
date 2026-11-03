/**
 * Pi front-end for tdo: the `/tdo` command and a footer count.
 *
 * Agents (Pi, Claude Code, Codex, ...) use the `tdo` CLI through the bundled skill
 * (skills/tdo/SKILL.md), so this extension has no model-facing tool of its own.
 */
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  PRIORITIES,
  addItem,
  countActive,
  formatItemDetail,
  formatItemLine,
  formatItemList,
  getDbPath,
  getItem,
  listItems,
  loadConfig,
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
const STATUS_VERBS: Record<string, Status> = { start: "doing", done: "done", drop: "dropped", reopen: "open" };
const SUBCOMMANDS = ["all", "show", ...Object.keys(STATUS_VERBS), "help"];
const HELP = [
  "/tdo — browse open items",
  "/tdo all — browse every project",
  "/tdo <title> [!urgent|!high|!low] [#tag] — add",
  "/tdo done|start|drop|reopen <id> [note] — change status",
  "/tdo show <id> — details",
].join("\n");

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

export default function tdoExtension(pi: ExtensionAPI) {
  const projects = new Map<string, Project>();

  function project(ctx: ExtensionContext): Project {
    const cwd = ctx.cwd || ctx.sessionManager.getCwd();
    let resolved = projects.get(cwd);
    if (!resolved) {
      resolved = resolveProject(cwd, { config: loadConfig() });
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
  // Agents change items through the CLI, so refresh the count after each run.
  pi.on("agent_end", async (_event, ctx) => refreshStatus(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
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
    if (item) await itemMenu(ctx, item);
  }

  async function itemMenu(ctx: ExtensionContext, item: Item): Promise<void> {
    const choices: Record<string, () => Promise<void> | void> = {
      "Work on it now": () => {
        withDb((db) => setStatus(db, item.id, "doing"));
        const message = `Let's work on tdo item #${item.id} (marked as doing). When it's fixed, close it with \`tdo done ${item.id} -m "<what changed>"\`.\n\n${formatItemDetail(item)}`;
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

  function changeById(ctx: ExtensionContext, verb: string, id: number, note: string | undefined): void {
    if (verb === "show") {
      const item = withDb((db) => getItem(db, id));
      if (!item) throw new Error(`No tdo item #${id}.`);
      ctx.ui.notify(formatItemDetail(item), "info");
      return;
    }
    const item = withDb((db) => setStatus(db, id, STATUS_VERBS[verb]!, note));
    ctx.ui.notify(`${item.status}: ${formatItemLine(item)}`, "info");
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
        if (trimmed === "help") return ctx.ui.notify(HELP, "info");
        const [verb = "", idText, ...rest] = trimmed.split(/\s+/);
        const id = Number(idText?.replace(/^#/, ""));
        if ((verb === "show" || verb in STATUS_VERBS) && Number.isInteger(id) && id > 0) {
          return changeById(ctx, verb, id, rest.join(" ") || undefined);
        }
        const quick = parseQuickAdd(trimmed);
        if (!quick.title) return ctx.ui.notify("tdo: add needs a title, e.g. /tdo fix flaky test !high #ci", "warning");
        const item = withDb((db) => addItem(db, { project: project(ctx), title: quick.title, priority: quick.priority, tags: quick.tags, source: "user", sessionId: sessionId(ctx), host: hostName() }));
        ctx.ui.notify(`tdo: added ${formatItemLine(item)}`, "info");
        refreshStatus(ctx);
      } catch (error) {
        ctx.ui.notify(`tdo: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
