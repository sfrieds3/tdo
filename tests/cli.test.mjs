import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const { run } = await import("../src/cli.ts");
const SCRIPT = new URL("../src/cli.ts", import.meta.url).pathname;
const PROJECT = "github.com/example/widgets";

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdo-cli-"));
  const env = { TDO_DB: path.join(dir, "tdo.db"), TDO_PROJECT: PROJECT, XDG_CONFIG_HOME: path.join(dir, "config") };
  return (...argv) => {
    const out = [];
    const code = run(argv, { out: (text) => out.push(text), cwd: dir, env });
    return { code, out: out.join("\n"), json: () => JSON.parse(out.join("\n")) };
  };
}

test("add, list, edit, close, and export round-trip", () => {
  const tdo = harness();
  const added = tdo("add", "fix", "flaky", "test", "!high", "#ci", "-t", "tests", "-f", "src/a.ts:3", "--json").json();
  assert.equal(added.title, "fix flaky test");
  assert.equal(added.priority, "high");
  assert.deepEqual(added.tags, ["ci", "tests"]);
  assert.equal(added.source, "cli");

  tdo("add", "rename helpers", "-p", "low");
  assert.match(tdo("ls").out, /#1 {2}high {4}fix flaky test {2}#ci #tests {2}@ src\/a\.ts:3\n#2 {2}low/);
  assert.deepEqual(tdo("ls", "-t", "ci", "--json").json().map((item) => item.id), [1]);
  assert.deepEqual(tdo("ls", "-p", "high", "--json").json().map((item) => item.id), [1]);

  const edited = tdo("edit", "2", "-p", "urgent", "-t", "+cleanup,-nope", "--json").json();
  assert.equal(edited.priority, "urgent");
  assert.deepEqual(edited.tags, ["cleanup"]);

  assert.match(tdo("done", "#1", "-m", "added retries").out, /^done #1/);
  assert.deepEqual(tdo("ls", "--json").json().map((item) => item.id), [2]);
  assert.deepEqual(tdo("ls", "-s", "all", "--json").json().map((item) => item.id), [2, 1]);
  assert.match(tdo("show", "1").out, /\[done \d{4}-\d{2}-\d{2}\] added retries/);
  assert.equal(tdo("count").out, `${PROJECT}: 1 open (1 urgent)`);
  assert.equal(tdo("project").out, PROJECT);
  assert.match(tdo("export", "--md").out, /- \[x\] #1 fix flaky test/);
  assert.equal(tdo("export").json().length, 2);
  assert.match(tdo("projects").out, /1 {2}github\.com\/example\/widgets/);
  assert.match(tdo("ls", "-a").out, /^widgets#2 /);
  assert.equal(tdo("add", "from an agent", "--source", "claude", "--json").json().source, "claude");
});

test("ids are per project; other projects are reached by name or key", () => {
  const tdo = harness();
  tdo("add", "here one");
  const other = tdo("add", "there one", "--project", "github.com/example/gadgets", "--json").json();
  assert.equal(other.id, 1);
  assert.match(other.projectId, /^[0-9a-f-]{36}$/);
  assert.notEqual(other.projectId, tdo("show", "1", "--json").json().projectId);
  assert.equal(tdo("show", "1", "--json").json().title, "here one");
  assert.equal(tdo("show", "gadgets#1", "--json").json().title, "there one");
  assert.equal(tdo("done", "1", "--project", "github.com/example/gadgets", "--json").json().status, "done");
  assert.equal(tdo("show", "1", "--json").json().status, "open");
});

test("migrate previews and upgrades a v1 database", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdo-mig-"));
  const dbPath = path.join(dir, "tdo.db");
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(dbPath);
  raw.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, display_name TEXT, created_at TEXT NOT NULL);
    CREATE TABLE items (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL, body TEXT, priority INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'open', file_ref TEXT, source TEXT, session_id TEXT, host TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT);
    CREATE TABLE tags (item_id INTEGER NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (item_id, tag));
    INSERT INTO projects VALUES (1, 'a', 'a', 'x'), (2, 'b', 'b', 'x');
    INSERT INTO items (id, project_id, title, created_at, updated_at) VALUES (1, 1, 'first', 'x', 'x'), (2, 2, 'other', 'x', 'x'), (3, 1, 'second', 'x', 'x');
    PRAGMA user_version = 1;`);
  raw.close();
  const env = { TDO_DB: dbPath, TDO_PROJECT: "a", XDG_CONFIG_HOME: path.join(dir, "config") };
  const tdo = (...argv) => { const out = []; run(argv, { out: (text) => out.push(text), cwd: dir, env }); return out.join("\n"); };

  const dry = tdo("migrate", "--dry-run");
  assert.match(dry, /would upgrade schema v1 -> v2/);
  assert.match(dry, /b {2}#2 -> #1 {2}other/);
  assert.match(dry, /a {2}#3 -> #2 {2}second/);
  assert.doesNotMatch(dry, /#1 -> #1/);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes("backup")), [], "dry run writes nothing");

  const done = tdo("migrate");
  assert.match(done, /upgraded schema v1 -> v2/);
  assert.match(done, /backup: .*tdo\.db\.v1-backup-/);
  assert.match(tdo("show", "2"), /^#2 second/);
  assert.match(tdo("migrate"), /already at schema v2/);
});

test("paths reports the database and config locations", () => {
  const tdo = harness();
  const paths = tdo("paths", "--json").json();
  assert.match(paths.db, /tdo\.db$/);
  assert.match(paths.config, /config[\\/]tdo[\\/]config\.json$/);
  assert.equal(paths.configExists, false);
});

test("invalid input raises clear errors", () => {
  const tdo = harness();
  assert.throws(() => tdo("add"), /needs a title/);
  assert.throws(() => tdo("add", "x", "-p", "meh"), /priority must be one of/);
  assert.throws(() => tdo("show", "abc"), /expected an item id/);
  assert.throws(() => tdo("done", "7"), /No tdo item #7 in/);
  assert.throws(() => tdo("show", "0"), /expected an item id/);
  assert.throws(() => tdo("frobnicate"), /unknown command/);
});

test("the script runs as a CLI with usage-error exit codes", () => {
  const env = { ...process.env, XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "tdo-cfg-")), TDO_DB: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tdo-bin-")), "tdo.db"), TDO_PROJECT: PROJECT };
  const ok = spawnSync(process.execPath, [SCRIPT, "add", "hello"], { env, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /added #1/);
  assert.equal(ok.stderr, "");
  const bad = spawnSync(process.execPath, [SCRIPT, "nope"], { env, encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /tdo: unknown command: nope/);
});
