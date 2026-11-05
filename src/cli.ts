#!/usr/bin/env node
/**
 * tdo — per-project "fix later" backlog. See README.md.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { createStore, parseTarget, saveDbTarget, serveRpc } from "./store.ts";
import {
  PRIORITIES,
  STATUS_FILTERS,
  formatCounts,
  formatItemDetail,
  formatItemLine,
  formatItemList,
  formatMarkdown,
  getConfigPath,
  getDbPath,
  loadConfig,
  type IdChange,
  parseQuickAdd,
  parseStatusFilter,
  projectFromKey,
  requirePriority,
  resolveProject,
  type Project,
  type Status,
} from "./core.ts";

const USAGE = `tdo — per-project backlog for things to fix later

usage:
  tdo add <title...> [-p PRIO] [-t TAGS] [-b BODY] [-f PATH[:LINE]] [--source NAME]
                            (inline !high and #tag work too)
  tdo ls [-a] [-s STATUS] [-t TAGS] [-p PRIO] [-q TEXT] [-n N]
  tdo show <id>              ids are per project: 3 or #3 here, NAME#3 or KEY#3 elsewhere
  tdo edit <id> [--title T] [-p PRIO] [-t +tag,-tag] [-b BODY] [-f REF]
  tdo start|done|drop|reopen <id>... [-m NOTE]
  tdo rm <id>
  tdo count                 open-item summary for the current project
  tdo tags [-a]             tag counts for active items
  tdo projects              all projects with active counts
  tdo project               show the resolved project key
  tdo paths                 show the database and config file locations
  tdo db use <target>        validate and save a local path or ssh:// URI
  tdo db check               check connection and schema
  tdo migrate [--dry-run]   upgrade an older database (backs it up first) and print id changes
  tdo export [-a] [--md]    dump items as JSON (default) or Markdown

options:
  --db TARGET     one-off database override (then TDO_DB, config db, default)
  --project KEY   use this project instead of resolving from the cwd
  -C DIR          resolve the project from DIR
  --json          machine-readable output (all commands)
  -a, --all       across all projects

priorities: ${PRIORITIES.join(", ")} (prefixes and 0-3 accepted)
statuses:   ${STATUS_FILTERS.join(", ")} (ls default: active = open + doing)
files:      database $XDG_DATA_HOME/tdo/tdo.db (default ~/.local/share/tdo/tdo.db)
            config   $XDG_CONFIG_HOME/tdo/config.json (optional; keys: db, aliases)
env:        TDO_DB, TDO_CONFIG, TDO_PROJECT, TDO_SOURCE (who is adding: cli, claude, codex, ...)`;

const OPTIONS = {
  db: { type: "string" },
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
  "dry-run": { type: "boolean" },
  source: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

const STATUS_COMMANDS: Record<string, Status> = { start: "doing", done: "done", drop: "dropped", reopen: "open" };

class UsageError extends Error {}

function requireRef(value: string | undefined): string {
  if (!/^(?:.+#|#)?\d+$/.test(value?.trim() ?? "") || /^(?:.*#|#)?0+$/.test(value!.trim())) throw new UsageError(`expected an item id, got ${JSON.stringify(value ?? "")}.`);
  return value!.trim();
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

type CliIO = { out: (text: string) => void; cwd: string; env: NodeJS.ProcessEnv };

/** Saved local paths must keep pointing at the checked file from any checkout. */
function savedTarget(value: string, cwd: string): string {
  const target = value.trim();
  if (parseTarget(target).kind === "ssh" || target === ":memory:") return target;
  const expanded = target === "~" ? os.homedir() : target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target;
  return path.resolve(cwd, expanded);
}

function dbCommand(args: string[], dbPath: string, io: CliIO, json: boolean): number {
  const emit = (data: unknown, text: string) => io.out(json ? JSON.stringify(data, null, 2) : text);
  if (args[0] === "use" && args.length === 2) {
    const target = savedTarget(args[1], io.cwd);
    const store = createStore(target, { env: io.env });
    try { store.call("check"); } finally { store.close(); }
    saveDbTarget(target, io.env);
    emit({ db: target }, `database saved: ${target}`);
    return 0;
  }
  if (args[0] === "check" && args.length === 1) {
    const store = createStore(dbPath, { env: io.env });
    try {
      const result = store.call("check");
      emit({ db: dbPath, ...result }, `${dbPath}: connected, schema v${result.schema}.`);
    } finally { store.close(); }
    return 0;
  }
  throw new UsageError("usage: tdo db use <target> | tdo db check");
}

export function run(argv: string[], io: CliIO): number {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [command = "ls", ...args] = positionals;
  if (values.help || command === "help") {
    io.out(USAGE);
    return 0;
  }
  const json = !!values.json;
  const emit = (data: unknown, text: string) => io.out(json ? JSON.stringify(data, null, 2) : text);
  const cwd = values.C ? path.resolve(io.cwd, values.C) : io.cwd;
  const config = loadConfig(io.env);
  const project = (): Project => (values.project ? projectFromKey(values.project) : resolveProject(cwd, { env: io.env, config }));
  const dbPath = values.db ?? getDbPath(io.env, { config });

  if (command === "project") {
    const resolved = project();
    emit(resolved, resolved.key);
    return 0;
  }
  if (command === "paths") {
    const paths = { db: dbPath, config: getConfigPath(io.env), configExists: fs.existsSync(getConfigPath(io.env)) };
    emit(paths, `db:     ${paths.db}\nconfig: ${paths.config}${paths.configExists ? "" : " (not present)"}`);
    return 0;
  }

  if (command === "db") return dbCommand(args, dbPath, io, json);
  const db = createStore(dbPath, { env: io.env });
  if (command === "migrate") {
    try {
      const result = db.call("migrate", !!values["dry-run"]);
      const renamed = result.changes.filter((row: IdChange) => row.from !== row.to).map((row: IdChange) => `  ${row.project}  #${row.from} -> #${row.to}  ${row.title}`);
      emit(result, [
        result.from === result.to ? `${dbPath}: already at schema v${result.to}.` : `${dbPath}: ${values["dry-run"] ? "would upgrade" : "upgraded"} schema v${result.from} -> v${result.to}.`,
        ...(result.backup ? [`backup: ${result.backup}`] : []),
        renamed.length ? "id changes:" : "no ids changed.", ...renamed,
      ].join("\n"));
      return 0;
    } finally { db.close(); }
  }

  /** Item ids are per project: `3` / `#3` here, `name#3` or `host/owner/repo#3` elsewhere. */
  const find = (value: string | undefined) => db.call("findItem", requireRef(value), project().key);
  try {
    switch (command) {
      case "add": {
        const quick = parseQuickAdd(args.join(" "));
        if (!quick.title) throw new UsageError("tdo add needs a title.");
        const item = db.call("addItem", {
          project: project(),
          title: quick.title,
          priority: values.priority ? requirePriority(values.priority) : quick.priority,
          tags: [...quick.tags, ...(values.tags ?? [])],
          body: values.body,
          fileRef: values.file,
          source: values.source || io.env.TDO_SOURCE || "cli",
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
        const items = db.call("listItems", {
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
        const item = find(args[0]);
        emit(item, formatItemDetail(item));
        return 0;
      }
      case "edit": {
        const target = find(args[0]);
        const tags = tagEdits(values.tags);
        const item = db.call("updateItem", target, {
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
        const targets = args.map(find);
        const items = targets.map((target) => db.call("setStatus", target, STATUS_COMMANDS[command], values.message));
        emit(items.length === 1 ? items[0] : items, items.map((item) => `${item.status} ${formatItemLine(item)}`).join("\n"));
        return 0;
      }
      case "rm": {
        const item = db.call("deleteItem", find(args[0]));
        emit(item, `deleted #${item.id} ${item.title}`);
        return 0;
      }
      case "count": {
        const resolved = project();
        const counts = db.call("countActive", resolved.key);
        emit({ project: resolved.key, ...counts }, `${resolved.key}: ${formatCounts(counts)}`);
        return 0;
      }
      case "tags": {
        const tags = db.call("listTags", values.all ? undefined : project().key);
        emit(tags, tags.length ? tags.map((row) => `${String(row.count).padStart(4)}  #${row.tag}`).join("\n") : "(no tags)");
        return 0;
      }
      case "projects": {
        const projects = db.call("listProjects");
        emit(projects, projects.length ? projects.map((row) => `${String(row.active).padStart(4)}  ${row.key}`).join("\n") : "(no projects)");
        return 0;
      }
      case "export": {
        const items = db.call("listItems", { project: values.all ? undefined : project().key, status: parseStatusFilter(values.status ?? "all"), limit: 5000 });
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

async function main(): Promise<void> {
  try {
    if (process.argv[2] === "internal-rpc") {
      if (process.argv.length !== 3) throw new UsageError("internal-rpc accepts no arguments.");
      await serveRpc();
      return;
    }
    process.exitCode = run(process.argv.slice(2), { out: (text) => console.log(text), cwd: process.cwd(), env: process.env });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`tdo: ${message}`);
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) console.error("run `tdo help` for usage.");
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

if (import.meta.main) main();
