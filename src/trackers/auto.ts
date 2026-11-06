/** Serializable caller-side decision. The store persists intent, never contacts a tracker. */
import type { EffectiveTracker } from "./config.ts";
import { isApproved } from "./config.ts";

export type AutoIntent = { provider: "github"; destination: string; tag: string; authorized: boolean };

export function isHumanCommand(tty: boolean, source: string): boolean {
  return tty && (source === "cli" || source === "user");
}

export function autoIntent(config: EffectiveTracker | undefined, human: boolean): AutoIntent | undefined {
  if (!config || config.mode !== "auto-on-tag") return undefined;
  return { provider: config.provider, destination: config.destination, tag: config.tag, authorized: human && isApproved(config) };
}
