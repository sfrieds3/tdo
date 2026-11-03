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
  assert.match(tdo("ls", "-a").out, /\(github\.com\/example\/widgets\)/);
  assert.equal(tdo("add", "from an agent", "--source", "claude", "--json").json().source, "claude");
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
  assert.throws(() => tdo("done", "7"), /No tdo item #7/);
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
