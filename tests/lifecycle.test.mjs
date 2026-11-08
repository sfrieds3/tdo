import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import * as core from "../src/core.ts";
import * as queue from "../src/link-ops.ts";
import { createStore } from "../src/store.ts";
import { drainLink, drainItems } from "../src/trackers/drain.ts";
import { pushItem, syncProject } from "../src/trackers/sync.ts";

const PROJECT = "github.com/example/widgets";
const config = { provider: "github", destination: PROJECT, labels: [], approval: "user-only", closeOnDone: true };
const ok = { ok: true, value: undefined };
const failure = { ok: false, kind: "retryable", message: "offline" };
function fixture(t) {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const item = store.call("addItem", { project: PROJECT, title: "original", body: "body" });
  const link = store.call("attachLink", item, "github", PROJECT, "42", `https://${PROJECT}/issues/42`);
  return { store, item, link };
}
function recording(calls, result = ok) {
  return () => ({
    provider: "github",
    update: (id, issue) => { calls.push(["update", id, issue]); return result; },
    close: (id, reason) => { calls.push(["close", id, reason]); return result; },
    reopen: (id) => { calls.push(["reopen", id]); return result; },
    comment: (id, body) => { calls.push(["comment", id, body]); return result; },
  });
}
const ops = (db) => db.prepare("SELECT seq,op,note_seq,status,attempts FROM link_ops ORDER BY seq").all().map((row) => ({ ...row }));

test("item/note and intent roll back together when queue insertion fails", (t) => {
  const db = core.openDb(":memory:");
  t.after(() => db.close());
  const item = core.addItem(db, { project: PROJECT, title: "atomic" });
  core.attachLink(db, item, "github", PROJECT, "42", "url");
  db.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON link_ops BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END;");
  assert.throws(() => core.setStatus(db, item, "done", "must roll back"), /queue unavailable/);
  assert.equal(core.getItem(db, item).status, "open");
  assert.deepEqual(core.getItem(db, item).notes, []);
  assert.throws(() => core.updateItem(db, item, { title: "lost" }), /queue unavailable/);
  assert.equal(core.getItem(db, item).title, "atomic");
  assert.throws(() => core.addNote(db, item, "lost note"), /queue unavailable/);
  assert.deepEqual(core.getItem(db, item).notes, []);
});

test("updates coalesce only consecutively and without any lease; sequence survives acknowledgements", (t) => {
  const db = core.openDb(":memory:");
  t.after(() => db.close());
  const item = core.addItem(db, { project: PROJECT, title: "seq" });
  core.attachLink(db, item, "github", PROJECT, "42", "url");
  core.updateItem(db, item, { title: "one" });
  core.updateItem(db, item, { body: "two" });
  assert.deepEqual(ops(db).map((op) => [op.seq, op.op]), [[1, "update"]]);
  assert.equal(queue.leaseLinkOps(db, item, "github", "owner"), true);
  const inFlight = queue.nextLinkOp(db, item, "github", "owner");
  core.updateItem(db, item, { title: "three" });
  core.updateItem(db, item, { title: "four" });
  assert.deepEqual(ops(db).map((op) => op.seq), [1, 2, 3], "an in-flight update must not consume later edits");
  assert.equal(queue.ackOp(db, item, "github", "owner", inFlight.seq), true);
  assert.equal(queue.ackOp(db, item, "github", "owner", 3), false, "cannot skip the ordered head");
  queue.ackOp(db, item, "github", "owner", 2);
  queue.ackOp(db, item, "github", "owner", 3);
  queue.releaseLinkOps(db, item, "github", "owner");
  core.addNote(db, item, "barrier");
  core.updateItem(db, item, { title: "five" });
  core.addNote(db, item, "another barrier");
  core.updateItem(db, item, { title: "six" });
  assert.deepEqual(ops(db).map((op) => [op.seq, op.op]), [[4, "comment"], [5, "update"], [6, "comment"], [7, "update"]]);
});

test("competing connections, lease expiry and stale completion preserve queue ordering", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdo-leases-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = core.openDb(path.join(dir, "db")), other = core.openDb(path.join(dir, "db"));
  t.after(() => { db.close(); other.close(); });
  const item = core.addItem(db, { project: PROJECT, title: "compete" });
  core.attachLink(db, item, "github", PROJECT, "42", "url");
  core.setStatus(db, item, "done", "finished");
  assert.equal(queue.leaseLinkOps(db, item, "github", "first"), true);
  assert.equal(queue.leaseLinkOps(other, item, "github", "second"), false);
  assert.equal(queue.nextLinkOp(other, item, "github", "second"), undefined);
  assert.equal(queue.ackOp(other, item, "github", "second", 1), false);
  db.prepare("UPDATE links SET drain_until = '2000-01-01T00:00:00.000Z'").run();
  assert.equal(queue.nextLinkOp(db, item, "github", "first"), undefined, "expired owner cannot renew");
  assert.equal(queue.ackOp(db, item, "github", "first", 1), false);
  assert.equal(queue.failOp(db, item, "github", "first", 1, true, "late"), false);
  assert.equal(queue.releaseLinkOps(db, item, "github", "first"), false);
  assert.equal(queue.leaseLinkOps(other, item, "github", "second"), true);
  assert.equal(queue.releaseLinkOps(db, item, "github", "first"), false);
  assert.equal(queue.nextLinkOp(other, item, "github", "second").op, "comment");
  assert.equal(queue.ackOp(other, item, "github", "second", 1), true);
  assert.equal(queue.nextLinkOp(other, item, "github", "second").op, "close");
  assert.equal(queue.ackOp(other, item, "github", "second", 2), true);
  assert.equal(core.getLink(db, item, "github").state, "closed");
});

test("offline close then reopen preserves comments and finishes open", (t) => {
  const { store, item, link } = fixture(t);
  store.call("setStatus", item, "done", "fixed");
  const calls = [], warnings = [];
  drainLink(store, item, link, config, { tracker: recording(calls, failure), warn: (s) => warnings.push(s) });
  assert.equal(calls.length, 1, "failure blocks close");
  store.call("setStatus", item, "open", "actually not fixed");
  calls.length = 0;
  drainLink(store, item, link, config, { tracker: recording(calls), warn: (s) => warnings.push(s) });
  assert.deepEqual(calls.map((call) => call[0]), ["comment", "close", "comment", "reopen"]);
  assert.deepEqual(calls.filter((call) => call[0] === "comment").map((call) => call[2]), ["fixed", "actually not fixed"]);
  assert.equal(store.call("getLink", item, "github").state, "open");
  assert.equal(store.call("getLink", item, "github").queued, 0);
});

test("lifecycle ops follow status transitions, not target statuses", (t) => {
  const db = core.openDb(":memory:");
  t.after(() => db.close());
  const item = core.addItem(db, { project: PROJECT, title: "transitions" });
  core.attachLink(db, item, "github", PROJECT, "42", "url");
  core.setStatus(db, item, "doing");
  core.setStatus(db, item, "open");
  assert.deepEqual(ops(db), [], "active -> active never touches the issue");
  core.setStatus(db, item, "done");
  core.setStatus(db, item, "done");
  core.setStatus(db, item, "doing");
  assert.deepEqual(ops(db).map((op) => op.op), ["close", "reopen"], "done -> doing reopens; repeating done does not re-close");
  core.setStatus(db, item, "dropped");
  core.setStatus(db, item, "done");
  assert.deepEqual(ops(db).map((op) => op.op), ["close", "reopen", "close", "close"], "dropped -> done updates the close reason");
});

test("five retries become attention, block later ops, and require an explicit current-project reset", (t) => {
  const { store, item, link } = fixture(t);
  store.call("addNote", item, "retry this comment");
  store.call("setStatus", item, "done");
  const calls = [];
  const options = { tracker: recording(calls, failure), warn() {} };
  for (let i = 0; i < 9; i++) drainLink(store, item, link, config, options);
  assert.equal(calls.length, 5);
  assert.equal(store.call("getLink", item, "github").attention, 1);
  assert.equal(store.call("retryLinkOps", "another/project"), 0);
  assert.equal(store.call("retryLinkOps", PROJECT), 1);
  calls.length = 0;
  drainLink(store, item, link, config, { tracker: recording(calls), warn() {} });
  assert.deepEqual(calls.map((call) => call[0]), ["comment", "close"]);
  assert.equal(store.call("getLink", item, "github").state, "closed");
});

test("permission failure blocks immediately; revoked approval never leases or sends", (t) => {
  const { store, item, link } = fixture(t);
  store.call("updateItem", item, { title: "permission" });
  const calls = [];
  drainLink(store, item, link, { ...config, approval: "changed" }, { tracker: recording(calls), warn() {} });
  assert.equal(calls.length, 0);
  drainLink(store, item, link, config, { tracker: recording(calls, { ok: false, kind: "attention", message: "permission denied" }), warn() {} });
  assert.equal(calls.length, 1);
  assert.equal(store.call("getLink", item, "github").attention, 1);
  assert.equal(store.call("getLink", item, "github").syncError, "permission denied");
});

test("edits during a drain survive the in-flight ack and render latest content", (t) => {
  const { store, item, link } = fixture(t);
  store.call("updateItem", item, { title: "before" });
  const calls = [];
  let competing;
  const tracker = () => ({ ...recording(calls)(), update: (id, issue) => {
    calls.push(["update", id, issue]);
    if (calls.length === 1) {
      store.call("updateItem", item, { title: "during", body: "latest" });
      competing = drainLink(store, item, link, config, { tracker: recording(calls), warn() {} });
    }
    return ok;
  } });
  drainLink(store, item, link, config, { tracker, warn() {} });
  assert.equal(competing.sent, 0);
  assert.deepEqual(calls.map((call) => call[2].title), ["before", "during"]);
  assert.equal(calls[1][2].body, "latest");
  assert.equal(store.call("getLink", item, "github").queued, 0);
});

test("create completion atomically reconciles current title/body/status but no pre-creation notes", (t) => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const item = store.call("addItem", { project: PROJECT, title: "snapshot", body: "old" });
  store.call("addNote", item, "before create");
  const calls = [];
  const tracker = () => ({ ...recording(calls)(), create: (issue) => {
    assert.equal(issue.title, "snapshot");
    store.call("updateItem", item, { title: "current", body: "new", fileRef: "src/a.ts:7" });
    store.call("setStatus", item, "done", "while creating");
    return { ok: true, value: { id: "42", url: `https://${PROJECT}/issues/42` } };
  } });
  const result = pushItem(store, store.call("getItem", item), config, { tracker, warn() {} });
  assert.equal(result.state, "closed");
  assert.deepEqual(calls.map((call) => call[0]), ["update", "close"]);
  assert.deepEqual(calls[0][2], { title: "current", body: "new\n\n`src/a.ts:7`" });
  assert.equal(store.call("getItem", item).notes.length, 2);
});

test("closed create with closeOnDone false stays open, and notes before create are never sent", (t) => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const item = store.call("addItem", { project: PROJECT, title: "closed" });
  store.call("setStatus", item, "dropped", "historical");
  const calls = [];
  const tracker = () => ({ ...recording(calls)(), create: () => ({ ok: true, value: { id: "42", url: "url" } }) });
  pushItem(store, store.call("getItem", item), { ...config, closeOnDone: false }, { tracker, warn() {} });
  assert.deepEqual(calls, []);
  assert.equal(store.call("getLink", item, "github").state, "open");
});

test("ordinary command budget is five attempted operations across all links", (t) => {
  const { store, item, link } = fixture(t);
  const second = store.call("addItem", { project: PROJECT, title: "second" });
  store.call("attachLink", second, "github", PROJECT, "43", "url");
  for (let n = 0; n < 4; n++) store.call("addNote", item, `note ${n}`);
  for (let n = 0; n < 4; n++) store.call("addNote", second, `note ${n}`);
  const calls = [];
  drainItems(store, [store.call("getItem", item), store.call("getItem", second)], config, { tracker: recording(calls), warn() {} });
  assert.equal(calls.length, 5);
  assert.equal(store.call("getLink", second, "github").queued, 3);
  assert.equal(store.call("getLink", item, "github").queued, 0);
  assert.equal(link.destination, PROJECT);
});

test("lost comment acknowledgement leaves intent for at-least-once redelivery", (t) => {
  const { store, item, link } = fixture(t);
  store.call("addNote", item, "may be duplicated");
  const calls = [], warnings = [];
  const flaky = { call: (op, ...args) => { if (op === "ackOp") throw new Error("lost reply"); return store.call(op, ...args); } };
  drainLink(flaky, item, link, config, { tracker: recording(calls), warn: (s) => warnings.push(s) });
  assert.equal(store.call("getLink", item, "github").queued, 1);
  drainLink(store, item, link, config, { tracker: recording(calls), warn() {} });
  assert.equal(calls.length, 2);
  assert.match(warnings[0], /lost reply/);
});

test("sync never re-creates an unknown outcome", (t) => {
  const { store } = fixture(t);
  const item = store.call("addItem", { project: PROJECT, title: "unknown" });
  const claim = store.call("claimLinkCreate", item, "github", PROJECT, "create");
  store.call("finishLinkCreate", item, "github", claim.token, { ok: false, kind: "uncertain", message: "lost response" });
  const calls = [];
  syncProject(store, PROJECT, config, { tracker: recording(calls), warn() {} });
  assert.equal(calls.length, 0);
  assert.equal(store.call("getLink", item, "github").state, "unknown");
});

test("create completion and current-state reconciliation roll back as one transaction", (t) => {
  const db = core.openDb(":memory:");
  t.after(() => db.close());
  const item = core.addItem(db, { project: PROJECT, title: "atomic create" });
  const claim = core.claimLinkCreate(db, item, "github", PROJECT, "create");
  core.setStatus(db, item, "dropped", "not a comment");
  db.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON link_ops BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END;");
  assert.throws(() => core.finishLinkCreate(db, item, "github", claim.token, { ok: true, externalId: "42", url: "url", snapshot: { title: item.title, body: item.body, fileRef: item.fileRef } }), /queue unavailable/);
  const link = core.getLink(db, item, "github");
  assert.equal(link.state, "creating");
  assert.equal(link.externalId, null);
  assert.deepEqual(ops(db), []);
});

test("expired lease updates are not coalesced with potentially in-flight work", (t) => {
  const db = core.openDb(":memory:");
  t.after(() => db.close());
  const item = core.addItem(db, { project: PROJECT, title: "expired" });
  core.attachLink(db, item, "github", PROJECT, "42", "url");
  core.updateItem(db, item, { title: "old in-flight" });
  queue.leaseLinkOps(db, item, "github", "crashed");
  queue.nextLinkOp(db, item, "github", "crashed");
  db.prepare("UPDATE links SET drain_until = '2000-01-01T00:00:00.000Z'").run();
  core.updateItem(db, item, { title: "new edit" });
  assert.deepEqual(ops(db).map((op) => op.seq), [1, 2]);
  assert.equal(queue.ackOp(db, item, "github", "crashed", 1), false);
});

test("an attention update is never erased by a newer update or silently reset by coalescing", (t) => {
  const { store, item, link } = fixture(t);
  store.call("updateItem", item, { title: "needs permission" });
  drainLink(store, item, link, config, { tracker: recording([], { ok: false, kind: "attention", message: "forbidden" }), warn() {} });
  store.call("updateItem", item, { title: "new edit" });
  const current = store.call("getLink", item, "github");
  assert.equal(current.attention, 1);
  assert.equal(current.queued, 1);
  const calls = [];
  drainLink(store, item, link, config, { tracker: recording(calls), warn() {} });
  assert.deepEqual(calls, []);
});


test("stale detached binding cannot lease or consume replacement intent", (t) => {
  const { store, item, link } = fixture(t);
  store.call("detachLink", item, "github");
  const replacement = store.call("attachLink", item, "github", PROJECT, "99", `https://${PROJECT}/issues/99`);
  store.call("addNote", item, "for replacement only");
  const calls = [];
  drainLink(store, item, link, config, { tracker: recording(calls), warn() {} });
  assert.deepEqual(calls, []);
  assert.equal(store.call("getLink", item, "github").queued, 1);
  drainLink(store, item, replacement, config, { tracker: recording(calls), warn() {} });
  assert.deepEqual(calls, [["comment", "99", "for replacement only"]]);
  assert.equal(store.call("getLink", item, "github").queued, 0);
});

test("successful create survives optional refresh transport failure with URL and warning", (t) => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const item = store.call("addItem", { project: PROJECT, title: "refresh" });
  const flaky = { call: (op, ...args) => {
    if (op === "getLink") throw new Error("SSH refresh unavailable");
    return store.call(op, ...args);
  } };
  const warnings = [];
  const result = pushItem(flaky, item, config, { tracker: () => ({ create: () => ({ ok: true, value: { id: "42", url: "known-url" } }) }), warn: (s) => warnings.push(s) });
  assert.deepEqual(result, { id: item.id, state: "open", url: "known-url", ok: true });
  assert.match(warnings[0], /known-url.*refresh.*SSH refresh unavailable/);
  assert.equal(store.call("getLink", item, "github").url, "known-url");
});

test("tag changes during a create queue a label update against the labels actually filed", (t) => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const item = store.call("addItem", { project: PROJECT, title: "tagged", tags: ["bug"] });
  const calls = [];
  const tracker = () => ({ ...recording(calls)(), create: (issue) => {
    assert.deepEqual(issue.labels, ["bug"]);
    store.call("updateItem", item, { addTags: ["ci"], removeTags: ["bug"] });
    return { ok: true, value: { id: "42", url: `https://${PROJECT}/issues/42` } };
  } });
  pushItem(store, store.call("getItem", item), config, { tracker, warn() {} });
  assert.deepEqual(calls, [["update", "42", { title: "tagged", body: "", addLabels: ["ci"], removeLabels: ["bug"] }]]);
  assert.deepEqual(store.call("getLink", item, "github").labels, ["ci"]);
});
