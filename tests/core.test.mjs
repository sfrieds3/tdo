import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const tdo = await import("../src/core.ts");

const NO_CONFIG = { aliases: {} };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tdo-test-"));
}

function git(cwd, ...args) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

test("normalizeRemote maps ssh, scp, and https remotes to host/owner/repo", () => {
  assert.equal(tdo.normalizeRemote("git@github.com:example/widgets.git"), "github.com/example/widgets");
  assert.equal(tdo.normalizeRemote("https://GitHub.com/example/widgets"), "github.com/example/widgets");
  assert.equal(tdo.normalizeRemote("https://user:token@github.com/example/widgets.git/"), "github.com/example/widgets");
  assert.equal(tdo.normalizeRemote("ssh://git@gitlab.example.com:2222/group/sub/widgets.git"), "gitlab.example.com/group/sub/widgets");
  assert.equal(tdo.normalizeRemote("example-host:~/repos/widgets.git"), "example-host/repos/widgets");
  assert.equal(tdo.normalizeRemote("https://github.com/example/my.dotfiles.git"), "github.com/example/my.dotfiles");
  assert.equal(tdo.normalizeRemote("/srv/git/widgets.git"), undefined);
  assert.equal(tdo.normalizeRemote("file:///srv/git/widgets.git"), undefined);
  assert.equal(tdo.normalizeRemote(""), undefined);
});

test("resolveProject prefers env, override file, remote, then home-relative path", () => {
  const home = tempDir();
  const repo = path.join(home, "code", "widgets");
  fs.mkdirSync(repo, { recursive: true });
  const env = {};
  assert.equal(tdo.resolveProject(repo, { env, home, config: NO_CONFIG }).key, "local:~/code/widgets");

  git(repo, "init", "-q");
  assert.equal(tdo.resolveProject(repo, { env, home, config: NO_CONFIG }).key, "local:~/code/widgets");

  git(repo, "remote", "add", "upstream", "https://github.com/upstream/widgets.git");
  git(repo, "remote", "add", "origin", "git@github.com:example/widgets.git");
  const sub = path.join(repo, "src");
  fs.mkdirSync(sub);
  const project = tdo.resolveProject(sub, { env, home, config: NO_CONFIG });
  assert.equal(project.key, "github.com/example/widgets");
  assert.equal(project.name, "widgets");
  assert.equal(fs.realpathSync(project.root), fs.realpathSync(repo));

  fs.writeFileSync(path.join(repo, ".tdo-project"), "example/custom\n");
  assert.equal(tdo.resolveProject(sub, { env, home, config: NO_CONFIG }).key, "example/custom");

  assert.equal(tdo.resolveProject(sub, { env: { TDO_PROJECT: "forced" }, home, config: NO_CONFIG }).key, "forced");
});

test("priority, tag, and quick-add parsing", () => {
  assert.equal(tdo.parsePriority("HIGH"), "high");
  assert.equal(tdo.parsePriority("u"), "urgent");
  assert.equal(tdo.parsePriority(3), "low");
  assert.equal(tdo.parsePriority("bogus"), undefined);
  assert.throws(() => tdo.requirePriority("bogus"), /priority must be one of/);
  assert.deepEqual(tdo.normalizeTags(["#CI", "perf, ui", " ", "ci"]), ["ci", "perf", "ui"]);
  assert.deepEqual(tdo.parseQuickAdd("fix flaky test !high #ci #Tests"), { title: "fix flaky test", priority: "high", tags: ["ci", "tests"] });
  assert.deepEqual(tdo.parseQuickAdd("handle issue #42 !wow"), { title: "handle issue #42 !wow", priority: undefined, tags: [] });
});

test("items can be added, listed, searched, updated, and closed", () => {
  const db = tdo.openDb(":memory:");
  const project = { key: "github.com/example/widgets", name: "widgets" };
  const a = tdo.addItem(db, { project, title: "  Fix   flaky login test ", priority: "high", tags: ["ci", "#tests"], fileRef: "src/login.ts:42", source: "user" });
  const b = tdo.addItem(db, { project, title: "Refactor config loader", body: "Too many env lookups", tags: ["cleanup"] });
  const c = tdo.addItem(db, { project, title: "Urgent crash on empty input", priority: "urgent" });
  tdo.addItem(db, { project: "github.com/example/gadgets", title: "Other project item", tags: ["ci"] });

  assert.equal(a.title, "Fix flaky login test");
  assert.deepEqual(a.tags, ["ci", "tests"]);
  assert.equal(a.fileRef, "src/login.ts:42");
  assert.equal(b.priority, "normal");

  assert.deepEqual(tdo.listItems(db, { project: project.key }).map((item) => item.id), [c.id, a.id, b.id]);
  assert.deepEqual(tdo.listItems(db, { project: project.key, tags: ["ci"] }).map((item) => item.id), [a.id]);
  assert.deepEqual(tdo.listItems(db, { tags: ["ci"] }).length, 2);
  assert.deepEqual(tdo.listItems(db, { project: project.key, minPriority: "high" }).map((item) => item.id), [c.id, a.id]);
  assert.deepEqual(tdo.listItems(db, { query: "env look" }).map((item) => item.id), [b.id]);
  assert.deepEqual(tdo.listItems(db, { query: "\"*" }), []);

  const updated = tdo.updateItem(db, b, { title: "Refactor settings loader", priority: "low", addTags: ["Perf"], removeTags: ["cleanup"] });
  assert.equal(updated.priority, "low");
  assert.deepEqual(updated.tags, ["perf"]);
  assert.deepEqual(tdo.listItems(db, { query: "settings" }).map((item) => item.id), [b.id]);
  assert.deepEqual(tdo.listItems(db, { query: "config" }), []);

  const doing = tdo.setStatus(db, b, "doing");
  assert.equal(doing.closedAt, null);
  assert.equal(tdo.listItems(db, { project: project.key })[0].id, b.id, "doing items sort first");

  const done = tdo.setStatus(db, a, "done", "fixed by retry");
  assert.ok(done.closedAt);
  assert.match(done.body, /\[done \d{4}-\d{2}-\d{2}\] fixed by retry/);
  assert.deepEqual(tdo.listItems(db, { project: project.key }).map((item) => item.id), [b.id, c.id]);
  assert.deepEqual(tdo.listItems(db, { project: project.key, status: "closed" }).map((item) => item.id), [a.id]);
  assert.equal(tdo.setStatus(db, a, "open").closedAt, null);

  const counts = tdo.countActive(db, project.key);
  assert.deepEqual(counts, { total: 3, doing: 1, urgent: 1, high: 1, normal: 0, low: 1 });
  assert.equal(tdo.formatCounts(counts), "3 open (1 urgent, 1 high)");
  assert.deepEqual(tdo.listTags(db, project.key), [{ tag: "ci", count: 1 }, { tag: "perf", count: 1 }, { tag: "tests", count: 1 }]);
  assert.deepEqual(tdo.listProjects(db).map((row) => [row.key, row.active]), [[project.key, 3], ["github.com/example/gadgets", 1]]);

  tdo.deleteItem(db, c);
  assert.equal(tdo.getItem(db, c), undefined);
  assert.deepEqual(tdo.listItems(db, { query: "crash" }), []);

  assert.throws(() => tdo.addItem(db, { project, title: "   " }), /title must not be empty/);
  assert.throws(() => tdo.setStatus(db, { projectId: a.projectId, id: 999 }, "done"), /No tdo item #999/);
});

test("item numbers are per project and never reused", () => {
  const db = tdo.openDb(":memory:");
  const widgets = "github.com/example/widgets";
  const gadgets = "github.com/example/gadgets";
  const w1 = tdo.addItem(db, { project: widgets, title: "w1" });
  const g1 = tdo.addItem(db, { project: gadgets, title: "g1" });
  const w2 = tdo.addItem(db, { project: widgets, title: "w2" });
  assert.deepEqual([w1.id, g1.id, w2.id], [1, 1, 2]);
  assert.equal(w1.projectId, w2.projectId);
  assert.notEqual(w1.projectId, g1.projectId);
  assert.match(w1.projectId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  tdo.deleteItem(db, w2);
  assert.equal(tdo.addItem(db, { project: widgets, title: "w3" }).id, 3);

  assert.equal(tdo.findItem(db, "1", widgets).title, "w1");
  assert.equal(tdo.findItem(db, "#1", gadgets).title, "g1");
  assert.equal(tdo.findItem(db, "gadgets#1", widgets).title, "g1");
  assert.equal(tdo.findItem(db, `${gadgets}#1`, widgets).title, "g1");
  assert.throws(() => tdo.findItem(db, "2", widgets), /No tdo item #2 in github\.com\/example\/widgets/);
  assert.throws(() => tdo.findItem(db, "nope#1", widgets), /No tdo project nope/);
  assert.throws(() => tdo.findItem(db, "abc", widgets), /expected an item id/);
  assert.equal(tdo.itemRef(g1, { showProject: true }), "gadgets#1");
});

const V1_SQL = `CREATE TABLE projects (id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, display_name TEXT, created_at TEXT NOT NULL);
  CREATE TABLE items (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), title TEXT NOT NULL, body TEXT,
    priority INTEGER NOT NULL DEFAULT 2, status TEXT NOT NULL DEFAULT 'open', file_ref TEXT, source TEXT, session_id TEXT, host TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT);
  CREATE TABLE tags (item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (item_id, tag));
  CREATE VIRTUAL TABLE items_fts USING fts5(title, body, content='items', content_rowid='id');
  CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, title, body) VALUES (new.id, new.title, coalesce(new.body, ''));
  END;
  INSERT INTO projects VALUES (1, 'a', 'a', 'x'), (2, 'b', 'b', 'x');
  INSERT INTO items (id, project_id, title, body, status, created_at, updated_at, closed_at) VALUES
    (1, 1, 'a1', 'searchable words', 'open', 'x', 'x', NULL), (2, 2, 'b1', NULL, 'open', 'x', 'x', NULL), (5, 1, 'a2', NULL, 'done', 'x', 'x', 'y');
  INSERT INTO tags VALUES (1, 'ci'), (5, 'perf'), (2, 'ci');
  PRAGMA user_version = 1;`;

async function v1Db() {
  const dbPath = path.join(tempDir(), "v1.db");
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(dbPath);
  raw.exec(V1_SQL);
  raw.close();
  return dbPath;
}

test("v1 databases migrate to uuid projects and per-project ids, with a backup", async () => {
  const dbPath = await v1Db();
  const preview = tdo.openDb(dbPath, { migrate: false });
  assert.equal(tdo.schemaVersion(preview), 1);
  assert.deepEqual(tdo.planMigration(preview).map((row) => [row.project, row.from, row.to]), [["a", 1, 1], ["a", 5, 2], ["b", 2, 1]]);
  const result = tdo.migrateDb(preview, dbPath);
  preview.close();
  assert.deepEqual([result.from, result.to], [1, 2]);
  assert.ok(fs.existsSync(result.backup), "backup written");
  const backup = tdo.openDb(result.backup, { migrate: false });
  assert.equal(tdo.schemaVersion(backup), 1, "backup keeps the old schema");
  backup.close();

  const db = tdo.openDb(dbPath);
  const items = tdo.listItems(db, { status: "all" });
  assert.deepEqual(items.map((item) => [item.project, item.id, item.tags.join(), item.status]).sort(), [["a", 1, "ci", "open"], ["a", 2, "perf", "done"], ["b", 1, "ci", "open"]]);
  assert.match(items[0].projectId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(tdo.listItems(db, { query: "searchable" }).map((item) => item.title), ["a1"]);
  assert.equal(tdo.addItem(db, { project: "a", title: "a3" }).id, 3);
  assert.deepEqual(tdo.migrateDb(db, dbPath).changes, [], "already current");
  db.close();
});

test("openDb creates a file database and reopens it at the same schema", () => {
  const dbPath = path.join(tempDir(), "nested", "tdo.db");
  const db = tdo.openDb(dbPath);
  tdo.addItem(db, { project: "local:~/code/widgets", title: "Persisted" });
  db.close();
  const reopened = tdo.openDb(dbPath);
  assert.equal(tdo.listItems(reopened)[0].title, "Persisted");
  reopened.close();
});

test("status notes from two handles on one file both survive", () => {
  const dbPath = path.join(tempDir(), "tdo.db");
  const a = tdo.openDb(dbPath);
  const b = tdo.openDb(dbPath);
  const item = tdo.addItem(a, { project: "local:~/code/widgets", title: "Shared" });
  tdo.setStatus(a, item, "done", "note A");
  tdo.setStatus(b, item, "done", "note B");
  const body = tdo.getItem(a, item).body;
  assert.match(body, /\[done \S+\] note A/);
  assert.match(body, /\[done \S+\] note B/);
  a.close();
  b.close();
});

test("writes take the write lock before reading the item", () => {
  const dbPath = path.join(tempDir(), "tdo.db");
  const db = tdo.openDb(dbPath);
  const holder = tdo.openDb(dbPath);
  const item = tdo.addItem(db, { project: "local:~/code/widgets", title: "Locked" });

  const statements = [];
  const exec = db.exec.bind(db);
  db.exec = (sql) => { statements.push(sql); return exec(sql); };
  tdo.setStatus(db, item, "doing", "started");
  tdo.updateItem(db, item, { title: "Locked still" });
  assert.deepEqual(statements, ["BEGIN IMMEDIATE", "COMMIT", "BEGIN IMMEDIATE", "COMMIT"]);
  delete db.exec;

  db.exec("PRAGMA busy_timeout = 0");
  holder.exec("BEGIN IMMEDIATE");
  assert.throws(() => tdo.setStatus(db, item, "done", "blocked"), /locked|busy/i);
  assert.throws(() => tdo.updateItem(db, item, { title: "blocked" }), /locked|busy/i);
  assert.throws(() => tdo.deleteItem(db, item), /locked|busy/i);
  holder.exec("ROLLBACK");
  const after = tdo.getItem(db, item);
  assert.equal(after.status, "doing");
  assert.equal(after.title, "Locked still");
  assert.doesNotMatch(after.body, /blocked/);

  const removed = tdo.deleteItem(db, item);
  assert.equal(removed.title, "Locked still");
  assert.equal(tdo.getItem(db, item), undefined);
  assert.throws(() => tdo.updateItem(db, item, { title: "gone" }), /No tdo item/);
  assert.throws(() => tdo.deleteItem(db, item), /No tdo item/);
  db.close();
  holder.close();
});

test("formatters render lines, detail, and markdown", () => {
  const db = tdo.openDb(":memory:");
  const item = tdo.addItem(db, { project: "github.com/example/widgets", title: "Fix it", priority: "high", tags: ["ci"], fileRef: "a.ts:1", body: "why" });
  assert.equal(tdo.formatItemLine(item), "#1  high    Fix it  #ci  @ a.ts:1");
  assert.equal(tdo.formatItemLine(item, { showProject: true }), "widgets#1  high    Fix it  #ci  @ a.ts:1");
  assert.match(tdo.formatItemDetail(item), /priority: high[\s\S]*\n\nwhy$/);
  assert.equal(tdo.formatMarkdown([item]), `## github.com/example/widgets\n\n- [ ] #${item.id} Fix it (high #ci \`a.ts:1\`)\n`);
});

test("grouped list renders bold project headers and per-project caps", () => {
  const db = tdo.openDb(":memory:");
  for (const [project, title, priority] of [["github.com/example/widgets", "w-low", "low"], ["github.com/example/widgets", "w-urgent", "urgent"], ["github.com/example/gadgets", "g-high", "high"]]) {
    tdo.addItem(db, { project, title, priority });
  }
  const items = tdo.listItems(db);
  assert.equal(tdo.formatGroupedList(items, { perProject: 1 }), [
    "widgets  github.com/example/widgets · 2 items, 1!",
    "  #2  urgent  w-urgent",
    "  … 1 more (tdo ls --project github.com/example/widgets)",
    "",
    "gadgets  github.com/example/gadgets · 1 item, 1!",
    "  #1  high    g-high",
  ].join("\n"));
  assert.match(tdo.formatGroupedList(items, { color: true }), /^\x1b\[1mwidgets\x1b\[22m/);
  assert.equal(tdo.formatGroupedList([]), "(nothing here)");
  assert.deepEqual(tdo.parseEditorText("title\r\n\r\nbody\n"), { title: "title", body: "body" });
});

test("paths follow XDG base directories with env and config overrides", () => {
  const home = tempDir();
  assert.equal(tdo.getDbPath({}, { home }), path.join(home, ".local", "share", "tdo", "tdo.db"));
  assert.equal(tdo.getConfigPath({}, home), path.join(home, ".config", "tdo", "config.json"));
  assert.equal(tdo.getDbPath({ XDG_DATA_HOME: "/data" }, { home }), path.join("/data", "tdo", "tdo.db"));
  assert.equal(tdo.getConfigPath({ XDG_CONFIG_HOME: "/cfg" }, home), path.join("/cfg", "tdo", "config.json"));
  // Relative XDG values are invalid per the spec and ignored.
  assert.equal(tdo.getDbPath({ XDG_DATA_HOME: "relative" }, { home }), path.join(home, ".local", "share", "tdo", "tdo.db"));
  assert.equal(tdo.getDbPath({ TDO_DB: "/x/y.db" }, { home }), "/x/y.db");
  assert.equal(tdo.getConfigPath({ TDO_CONFIG: "/x/c.json" }, home), "/x/c.json");
});

test("config file sets the database path and project aliases", () => {
  const home = tempDir();
  const env = { XDG_CONFIG_HOME: path.join(home, "cfg") };
  assert.deepEqual(tdo.loadConfig(env, home), { aliases: {} });

  fs.mkdirSync(path.join(home, "cfg", "tdo"), { recursive: true });
  const file = path.join(home, "cfg", "tdo", "config.json");
  fs.writeFileSync(file, JSON.stringify({ db: "~/backlog/tdo.db", aliases: { "github.com/me/widgets": "github.com/example/widgets" } }));
  const config = tdo.loadConfig(env, home);
  assert.equal(config.db, path.join(home, "backlog", "tdo.db"));
  assert.equal(tdo.getDbPath(env, { home }), path.join(home, "backlog", "tdo.db"));
  assert.equal(tdo.getDbPath({ ...env, TDO_DB: "/override.db" }, { home }), "/override.db");
  assert.equal(tdo.resolveProject(home, { env: { TDO_PROJECT: "github.com/me/widgets" }, home, config }).key, "github.com/example/widgets");

  fs.writeFileSync(file, "{ nope");
  assert.throws(() => tdo.loadConfig(env, home), /invalid JSON/);
  for (const floating of [true, false]) {
    fs.writeFileSync(file, JSON.stringify({ floating }));
    assert.equal(tdo.loadConfig(env, home).floating, floating);
  }
  for (const floating of ["true", 1, null, {}]) {
    fs.writeFileSync(file, JSON.stringify({ floating }));
    assert.throws(() => tdo.loadConfig(env, home), /"floating" must be a boolean/);
  }
  fs.writeFileSync(file, JSON.stringify({ perProject: 3 }));
  assert.equal(tdo.loadConfig(env, home).perProject, 3);
  fs.writeFileSync(file, JSON.stringify({ perProject: -1 }));
  assert.throws(() => tdo.loadConfig(env, home), /"perProject" must be a non-negative integer/);
  fs.writeFileSync(file, JSON.stringify({ aliases: { a: 1 } }));
  assert.throws(() => tdo.loadConfig(env, home), /"aliases" must map/);
});
