/** GitHub issues through the `gh` CLI. Arguments are passed as an array (never a shell); bodies go on stdin. */
import { spawnSync } from "node:child_process";
import type { NewIssue, Tracker, TrackerResult } from "./types.ts";

export const GH_TIMEOUT_MS = 10_000;

export type GhOptions = { destination: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };

type Run = { status: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException; signal: NodeJS.Signals | null };

function gh(args: string[], options: GhOptions, input?: string): Run {
  const result = spawnSync("gh", args, {
    input,
    encoding: "utf8",
    env: { ...(options.env ?? process.env), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
    timeout: options.timeoutMs ?? GH_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error as NodeJS.ErrnoException | undefined, signal: result.signal };
}

function describe(run: Run): string {
  if (run.error) return run.error.message;
  const detail = run.stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
  return `gh exited ${run.status ?? run.signal}${detail ? `: ${detail}` : ""}`;
}

const ISSUE_URL = /^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?$/;

export function parseGithubIssueUrl(url: string): { destination: string; id: string } | undefined {
  const match = ISSUE_URL.exec(url.trim());
  return match ? { destination: `${match[1]!.toLowerCase()}/${match[2]}/${match[3]}`, id: match[4]! } : undefined;
}

export function githubTracker(options: GhOptions): Tracker {
  const [host] = options.destination.split("/");
  const repo = options.destination;
  const sameRepo = (destination: string) => destination.toLowerCase() === repo.toLowerCase();

  function check(): TrackerResult<void> {
    const auth = gh(["auth", "status", "--hostname", host!], options);
    if (auth.error?.code === "ENOENT") return { ok: false, kind: "attention", message: "gh is not installed; see https://cli.github.com" };
    if (auth.error || auth.status !== 0) return { ok: false, kind: "attention", message: `gh is not authenticated for ${host} (run \`gh auth login --hostname ${host}\`): ${describe(auth)}` };
    return { ok: true, value: undefined };
  }

  return {
    provider: "github",
    check,
    parseIssueUrl: parseGithubIssueUrl,
    create(issue: NewIssue) {
      // Everything before `issue create` is known not to create anything; everything after is uncertain
      // unless gh hands back this repo's issue URL.
      const preflight = check();
      if (!preflight.ok) return preflight;
      const args = ["issue", "create", "--repo", repo, "--title", issue.title, "--body-file", "-", ...issue.labels.flatMap((label) => ["--label", label])];
      const run = gh(args, options, issue.body);
      if (run.error?.code === "ENOENT") return { ok: false, kind: "attention", message: "gh is not installed; see https://cli.github.com" };
      if (run.error || run.status !== 0) return { ok: false, kind: "uncertain", message: describe(run) };
      const url = run.stdout.trim().split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
      const parsed = parseGithubIssueUrl(url);
      if (!parsed || !sameRepo(parsed.destination)) return { ok: false, kind: "uncertain", message: `unexpected gh output: ${JSON.stringify(run.stdout.trim().slice(0, 200))}` };
      return { ok: true, value: { id: parsed.id, url } };
    },
  };
}
