import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Item } from "./core.ts";

type WorkContext = { cwd: string; env: NodeJS.ProcessEnv };
type Selection = { id: number; name: string; branch: string; launch: "shell" | "pi" };

export function rexWorkSetup(): string {
  const script = fileURLToPath(new URL("./rex-work.lua", import.meta.url));
  // Lua long strings don't interpret quotes or backslashes. Pick a delimiter not used in the path.
  let delimiter = "=";
  while (script.includes(`]${delimiter}]`)) delimiter += "=";
  return `dofile([${delimiter}[${script}]${delimiter}])`;
}

function invoke(command: string, args: string[], { cwd, env }: WorkContext, timeout: number, input?: string): string {
  const result = spawnSync(command, args, { cwd, env, input, timeout, encoding: "utf8" });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr.trim() || `exited with ${result.signal ?? result.status}`}`);
  return result.stdout;
}

function suggestion(title: string): string {
  return title.toLowerCase().replace(/#\d+\b/g, "").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "").slice(0, 48).replace(/-+$/, "") || "tdo-work";
}

export function pickRexWork(context: WorkContext, project: string, items: Item[]): Selection | undefined {
  const { REX_SESSION: session, REX_BLOCK: block } = context.env;
  if (!session || !block) throw new Error("tdo work must run inside a Rex terminal.");
  const rows = items.map((item) => ({ id: String(item.id), title: item.title,
    subtitle: `#${item.id} · ${item.status} · ${item.priority}`, suggestion: suggestion(item.title) }));
  const input = JSON.stringify({ project, items_json: JSON.stringify(rows) });
  let raw: string;
  try {
    raw = invoke("rex", ["do", "tdo_work_prompt", "-s", session, "-b", block, "--args", "-", "--json", "--timeout", "5m"], context, 310_000, input);
  } catch (error) {
    throw new Error(`${(error as Error).message}\nIf the Rex action is missing, see \`tdo work setup\`.`);
  }
  const answer = JSON.parse(raw);
  if (answer?.cancelled === true) return undefined;
  const item = items.find((candidate) => String(candidate.id) === answer?.id);
  if (!item || typeof answer.name !== "string" || typeof answer.branch !== "string" || !["shell", "pi"].includes(answer.launch)) {
    throw new Error("invalid selection from Rex; no worktree was created.");
  }
  return { id: item.id, name: answer.name, branch: answer.branch, launch: answer.launch };
}

function worktreePath(context: WorkContext, name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name)) {
    throw new Error("use a worktree name of 1–80 letters, digits, dots, underscores or hyphens, starting with a letter or digit.");
  }
  const [main, entry] = invoke("git", ["worktree", "list", "--porcelain", "-z"], context, 5_000).split("\0", 2);
  if (!main?.startsWith("worktree ") || entry === "bare") throw new Error("tdo work needs a Git repository with a main checkout.");
  const parent = path.join(main.slice("worktree ".length), ".worktrees");
  if (lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`refusing to create a worktree under a symlink: ${parent}`);
  }
  const target = path.join(parent, name);
  if (lstatSync(target, { throwIfNoEntry: false })) throw new Error(`worktree path already exists: ${target}`);
  return target;
}

export function launchRexWork(context: WorkContext, selection: Selection, prompt: string): { worktree: string; windowId: string } {
  const { name, branch, launch } = selection;
  const worktree = worktreePath(context, name);
  // Check the literal name, not the checkout-history expansion accepted by `--branch`.
  if (!branch || branch.startsWith("-") || branch === "HEAD" ||
      spawnSync("git", ["check-ref-format", `refs/heads/${branch}`], { ...context, timeout: 5_000 }).status !== 0) {
    throw new Error(`invalid new Git branch name: ${JSON.stringify(branch)}.`);
  }
  invoke("git", ["worktree", "add", "-b", branch, "--", worktree, "HEAD"], context, 120_000);

  try {
    const args = ["window", "new", "-s", context.env.REX_SESSION!, name, "-c", worktree, "--interactive", "--json"];
    if (launch === "pi") args.push("--keep-open", "--", "pi", "--", prompt);
    const result = JSON.parse(invoke("rex", args, context, 15_000));
    if (typeof result?.window_id !== "string" || !result.window_id) throw new Error("Rex returned no window ID");
    return { worktree, windowId: result.window_id };
  } catch (error) {
    throw new Error(`created worktree at ${worktree}, but couldn't confirm the new Rex tab: ${(error as Error).message}. Check Rex before retrying.`);
  }
}
