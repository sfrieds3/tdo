import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = requireFromPi("jiti");
const extension = await createJiti(import.meta.url).import("../extensions/tdo.ts");
const core = await import("../src/core.ts");

const PROJECT = "github.com/example/widgets";

function harness({ selections = [], keys = [], editorText, confirm = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdo-ext-"));
  const dbPath = path.join(dir, "tdo.db");
  process.env.TDO_DB = dbPath;
  process.env.TDO_PROJECT = PROJECT;
  process.env.XDG_CONFIG_HOME = path.join(dir, "config");
  const handlers = new Map();
  const notifications = [];
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
      async confirm() { return confirm; },
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
  const emit = async (name, event = {}) => { for (const handler of handlers.get(name) || []) await handler(event, ctx); };
  const items = () => { const db = core.openDb(dbPath); try { return core.listItems(db, { status: "all" }); } finally { db.close(); } };
  const addDirect = (input) => { const db = core.openDb(dbPath); try { return core.addItem(db, { project: PROJECT, ...input }); } finally { db.close(); } };
  const byTitle = (title) => items().find((item) => item.title === title);
  return { dir, dbPath, tools, command, ctx, emit, items, byTitle, addDirect, notifications, statuses, sent, entries, pickerTitles };
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
  assert.equal(h.sent.length, 0);
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
