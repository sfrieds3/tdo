import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { getConfigPath } from "./core.ts";

export type FloatingRequest = {
  backend: "tmux" | "rex";
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

/** Prefer the innermost multiplexer when tmux itself is running in Rex. */
export function floatingBackend(env: NodeJS.ProcessEnv): FloatingRequest["backend"] | undefined {
  if (env.TMUX) return "tmux";
  if (env.REX_SESSION && env.REX_BLOCK) return "rex";
  return undefined;
}

/** Forward browser settings, not stale terminal identities or unrelated application secrets. */
function browserCommand({ command, cwd, env }: FloatingRequest): string[] {
  const forwarded = Object.entries(env)
    .filter(([key, value]) => value !== undefined && /^(TDO_|XDG_|SSH_|LC_|FZF_|LANG$|PATH$|HOME$|VISUAL$|EDITOR$|PAGER$|LESS$|NO_COLOR$|FORCE_COLOR$)/.test(key))
    .map(([key, value]) => `${key}=${value}`);
  return ["/usr/bin/env", ...forwarded,
    `TDO_CONFIG=${path.resolve(cwd, getConfigPath(env))}`,
    "TDO_FLOATING_BROWSER=1", ...command];
}

/** tmux parses trailing semicolons even when spawned without a shell. */
export function tmuxCommandArgs(args: string[]): string[] {
  return args.map((arg) => arg.replace(/;$/, "\\;"));
}

/** Bounded launcher calls; never retry a Rex creation which may already have succeeded. */
function rexCall(args: string[], request: FloatingRequest, input?: unknown): unknown {
  const result = spawnSync("rex", args, {
    cwd: request.cwd, env: request.env, encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input), timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error(`Rex floating browser: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Rex floating browser: ${result.stderr.trim() || `launcher exited ${result.status}`}`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error("Rex floating browser: invalid JSON from rex."); }
}

/** The child owns fzf's state and cleanup. Rex launches asynchronously; tmux waits for its popup. */
export function launchFloatingBrowser(request: FloatingRequest): number {
  const command = browserCommand(request);
  if (request.backend === "tmux") {
    const result = spawnSync("tmux", tmuxCommandArgs(["display-popup", "-E", "-w", "80%", "-h", "80%", "-d", request.cwd,
      ...(request.env.TMUX_PANE ? ["-t", request.env.TMUX_PANE] : []), ...command]),
    { cwd: request.cwd, env: request.env, stdio: "inherit" });
    if (result.error) throw new Error(`tmux floating browser: ${result.error.message}`);
    if (result.status !== 0) throw new Error("tmux floating browser failed; use `tdo --no-float` for the inline browser.");
    return 0;
  }
  const session = request.env.REX_SESSION!;
  const inspected = rexCall(["block", "inspect", "-s", session, request.env.REX_BLOCK!, "--json"], request) as { block?: { window_id?: string } };
  const window = inspected?.block?.window_id;
  if (!window) throw new Error("Rex floating browser: could not find the caller's window; use `tdo --no-float`.");
  const created = rexCall(["api", "call", "-s", session, "session.new_layer", "-"], request, {
    window_id: window, bounds: [0.1, 0.1, 0.8, 0.8], focus: true,
    layout: { block: { flavor: "com.superlogical.terminal.shell", label: "tdo", options: {
      shell: "none", cwd: request.cwd, command, exit: { on_completion: true, quick_exit_threshold_ms: 250 },
    } } },
  }) as { layer_id?: string };
  if (!created?.layer_id) throw new Error("Rex floating browser: launch returned no layer id; inspect Rex before retrying.");
  return 0;
}
