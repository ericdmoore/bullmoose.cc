import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MIGRATIONS } from "./migrations.mjs";

/**
 * The schema re-run cannot upgrade an existing database, and every failure that
 * comes out of that is silent. `infra/migrations.mjs` is the list of DDL a
 * re-run cannot perform; this file proves the list is honest.
 *
 * Two properties, and the second is the one that matters:
 *
 *   1. A FRESH database built from the .sql files satisfies every check. If it
 *      does not, the check disagrees with the schema and would send an operator
 *      chasing a migration that is already applied.
 *
 *   2. Each check FAILS once its migration is reversed, and passes again after
 *      `up`. Without this, a check that returned 1 unconditionally would look
 *      perfect in property 1 while detecting nothing — which is exactly the
 *      failure mode being guarded against, one level up.
 */

const ROOT = resolve(import.meta.dirname, "..");
const SCHEMAS = ["packages/mailstore/sql/data-plane.sql", "packages/mailstore/sql/control-plane.sql"];

/** A fresh database with the current schema, the way bootstrap `schemas` builds it. */
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const f of SCHEMAS) db.exec(readFileSync(resolve(ROOT, f), "utf8"));
  return db;
}

/** Every check is "one SQL returning n; applied iff n >= 1". */
function checkPasses(db: DatabaseSync, sql: string): boolean {
  const row = db.prepare(sql).get() as { n: number } | undefined;
  return (row?.n ?? 0) >= 1;
}

describe("infra/migrations — the DDL a schema re-run cannot perform", () => {
  it("the current schema satisfies every check", () => {
    const db = freshDb();
    const unmet = MIGRATIONS.filter((m) => !checkPasses(db, m.check)).map((m) => m.id);
    // A failure here means migrations.mjs and the .sql files disagree — either
    // a check is wrong, or the schema lost something a migration still claims.
    expect(unmet).toEqual([]);
  });

  it.each(MIGRATIONS.map((m) => [m.id, m] as const))(
    "%s — check reports missing when absent, applied after up",
    (_id, m) => {
      // A MINIMAL database in which this migration has not run: just enough
      // tables for `up` to execute. Built forward rather than by reversing the
      // real schema, because `ALTER TABLE … DROP COLUMN` makes SQLite re-parse
      // the table's stored CREATE and older builds fail it with `incomplete
      // input` — green locally, red in CI. A check that only holds on one
      // SQLite build is not a check.
      const db = new DatabaseSync(":memory:");
      for (const sql of m.absent) db.exec(sql);

      // The whole point. If this passes on a database where the migration
      // plainly has not run, the check cannot detect the drift it exists to
      // detect, and an operator would be told a missing migration was applied.
      expect(checkPasses(db, m.check), `${m.id}: check did not bite`).toBe(false);

      for (const sql of m.up) db.exec(sql);
      expect(checkPasses(db, m.check), `${m.id}: up did not satisfy its own check`).toBe(true);
    },
  );

  it("every `needs` names a real migration, and none precedes its dependency", () => {
    const order = MIGRATIONS.map((m) => m.id);
    for (const m of MIGRATIONS) {
      for (const need of m.needs ?? []) {
        expect(order, `${m.id} needs unknown ${need}`).toContain(need);
        // The runner applies in list order, so a dependency listed later would
        // fail at apply time rather than at review time.
        expect(order.indexOf(need), `${m.id} must follow ${need}`).toBeLessThan(
          order.indexOf(m.id),
        );
      }
    }
  });

  it("running every `up` against a fresh database is a no-op, not an error", () => {
    // Re-running the whole set has to be safe: an operator who is unsure which
    // migrations landed must be able to run them all. Column adds are the
    // exception -- SQLite has no ADD COLUMN IF NOT EXISTS -- so those throw
    // `duplicate column name`, which the runner treats as success. Anything
    // else throwing is a real defect in the DDL.
    const db = freshDb();
    for (const m of MIGRATIONS) {
      for (const sql of m.up) {
        try {
          db.exec(sql);
        } catch (err) {
          expect((err as Error).message, `${m.id}: ${sql.slice(0, 60)}`).toMatch(
            /duplicate column name/i,
          );
        }
      }
      expect(checkPasses(db, m.check), `${m.id} after re-run`).toBe(true);
    }
  });

  it("the migrations that break a worker outright are marked as deploy blockers", () => {
    // These are ordering-critical in a way the others are not: verifyBearer
    // filters on both auth columns (a worker deployed against a database
    // missing either one authenticates nobody), the agent worker's finish()
    // UPDATE names the s07 T5 cost columns (missing them fails every
    // invocation finalisation), and the ActionProposal JOIN projection SELECTs
    // the s10 T3 needsInfo columns (missing them fails every proposal read).
    // Naming them in data keeps the runbook and the runner from drifting apart.
    const blockers = MIGRATIONS.filter((m) => m.blocks === "deploy").map((m) => m.id).sort();
    expect(blockers).toEqual([
      "accounts-deleted-at",
      "grants-revoked-at",
      "invocation-cost-columns",
      "proposal-needsinfo-columns",
    ]);
  });

  it("grants_tuple is partial and bureau_grants_tuple is NOT", () => {
    // The pair that has to stay divergent. `grants` inserts with ON CONFLICT DO
    // NOTHING and needs the partial index so a tombstone stops occupying the
    // tuple; `bureau_grants` upserts and resurrects its tombstone, so a partial
    // index there breaks every write. Asserted together because the danger is
    // someone "fixing" the inconsistency.
    const db = freshDb();
    const sqlOf = (name: string) =>
      (db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(name) as { sql: string }).sql;
    expect(sqlOf("grants_tuple")).toMatch(/WHERE revoked_at IS NULL/);
    expect(sqlOf("bureau_grants_tuple")).not.toMatch(/WHERE/i);
  });
});
