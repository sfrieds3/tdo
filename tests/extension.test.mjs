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
  assert.equal(h.statuses.get("tdo"), "tdo 2 (1!)");
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
  assert.equal(h.statuses.get("tdo"), "tdo 1 (1!)");
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
  assert.equal(h.statuses.get("tdo"), "tdo 2 (1!) ▸ #1 rename helpers");

  // A reload restores the focus from the session branch.
  await h.emit("session_start");
  assert.equal(h.statuses.get("tdo"), "tdo 2 (1!) ▸ #1 rename helpers");

  // The agent closes it through the CLI; the footer drops the focus after the run.
  const db = core.openDb(process.env.TDO_DB);
  core.setStatus(db, h.byTitle("rename helpers"), "done");
  db.close();
  await h.emit("agent_end");
  assert.equal(h.statuses.get("tdo"), "tdo 1 (1!)");
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
  assert.equal(h.statuses.get("tdo"), "tdo 1 (1!)");
  assert.match(h.notifications.at(-1).message, /added #1/);
  await h.command.handler("", h.ctx);
  assert.equal(h.byTitle("remote fix").status, "doing");
  assert.match(h.sent[0].text, /marked as doing/);
  assert.equal(h.statuses.get("tdo"), "tdo 1 (1!) ▸ #1 remote fix");
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
  assert.equal(h.statuses.get("tdo"), "tdo 1 (1!)");
});

test("SSH failures preserve saved focus and recover; only a successful absent lookup clears it", async (t) => {
  const h = remoteHarness(t, { keys: [[ENTER]] });
  h.addDirect({ title: "keep focus" });
  await h.command.handler("", h.ctx);
  const entryCount = h.entries.length;
  process.env.TDO_TEST_FAIL = "1";
  await h.emit("agent_end");
  assert.equal(h.statuses.get("tdo"), "tdo unavailable");
  assert.equal(h.entries.length, entryCount);
  assert.equal(h.notifications.length, 0, "background refresh errors stay quiet");
  await h.command.handler("not saved", h.ctx);
  assert.equal(h.byTitle("not saved"), undefined);
  assert.equal(h.notifications.at(-1).level, "error");
  await h.emit("session_tree");
  assert.equal(h.entries.length, entryCount);
  process.env.TDO_TEST_FAIL = "getItem";
  await h.emit("agent_end");
  assert.equal(h.statuses.get("tdo"), "tdo unavailable", "failed focus lookup is not an absent item");
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
  assert.equal(h.statuses.get("tdo"), "tdo 2");
  await old;
  assert.equal(h.statuses.get("tdo"), "tdo 2");
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

test("Pi guard requires confirmation, fails closed without UI or when confirmation fails", async (t) => {
  const h = trackerHarness(t, { confirm: false });
  assert.equal((await h.emit("tool_call", bashCall("1", "tdo push 1"))).block, true);
  assert.equal((await h.emit("tool_call", bashCall("2", "tdo tracker approve --yes"))).block, true);
  assert.equal(h.dialogs.length, 2);
  h.ctx.hasUI = false;
  assert.equal((await h.emit("tool_call", bashCall("3", "tdo --json push 1"))).block, true);
  assert.equal(h.dialogs.length, 2);
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
  fs.writeFileSync(path.join(h.dir, ".tdo", "config.json"), JSON.stringify({ tracker: { provider: "github", mode: "auto-on-tag" } }));
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
    fs.writeFileSync(path.join(h.dir, ".tdo", "config.json"), JSON.stringify({ tracker: { provider: "github", repo: "foreign/repo" } }));
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
