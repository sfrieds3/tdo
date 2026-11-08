/* Frozen historical schema and conversion: do not use current application helpers here. */
import type { DatabaseSync } from "node:sqlite";

/**
 * v3 -> v4 schema change. `links.labels` records, as a JSON array, the labels tdo itself applied to
 * the issue, so tag sync only ever removes labels tdo added. NULL means none are known.
 */
export function migrateToV4(db: DatabaseSync): void {
  db.exec("ALTER TABLE links ADD COLUMN labels TEXT;");
}
