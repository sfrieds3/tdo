import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { run } from "../src/cli.ts";
import { floatingBackend, launchFloatingBrowser, tmuxCommandArgs } from "../src/floating.ts";

function fixture(t, config = { floating: true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdo-float-'"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const env = { PATH: dir, TDO_CONFIG: configPath, TDO_PROJECT: "example/widgets", TDO_DB: path.join(dir, "tdo.db") };
  const calls = [];
  const io = { cwd: dir, env, out() {}, interactive: true,
    runFloat: (request) => { calls.push(request); return 0; },
    runFzf: () => { calls.push("inline"); return 130; } };
  return { dir, env, io, calls, configPath };
}

test("floating backend prefers tmux and requires complete Rex context", () => {
  assert.equal(floatingBackend({}), undefined);
  assert.equal(floatingBackend({ REX_SESSION: "s" }), undefined);
  assert.equal(floatingBackend({ REX_SESSION: "s", REX_BLOCK: "b" }), "rex");
  assert.equal(floatingBackend({ TMUX: "socket", REX_SESSION: "s", REX_BLOCK: "b" }), "tmux");
});

test("config gates floating browsers; inline overrides, JSON, and explicit commands stay unchanged", (t) => {
  for (const floating of [undefined, false, true]) {
    const { io, env, calls, configPath } = fixture(t, { floating });
    env.TMUX = "socket";
    assert.equal(run([], io), 0);
    assert.equal(calls[0] === "inline", floating !== true);
    calls.length = 0;
    run(["browse", "--no-float"], io);
    assert.deepEqual(calls, ["inline"]);
    calls.length = 0;
    run(["--json"], io);
    run(["ls"], io);
    run(["add", "ordinary item"], io);
    assert.throws(() => run(["pick"], { ...io, pick: () => [] }), (error) => error.constructor.name === "Cancelled");
    assert.deepEqual(calls, []);
    fs.writeFileSync(configPath, JSON.stringify({ floating: true }));
    run([], { ...io, interactive: false });
    assert.deepEqual(calls, [], "noninteractive default remains ls");
    delete env.TMUX;
    run(["browse"], io);
    assert.deepEqual(calls, ["inline"], "no terminal backend falls back inline");
  }
});

test("float child preserves database, project, cwd and filters without recursion or local database access", (t) => {
  const { io, env, calls, dir } = fixture(t);
  env.REX_SESSION = "session:caller";
  env.REX_BLOCK = "block:caller";
  for (const db of ["backlog with 'quotes.db", "ssh://user@host/absolute/backlog%20file.db"]) {
    run(["browse", "--db", db, "--project", "custom/project", "-C", "sub dir", "-a", "-s", "all"], io);
    const request = calls.at(-1);
    assert.equal(request.backend, "rex");
    assert.equal(request.cwd, dir);
    assert.equal(request.env, env);
    assert.deepEqual(request.command.slice(request.command.indexOf("browse")), ["browse", "--no-float", "--db",
      db.startsWith("ssh:") ? db : path.join(dir, db), "--project", "custom/project", "-C", path.join(dir, "sub dir"), "-s", "all", "-a"]);
    assert.ok(path.isAbsolute(request.command[0]));
    assert.ok(request.command.some((arg) => arg.endsWith("/src/cli.ts")));
    assert.equal(fs.existsSync(path.join(dir, "backlog with 'quotes.db")), false);
  }
  assert.throws(() => run(["browse"], { ...io, runFloat() { throw new Error("launch failed"); } }), /launch failed/);
});

function fakeLauncher(dir, name, behavior = "") {
  const log = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(path.join(dir, name), `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
const input = args.at(-1) === '-' ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input, cwd: process.cwd() }) + '\\n');
${behavior}
`, { mode: 0o755 });
  return () => fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("tmux uses popup argv (not a shell string), targeted pane, and forwarded browser settings", (t) => {
  const { dir, env } = fixture(t);
  const logged = fakeLauncher(dir, "tmux");
  Object.assign(env, { TMUX: "socket", TMUX_PANE: "%7", SSH_AUTH_SOCK: "/socket with spaces", EDITOR: "nvim -f", TDO_FZF_OPTS: "--border", UNRELATED_SECRET: "private" });
  const command = [process.execPath, "script with 'quotes.ts", "browse", "--no-float", "--project", "$(touch BAD)"];
  assert.equal(launchFloatingBrowser({ backend: "tmux", command, cwd: dir, env }), 0);
  const { args, cwd } = logged()[0];
  assert.equal(fs.realpathSync(cwd), fs.realpathSync(dir));
  assert.deepEqual(args.slice(0, 11), ["display-popup", "-E", "-w", "80%", "-h", "80%", "-d", dir, "-t", "%7", "/usr/bin/env"]);
  assert.deepEqual(args.slice(-command.length), command);
  assert.ok(args.includes("SSH_AUTH_SOCK=/socket with spaces"));
  assert.ok(args.includes("EDITOR=nvim -f"));
  assert.ok(args.includes("TDO_FZF_OPTS=--border"));
  assert.ok(args.includes("TDO_FLOATING_BROWSER=1"));
  assert.ok(!args.some((arg) => /^(TMUX|UNRELATED_SECRET)=/.test(arg)));
});

test("Rex targets caller's window and creates a self-closing floating terminal using JSON stdin", (t) => {
  const { dir, env } = fixture(t);
  const logged = fakeLauncher(dir, "rex", `console.log(JSON.stringify(args[0] === 'block' ? { block: { window_id: 'window:caller' } } : { layer_id: 'layer:new' }));`);
  Object.assign(env, { REX_SESSION: "session:caller", REX_BLOCK: "block:caller", TDO_CONFIG: "config.json" });
  const command = [process.execPath, "a 'quoted' script", "browse", "--no-float"];
  assert.equal(launchFloatingBrowser({ backend: "rex", command, cwd: dir, env }), 0);
  const [inspect, create] = logged();
  assert.deepEqual(inspect.args, ["block", "inspect", "-s", "session:caller", "block:caller", "--json"]);
  assert.deepEqual(create.args, ["api", "call", "-s", "session:caller", "session.new_layer", "-"]);
  assert.equal(create.input.window_id, "window:caller");
  assert.deepEqual(create.input.bounds, [0.1, 0.1, 0.8, 0.8]);
  assert.equal(create.input.focus, true);
  const block = create.input.layout.block;
  assert.equal(block.flavor, "com.superlogical.terminal.shell");
  assert.equal(block.options.shell, "none");
  assert.equal(block.options.cwd, dir);
  assert.deepEqual(block.options.exit, { on_completion: true, quick_exit_threshold_ms: 250 });
  assert.deepEqual(block.options.command.slice(-command.length), command);
  assert.ok(block.options.command.includes(`TDO_CONFIG=${path.join(dir, "config.json")}`));
  assert.ok(!block.options.command.some((arg) => arg.startsWith("REX_BLOCK=")));
});

test("launcher failures are surfaced without retry or inline fallback", (t) => {
  const { dir, env } = fixture(t);
  const request = { backend: "rex", command: ["tdo", "browse"], cwd: dir, env: { ...env, REX_SESSION: "s", REX_BLOCK: "b" } };
  assert.throws(() => launchFloatingBrowser(request), /Rex floating browser:.*ENOENT/);
  const logged = fakeLauncher(dir, "rex", "console.error('unsupported method'); process.exit(1);");
  assert.throws(() => launchFloatingBrowser(request), /unsupported method/);
  assert.equal(logged().length, 1);
  fakeLauncher(dir, "rex", "console.log('not json');");
  assert.throws(() => launchFloatingBrowser(request), /invalid JSON/);
  fakeLauncher(dir, "rex", "console.log('{}');");
  assert.throws(() => launchFloatingBrowser(request), /caller's window/);
  fakeLauncher(dir, "rex", "console.log(JSON.stringify({ block: { window_id: 'w' } }));");
  assert.throws(() => launchFloatingBrowser(request), /no layer id/);
  fakeLauncher(dir, "tmux", "process.exit(1);");
  assert.throws(() => launchFloatingBrowser({ ...request, backend: "tmux" }), /tmux floating browser failed/);
});

test("real CLI dispatches into fake Rex and child browser cannot create another float", (t) => {
  const { dir, env } = fixture(t);
  const logged = fakeLauncher(dir, "rex", `
if (args[0] === 'block') console.log(JSON.stringify({ block: { window_id: 'w' } }));
else {
  const child = input.layout.block.options;
  const result = require('node:child_process').spawnSync(child.command[0], child.command.slice(1), { cwd: child.cwd, env: { ...process.env }, encoding: 'utf8' });
  if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
  console.log(JSON.stringify({ layer_id: 'new' }));
}`);
  const fzfCalls = fakeLauncher(dir, "fzf");
  const script = new URL("../src/cli.ts", import.meta.url).pathname;
  const result = spawnSync(process.execPath, [script, "browse"], { cwd: dir, env: { ...env, REX_SESSION: "s", REX_BLOCK: "b" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(logged().length, 2);
  assert.equal(fzfCalls()[0].args.filter((arg) => arg.startsWith("--height=")).at(-1), "--height=100%");
});

test("tmux argument escaping survives its real parser, including standalone and trailing semicolons", (t) => {
  if (spawnSync("tmux", ["-V"]).error) return t.skip("tmux is not installed");
  const { dir } = fixture(t);
  const socket = path.join(dir, "tmux.sock");
  const tmux = (...args) => spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 10_000 });
  t.after(() => tmux("kill-server"));
  const started = tmux("-f", "/dev/null", "new-session", "-d", "-s", "test");
  assert.equal(started.status, 0, started.stderr);
  const output = path.join(dir, "argv.json");
  const cwd = path.join(dir, "cwd;");
  fs.mkdirSync(cwd);
  const values = [";", "widgets;", "a\\;", "x;y", "$(touch BAD)", "two words", "a 'quote'"];
  const script = `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({ args: process.argv.slice(1), cwd: process.cwd() })); require('node:child_process').spawnSync('tmux', ['-S', ${JSON.stringify(socket)}, 'wait-for', '-S', 'written']);`;
  const launched = tmux(...tmuxCommandArgs(["new-window", "-d", "-t", "test", "-c", cwd, process.execPath, "-e", script, ...values]));
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(tmux("wait-for", "written").status, 0);
  const data = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.deepEqual(data.args, values);
  assert.equal(fs.realpathSync(data.cwd), fs.realpathSync(cwd));
});
