/** Private caller-side subprocess, not an RPC helper; inputs are JSON data, never shell text. */
import { canonicalJson, loadConfig, resolveProject } from "../core.ts";
import { createStore } from "../store.ts";
import { isApproved, resolveTracker } from "./config.ts";
import { pushItem } from "./sync.ts";
import { drainItems } from "./drain.ts";
import type { TrackerWork } from "./async.ts";

function run(work: TrackerWork): unknown {
  const project = resolveProject(process.cwd(), { config: loadConfig() });
  const resolved = resolveTracker(project, loadConfig());
  if (project.key !== work.project || resolved.kind !== "ok" || !isApproved(resolved.tracker) || canonicalJson(JSON.parse(JSON.stringify(resolved.tracker))) !== canonicalJson(work.config)) throw new Error("tracker configuration changed; consent must be renewed");
  const store = createStore(work.target);
  try {
    const item = store.call("getItem", work.item);
    if (!item || item.project !== project.key) throw new Error("item is no longer in this project");
    if (work.action === "push" && canonicalJson(item) !== canonicalJson(work.item)) throw new Error("item changed; consent must be renewed");
    const options = { warn: (message: string) => console.error(message), env: process.env, limit: 5 };
    return work.action === "push" ? pushItem(store, item, resolved.tracker, options) : drainItems(store, [item], resolved.tracker, options);
  } finally { store.close(); }
}
try { console.log(JSON.stringify(run(JSON.parse(process.argv[2]!)))); }
catch (error) { console.log(JSON.stringify({ error: (error as Error).message })); }
