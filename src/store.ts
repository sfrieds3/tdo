/** Operation-level storage. SQLite handles never cross the SSH boundary. */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import * as core from "./core.ts";
import * as queue from "./link-ops.ts";

// v2 adds unbounded lists; v3 adds notes/filing; v4 adds lifecycle queues; v5 adds auto intent/awaiting filters; v6 adds synced labels.
export const RPC_VERSION = 6;
export const MAX_RPC_BYTES = 8 * 1024 * 1024;
export const SSH_TIMEOUT_MS = 20_000;

const operations = {
  leaseLinkOps: queue.leaseLinkOps,
  nextLinkOp: queue.nextLinkOp,
  ackOp: queue.ackOp,
  failOp: queue.failOp,
  releaseLinkOps: queue.releaseLinkOps,
  retryLinkOps: queue.retryLinkOps,
  addItem: core.addItem,
  listItems: core.listItems,
  listLinkedItems: core.listLinkedItems,
  findItem: core.findItem,
  getItem: core.getItem,
  getItemByNumber: core.getItemByNumber,
  updateItem: core.updateItem,
  setStatus: core.setStatus,
  addNote: core.addNote,
  deleteItem: core.deleteItem,
  getLink: core.getLink,
  claimLinkCreate: core.claimLinkCreate,
  finishLinkCreate: core.finishLinkCreate,
  expireStaleClaims: core.expireStaleClaims,
  attachLink: core.attachLink,
  detachLink: core.detachLink,
  countLinks: core.countLinks,
  countActive: core.countActive,
  listTags: core.listTags,
  listProjects: core.listProjects,
};
type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;
type Crud = { [K in keyof typeof operations]: { args: Tail<Parameters<(typeof operations)[K]>>; result: ReturnType<(typeof operations)[K]> } };
export type StoreOperations = Crud & {
  check: { args: []; result: { schema: number; compatible: boolean } };
  migrate: { args: [dryRun?: boolean]; result: core.MigrationResult & { dryRun?: boolean } };
};
export type Operation = keyof StoreOperations;
export interface Store {
  call<K extends Operation>(operation: K, ...args: StoreOperations[K]["args"]): StoreOperations[K]["result"];
  close(): void;
}
export interface AsyncStore {
  call<K extends Operation>(operation: K, ...args: StoreOperations[K]["args"]): Promise<StoreOperations[K]["result"]>;
  close(): void;
}
export type Target = { kind: "local"; path: string } | { kind: "ssh"; host: string; user?: string; port?: number; path: string };

/** Parse once; the remote path is JSON data, never a shell argument. */
export function parseTarget(value: string): Target {
  if (!value || /[\0\r\n]/.test(value)) throw new Error("invalid database target.");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value) || value === ":memory:") return { kind: "local", path: value };
  if (!value.startsWith("ssh://")) throw new Error("unsupported database scheme; use a local path or ssh:// URI.");
  // Parse authority ourselves: WHATWG URL normalizes dot segments before decoding.
  const match = /^ssh:\/\/(?:([^@/:]+)@)?(\[[0-9a-fA-F:]+\]|[^/:@]+)(?::([0-9]+))?(\/[^?#]*)$/.exec(value);
  if (!match) throw new Error("expected ssh://[user@]host[:port]/absolute/path (no password, query, or fragment).");
  const [, user, host, portText, encodedPath] = match;
  if (!/^(?:[A-Za-z0-9][A-Za-z0-9._-]*|\[[0-9a-fA-F:]+\])$/.test(host) || (user !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(user))) throw new Error("invalid SSH host or user.");
  if (host.startsWith("[") && isIP(host.slice(1, -1)) !== 6) throw new Error("invalid SSH IPv6 host.");
  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("invalid SSH port.");
  let remotePath: string;
  try { remotePath = decodeURIComponent(encodedPath); } catch { throw new Error("invalid percent encoding in SSH path."); }
  if (!remotePath.startsWith("/") || remotePath === "/" || /[\0\r\n]/.test(remotePath)) throw new Error("SSH database path must be an absolute file path.");
  return { kind: "ssh", host, user, port, path: remotePath };
}

/** Atomic replacement preserves aliases and forward-compatible config keys. */
export function saveDbTarget(target: string, env: NodeJS.ProcessEnv = process.env): void {
  parseTarget(target);
  core.updateConfig((config) => ({ ...config, db: target }), env);
}

function localCall<K extends Operation>(dbPath: string, explicitMigration: boolean, operation: K, args: StoreOperations[K]["args"], sharedDb?: ReturnType<typeof core.openDb>): StoreOperations[K]["result"] {
  const db = sharedDb ?? core.openDb(dbPath, { migrate: false });
  try {
    const version = core.schemaVersion(db);
    if (version > core.SCHEMA) throw new Error(`tdo database schema v${version} is newer than this tdo (v${core.SCHEMA}).`);
    if (operation === "migrate") {
      if (args[0]) return { from: version, to: core.SCHEMA, changes: core.planMigration(db), notesMoved: core.planNoteExtraction(db), dryRun: true } as StoreOperations[K]["result"];
      return core.migrateDb(db, dbPath) as StoreOperations[K]["result"];
    }
    if (version > 0 && version < core.SCHEMA && explicitMigration) throw new Error(`remote database schema v${version} requires explicit migration; run tdo migrate.`);
    core.migrateDb(db, dbPath);
    if (operation === "check") return { schema: core.schemaVersion(db), compatible: true } as StoreOperations[K]["result"];
    const fn = operations[operation as keyof typeof operations] as (db: ReturnType<typeof core.openDb>, ...args: unknown[]) => unknown;
    return fn(db, ...args) as StoreOperations[K]["result"];
  } finally { if (!sharedDb) db.close(); }
}

function localStore(dbPath: string): Store {
  let db: ReturnType<typeof core.openDb> | undefined;
  return {
    call(operation, ...args) {
      db ??= core.openDb(dbPath, { migrate: false });
      return localCall(dbPath, false, operation, args, db);
    },
    close() { db?.close(); db = undefined; },
  };
}

// Small closed validation grammar for the public RPC surface, not arbitrary SQL or CLI text.
type Validator = (value: unknown) => boolean;
const string: Validator = (v) => typeof v === "string";
const integer: Validator = (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const limit: Validator = (v) => v === 0 || integer(v);
const boolean: Validator = (v) => typeof v === "boolean";
const strings: Validator = (v) => Array.isArray(v) && v.every(string);
const optional = (test: Validator): Validator => (v) => v === undefined || test(v);
const nullable = (test: Validator): Validator => (v) => v === null || test(v);
const oneOf = (values: readonly string[]): Validator => (v) => typeof v === "string" && values.includes(v);
function object(fields: Record<string, Validator>): Validator {
  return (v) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((key) => Object.hasOwn(fields, key)) && Object.entries(fields).every(([key, test]) => test((v as Record<string, unknown>)[key]));
}
const project = object({ key: string, name: string, root: optional(string) });
const key: Validator = (v) => !!v && typeof v === "object" && !Array.isArray(v) && string((v as core.ItemKey).projectId) && integer((v as core.ItemKey).id);
const priority = oneOf(core.PRIORITIES);
const newItem = object({ project: (v) => string(v) || project(v), title: string, body: optional(string), priority: optional(priority), tags: optional(strings), fileRef: optional(string), source: optional(string), sessionId: optional(string), host: optional(string), createdByHuman: optional(boolean) });
const patch = object({ title: optional(string), body: optional(nullable(string)), priority: optional(priority), addTags: optional(strings), removeTags: optional(strings), fileRef: optional(nullable(string)) });
const autoIntent = object({ provider: oneOf(["github"]), destination: string, tag: string, authorized: boolean });
const filter = object({ project: optional(string), status: optional(oneOf(core.STATUS_FILTERS)), tags: optional(strings), minPriority: optional(priority), query: optional(string), limit: optional(limit), linked: optional(boolean), awaiting: optional(boolean) });
const outcome: Validator = (v) => object({ ok: (x) => x === true, externalId: string, url: string, snapshot: optional(object({ title: string, body: nullable(string), fileRef: nullable(string), tags: optional(strings) })), labels: optional(strings) })(v) || object({ ok: (x) => x === false, kind: oneOf(["attention", "retryable", "uncertain"]), message: string })(v);
const validators: Record<Operation, Validator[]> = {
  leaseLinkOps: [key, string, string, optional(object({ destination: string, externalId: nullable(string), url: nullable(string), createdAt: string }))], nextLinkOp: [key, string, string], ackOp: [key, string, string, integer, optional(strings)], failOp: [key, string, string, integer, boolean, string], releaseLinkOps: [key, string, string, optional(object({ destination: string, externalId: nullable(string), url: nullable(string), createdAt: string }))], retryLinkOps: [string],
  listLinkedItems: [string],
  addItem: [newItem, optional(autoIntent)], listItems: [optional(filter)], findItem: [string, string], getItem: [key], getItemByNumber: [string, integer],
  updateItem: [key, patch, optional(autoIntent)], setStatus: [key, oneOf(core.STATUSES), optional(nullable(string)), optional(boolean)], addNote: [key, string], deleteItem: [key], countActive: [string],
  getLink: [key, string], claimLinkCreate: [key, string, string, oneOf(["create", "force"])], finishLinkCreate: [key, string, string, outcome, optional(boolean)],
  expireStaleClaims: [string], attachLink: [key, string, string, string, string], detachLink: [key, string], countLinks: [string],
  listTags: [optional(string)], listProjects: [], check: [], migrate: [optional(boolean)],
};
function validateCall(operation: unknown, args: unknown): asserts operation is Operation {
  if (typeof operation !== "string" || !Object.hasOwn(validators, operation) || !Array.isArray(args)) throw new Error("invalid RPC operation.");
  const tests = validators[operation as Operation];
  if (args.length > tests.length || !tests.every((test, i) => test(args[i]))) throw new Error(`invalid arguments for ${operation}.`);
}

/** Helper ignores all server-side project/config/env resolution. Only absolute local files are allowed. */
export function handleRpc(input: string): string {
  try {
    if (Buffer.byteLength(input) > MAX_RPC_BYTES) throw new Error("RPC input exceeds size limit.");
    const request: unknown = JSON.parse(input);
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("invalid RPC envelope.");
    const envelope = request as Record<string, unknown>;
    if (Object.keys(envelope).sort().join(",") !== "args,operation,path,version" || envelope.version !== RPC_VERSION) throw new Error("incompatible RPC protocol; install a compatible tdo on the remote PATH.");
    if (typeof envelope.path !== "string" || !path.posix.isAbsolute(envelope.path) || /[\0\r\n]/.test(envelope.path)) throw new Error("RPC requires an absolute local database path.");
    validateCall(envelope.operation, envelope.args);
    const result = localCall(envelope.path, true, envelope.operation, envelope.args as never);
    const output = JSON.stringify({ version: RPC_VERSION, ok: true, result: result ?? null });
    if (Buffer.byteLength(output) > MAX_RPC_BYTES) throw new Error("RPC output exceeds size limit.");
    return output;
  } catch (error) {
    return JSON.stringify({ version: RPC_VERSION, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

const number: Validator = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const array = (test: Validator): Validator => (v) => Array.isArray(v) && v.every(test);
const note = object({ seq: integer, status: nullable(oneOf(core.STATUSES)), body: string, createdAt: string });
const link = object({ provider: string, destination: string, state: oneOf(core.LINK_STATES), externalId: nullable(string), url: nullable(string), error: nullable(string), claimedAt: nullable(string), createdAt: string, syncedAt: nullable(string), labels: nullable(strings), queued: number, attention: number, syncError: nullable(string) });
const item = object({ id: integer, projectId: string, project: string, title: string, body: nullable(string), priority, status: oneOf(core.STATUSES), tags: strings, fileRef: nullable(string), source: nullable(string), sessionId: nullable(string), host: nullable(string), createdAt: string, updatedAt: string, closedAt: nullable(string), notes: array(note), links: array(link) });
const linkCounts: Validator = (v) => !!v && typeof v === "object" && !Array.isArray(v) && Object.entries(v).every(([state, ids]) => (core.LINK_STATES as readonly string[]).includes(state) && array(integer)(ids));
const op = object({ seq: integer, op: oneOf(["update", "close", "reopen", "comment"]), reason: nullable(string), noteSeq: nullable(integer), status: oneOf(["queued", "attention"]), attempts: number, lastError: nullable(string) });
const resultValidators: Record<Operation, Validator> = {
  leaseLinkOps: boolean, nextLinkOp: nullable(op), ackOp: boolean, failOp: boolean, releaseLinkOps: boolean, retryLinkOps: number,
  listLinkedItems: array(item),
  addItem: item, listItems: array(item), findItem: item, getItem: nullable(item), getItemByNumber: nullable(item), updateItem: item, setStatus: item, addNote: item, deleteItem: item,
  getLink: nullable(link), claimLinkCreate: object({ token: optional(string), link }), finishLinkCreate: nullable(link), expireStaleClaims: (v) => typeof v === "number",
  attachLink: link, detachLink: nullable(link), countLinks: linkCounts,
  countActive: object({ total: number, doing: number, urgent: number, high: number, normal: number, low: number }),
  listTags: array(object({ tag: string, count: number })),
  listProjects: array(object({ key: string, name: string, active: number, total: number })),
  check: object({ schema: number, compatible: boolean }),
  migrate: object({ from: number, to: number, backup: optional(string), dryRun: optional(boolean), notesMoved: optional(number), changes: array(object({ project: string, from: integer, to: integer, title: string })) }),
};

function sshArgs(target: Extract<Target, { kind: "ssh" }>): string[] {
  return ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ConnectionAttempts=1", ...(target.port ? ["-p", String(target.port)] : []), ...(target.user ? ["-l", target.user] : []), "--", target.host.replace(/^\[|\]$/g, ""), "tdo internal-rpc"];
}
function request(target: Target, operation: Operation, args: unknown[]): string {
  validateCall(operation, args);
  const wireArgs = [...args];
  while (wireArgs.length && wireArgs.at(-1) === undefined) wireArgs.pop();
  const input = JSON.stringify({ version: RPC_VERSION, path: target.path, operation, args: wireArgs });
  if (Buffer.byteLength(input) > MAX_RPC_BYTES) throw new Error("RPC input exceeds size limit.");
  return input;
}
function response<K extends Operation>(stdout: string, operation: K): StoreOperations[K]["result"] {
  let reply: Record<string, unknown>;
  try { reply = JSON.parse(stdout); } catch { throw new Error("invalid SSH RPC response; ensure compatible remote tdo is on PATH and shell startup is quiet."); }
  if (!reply || reply.version !== RPC_VERSION || typeof reply.ok !== "boolean") throw new Error("incompatible SSH RPC response.");
  if (!reply.ok) throw new Error(`remote tdo: ${typeof reply.error === "string" ? reply.error : "invalid error response"}`);
  if (!Object.hasOwn(reply, "result") || !resultValidators[operation](reply.result)) throw new Error(`invalid SSH RPC result for ${operation}.`);
  // JSON has no undefined; optional lookups use null on the wire.
  return (reply.result === null && NULLABLE.has(operation) ? undefined : reply.result) as StoreOperations[K]["result"];
}
const NULLABLE = new Set<Operation>(["getItem", "getItemByNumber", "getLink", "finishLinkCreate", "detachLink", "nextLinkOp"]);
function transportError(error: unknown, stderr: string): Error {
  return new Error(`SSH database operation failed (no local fallback; writes may have completed): ${error instanceof Error ? error.message : String(error)}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
}

export function createStore(target = core.getDbPath(), options: { env?: NodeJS.ProcessEnv } = {}): Store {
  const parsed = parseTarget(target);
  if (parsed.kind === "local") return localStore(parsed.path);
  return {
    call(operation, ...args) {
      const child = spawnSync("ssh", sshArgs(parsed), { input: request(parsed, operation, args), encoding: "utf8", env: options.env ?? process.env, timeout: SSH_TIMEOUT_MS, maxBuffer: MAX_RPC_BYTES, killSignal: "SIGKILL" });
      if (child.error || child.status !== 0) throw transportError(child.error ?? `exit ${child.status ?? child.signal}`, child.stderr ?? "");
      return response(child.stdout, operation);
    },
    close() {},
  };
}

/** Nonblocking SSH API for hosts such as Pi. No synchronous SSH is used here. */
export function createAsyncStore(target = core.getDbPath(), options: { env?: NodeJS.ProcessEnv } = {}): AsyncStore {
  const parsed = parseTarget(target);
  if (parsed.kind === "local") {
    const local = localStore(parsed.path);
    return { async call(operation, ...args) { return local.call(operation, ...args); }, close() { local.close(); } };
  }
  return {
    async call(operation, ...args) {
      const input = request(parsed, operation, args);
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn("ssh", sshArgs(parsed), { env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
        const out: Buffer[] = [], err: Buffer[] = [];
        let bytes = 0;
        let failure: Error | undefined;
        const fail = (error: Error) => {
          if (failure) return;
          failure = error;
          clearTimeout(timer);
          child.kill("SIGKILL");
          // Proxy descendants may retain the pipes after ssh exits. Never wait for
          // their descriptors to close to enforce our own operation deadline.
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          reject(transportError(error, Buffer.concat(err).toString("utf8")));
        };
        const timer = setTimeout(() => fail(new Error("SSH operation timed out")), SSH_TIMEOUT_MS);
        const collect = (buffers: Buffer[]) => (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RPC_BYTES) { fail(new Error("SSH output exceeds size limit")); return; }
          buffers.push(chunk);
        };
        child.stdout.on("data", collect(out));
        child.stderr.on("data", collect(err));
        child.on("error", fail);
        child.stdin.on("error", fail);
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          if (failure || code !== 0) reject(transportError(failure ?? `exit ${code ?? signal}`, Buffer.concat(err).toString("utf8")));
          else resolve(Buffer.concat(out).toString("utf8"));
        });
        child.stdin.end(input);
      });
      return response(stdout, operation);
    },
    close() {},
  };
}

/** Bounded stdin reader used only by the fixed internal helper command. */
export async function serveRpc(): Promise<void> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_RPC_BYTES) throw new Error("RPC input exceeds size limit.");
    chunks.push(buffer);
  }
  process.stdout.write(handleRpc(Buffer.concat(chunks).toString("utf8")) + "\n");
}
