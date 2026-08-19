import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import { SURPLUS_MINT_CAP, inSurplusWindow, projectSurplus, surplusBackfill, surplusMarkerId } from "./surplusBackfill";

/**
 * s26 T3 v2 — surplus burns the backlog (devPlan rule 2). Near the end of the
 * budget cycle, projected surplus mints backfill invocations: newest-first,
 * NULL-due, floor-bounded, idempotent per (binding, email) AND per (binding,
 * period). The tests are written to BITE:
 *
 *   - the projection is CONSERVATIVE by rounding (elapsed floors, remaining
 *     ceils — both shrink the surplus);
 *   - outside the last-N-days window, or under the 25% floor, NOTHING happens
 *     (DefaultCase silence, and no period marker — a later tick may qualify);
 *   - the mint respects the history floor, skips already-invoked mail, lands
 *     newest-first, NULL-due, with `backfill: true` (the scout trigger);
 *   - the batch is sized by what the surplus BUYS at the binding's median
 *     per-run cost; an unknown median stays null (never a guessed number);
 *   - one period gets ONE mint (the T9 period-marker, guarded-INSERT flavor),
 *     and the marker's result_json carries the dossier's ledger numbers.
 */

const ACCOUNT = "t_bm__a_surplus";
const TENANT = "t_bm";
const BINDING = "bind_scribe";
const DAY = 86_400_000;
const CAP = 5_000_000; // $5.00

// Aug 28, 2026 12:00 UTC — inside the last-5-days window of a 31-day month.
// Elapsed 27.5 days (floors to 27), remaining 3.5 (ceils to 4).
const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);
const MONTH_START = Date.UTC(2026, 7, 1);
const PERIOD_END = Date.UTC(2026, 8, 1);
const PERIOD = "2026-08";
const FLOOR_TS = NOW - 60 * DAY; // the binding's birth (createdAt)

const EXTRACT_CONFIG = {
  pipeline: "extract",
  defaultModel: "extract",
  modelAliases: {
    extract: [
      { provider: "workers-ai", model: "@cf/scout" },
      { provider: "mock", model: "paid" },
    ],
  },
  budgets: { spendPerMonth: CAP },
  createdAt: FLOOR_TS,
};

function scaffold(config: Record<string, unknown> = EXTRACT_CONFIG) {
  const w = fakeEnv();
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, displayName: "Scribe" });
  w.db.seed("agent_bindings", [
    { id: BINDING, account_id: ACCOUNT, name: "scribe", config_json: JSON.stringify(config) },
  ]);

  const seedEmail = (id: string, receivedAt: number) =>
    w.db.seed("emails", [
      { id, account_id: ACCOUNT, blob_id: `b_${id}`, thread_id: `t_${id}`, size: 1, received_at: receivedAt },
    ]);

  /** Spend `micros` this month, as a completed run — the SAME rows the spend
   * sum, the median estimator, and budgetExhaustedSql all read. */
  let spends = 0;
  const spend = (micros: number) => {
    spends += 1;
    w.db.seed("agent_invocations", [
      {
        id: `inv_spent_${spends}`,
        account_id: ACCOUNT,
        binding_id: BINDING,
        binding_name: "scribe",
        status: "done",
        created_at: MONTH_START + spends,
        claimed_at: NOW - 2000,
        done_at: NOW - 1000,
        cost_micros: micros,
      },
    ]);
  };

  const minted = () =>
    w.db.query<{ id: string; email_id: string; due_at: number | null; context_json: string; privacy: string | null }>(
      `SELECT id, email_id, due_at, context_json, privacy FROM agent_invocations
       WHERE account_id = ? AND binding_id = ? AND status = 'pending'
       ORDER BY email_id`,
      ACCOUNT,
      BINDING,
    );

  const marker = () =>
    w.db.query<{ id: string; status: string; cost_micros: number; context_json: string; result_json: string }>(
      `SELECT id, status, cost_micros, context_json, result_json FROM agent_invocations
       WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      surplusMarkerId(BINDING, PERIOD),
    );

  const run = (now: number = NOW) => surplusBackfill(w.env as never, now);

  return { w, seedEmail, spend, minted, marker, run };
}

// ---- the projection, pure -------------------------------------------------

describe("projectSurplus — conservative by rounding", () => {
  const base = { now: NOW, monthStartMs: MONTH_START, periodEndMs: PERIOD_END, grantedMicros: 0 };

  it("floors elapsed days and ceils remaining days — both shrink the surplus", () => {
    const p = projectSurplus({ ...base, capMicros: CAP, spentMicros: 2_700_000 });
    expect(p.elapsedDays).toBe(27); // 27.5 elapsed → the average is INFLATED
    expect(p.remainingDays).toBe(4); // 3.5 remaining → the projection is INFLATED
    expect(p.projectedMicros).toBe(400_000); // (2.7M / 27) × 4
    expect(p.surplusMicros).toBe(1_900_000); // 5M − 2.7M − 0.4M
    expect(p.floorMicros).toBe(1_250_000); // 25% of the effective cap
  });

  it("an over-pace month projects a NEGATIVE surplus, never a clamped zero", () => {
    const p = projectSurplus({ ...base, capMicros: CAP, spentMicros: 4_950_000 });
    expect(p.surplusMicros).toBeLessThan(0);
  });

  it("nothing spent = the whole cap is surplus (no evidence of a spend rate)", () => {
    const p = projectSurplus({ ...base, capMicros: CAP, spentMicros: 0 });
    expect(p.projectedMicros).toBe(0);
    expect(p.surplusMicros).toBe(CAP);
  });

  it("an approved overage widens the effective cap — budgetExhaustedSql's own ceiling", () => {
    const p = projectSurplus({ ...base, capMicros: CAP, grantedMicros: 1_000_000, spentMicros: 2_700_000 });
    expect(p.capEffectiveMicros).toBe(6_000_000);
    expect(p.surplusMicros).toBe(2_900_000);
    expect(p.floorMicros).toBe(1_500_000);
  });

  it("inSurplusWindow: the last 5 UTC days of the month, and not a day sooner", () => {
    expect(inSurplusWindow(Date.UTC(2026, 7, 10))).toBe(false);
    expect(inSurplusWindow(Date.UTC(2026, 7, 26, 23, 59))).toBe(false); // Aug 27 00:00 is the edge
    expect(inSurplusWindow(Date.UTC(2026, 7, 27, 0, 0))).toBe(true);
    expect(inSurplusWindow(Date.UTC(2026, 7, 31, 23, 59))).toBe(true);
  });
});

// ---- the sweep ------------------------------------------------------------

describe("surplusBackfill — the mint", () => {
  it("mints newest-first, NULL-due, backfill-flagged, sized by what the surplus buys", async () => {
    const s = scaffold();
    // $2.70 spent in three $0.90 runs → median $0.90, surplus $1.90 → 2 runs.
    s.spend(900_000);
    s.spend(900_000);
    s.spend(900_000);
    // Five backlog messages inside the floor window...
    s.seedEmail("e_d1", NOW - 1 * DAY);
    s.seedEmail("e_d2", NOW - 2 * DAY);
    s.seedEmail("e_d9", NOW - 9 * DAY);
    s.seedEmail("e_d20", NOW - 20 * DAY);
    s.seedEmail("e_d40", NOW - 40 * DAY);
    // ...one BEHIND the history floor (never minted)...
    s.seedEmail("e_ancient", NOW - 90 * DAY);
    // ...and one already invoked (live delivery) — the per-email guard's job.
    s.seedEmail("e_live", NOW - 3 * DAY);
    s.w.db.seed("agent_invocations", [
      {
        id: "inv_live",
        account_id: ACCOUNT,
        binding_id: BINDING,
        binding_name: "scribe",
        status: "done",
        email_id: "e_live",
        created_at: NOW - 3 * DAY,
      },
    ]);

    expect(await s.run()).toEqual({ bindings: 1, minted: 2 });

    // The TWO NEWEST un-invoked messages, and only those.
    const rows = s.minted();
    expect(rows.map((r) => r.email_id)).toEqual(["e_d1", "e_d2"]);
    for (const r of rows) {
      expect(r.due_at).toBeNull(); // sit-free: a homelab may eat it at $0
      const ctx = JSON.parse(r.context_json) as Record<string, unknown>;
      expect(ctx.backfill).toBe(true); // the scout trigger (extract.ts)
      expect(ctx.surplusPeriod).toBe(PERIOD);
      expect(ctx.emailId).toBe(r.email_id);
    }

    // The marker carries the dossier's ledger — "surplus $1.90 of $5.00,
    // 2 of 5 messages" is read from here, never re-derived.
    const mk = s.marker();
    expect(mk).toHaveLength(1);
    expect(mk[0]!.status).toBe("done");
    expect(mk[0]!.cost_micros).toBe(0);
    expect(JSON.parse(mk[0]!.result_json)).toMatchObject({
      kind: "surplus-backfill",
      periodKey: PERIOD,
      surplusMicros: 1_900_000,
      capEffectiveMicros: CAP,
      spentMicros: 2_700_000,
      projectedMicros: 400_000,
      medianMicros: 900_000,
      affordable: 2,
      backlog: 5,
      minted: 2,
    });
  });

  it("is idempotent per (binding, period): a second tick re-mints NOTHING", async () => {
    const s = scaffold();
    s.spend(900_000);
    s.spend(900_000);
    s.spend(900_000);
    s.seedEmail("e_a", NOW - 1 * DAY);
    s.seedEmail("e_b", NOW - 2 * DAY);
    s.seedEmail("e_c", NOW - 3 * DAY);

    expect(await s.run()).toEqual({ bindings: 1, minted: 2 });
    // The next tick — same period, backlog still standing — is a no-op: the
    // marker stops the re-scan (the per-email guard would stop duplicates
    // anyway; the marker stops the wasted work).
    expect(await s.run()).toEqual({ bindings: 0, minted: 0 });
    expect(await s.run(NOW + DAY)).toEqual({ bindings: 0, minted: 0 });
    expect(s.minted()).toHaveLength(2);
    expect(s.marker()).toHaveLength(1);
  });

  it("outside the last-5-days window: silence, no mint, no marker", async () => {
    const s = scaffold();
    s.spend(900_000);
    s.seedEmail("e_a", NOW - 1 * DAY);
    expect(await s.run(Date.UTC(2026, 7, 10))).toEqual({ bindings: 0, minted: 0 });
    expect(s.minted()).toEqual([]);
    expect(s.marker()).toEqual([]);
  });

  it("a thin surplus (under 25% of cap) mints nothing — and leaves NO marker, so a later tick may qualify", async () => {
    const s = scaffold();
    // $4.50 spent at a pace that projects past the cap: surplus < 0 < floor.
    for (let i = 0; i < 5; i++) s.spend(900_000);
    s.seedEmail("e_a", NOW - 1 * DAY);
    expect(await s.run()).toEqual({ bindings: 0, minted: 0 });
    expect(s.minted()).toEqual([]);
    expect(s.marker()).toEqual([]); // the period is NOT burned by a refusal
  });

  it("no history floor (pre-s26 binding): fails CLOSED — surplus or not, nothing is minted", async () => {
    const cfg = { ...EXTRACT_CONFIG } as Record<string, unknown>;
    delete cfg.createdAt;
    const s = scaffold(cfg);
    s.spend(900_000);
    s.seedEmail("e_a", NOW - 1 * DAY);
    expect(await s.run()).toEqual({ bindings: 0, minted: 0 });
    expect(s.minted()).toEqual([]);
    expect(s.marker()).toEqual([]);
  });

  it("an approved floor widening (historyFloor) reaches behind createdAt", async () => {
    const s = scaffold({ ...EXTRACT_CONFIG, historyFloor: NOW - 100 * DAY });
    s.spend(900_000); // median $0.90; spent $0.90 → surplus $3.95 → 4 runs
    s.seedEmail("e_old", NOW - 90 * DAY); // behind createdAt, inside historyFloor
    expect(await s.run()).toEqual({ bindings: 1, minted: 1 });
    expect(s.minted().map((r) => r.email_id)).toEqual(["e_old"]);
  });

  it("unknown median (no paid history): affordable stays NULL, the batch cap alone bounds the mint", async () => {
    const s = scaffold();
    // No spend at all: surplus = the whole cap, but no per-run cost to size
    // by. Minting is queueing, not spending — the claim gate still holds the
    // cap — so the mint proceeds under SURPLUS_MINT_CAP with the unknown
    // carried as null, never a guessed number.
    s.seedEmail("e_a", NOW - 1 * DAY);
    s.seedEmail("e_b", NOW - 2 * DAY);
    expect(await s.run()).toEqual({ bindings: 1, minted: 2 });
    const ledger = JSON.parse(s.marker()[0]!.result_json) as Record<string, unknown>;
    expect(ledger.medianMicros).toBeNull();
    expect(ledger.affordable).toBeNull();
    expect(ledger.minted).toBe(2);
    expect(SURPLUS_MINT_CAP).toBeGreaterThanOrEqual(2);
  });

  it("a free-only cost history ($0 runs) predicts nothing about paid cost — treated as unknown, not as infinite affordability", async () => {
    const s = scaffold();
    s.spend(0); // a homelab/workers-ai run: known and genuinely free
    s.seedEmail("e_a", NOW - 1 * DAY);
    expect(await s.run()).toEqual({ bindings: 1, minted: 1 });
    const ledger = JSON.parse(s.marker()[0]!.result_json) as Record<string, unknown>;
    expect(ledger.medianMicros).toBeNull(); // cost>0 is the estimator's population
    expect(ledger.affordable).toBeNull();
  });

  it("only backfillable pipelines: a budgeted REPLY binding with a backlog mints nothing", async () => {
    const s = scaffold({ ...EXTRACT_CONFIG, pipeline: "reply" });
    s.seedEmail("e_a", NOW - 1 * DAY);
    expect(await s.run()).toEqual({ bindings: 0, minted: 0 });
    expect(s.minted()).toEqual([]);
  });

  it("no budget cap configured (or cap 0): never considered", async () => {
    const noBudget = { ...EXTRACT_CONFIG } as Record<string, unknown>;
    delete noBudget.budgets;
    const s = scaffold(noBudget);
    s.seedEmail("e_a", NOW - 1 * DAY);
    expect(await s.run()).toEqual({ bindings: 0, minted: 0 });

    const zero = scaffold({ ...EXTRACT_CONFIG, budgets: { spendPerMonth: 0 } });
    zero.seedEmail("e_a", NOW - 1 * DAY);
    expect(await zero.run()).toEqual({ bindings: 0, minted: 0 });
  });

  it("an approved overage widens what the surplus mint may plan against", async () => {
    const s = scaffold();
    s.spend(900_000);
    s.spend(900_000);
    s.spend(900_000);
    s.w.db.seed("agent_budget_overages", [
      {
        account_id: ACCOUNT,
        binding_id: BINDING,
        period_key: PERIOD,
        amount_micros: 1_000_000,
        proposal_id: "prop_1",
        approved_at: NOW - DAY,
      },
    ]);
    for (let i = 1; i <= 5; i++) s.seedEmail(`e_${i}`, NOW - i * DAY);
    // capEffective $6.00 → surplus $2.90 → floor(2.9/0.9) = 3 runs.
    expect(await s.run()).toEqual({ bindings: 1, minted: 3 });
    expect(JSON.parse(s.marker()[0]!.result_json)).toMatchObject({
      capEffectiveMicros: 6_000_000,
      surplusMicros: 2_900_000,
      affordable: 3,
    });
  });

  it("a disabled binding and a deleted account are never considered", async () => {
    const s = scaffold();
    s.spend(900_000);
    s.seedEmail("e_a", NOW - 1 * DAY);
    s.w.db.query(`UPDATE agent_bindings SET enabled = 0 WHERE id = ?`, BINDING);
    expect(await s.run()).toEqual({ bindings: 0, minted: 0 });

    s.w.db.query(`UPDATE agent_bindings SET enabled = 1 WHERE id = ?`, BINDING);
    s.w.db.query(`UPDATE accounts SET deleted_at = ? WHERE id = ?`, NOW, ACCOUNT);
    expect(await s.run()).toEqual({ bindings: 0, minted: 0 });
  });

  it("fails OPEN: a binding whose money query explodes does not take the pass down", async () => {
    const s = scaffold();
    s.spend(900_000);
    s.seedEmail("e_a", NOW - 1 * DAY);
    const db = s.w.env.DB;
    const realPrepare = db.prepare.bind(db);
    let calls = 0;
    (db as { prepare: unknown }).prepare = (sql: string) => {
      calls += 1;
      if (sql.includes("agent_budget_overages") && sql.includes("SUM(s.cost_micros)")) {
        throw new Error("boom — injected");
      }
      return realPrepare(sql);
    };
    // The per-binding failure is swallowed (loudly) and the pass reports
    // nothing minted rather than throwing into `scheduled`.
    await expect(s.run()).resolves.toEqual({ bindings: 0, minted: 0 });
    expect(calls).toBeGreaterThan(0);
  });
});
