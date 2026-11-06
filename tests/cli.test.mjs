import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const { run } = await import("../src/cli.ts");
const core = await import("../src/core.ts");
const SCRIPT = new URL("../src/cli.ts", import.meta.url).pathname;
const PROJECT = "github.com/example/widgets";

function harness(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdo-cli-"));
  const env = { TDO_DB: path.join(dir, "tdo.db"), TDO_PROJECT: PROJECT, XDG_CONFIG_HOME: path.join(dir, "config") };
  return (...argv) => {
    const out = [];
    const err = [];
    const code = run(argv, { out: (text) => out.push(text), err: (text) => err.push(text), cwd: dir, env, ...extra });
    return { code, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")) };
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
  assert.match(tdo("show", "1").out, /notes:\n {2}\d{4}-\d{2}-\d{2} done {4}added retries/);
  assert.equal(tdo("count").out, `${PROJECT}: 1 open (1 urgent)`);
  assert.equal(tdo("project").out, PROJECT);
  assert.match(tdo("export", "--md").out, /- \[x\] #1 fix flaky test/);
  assert.equal(tdo("export").json().length, 2);
  assert.match(tdo("projects").out, /1 {2}github\.com\/example\/widgets/);
  assert.match(tdo("ls", "-a").out, /^widgets  github\.com\/example\/widgets · 1 item, 1!\n  #2  urgent  rename helpers/);
  assert.equal(tdo("add", "from an agent", "--source", "claude", "--json").json().source, "claude");
});

test("edit removes tags with ~tag and handles -t=… without creating '=' tags", () => {
  const tdo = harness();
  tdo("add", "tagged", "-t", "foo,bar");
  assert.deepEqual(tdo("edit", "1", "-t", "~foo", "--json").json().tags, ["bar"]);
  assert.deepEqual(tdo("edit", "1", "-t", "+foo,~bar", "--json").json().tags, ["foo"]);
  assert.deepEqual(tdo("edit", "1", "--tags=-foo", "--json").json().tags, []);
  tdo("edit", "1", "-t", "foo");
  assert.deepEqual(tdo("edit", "1", "-t=-foo", "--json").json().tags, []);
  assert.deepEqual(tdo("edit", "1", "-t=baz", "--json").json().tags, ["baz"]);
  assert.deepEqual(tdo("add", "eq", "-t=qux", "--json").json().tags, ["qux"]);
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
  assert.match(dry, /would upgrade schema v1 -> v3/);
  assert.match(dry, /b {2}#2 -> #1 {2}other/);
  assert.match(dry, /a {2}#3 -> #2 {2}second/);
  assert.doesNotMatch(dry, /#1 -> #1/);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes("backup")), [], "dry run writes nothing");

  const done = tdo("migrate");
  assert.match(done, /upgraded schema v1 -> v3/);
  assert.match(done, /backup: .*tdo\.db\.v1-backup-/);
  assert.match(tdo("show", "2"), /^#2 second/);
  assert.match(tdo("migrate"), /already at schema v3/);
});

test("ls -a groups by project, most urgent first, capped per project", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdo-cli-"));
  const env = { TDO_DB: path.join(dir, "tdo.db"), TDO_PROJECT: PROJECT, XDG_CONFIG_HOME: path.join(dir, "config") };
  const tdo = (...argv) => { const out = []; run(argv, { out: (text) => out.push(text), cwd: dir, env }); return out.join("\n"); };
  for (const title of ["a !low", "b", "c !high", "d", "e", "f", "g"]) tdo("add", title);
  tdo("add", "only one !urgent", "--project", "github.com/example/gadgets");

  const grouped = tdo("ls", "-a");
  assert.equal(grouped.split("\n\n")[0].split("\n")[0], "gadgets  github.com/example/gadgets · 1 item, 1!", "most urgent project first");
  const widgets = grouped.split("\n\n")[1].split("\n");
  assert.equal(widgets[0], "widgets  github.com/example/widgets · 7 items, 1!");
  assert.deepEqual(widgets.slice(1, 3), ["  #3  high    c", "  #2  normal  b"]);
  assert.equal(widgets.length, 1 + 5 + 1, "header, 5 items, and a more line");
  assert.equal(widgets.at(-1), "  … 2 more (tdo ls --project github.com/example/widgets -n 0)");

  assert.equal(tdo("ls", "-a", "-n", "2").split("\n\n")[1].split("\n").length, 1 + 2 + 1);
  assert.doesNotMatch(tdo("ls", "-a", "-n", "0"), /more/);
  assert.equal(JSON.parse(tdo("ls", "-a", "-n", "2", "--json")).length, 3);

  fs.mkdirSync(path.join(dir, "config", "tdo"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "tdo", "config.json"), JSON.stringify({ perProject: 1 }));
  assert.match(tdo("ls", "-a"), /… 6 more/);
  // In one project, -n is still a plain limit.
  assert.equal(tdo("ls", "-n", "2").split("\n").length, 3, "two items and a truncation notice");
});

test("list limits disclose actual truncation without changing JSON output", () => {
  const tdo = harness({ color: true });
  tdo("add", "first !high #ci");
  tdo("add", "second #ci");
  tdo("add", "third #ci");
  tdo("add", "closed #ci");
  tdo("done", "4");
  tdo("add", "unrelated", "--project", "other/project");
  const limited = tdo("ls", "-n", "2");
  assert.equal(limited.out.split("\n").length, 3);
  assert.match(limited.out, /\x1b\[2m… more items .*use -n 0/);
  assert.equal(limited.err, "");
  const json = tdo("ls", "--limit=2", "--json");
  assert.deepEqual(json.json().map((item) => item.title), ["first", "second"]);
  assert.match(json.err, /more items/);
  assert.doesNotMatch(json.out, /…|\x1b/);
  for (const args of [["-n", "3"], ["-n", "0"], ["-n", "1", "-q", "first"], ["-n", "1", "-p", "high"], ["-n", "1", "-s", "done"], ["-n", "1", "-t", "absent"]]) {
    const result = tdo("ls", ...args, "--json");
    assert.equal(result.err, "", `no false truncation notice for ${args.join(" ")}`);
  }
  assert.equal(tdo("ls", "-n", "0", "--json").json().length, 3);
  const grouped = tdo("ls", "-a", "-n", "2", "--json");
  assert.deepEqual(grouped.json().map((item) => item.project).sort(), [PROJECT, PROJECT, "other/project"].sort());
  assert.match(grouped.err, /more items/);
  assert.equal(tdo("ls", "-a", "-n", "0", "--json").err, "");
  assert.throws(() => tdo("ls", "--limit=9007199254740992"), /non-negative integer/);
});

test("unlimited lists, exports, and browser candidates include rows beyond 5000", (t) => {
  let picked = 0;
  const tdo = harness({ pick: (lines) => { picked = lines.length; return [lines.at(-1).split("\t")[0]]; } });
  const dbPath = tdo("paths", "--json").json().db;
  t.after(() => fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }));
  const db = core.openDb(dbPath);
  try {
    for (let i = 1; i <= 5001; i++) core.addItem(db, { project: PROJECT, title: `bulk ${i}` });
    const closed = core.addItem(db, { project: PROJECT, title: "closed sentinel" });
    core.setStatus(db, closed, "done");
    core.addItem(db, { project: "other/project", title: "other sentinel" });
    assert.equal(core.listItems(db).length, 500, "core keeps its default");
    assert.equal(core.listItems(db, { limit: 5001 }).length, 5001, "positive limits are not clamped");
  } finally { db.close(); }
  const defaultList = tdo("ls", "--json");
  assert.equal(defaultList.json().length, 500);
  assert.match(defaultList.err, /more items/);
  const unlimited = tdo("ls", "-n", "0", "--json");
  assert.equal(unlimited.json().length, 5001);
  assert.equal(unlimited.err, "");
  assert.equal(tdo("ls", "-n", "5001", "--json").err, "");
  assert.equal(tdo("ls", "-n", "5001", "--json").json().length, 5001);
  assert.equal(tdo("ls", "-a", "-n", "0", "--json").json().length, 5002);
  assert.match(tdo("ls", "-a", "-n", "1").out, /5001 items[\s\S]*… 5000 more/);
  const exported = tdo("export").json();
  assert.equal(exported.length, 5002);
  assert.ok(exported.some((item) => item.title === "closed sentinel"));
  assert.ok(exported.some((item) => item.title === "bulk 5001"));
  assert.equal(tdo("export", "-a").json().length, 5003);
  const markdown = tdo("export", "--md").out;
  assert.equal(markdown.match(/^- \[/gm).length, 5002);
  assert.match(markdown, /- \[x\] #5002 closed sentinel/);
  assert.equal(tdo("pick").out, "5001");
  assert.equal(picked, 5001);
  const state = path.join(path.dirname(dbPath), "state.json");
  fs.writeFileSync(state, JSON.stringify({ all: true, status: "all" }));
  const feed = tdo("_fzf", "feed", state).out;
  assert.equal(feed.split("\n").length, 5003);
  assert.match(feed, /bulk 5001/);
  assert.match(feed, /other sentinel/);
});

test("JSON truncation diagnostics go to real stderr, not stdout", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdo-limit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, TDO_DB: path.join(dir, "tdo.db"), TDO_PROJECT: PROJECT, TDO_CONFIG: path.join(dir, "config.json") };
  const db = core.openDb(env.TDO_DB);
  try { for (let i = 0; i < 3; i++) core.addItem(db, { project: PROJECT, title: `item ${i}` }); } finally { db.close(); }
  for (const all of [[], ["-a"]]) {
    const limited = spawnSync(process.execPath, [SCRIPT, "ls", ...all, "-n", "2", "--json"], { env, encoding: "utf8" });
    assert.equal(limited.status, 0, limited.stderr);
    assert.equal(JSON.parse(limited.stdout).length, 2);
    assert.match(limited.stderr, /more items/);
    const full = spawnSync(process.execPath, [SCRIPT, "ls", ...all, "-n", "0", "--json"], { env, encoding: "utf8" });
    assert.equal(full.status, 0, full.stderr);
    assert.equal(JSON.parse(full.stdout).length, 3);
    assert.equal(full.stderr, "");
  }
});

test("colors are opt-in and follow NO_COLOR / FORCE_COLOR", async () => {
  const { useColor } = await import("../src/cli.ts");
  assert.equal(useColor({}, true), true);
  assert.equal(useColor({}, false), false);
  assert.equal(useColor({ NO_COLOR: "1" }, true), false);
  assert.equal(useColor({ FORCE_COLOR: "1" }, false), true);
  const tdo = harness({ color: true });
  tdo("add", "loud !urgent");
  assert.match(tdo("ls").out, /\x1b\[1m#1\x1b\[22m {2}\x1b\[31m\x1b\[1murgent|\x1b\[1m\x1b\[31murgent/);
  assert.doesNotMatch(tdo("ls", "--json").out, /\x1b/);
});

test("commands pick with fzf when the id is left out", () => {
  const picks = [];
  let answer = [];
  const tdo = harness({ pick: (lines, options) => { picks.push({ lines, options }); return answer; } });
  tdo("add", "first");
  tdo("add", "second !high");
  tdo("add", "elsewhere", "--project", "github.com/example/gadgets");

  answer = [`${PROJECT}#1`];
  assert.match(tdo("show").out, /^#1 first/);
  assert.equal(picks.at(-1).options.multi, false);
  assert.deepEqual(picks.at(-1).lines.map((line) => line.split("\t")[0]), [`${PROJECT}#2`, `${PROJECT}#1`], "this project, most urgent first");
  assert.match(picks.at(-1).options.preview, / show \{1\}$/);

  answer = [`${PROJECT}#1`, `${PROJECT}#2`];
  tdo("done");
  assert.equal(picks.at(-1).options.multi, true);
  assert.deepEqual(tdo("ls", "--json").json(), []);
  answer = [`${PROJECT}#2`];
  tdo("reopen");
  assert.deepEqual(picks.at(-1).lines.map((line) => line.split("\t")[0]), [`${PROJECT}#2`, `${PROJECT}#1`], "reopen offers closed items");

  answer = ["github.com/example/gadgets#1"];
  assert.equal(tdo("pick", "-a").out, "github.com/example/gadgets#1");
  assert.equal(picks.at(-1).lines.length, 2, "all active items across projects");

  answer = [];
  assert.throws(() => tdo("show"), (error) => error.constructor.name === "Cancelled");
  assert.throws(() => harness()("show"), /needs an item id \(or install fzf/);
});

test("push recovery picker includes closed items and respects explicit status filters", () => {
  let offered;
  const tdo = harness({ pick: (lines) => { offered = lines.map((line) => line.split("\t")[0]); return []; } });
  tdo("add", "active");
  tdo("add", "closed");
  tdo("done", "2");
  // Detach works without a tracker config; cancelling stops before any mutation.
  assert.throws(() => tdo("push", "--detach"), (error) => error.constructor.name === "Cancelled");
  assert.deepEqual(offered, [`${PROJECT}#1`, `${PROJECT}#2`]);
  assert.throws(() => tdo("push", "--detach", "-s", "active"), (error) => error.constructor.name === "Cancelled");
  assert.deepEqual(offered, [`${PROJECT}#1`]);
  assert.throws(() => tdo("reopen", "-s", "active"), (error) => error.constructor.name === "Cancelled");
  assert.deepEqual(offered, [`${PROJECT}#1`]);
});

test("edit without flags round-trips title and body through the editor", () => {
  let seen;
  let reply = "renamed\n\nwhy it matters\n";
  const tdo = harness({ edit: (text) => { seen = text; return reply; } });
  tdo("add", "original", "-b", "old body");
  assert.match(tdo("edit", "1").out, /^updated #1 {2}normal {2}renamed/);
  assert.equal(seen, "original\n\nold body");
  assert.equal(tdo("show", "1", "--json").json().body, "why it matters");
  assert.match(tdo("edit", "1").out, /^unchanged/);
  reply = "\n";
  assert.throws(() => tdo("edit", "1"), /title must not be empty/);
  reply = undefined;
  assert.throws(() => tdo("edit", "1"), (error) => error.constructor.name === "Cancelled");
  const plain = harness();
  plain("add", "no editor here");
  assert.throws(() => plain("edit", "1"), /needs flags such as --title/);
});

test("plain tdo opens the fzf browser with action bindings", () => {
  const calls = [];
  const tdo = harness({ interactive: true, runFzf: (args, env) => { calls.push({ args, env }); return 130; } });
  tdo("add", "first");
  assert.equal(tdo().code, 0, "esc exits cleanly");
  const { args, env } = calls[0];
  const binds = args.filter((arg) => arg.startsWith("--bind=")).map((arg) => arg.slice(7).split(":")[0]);
  assert.deepEqual(binds, ["start", "ctrl-n", "ctrl-p", "enter", "ctrl-e", "ctrl-s", "ctrl-d", "ctrl-x", "ctrl-r", "alt-up", "alt-down", "alt-d", "alt-n", "ctrl-a", "ctrl-t"]);
  assert.ok(args.includes("--bind=ctrl-n:down") && args.includes("--bind=ctrl-p:up"));
  assert.ok(args.includes("--multi"));
  assert.match(args.find((arg) => arg.startsWith("--header=")), /tdo · github\.com\/example\/widgets · open/);
  assert.equal(env.FORCE_COLOR, "1");
  // --json and explicit commands never open the browser.
  assert.equal(tdo("--json").json().length, 1);
  assert.equal(calls.length, 1);
});

test("browser helpers feed items, toggle scope, and change priority", () => {
  const tdo = harness();
  tdo("add", "here !high");
  tdo("add", "low one !low");
  tdo("add", "there", "--project", "github.com/example/gadgets");
  tdo("done", "2");
  const state = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tdo-state-")), "state.json");
  fs.writeFileSync(state, JSON.stringify({ all: false, status: "active" }));
  const refs = () => tdo("_fzf", "feed", state).out.split("\n").filter(Boolean).map((line) => line.split("\t")[0]);
  assert.deepEqual(refs(), [`${PROJECT}#1`]);
  tdo("_fzf", "toggle-closed", state);
  assert.deepEqual(refs(), [`${PROJECT}#1`, `${PROJECT}#2`]);
  tdo("_fzf", "toggle-all", state);
  assert.deepEqual(refs(), [`${PROJECT}#1`, `${PROJECT}#2`, "github.com/example/gadgets#1"], "current project first");
  assert.match(tdo("_fzf", "header", state).out, /^tdo · all projects · open \+ closed/);
  tdo("_fzf", "raise", state, `${PROJECT}#1`, "github.com/example/gadgets#1");
  assert.equal(tdo("show", "1", "--json").json().priority, "urgent");
  assert.equal(tdo("show", "gadgets#1", "--json").json().priority, "high");
  tdo("_fzf", "raise", state, `${PROJECT}#1`);
  assert.equal(tdo("show", "1", "--json").json().priority, "urgent", "clamped at urgent");
  tdo("_fzf", "lower", state, `${PROJECT}#2`);
  assert.equal(tdo("show", "2", "--json").json().priority, "low", "clamped at low");
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
