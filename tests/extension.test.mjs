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

function harness({ selections = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdo-ext-"));
  process.env.TDO_DB = path.join(dir, "tdo.db");
  process.env.TDO_PROJECT = PROJECT;
  process.env.XDG_CONFIG_HOME = path.join(dir, "config");
  const handlers = new Map();
  const notifications = [];
  const statuses = new Map();
  const sent = [];
  const tools = [];
  let command;
  const pi = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); },
    registerTool(definition) { tools.push(definition); },
    registerCommand(_name, definition) { command = definition; },
    sendUserMessage(text, options) { sent.push({ text, options }); },
  };
  const ctx = {
    cwd: dir,
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getCwd: () => dir, getSessionId: () => "session-1" },
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
      setStatus(key, value) { statuses.set(key, value); },
      theme: { fg: (_color, text) => text },
      async select(_title, options) { const next = selections.shift(); return typeof next === "function" ? next(options) : next; },
    },
  };
  extension.default(pi);
  const emit = async (name, event = {}) => { for (const handler of handlers.get(name) || []) await handler(event, ctx); };
  const items = () => { const db = core.openDb(process.env.TDO_DB); try { return core.listItems(db, { status: "all" }); } finally { db.close(); } };
  const addDirect = (input) => { const db = core.openDb(process.env.TDO_DB); try { return core.addItem(db, { project: PROJECT, ...input }); } finally { db.close(); } };
  return { tools, command, ctx, emit, items, addDirect, notifications, statuses, sent };
}

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

test("/tdo quick-adds with inline priority and tags, and changes status by id", async () => {
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

  await h.command.handler("done #1 retried", h.ctx);
  assert.equal(h.items()[0].status, "done");
  assert.match(h.items()[0].body, /retried/);
  assert.equal(h.statuses.get("tdo"), undefined);

  await h.command.handler("show 1", h.ctx);
  assert.match(h.notifications.at(-1).message, /^#1 fix flaky login test/);

  await h.command.handler("done 99", h.ctx);
  assert.equal(h.notifications.at(-1).level, "error");
  // A non-numeric "id" is treated as a title, so "done later" is a valid item.
  await h.command.handler("done later", h.ctx);
  assert.ok(h.items().some((entry) => entry.title === "done later" && entry.status === "open"));
});

test("/tdo browse picks an item and can hand it to the agent", async () => {
  const h = harness({ selections: [(options) => options[0], "Work on it now"] });
  await h.command.handler("", h.ctx);
  assert.match(h.notifications.at(-1).message, /nothing open/);

  await h.command.handler("rename helpers #cleanup", h.ctx);
  await h.command.handler("", h.ctx);
  assert.equal(h.items()[0].status, "doing");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /Let's work on tdo item #1/);
  assert.match(h.sent[0].text, /tdo done 1 -m/);
});
