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
  process.env.TDO_DB = path.join(dir, "tdo.db");
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
  const items = () => { const db = core.openDb(process.env.TDO_DB); try { return core.listItems(db, { status: "all" }); } finally { db.close(); } };
  const addDirect = (input) => { const db = core.openDb(process.env.TDO_DB); try { return core.addItem(db, { project: PROJECT, ...input }); } finally { db.close(); } };
  const byTitle = (title) => items().find((item) => item.title === title);
  return { tools, command, ctx, emit, items, byTitle, addDirect, notifications, statuses, sent, entries, pickerTitles };
}

const DOWN = "\x1b[B";
const ENTER = "\r";

test("registers no model-facing tool; agents use the CLI through the skill", () => {
  assert.deepEqual(harness().tools, []);
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
