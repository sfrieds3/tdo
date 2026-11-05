/** Shell-free caller-side worker: synchronous PR2 orchestration never runs on Pi's event loop. */
import { execFile } from "node:child_process";
import * as path from "node:path";
import { getConfigPath } from "../core.ts";
import { fileURLToPath } from "node:url";
import type { EffectiveTracker } from "./config.ts";
import type { Item } from "../core.ts";

export type TrackerWork = { action: "push" | "drain"; target: string; project: string; config: EffectiveTracker; item: Item };
export function runTrackerWork(work: TrackerWork, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<{ url?: string; error?: string; warnings: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [fileURLToPath(new URL("./worker.ts", import.meta.url)), JSON.stringify(work)], { cwd, env: { ...env, TDO_CONFIG: path.resolve(getConfigPath(env)) }, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`${error.message}${stderr.trim() ? `: ${stderr.trim()}` : ""}`)); return; }
      try { resolve({ ...JSON.parse(stdout), warnings: stderr.trim() }); }
      catch { reject(new Error("invalid tracker worker response")); }
    });
  });
}
