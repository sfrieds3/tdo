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
import { createStore, parseTarget, saveDbTarget, serveRpc, type Store } from "./store.ts";
import { isApproved, resolveTracker, setApproval, type EffectiveTracker, type TrackerResolution } from "./trackers/config.ts";
import { autoIntent, isHumanCommand } from "./trackers/auto.ts";
import { summarizeLinks, formatSyncSummary } from "./trackers/status.ts";
import { drainItems } from "./trackers/drain.ts";
import { pushItem, syncProject, trackerFor, type PushResult } from "./trackers/sync.ts";
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
  updateConfig,
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
  tdo ls [-a] [-s STATUS] [-t TAGS] [-p PRIO] [-q TEXT] [-n N] [--linked] [--awaiting]
                            -a groups by project, N items each (default ${DEFAULT_PER_PROJECT}; 0 = all)
                            ↗#42 filed as an issue, ↗… in progress, ↗! needs attention
  tdo show [id]             ids are per project: 3 or #3 here, NAME#3 or KEY#3 elsewhere
  tdo edit [id] [--title T] [-p PRIO] [-t +tag,~tag] [-b BODY] [-f REF]
                            ~tag removes a tag (quote a leading ~: -t '~tag')
                            no flags: edit title and body in $EDITOR
  tdo start|done|drop|reopen [id...] [-m NOTE]
  tdo note [id] <text...>   add a note without changing status
  tdo rm [id]
  tdo push [id...] [--attach URL | --force | --detach]
                            file items as GitHub issues (see tdo tracker)
  tdo sync [--retry]        drain saved tracker operations for this project
  tdo tracker [status|approve|revoke] [--yes]
                            issue tracker config from .tdo/config.json and your approval
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
  alt-up/alt-down priority · alt-d delete · alt-n add the query as an item
  ctrl-a all projects · ctrl-t include closed · tab marks several · esc quit

options:
  --db TARGET     one-off database override (then TDO_DB, config db, default)
  --project KEY   use this project instead of resolving from the cwd
  -C DIR          resolve the project from DIR
  --json          machine-readable output (all commands)
  --no-sync       save lifecycle intent without contacting GitHub
  --no-float      keep the browser inline even with config floating: true
  -a, --all       across all projects

priorities: ${PRIORITIES.join(", ")} (prefixes and 0-3 accepted)
statuses:   ${STATUS_FILTERS.join(", ")} (ls default: active = open + doing)
files:      database $XDG_DATA_HOME/tdo/tdo.db (default ~/.local/share/tdo/tdo.db)
            config   $XDG_CONFIG_HOME/tdo/config.json (optional; keys: db, aliases, perProject, floating, worktree, projects)
            repo     .tdo/config.json at the repo root (optional; keys: project, tracker)
env:        TDO_DB, TDO_CONFIG, TDO_PROJECT, TDO_SOURCE (who is adding: cli, claude, codex, ...),
            TDO_FZF_OPTS (extra fzf flags), NO_COLOR / FORCE_COLOR`;

const OPTIONS = {
  db: { type: "string" },
  project: { type: "string" },
  C: { type: "string", short: "C" },
  json: { type: "boolean" },
  "no-float": { type: "boolean" },
  "no-sync": { type: "boolean" },
  retry: { type: "boolean" },
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
  linked: { type: "boolean" },
  awaiting: { type: "boolean" },
  attach: { type: "string" },
  force: { type: "boolean" },
  detach: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
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
  /** Warnings and progress; never mixed into --json stdout. Defaults to stderr. */
  err?: (text: string) => void;
  /** Asks a yes/no question on the terminal; undefined when there is none. Injectable for tests. */
  confirm?: (question: string) => boolean;
  /** stdin and stdout are a terminal; decides whether an item was added by a person. */
  tty?: boolean;
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

const MULTI_COMMANDS = new Set(["start", "done", "drop", "reopen", "pick", "push"]);
/** Sources that mean a person typed the command (with a terminal attached). */

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "").split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, name)));
}

/** ctrl-n/ctrl-p always move the cursor, even when FZF_DEFAULT_OPTS (e.g. --history) rebinds them. */
const CURSOR_BINDS = ["--bind=ctrl-n:down", "--bind=ctrl-p:up"];

/** fzf over the items; reads its UI from /dev/tty, so stdin/stdout stay free for the item list and result. */
function fzfPick(env: NodeJS.ProcessEnv): Interactive["pick"] | undefined {
  if (!process.stdin.isTTY || !process.stderr.isTTY || !onPath("fzf", env)) return undefined;
  return (lines, { multi, header, preview }) => {
    const args = [
      "--ansi", "--delimiter=\t", "--with-nth=2..", "--no-sort", "--layout=reverse", "--height=60%",
      `--header=${header}`, `--preview=${preview}`, "--preview-window=right,55%,wrap",
      ...CURSOR_BINDS,
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

/**
 * Splits `-t +a,~b,c` style edits into tags to add and remove. `~` or `-` removes; `+` or no prefix adds.
 * A leading `=` (from `-t=~b`, which short options don't support) is dropped.
 */
function tagEdits(values: string[] | undefined): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const part of (values ?? []).flatMap((value) => value.replace(/^=/, "").split(","))) {
    const text = part.trim();
    if (/^[~-]/.test(text)) remove.push(text.slice(1));
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

/** Recovery actions must also offer closed items; ordinary push only offers active ones. */
function pickerDefaultStatus(command: string, values: { attach?: string; detach?: boolean }): StatusFilter {
  if (command === "reopen") return "closed";
  if (command === "push" && (values.detach || values.attach)) return "all";
  return "active";
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
  const warn = io.err ?? ((text: string) => console.error(text));
  const tracker = (): TrackerResolution => resolveTracker(project(), config, { configPath: getConfigPath(io.env) });
  if (command === "tracker") return trackerCommand(args, { io, json, emit, warn, project: project(), tracker: tracker(), yes: !!values.yes, dbPath });
  const db = createStore(dbPath, { env: io.env });
  if (command === "migrate") {
    try {
      const result = db.call("migrate", !!values["dry-run"]);
      const renamed = result.changes.filter((row: IdChange) => row.from !== row.to).map((row: IdChange) => `  ${row.project}  #${row.from} -> #${row.to}  ${row.title}`);
      const moved = result.notesMoved ? [`${values["dry-run"] ? "would move" : "moved"} ${result.notesMoved} status note${result.notesMoved === 1 ? "" : "s"} out of item bodies.`] : [];
      emit(result, [
        result.from === result.to ? `${dbPath}: already at schema v${result.to}.` : `${dbPath}: ${values["dry-run"] ? "would upgrade" : "upgraded"} schema v${result.from} -> v${result.to}.`,
        ...(result.backup ? [`backup: ${result.backup}`] : []),
        ...(result.from === result.to ? [] : [...(renamed.length ? ["id changes:", ...renamed] : ["no ids changed."]), ...moved]),
      ].join("\n"));
      return 0;
    } finally { db.close(); }
  }

  /** Item ids are per project: `3` / `#3` here, `name#3` or `host/owner/repo#3` elsewhere. */
  const find = (value: string | undefined) => db.call("findItem", requireRef(value), project().key);
  const color = !json && !!io.color;
  const all = !!values.all;

  /** Items named on the command line, or picked with fzf when there are none. */
  const targets = (refs: string[] = args): Item[] => {
    if (refs.length) return refs.map(find);
    const pick = io.pick ?? fzfPick(io.env);
    if (!pick) throw new UsageError(`tdo ${command} needs an item id (or install fzf and run it in a terminal to pick one).`);
    const status = parseStatusFilter(values.status ?? pickerDefaultStatus(command, values));
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
  const one = (refs: string[] = args): Item => {
    const picked = targets(refs);
    if (picked.length > 1) throw new UsageError(`tdo ${command} takes one item.`);
    return picked[0]!;
  };
  // Resolved lazily, inside the command's error handling, and only by commands that need it.
  let cached: TrackerResolution | undefined;
  const resolved = (): TrackerResolution => {
    if (cached) return cached;
    cached = tracker();
    if (cached.kind === "invalid" && !["push", "sync"].includes(command)) warn(`tdo: invalid tracker config: ${cached.error}`);
    return cached;
  };
  const intentFor = (itemProject = project().key) => {
    if (itemProject !== project().key) return undefined;
    const resolution = resolved();
    return autoIntent(resolution.kind === "ok" ? resolution.tracker : undefined, isHumanCommand(!!io.tty, values.source || io.env.TDO_SOURCE || "cli"));
  };
  const afterMutation = (items: Item[]) => {
    for (const item of items) if (item.links.some((link) => link.state === "awaiting-approval")) warn(`#${item.id} matches the tracker tag — awaiting approval: run 'tdo push ${item.id}'.`);
    if (values["no-sync"]) return;
    const resolution = resolved();
    if (resolution.kind !== "ok") return;
    if (!isApproved(resolution.tracker)) {
      if (items.some((item) => item.links.length)) warn(`tdo: tracker ${resolution.tracker.approval}; operations remain queued; run tdo tracker approve.`);
      return;
    }
    // This checkout cannot approve another project's repository configuration.
    for (const item of items.filter((item) => item.project === project().key && item.links.some((link) => link.state === "pending"))) {
      try {
        const result = pushItem(db, item, resolution.tracker, { warn, env: io.env, noSync: true });
        if (result.error) warn(`tdo: ${result.error}`);
      } catch (error) { warn(`tdo: #${item.id}: filing paused: ${(error as Error).message}; local change saved.`); }
    }
    drainItems(db, items.filter((item) => item.project === project().key), resolution.tracker, { warn, env: io.env, limit: 5 });
  };
  try {
    switch (command) {
      case "add": {
        const quick = parseQuickAdd(args.join(" "));
        if (!quick.title) throw new UsageError("tdo add needs a title.");
        const source = values.source || io.env.TDO_SOURCE || "cli";
        const item = db.call("addItem", {
          project: project(),
          title: quick.title,
          priority: values.priority ? requirePriority(values.priority) : quick.priority,
          tags: [...quick.tags, ...(values.tags ?? [])],
          body: values.body,
          fileRef: values.file,
          source,
          sessionId: io.env.TDO_SESSION_ID,
          host: os.hostname().split(".")[0],
          createdByHuman: isHumanCommand(!!io.tty, source),
        }, intentFor());
        emit(item, `added ${formatItemLine(item)}`);
        afterMutation([item]);
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
          ...(values.linked ? { linked: true } : {}),
          ...(values.awaiting ? { awaiting: true } : {}),
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
            if (/^y(es)?$/i.test(answer.trim())) for (const item of items) deleteWithWarning(db, item, warn);
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
          const item = db.call("updateItem", target, { title, body }, intentFor(target.project));
          emit(item, `updated ${formatItemLine(item, { color })}`);
          afterMutation([item]);
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
        }, intentFor(target.project));
        emit(item, `updated ${formatItemLine(item)}`);
        afterMutation([item]);
        return 0;
      }
      case "start":
      case "done":
      case "drop":
      case "reopen": {
        const selected = targets();
        // Resolve every policy before the first write: a later foreign target may be unsafe.
        const policies = selected.map((target) => statusPolicy(target, project().key, STATUS_COMMANDS[command], resolved(), config));
        const items = selected.map((target, i) => db.call("setStatus", target, STATUS_COMMANDS[command], values.message, policies[i]));
        emit(items.length === 1 ? items[0] : items, items.map((item) => `${item.status} ${formatItemLine(item)}`).join("\n"));
        afterMutation(items);
        return 0;
      }
      case "note": {
        // `tdo note 3 text...`; without a leading id, pick the item and use every word as the note.
        const ref = args.length && /^(?:.+#|#)?\d+$/.test(args[0]!) ? args[0] : undefined;
        const text = (ref ? args.slice(1) : args).join(" ").trim() || values.message?.trim();
        if (!text) throw new UsageError("tdo note needs text: tdo note <id> <text...>");
        const target = one(ref ? [ref] : []);
        const item = db.call("addNote", target, text);
        emit(item, `noted ${formatItemLine(item, { color })}`);
        afterMutation([item]);
        return 0;
      }
      case "sync": {
        if (args.length || all) throw new UsageError("usage: tdo sync [--retry] (current project only)");
        const resolution = resolved();
        if (resolution.kind !== "ok") throw new Error(resolution.kind === "invalid" ? resolution.error : "no tracker configured");
        if (!isApproved(resolution.tracker)) throw new Error("tracker is not approved; run tdo tracker approve");
        if (values["no-sync"]) throw new UsageError("sync cannot be combined with --no-sync");
        const results = syncProject(db, project().key, resolution.tracker, { warn, env: io.env, retry: values.retry });
        emit(results, results.length ? results.map((row) => `#${row.id}: ${row.error ?? ("sent" in row ? `${row.sent} operations sent` : row.state)}`).join("\n") : "nothing queued.");
        return results.some((row) => row.error) ? 1 : 0;
      }
      case "push":
        return pushCommand(db, { targets, find, args, values, json, emit, warn, io, tracker: tracker(), projectKey: project().key });
      case "rm": {
        const item = deleteWithWarning(db, one(), warn);
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

function deleteWithWarning(store: Store, key: Item, warn: (text: string) => void): Item {
  const item = store.call("deleteItem", key);
  for (const link of item.links) if (link.url) warn(`tdo: ${link.url} was left unchanged on ${link.destination}.`);
  return item;
}

/** Asks on the controlling terminal; undefined when there's no terminal to ask on. */
function ttyConfirm(question: string): boolean | undefined {
  if (!process.stdin.isTTY) return undefined;
  return /^y(es)?$/i.test(askTty(`${question} [y/N] `).trim());
}

function describeTracker(tracker: EffectiveTracker): string[] {
  const from = (key: keyof EffectiveTracker["sources"]) => (tracker.sources[key] === "user" ? "  (your config)" : "");
  return [
    `provider:    ${tracker.provider}${from("provider")}`,
    `destination: ${tracker.destination}${from("repo")}`,
    `mode:        ${tracker.mode}${from("mode")}`,
    `tag:         #${tracker.tag}${from("tag")}`,
    `labels:      ${tracker.labels.length ? tracker.labels.join(", ") : "(none)"}${from("labels")}`,
    `closeOnDone: ${tracker.closeOnDone}${from("closeOnDone")}`,
  ];
}

const APPROVAL_TEXT: Record<EffectiveTracker["approval"], string> = {
  approved: "approved",
  unapproved: "not approved; run `tdo tracker approve`",
  changed: "changed since you approved it; run `tdo tracker approve` to review",
  "user-only": "defined in your config (no approval needed)",
};

/** Shows the effective tracker and asks to approve it; writes the approval on yes. */
function approve(tracker: EffectiveTracker, projectKey: string, options: { io: Io; warn: (text: string) => void; yes: boolean; env: NodeJS.ProcessEnv }): boolean {
  if (tracker.approval === "user-only" || tracker.approval === "approved") return true;
  if (!options.yes) {
    const ask = options.io.confirm ?? ttyConfirm;
    options.warn([`${projectKey}: .tdo/config.json wants to file issues with your gh credentials:`, ...describeTracker(tracker).map((line) => `  ${line}`)].join("\n"));
    const answer = ask("Approve?");
    if (answer === undefined) throw new UsageError("no terminal to confirm on; review with `tdo tracker status` and run `tdo tracker approve --yes`.");
    if (!answer) return false;
  }
  updateConfig((raw) => setApproval(raw, projectKey, tracker.hash), options.env);
  tracker.approval = "approved";
  return true;
}

type TrackerCommandContext = { io: Io; json: boolean; emit: (data: unknown, text: string) => void; warn: (text: string) => void; project: Project; tracker: TrackerResolution; yes: boolean; dbPath: string };

function trackerCommand(args: string[], ctx: TrackerCommandContext): number {
  const [sub = "status", ...rest] = args;
  if (rest.length) throw new UsageError(`unexpected argument: ${rest[0]}`);
  const { tracker } = ctx;
  if (sub === "status") {
    if (tracker.kind !== "ok") {
      const text = tracker.kind === "none" ? "no tracker configured (add a \"tracker\" block to .tdo/config.json)" : tracker.kind === "disabled" ? "tracker disabled in your config" : `invalid tracker config: ${tracker.error}`;
      ctx.emit({ project: ctx.project.key, tracker: tracker.kind, ...(tracker.kind === "invalid" ? { error: tracker.error } : {}) }, `${ctx.project.key}: ${text}`);
      return tracker.kind === "invalid" ? 1 : 0;
    }
    const config = tracker.tracker;
    const health = trackerFor(config.destination, ctx.io.env).check();
    let links: Record<string, number[]> | undefined;
    let linksError: string | undefined;
    let sync: ReturnType<typeof summarizeLinks> | undefined;
    const store = createStore(ctx.dbPath, { env: ctx.io.env });
    try {
      links = store.call("countLinks", ctx.project.key);
      sync = summarizeLinks(store.call("listLinkedItems", ctx.project.key), config);
    } catch (error) { linksError = (error as Error).message; } finally { store.close(); }
    ctx.emit({ project: ctx.project.key, tracker: { ...config }, gh: health.ok ? "ok" : health.message, links: links ?? null, sync: sync ?? null, ...(linksError ? { linksError } : {}) }, [
      `${ctx.project.key}: ${config.provider} issues in ${config.destination}`,
      ...describeTracker(config).map((line) => `  ${line}`),
      `approval:    ${APPROVAL_TEXT[config.approval]}`,
      `gh:          ${health.ok ? "ok" : health.message}`,
      ...(sync ? formatSyncSummary(sync) : []),
      ...(links ? Object.entries(links).map(([state, ids]) => `${`${state}:`.padEnd(13)}${ids.map((id) => `#${id}`).join(" ")}`) : [`links:       unavailable (${linksError})`]),
    ].join("\n"));
    return 0;
  }
  if (tracker.kind === "invalid") throw new Error(`invalid tracker config: ${tracker.error}`);
  if (tracker.kind !== "ok") throw new Error(`${ctx.project.key}: no tracker configured.`);
  const config = tracker.tracker;
  if (sub === "approve") {
    if (config.approval === "user-only") throw new Error("this tracker is defined in your own config; there's nothing to approve.");
    const approved = approve(config, ctx.project.key, { io: ctx.io, warn: ctx.warn, yes: ctx.yes, env: ctx.io.env });
    if (!approved) throw new Cancelled();
    ctx.emit({ project: ctx.project.key, approved: true, hash: config.hash }, `approved: ${config.provider} issues in ${config.destination} for ${ctx.project.key}.`);
    return 0;
  }
  if (sub === "revoke") {
    if (config.approval === "user-only") throw new Error("this tracker is defined in your config; remove it or set \"tracker\": false.");
    updateConfig((raw) => setApproval(raw, ctx.project.key, undefined), ctx.io.env);
    ctx.emit({ project: ctx.project.key, approved: false }, `revoked tracker approval for ${ctx.project.key}.`);
    return 0;
  }
  throw new UsageError("usage: tdo tracker [status|approve|revoke] [--yes]");
}

/** Foreign links need their own known user policy; approval hashes imply missing repository policy. */
function statusPolicy(item: Item, current: string, status: Status, resolution: TrackerResolution, config: ReturnType<typeof loadConfig>): boolean {
  if (item.project === current) return resolution.kind === "ok" ? resolution.tracker.closeOnDone : true;
  if (status === "doing" || !item.links.some((link) => ["open", "closed"].includes(link.state))) return false;
  const raw = config.projects?.[item.project]?.tracker;
  const foreign = resolveTracker(projectFromKey(item.project), config);
  if (raw && typeof raw === "object" && !("approved" in raw) && foreign.kind === "ok") return foreign.tracker.closeOnDone;
  throw new Error(`${item.project}#${item.id}: tracker lifecycle policy is unknown; run from its project checkout or configure project tracker in your user config.`);
}

type PushContext = {
  targets: () => Item[];
  find: (ref: string) => Item;
  args: string[];
  values: { attach?: string; force?: boolean; detach?: boolean; yes?: boolean; "no-sync"?: boolean };
  json: boolean;
  emit: (data: unknown, text: string) => void;
  warn: (text: string) => void;
  io: Io;
  tracker: TrackerResolution;
  projectKey: string;
};

function pushCommand(db: Store, ctx: PushContext): number {
  const { values } = ctx;
  if ([values.attach !== undefined, values.force, values.detach].filter(Boolean).length > 1) throw new UsageError("--attach, --force, and --detach can't be combined.");
  const provider = ctx.tracker.kind === "ok" ? ctx.tracker.tracker.provider : "github";
  if (values.detach) {
    const results = ctx.targets().map((item) => {
      const link = db.call("detachLink", item, provider);
      return { id: item.id, detached: !!link, url: link?.url ?? undefined };
    });
    ctx.emit(results, results.map((row) => (row.detached ? `#${row.id}: detached${row.url ? ` (left ${row.url} as is)` : ""}` : `#${row.id}: no link`)).join("\n"));
    return 0;
  }
  if (ctx.tracker.kind === "invalid") throw new Error(`invalid tracker config: ${ctx.tracker.error}`);
  if (ctx.tracker.kind !== "ok") throw new Error(`${ctx.projectKey}: no tracker configured; add a "tracker" block to .tdo/config.json.`);
  const config = ctx.tracker.tracker;
  if (!isApproved(config)) {
    if (config.approval === "changed") ctx.warn("tdo: tracker config changed since you approved it.");
    if (!approve(config, ctx.projectKey, { io: ctx.io, warn: ctx.warn, yes: false, env: ctx.io.env })) throw new Cancelled();
  }
  db.call("expireStaleClaims", ctx.projectKey);
  if (values.attach !== undefined) {
    if (ctx.args.length !== 1) throw new UsageError("--attach takes exactly one item id.");
    const item = ctx.find(ctx.args[0]!);
    if (item.project !== ctx.projectKey) throw new Error(`#${item.id} belongs to ${item.project}; run tdo push from that project.`);
    const parsed = trackerFor(config.destination, ctx.io.env).parseIssueUrl(values.attach);
    if (!parsed) throw new UsageError(`not an issue URL: ${values.attach}`);
    const destination = item.links.find((link) => link.provider === provider)?.destination ?? config.destination;
    if (parsed.destination !== destination) throw new Error(`#${item.id} files to ${destination}; ${values.attach} is in ${parsed.destination}.`);
    const link = db.call("attachLink", item, provider, destination, parsed.id, values.attach.trim());
    ctx.emit([{ id: item.id, state: link.state, url: link.url, ok: true }], `#${item.id}: attached ${link.url}`);
    return 0;
  }
  const results: PushResult[] = [];
  for (const item of ctx.targets()) {
    // This project's tracker config only applies to this project's items.
    if (item.project !== ctx.projectKey) {
      results.push({ id: item.id, state: "skipped", error: `${item.project}#${item.id}: run tdo push from that project.`, ok: false });
      continue;
    }
    // Re-read so the link reflects stale-claim expiry and concurrent pushes.
    try {
      results.push(pushItem(db, db.call("findItem", `${item.project}#${item.id}`, ctx.projectKey), config, { force: values.force, noSync: values["no-sync"], env: ctx.io.env, warn: ctx.warn }));
    } catch (error) {
      results.push({ id: item.id, state: "skipped", error: `#${item.id}: ${(error as Error).message}`, ok: false });
    }
  }
  ctx.emit(results, results.map((row) => (row.ok ? `#${row.id}: ${row.url}` : row.error ?? `#${row.id}: ${row.state}`)).join("\n"));
  return results.every((row) => row.ok) ? 0 : 1;
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
  ["alt-n", "add query", "execute-silent($T add {q})+clear-query+reload($T _fzf feed $S)"],
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
    ...CURSOR_BINDS,
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
    process.exitCode = run(process.argv.slice(2), { out: (text) => console.log(text), cwd: process.cwd(), env: process.env, color: useColor(process.env, process.stdout.isTTY), interactive: tty && onPath("fzf", process.env), tty });
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
