import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { run } from "../src/cli.ts";
import { openDb, schemaVersion } from "../src/core.ts";
import { createStore, createAsyncStore, parseTarget, handleRpc, MAX_RPC_BYTES } from "../src/store.ts";

const script = new URL("../src/cli.ts", import.meta.url).pathname;
function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdo-ssh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "ssh.log");
  fs.writeFileSync(path.join(bin, "ssh"), `#!${process.execPath}
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
fs.appendFileSync(process.env.SSH_LOG, JSON.stringify(process.argv.slice(2))+'\\n');
if (process.env.SSH_MODE === 'hang') { setInterval(() => {}, 1000); return; }
if (process.env.SSH_MODE === 'descendant') {
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 40000)'], {stdio: ['ignore', 'inherit', 'inherit']});
  fs.writeFileSync(process.env.SSH_LOG + '.pid', String(child.pid));
  process.exit(0);
}
if (process.env.SSH_MODE === 'fail') { console.error('offline'); process.exit(255); }
if (process.env.SSH_MODE === 'bad') { console.log('not json'); process.exit(0); }
if (process.env.SSH_MODE === 'version') { console.log(JSON.stringify({version:99,ok:true,result:{}})); process.exit(0); }
if (process.env.SSH_MODE === 'shape') { console.log(JSON.stringify({version:3,ok:true,result:{}})); process.exit(0); }
if (process.env.SSH_MODE === 'large') { process.stdout.write('x'.repeat(9*1024*1024)); return; }
const input = fs.readFileSync(0);
const request = JSON.parse(input);
if (process.env.SSH_FAIL_OP === request.operation && (!process.env.SSH_FAIL_ID || String(request.args[0]?.id) === process.env.SSH_FAIL_ID)) { console.error('injected store failure'); process.exit(255); }
const result = spawnSync(process.execPath, [process.env.TDO_HELPER, 'internal-rpc'], {input, encoding:'utf8', env:{...process.env,TDO_CONFIG:'/does-not-exist',TDO_DB:'/not-the-requested-db',TDO_PROJECT:'server-project',TDO_REMOTE_HELPER:'1'}});
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
`, { mode: 0o755 });
  const db = path.join(dir, "remote space;$(touch injected).db");
  const target = `ssh://alice@test-alias:2222${db.split("/").map(encodeURIComponent).join("/")}`;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SSH_LOG: log, TDO_HELPER: script, TDO_CONFIG: path.join(dir, "config.json"), TDO_DB: target, TDO_PROJECT: "caller/project", TDO_SOURCE: "agent", TDO_SESSION_ID: "session-1" };
  const cli = (...argv) => {
    const out = [];
    const status = run(argv, { out: (text) => out.push(text), cwd: dir, env });
    return { status, text: out.join("\n"), json: () => JSON.parse(out.join("\n")) };
  };
  return { dir, db, target, env, cli, log };
}

test("SSH URI parsing rejects ambiguous or injectable authorities and decodes paths once", () => {
  for (const target of ["https://host/db", "ssh://-oProxyCommand=x/db", "ssh://user:password@host/db", "ssh://host:0/db", "ssh://host:65536/db", "ssh://host/db?x", "ssh://host/db#x", "ssh://host/", "ssh://host/%00", "ssh://host/%0A", "ssh://host/%ZZ", "ssh://a%40b@host/db", "ssh://[:::]/db", "ssh://host", "ssh://host;touch/db"]) assert.throws(() => parseTarget(target), target);
  assert.equal(parseTarget("ssh://host/a%2520b").path, "/a%20b");
  assert.equal(parseTarget("ssh://[::1]:22/a").host, "[::1]");
  assert.equal(parseTarget("ssh://host/a/../b").path, "/a/../b");
  assert.throws(() => openDb("ssh://host/db"), /local paths only/);
});

test("SSH CLI full CRUD, FTS, metadata, project refs, tags, counts and exports use real helper", (t) => {
  const h = harness(t);
  const added = h.cli("add", "remote searchable !high #ci", "--json").json();
  assert.equal(added.project, "caller/project");
  assert.equal(added.source, "agent");
  assert.equal(added.sessionId, "session-1");
  assert.ok(added.host);
  assert.equal(h.cli("ls", "-q", "search", "--json").json()[0].id, 1);
  assert.equal(h.cli("show", "1", "--json").json().title, "remote searchable");
  assert.equal(h.cli("edit", "1", "--title", "updated", "-t", "+test,-ci", "--json").json().title, "updated");
  assert.deepEqual(h.cli("tags", "--json").json(), [{ tag: "test", count: 1 }]);
  assert.equal(h.cli("count", "--json").json().total, 1);
  h.cli("start", "1"); // optional undefined note must be omitted from wire args
  h.cli("done", "1", "-m", "finished");
  h.cli("reopen", "1");
  assert.equal(h.cli("projects", "--json").json()[0].key, "caller/project");
  h.cli("add", "other project", "--project", "other/name");
  assert.equal(h.cli("show", "name#1", "--json").json().project, "other/name");
  assert.equal(h.cli("export", "--all").json().length, 2);
  assert.match(h.cli("export", "--md").text, /updated/);
  h.cli("rm", "1");
  assert.equal(h.cli("ls", "--json").json().length, 0);
  assert.equal(h.cli("db", "check", "--json").json().schema, 3);
  const args = JSON.parse(fs.readFileSync(h.log, "utf8").split("\n")[0]);
  assert.deepEqual(args, ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ConnectionAttempts=1", "-p", "2222", "-l", "alice", "--", "test-alias", "tdo internal-rpc"]);
  assert.ok(!args.join(" ").includes(h.db));
  assert.ok(fs.existsSync(h.db));
  assert.ok(!fs.existsSync(path.join(h.dir, "injected")));
});

test("SSH grouped listings honor per-project caps, priority, filters and JSON", (t) => {
  const h = harness(t);
  fs.writeFileSync(h.env.TDO_CONFIG, JSON.stringify({ perProject: 1 }));
  h.cli("add", "normal #ci");
  h.cli("add", "urgent !urgent #ci");
  h.cli("add", "other !high", "--project", "other/name");
  const grouped = h.cli("ls", "-a").text;
  assert.match(grouped, /urgent/);
  assert.match(grouped, /1 more/);
  assert.ok(grouped.indexOf("caller/project") < grouped.indexOf("other/name"));
  assert.equal(h.cli("ls", "-a", "--json").json().length, 2);
  assert.equal(h.cli("ls", "-a", "-n", "0", "--json").json().length, 3);
  assert.deepEqual(h.cli("ls", "-a", "-t", "ci", "-p", "high", "--json").json().map((item) => item.title), ["urgent"]);
  assert.throws(() => h.cli("ls", "-a", "--limit=-1"), /non-negative integer/);
});

test("SSH ID-less pickers and editor use selected --db including preview subprocesses", (t) => {
  const h = harness(t);
  h.cli("add", "first");
  h.cli("add", "second");
  const argv1 = process.argv[1];
  process.argv[1] = script;
  t.after(() => { process.argv[1] = argv1; });
  const env = { ...h.env, TDO_DB: path.join(h.dir, "wrong.db") };
  const out = [];
  const io = { out: (text) => out.push(text), cwd: h.dir, env,
    pick(lines, options) {
      assert.equal(lines.length, 2);
      assert.equal(options.multi, true);
      assert.ok(options.preview.includes(h.target));
      const preview = spawnSync(options.preview.replace("{1}", "caller/project#1"), { shell: true, encoding: "utf8", cwd: h.dir, env });
      assert.equal(preview.status, 0, preview.stderr);
      assert.match(preview.stdout, /first/);
      return lines.map((line) => line.split("\t")[0]);
    },
  };
  assert.equal(run(["--db", h.target, "start"], io), 0);
  assert.equal(h.cli("count", "--json").json().doing, 2);
  assert.equal(run(["--db", h.target, "edit", "1"], { ...io, edit: (text) => {
    assert.equal(text, "first");
    return "edited\n\nremote body";
  } }), 0);
  assert.equal(h.cli("show", "1", "--json").json().body, "remote body");
  run(["--db", h.target, "edit", "1"], { ...io, edit: () => "edited" });
  assert.equal(h.cli("show", "1", "--json").json().body, null);
  assert.ok(!fs.existsSync(env.TDO_DB));
});

test("SSH browser subprocesses retain --db and helpers feed, toggle and update remote items", (t) => {
  const h = harness(t);
  h.cli("add", "current");
  h.cli("add", "other", "--project", "other/name");
  const argv1 = process.argv[1];
  process.argv[1] = script;
  t.after(() => { process.argv[1] = argv1; });
  const env = { ...h.env, TDO_DB: path.join(h.dir, "wrong.db") };
  let stateFile;
  const code = run(["--db", h.target], { out() {}, cwd: h.dir, env, interactive: true,
    runFzf(args, childEnv) {
      const feed = args.find((arg) => arg.startsWith("--bind=start:reload(")).slice("--bind=start:reload(".length, -1);
      stateFile = feed.match(/_fzf feed (.*)$/)[1];
      const exec = (command) => {
        const result = spawnSync(command, { shell: true, encoding: "utf8", cwd: h.dir, env: childEnv });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      assert.ok(feed.includes(h.target));
      assert.match(exec(feed), /current/);
      assert.doesNotMatch(exec(feed), /other\/name/);
      exec(feed.replace("_fzf feed", "_fzf toggle-all"));
      assert.match(exec(feed), /other\/name#1/);
      exec(feed.replace("_fzf feed", "_fzf raise") + " caller/project#1");
      exec(feed.replace("_fzf feed", "_fzf lower") + " other/name#1");
      const preview = args.find((arg) => arg.startsWith("--preview=")).slice("--preview=".length);
      assert.match(exec(preview.replace("{1}", "caller/project#1")), /priority:.*high/);
      exec(feed.replace("_fzf feed", "_fzf toggle-closed"));
      assert.match(exec(feed.replace("_fzf feed", "_fzf header")), /open \+ closed/);
      return 130;
    },
  });
  assert.equal(code, 0);
  assert.ok(!fs.existsSync(stateFile));
  assert.equal(h.cli("show", "1", "--json").json().priority, "high");
  assert.equal(h.cli("show", "name#1", "--json").json().priority, "low");
  assert.ok(!fs.existsSync(env.TDO_DB));
});

test("async store is nonblocking and supports the same typed operations", async (t) => {
  const h = harness(t);
  const store = createAsyncStore(h.target, { env: h.env });
  let tick = false;
  const pending = store.call("addItem", { project: "async", title: "async item" });
  await new Promise((resolve) => setImmediate(() => { tick = true; resolve(); }));
  assert.ok(tick);
  const added = await pending;
  assert.equal((await store.call("getItem", { projectId: added.projectId, id: added.id })).title, "async item");
  assert.equal(await store.call("getItemByNumber", "async", 999), undefined);
  assert.equal((await store.call("listTags", undefined)).length, 0);
  assert.equal((await store.call("countActive", "async")).total, 1);
  store.close();
});

test("target precedence and db use preserve config, while paths never connects", (t) => {
  const h = harness(t);
  const configDb = path.join(h.dir, "config.db");
  fs.writeFileSync(h.env.TDO_CONFIG, JSON.stringify({ db: configDb, aliases: { "caller/project": "aliased" }, future: { keep: true } }));
  h.cli("db", "use", h.target);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.env.TDO_CONFIG, "utf8")), { db: h.target, aliases: { "caller/project": "aliased" }, future: { keep: true } });
  const calls = fs.readFileSync(h.log, "utf8");
  assert.equal(h.cli("paths", "--json").json().db, h.target);
  assert.equal(fs.readFileSync(h.log, "utf8"), calls);
  const override = path.join(h.dir, "override.db");
  h.cli("add", "one off", "--db", override);
  assert.equal(h.cli("paths", "--db", override, "--json").json().db, override);
  h.env.TDO_DB = configDb;
  assert.equal(h.cli("paths", "--json").json().db, configDb);
  delete h.env.TDO_DB;
  assert.equal(h.cli("paths", "--json").json().db, h.target);
  const before = fs.readFileSync(h.env.TDO_CONFIG, "utf8");
  assert.throws(() => h.cli("db", "use", "ssh://-bad/db"));
  h.env.SSH_MODE = "fail";
  assert.throws(() => h.cli("db", "use", h.target), /offline/);
  assert.equal(fs.readFileSync(h.env.TDO_CONFIG, "utf8"), before);
});

test("db use checks and saves the same canonical local target", (t) => {
  const h = harness(t);
  delete h.env.TDO_DB;
  const relative = path.join(h.dir, "relative.db");
  h.cli("db", "use", "  relative.db  ");
  assert.equal(h.cli("paths", "--json").json().db, relative);
  assert.ok(fs.existsSync(relative));
  const homeTarget = path.join(h.dir, "home-expanded.db");
  h.cli("db", "use", `~/${path.relative(os.homedir(), homeTarget)}`);
  assert.equal(h.cli("paths", "--json").json().db, homeTarget);
  assert.ok(fs.existsSync(homeTarget));
  const out = [];
  run(["paths", "--json"], { out: (text) => out.push(text), cwd: os.homedir(), env: h.env });
  assert.equal(JSON.parse(out[0]).db, homeTarget, "selection is independent of the next command's cwd");
});

test("transport and protocol failures never create a local fallback or retry", async (t) => {
  const h = harness(t);
  for (const mode of ["fail", "bad", "version", "shape", "large"]) {
    h.env.SSH_MODE = mode;
    assert.throws(() => createStore(h.target, { env: h.env }).call("countActive", "p"), /SSH|RPC/);
    await assert.rejects(createAsyncStore(h.target, { env: h.env }).call("countActive", "p"), /SSH|RPC/);
  }
  assert.equal(fs.readFileSync(h.log, "utf8").trim().split("\n").length, 10);
  assert.ok(!fs.existsSync(h.db));
});

test("sync and async SSH operations enforce the overall timeout", async (t) => {
  const h = harness(t);
  h.env.SSH_MODE = "descendant";
  const pending = assert.rejects(createAsyncStore(h.target, { env: h.env }).call("check"), /timed out/);
  h.env.SSH_MODE = "hang";
  const start = Date.now();
  try {
    assert.throws(() => createStore(h.target, { env: h.env }).call("check"), /SSH database operation failed/);
    await pending;
    assert.ok(Date.now() - start < 30_000, "inherited proxy pipes cannot extend the deadline");
    assert.ok(!fs.existsSync(h.db));
  } finally {
    const pidFile = h.log + ".pid";
    if (fs.existsSync(pidFile)) {
      try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
});

test("helper validates closed protocol and args before opening a database", (t) => {
  const h = harness(t);
  const request = { version: 3, path: h.db, operation: "listItems", args: [] };
  for (const bad of ["not-json", JSON.stringify({ ...request, version: 1 }), JSON.stringify({ ...request, extra: true }), JSON.stringify({ ...request, path: "ssh://host/db" }), JSON.stringify({ ...request, operation: "exec", args: ["DROP TABLE items"] }), JSON.stringify({ ...request, args: [{ limit: "1; DROP TABLE items" }] }), JSON.stringify({ ...request, operation: "addItem", args: [{ project: {}, title: "bad" }] }), "x".repeat(MAX_RPC_BYTES + 1)]) {
    assert.equal(JSON.parse(handleRpc(bad)).ok, false);
  }
  assert.ok(!fs.existsSync(h.db));
  assert.equal(JSON.parse(handleRpc(JSON.stringify(request))).ok, true);
  const raw = spawnSync(process.execPath, [script, "internal-rpc", "extra"], { encoding: "utf8" });
  assert.equal(raw.status, 2);
});

test("remote older schema requires explicit migration and backup stays on server", async (t) => {
  const h = harness(t);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(h.db);
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, display_name TEXT, created_at TEXT NOT NULL);
    CREATE TABLE items (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL, body TEXT, priority INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'open', file_ref TEXT, source TEXT, session_id TEXT, host TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT);
    CREATE TABLE tags (item_id INTEGER NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (item_id, tag));
    INSERT INTO projects VALUES (1, 'caller/project', 'project', 'x');
    INSERT INTO items (id, project_id, title, created_at, updated_at) VALUES (5, 1, 'old item', 'x', 'x');
    PRAGMA user_version = 1;`);
  db.close();
  assert.throws(() => h.cli("ls"), /explicit migration/);
  assert.throws(() => h.cli("db", "check"), /explicit migration/);
  const preview = h.cli("migrate", "--dry-run", "--json").json();
  assert.equal(preview.from, 1);
  assert.deepEqual(preview.changes.map((c) => [c.from, c.to]), [[5, 1]]);
  const before = openDb(h.db, { migrate: false });
  assert.equal(schemaVersion(before), 1);
  before.close();
  const migrated = h.cli("migrate", "--json").json();
  assert.ok(fs.existsSync(migrated.backup));
  assert.ok(migrated.backup.startsWith(h.db));
  assert.equal(h.cli("ls", "--json").json()[0].id, 1);
  assert.equal(h.cli("migrate", "--json").json().from, 3);
});

test("local operation store retains an in-memory database across calls", () => {
  const store = createStore(":memory:");
  store.call("addItem", { project: "local", title: "persistent handle" });
  assert.equal(store.call("listItems").length, 1);
  store.close();
});

test("lifecycle intent persists through fake SSH, including leases, retries and protocol evolution", (t) => {
  const h = harness(t);
  const remote = createStore(h.target, { env: h.env });
  t.after(() => remote.close());
  const item = remote.call("addItem", { project: "caller/project", title: "remote queue" });
  remote.call("attachLink", item, "github", "github.com/example/widgets", "42", "https://github.com/example/widgets/issues/42");
  remote.call("updateItem", item, { title: "latest" });
  remote.call("setStatus", item, "done", "remote note", true);
  remote.call("setStatus", item, "open", undefined, true); // optional hole is JSON null on the wire
  assert.equal(remote.call("getItem", item).links[0].queued, 4);
  const reopened = createStore(h.target, { env: h.env });
  t.after(() => reopened.close());
  assert.equal(reopened.call("listLinkedItems", "caller/project")[0].notes[0].body, "remote note");
  assert.equal(remote.call("leaseLinkOps", item, "github", "first"), true);
  assert.equal(reopened.call("leaseLinkOps", item, "github", "second"), false);
  assert.equal(reopened.call("ackOp", item, "github", "second", 1), false);
  assert.equal(remote.call("nextLinkOp", item, "github", "first").op, "update");
  assert.equal(remote.call("ackOp", item, "github", "first", 1), true);
  assert.equal(remote.call("failOp", item, "github", "first", 2, true, "auth required"), true);
  assert.equal(remote.call("releaseLinkOps", item, "github", "first"), true);
  assert.equal(remote.call("getLink", item, "github").attention, 1);
  assert.equal(remote.call("retryLinkOps", "other/project"), 0);
  assert.equal(remote.call("retryLinkOps", "caller/project"), 1);
  assert.equal(reopened.call("leaseLinkOps", item, "github", "second"), true);
  for (const [seq, op] of [[2, "comment"], [3, "close"], [4, "reopen"]]) {
    const next = reopened.call("nextLinkOp", item, "github", "second");
    assert.deepEqual([next.seq, next.op], [seq, op]);
    assert.equal(reopened.call("ackOp", item, "github", "second", seq), true);
  }
  assert.equal(reopened.call("nextLinkOp", item, "github", "second"), undefined);
  reopened.call("releaseLinkOps", item, "github", "second");
  assert.equal(remote.call("getLink", item, "github").state, "open");
  const local = openDb(h.db);
  t.after(() => local.close());
  assert.equal(local.prepare("SELECT next_op_seq FROM links").get().next_op_seq, 5);
  const old = JSON.parse(handleRpc(JSON.stringify({ version: 2, path: h.db, operation: "setStatus", args: [item, "done"] })));
  assert.match(old.error, /incompatible RPC protocol/);
  assert.equal(remote.call("getItem", item).status, "open", "old clients cannot mutate without lifecycle intent");
});

test("remote-backed lifecycle draining invokes gh only on the caller, never in the SSH helper", (t) => {
  const h = harness(t);
  const ghLog = path.join(h.dir, "gh.log");
  h.env.GH_LOG = ghLog;
  fs.writeFileSync(path.join(h.dir, "bin", "gh"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args.includes('-') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.GH_LOG, JSON.stringify({args,input,remote:process.env.TDO_REMOTE_HELPER || null})+'\\n');
if (process.env.TDO_REMOTE_HELPER) process.exit(99);
process.exit(0);
`, { mode: 0o755 });
  fs.writeFileSync(h.env.TDO_CONFIG, JSON.stringify({ projects: { "caller/project": { tracker: { provider: "github", repo: "example/widgets" } } } }));
  const remote = createStore(h.target, { env: h.env });
  const item = remote.call("addItem", { project: "caller/project", title: "caller only" });
  remote.call("attachLink", item, "github", "github.com/example/widgets", "42", "https://github.com/example/widgets/issues/42");
  remote.close();
  assert.equal(fs.existsSync(ghLog), false, "RPC operations never run gh");
  assert.equal(h.cli("done", "1", "-m", "fixed", "--json").status, 0);
  const calls = fs.readFileSync(ghLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.args[1]), ["comment", "close"]);
  assert.ok(calls.every((call) => call.remote === null));
  assert.equal(h.cli("show", "1", "--json").json().links[0].state, "closed");
});


test("SSH stale detached snapshot cannot consume replacement issue queue", async (t) => {
  const { drainLink } = await import("../src/trackers/drain.ts");
  const h = harness(t);
  const store = createStore(h.target, { env: h.env });
  t.after(() => store.close());
  const destination = "github.com/example/widgets";
  const item = store.call("addItem", { project: "caller/project", title: "binding" });
  const old = store.call("attachLink", item, "github", destination, "42", "old-url");
  store.call("detachLink", item, "github");
  const replacement = store.call("attachLink", item, "github", destination, "99", "new-url");
  store.call("addNote", item, "new intent");
  const sent = [];
  const config = { provider: "github", approval: "user-only", closeOnDone: true };
  const options = { warn() {}, tracker: () => ({ comment: (id, body) => { sent.push([id, body]); return { ok: true }; } }) };
  drainLink(store, item, old, config, options);
  assert.deepEqual(sent, []);
  assert.equal(store.call("getLink", item, "github").queued, 1);
  drainLink(store, item, replacement, config, options);
  assert.deepEqual(sent, [["99", "new intent"]]);
  assert.equal(store.call("getLink", item, "github").queued, 0);
  const invalid = JSON.parse(handleRpc(JSON.stringify({ version: 3, path: h.db, operation: "leaseLinkOps", args: [item, "github", "owner", { destination }] })));
  assert.equal(invalid.ok, false, "RPC binding expectations must have every validated field");
});

test("SSH multi-push keeps one JSON array and known URLs across store failures", (t) => {
  const h = harness(t);
  fs.writeFileSync(h.env.TDO_CONFIG, JSON.stringify({ projects: { "caller/project": { tracker: { provider: "github", repo: "example/widgets" } } } }));
  fs.writeFileSync(path.join(h.dir, "bin", "gh"), `#!${process.execPath}
console.log('https://github.com/example/widgets/issues/42');
`, { mode: 0o755 });
  for (const title of ["one", "two", "three", "four", "five"]) h.cli("add", title);
  h.env.SSH_FAIL_OP = "getLink";
  const warnings = [];
  const out = [];
  assert.equal(run(["push", "1", "2", "--json", "--no-sync"], { out: (s) => out.push(s), err: (s) => warnings.push(s), cwd: h.dir, env: h.env }), 0);
  assert.equal(out.length, 1);
  assert.deepEqual(JSON.parse(out[0]).map((row) => [row.id, row.ok, row.url]), [[1, true, "https://github.com/example/widgets/issues/42"], [2, true, "https://github.com/example/widgets/issues/42"]]);
  assert.equal(warnings.length, 2);
  h.env.SSH_FAIL_OP = "finishLinkCreate";
  h.env.SSH_FAIL_ID = "3";
  out.length = 0;
  assert.equal(run(["push", "3", "1", "--json", "--no-sync"], { out: (s) => out.push(s), err: (s) => warnings.push(s), cwd: h.dir, env: h.env }), 1);
  const rows = JSON.parse(out[0]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ok, false);
  assert.equal(rows[0].url, "https://github.com/example/widgets/issues/42");
  assert.equal(rows[1].ok, true);
  h.env.SSH_FAIL_OP = "claimLinkCreate";
  h.env.SSH_FAIL_ID = "4";
  out.length = 0;
  assert.equal(run(["push", "4", "5", "--json", "--no-sync"], { out: (s) => out.push(s), err: (s) => warnings.push(s), cwd: h.dir, env: h.env }), 1);
  const continued = JSON.parse(out[0]);
  assert.equal(continued[0].ok, false);
  assert.match(continued[0].error, /injected store failure/);
  assert.equal(continued[1].ok, true, "unexpected per-item store failures do not abort later items");
});
