import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";

const SKILL = fs.readFileSync(new URL("../skills/tdo/SKILL.md", import.meta.url), "utf8");
const { run } = await import("../src/cli.ts");

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "SKILL.md starts with frontmatter");
  return Object.fromEntries(match[1].split("\n").map((line) => {
    const index = line.indexOf(":");
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
}

test("skill frontmatter follows the Agent Skills format", () => {
  const meta = frontmatter(SKILL);
  assert.equal(meta.name, "tdo");
  assert.match(meta.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(meta.description.length > 50 && meta.description.length <= 1024);
});

test("every tdo command the skill documents parses", () => {
  const usage = [];
  run(["help"], { out: (text) => usage.push(text), cwd: process.cwd(), env: {} });
  const commands = new Set([...SKILL.matchAll(/^tdo ([a-z]+)/gm)].map((match) => match[1]));
  assert.ok(commands.size >= 6);
  for (const command of commands) assert.match(usage.join("\n"), new RegExp(`tdo ${command}\\b|${command}\\|`), `usage documents ${command}`);
  for (const flag of ["--source", "--json", "-q", "-t", "-p", "-s", "-m", "-f", "-b"]) assert.ok(SKILL.includes(flag), `skill mentions ${flag}`);
});
