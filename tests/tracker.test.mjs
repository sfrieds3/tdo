import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const { run } = await import("../src/cli.ts");
const core = await import("../src/core.ts");
const { resolveTracker, approvalHash, normalizeDestination, parseOverride } = await import("../src/trackers/config.ts");
const { pushItem, renderIssue } = await import("../src/trackers/sync.ts");
const { createStore } = await import("../src/store.ts");

const KEY = "github.com/example/widgets";

/**
 * A git repo with a GitHub remote, a `.tdo/config.json`, and a fake `gh` on PATH.
 * The fake logs argv + stdin as JSON lines and behaves per GH_MODE.
 */
function harness(t, { tracker = { provider: "github" }, mode = "ok" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdo-tracker-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, ".tdo"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", `git@github.com:example/widgets.git`]);
  if (tracker !== undefined) fs.writeFileSync(path.join(repo, ".tdo", "config.json"), JSON.stringify({ tracker }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "gh.log");
  fs.writeFileSync(path.join(bin, "gh"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args.includes('-') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.GH_LOG, JSON.stringify({ args, input }) + '\\n');
const mode = process.env.GH_MODE;
if (args[0] === 'auth') { if (mode === 'noauth') { console.error('not logged in'); process.exit(1); } process.exit(0); }
if (args[0] === 'issue' && args[1] === 'create') {
  if (mode === 'fail') { console.error('HTTP 502: something broke'); process.exit(1); }
  if (mode === 'garbage') { console.log('Creating issue...'); process.exit(0); }
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  const n = fs.readFileSync(process.env.GH_LOG, 'utf8').split('\\n').filter((l) => l.includes('"create"')).length;
  console.log('https://github.com/example/widgets/issues/' + (100 + n));
  process.exit(0);
}
if (args[0] === 'issue') { if (process.env.GH_OP_ERROR) { console.error(process.env.GH_OP_ERROR); process.exit(1); } if (mode === 'op-hang') { setInterval(() => {}, 1000); return; } if (mode === 'fail') { console.error('HTTP 502: offline'); process.exit(1); } if (mode === 'noauth') { console.error('HTTP 401: unauthorized'); process.exit(1); } process.exit(0); }
console.error('unexpected gh call'); process.exit(3);
`, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, GH_LOG: log, GH_MODE: mode, TDO_DB: path.join(dir, "tdo.db"), XDG_CONFIG_HOME: path.join(dir, "config"), HOME: dir };
  const errors = [];
  const answers = [];
  const cli = (...argv) => {
    const out = [];
    let code;
    try {
      code = run(argv, { out: (text) => out.push(text), err: (text) => errors.push(text), confirm: () => answers.shift(), cwd: repo, env, tty: true });
    } catch (error) {
      return { code: error.constructor.name === "Cancelled" ? 130 : 1, out: out.join("\n"), error };
    }
    return { code, out: out.join("\n"), json: () => JSON.parse(out.join("\n")) };
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const creates = () => calls().filter((call) => call.args[1] === "create");
  const userConfig = () => JSON.parse(fs.readFileSync(path.join(dir, "config", "tdo", "config.json"), "utf8"));
  return { dir, repo, env, cli, calls, creates, errors, answers, userConfig };
}

const project = (root) => ({ key: KEY, name: "widgets", root });

test("tracker config: destinations, validation, merge, and defaults", (t) => {
  assert.equal(normalizeDestination("Example/widgets"), "github.com/Example/widgets");
  assert.equal(normalizeDestination("GHE.example.com/team/repo"), "ghe.example.com/team/repo");
  assert.equal(normalizeDestination("not a repo"), undefined);
  assert.throws(() => parseOverride({ provider: "jira" }, "f"), /provider/);
  assert.throws(() => parseOverride({ labels: [""] }, "f"), /labels/);
  assert.throws(() => parseOverride({ closeOnDone: "yes" }, "f"), /closeOnDone/);
  assert.deepEqual(parseOverride({ provider: "github", tag: "#Issue", extra: 1 }, "f"), { provider: "github", tag: "issue" });

  const h = harness(t, { tracker: { provider: "github", labels: ["tdo"] } });
  const resolved = resolveTracker(project(h.repo), { aliases: {}, projects: { [KEY]: { tracker: { tag: "gh" } } } });
  assert.equal(resolved.kind, "ok");
  assert.equal(resolved.tracker.destination, KEY);
  assert.equal(resolved.tracker.tag, "gh");
  assert.deepEqual(resolved.tracker.labels, ["tdo"]);
  assert.equal(resolved.tracker.mode, "manual");
  assert.equal(resolved.tracker.sources.tag, "user");
  assert.equal(resolved.tracker.approval, "unapproved");

  assert.equal(resolveTracker(project(h.repo), { aliases: {}, projects: { [KEY]: { tracker: false } } }).kind, "disabled");
  assert.equal(resolveTracker({ key: "gitlab.com/a/b", name: "b", root: h.repo }, { aliases: {} }).kind, "invalid", "non-GitHub key needs tracker.repo");
  fs.writeFileSync(path.join(h.repo, ".tdo", "config.json"), JSON.stringify({ tracker: { labels: [] } }));
  assert.match(resolveTracker(project(h.repo), { aliases: {} }).error, /provider is required/);
});

test("an approval-only user entry is not an override once the repo tracker is removed", (t) => {
  const h = harness(t);
  const config = { aliases: {}, projects: { [KEY]: { tracker: { approved: approvalHash({ provider: "github" }, project(h.repo)) } } } };
  const resolved = resolveTracker(project(h.repo), config);
  assert.equal(resolved.tracker.approval, "approved");
  assert.equal(resolved.tracker.origin, "repo");
  fs.rmSync(path.join(h.repo, ".tdo", "config.json"));
  assert.equal(resolveTracker(project(h.repo), config).kind, "none");
});

test("force claims are a superset of create claims; attach matches destinations case-insensitively", () => {
  const db = core.openDb(":memory:");
  const item = core.addItem(db, { project: KEY, title: "forced retry" });
  const claim = core.claimLinkCreate(db, item, "github", KEY, "create");
  core.finishLinkCreate(db, item, "github", claim.token, { ok: false, kind: "attention", message: "no auth" });
  assert.ok(core.claimLinkCreate(db, item, "github", KEY, "force").token, "force can retry an error link");
  db.prepare("UPDATE links SET claimed_at = '2000-01-01T00:00:00.000Z'").run();
  const attached = core.attachLink(db, item, "github", KEY.toUpperCase().replace("GITHUB.COM", "github.com"), "7", "u7");
  assert.equal(attached.destination, KEY);
  assert.throws(() => core.attachLink(db, item, "github", "github.com/example/other", "8", "u8"), /is bound to/);
  db.close();
});

test("approval hash ignores spelling and unknown keys but pins the destination", (t) => {
  const h = harness(t);
  const base = approvalHash({ provider: "github" }, project(h.repo));
  assert.equal(approvalHash(parseOverride({ provider: "github", closeOnDone: true, labels: [], mode: "manual", junk: 1 }, "f"), project(h.repo)), base);
  assert.equal(approvalHash({ provider: "github", labels: ["b", "a"] }, project(h.repo)), approvalHash({ provider: "github", labels: ["a", "b"] }, project(h.repo)));
  assert.notEqual(approvalHash({ provider: "github", repo: "other/repo" }, project(h.repo)), base);
  assert.notEqual(approvalHash({ provider: "github" }, { ...project(h.repo), key: "github.com/example/fork" }), base, "derived destination is pinned");
});

test("push requires approval; approve/revoke write the user config and preserve other keys", (t) => {
  const h = harness(t);
  fs.mkdirSync(path.join(h.dir, "config", "tdo"), { recursive: true });
  fs.writeFileSync(path.join(h.dir, "config", "tdo", "config.json"), JSON.stringify({ perProject: 7, mystery: true }));
  h.cli("add", "first");

  h.answers.push(false);
  assert.equal(h.cli("push", "1").code, 130, "declined approval cancels");
  assert.equal(h.creates().length, 0, "nothing filed without approval");
  assert.match(h.errors.join("\n"), /wants to file issues/);

  const status = h.cli("tracker", "status", "--json").json();
  assert.equal(status.tracker.approval, "unapproved");
  assert.equal(status.tracker.destination, KEY);

  assert.equal(h.cli("tracker", "approve", "--yes").code, 0);
  const saved = h.userConfig();
  assert.equal(saved.perProject, 7);
  assert.equal(saved.mystery, true);
  assert.match(saved.projects[KEY].tracker.approved, /^sha256:/);
  assert.equal(h.cli("tracker", "status", "--json").json().tracker.approval, "approved");

  // Editing the committed block invalidates approval.
  fs.writeFileSync(path.join(h.repo, ".tdo", "config.json"), JSON.stringify({ tracker: { provider: "github", repo: "attacker/repo" } }));
  assert.equal(h.cli("tracker", "status", "--json").json().tracker.approval, "changed");
  fs.writeFileSync(path.join(h.repo, ".tdo", "config.json"), JSON.stringify({ tracker: { provider: "github" } }));

  assert.equal(h.cli("tracker", "revoke").code, 0);
  assert.equal(h.userConfig().projects, undefined);
  assert.equal(h.userConfig().perProject, 7);
});

test("approve without a terminal needs --yes", (t) => {
  const h = harness(t);
  const out = [];
  assert.throws(() => run(["tracker", "approve"], { out: (text) => out.push(text), err: () => {}, cwd: h.repo, env: h.env }), /no terminal/);
});

test("push files a clean issue, records the link, and is idempotent", (t) => {
  const h = harness(t, { tracker: { provider: "github", labels: ["tdo", "backlog"] } });
  h.cli("tracker", "approve", "--yes");
  h.cli("add", "flaky login test", "-b", "Races the token refresh.", "-f", "src/auth.ts:88");
  h.cli("done", "1", "-m", "never mind");
  h.cli("reopen", "1", "-m", "it's back");

  const [result] = h.cli("push", "1", "--json").json();
  assert.deepEqual([result.ok, result.state, result.url], [true, "open", "https://github.com/example/widgets/issues/101"]);
  const [create] = h.creates();
  assert.deepEqual(create.args, ["issue", "create", "--repo", KEY, "--title", "flaky login test", "--body-file", "-", "--label", "tdo", "--label", "backlog"]);
  assert.equal(create.input, "Races the token refresh.\n\n`src/auth.ts:88`", "body has no notes and no tdo markers");
  assert.ok(h.calls().some((call) => call.args[0] === "auth"), "preflight auth check");

  assert.equal(h.cli("push", "1").out, "#1: https://github.com/example/widgets/issues/101");
  assert.equal(h.creates().length, 1, "second push files nothing");
  assert.match(h.cli("ls").out, /flaky login test {2}↗#101/);
  assert.deepEqual(h.cli("ls", "--linked", "--json").json().map((item) => item.id), [1]);
  assert.match(h.cli("show", "1").out, /issue: {4}https:\/\/github\.com\/example\/widgets\/issues\/101 \(open\)/);
});

test("uncertain create failures become unknown and are never retried automatically", (t) => {
  const h = harness(t, { mode: "fail" });
  h.cli("tracker", "approve", "--yes");
  h.cli("add", "one");
  const failed = h.cli("push", "1", "--json");
  assert.equal(failed.code, 1);
  assert.equal(failed.json()[0].state, "unknown");
  assert.match(failed.json()[0].error, /--attach URL.*--force/);

  h.env.GH_MODE = "ok";
  assert.equal(h.cli("push", "1").code, 1, "plain push refuses an unknown link");
  assert.equal(h.creates().length, 1);
  assert.match(h.cli("ls").out, /one {2}↗!/);

  // The user checked GitHub and found nothing: --force files it.
  const forced = h.cli("push", "1", "--force", "--json").json()[0];
  assert.equal(forced.state, "open");
  assert.equal(h.creates().length, 2);
  assert.equal(h.cli("push", "1", "--force").code, 1, "--force does nothing to an open link");
});

test("unparseable gh output is uncertain; missing gh or auth is known-not-created", (t) => {
  const h = harness(t, { mode: "garbage" });
  h.cli("tracker", "approve", "--yes");
  h.cli("add", "one");
  h.cli("add", "two");
  assert.equal(h.cli("push", "1", "--json").json()[0].state, "unknown");

  h.env.GH_MODE = "noauth";
  const noauth = h.cli("push", "2", "--json").json()[0];
  assert.equal(noauth.state, "error");
  assert.match(noauth.error, /not authenticated/);
  assert.equal(h.creates().length, 1, "auth failure stops before issue create");

  h.env.GH_MODE = "ok";
  assert.equal(h.cli("push", "2", "--json").json()[0].state, "open", "error links can be pushed again");

  h.env.PATH = "/nonexistent";
  h.cli("add", "three");
  assert.match(h.cli("push", "3", "--json").json()[0].error, /gh is not installed/);
});

test("--attach records a known issue and rejects other repos; --detach forgets the link", (t) => {
  const h = harness(t, { mode: "fail" });
  h.cli("tracker", "approve", "--yes");
  h.cli("add", "one");
  h.cli("push", "1");
  assert.match(h.cli("push", "1", "--attach", "https://github.com/someone/else/issues/9").error.message, /files to github\.com\/example\/widgets/);
  assert.match(h.cli("push", "1", "--attach", "https://example.com/nope").error.message, /not an issue URL/);
  const attached = h.cli("push", "1", "--attach", "https://github.com/example/widgets/issues/55", "--json").json()[0];
  assert.deepEqual([attached.state, attached.url], ["open", "https://github.com/example/widgets/issues/55"]);
  assert.equal(h.creates().length, 1);
  assert.match(h.cli("push", "1", "--detach").out, /detached \(left https:\/\/github\.com\/example\/widgets\/issues\/55 as is\)/);
  assert.deepEqual(h.cli("show", "1", "--json").json().links, []);
  assert.match(h.cli("push", "1", "--force", "--detach").error.message, /can't be combined/);
});

test("links keep their destination after the config changes", (t) => {
  const h = harness(t, { mode: "fail" });
  h.cli("tracker", "approve", "--yes");
  h.cli("add", "one");
  h.cli("push", "1");
  fs.writeFileSync(path.join(h.repo, ".tdo", "config.json"), JSON.stringify({ tracker: { provider: "github", repo: "example/elsewhere" } }));
  h.cli("tracker", "approve", "--yes");
  h.env.GH_MODE = "ok";
  h.cli("push", "1", "--force");
  assert.equal(h.creates().at(-1).args[3], KEY, "the forced retry goes to the link's original repo");
});

test("closed items reconcile while other projects require their own checkout", (t) => {
  const h = harness(t);
  h.cli("tracker", "approve", "--yes");
  h.cli("add", "one");
  h.cli("done", "1");
  assert.match(h.cli("push", "1").out, /https:\/\/github.com\/example\/widgets\/issues\/101/);
  assert.equal(h.cli("show", "1", "--json").json().links[0].state, "closed");
  h.cli("add", "elsewhere", "--project", "github.com/example/other");
  assert.match(h.cli("push", "other#1").out, /run tdo push from that project/);
  assert.equal(h.creates().length, 1);
});

test("concurrent claims: only one caller gets a token; superseded completions are ignored", () => {
  const db = core.openDb(":memory:");
  const item = core.addItem(db, { project: KEY, title: "race" });
  const first = core.claimLinkCreate(db, item, "github", KEY, "create");
  const second = core.claimLinkCreate(db, item, "github", KEY, "create");
  assert.ok(first.token);
  assert.equal(second.token, undefined);
  assert.equal(second.link.state, "creating");
  assert.throws(() => core.detachLink(db, item, "github"), /being filed right now/);

  // Simulate a crash: the claim goes stale, a later command marks it unknown, the user forces.
  db.prepare("UPDATE links SET claimed_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal(core.expireStaleClaims(db, KEY), 1);
  assert.equal(core.getLink(db, item, "github").state, "unknown");
  const forced = core.claimLinkCreate(db, item, "github", KEY, "force");
  assert.ok(forced.token);
  assert.equal(core.finishLinkCreate(db, item, "github", first.token, { ok: true, externalId: "1", url: "u1" }), undefined, "the stale attempt can't overwrite");
  assert.equal(core.finishLinkCreate(db, item, "github", forced.token, { ok: true, externalId: "2", url: "u2" }).externalId, "2");

  // An error link is claimed by exactly one retry, too.
  const other = core.addItem(db, { project: KEY, title: "retry" });
  const claim = core.claimLinkCreate(db, other, "github", KEY, "create");
  core.finishLinkCreate(db, other, "github", claim.token, { ok: false, kind: "attention", message: "no auth" });
  const retries = [core.claimLinkCreate(db, other, "github", KEY, "create"), core.claimLinkCreate(db, other, "github", KEY, "create")];
  assert.deepEqual(retries.map((retry) => !!retry.token), [true, false]);
  db.close();
});

test("pushItem warns with the URL when a finished create can't be recorded", (t) => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const item = store.call("addItem", { project: KEY, title: "orphan" });
  const warnings = [];
  const config = { provider: "github", destination: KEY, labels: [], approval: "user-only", closeOnDone: true };
  const fakeTracker = () => ({ provider: "github", check: () => ({ ok: true }), parseIssueUrl: () => undefined, create: () => ({ ok: true, value: { id: "7", url: "https://github.com/example/widgets/issues/7" } }) });
  const failing = { call: (op, ...args) => { if (op === "finishLinkCreate") throw new Error("database is locked"); return store.call(op, ...args); }, close() {} };
  const result = pushItem(failing, item, config, { warn: (text) => warnings.push(text), tracker: fakeTracker });
  assert.equal(result.ok, false);
  assert.equal(result.url, "https://github.com/example/widgets/issues/7");
  assert.match(result.error, /locked/);
  assert.match(warnings[0], /filed https:\/\/github\.com\/example\/widgets\/issues\/7 but couldn't record it.*--attach/);
  assert.equal(store.call("getLink", item, "github").state, "creating", "left for stale detection");
  assert.deepEqual(renderIssue({ ...item, body: null, fileRef: null }, ["x"]), { title: "orphan", body: "", labels: ["x"] });
});

test("notes: tdo note, show, export, search, and body edits keep note text searchable", (t) => {
  const h = harness(t, { tracker: undefined });
  h.cli("add", "alpha item", "-b", "original body");
  assert.match(h.cli("note", "1", "found", "the", "zebra", "cause").out, /^noted #1/);
  h.cli("done", "1", "-m", "fixed via quokka patch");
  const shown = h.cli("show", "1").out;
  assert.match(shown, /original body\n\nnotes:\n {2}\d{4}-\d{2}-\d{2} note {4}found the zebra cause\n {2}\d{4}-\d{2}-\d{2} done {4}fixed via quokka patch$/);
  h.cli("edit", "1", "-b", "rewritten penguin body");
  for (const word of ["zebra", "quokka", "penguin"]) assert.deepEqual(h.cli("ls", "-s", "all", "-q", word, "--json").json().map((item) => item.id), [1], word);
  assert.deepEqual(h.cli("ls", "-s", "all", "-q", "original", "--json").json(), []);
  assert.match(h.cli("export", "--md").out, /- \d{4}-\d{2}-\d{2} done: fixed via quokka patch/);
  assert.equal(h.cli("export").json()[0].notes.length, 2);
  assert.match(h.cli("note", "1").error.message, /needs text/);
});

test("add records whether a person added the item", (t) => {
  const h = harness(t, { tracker: undefined });
  h.cli("add", "by hand");
  h.cli("add", "by agent", "--source", "claude");
  const db = core.openDb(h.env.TDO_DB);
  const rows = db.prepare("SELECT id, created_by_human FROM items ORDER BY id").all().map((row) => [row.id, row.created_by_human]);
  db.close();
  assert.deepEqual(rows, [[1, 1], [2, 0]]);
});

test("v3: fresh and v2-upgraded databases match, and a failing v2 -> v3 conversion rolls back", async (t) => {
  const { SCHEMA_V2 } = await import("../src/migrations/v2.ts");
  const v3 = await import("../src/migrations/v3.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdo-v3-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const v2Path = path.join(dir, "v2.db");
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(v2Path);
  raw.exec(SCHEMA_V2);
  raw.exec(`INSERT INTO projects (id, key, created_at) VALUES ('p', 'a', 'x');
    INSERT INTO items (project_id, id, title, body, created_at, updated_at) VALUES ('p', 1, 't', 'b

[done 2026-01-01] n', 'x', 'x');
    PRAGMA user_version = 2;`);
  raw.close();

  // Fresh v0 -> 2 -> 3 and upgraded 2 -> 3 end with identical schema objects.
  const upgraded = core.openDb(v2Path);
  const fresh = core.openDb(":memory:");
  const schema = (db) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all();
  assert.deepEqual(schema(upgraded), schema(fresh));
  assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
  upgraded.close();
  fresh.close();

  // A failure after the v3 DDL leaves the v2 database untouched.
  const { runMigrations } = await import("../src/migrations/index.ts");
  const failPath = path.join(dir, "fail.db");
  const seed = new DatabaseSync(failPath);
  seed.exec(SCHEMA_V2);
  seed.exec("INSERT INTO projects (id, key, created_at) VALUES ('p', 'a', 'x'); INSERT INTO items (project_id, id, title, body, created_at, updated_at) VALUES ('p', 1, 't', '[done 2026-01-01] n', 'x', 'x'); PRAGMA user_version = 2;");
  seed.close();
  const db = core.openDb(failPath, { migrate: false });
  t.after(() => db.close());
  const before = schema(db);
  assert.throws(() => runMigrations(db, failPath, [{ from: 2, to: 3, apply: (inner) => { v3.migrateToV3(inner); throw new Error("boom"); } }], 3), /boom/);
  assert.equal(core.schemaVersion(db), 2);
  assert.deepEqual(schema(db), before);
  assert.equal(db.prepare("SELECT body FROM items").get().body, "[done 2026-01-01] n");
});

test("v2 databases migrate to v3, moving trailing status notes out of bodies", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdo-v2-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "tdo.db");
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(dbPath);
  // A real v2 database, built from the frozen v2 schema.
  const { SCHEMA_V2 } = await import("../src/migrations/v2.ts");
  raw.exec(SCHEMA_V2);
  raw.exec(`INSERT INTO projects (id, key, display_name, next_item_id, created_at) VALUES ('p', 'a', 'a', 5, 'x');
    INSERT INTO items (project_id, id, title, body, status, created_at, updated_at) VALUES
      ('p', 1, 'plain', 'just a body', 'open', 'x', 'x'),
      ('p', 2, 'noted', 'context here

[doing 2026-01-02] started on it

[done 2026-01-03] fixed it', 'done', 'x', 'x'),
      ('p', 3, 'ambiguous', '[done 2026-01-01] looks like a note

but this paragraph is user text', 'open', 'x', 'x'),
      ('p', 4, 'only notes', '[dropped 2026-02-02] not needed', 'dropped', 'x', 'x');
    PRAGMA user_version = 2;`);
  raw.close();

  const env = { TDO_DB: dbPath, TDO_PROJECT: "a", XDG_CONFIG_HOME: path.join(dir, "config") };
  const tdo = (...argv) => { const out = []; run(argv, { out: (text) => out.push(text), cwd: dir, env }); return out.join("\n"); };
  assert.match(tdo("migrate", "--dry-run"), /would upgrade schema v2 -> v3\.\nno ids changed\.\nwould move 3 status notes/);
  assert.match(tdo("migrate"), /upgraded schema v2 -> v3\.\nbackup: .*v2-backup.*\nno ids changed\.\nmoved 3 status notes/);
  const items = JSON.parse(tdo("export", "--json"));
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));
  assert.equal(byId[1].body, "just a body");
  assert.equal(byId[2].body, "context here");
  assert.deepEqual(byId[2].notes.map((note) => [note.status, note.body, note.createdAt]), [["doing", "started on it", "2026-01-02T00:00:00.000Z"], ["done", "fixed it", "2026-01-03T00:00:00.000Z"]]);
  assert.match(byId[3].body, /looks like a note\n\nbut this paragraph/, "a non-note last paragraph stops extraction");
  assert.equal(byId[4].body, null);
  assert.equal(byId[4].notes[0].body, "not needed");
  assert.deepEqual(JSON.parse(tdo("ls", "-s", "all", "-q", "fixed", "--json")).map((item) => item.id), [2], "moved notes are searchable once");
  assert.equal(tdo("add", "fresh", "--json").includes('"id": 5'), true);
});

test("ordinary mutations commit and emit one JSON document even when GitHub is offline", (t) => {
  const h = harness(t);
  h.cli("tracker", "approve", "--yes");
  h.cli("add", "local wins");
  h.cli("push", "1");
  h.env.GH_MODE = "fail";
  const done = h.cli("done", "1", "-m", "fixed locally", "--json");
  assert.equal(done.code, 0);
  assert.equal(done.json().status, "done");
  assert.equal(done.json().notes[0].body, "fixed locally");
  assert.match(h.errors.at(-1), /sync paused.*saved/);
  assert.equal(h.cli("show", "1", "--json").json().links[0].queued, 2);
  assert.match(h.cli("ls", "-s", "all").out, /↗…/);
  h.env.GH_MODE = "ok";
  assert.equal(h.cli("reopen", "1", "--json").code, 0);
  const sent = h.calls().filter((call) => ["close", "reopen"].includes(call.args[1]));
  assert.deepEqual(sent.map((call) => call.args[1]), ["close", "reopen"]);
  assert.equal(h.cli("show", "1", "--json").json().links[0].state, "open");
});

test("no-sync queues durable lifecycle changes and sync uses persisted destination after config changes", (t) => {
  const h = harness(t);
  h.cli("tracker", "approve", "--yes");
  h.cli("add", "bound");
  h.cli("push", "1");
  const before = h.calls().length;
  h.cli("edit", "1", "--title", "edited offline", "--no-sync", "--json");
  h.cli("note", "1", "queued note", "--no-sync");
  h.cli("done", "1", "--no-sync");
  assert.equal(h.calls().length, before);
  fs.writeFileSync(path.join(h.repo, ".tdo", "config.json"), JSON.stringify({ tracker: { provider: "github", repo: "elsewhere/repo" } }));
  h.cli("reopen", "1", "--json");
  assert.equal(h.calls().length, before, "changed approval blocks all delivery");
  assert.equal(h.cli("sync", "--json").code, 1);
  h.cli("tracker", "approve", "--yes");
  const status = h.cli("tracker", "status", "--json").json();
  assert.equal(status.sync.queued, 4);
  assert.deepEqual(status.sync.differentDestination, [1]);
  const synced = h.cli("sync", "--json");
  assert.equal(synced.code, 0);
  assert.equal(synced.json()[0].sent, 4);
  const mutations = h.calls().slice(before).filter((call) => call.args[0] === "issue");
  assert.deepEqual(mutations.map((call) => call.args[1]), ["edit", "comment", "close", "reopen"]);
  for (const call of mutations) assert.equal(call.args[call.args.indexOf("--repo") + 1], KEY);
  assert.equal(mutations[0].args[mutations[0].args.indexOf("--title") + 1], "edited offline");
});

test("permanent operation failure requires sync --retry and closeOnDone false only posts the note", (t) => {
  const h = harness(t, { tracker: { provider: "github", closeOnDone: false } });
  h.cli("tracker", "approve", "--yes");
  h.cli("add", "permission");
  h.cli("push", "1");
  h.env.GH_MODE = "noauth";
  assert.equal(h.cli("done", "1", "-m", "finished", "--json").code, 0);
  assert.equal(h.cli("show", "1", "--json").json().links[0].attention, 1);
  assert.match(h.cli("show", "1").out, /401.*unauthorized/);
  assert.match(h.cli("ls", "-s", "all").out, /↗!/);
  const before = h.calls().length;
  h.env.GH_MODE = "ok";
  assert.equal(h.cli("sync", "--json").code, 1);
  assert.equal(h.calls().length, before, "attention must not be silently retried");
  assert.equal(h.cli("sync", "--retry", "--json").code, 0);
  assert.equal(h.calls().at(-1).args[1], "comment");
  assert.equal(h.calls().some((call) => call.args[1] === "close"), false);
});

test("GitHub lifecycle methods use argv/stdin safely and classify recoverable versus attention errors", async (t) => {
  const h = harness(t);
  const { githubTracker } = await import("../src/trackers/github.ts");
  const gh = githubTracker({ destination: "enterprise.test/owner/repo", env: h.env, timeoutMs: 300 });
  const title = "title $(touch never) --shell";
  const body = "body `not executed`\nwith newlines";
  assert.equal(gh.update("42", { title, body }).ok, true);
  assert.equal(gh.comment("42", body).ok, true);
  assert.equal(gh.close("42", "not planned").ok, true);
  assert.equal(gh.reopen("42").ok, true);
  const calls = h.calls();
  assert.deepEqual(calls[0], { args: ["issue", "edit", "42", "--title", title, "--body-file", "-", "--repo", "enterprise.test/owner/repo"], input: body });
  assert.equal(calls[1].input, body);
  assert.deepEqual(calls[2].args.slice(0, 5), ["issue", "close", "42", "--reason", "not planned"]);
  for (const message of ["HTTP 429: slow down", "HTTP 403: API rate limit exceeded", "timeout connecting", "Could not resolve host: api.github.com", "HTTP 502: bad gateway", "unrecognized failure"]) {
    h.env.GH_OP_ERROR = message;
    assert.equal(gh.reopen("42").kind, "retryable", message);
  }
  for (const message of ["HTTP 401: authentication required", "HTTP 403: forbidden", "HTTP 404: Not Found", "GraphQL: Could not resolve to a Repository", "issue was transferred", "issue deleted"]) {
    h.env.GH_OP_ERROR = message;
    assert.equal(gh.close("42", "completed").kind, "attention", message);
  }
  delete h.env.GH_OP_ERROR;
  h.env.GH_MODE = "op-hang";
  assert.equal(gh.comment("42", body).kind, "retryable", "lost comment response is retryable, not uncertain create");
});

test("cross-project mutation never borrows the current checkout's approval to drain", (t) => {
  const h = harness(t);
  h.cli("tracker", "approve", "--yes");
  h.cli("add", "other", "--project", "github.com/example/other");
  const store = createStore(h.env.TDO_DB);
  const item = store.call("findItem", "1", "github.com/example/other");
  store.call("attachLink", item, "github", "github.com/example/other", "7", "https://github.com/example/other/issues/7");
  store.close();
  core.updateConfig((raw) => ({ ...raw, projects: { ...raw.projects, "github.com/example/other": { tracker: { provider: "github", closeOnDone: true } } } }), h.env);
  const before = h.calls().length;
  assert.equal(h.cli("done", "other#1", "--json").code, 0);
  assert.equal(h.calls().length, before);
  assert.equal(h.cli("show", "other#1", "--json").json().links[0].queued, 1);
});


test("foreign linked status uses its user policy, not the checkout policy", (t) => {
  const h = harness(t, { tracker: { provider: "github", closeOnDone: true } });
  h.cli("add", "local");
  for (const [name, closeOnDone] of [["yes", true], ["no", false]]) {
    const key = `github.com/example/${name}`;
    h.cli("add", name, "--project", key);
    const store = createStore(h.env.TDO_DB);
    const item = store.call("findItem", "1", key);
    store.call("attachLink", item, "github", key, "7", `https://${key}/issues/7`);
    store.close();
    core.updateConfig((raw) => ({ ...raw, projects: { ...raw.projects, [key]: { tracker: { provider: "github", closeOnDone } } } }), h.env);
  }
  assert.equal(h.cli("done", "yes#1", "no#1", "--no-sync").code, 0);
  assert.equal(h.cli("show", "yes#1", "--json").json().links[0].queued, 1);
  assert.equal(h.cli("show", "no#1", "--json").json().links[0].queued, 0);
  // Reverse the checkout policy too: neither direction may override the foreign policy.
  fs.writeFileSync(path.join(h.repo, ".tdo", "config.json"), JSON.stringify({ tracker: { provider: "github", closeOnDone: false } }));
  assert.equal(h.cli("reopen", "yes#1", "no#1", "--no-sync").code, 0);
  assert.equal(h.cli("show", "yes#1", "--json").json().links[0].queued, 2);
  assert.equal(h.cli("show", "no#1", "--json").json().links[0].queued, 0);
});

test("unknown foreign linked lifecycle policy refuses the entire selection before writes", (t) => {
  const h = harness(t);
  h.cli("add", "local");
  h.cli("add", "foreign", "--project", "github.com/example/other");
  const store = createStore(h.env.TDO_DB);
  const foreign = store.call("findItem", "1", "github.com/example/other");
  store.call("attachLink", foreign, "github", foreign.project, "7", "url");
  store.close();
  for (const command of ["done", "drop", "reopen"]) {
    const result = h.cli(command, "1", "other#1", "-m", "must not write", "--no-sync");
    assert.equal(result.code, 1);
    assert.match(result.error.message, /run from its project checkout or configure project tracker/);
    assert.equal(h.cli("show", "1", "--json").json().status, "open");
    assert.deepEqual(h.cli("show", "1", "--json").json().notes, []);
    assert.deepEqual(h.cli("show", "other#1", "--json").json().notes, []);
  }
  assert.equal(h.cli("start", "other#1").code, 0, "start has no close/reopen intent");
  h.cli("add", "unlinked", "--project", "github.com/example/plain");
  assert.equal(h.cli("done", "plain#1").code, 0, "unlinked foreign items need no tracker policy");
  core.updateConfig((raw) => ({ ...raw, projects: { ...raw.projects, [foreign.project]: { tracker: { provider: "github", approved: "repo-hash" } } } }), h.env);
  assert.match(h.cli("done", "other#1").error.message, /policy is unknown/, "a repo approval cannot reconstruct missing repository policy");
});
