#!/usr/bin/env node
// Entry point for the `tdo` bin. Plain JS on purpose: enabling Node's on-disk compile cache here,
// before src/cli.ts is loaded, lets later runs skip type-stripping and recompiling the TypeScript.
// That saves roughly 40-75 ms per invocation. NODE_DISABLE_COMPILE_CACHE=1 turns it off.
import module from "node:module";

module.enableCompileCache?.();
const { main } = await import("./cli.ts");
await main();
