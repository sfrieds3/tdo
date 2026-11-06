import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";

const release = fs.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const ci = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
// Exercise the actual github-script bodies, without adding a YAML/runtime dependency.
const scripts = [...release.matchAll(/^          script: \|\n((?: {12}.*\n|\n)+)/gm)].map((match) => new AsyncFunction("github", "context", match[1].replace(/^ {12}/gm, "")));
const context = { repo: { owner: "owner", repo: "tdo" }, serverUrl: "https://github.com", runId: 42 };

function harness(t, overrides = {}) {
  const saved = Object.fromEntries(["RELEASE_PR", "RELEASE_SHA", "CI_RESULT"].map((name) => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  process.env.RELEASE_PR = JSON.stringify({ number: 21, sha: "outdated-output-sha" });
  const pr = {
    state: "open",
    base: { ref: "main" },
    head: { repo: { full_name: "owner/tdo" }, ref: "release-please--branches--main--components--tdo", sha: "resolved-head-sha" },
    user: { login: "github-actions[bot]" },
    ...overrides,
  };
  const statuses = [];
  const github = { rest: {
    pulls: { get: async (args) => { assert.deepEqual(args, { owner: "owner", repo: "tdo", pull_number: 21 }); return { data: pr }; } },
    repos: { createCommitStatus: async (status) => { statuses.push(status); } },
  } };
  return { github, statuses };
}

test("release CI tests an explicit SHA with read-only permissions and reports independently", () => {
  assert.equal(scripts.length, 2);
  assert.match(release, /pr: \$\{\{ steps\.release\.outputs\.pr \}\}/);
  assert.match(release, /if: needs\.release-please\.outputs\.pr != ''/);
  assert.match(release, /pr-ci:\n    needs: prepare-pr-ci\n    permissions:\n      contents: read\n      pull-requests: read\n    uses: \.\/\.github\/workflows\/ci\.yml\n    with:\n      checkout_ref: \$\{\{ needs\.prepare-pr-ci\.outputs\.sha \}\}/);
  assert.match(release, /if: always\(\) && needs\.prepare-pr-ci\.result == 'success'/);
  assert.doesNotMatch(release, /secrets: inherit|pull_request_target|workflow_dispatch/);
  assert.match(ci, /group: ci-\$\{\{ inputs\.checkout_ref \|\| github\.ref \}\}/);
  assert.match(ci, /ref: \$\{\{ inputs\.checkout_ref \|\| github\.sha \}\}\n          persist-credentials: false/);
  assert.match(ci, /if: github\.event_name == 'pull_request'/, "ordinary PR title check is retained");
});

test("preparation resolves the live PR SHA and posts pending before testing", async (t) => {
  const h = harness(t);
  const sha = await scripts[0](h.github, context);
  assert.equal(sha, "resolved-head-sha", "do not use the release tag SHA or a moving branch for checkout");
  assert.equal(h.statuses.length, 1);
  assert.equal(h.statuses[0].sha, sha);
  assert.equal(h.statuses[0].state, "pending");
  assert.equal(h.statuses[0].context, "Release PR CI");
  assert.equal(h.statuses[0].target_url, "https://github.com/owner/tdo/actions/runs/42");
});

for (const [name, overrides] of [
  ["closed PR", { state: "closed" }],
  ["different base", { base: { ref: "other" } }],
  ["fork", { head: { repo: { full_name: "outside/tdo" }, ref: "release-please--branches--main--components--tdo", sha: "untrusted" } }],
  ["different branch", { head: { repo: { full_name: "owner/tdo" }, ref: "feature", sha: "untrusted" } }],
  ["different author", { user: { login: "someone-else" } }],
]) {
  test(`release CI refuses a ${name}`, async (t) => {
    const h = harness(t, overrides);
    await assert.rejects(scripts[0](h.github, context), /unexpected pull request/);
    assert.equal(h.statuses.length, 0);
  });
}

for (const result of ["success", "failure", "cancelled", "skipped"]) {
  test(`reporter records ${result} only on the originally tested SHA`, async (t) => {
    const h = harness(t);
    process.env.RELEASE_SHA = "original-tested-sha";
    process.env.CI_RESULT = result;
    h.github.rest.pulls.get = () => { throw new Error("reporter must not re-resolve a moving PR head"); };
    await scripts[1](h.github, context);
    assert.equal(h.statuses.length, 1);
    assert.equal(h.statuses[0].sha, "original-tested-sha");
    assert.equal(h.statuses[0].state, result === "success" ? "success" : "failure");
    assert.equal(h.statuses[0].context, "Release PR CI");
  });
}
