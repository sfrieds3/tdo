import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const tdo = await import("../src/core.ts");

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
  assert.equal(tdo.resolveProject(repo, { env, home }).key, "local:~/code/widgets");

  git(repo, "init", "-q");
  assert.equal(tdo.resolveProject(repo, { env, home }).key, "local:~/code/widgets");

  git(repo, "remote", "add", "upstream", "https://github.com/upstream/widgets.git");
  git(repo, "remote", "add", "origin", "git@github.com:example/widgets.git");
  const sub = path.join(repo, "src");
  fs.mkdirSync(sub);
  const project = tdo.resolveProject(sub, { env, home });
  assert.equal(project.key, "github.com/example/widgets");
  assert.equal(project.name, "widgets");
  assert.equal(fs.realpathSync(project.root), fs.realpathSync(repo));

  fs.mkdirSync(path.join(repo, ".pi"));
  fs.writeFileSync(path.join(repo, ".pi", "tdo-project"), "example/custom\n");
  assert.equal(tdo.resolveProject(sub, { env, home }).key, "example/custom");

  assert.equal(tdo.resolveProject(sub, { env: { TDO_PROJECT: "forced" }, home }).key, "forced");
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

  const updated = tdo.updateItem(db, b.id, { title: "Refactor settings loader", priority: "low", addTags: ["Perf"], removeTags: ["cleanup"] });
  assert.equal(updated.priority, "low");
  assert.deepEqual(updated.tags, ["perf"]);
  assert.deepEqual(tdo.listItems(db, { query: "settings" }).map((item) => item.id), [b.id]);
  assert.deepEqual(tdo.listItems(db, { query: "config" }), []);

  const doing = tdo.setStatus(db, b.id, "doing");
  assert.equal(doing.closedAt, null);
  assert.equal(tdo.listItems(db, { project: project.key })[0].id, b.id, "doing items sort first");

  const done = tdo.setStatus(db, a.id, "done", "fixed by retry");
  assert.ok(done.closedAt);
  assert.match(done.body, /\[done \d{4}-\d{2}-\d{2}\] fixed by retry/);
  assert.deepEqual(tdo.listItems(db, { project: project.key }).map((item) => item.id), [b.id, c.id]);
  assert.deepEqual(tdo.listItems(db, { project: project.key, status: "closed" }).map((item) => item.id), [a.id]);
  assert.equal(tdo.setStatus(db, a.id, "open").closedAt, null);

  const counts = tdo.countActive(db, project.key);
  assert.deepEqual(counts, { total: 3, doing: 1, urgent: 1, high: 1, normal: 0, low: 1 });
  assert.equal(tdo.formatCounts(counts), "3 open (1 urgent, 1 high)");
  assert.deepEqual(tdo.listTags(db, project.key), [{ tag: "ci", count: 1 }, { tag: "perf", count: 1 }, { tag: "tests", count: 1 }]);
  assert.deepEqual(tdo.listProjects(db).map((row) => [row.key, row.active]), [[project.key, 3], ["github.com/example/gadgets", 1]]);

  tdo.deleteItem(db, c.id);
  assert.equal(tdo.getItem(db, c.id), undefined);
  assert.deepEqual(tdo.listItems(db, { query: "crash" }), []);

  assert.throws(() => tdo.addItem(db, { project, title: "   " }), /title must not be empty/);
  assert.throws(() => tdo.setStatus(db, 999, "done"), /No tdo item #999/);
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

test("formatters render lines, detail, and markdown", () => {
  const db = tdo.openDb(":memory:");
  const item = tdo.addItem(db, { project: "github.com/example/widgets", title: "Fix it", priority: "high", tags: ["ci"], fileRef: "a.ts:1", body: "why" });
  assert.equal(tdo.formatItemLine(item), `#${item.id}  high    Fix it  #ci  @ a.ts:1`);
  assert.match(tdo.formatItemDetail(item), /priority: high[\s\S]*\n\nwhy$/);
  assert.equal(tdo.formatMarkdown([item]), `## github.com/example/widgets\n\n- [ ] #${item.id} Fix it (high #ci \`a.ts:1\`)\n`);
});
