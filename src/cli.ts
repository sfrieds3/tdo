#!/usr/bin/env node
/**
 * tdo — per-project "fix later" backlog. See README.md.
 */
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
  PRIORITIES,
  STATUS_FILTERS,
  addItem,
  countActive,
  deleteItem,
  formatCounts,
  formatItemDetail,
  formatItemLine,
  formatItemList,
  formatMarkdown,
  getDbPath,
  getItem,
  listItems,
  listProjects,
  listTags,
  openDb,
  parseQuickAdd,
  parseStatusFilter,
  projectFromKey,
  requirePriority,
  resolveProject,
  setStatus,
  updateItem,
  type Project,
  type Status,
} from "./core.ts";

const USAGE = `tdo — per-project backlog for things to fix later

usage:
  tdo add <title...> [-p PRIO] [-t TAGS] [-b BODY] [-f PATH[:LINE]]   (inline !high and #tag work too)
  tdo ls [-a] [-s STATUS] [-t TAGS] [-p PRIO] [-q TEXT] [-n N]
  tdo show <id>
  tdo edit <id> [--title T] [-p PRIO] [-t +tag,-tag] [-b BODY] [-f REF]
  tdo start|done|drop|reopen <id>... [-m NOTE]
  tdo rm <id>
  tdo count                 open-item summary for the current project
  tdo tags [-a]             tag counts for active items
  tdo projects              all projects with active counts
  tdo project               show the resolved project key
  tdo export [-a] [--md]    dump items as JSON (default) or Markdown

options:
  --project KEY   use this project instead of resolving from the cwd
  -C DIR          resolve the project from DIR
  --json          machine-readable output (all commands)
  -a, --all       across all projects

priorities: ${PRIORITIES.join(", ")} (prefixes and 0-3 accepted)
statuses:   ${STATUS_FILTERS.join(", ")} (ls default: active = open + doing)
env:        TDO_DB (default ~/.pi/state/tdo.db), TDO_PROJECT`;

const OPTIONS = {
  project: { type: "string" },
  C: { type: "string", short: "C" },
  json: { type: "boolean" },
  all: { type: "boolean", short: "a" },
  priority: { type: "string", short: "p" },
  tags: { type: "string", short: "t", multiple: true },
  body: { type: "string", short: "b" },
  file: { type: "string", short: "f" },
  status: { type: "string", short: "s" },
  query: { type: "string", short: "q" },
  limit: { type: "string", short: "n" },
  title: { type: "string" },
  message: { type: "string", short: "m" },
  md: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

const STATUS_COMMANDS: Record<string, Status> = { start: "doing", done: "done", drop: "dropped", reopen: "open" };

class UsageError extends Error {}

function parseId(value: string | undefined): number {
  const id = Number(String(value ?? "").replace(/^#/, ""));
  if (!Number.isInteger(id) || id <= 0) throw new UsageError(`expected an item id, got ${JSON.stringify(value ?? "")}.`);
  return id;
}

/** Splits `-t +a,-b,c` style edits into tags to add and remove. */
function tagEdits(values: string[] | undefined): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const part of (values ?? []).flatMap((value) => value.split(","))) {
    const text = part.trim();
    if (text.startsWith("-")) remove.push(text.slice(1));
    else if (text) add.push(text.replace(/^\+/, ""));
  }
  return { add, remove };
}

export function run(argv: string[], io: { out: (text: string) => void; cwd: string; env: NodeJS.ProcessEnv }): number {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [command = "ls", ...args] = positionals;
  if (values.help || command === "help") {
    io.out(USAGE);
    return 0;
  }
  const json = !!values.json;
  const emit = (data: unknown, text: string) => io.out(json ? JSON.stringify(data, null, 2) : text);
  const cwd = values.C ? path.resolve(io.cwd, values.C) : io.cwd;
  const project = (): Project => (values.project ? projectFromKey(values.project) : resolveProject(cwd, { env: io.env }));

  if (command === "project") {
    const resolved = project();
    emit(resolved, resolved.key);
    return 0;
  }

  const db = openDb(getDbPath(io.env));
  try {
    switch (command) {
      case "add": {
        const quick = parseQuickAdd(args.join(" "));
        if (!quick.title) throw new UsageError("tdo add needs a title.");
        const item = addItem(db, {
          project: project(),
          title: quick.title,
          priority: values.priority ? requirePriority(values.priority) : quick.priority,
          tags: [...quick.tags, ...(values.tags ?? [])],
          body: values.body,
          fileRef: values.file,
          source: io.env.TDO_SOURCE || "cli",
          sessionId: io.env.TDO_SESSION_ID,
          host: os.hostname().split(".")[0],
        });
        emit(item, `added ${formatItemLine(item)}`);
        return 0;
      }
      case "ls":
      case "list": {
        if (args.length) throw new UsageError(`unexpected argument: ${args[0]}`);
        const all = !!values.all;
        const items = listItems(db, {
          project: all ? undefined : project().key,
          status: parseStatusFilter(values.status),
          tags: values.tags,
          minPriority: values.priority ? requirePriority(values.priority) : undefined,
          query: values.query,
          limit: values.limit ? Number(values.limit) : undefined,
        });
        emit(items, formatItemList(items, { showProject: all }));
        return 0;
      }
      case "show": {
        const item = getItem(db, parseId(args[0]));
        if (!item) throw new Error(`No tdo item #${parseId(args[0])}.`);
        emit(item, formatItemDetail(item));
        return 0;
      }
      case "edit": {
        const id = parseId(args[0]);
        const tags = tagEdits(values.tags);
        const item = updateItem(db, id, {
          title: values.title,
          priority: values.priority ? requirePriority(values.priority) : undefined,
          body: values.body,
          fileRef: values.file,
          addTags: tags.add,
          removeTags: tags.remove,
        });
        emit(item, `updated ${formatItemLine(item)}`);
        return 0;
      }
      case "start":
      case "done":
      case "drop":
      case "reopen": {
        if (!args.length) throw new UsageError(`tdo ${command} needs an item id.`);
        const items = args.map((arg) => setStatus(db, parseId(arg), STATUS_COMMANDS[command], values.message));
        emit(items.length === 1 ? items[0] : items, items.map((item) => `${item.status} ${formatItemLine(item)}`).join("\n"));
        return 0;
      }
      case "rm": {
        const item = deleteItem(db, parseId(args[0]));
        emit(item, `deleted #${item.id} ${item.title}`);
        return 0;
      }
      case "count": {
        const resolved = project();
        const counts = countActive(db, resolved.key);
        emit({ project: resolved.key, ...counts }, `${resolved.key}: ${formatCounts(counts)}`);
        return 0;
      }
      case "tags": {
        const tags = listTags(db, values.all ? undefined : project().key);
        emit(tags, tags.length ? tags.map((row) => `${String(row.count).padStart(4)}  #${row.tag}`).join("\n") : "(no tags)");
        return 0;
      }
      case "projects": {
        const projects = listProjects(db);
        emit(projects, projects.length ? projects.map((row) => `${String(row.active).padStart(4)}  ${row.key}`).join("\n") : "(no projects)");
        return 0;
      }
      case "export": {
        const items = listItems(db, { project: values.all ? undefined : project().key, status: parseStatusFilter(values.status ?? "all"), limit: 5000 });
        io.out(values.md && !json ? formatMarkdown(items).trimEnd() : JSON.stringify(items, null, 2));
        return 0;
      }
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } finally {
    db.close();
  }
}

function main(): void {
  try {
    process.exitCode = run(process.argv.slice(2), { out: (text) => console.log(text), cwd: process.cwd(), env: process.env });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`tdo: ${message}`);
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) console.error("run `tdo help` for usage.");
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

if (import.meta.main) main();
