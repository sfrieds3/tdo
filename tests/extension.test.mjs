import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { execFileSync } from "node:child_process";

const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = requireFromPi("jiti");
const extension = await createJiti(import.meta.url).import("../extensions/tdo.ts");
const core = await import("../src/core.ts");

const PROJECT = "github.com/example/widgets";

function harness({ selections = [], keys = [], editorText, confirm = true, confirmations = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdo-ext-"));
  const dbPath = path.join(dir, "tdo.db");
  process.env.TDO_DB = dbPath;
  process.env.TDO_PROJECT = PROJECT;
  process.env.XDG_CONFIG_HOME = path.join(dir, "config");
  const handlers = new Map();
  const notifications = [];
  const dialogs = [];
  const statuses = new Map();
  const sent = [];
  const tools = [];
  const entries = [];
  const pickerTitles = [];
  let command;
  const pi = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); },
    registerTool(definition) { tools.push(definition); },
    registerCommand(_name, definition) { command = definition; },
    sendUserMessage(text, options) { sent.push({ text, options }); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  };
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const ctx = {
    cwd: dir,
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getCwd: () => dir, getSessionId: () => "session-1", getBranch: () => entries },
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
      setStatus(key, value) { statuses.set(key, value); },
      theme,
      async select(_title, options) { const next = selections.shift(); return typeof next === "function" ? next(options) : next; },
      async editor() { return editorText; },
      async confirm(title, message) { dialogs.push({ title, message }); const next = confirmations.length ? confirmations.shift() : confirm; return typeof next === "function" ? await next(title, message) : next; },
      // Drive the real picker component with queued keystrokes; an empty queue means esc.
      async custom(factory) {
        return new Promise((resolve) => {
          let finished = false;
          const done = (value) => { finished = true; resolve(value); };
          const component = factory({ requestRender() {} }, theme, {}, done);
          pickerTitles.push(component.render(80).join("\n"));
          for (const key of keys.shift() ?? ["\x1b"]) {
            if (finished) break;
            component.handleInput(key);
          }
          if (!finished) done(undefined);
        });
      },
    },
  };
  extension.default(pi);
  const emit = async (name, event = {}) => { let result; for (const handler of handlers.get(name) || []) result = await handler(event, ctx) ?? result; return result; };
  const items = () => { const db = core.openDb(dbPath); try { return core.listItems(db, { status: "all" }); } finally { db.close(); } };
  const addDirect = (input) => { const db = core.openDb(dbPath); try { return core.addItem(db, { project: PROJECT, ...input }); } finally { db.close(); } };
  const byTitle = (title) => items().find((item) => item.title === title);
  return { dir, dbPath, tools, command, ctx, emit, items, byTitle, addDirect, notifications, statuses, sent, entries, pickerTitles, dialogs };
}

const DOWN = "\x1b[B";
const ENTER = "\r";

test("registers no model-facing tool; agents use the CLI through the skill", () => {
  assert.deepEqual(harness().tools, []);
});

test("argument completions stay empty for a bare `/tdo ` so Enter opens the project picker", () => {
  const { command } = harness();
  assert.equal(command.getArgumentCompletions(""), null);
  assert.equal(command.getArgumentCompletions("  "), null);
  assert.deepEqual(command.getArgumentCompletions("--").map((item) => item.value), ["--all"]);
  assert.deepEqual(command.getArgumentCompletions("he").map((item) => item.value), ["help"]);
  assert.equal(command.getArgumentCompletions("fix"), null);
});

test("footer count refreshes on session start and after agent runs", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.equal(h.statuses.get("tdo"), undefined);
  // Simulate an agent adding items through the CLI during a run.
  h.addDirect({ title: "Handle empty config", priority: "high" });
  h.addDirect({ title: "Tidy logging", priority: "low" });
  await h.emit("agent_end");
  assert.equal(h.statuses.get("tdo"), "☑ 2 (1!)");
});

test("project resolution is nonblocking, awaited, and shared by concurrent extension calls", async (t) => {
  const saved = { ...process.env };
  const h = harness();
  const bin = path.join(h.dir, "bin");
  const marker = path.join(h.dir, "git-started");
  const release = path.join(h.dir, "git-release");
  const calls = path.join(h.dir, "git-calls");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(4).join(' ');
fs.appendFileSync(${JSON.stringify(calls)}, args + '\\n');
if (args === 'rev-parse --show-toplevel') {
  fs.writeFileSync(${JSON.stringify(marker)}, 'ready');
  const timeout = setTimeout(() => process.exit(1), 2000);
  const poll = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(release)})) return;
    clearInterval(poll); clearTimeout(timeout);
    console.log(${JSON.stringify(h.dir)});
  }, 10);
} else if (args === 'remote') console.log('origin');
else if (args === 'remote get-url origin') console.log('https://${PROJECT}.git');
`, { mode: 0o755 });
  delete process.env.TDO_PROJECT;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(h.dir, { recursive: true, force: true });
  });
  const status = h.emit("session_start");
  const add = h.command.handler("await project !high", h.ctx);
  const browse = h.command.handler("", h.ctx);
  try {
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(marker), "git has started while the event loop remains responsive");
    assert.equal(h.statuses.size, 0, "footer waits for resolution");
    assert.equal(h.notifications.length, 0, "commands wait for resolution");
    assert.equal(fs.existsSync(h.dbPath), false, "no store operations before resolution");
    assert.equal(fs.readFileSync(calls, "utf8"), "rev-parse --show-toplevel\n", "concurrent callers share one pending resolution");
  } finally {
    fs.writeFileSync(release, "go");
    await Promise.all([status, add, browse]);
  }
  assert.equal(h.byTitle("await project").project, PROJECT);
  assert.equal(h.statuses.get("tdo"), "☑ 1 (1!)");
  assert.match(h.notifications.find((entry) => entry.message.includes("added"))?.message, /added #1/);
  await h.emit("agent_end");
  assert.ok(fs.readFileSync(calls, "utf8").split("rev-parse --show-toplevel").length > 2, "later operations resolve fresh configuration rather than retaining stale consent context");
  const beforeSession = fs.readFileSync(calls, "utf8").trim().split("\n").length;
  await h.emit("session_start");
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, beforeSession + 3, "session start resolves fresh configuration");

  for (const transition of ["session_shutdown", "session_tree", "session_start"]) {
    fs.unlinkSync(release);
    fs.unlinkSync(marker);
    const refresh = h.emit("session_start");
    const staleAdd = h.command.handler(`stale ${transition}`, h.ctx);
    const staleBrowse = h.command.handler("", h.ctx);
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(marker));
    const changed = h.emit(transition);
    fs.writeFileSync(release, "go");
    await Promise.all([refresh, staleAdd, staleBrowse, changed]);
    assert.equal(h.byTitle(`stale ${transition}`), undefined, "old commands must not write after a lifecycle change");
  }
});

test("failed project resolution is evicted so commands can retry after config repair", async () => {
  const h = harness();
  const configDir = path.join(h.dir, "config", "tdo");
  fs.mkdirSync(configDir, { recursive: true });
  const config = path.join(configDir, "config.json");
  fs.writeFileSync(config, "{ nope");
  await h.command.handler("not saved", h.ctx);
  assert.equal(h.notifications.at(-1).level, "error");
  assert.match(h.notifications.at(-1).message, /invalid JSON/);
  assert.equal(h.items().length, 0);
  fs.writeFileSync(config, "{}");
  await h.command.handler("saved after repair", h.ctx);
  assert.equal(h.byTitle("saved after repair").project, PROJECT);
});

test("/tdo quick-adds with inline priority and tags", async () => {
  const h = harness();
  await h.command.handler("fix flaky login test !urgent #ci", h.ctx);
  const [item] = h.items();
  assert.equal(item.title, "fix flaky login test");
  assert.equal(item.priority, "urgent");
  assert.deepEqual(item.tags, ["ci"]);
  assert.equal(item.source, "user");
  assert.equal(item.sessionId, "session-1");
  assert.match(h.notifications.at(-1).message, /^tdo: added #1/);
  assert.equal(h.statuses.get("tdo"), "☑ 1 (1!)");
  // Old status verbs are gone from the command; they are just titles now.
  await h.command.handler("done later", h.ctx);
  assert.equal(h.byTitle("done later")?.status, "open");
});

test("/tdo picker: enter works on an item and shows it in the footer until it closes", async () => {
  const h = harness({ keys: [[DOWN, ENTER]] });
  await h.command.handler("", h.ctx);
  assert.match(h.notifications.at(-1).message, /nothing open/);

  await h.command.handler("rename helpers #cleanup", h.ctx);
  await h.command.handler("crash on empty input !urgent", h.ctx);
  await h.command.handler("", h.ctx);
  assert.match(h.pickerTitles.at(-1), /enter work on it · e edit · p priority · x done · d delete/);
  assert.equal(h.byTitle("rename helpers").status, "doing");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /Let's work on tdo item #1/);
  assert.match(h.sent[0].text, /tdo done 1 -m/);
  assert.doesNotMatch(h.sent[0].text, /worktree/);
  assert.equal(h.statuses.get("tdo"), "☑ 2 (1!) ▸ #1 rename helpers");

  // A reload restores the focus from the session branch.
  await h.emit("session_start");
  assert.equal(h.statuses.get("tdo"), "☑ 2 (1!) ▸ #1 rename helpers");

  // The agent closes it through the CLI; the footer drops the focus after the run.
  const db = core.openDb(process.env.TDO_DB);
  core.setStatus(db, h.byTitle("rename helpers"), "done");
  db.close();
  await h.emit("agent_end");
  assert.equal(h.statuses.get("tdo"), "☑ 1 (1!)");
  assert.deepEqual(h.entries.at(-1), { type: "custom", customType: "tdo-focus", data: null });
});

test("/tdo picker keys edit, re-prioritize, close, and delete, then reopen the picker", async () => {
  const h = harness({
    keys: [["e"], ["p"], [DOWN, "x"], [DOWN, "d"], []],
    editorText: "rename helpers in utils\n\nmatch house style",
    selections: ["urgent"],
  });
  await h.command.handler("rename helpers", h.ctx);
  await h.command.handler("tidy logging !low", h.ctx);
  await h.command.handler("scratch idea !low", h.ctx);
  await h.command.handler("", h.ctx);
  const edited = h.items().find((item) => item.id === 1);
  assert.equal(edited.title, "rename helpers in utils");
  assert.equal(edited.body, "match house style");
  assert.equal(edited.priority, "urgent");
  assert.equal(h.byTitle("tidy logging").status, "done");
  assert.equal(h.byTitle("scratch idea"), undefined, "d deleted the selected item");
  assert.match(h.notifications.at(-1).message, /deleted #3 scratch idea/);
  assert.equal(h.statuses.get("tdo"), "☑ 1 (1!)", "the footer drops the deleted item");
  assert.equal(h.sent.length, 0);
});

test("Pi picker discloses overflow only when more than 200 items match", async () => {
  const h = harness();
  const db = core.openDb(h.dbPath);
  try {
    for (let i = 1; i <= 200; i++) core.addItem(db, { project: PROJECT, title: `item ${i}` });
  } finally { db.close(); }
  await h.command.handler("", h.ctx);
  assert.equal(h.notifications.length, 0, "exactly 200 is complete");
  assert.match(h.pickerTitles.at(-1), /\(200\)/);
  h.addDirect({ title: "overflow" });
  await h.command.handler("", h.ctx);
  assert.equal(h.notifications.at(-1).level, "warning");
  assert.match(h.notifications.at(-1).message, /first 200 active items.*tdo ls -n 0/);
  assert.match(h.pickerTitles.at(-1), /\(200\+\)/);
  await h.command.handler("--all", h.ctx);
  assert.match(h.notifications.at(-1).message, /tdo ls -a -n 0/);
  h.ctx.hasUI = false;
  const before = h.notifications.length;
  await h.command.handler("", h.ctx);
  assert.equal(h.notifications[before].level, "warning", "non-UI browsing also discloses truncation");
  assert.equal(h.notifications.at(-1).message.split("\n").length, 200);
});

test("/tdo --all browses every project with project-qualified ids", async () => {
  const h = harness({ keys: [[]] });
  h.addDirect({ title: "here" });
  h.addDirect({ project: "github.com/example/gadgets", title: "elsewhere" });
  await h.command.handler("--all", h.ctx);
  assert.match(h.pickerTitles.at(-1), /all projects \(2\)/);
  assert.match(h.pickerTitles.at(-1), /gadgets#1 +normal +elsewhere/);
});

/** A fake transport only: all protocol handling and database work use the real CLI. */
function remoteHarness(t, options) {
  const saved = { ...process.env };
  const h = harness(options);
  const bin = path.join(h.dir, "bin");
  fs.mkdirSync(bin);
  const marker = path.join(h.dir, "ready");
  fs.writeFileSync(path.join(bin, "ssh"), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const input = fs.readFileSync(0);
if (process.env.TDO_TEST_FAIL === '1' || process.env.TDO_TEST_FAIL === JSON.parse(input).operation) { console.error('offline'); process.exit(255); }
const result = spawnSync(process.execPath, [${JSON.stringify(new URL("../src/cli.ts", import.meta.url).pathname)}, 'internal-rpc'], { input, encoding: 'utf8' });
if (process.env.TDO_TEST_DELAY) fs.writeFileSync(${JSON.stringify(marker)}, 'ready');
setTimeout(() => {
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exitCode = result.status ?? 1;
}, Number(process.env.TDO_TEST_DELAY || 0));
`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.TDO_DB = `ssh://test-alias${h.dbPath}`;
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(h.dir, { recursive: true, force: true });
  });
  const waitForResponse = async () => {
    for (let i = 0; i < 500; i++) {
      if (fs.existsSync(marker)) { fs.unlinkSync(marker); return; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("fake SSH did not prepare a response");
  };
  return { ...h, waitForResponse };
}

test("SSH extension quick-add, footer, and work instructions await writes without blocking Pi", async (t) => {
  const h = remoteHarness(t, { keys: [[ENTER]] });
  await h.emit("session_start");
  process.env.TDO_TEST_DELAY = "150";
  let completed = false;
  const pending = h.command.handler("remote fix !high #ci", h.ctx).then(() => { completed = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(completed, false, "event loop runs while SSH is still pending");
  assert.equal(h.notifications.length, 0, "no premature success notification");
  await pending;
  delete process.env.TDO_TEST_DELAY;
  assert.equal(h.byTitle("remote fix").priority, "high");
  assert.deepEqual(h.byTitle("remote fix").tags, ["ci"]);
  assert.equal(h.statuses.get("tdo"), "☑ 1 (1!)");
  assert.match(h.notifications.at(-1).message, /added #1/);
  await h.command.handler("", h.ctx);
  assert.equal(h.byTitle("remote fix").status, "doing");
  assert.match(h.sent[0].text, /marked as doing/);
  assert.equal(h.statuses.get("tdo"), "☑ 1 (1!) ▸ #1 remote fix");
});

test("SSH picker edits, changes priority, closes and deletes through internal-rpc", async (t) => {
  const h = remoteHarness(t, {
    keys: [["e"], ["p"], [DOWN, "x"], [DOWN, "d"], []],
    editorText: "remote edited\n\nbody changed",
    selections: ["urgent"],
  });
  h.addDirect({ title: "first" });
  h.addDirect({ title: "close me", priority: "low" });
  h.addDirect({ title: "delete me", priority: "low" });
  await h.command.handler("", h.ctx);
  const edited = h.byTitle("remote edited");
  assert.equal(edited.body, "body changed");
  assert.equal(edited.priority, "urgent");
  assert.equal(h.byTitle("close me").status, "done");
  assert.equal(h.byTitle("delete me"), undefined);
  assert.equal(h.statuses.get("tdo"), "☑ 1 (1!)");
});

test("SSH failures preserve saved focus and recover; only a successful absent lookup clears it", async (t) => {
  const h = remoteHarness(t, { keys: [[ENTER]] });
  h.addDirect({ title: "keep focus" });
  await h.command.handler("", h.ctx);
  const entryCount = h.entries.length;
  process.env.TDO_TEST_FAIL = "1";
  await h.emit("agent_end");
  assert.equal(h.statuses.get("tdo"), "☑ unavailable");
  assert.equal(h.entries.length, entryCount);
  assert.equal(h.notifications.length, 0, "background refresh errors stay quiet");
  await h.command.handler("not saved", h.ctx);
  assert.equal(h.byTitle("not saved"), undefined);
  assert.equal(h.notifications.at(-1).level, "error");
  await h.emit("session_tree");
  assert.equal(h.entries.length, entryCount);
  process.env.TDO_TEST_FAIL = "getItem";
  await h.emit("agent_end");
  assert.equal(h.statuses.get("tdo"), "☑ unavailable", "failed focus lookup is not an absent item");
  assert.equal(h.entries.length, entryCount);
  delete process.env.TDO_TEST_FAIL;
  await h.emit("agent_end");
  assert.match(h.statuses.get("tdo"), /▸ #1 keep focus/);
  const db = core.openDb(h.dbPath);
  core.deleteItem(db, h.byTitle("keep focus"));
  db.close();
  await h.emit("agent_end");
  assert.equal(h.statuses.get("tdo"), undefined);
  assert.equal(h.entries.at(-1).data, null);
});

test("pending SSH work cannot focus or message a different session branch", async (t) => {
  const h = remoteHarness(t, { keys: [[ENTER], [ENTER]] });
  h.addDirect({ title: "old branch item" });
  await h.emit("session_start");
  const originalCustom = h.ctx.ui.custom;
  let workStarted;
  h.ctx.ui.custom = async (factory) => {
    const picked = await originalCustom(factory);
    process.env.TDO_TEST_DELAY = "350";
    workStarted();
    return picked;
  };
  for (const transition of ["session_tree", "session_start"]) {
    const selected = new Promise((resolve) => { workStarted = resolve; });
    const pending = h.command.handler("", h.ctx);
    await selected;
    await h.waitForResponse(); // setStatus committed, but its reply is still in flight
    delete process.env.TDO_TEST_DELAY;
    h.entries.length = 0;
    if (transition === "session_start") await h.emit("session_shutdown");
    await h.emit(transition);
    await pending;
    assert.equal(h.entries.length, 0, "old work must not append focus to the new branch");
    assert.equal(h.sent.length, 0, "old work must not message the new session");
  }
});

test("older SSH refreshes cannot overwrite newer results or repopulate status after shutdown", async (t) => {
  const h = remoteHarness(t);
  h.addDirect({ title: "one" });
  await h.emit("session_start");
  process.env.TDO_TEST_DELAY = "300";
  const old = h.emit("agent_end");
  await h.waitForResponse();
  delete process.env.TDO_TEST_DELAY;
  h.addDirect({ title: "two" });
  await h.emit("agent_end");
  assert.equal(h.statuses.get("tdo"), "☑ 2");
  await old;
  assert.equal(h.statuses.get("tdo"), "☑ 2");
  process.env.TDO_TEST_DELAY = "150";
  const shutdownPending = h.emit("agent_end");
  await h.waitForResponse();
  await h.emit("session_shutdown");
  await shutdownPending;
  assert.equal(h.statuses.get("tdo"), undefined);
});

test("/tdo picker: config worktree asks the agent to work in a new worktree and branch", async () => {
  const h = harness({ keys: [[ENTER]] });
  fs.mkdirSync(path.join(h.dir, "config", "tdo"), { recursive: true });
  fs.writeFileSync(path.join(h.dir, "config", "tdo", "config.json"), JSON.stringify({ worktree: true }));
  await h.command.handler("split the parser", h.ctx);
  await h.command.handler("", h.ctx);
  assert.equal(h.sent.length, 1);
  assert.ok(h.sent[0].text.includes(extension.WORKTREE_INSTRUCTION));
  assert.match(h.sent[0].text, /tdo done 1 -m/);
});


function trackerHarness(t, options = {}) {
  const saved = { ...process.env };
  const h = harness(options);
  t.after(() => { process.env = saved; fs.rmSync(h.dir, { recursive: true, force: true }); });
  h.config = path.join(process.env.XDG_CONFIG_HOME, "tdo", "config.json");
  fs.mkdirSync(path.dirname(h.config), { recursive: true });
  fs.writeFileSync(h.config, JSON.stringify({ projects: { [PROJECT]: { tracker: { provider: "github", mode: "auto-on-tag", closeOnDone: false } } } }));
  const bin = path.join(h.dir, "bin");
  fs.mkdirSync(bin);
  h.log = path.join(h.dir, "gh.log");
  process.env.GH_LOG = h.log;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  fs.writeFileSync(path.join(bin, "gh"), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'auth') process.exit(0);
if (process.argv[3] === 'create') console.log('https://github.com/example/widgets/issues/42');
`, { mode: 0o755 });
  h.calls = () => fs.existsSync(h.log) ? fs.readFileSync(h.log, "utf8").trim().split("\n").map(JSON.parse) : [];
  h.awaiting = (title = "agent item") => {
    const db = core.openDb(h.dbPath);
    try { return core.addItem(db, { project: PROJECT, title, tags: ["issue"], source: "pi" }, { provider: "github", destination: PROJECT, tag: "issue", authorized: false }); }
    finally { db.close(); }
  };
  return h;
}
const bashCall = (id, command) => ({ toolName: "bash", toolCallId: id, input: { command } });
const bashResult = (id, command, text = "awaiting-approval") => ({ ...bashCall(id, command), content: [{ type: "text", text }], isError: false });

test("Pi guard requires confirmation for supported flags and basic quoted subcommands", async (t) => {
  const h = trackerHarness(t, { confirm: false });
  const commands = ["tdo push 1", "tdo --json push 1", "tdo tracker approve --yes", "tdo tracker --yes approve", "tdo tracker --json approve --yes", `tdo 'tracker' --yes "approve"`, `tdo "push" 1`];
  for (const command of commands) {
    assert.equal((await h.emit("tool_call", bashCall(command, command))).block, true, command);
    assert.equal(h.dialogs.at(-1).message, command);
  }
  assert.equal(h.dialogs.length, commands.length);
  h.ctx.hasUI = false;
  for (const command of commands) assert.equal((await h.emit("tool_call", bashCall(command, command))).block, true, command);
  assert.equal(h.dialogs.length, commands.length, "no UI means no prompt or authorization");
  h.ctx.hasUI = true;
  h.ctx.ui.confirm = async () => { throw new Error("UI closed"); };
  assert.equal((await h.emit("tool_call", bashCall("4", "tdo push 1"))).block, true);
  assert.equal(await h.emit("tool_call", bashCall("5", "tdo ls")), undefined);
});

test("Pi footer counts awaiting including closed items, and does not repopulate after shutdown", async (t) => {
  const h = trackerHarness(t);
  const item = h.awaiting();
  const db = core.openDb(h.dbPath); core.setStatus(db, item, "done"); db.close();
  await h.emit("session_start");
  assert.equal(h.statuses.get("tdo"), "1 awaiting");
  await h.emit("session_shutdown");
  await h.emit("agent_end");
  assert.equal(h.statuses.get("tdo"), undefined);
});

test("Pi quick add uses human auto intent and async worker; editor/done reuse PR2 lifecycle with closeOnDone false", async (t) => {
  const h = trackerHarness(t, { keys: [["e"], ["x"], []], editorText: "edited title\n\nnew body" });
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 0);
  await h.command.handler("human #issue", h.ctx);
  clearTimeout(timer);
  assert.equal(ticked, true);
  assert.equal(h.items()[0].links[0].state, "open", JSON.stringify(h.notifications));
  await h.command.handler("", h.ctx);
  assert.equal(h.items()[0].status, "done");
  assert.equal(h.items()[0].links[0].queued, 0);
  assert.equal(h.calls().filter((args) => args[1] === "create").length, 1);
  assert.equal(h.calls().filter((args) => args[1] === "edit").length, 1);
  assert.equal(h.calls().filter((args) => args[1] === "close").length, 0);
});

test("Pi agent result prompts only verified new matching awaiting items; output IDs are not authority", async (t) => {
  const h = trackerHarness(t);
  const command = 'tdo add "agent item #issue" --source pi --json';
  await h.emit("tool_call", bashCall("add", command));
  const item = h.awaiting();
  await h.emit("tool_result", bashResult("add", command, '{"id":999,"links":[{"state":"awaiting-approval"}]}'));
  assert.equal(h.items()[0].links[0].state, "open", JSON.stringify(h.notifications));
  assert.match(h.dialogs[0].title, new RegExp(`File #${item.id}.*github.com/example/widgets`));
  assert.equal(h.calls().filter((args) => args[1] === "create").length, 1);
  await h.emit("tool_result", bashResult("add", command));
  assert.equal(h.dialogs.length, 1);
});

for (const consent of [true, false]) {
  test(`Pi offers consent for each CLI item in an AND-list (accept=${consent})`, async (t) => {
    const h = trackerHarness(t, { confirm: consent });
    fs.symlinkSync(path.resolve("src/cli.ts"), path.join(h.dir, "bin", "tdo"));
    const command = 'tdo add "first item" -t issue -b "Keep local; ask before filing." --source pi --json && tdo add "second item" -t issue --source pi --json';
    await h.emit("tool_call", bashCall("batch", command));
    const output = execFileSync("bash", ["-c", command], { cwd: h.dir, env: { ...process.env }, encoding: "utf8" });
    assert.equal(h.calls().filter((args) => args[1] === "create").length, 0);
    await h.emit("tool_result", bashResult("batch", command, output));
    assert.equal(h.dialogs.length, 2, JSON.stringify({ items: h.items(), notifications: h.notifications, output }));
    for (const item of h.items()) {
      assert.ok(h.dialogs.some((dialog) => dialog.title.includes(`File #${item.id} `) && dialog.message === item.title));
      assert.equal(item.links[0].state, consent ? "open" : "awaiting-approval");
    }
    assert.equal(h.calls().filter((args) => args[1] === "create").length, consent ? 2 : 0);
    await h.emit("tool_result", bashResult("batch", command, output));
    assert.equal(h.dialogs.length, 2, "replayed results do not repeat prompts");
  });
}

test("Pi verifies partial AND-list success without relying on output hints", async (t) => {
  const h = trackerHarness(t, { confirm: false });
  h.awaiting("existing");
  const command = 'tdo add existing -t issue && tdo add "new item" -t issue && tdo add missing -t issue';
  await h.emit("tool_call", bashCall("partial", command));
  const item = h.awaiting("new item");
  h.awaiting("unrelated");
  await h.emit("tool_result", { ...bashResult("partial", command, "output truncated"), isError: true });
  assert.equal(h.dialogs.length, 1);
  assert.match(h.dialogs[0].title, new RegExp(`File #${item.id} `));
  assert.equal(h.calls().length, 0);
});

test("Pi handles nested bash mutations from codemode exactly once", async (t) => {
  const h = trackerHarness(t, { confirm: false });
  const command = 'tdo add "agent item" -t issue';
  const outer = { toolName: "codemode", toolCallId: "outer", input: { code: `await tools.bash({command: ${JSON.stringify(command)}})` } };
  const inner = { ...bashCall("outer/1", command), parentToolCallId: "outer" };
  await h.emit("tool_call", outer);
  await h.emit("tool_call", inner);
  h.awaiting();
  await h.emit("tool_result", { ...bashResult(inner.toolCallId, command, ""), parentToolCallId: "outer" });
  await h.emit("tool_result", { ...outer, content: [{ type: "text", text: "awaiting-approval" }], isError: false });
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.calls().length, 0);
});

test("Pi treats quoted shell operators as literal item text", async (t) => {
  const h = trackerHarness(t, { confirm: false });
  const command = 'tdo add "handle && and ; literally" -t issue -b "a | b > c"';
  await h.emit("tool_call", bashCall("quoted", command));
  h.awaiting("handle && and ; literally");
  await h.emit("tool_result", bashResult("quoted", command));
  assert.equal(h.dialogs.length, 1);
});

test("Pi rejects mixed scripts, overrides, expansions, and malformed AND-lists", async (t) => {
  const h = trackerHarness(t, { confirm: false });
  const commands = [
    'cd elsewhere && tdo add new', 'tdo add new && cd elsewhere',
    'tdo add new && tdo add other --db /tmp/other', 'tdo add new --project foreign',
    'tdo add new --config /tmp/config', 'tdo add new -C elsewhere',
    'TDO_DB=x tdo add new', 'tdo add new && TDO_PROJECT=x tdo add other',
    'tdo add new; tdo add other', 'tdo add new || tdo add other', 'tdo add new | cat',
    'tdo add new > output', 'tdo add "$TITLE"', 'tdo add "`echo new`"',
    'tdo add $(echo new)', 'tdo add ne\\w', 'tdo add ne"w"',
    'tdo add new &&', '&& tdo add new', 'tdo add "new',
    'tdo add new\ntdo add other', 'tdo add new # comment && tdo add other',
    'tdo add new *', 'tdo add [ab]', 'tdo add new {a,b}', 'tdo add new & tdo add other',
  ];
  for (const [index, command] of commands.entries()) {
    await h.emit("tool_call", bashCall(String(index), command));
    h.awaiting("new");
    await h.emit("tool_result", bashResult(String(index), command));
    assert.equal(h.dialogs.length, 0, command);
  }
  assert.equal(h.calls().length, 0);
});

test("Pi rejects a result whose command differs from the captured call", async (t) => {
  const h = trackerHarness(t, { confirm: false });
  await h.emit("tool_call", bashCall("changed", "tdo add new -t issue"));
  h.awaiting("new");
  await h.emit("tool_result", bashResult("changed", "tdo add other -t issue"));
  assert.equal(h.dialogs.length, 0);
});

test("Pi stops batch prompts after session navigation during consent", async (t) => {
  const h = trackerHarness(t, { confirmations: [async () => {
    await h.emit("session_tree");
    return true;
  }] });
  const command = 'tdo add first -t issue && tdo add second -t issue';
  await h.emit("tool_call", bashCall("navigate", command));
  h.awaiting("first");
  h.awaiting("second");
  await h.emit("tool_result", bashResult("navigate", command));
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.calls().length, 0);
  assert.ok(h.items().every((item) => item.links[0].state === "awaiting-approval"));
});

test("Pi does not prompt for already-filed or untagged items", async (t) => {
  const h = trackerHarness(t);
  const command = 'tdo add filed -t issue && tdo add local';
  await h.emit("tool_call", bashCall("linked", command));
  const item = h.awaiting("filed");
  const db = core.openDb(h.dbPath);
  core.attachLink(db, item, "github", PROJECT, "42", "https://github.com/example/widgets/issues/42");
  db.close();
  h.addDirect({ title: "local", source: "pi" });
  await h.emit("tool_result", bashResult("linked", command));
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.calls().length, 0);
});

test("Pi ignores forged results, existing awaiting items, foreign overrides, and noninteractive adds", async (t) => {
  const h = trackerHarness(t);
  h.awaiting();
  await h.emit("tool_result", bashResult("forged", "tdo add anything"));
  await h.emit("tool_call", bashCall("existing", 'tdo add "agent item #issue"'));
  await h.emit("tool_result", bashResult("existing", 'tdo add "agent item #issue"'));
  for (const command of ['cd elsewhere && tdo add other', 'tdo add other --db /tmp/other', 'tdo add other --project foreign', 'TDO_DB=x tdo add other', 'tdo add other -C elsewhere']) {
    await h.emit("tool_call", bashCall(command, command));
    await h.emit("tool_result", bashResult(command, command));
  }
  h.ctx.hasUI = false;
  await h.command.handler("script #issue", h.ctx);
  assert.equal(h.byTitle("script").links[0].state, "awaiting-approval");
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.calls().length, 0);
});

test("Pi deduplicates concurrent result dialogs and revalidates item/config after confirmation", async (t) => {
  const h = trackerHarness(t, { confirmations: [async () => {
    const db = core.openDb(h.dbPath); core.updateItem(db, h.items()[0], { title: "changed while waiting" }); db.close();
    return true;
  }] });
  const command = 'tdo add "agent item #issue"';
  await h.emit("tool_call", bashCall("a", command));
  await h.emit("tool_call", bashCall("b", command));
  h.awaiting();
  await Promise.all([h.emit("tool_result", bashResult("a", command)), h.emit("tool_result", bashResult("b", command))]);
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.calls().length, 0);
  assert.equal(h.items()[0].links[0].state, "awaiting-approval");
});

test("Pi picker cannot consent on another project's behalf", async (t) => {
  const h = trackerHarness(t, { keys: [[DOWN, "g"], []] });
  h.addDirect({ title: "here" });
  h.addDirect({ project: "github.com/example/foreign", title: "foreign" });
  await h.command.handler("--all", h.ctx);
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.calls().length, 0);
});


function repoTracker(h) {
  execFileSync("git", ["init", "-q", h.dir]);
  fs.mkdirSync(path.join(h.dir, ".tdo"));
  fs.writeFileSync(path.join(h.dir, ".tdo", "config.json"), JSON.stringify({ project: PROJECT, tracker: { provider: "github", mode: "auto-on-tag" } }));
}

test("Pi project approval and item consent are separate, with exact config details and no filing on item refusal", async (t) => {
  const h = trackerHarness(t, { keys: [["g"], []], confirmations: [true, false] });
  repoTracker(h);
  h.awaiting();
  await h.command.handler("", h.ctx);
  assert.equal(h.dialogs.length, 2);
  assert.match(h.dialogs[0].title, /Approve project/);
  for (const detail of ["provider: github", `destination: ${PROJECT}`, "mode: auto-on-tag", "tag: #issue", "labels: none", "closeOnDone: false"]) assert.ok(h.dialogs[0].message.includes(detail), detail);
  assert.match(h.dialogs[1].title, /File #1/);
  assert.match(JSON.parse(fs.readFileSync(h.config)).projects[PROJECT].tracker.approved, /^sha256:/);
  assert.equal(h.calls().length, 0);
  assert.equal(h.items()[0].links[0].state, "awaiting-approval");
});

test("Pi revalidates changed repo approval and does not persist stale consent", async (t) => {
  let h;
  h = trackerHarness(t, { keys: [["g"], []], confirmations: [async () => {
    fs.writeFileSync(path.join(h.dir, ".tdo", "config.json"), JSON.stringify({ project: PROJECT, tracker: { provider: "github", repo: "foreign/repo" } }));
    return true;
  }] });
  repoTracker(h);
  h.awaiting();
  await h.command.handler("", h.ctx);
  assert.equal(JSON.parse(fs.readFileSync(h.config)).projects[PROJECT].tracker.approved, undefined);
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.calls().length, 0);
});

test("Pi confirmation names a link's persisted repo rather than the current config destination", async (t) => {
  const h = trackerHarness(t, { keys: [["g"], []], confirm: false });
  h.awaiting();
  const config = JSON.parse(fs.readFileSync(h.config));
  config.projects[PROJECT].tracker.repo = "other/repo";
  fs.writeFileSync(h.config, JSON.stringify(config));
  await h.command.handler("", h.ctx);
  assert.match(h.dialogs[0].title, /github.com\/example\/widgets/);
  assert.doesNotMatch(h.dialogs[0].title, /other\/repo/);
  assert.equal(h.calls().length, 0);
});

test("Pi serializes guard dialogs and rejects confirmation after session navigation", async (t) => {
  let release;
  let inDialog = 0;
  let maxDialogs = 0;
  const h = trackerHarness(t, { confirmations: [async () => {
    inDialog++; maxDialogs = Math.max(maxDialogs, inDialog);
    await new Promise((resolve) => { release = resolve; });
    inDialog--; return true;
  }, async () => { inDialog++; maxDialogs = Math.max(maxDialogs, inDialog); inDialog--; return true; }] });
  const first = h.emit("tool_call", bashCall("a", "tdo push 1"));
  const second = h.emit("tool_call", bashCall("b", "tdo tracker approve"));
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  await h.emit("session_tree");
  release();
  assert.equal((await first).block, true);
  assert.equal((await second).block, true);
  assert.equal(maxDialogs, 1);
  assert.equal(h.dialogs.length, 1);
});

test("Pi linked done drains asynchronously and tracker failures never fail the local mutation", async (t) => {
  const h = trackerHarness(t, { keys: [["x"], []] });
  const config = JSON.parse(fs.readFileSync(h.config)); config.projects[PROJECT].tracker.closeOnDone = true;
  fs.writeFileSync(h.config, JSON.stringify(config));
  await h.command.handler("human #issue", h.ctx);
  const gh = path.join(h.dir, "bin", "gh");
  fs.writeFileSync(gh, `#!${process.execPath}\nconsole.error('network offline'); process.exit(1);\n`, { mode: 0o755 });
  await h.command.handler("", h.ctx);
  const [item] = h.items();
  assert.equal(item.status, "done");
  assert.equal(item.links[0].queued, 1);
  assert.ok(h.notifications.some((note) => note.message.includes("local change saved")));
  assert.ok(h.notifications.some((note) => note.message.includes("done #1")));
});

test("Pi RPC quick-add cannot manufacture human provenance even when dialogs are available", async (t) => {
  const h = trackerHarness(t);
  h.ctx.mode = "rpc";
  await h.command.handler("rpc item #issue", h.ctx);
  const [item] = h.items();
  assert.equal(item.links[0].state, "awaiting-approval");
  const db = core.openDb(h.dbPath);
  assert.equal(db.prepare("SELECT created_by_human AS human FROM items WHERE id = ?").get(item.id).human, 0);
  db.close();
  assert.equal(h.calls().length, 0);
});

test("Pi awaiting edit prompts from verified command target, not output IDs", async (t) => {
  const h = trackerHarness(t, { confirm: false });
  const item = h.addDirect({ title: "existing agent", source: "pi" });
  const command = `tdo edit ${item.id} -t issue --json`;
  await h.emit("tool_call", bashCall("edit", command));
  const db = core.openDb(h.dbPath);
  core.updateItem(db, item, { addTags: ["issue"] }, { provider: "github", destination: PROJECT, tag: "issue", authorized: true });
  db.close();
  await h.emit("tool_result", bashResult("edit", command, '{"id":999,"links":[{"state":"awaiting-approval"}]}'));
  assert.equal(h.dialogs.length, 1);
  assert.match(h.dialogs[0].title, /File #1/);
  assert.equal(h.items()[0].links[0].state, "awaiting-approval");
  assert.equal(h.calls().length, 0);
});


test("Pi worker preserves a relative caller config path when session cwd differs", async (t) => {
  const h = trackerHarness(t);
  process.env.TDO_CONFIG = path.relative(process.cwd(), h.config);
  await h.command.handler("relative config #issue", h.ctx);
  assert.equal(h.items()[0].links[0].state, "open", JSON.stringify(h.notifications));
  assert.equal(h.calls().filter((args) => args[1] === "create").length, 1);
});

for (const policy of [true, false, undefined, "approval-only", "invalid"]) {
  test(`Pi foreign linked done respects user lifecycle policy: ${policy}`, async (t) => {
    const h = trackerHarness(t, { keys: [["x"], []] });
    const foreign = "github.com/example/foreign";
    const item = h.addDirect({ project: foreign, title: "foreign linked" });
    const db = core.openDb(h.dbPath);
    core.attachLink(db, item, "github", foreign, "7", "url");
    db.close();
    const config = JSON.parse(fs.readFileSync(h.config));
    if (policy !== undefined) config.projects[foreign] = { tracker: policy === "approval-only" ? { provider: "github", approved: "missing-repo-hash" } : policy === "invalid" ? { provider: "oops" } : { provider: "github", closeOnDone: policy } };
    fs.writeFileSync(h.config, JSON.stringify(config));
    await h.command.handler("--all", h.ctx);
    const saved = h.items()[0];
    const known = typeof policy === "boolean";
    assert.equal(saved.status, known ? "done" : "open");
    assert.equal(saved.links[0].queued, policy === true ? 1 : 0);
    if (!known) assert.match(h.notifications.at(-1).message, /policy is unknown/);
    assert.equal(h.calls().length, 0, "foreign links never drain under checkout approval");
  });
}

test("Pi unknown foreign policy allows doing and nonlinked done", async (t) => {
  const h = trackerHarness(t, { keys: [[ENTER], [DOWN, "x"], []] });
  const foreign = "github.com/example/foreign";
  const linked = h.addDirect({ project: foreign, title: "linked" });
  const db = core.openDb(h.dbPath);
  core.attachLink(db, linked, "github", foreign, "7", "url");
  db.close();
  await h.command.handler("--all", h.ctx);
  assert.equal(h.items()[0].status, "doing");
  assert.equal(h.items()[0].links[0].queued, 0);
  const other = h.addDirect({ project: "github.com/example/plain", title: "unlinked", priority: "urgent" });
  await h.command.handler("--all", h.ctx);
  assert.equal(h.items().find((item) => item.projectId === other.projectId).status, "done");
  assert.equal(h.calls().length, 0);
});
