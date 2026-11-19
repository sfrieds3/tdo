import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../src/bin.mjs", import.meta.url));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdo rex '"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "rex.jsonl");
  const root = path.join(fs.realpathSync(dir), "main checkout");
  const db = path.join(dir, "backlog.db");
  fs.mkdirSync(root);
  const env = { PATH: `${dir}${path.delimiter}${process.env.PATH}`, HOME: dir, GIT_CONFIG_NOSYSTEM: "1",
    TDO_CONFIG: path.join(dir, "config.json"), TDO_DB: db, REX_LOG: log, REX_SESSION: "session:caller", REX_BLOCK: "block:caller" };
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const tdo = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: root, env, encoding: "utf8" });
  const json = (...args) => {
    const result = tdo(...args, "--json");
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  const answer = (overrides) => { env.REX_ANSWER = JSON.stringify({ id: "1", name: "picked-dir", branch: "topic/picked-branch", launch: "shell", ...overrides }); };
  answer({});
  fs.writeFileSync(path.join(dir, "rex"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args[0] === 'do' ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
fs.appendFileSync(process.env.REX_LOG, JSON.stringify({ args, input }) + '\\n');
if (args[0] === 'do') console.log(process.env.REX_ANSWER);
else if (process.env.REX_FAIL) { console.error('connection lost'); process.exitCode = 1; }
else console.log(JSON.stringify({ window_id: 'window:new' }));
`, { mode: 0o755 });
  git(root, "init", "-b", "main");
  git(root, "-c", "user.name=tdo", "-c", "user.email=tdo@example.test", "commit", "--allow-empty", "-m", "Base");
  git(root, "remote", "add", "origin", "https://github.com/example/current.git");
  return { root, env, git, tdo, json, answer, calls };
}

test("Rex work setup prints a loadable action path without running Rex or opening the DB", (t) => {
  const f = fixture(t);
  const { lua } = f.json("work", "setup");
  assert.match(lua, /^dofile\(\[=+\[.*src[\\/]rex-work\.lua\]=+\]\)$/);
  assert.equal(fs.existsSync(f.env.TDO_DB), false);
  assert.deepEqual(f.calls(), []);
});

test("Rex work lists only current active items and cancellation has no launch side effects", (t) => {
  const f = fixture(t);
  f.json("add", "Fix parser #42");
  f.json("add", "Already complete");
  f.json("done", "2");
  f.json("add", "Other project", "--project", "github.com/example/other");
  f.answer({ cancelled: true });
  const result = f.tdo("work");
  assert.equal(result.status, 130, result.stderr);
  assert.equal(result.stderr, "");
  const [prompt] = f.calls();
  assert.equal(f.calls().length, 1);
  assert.deepEqual(prompt.args.slice(0, 9), ["do", "tdo_work_prompt", "-s", "session:caller", "-b", "block:caller", "--args", "-", "--json"]);
  assert.equal(prompt.input.project, "github.com/example/current");
  assert.deepEqual(JSON.parse(prompt.input.items_json), [{ id: "1", title: "Fix parser #42", subtitle: "#1 · open · normal", suggestion: "fix-parser" }]);
  assert.equal(f.json("show", "1").status, "open");
  assert.equal(fs.existsSync(path.join(f.root, ".worktrees")), false);
  assert.equal(f.git(f.root, "branch", "--list"), "* main");
});

test("Rex work uses the caller's HEAD and puts the new worktree under the main checkout", (t) => {
  const f = fixture(t);
  const caller = path.join(f.root, ".worktrees", "caller");
  f.git(f.root, "worktree", "add", "-b", "caller", caller);
  f.git(caller, "-c", "user.name=tdo", "-c", "user.email=tdo@example.test", "commit", "--allow-empty", "-m", "Caller revision");
  f.json("add", "Pick this");
  const worktree = path.join(f.root, ".worktrees", "picked-dir");
  assert.deepEqual(f.json("work", "-C", caller), { worktree, windowId: "window:new", id: 1, branch: "topic/picked-branch", launch: "shell" });
  assert.equal(f.git(worktree, "branch", "--show-current"), "topic/picked-branch");
  assert.equal(f.git(worktree, "rev-parse", "HEAD"), f.git(caller, "rev-parse", "HEAD"));
  assert.deepEqual(f.calls()[1].args, ["window", "new", "-s", "session:caller", "picked-dir", "-c", worktree, "--interactive", "--json"]);
  assert.equal(f.json("show", "1").status, "doing");
});

test("Rex work passes the item details to Pi as one argument in an interactive shell", (t) => {
  const f = fixture(t);
  const body = "Quoted 'text', $(touch BAD) and `backticks`\nSecond line";
  f.json("add", "Fix quoting", "-b", body, "-f", "src/demo.ts:42");
  f.answer({ launch: "pi" });
  f.json("work");
  const args = f.calls()[1].args;
  const [prompt] = args.slice(13);
  assert.deepEqual(args.slice(9, 13), ["--keep-open", "--", "pi", "--"]);
  assert.equal(args.length, 14);
  assert.ok(prompt.startsWith("Work on this tdo item in the current worktree."));
  assert.ok(prompt.includes("#1 Fix quoting"));
  assert.ok(prompt.includes(body));
  assert.ok(prompt.includes("src/demo.ts:42"));
});

test("invalid replies and conflicting paths or branches cannot open a tab", (t) => {
  const f = fixture(t);
  f.json("add", "Do work");
  for (const [reply, error] of [
    [{ id: "2" }, /invalid selection/],
    [{ launch: "other" }, /invalid selection/],
    [{ name: "../escape" }, /worktree name/],
    [{ branch: "-invalid" }, /invalid new Git branch/],
    [{ branch: "bad..ref" }, /invalid new Git branch/],
    [{ branch: "main" }, /already exists/],
  ]) {
    f.answer(reply);
    const result = f.tdo("work");
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
  }
  assert.equal(fs.existsSync(path.join(f.root, ".worktrees", "picked-dir")), false);
  fs.mkdirSync(path.join(f.root, ".worktrees", "picked-dir"), { recursive: true });
  f.answer({});
  assert.match(f.tdo("work").stderr, /worktree path already exists/);
  assert.ok(f.calls().every((call) => call.args[0] === "do"));
  assert.equal(f.git(f.root, "branch", "--list"), "* main");
  assert.equal(f.json("show", "1").status, "open");
});

test("Rex launch failure reports the retained worktree and does not mark the item doing", (t) => {
  const f = fixture(t);
  f.json("add", "Do work");
  f.env.REX_FAIL = "1";
  const result = f.tdo("work");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /created worktree at .*picked-dir, but couldn't confirm the new Rex tab: rex: connection lost/);
  assert.equal(f.git(path.join(f.root, ".worktrees", "picked-dir"), "branch", "--show-current"), "topic/picked-branch");
  assert.equal(f.json("show", "1").status, "open");
  assert.equal(f.calls().length, 2);
});
