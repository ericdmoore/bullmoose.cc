import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "./migrations.mjs";

/**
 * The deploy hazard this catches, found live on 2026-08-14:
 *
 *   `bootstrap.mjs` runs `schemas` BEFORE `migrate`. On a FRESH database the
 *   schema file's `CREATE TABLE` carries every column, so an index over any of
 *   them succeeds. On an EXISTING database `CREATE TABLE IF NOT EXISTS` skips
 *   the table entirely — the column arrives only via `migrate`, which has not
 *   run yet — so the index fails and the whole phase dies:
 *
 *       ✘ no such column: job_id at offset 211: SQLITE_ERROR
 *
 * It passes on every fresh shard and fails on every existing one, which is the
 * worst shape a deploy bug can have: it works when you test it and breaks when
 * you ship it.
 *
 * The rule: an index over a column a migration ADDs belongs in that migration's
 * `up`, which is the only place both orderings are safe.
 */

const SCHEMAS = [
  "../packages/mailstore/sql/data-plane.sql",
  "../packages/mailstore/sql/control-plane.sql",
];

/** `(table, column)` pairs every migration adds via ALTER TABLE … ADD COLUMN. */
function migratedColumns(): Map<string, Set<string>> {
  const byTable = new Map<string, Set<string>>();
  for (const m of MIGRATIONS) {
    for (const stmt of m.up ?? []) {
      const hit = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i.exec(String(stmt));
      if (!hit) continue;
      const [, table, column] = hit;
      const cols = byTable.get(table!) ?? new Set<string>();
      cols.add(column!);
      byTable.set(table!, cols);
    }
  }
  return byTable;
}

/** `CREATE INDEX … ON <table> (<cols>)` from a schema file, newlines and all. */
function schemaIndexes(sql: string): Array<{ name: string; table: string; columns: string[] }> {
  const out: Array<{ name: string; table: string; columns: string[] }> = [];
  const re =
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)/gis;
  for (const m of sql.matchAll(re)) {
    const [, name, table, cols] = m;
    out.push({
      name: name!,
      table: table!,
      // COALESCE(x, '') and friends appear in partial indexes; take bare words
      // and let the intersection below decide what matters.
      columns: (cols ?? "").split(",").flatMap((c) => c.match(/\w+/g) ?? []),
    });
  }
  return out;
}

describe("no schema-file index may reference a migration-added column", () => {
  const migrated = migratedColumns();

  it("finds the migrated columns at all (guards the parser, not the code)", () => {
    // If this ever goes empty the test above passes vacuously and stops being
    // a check — the exact failure mode a static scan is prone to.
    expect(migrated.size).toBeGreaterThan(3);
    expect(migrated.get("agent_invocations")?.has("job_id")).toBe(true);
  });

  for (const rel of SCHEMAS) {
    it(`${rel.split("/").pop()} indexes only columns the CREATE TABLE carries`, () => {
      const sql = readFileSync(new URL(rel, import.meta.url), "utf8");
      const offenders: string[] = [];
      for (const idx of schemaIndexes(sql)) {
        const added = migrated.get(idx.table);
        if (!added) continue;
        for (const col of idx.columns) {
          if (added.has(col)) {
            offenders.push(
              `${idx.name} ON ${idx.table}(${col}) — ${col} is added by a migration, ` +
                `so this index cannot exist when \`schemas\` runs on an existing shard. ` +
                `Move it into that migration's \`up\`.`,
            );
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
