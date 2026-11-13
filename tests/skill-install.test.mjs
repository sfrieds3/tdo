import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const { run } = await import("../src/cli.ts");
const source = fileURLToPath(new URL("../skills/tdo/", import.meta.url));

function harness(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tdo skill-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const destination = path.join(home, ".agents", "skills", "tdo");
  // Broken config and remote database must not affect a local skill installation.
  const config = path.join(home, "config.json");
  fs.writeFileSync(config, "not json");
  const env = { HOME: home, TDO_CONFIG: config, TDO_DB: "ssh://invalid/db" };
  const invoke = (...args) => {
    const output = [];
    const code = run(args, { out: (text) => output.push(text), cwd: home, env });
    return { code, text: output.join("\n") };
  };
  return { home, destination, env, invoke };
}

test("skill install creates the shared skill link outside a repository and is repeatable", (t) => {
  const { destination, invoke } = harness(t);
  const installed = invoke("skill", "install", "--json");
  assert.equal(installed.code, 0);
  assert.deepEqual(JSON.parse(installed.text), { source, scope: "global", installations: [{ target: "agents", status: "installed", destination }] });
  assert.equal(fs.realpathSync(destination), fs.realpathSync(source));
  assert.ok(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8").startsWith("---\n"));
  const again = invoke("skill", "install", "--json");
  assert.equal(JSON.parse(again.text).installations[0].status, "already-installed");
  assert.match(invoke("skill", "install").text, /already installed:.*\nRestart your agent/);
});

test("skill install recognizes an equivalent relative link", (t) => {
  const { destination, invoke } = harness(t);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(destination), source), destination, "dir");
  assert.equal(JSON.parse(invoke("skill", "install", "--json").text).installations[0].status, "already-installed");
});

for (const kind of ["file", "directory", "link", "dangling link"]) {
  test(`skill install preserves an existing ${kind}`, (t) => {
    const { home, destination, invoke } = harness(t);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (kind === "file") fs.writeFileSync(destination, "keep me");
    else if (kind === "directory") {
      fs.mkdirSync(destination);
      fs.writeFileSync(path.join(destination, "SKILL.md"), "keep me");
    } else fs.symlinkSync(kind === "link" ? home : path.join(home, "missing"), destination, "dir");
    const before = fs.lstatSync(destination);
    assert.throws(() => invoke("skill", "install"), /Refusing to replace.*Move it aside/);
    assert.equal(fs.lstatSync(destination).ino, before.ino);
    if (kind === "file") assert.equal(fs.readFileSync(destination, "utf8"), "keep me");
    if (kind === "directory") assert.equal(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8"), "keep me");
  });
}

test("skill rejects unknown and extra subcommand arguments without installing", (t) => {
  const { destination, invoke } = harness(t);
  for (const args of [["skill", "remove"], ["skill", "install", "extra"]]) {
    assert.throws(() => invoke(...args), /usage: tdo skill/);
  }
  assert.equal(fs.existsSync(path.dirname(destination)), false);
});

test("the CLI entrypoint installs skills and reports conflicts and usage errors", (t) => {
  const { home, destination, env } = harness(t);
  const cli = path.join(home, "tdo");
  fs.symlinkSync(fileURLToPath(new URL("../src/bin.mjs", import.meta.url)), cli);
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: home, env: { ...process.env, ...env }, encoding: "utf8" });
  const installed = invoke("skill", "install", "--json");
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).installations[0].destination, destination);
  fs.unlinkSync(destination);
  fs.writeFileSync(destination, "keep me");
  const conflict = invoke("skill", "install");
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /tdo: Refusing to replace/);
  assert.equal(invoke("skill", "remove").status, 2);
  assert.equal(fs.readFileSync(destination, "utf8"), "keep me");
});

for (const scope of ["global", "local"]) {
  for (const [flags, expected] of [
    [[], ["agents"]],
    [["--agents"], ["agents"]],
    [["--claude"], ["claude"]],
    [["--pi"], ["pi"]],
    [["--claude", "--pi"], ["claude", "pi"]],
    [["--all"], ["agents", "claude", "pi"]],
  ]) {
    test(`skill ${scope} installs only selected targets: ${flags.join(" ") || "default"}`, (t) => {
      const { home, invoke } = harness(t);
      const repo = path.join(home, "repo with spaces");
      const nested = path.join(repo, "src", "nested");
      fs.mkdirSync(nested, { recursive: true });
      assert.equal(spawnSync("git", ["init", repo], { encoding: "utf8" }).status, 0);
      const scopeFlags = scope === "local" ? ["--local", "-C", nested] : ["--global"];
      const result = JSON.parse(invoke("skill", ...flags, ...scopeFlags, "--json").text);
      assert.equal(result.scope, scope);
      assert.deepEqual(result.installations.map((entry) => entry.target), expected);
      const dirs = { agents: ".agents/skills", claude: ".claude/skills", pi: scope === "local" ? ".pi/skills" : ".pi/agent/skills" };
      for (const [target, dir] of Object.entries(dirs)) {
        const destination = path.join(scope === "local" ? repo : home, dir, "tdo");
        assert.equal(fs.existsSync(destination), expected.includes(target));
        if (expected.includes(target)) assert.equal(fs.realpathSync(destination), fs.realpathSync(source));
      }
      const repeat = JSON.parse(invoke("skill", ...flags, ...scopeFlags, "--json").text);
      assert.ok(repeat.installations.every((entry) => entry.status === "already-installed"));
      if (scope === "local") assert.equal(fs.existsSync(path.join(nested, ".agents")), false);
    });
  }
}

test("skill --all preflights conflicts before creating any links", (t) => {
  const { home, destination, invoke } = harness(t);
  const conflict = path.join(home, ".pi", "agent", "skills", "tdo");
  fs.mkdirSync(path.dirname(conflict), { recursive: true });
  fs.writeFileSync(conflict, "keep me");
  assert.throws(() => invoke("skill", "--all"), /Refusing to replace/);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(path.join(home, ".claude")), false);
  assert.equal(fs.readFileSync(conflict, "utf8"), "keep me");
});

test("skill rejects conflicting scopes and local installation outside Git", (t) => {
  const { destination, invoke } = harness(t);
  assert.throws(() => invoke("skill", "--local", "--global"), /either --local or --global/);
  assert.throws(() => invoke("skill", "--local"), /requires a Git repository/);
  assert.equal(fs.existsSync(path.dirname(destination)), false);
});

test("skill --local uses the actual working directory when -C is omitted", (t) => {
  const { home, env } = harness(t);
  const repo = path.join(home, "repo");
  assert.equal(spawnSync("git", ["init", repo]).status, 0);
  const cwd = path.join(repo, "nested");
  fs.mkdirSync(cwd);
  const out = [];
  assert.equal(run(["skill", "--local", "--pi", "--json"], { cwd, env, out: (text) => out.push(text) }), 0);
  const result = JSON.parse(out[0]);
  assert.equal(result.installations[0].destination, path.join(fs.realpathSync(repo), ".pi", "skills", "tdo"));
  assert.equal(fs.existsSync(path.join(home, ".pi")), false);
});

for (const kind of ["file", "directory", "link", "dangling link"]) {
  test(`skill --overwrite replaces an existing ${kind} without touching other targets`, (t) => {
    const { home, destination, invoke } = harness(t);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const oldTarget = path.join(home, "old-skill");
    fs.mkdirSync(oldTarget);
    fs.writeFileSync(path.join(oldTarget, "SKILL.md"), "keep old target");
    if (kind === "file") fs.writeFileSync(destination, "old file");
    else if (kind === "directory") {
      fs.mkdirSync(destination);
      fs.writeFileSync(path.join(destination, "SKILL.md"), "old skill");
      fs.symlinkSync(oldTarget, path.join(destination, "external"), "dir");
    } else fs.symlinkSync(kind === "link" ? oldTarget : path.join(home, "missing"), destination, "dir");
    const unselected = path.join(home, ".claude", "skills", "tdo");
    fs.mkdirSync(path.dirname(unselected), { recursive: true });
    fs.writeFileSync(unselected, "keep unselected");
    const result = JSON.parse(invoke("skill", "--agents", "--overwrite", "--json").text);
    assert.equal(result.installations[0].status, "updated");
    assert.equal(fs.realpathSync(destination), fs.realpathSync(source));
    assert.equal(fs.readFileSync(path.join(oldTarget, "SKILL.md"), "utf8"), "keep old target");
    assert.equal(fs.readFileSync(unselected, "utf8"), "keep unselected");
    const again = JSON.parse(invoke("skill", "--overwrite", "--json").text);
    assert.equal(again.installations[0].status, "already-installed");
  });
}

test("skill --overwrite installs absent targets normally", (t) => {
  const { invoke } = harness(t);
  const result = JSON.parse(invoke("skill", "--all", "--overwrite", "--json").text);
  assert.equal(result.installations.length, 3);
  assert.ok(result.installations.every((entry) => entry.status === "installed"));
});

test("skill --overwrite updates a repository-local skill without changing user-wide skills", (t) => {
  const { home, destination, invoke } = harness(t);
  const repo = path.join(home, "repo");
  assert.equal(spawnSync("git", ["init", repo]).status, 0);
  const local = path.join(repo, ".claude", "skills", "tdo");
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, "SKILL.md"), "old skill");
  const result = invoke("skill", "--claude", "--local", "-C", repo, "--overwrite");
  assert.match(result.text, /^updated:/);
  assert.equal(fs.realpathSync(local), fs.realpathSync(source));
  assert.equal(fs.existsSync(destination), false);
});

test("skill --overwrite refuses to remove its own bundled skill through a parent symlink", (t) => {
  const { home, invoke } = harness(t);
  fs.mkdirSync(path.join(home, ".agents"));
  fs.symlinkSync(path.dirname(path.resolve(source)), path.join(home, ".agents", "skills"), "dir");
  assert.throws(() => invoke("skill", "--all", "--overwrite"), /contains the bundled tdo skill/);
  assert.ok(fs.readFileSync(path.join(source, "SKILL.md"), "utf8").startsWith("---\n"));
  assert.equal(fs.existsSync(path.join(home, ".claude")), false);
});
