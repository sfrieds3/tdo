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
if (process.env.SSH_MODE === 'shape') { console.log(JSON.stringify({version:1,ok:true,result:{}})); process.exit(0); }
if (process.env.SSH_MODE === 'large') { process.stdout.write('x'.repeat(9*1024*1024)); return; }
const input = fs.readFileSync(0);
const result = spawnSync(process.execPath, [process.env.TDO_HELPER, 'internal-rpc'], {input, encoding:'utf8', env:{...process.env,TDO_CONFIG:'/does-not-exist',TDO_DB:'/not-the-requested-db',TDO_PROJECT:'server-project'}});
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
  assert.equal(h.cli("db", "check", "--json").json().schema, 2);
  const args = JSON.parse(fs.readFileSync(h.log, "utf8").split("\n")[0]);
  assert.deepEqual(args, ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ConnectionAttempts=1", "-p", "2222", "-l", "alice", "--", "test-alias", "tdo internal-rpc"]);
  assert.ok(!args.join(" ").includes(h.db));
  assert.ok(fs.existsSync(h.db));
  assert.ok(!fs.existsSync(path.join(h.dir, "injected")));
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
  const request = { version: 1, path: h.db, operation: "listItems", args: [] };
  for (const bad of ["not-json", JSON.stringify({ ...request, version: 2 }), JSON.stringify({ ...request, extra: true }), JSON.stringify({ ...request, path: "ssh://host/db" }), JSON.stringify({ ...request, operation: "exec", args: ["DROP TABLE items"] }), JSON.stringify({ ...request, args: [{ limit: "1; DROP TABLE items" }] }), JSON.stringify({ ...request, operation: "addItem", args: [{ project: {}, title: "bad" }] }), "x".repeat(MAX_RPC_BYTES + 1)]) {
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
  assert.equal(h.cli("migrate", "--json").json().from, 2);
});

test("local operation store retains an in-memory database across calls", () => {
  const store = createStore(":memory:");
  store.call("addItem", { project: "local", title: "persistent handle" });
  assert.equal(store.call("listItems").length, 1);
  store.close();
});
