import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_V2, migrateFromV1 } from "./v2.ts";

export const SCHEMA = 2;

/** One row per item in a v1 -> v2 id mapping (including unchanged numbers). */
export type IdChange = { project: string; from: number; to: number; title: string };
export type MigrationResult = { from: number; to: number; backup?: string; changes: IdChange[] };

export function schemaVersion(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

/** Previews how a v1 database's global item ids map to per-project ids. Empty for other versions. */
export function planMigration(db: DatabaseSync): IdChange[] {
  if (schemaVersion(db) !== 1) return [];
  const rows = db.prepare("SELECT i.id AS id, i.title AS title, p.key AS project FROM items i JOIN projects p ON p.id = i.project_id ORDER BY i.project_id, i.id").all() as { id: number; title: string; project: string }[];
  const next = new Map<string, number>();
  return rows.map((row) => {
    const to = next.get(row.project) ?? 1;
    next.set(row.project, to + 1);
    return { project: row.project, from: Number(row.id), to, title: row.title };
  });
}

/** Writes a consistent sibling copy, with a UUID suffix to avoid collisions between attempts. */
export function backupDb(db: DatabaseSync, dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const target = `${dbPath}.v${schemaVersion(db)}-backup-${stamp}-${randomUUID()}`;
  db.prepare("VACUUM INTO ?").run(target);
  return target;
}

/** Internal registry contract. Steps must not manage transactions or user_version themselves. */
export type MigrationStep = {
  from: number;
  to: number;
  apply: (db: DatabaseSync) => void;
  preview?: (db: DatabaseSync) => IdChange[];
};

const migrations: readonly MigrationStep[] = [
  { from: 0, to: 2, apply: (db) => db.exec(SCHEMA_V2) },
  { from: 1, to: 2, apply: migrateFromV1, preview: planMigration },
];

function rejectNewer(version: number, target: number): void {
  if (version > target) throw new Error(`tdo database schema v${version} is newer than this tdo (v${target}).`);
}

/** Internal runner; explicit registry/target arguments let tests exercise future chains without bumping SCHEMA. */
export function runMigrations(db: DatabaseSync, dbPath: string | undefined, steps: readonly MigrationStep[], target: number): MigrationResult {
  const version = schemaVersion(db);
  rejectNewer(version, target);
  if (version === target) return { from: version, to: version, changes: [] };
  // VACUUM INTO cannot run inside the write transaction. Keep this single backup if an upgrade fails.
  let backup = version > 0 && dbPath && dbPath !== ":memory:" ? backupDb(db, dbPath) : undefined;
  db.exec("BEGIN IMMEDIATE");
  let from: number;
  const changes: IdChange[] = [];
  try {
    from = schemaVersion(db);
    rejectNewer(from, target);
    let current = from;
    while (current < target) {
      const step = steps.find((candidate) => candidate.from === current);
      if (!step || !Number.isInteger(step.to) || step.to <= current || step.to > target) throw new Error(`No migration from schema v${current} to v${target}.`);
      changes.push(...(step.preview?.(db) ?? []));
      step.apply(db);
      db.exec(`PRAGMA user_version = ${step.to}`);
      current = step.to;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  // Another process may have finished the upgrade before we obtained the write lock.
  if (from === target && backup) {
    fs.rmSync(backup, { force: true });
    backup = undefined;
  }
  return { from, to: target, backup, changes };
}

/** Upgrade atomically, backing up an existing file database once before taking the write lock. */
export function migrateDb(db: DatabaseSync, dbPath?: string): MigrationResult {
  return runMigrations(db, dbPath, migrations, SCHEMA);
}
