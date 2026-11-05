#!/usr/bin/env node
/**
 * tdo — per-project "fix later" backlog. See README.md.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { floatingBackend, launchFloatingBrowser } from "./floating.ts";
import { createStore, parseTarget, saveDbTarget, serveRpc } from "./store.ts";
import {
  PRIORITIES,
  STATUS_FILTERS,
  formatCounts,
  formatItemDetail,
  formatItemLine,
  formatGroupedList,
  byPriority,
  formatItemList,
  formatMarkdown,
  DEFAULT_PER_PROJECT,
  editorText,
  parseEditorText,
  getConfigPath,
  getDbPath,
  loadConfig,
  type IdChange,
  parseQuickAdd,
  parseStatusFilter,
  projectFromKey,
  requirePriority,
  resolveProject,
  itemRef,
  type Item,
  type Project,
  type Status,
  type StatusFilter,
} from "./core.ts";

const USAGE = `tdo — per-project backlog for things to fix later

usage:
  tdo                       in a terminal with fzf: browse and act on items (see keys below);
                            otherwise the same as tdo ls
  tdo add <title...> [-p PRIO] [-t TAGS] [-b BODY] [-f PATH[:LINE]] [--source NAME]
                            (inline !high and #tag work too)
  tdo ls [-a] [-s STATUS] [-t TAGS] [-p PRIO] [-q TEXT] [-n N]
                            -a groups by project, N items each (default ${DEFAULT_PER_PROJECT}; 0 = all)
  tdo show [id]             ids are per project: 3 or #3 here, NAME#3 or KEY#3 elsewhere
  tdo edit [id] [--title T] [-p PRIO] [-t +tag,-tag] [-b BODY] [-f REF]
                            no flags: edit title and body in $EDITOR
  tdo start|done|drop|reopen [id...] [-m NOTE]
  tdo rm [id]
  tdo pick [-a] [-s STATUS] print the refs of items picked with fzf
                            (any command above picks with fzf when the id is left out)
  tdo count                 open-item summary for the current project
  tdo tags [-a]             tag counts for active items
  tdo projects              all projects with active counts
  tdo project               show the resolved project key
  tdo paths                 show the database and config file locations
  tdo db use <target>        validate and save a local path or ssh:// URI
  tdo db check               check connection and schema
  tdo migrate [--dry-run]   upgrade an older database (backs it up first) and print id changes
  tdo export [-a] [--md]    dump items as JSON (default) or Markdown

browser keys (plain tdo, or tdo browse [-a] [-s all]):
  enter view · ctrl-e edit · ctrl-s start · ctrl-d done · ctrl-x drop · ctrl-r reopen
  alt-up/alt-down priority · alt-d delete · ctrl-n add the query as an item
  ctrl-a all projects · ctrl-t include closed · tab marks several · esc quit

options:
  --db TARGET     one-off database override (then TDO_DB, config db, default)
  --project KEY   use this project instead of resolving from the cwd
  -C DIR          resolve the project from DIR
  --json          machine-readable output (all commands)
  --no-float      keep the browser inline even with config floating: true
  -a, --all       across all projects

priorities: ${PRIORITIES.join(", ")} (prefixes and 0-3 accepted)
statuses:   ${STATUS_FILTERS.join(", ")} (ls default: active = open + doing)
files:      database $XDG_DATA_HOME/tdo/tdo.db (default ~/.local/share/tdo/tdo.db)
            config   $XDG_CONFIG_HOME/tdo/config.json (optional; keys: db, aliases, perProject, floating)
env:        TDO_DB, TDO_CONFIG, TDO_PROJECT, TDO_SOURCE (who is adding: cli, claude, codex, ...),
            TDO_FZF_OPTS (extra fzf flags), NO_COLOR / FORCE_COLOR`;

const OPTIONS = {
  db: { type: "string" },
  project: { type: "string" },
  C: { type: "string", short: "C" },
  json: { type: "boolean" },
  "no-float": { type: "boolean" },
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

/** Interactive hooks, injectable for tests. Without them the CLI uses fzf and $EDITOR on a terminal. */
export type Interactive = {
  /** Shows `lines` (tab-separated: ref, then display text) and returns the picked refs; empty means cancelled. */
  pick?: (lines: string[], options: { multi: boolean; header: string; preview: string }) => string[];
  /** Opens `text` in an editor; returns the saved text, or undefined if cancelled. */
  edit?: (text: string) => string | undefined;
};

export type Io = {
  out: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  color?: boolean;
  /** Plain `tdo` opens the fzf browser when true (a terminal with fzf); otherwise it lists. */
  interactive?: boolean;
  /** Runs fzf for the browser; injectable for tests. Returns fzf's exit status. */
  runFzf?: (args: string[], env: NodeJS.ProcessEnv) => number;
  /** Launches the browser in a separate terminal; injectable for tests. */
  runFloat?: typeof launchFloatingBrowser;
} & Interactive;

const PICK_COMMANDS = new Set(["show", "edit", "start", "done", "drop", "reopen", "rm", "pick"]);
const MULTI_COMMANDS = new Set(["start", "done", "drop", "reopen", "pick"]);

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "").split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, name)));
}

/** fzf over the items; reads its UI from /dev/tty, so stdin/stdout stay free for the item list and result. */
function fzfPick(env: NodeJS.ProcessEnv): Interactive["pick"] | undefined {
  if (!process.stdin.isTTY || !process.stderr.isTTY || !onPath("fzf", env)) return undefined;
  return (lines, { multi, header, preview }) => {
    const args = [
      "--ansi", "--delimiter=\t", "--with-nth=2..", "--no-sort", "--layout=reverse", "--height=60%",
      `--header=${header}`, `--preview=${preview}`, "--preview-window=right,55%,wrap",
      ...(multi ? ["--multi", "--bind=ctrl-a:toggle-all"] : []),
    ];
    const extra = env.TDO_FZF_OPTS?.trim();
    const result = spawnSync("fzf", args, { input: lines.join("\n"), encoding: "utf8", stdio: ["pipe", "pipe", "inherit"], env: { ...env, FZF_DEFAULT_OPTS: [env.FZF_DEFAULT_OPTS, extra].filter(Boolean).join(" ") } });
    if (result.error) throw result.error;
    // 1 = no match, 130 = cancelled.
    if (result.status !== 0) return [];
    return result.stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[0]!);
  };
}

function editorEdit(env: NodeJS.ProcessEnv): Interactive["edit"] | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const editor = env.VISUAL?.trim() || env.EDITOR?.trim() || "vi";
  return (text) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdo-edit-"));
    const file = path.join(dir, "item.md");
    try {
      fs.writeFileSync(file, `${text}\n`);
      const result = spawnSync(`${editor} ${shellQuote(file)}`, { shell: true, stdio: "inherit", env });
      if (result.status !== 0) return undefined;
      return fs.readFileSync(file, "utf8");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Whether to color output: FORCE_COLOR wins, then NO_COLOR, then whether stdout is a terminal. */
export function useColor(env: NodeJS.ProcessEnv, isTTY: boolean | undefined): boolean {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return !!isTTY;
}

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

export function run(argv: string[], io: Io): number {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [command = io.interactive && !values.json ? "browse" : "ls", ...args] = positionals;
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

  if (command === "browse") {
    const status = values.status ? parseStatusFilter(values.status) : "active";
    const backend = config.floating && !values["no-float"] && !json ? floatingBackend(io.env) : undefined;
    if (backend) {
      const child = [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), "browse", "--no-float",
        "--db", savedTarget(dbPath, io.cwd), "--project", project().key, "-C", cwd, "-s", status,
        ...(values.all ? ["-a"] : [])];
      return (io.runFloat ?? launchFloatingBrowser)({ backend, command: child, cwd: io.cwd, env: io.env });
    }
    return browse(io, { all: !!values.all, status, project: values.project, cwd: values.C ? cwd : undefined, db: dbPath });
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
  const color = !json && !!io.color;
  const all = !!values.all;

  /** Items named on the command line, or picked with fzf when there are none. */
  const targets = (): Item[] => {
    if (args.length) return args.map(find);
    const pick = io.pick ?? fzfPick(io.env);
    if (!pick) throw new UsageError(`tdo ${command} needs an item id (or install fzf and run it in a terminal to pick one).`);
    const status = parseStatusFilter(values.status ?? (command === "reopen" ? "closed" : "active"));
    const items = db.call("listItems", { project: all ? undefined : project().key, status, limit: 5000 }).sort((a, b) => (all ? a.project.localeCompare(b.project) : 0) || byStatusThenPriority(a, b));
    if (!items.length) throw new Error(`nothing to pick from${all ? "" : ` in ${project().key}`}.`);
    const self = [process.execPath, ...process.execArgv, process.argv[1] ?? "tdo", "--db", dbPath, "--project", project().key].map(shellQuote).join(" ");
    const lines = items.map((item) => `${item.project}#${item.id}\t${formatItemLine(item, { showProject: all, color: true })}`);
    const multi = MULTI_COMMANDS.has(command);
    const header = `tdo ${command}${all ? " (all projects)" : ` · ${project().key}`}${multi ? " · tab to mark several" : ""}`;
    const picked = pick(lines, { multi, header, preview: `${self} show {1}` });
    if (!picked.length) throw new Cancelled();
    return picked.map((ref) => db.call("findItem", ref, project().key));
  };
  const one = (): Item => {
    const picked = targets();
    if (picked.length > 1) throw new UsageError(`tdo ${command} takes one item.`);
    return picked[0]!;
  };
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
        const limit = values.limit === undefined ? undefined : Number(values.limit);
        if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) throw new UsageError(`-n must be a non-negative integer, got ${JSON.stringify(values.limit)}.`);
        const filter = {
          project: all ? undefined : project().key,
          status: parseStatusFilter(values.status),
          tags: values.tags,
          minPriority: values.priority ? requirePriority(values.priority) : undefined,
          query: values.query,
        };
        if (!all) {
          const items = db.call("listItems", { ...filter, limit: limit || undefined });
          emit(items, formatItemList(items, { color }));
          return 0;
        }
        // Across projects, -n (or the config's perProject) caps each project's group.
        const perProject = limit ?? config.perProject ?? DEFAULT_PER_PROJECT;
        const items = db.call("listItems", { ...filter, limit: 5000 });
        if (json) {
          const counts = new Map<string, number>();
          emit(items.sort(byPriority).filter((item) => {
            const seen = (counts.get(item.project) ?? 0) + 1;
            counts.set(item.project, seen);
            return perProject === 0 || seen <= perProject;
          }), "");
          return 0;
        }
        emit(items, formatGroupedList(items, { perProject, color }));
        return 0;
      }
      case "_fzf": {
        // Internal helpers for the fzf browser: _fzf <action> <state-file> [refs...]
        const [action, stateFile, ...refs] = args;
        if (!action || !stateFile) throw new UsageError("tdo _fzf is internal; run plain `tdo` instead.");
        const state = readState(stateFile);
        const scope = state.all ? undefined : project().key;
        switch (action) {
          case "feed": {
            const items = db.call("listItems", { project: scope, status: state.status, limit: 5000 }).sort((a, b) => (state.all ? byProjectFirst(a, b, project().key) : 0) || byStatusThenPriority(a, b));
            io.out(items.map((item) => `${item.project}#${item.id}\t${formatItemLine(item, { showProject: state.all, color: true })}`).join("\n"));
            return 0;
          }
          case "header":
            io.out(browseHeader(state, project().key));
            return 0;
          case "toggle-all":
            writeState(stateFile, { ...state, all: !state.all });
            return 0;
          case "toggle-closed":
            writeState(stateFile, { ...state, status: state.status === "active" ? "all" : "active" });
            return 0;
          case "raise":
          case "lower":
            for (const ref of refs) {
              const item = db.call("findItem", ref, project().key);
              const index = PRIORITIES.indexOf(item.priority) + (action === "raise" ? -1 : 1);
              if (index >= 0 && index < PRIORITIES.length) db.call("updateItem", item, { priority: PRIORITIES[index] });
            }
            return 0;
          case "delete": {
            const items = refs.map((ref) => db.call("findItem", ref, project().key));
            if (!items.length) return 0;
            const answer = askTty(`delete ${items.length === 1 ? `${itemRef(items[0]!, { showProject: true })} ${items[0]!.title}` : `${items.length} items`}? [y/N] `);
            if (/^y(es)?$/i.test(answer.trim())) for (const item of items) db.call("deleteItem", item);
            return 0;
          }
          default:
            throw new UsageError(`unknown _fzf action: ${action}`);
        }
      }
      case "pick": {
        io.out(targets().map((item) => (all || item.project !== project().key ? `${item.project}#${item.id}` : String(item.id))).join("\n"));
        return 0;
      }
      case "show": {
        const item = one();
        emit(item, formatItemDetail(item));
        return 0;
      }
      case "edit": {
        const target = one();
        const flagged = [values.title, values.priority, values.body, values.file, values.tags].some((value) => value !== undefined);
        if (!flagged) {
          const edit = io.edit ?? editorEdit(io.env);
          if (!edit) throw new UsageError("tdo edit needs flags such as --title or -p when not run in a terminal.");
          const text = edit(editorText(target));
          if (text === undefined) throw new Cancelled();
          const { title, body } = parseEditorText(text);
          if (!title) throw new Error("title must not be empty; nothing changed.");
          if (title === target.title && body === (target.body ?? null)) {
            emit(target, `unchanged ${formatItemLine(target, { color })}`);
            return 0;
          }
          const item = db.call("updateItem", target, { title, body });
          emit(item, `updated ${formatItemLine(item, { color })}`);
          return 0;
        }
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
        const items = targets().map((target) => db.call("setStatus", target, STATUS_COMMANDS[command], values.message));
        emit(items.length === 1 ? items[0] : items, items.map((item) => `${item.status} ${formatItemLine(item)}`).join("\n"));
        return 0;
      }
      case "rm": {
        const item = db.call("deleteItem", one());
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

type BrowseState = { all: boolean; status: StatusFilter };

function readState(file: string): BrowseState {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BrowseState>;
  return { all: !!parsed.all, status: parseStatusFilter(parsed.status) };
}

function writeState(file: string, state: BrowseState): void {
  fs.writeFileSync(file, JSON.stringify(state));
}

/** The current project first, then the rest by key. */
function byProjectFirst(a: Item, b: Item, current: string): number {
  return Number(b.project === current) - Number(a.project === current) || a.project.localeCompare(b.project);
}

/** Browser key bindings: [key, label, fzf action]. `$T` is the tdo invocation, `$S` the state file. */
export const BROWSE_KEYS: [string, string, string][] = [
  ["enter", "view", "execute($T show {1} | ${PAGER:-less -R})"],
  ["ctrl-e", "edit", "execute($T edit {1})+reload($T _fzf feed $S)"],
  ["ctrl-s", "start", "execute-silent($T start {+1})+reload($T _fzf feed $S)"],
  ["ctrl-d", "done", "execute-silent($T done {+1})+reload($T _fzf feed $S)"],
  ["ctrl-x", "drop", "execute-silent($T drop {+1})+reload($T _fzf feed $S)"],
  ["ctrl-r", "reopen", "execute-silent($T reopen {+1})+reload($T _fzf feed $S)"],
  ["alt-up", "prio+", "execute-silent($T _fzf raise $S {+1})+reload($T _fzf feed $S)"],
  ["alt-down", "prio-", "execute-silent($T _fzf lower $S {+1})+reload($T _fzf feed $S)"],
  ["alt-d", "delete", "execute($T _fzf delete $S {+1})+reload($T _fzf feed $S)"],
  ["ctrl-n", "add query", "execute-silent($T add {q})+clear-query+reload($T _fzf feed $S)"],
  ["ctrl-a", "all projects", "execute-silent($T _fzf toggle-all $S)+reload($T _fzf feed $S)+transform-header($T _fzf header $S)"],
  ["ctrl-t", "closed", "execute-silent($T _fzf toggle-closed $S)+reload($T _fzf feed $S)+transform-header($T _fzf header $S)"],
];

function browseHeader(state: BrowseState, current: string): string {
  const scope = state.all ? "all projects" : current;
  const shown = state.status === "active" ? "open" : "open + closed";
  const keys = BROWSE_KEYS.map(([key, label]) => `${key} ${label}`);
  return [`tdo · ${scope} · ${shown} · tab marks several · esc quit`, keys.slice(0, 6).join(" · "), keys.slice(6, 9).join(" · "), keys.slice(9).join(" · ")].join("\n");
}

export function browseArgs(tdo: string, stateFile: string, header: string, floating = false): string[] {
  const expand = (action: string) => action.replaceAll("$T", tdo).replaceAll("$S", shellQuote(stateFile));
  return [
    "--ansi", "--multi", "--delimiter=\t", "--with-nth=2..", "--no-sort", "--layout=reverse", floating ? "--height=100%" : "--height=90%",
    "--prompt=tdo> ", `--header=${header}`, "--header-first",
    `--preview=${tdo} show {1}`, "--preview-window=right,50%,wrap",
    `--bind=start:reload(${expand("$T _fzf feed $S")})`,
    ...BROWSE_KEYS.map(([key, , action]) => `--bind=${key}:${expand(action)}`),
  ];
}

/** The interactive browser: fzf over the backlog, with bindings for every action. */
function browse(io: Io, options: { all: boolean; status: StatusFilter; project?: string; cwd?: string; db: string }): number {
  const runFzf = io.runFzf ?? (onPath("fzf", io.env) ? (fzfArgs: string[], env: NodeJS.ProcessEnv) => spawnSync("fzf", fzfArgs, { stdio: ["ignore", "inherit", "inherit"], env }).status ?? 1 : undefined);
  if (!runFzf) throw new UsageError("the browser needs fzf on PATH; use `tdo ls` to list.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdo-browse-"));
  const stateFile = path.join(dir, "state.json");
  try {
    const state: BrowseState = { all: options.all, status: options.status };
    writeState(stateFile, state);
    // Subcommands inherit the browser's project selection.
    const tdo = [process.execPath, ...process.execArgv, process.argv[1] ?? "tdo", "--db", options.db, ...(options.project ? ["--project", options.project] : []), ...(options.cwd ? ["-C", options.cwd] : [])].map(shellQuote).join(" ");
    const current = options.project ?? resolveProject(options.cwd ?? io.cwd, { env: io.env }).key;
    const env: NodeJS.ProcessEnv = { ...io.env, FORCE_COLOR: "1", FZF_DEFAULT_OPTS: [io.env.FZF_DEFAULT_OPTS, io.env.TDO_FZF_OPTS].filter(Boolean).join(" ") };
    delete env.NO_COLOR;
    const status = runFzf(browseArgs(tdo, stateFile, browseHeader(state, current), io.env.TDO_FLOATING_BROWSER === "1"), env);
    // 1 = no match, 130 = esc: both are a normal exit from the browser.
    return status === 1 || status === 130 ? 0 : status;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Prompts on the controlling terminal; returns "" when there is none. */
function askTty(question: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync("/dev/tty", "r+");
    fs.writeSync(fd, question);
    const buffer = Buffer.alloc(256);
    let answer = "";
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      answer += buffer.toString("utf8", 0, read);
      if (answer.includes("\n")) break;
    }
    return answer.split("\n")[0] ?? "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Raised when an interactive pick or edit is cancelled; exits quietly with 130 like fzf. */
class Cancelled extends Error {}

const STATUS_ORDER: Record<Status, number> = { doing: 0, open: 1, done: 2, dropped: 3 };

function byStatusThenPriority(a: Item, b: Item): number {
  return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byPriority(a, b);
}

async function main(): Promise<void> {
  try {
    if (process.argv[2] === "internal-rpc") {
      if (process.argv.length !== 3) throw new UsageError("internal-rpc accepts no arguments.");
      await serveRpc();
      return;
    }
    const tty = !!process.stdin.isTTY && !!process.stdout.isTTY;
    process.exitCode = run(process.argv.slice(2), { out: (text) => console.log(text), cwd: process.cwd(), env: process.env, color: useColor(process.env, process.stdout.isTTY), interactive: tty && onPath("fzf", process.env) });
  } catch (error) {
    if (error instanceof Cancelled) {
      process.exitCode = 130;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`tdo: ${message}`);
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) console.error("run `tdo help` for usage.");
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

if (import.meta.main) main();
