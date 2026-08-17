import { describe, expect, it } from "vitest";
import { fakeD1, type FakeD1 } from "@bullmoose/test-fakes";
import {
  ESCALATION_WINDOW_NO_HISTORY_MS,
  budgetExhausted,
  mayClaim,
  type BudgetState,
  type ClaimantIdentity,
} from "./mayClaim.js";
import {
  bindingEscalationWindowMs,
  bindingMedianCostMicros,
  budgetMonthStartMs,
  budgetPeriodEndMs,
  budgetPeriodKey,
  claimFitBinds,
  claimFitSql,
  claimGateBinds,
  claimGateSql,
  dueWindowBinds,
  dueWindowSql,
  medianMicros,
  notPinnedSql,
} from "./claimGate.js";

/**
 * THE AGREEMENT PROOF (jobs-and-facets §5): the pure `mayClaim` and the SQL
 * fold `claimGateSql` are two formulations of ONE predicate, and this file is
 * what keeps that a fact rather than a comment. Every case seeds a real row
 * (live schema, real SQLite), evaluates BOTH formulations, and requires the
 * same verdict — for the exhaustive policy cross-product, the fit table, and
 * the garbage corners. A drift in either formulation fails here by name.
 *
 * Expectations are NOT hand-derived (the hand-written matrix lives in
 * mayClaim.test.ts); the property under test is agreement itself, plus a few
 * anchor assertions so the whole table cannot silently agree on nonsense.
 */

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);
const HOUR = 60 * 60_000;
const MONTH_START = budgetMonthStartMs(NOW);
const PERIOD = budgetPeriodKey(NOW);

// ---- case axes -------------------------------------------------------------

const CLAIMANTS: Record<string, ClaimantIdentity> = {
  free: { isFree: true, capabilities: null },
  paid: { isFree: false, capabilities: null },
};

const DUES: Record<string, number | null> = {
  "due-null": null,
  "due-far": NOW + 3 * HOUR, // outside the 1h no-history window
  "due-near": NOW + 10 * 60_000,
  "due-past": NOW - HOUR,
};

const PRIVACIES: Record<string, string | null> = {
  "privacy-null": null,
  pinned: "pinned",
};

/**
 * Budget variants: binding config + this-month spend rows + any APPROVED
 * OVERAGE rows (s11 T9) + what the pure side should be told.
 *
 * `exhausted` is DECLARED here and CHECKED against the pure fold
 * `budgetExhausted({capMicros, spentMicros, overageMicros})` in its own case
 * below — so the fixture cannot quietly teach the table a wrong expectation,
 * and the T9 overage term is exercised on both sides of the agreement rather
 * than only in the SQL. `capMicros: null` = no numeric cap the gate can read
 * (absent, junk config, or a string) → never exhausted.
 */
const BUDGETS: Record<
  string,
  {
    config: string;
    capMicros: number | null;
    monthSpendMicros: number;
    lastMonthSpendMicros?: number;
    /** Approved overage rows for THIS period, micro-USD (s11 T9). */
    overageMicros?: number[];
    /** An overage granted for a DIFFERENT period — must not count. */
    otherPeriodOverageMicros?: number;
    exhausted: boolean;
  }
> = {
  "budget-none": { config: "{}", capMicros: null, monthSpendMicros: 0, exhausted: false },
  "budget-under": {
    config: JSON.stringify({ budgets: { spendPerMonth: 5_000_000 } }),
    capMicros: 5_000_000,
    monthSpendMicros: 1_000_000,
    exhausted: false,
  },
  "budget-over": {
    config: JSON.stringify({ budgets: { spendPerMonth: 5_000_000 } }),
    capMicros: 5_000_000,
    monthSpendMicros: 5_000_000,
    exhausted: true,
  },
  // Only LAST month's spend exceeds the cap — proves the month bucketing.
  "budget-lastmonth": {
    config: JSON.stringify({ budgets: { spendPerMonth: 5_000_000 } }),
    capMicros: 5_000_000,
    monthSpendMicros: 0,
    lastMonthSpendMicros: 9_000_000,
    exhausted: false,
  },
  // A zero budget = "never spend paid": exhausted from the first moment.
  "budget-zero": {
    config: JSON.stringify({ budgets: { spendPerMonth: 0 } }),
    capMicros: 0,
    monthSpendMicros: 0,
    exhausted: true,
  },
  // Garbage tolerance: junk config can only FAIL to constrain.
  "budget-junk-config": {
    config: "not json {",
    capMicros: null,
    monthSpendMicros: 9_000_000,
    exhausted: false,
  },
  "budget-string-cap": {
    config: JSON.stringify({ budgets: { spendPerMonth: "5" } }),
    capMicros: null,
    monthSpendMicros: 9_000_000,
    exhausted: false,
  },
  // ---- s11 T9: the approved overage raises the ceiling, and only so far ----
  // Over the cap, but an approved overage covers the gap: claimable again.
  "budget-over-with-overage": {
    config: JSON.stringify({ budgets: { spendPerMonth: 5_000_000 } }),
    capMicros: 5_000_000,
    monthSpendMicros: 5_000_000,
    overageMicros: [2_000_000],
    exhausted: false,
  },
  // THE BOUND IS REAL: the same overage, spent through. Exhausted again.
  "budget-past-overage": {
    config: JSON.stringify({ budgets: { spendPerMonth: 5_000_000 } }),
    capMicros: 5_000_000,
    monthSpendMicros: 7_000_000,
    overageMicros: [2_000_000],
    exhausted: true,
  },
  // Two grants SUM rather than one shadowing the other.
  "budget-two-overages": {
    config: JSON.stringify({ budgets: { spendPerMonth: 5_000_000 } }),
    capMicros: 5_000_000,
    monthSpendMicros: 7_000_000,
    overageMicros: [2_000_000, 1_000_000],
    exhausted: false,
  },
  // Last period's grant does NOT travel: the period_key stops matching at the
  // month roll, which is how a T9 overage expires without a cleanup sweep.
  "budget-stale-overage": {
    config: JSON.stringify({ budgets: { spendPerMonth: 5_000_000 } }),
    capMicros: 5_000_000,
    monthSpendMicros: 5_000_000,
    otherPeriodOverageMicros: 9_000_000,
    exhausted: true,
  },
  // An overage against NO cap is inert, never a licence to spend.
  "budget-overage-no-cap": {
    config: "{}",
    capMicros: null,
    monthSpendMicros: 9_000_000,
    overageMicros: [9_000_000],
    exhausted: false,
  },
};

/** Liveness variants: an earlier claim row by a free claimant, or not. */
const LIVENESS: Record<string, { claimedAgoMs: number | null; live: boolean }> = {
  "free-absent": { claimedAgoMs: null, live: false },
  "free-live": { claimedAgoMs: 5 * 60_000, live: true },
  "free-stale": { claimedAgoMs: 20 * 60_000, live: false }, // beyond the 15min horizon
};

// ---- harness ---------------------------------------------------------------

interface Seeded {
  accountId: string;
  bindingId: string;
  invId: string;
}

let n = 0;
function seedCase(
  db: FakeD1,
  opts: {
    dueAt: number | null;
    privacy: string | null;
    requiresJson: string | null;
    budget: (typeof BUDGETS)[string];
    liveness: (typeof LIVENESS)[string];
    /** Durations (ms) of past done invocations — the window history. */
    durations?: number[];
  },
): Seeded {
  n += 1;
  const accountId = `a_case_${n}`;
  const bindingId = `b_case_${n}`;
  const invId = `inv_case_${n}`;
  db.seed("agent_bindings", [
    { id: bindingId, account_id: accountId, name: `bind${n}`, config_json: opts.budget.config },
  ]);
  db.seed("agent_invocations", [
    {
      id: invId,
      account_id: accountId,
      binding_id: bindingId,
      binding_name: `bind${n}`,
      status: "pending",
      created_at: 1,
      due_at: opts.dueAt,
      privacy: opts.privacy,
      requires_json: opts.requiresJson,
    },
  ]);
  let k = 0;
  const doneRow = (over: Record<string, unknown>) => {
    k += 1;
    db.seed("agent_invocations", [
      {
        id: `${invId}_h${k}`,
        account_id: accountId,
        binding_id: bindingId,
        binding_name: `bind${n}`,
        status: "done",
        created_at: 1,
        ...over,
      },
    ]);
  };
  if (opts.budget.monthSpendMicros > 0) {
    doneRow({
      claimed_at: NOW - HOUR,
      done_at: NOW - HOUR + 1,
      cost_micros: opts.budget.monthSpendMicros,
    });
  }
  if (opts.budget.lastMonthSpendMicros) {
    doneRow({
      claimed_at: MONTH_START - 2,
      done_at: MONTH_START - 1,
      cost_micros: opts.budget.lastMonthSpendMicros,
    });
  }
  // s11 T9 — the approved overage rows the gate adds to the cap.
  let o = 0;
  const overageRow = (periodKey: string, amount: number) => {
    o += 1;
    db.seed("agent_budget_overages", [
      {
        account_id: accountId,
        binding_id: bindingId,
        period_key: periodKey,
        amount_micros: amount,
        proposal_id: `${invId}_o${o}`,
        approved_by: "eric",
        approved_at: NOW - HOUR,
      },
    ]);
  };
  for (const amount of opts.budget.overageMicros ?? []) overageRow(PERIOD, amount);
  if (opts.budget.otherPeriodOverageMicros) {
    overageRow(budgetPeriodKey(MONTH_START - 1), opts.budget.otherPeriodOverageMicros);
  }
  if (opts.liveness.claimedAgoMs !== null) {
    doneRow({ claimed_at: NOW - opts.liveness.claimedAgoMs, done_at: NOW - 1, claimant_free: 1 });
  }
  for (const d of opts.durations ?? []) {
    doneRow({ claimed_at: NOW - 24 * HOUR, done_at: NOW - 24 * HOUR + d });
  }
  return { accountId, bindingId, invId };
}

/** Both verdicts for one seeded case; the caller asserts they agree. */
async function verdicts(
  db: FakeD1,
  seeded: Seeded,
  opts: {
    claimant: ClaimantIdentity;
    dueAt: number | null;
    privacy: string | null;
    requiresJson: string | null;
    budget: (typeof BUDGETS)[string];
    liveness: (typeof LIVENESS)[string];
    windowMs: number;
  },
): Promise<{ pure: boolean; sql: boolean }> {
  let requires: unknown = null;
  if (opts.requiresJson !== null) {
    try {
      requires = JSON.parse(opts.requiresJson);
    } catch {
      requires = null; // what the read surface does with an unparseable facet
    }
  }
  const budgetState: BudgetState = {
    budgetExhausted: opts.budget.exhausted,
    freeRuntimeLive: opts.liveness.live,
    escalationWindowMs: opts.windowMs,
  };
  const pure = mayClaim(
    { dueAt: opts.dueAt, privacy: opts.privacy, requires },
    opts.claimant,
    budgetState,
    NOW,
  );
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM agent_invocations
       WHERE account_id = ? AND id = ? AND status = 'pending'${claimGateSql("agent_invocations")}`,
    )
    .bind(
      seeded.accountId,
      seeded.invId,
      ...claimGateBinds({
        now: NOW,
        claimant: opts.claimant,
        escalationWindowMs: opts.windowMs,
        monthStartMs: MONTH_START,
      }),
    )
    .first<{ hit: number }>();
  return { pure, sql: row !== null };
}

// ---- the tables ------------------------------------------------------------

describe("claim gate: SQL and mayClaim agree", () => {
  it("placeholder count matches the bind list", () => {
    const sql = claimGateSql("inv");
    const binds = claimGateBinds({
      now: NOW,
      claimant: CLAIMANTS.paid!,
      escalationWindowMs: ESCALATION_WINDOW_NO_HISTORY_MS,
      monthStartMs: MONTH_START,
    });
    expect(sql.split("?").length - 1).toBe(binds.length);
  });

  /**
   * s11 T9 — the fixture table's `exhausted` column is not hand-wisdom: it is
   * what `budgetExhausted()` folds from (cap, spend, overage). Proving that
   * here is what makes the cross-product below an agreement test for the
   * OVERAGE term too, rather than for the two terms that predate it. Drift on
   * either side (a fixture that lies, or a fold that stops adding the overage)
   * fails by name.
   */
  it("the pure fold derives every fixture's exhausted verdict, overage included", () => {
    for (const [name, b] of Object.entries(BUDGETS)) {
      const overageMicros = (b.overageMicros ?? []).reduce((a, x) => a + x, 0);
      expect(
        budgetExhausted({
          capMicros: b.capMicros,
          spentMicros: b.monthSpendMicros,
          overageMicros,
        }),
        name,
      ).toBe(b.exhausted);
    }
    // Anchors: a cap with no overage is the pre-T9 comparison; an overage
    // against no cap grants nothing; the bound is `>=`, not `>`.
    expect(budgetExhausted({ capMicros: 100, spentMicros: 100, overageMicros: 0 })).toBe(true);
    expect(budgetExhausted({ capMicros: 100, spentMicros: 100, overageMicros: 1 })).toBe(false);
    expect(budgetExhausted({ capMicros: 100, spentMicros: 101, overageMicros: 1 })).toBe(true);
    expect(budgetExhausted({ capMicros: null, spentMicros: 1e9, overageMicros: 0 })).toBe(false);
  });

  it("the exhaustive policy cross-product (claimant × due × privacy × budget × liveness)", async () => {
    const db = fakeD1();
    const disagreements: string[] = [];
    let eligibleCount = 0;
    let total = 0;
    for (const [cName, claimant] of Object.entries(CLAIMANTS)) {
      for (const [dName, dueAt] of Object.entries(DUES)) {
        for (const [pName, privacy] of Object.entries(PRIVACIES)) {
          for (const [bName, budget] of Object.entries(BUDGETS)) {
            for (const [lName, liveness] of Object.entries(LIVENESS)) {
              const name = `${cName}/${dName}/${pName}/${bName}/${lName}`;
              const seeded = seedCase(db, { dueAt, privacy, requiresJson: null, budget, liveness });
              const opts = {
                claimant,
                dueAt,
                privacy,
                requiresJson: null,
                budget,
                liveness,
                windowMs: ESCALATION_WINDOW_NO_HISTORY_MS,
              };
              const v = await verdicts(db, seeded, opts);
              if (v.pure !== v.sql) disagreements.push(`${name}: pure=${v.pure} sql=${v.sql}`);
              if (v.pure) eligibleCount += 1;
              total += 1;
            }
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
    // Anchors so the table cannot agree vacuously: every free case is
    // eligible (policy never restricts free; requires is null here), and the
    // paid set is a strict, non-empty subset.
    const perClaimant = total / 2;
    expect(eligibleCount).toBeGreaterThan(perClaimant);
    expect(eligibleCount).toBeLessThan(total);
    db.close();
  });

  it("the fit table (capabilities × requires_json), both claimant kinds", async () => {
    const db = fakeD1();
    const caps = { vision: false, contextTokens: 32_000, tools: false };
    const capVariants: Array<[string, ClaimCapsOrNull]> = [
      ["undeclared", null],
      ["typical", caps],
      ["empty", {}],
      ["vision", { ...caps, vision: true }],
      ["tools", { ...caps, tools: true }],
      ["no-limit", { vision: true }],
    ];
    type ClaimCapsOrNull = ClaimantIdentity["capabilities"];
    const requiresVariants: Array<[string, string | null]> = [
      ["null", null],
      ["invalid-json", "not json {"],
      ["json-string", JSON.stringify("garbage")],
      ["json-array", JSON.stringify([1, 2])],
      ["vision", JSON.stringify({ vision: true })],
      ["vision-false", JSON.stringify({ vision: false })],
      ["vision-string", JSON.stringify({ vision: "true" })],
      ["tools", JSON.stringify({ tools: true })],
      ["ctx-fits", JSON.stringify({ contextTokens: 32_000 })],
      ["ctx-over", JSON.stringify({ contextTokens: 32_001 })],
      ["ctx-real-over", JSON.stringify({ contextTokens: 32_000.5 })],
      ["ctx-string", JSON.stringify({ contextTokens: "9999999" })],
      ["combined", JSON.stringify({ vision: true, contextTokens: 64_000 })],
    ];
    const disagreements: string[] = [];
    const fitVerdicts = new Set<boolean>();
    for (const [cName, capabilities] of capVariants) {
      for (const isFree of [true, false]) {
        for (const [rName, requiresJson] of requiresVariants) {
          const claimant: ClaimantIdentity = { isFree, capabilities };
          const seeded = seedCase(db, {
            dueAt: null,
            privacy: null,
            requiresJson,
            budget: BUDGETS["budget-none"]!,
            liveness: LIVENESS["free-absent"]!,
          });
          const v = await verdicts(db, seeded, {
            claimant,
            dueAt: null,
            privacy: null,
            requiresJson,
            budget: BUDGETS["budget-none"]!,
            liveness: LIVENESS["free-absent"]!,
            windowMs: ESCALATION_WINDOW_NO_HISTORY_MS,
          });
          const name = `${cName}/isFree=${isFree}/${rName}`;
          if (v.pure !== v.sql) disagreements.push(`${name}: pure=${v.pure} sql=${v.sql}`);
          fitVerdicts.add(v.pure);
        }
      }
    }
    expect(disagreements).toEqual([]);
    // Anchor: the table exercises both refusals and admissions.
    expect(fitVerdicts).toEqual(new Set([true, false]));
    db.close();
  });

  /**
   * s11 T3 uses this module PIECEWISE: the overdue backstop claims outside
   * `policy` (a gated claim would refuse the budget-exhausted overdue work it
   * exists to rescue) while keeping fit and the privacy pin. That is only
   * sound if the fragments are the same expressions the full gate folds — so
   * this proves the subset is a strict WIDENING that keeps the pin.
   */
  it("the T3 subset (fit ∧ notPinned) admits what the full gate refuses — but never a pin", async () => {
    const db = fakeD1();
    const paid = CLAIMANTS.paid!;
    const subsetSql = `SELECT 1 AS hit FROM agent_invocations
       WHERE account_id = ? AND id = ? AND status = 'pending'
         AND ${notPinnedSql("agent_invocations")}
         AND ${claimFitSql("agent_invocations")}`;
    const subsetHit = async (s: Seeded) =>
      (await db
        .prepare(subsetSql)
        .bind(s.accountId, s.invId, ...claimFitBinds(paid))
        .first<{ hit: number }>()) !== null;

    // Overdue AND out of budget: the full gate says no (exhaustion narrows the
    // claimant set), the backstop says yes (that is the whole point).
    const broke = {
      dueAt: NOW - HOUR,
      privacy: null,
      requiresJson: null,
      budget: BUDGETS["budget-over"]!,
      liveness: LIVENESS["free-absent"]!,
    };
    const brokeCase = seedCase(db, broke);
    const gated = await verdicts(db, brokeCase, {
      ...broke,
      claimant: paid,
      windowMs: ESCALATION_WINDOW_NO_HISTORY_MS,
    });
    expect(gated).toEqual({ pure: false, sql: false });
    expect(await subsetHit(brokeCase)).toBe(true);

    // The pin survives the bypass: overdue, in budget, pinned — refused by both.
    const pinned = { ...broke, privacy: "pinned", budget: BUDGETS["budget-none"]! };
    const pinnedCase = seedCase(db, pinned);
    expect(
      await verdicts(db, pinnedCase, {
        ...pinned,
        claimant: paid,
        windowMs: ESCALATION_WINDOW_NO_HISTORY_MS,
      }),
    ).toEqual({ pure: false, sql: false });
    expect(await subsetHit(pinnedCase)).toBe(false);

    // So does fit: a declared vector that cannot meet the requirement.
    const unfit = { ...broke, requiresJson: JSON.stringify({ vision: true }) };
    const unfitCase = seedCase(db, unfit);
    const seeing: ClaimantIdentity = { isFree: false, capabilities: { vision: false } };
    const seen = await db
      .prepare(subsetSql)
      .bind(unfitCase.accountId, unfitCase.invId, ...claimFitBinds(seeing))
      .first<{ hit: number }>();
    expect(seen).toBeNull();
    // ...and an UNDECLARED vector still claims it (T2-FIT-CONTRACT).
    expect(await subsetHit(unfitCase)).toBe(true);
    db.close();
  });

  /**
   * s11 T9 uses this module PIECEWISE too, and in the mirror image of T3's
   * subset: the budget-stranding sweep asks "would a paid claimant take this
   * row if the budget were not spent?" — fit ∧ notPinned ∧ dueWindow — AND
   * budgetExhausted. That counterfactual is only honest if it is built from
   * the SAME expressions the full gate folds, so this proves the decomposition:
   * gate ⟺ fit ∧ (free ∨ (notPinned ∧ ¬exhausted ∧ dueWindow)).
   */
  it("the T9 decomposition: (stranded-shape ∧ exhausted) is exactly what the gate refuses", async () => {
    const db = fakeD1();
    const paid = CLAIMANTS.paid!;
    const strandedShapeSql = `SELECT 1 AS hit FROM agent_invocations
       WHERE account_id = ? AND id = ? AND status = 'pending'
         AND ${notPinnedSql("agent_invocations")}
         AND ${claimFitSql("agent_invocations")}
         AND ${dueWindowSql("agent_invocations")}`;
    const strandedShape = async (s: Seeded) =>
      (await db
        .prepare(strandedShapeSql)
        .bind(
          s.accountId,
          s.invId,
          ...claimFitBinds(paid),
          ...dueWindowBinds({ now: NOW, escalationWindowMs: ESCALATION_WINDOW_NO_HISTORY_MS }),
        )
        .first<{ hit: number }>()) !== null;

    const mismatches: string[] = [];
    let strandedCount = 0;
    for (const [dName, dueAt] of Object.entries(DUES)) {
      for (const [pName, privacy] of Object.entries(PRIVACIES)) {
        for (const [bName, budget] of Object.entries(BUDGETS)) {
          for (const [lName, liveness] of Object.entries(LIVENESS)) {
            const opts = { dueAt, privacy, requiresJson: null, budget, liveness };
            const seeded = seedCase(db, opts);
            const v = await verdicts(db, seeded, {
              ...opts,
              claimant: paid,
              windowMs: ESCALATION_WINDOW_NO_HISTORY_MS,
            });
            const shape = await strandedShape(seeded);
            // The decomposition: a paid claimant is eligible exactly when the
            // stranded SHAPE holds and the budget is NOT exhausted. So the
            // budget-stranded set is (shape ∧ exhausted) — nothing else.
            const name = `${dName}/${pName}/${bName}/${lName}`;
            if (v.pure !== (shape && !budget.exhausted)) {
              mismatches.push(
                `${name}: gate=${v.pure} shape=${shape} exhausted=${budget.exhausted}`,
              );
            }
            if (shape && budget.exhausted) strandedCount += 1;
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    // Anchor: the stranded set is non-empty (otherwise T9 could never fire).
    expect(strandedCount).toBeGreaterThan(0);
    db.close();
  });

  it("the T9 period key and period end bracket the month the spend sum uses", () => {
    expect(budgetPeriodKey(NOW)).toBe("2026-08");
    // The key names the SAME month the spend bucket opens...
    expect(budgetPeriodKey(budgetMonthStartMs(NOW))).toBe(budgetPeriodKey(NOW));
    // ...and the period ends exactly where the next one's spend bucket begins,
    // so an overage and the cap it lifts expire in the same instant.
    expect(budgetPeriodEndMs(NOW)).toBe(budgetMonthStartMs(budgetPeriodEndMs(NOW)));
    expect(budgetPeriodKey(budgetPeriodEndMs(NOW))).toBe("2026-09");
    // December rolls the year, and the key is zero-padded so it sorts.
    const dec = Date.UTC(2026, 11, 31, 23, 59, 59);
    expect(budgetPeriodKey(dec)).toBe("2026-12");
    expect(budgetPeriodKey(budgetPeriodEndMs(dec))).toBe("2027-01");
    expect(budgetPeriodKey(Date.UTC(2026, 0, 5))).toBe("2026-01");
  });

  it("bindingMedianCostMicros reads paid history only, and says null when it has none", async () => {
    const db = fakeD1();
    const seeded = seedCase(db, {
      dueAt: null,
      privacy: null,
      requiresJson: null,
      budget: BUDGETS["budget-none"]!,
      liveness: LIVENESS["free-absent"]!,
    });
    // No history at all → unknown, never a guessed number.
    expect(await bindingMedianCostMicros(db, seeded.accountId, seeded.bindingId)).toBeNull();

    let k = 0;
    const costRow = (cost: number | null, status = "done") => {
      k += 1;
      db.seed("agent_invocations", [
        {
          id: `${seeded.invId}_c${k}`,
          account_id: seeded.accountId,
          binding_id: seeded.bindingId,
          binding_name: "b",
          status,
          created_at: 1,
          claimed_at: NOW - HOUR,
          done_at: NOW - HOUR + k,
          cost_micros: cost,
        },
      ]);
    };
    costRow(0); // genuinely free — predicts nothing about paid spend
    costRow(null); // undetermined — not a zero
    expect(await bindingMedianCostMicros(db, seeded.accountId, seeded.bindingId)).toBeNull();

    costRow(100);
    costRow(300);
    costRow(200);
    costRow(900, "failed"); // a crash is not a cost estimate
    expect(await bindingMedianCostMicros(db, seeded.accountId, seeded.bindingId)).toBe(200);

    // The pure fold, on its own.
    expect(medianMicros([])).toBeNull();
    expect(medianMicros([5])).toBe(5);
    expect(medianMicros([4, 2])).toBe(3);
    db.close();
  });

  it("bindingEscalationWindowMs reads real history and feeds both sides identically", async () => {
    const db = fakeD1();
    // Median of 10/20/40min = 20min → window 60min. due 90min out: outside.
    const budget = BUDGETS["budget-none"]!;
    const liveness = LIVENESS["free-absent"]!;
    const dueAt = NOW + 90 * 60_000;
    const seeded = seedCase(db, {
      dueAt,
      privacy: null,
      requiresJson: null,
      budget,
      liveness,
      durations: [10 * 60_000, 20 * 60_000, 40 * 60_000],
    });
    const windowMs = await bindingEscalationWindowMs(db, seeded.accountId, seeded.bindingId);
    expect(windowMs).toBe(60 * 60_000);
    const paid = CLAIMANTS.paid!;
    const outside = await verdicts(db, seeded, {
      claimant: paid,
      dueAt,
      privacy: null,
      requiresJson: null,
      budget,
      liveness,
      windowMs,
    });
    expect(outside).toEqual({ pure: false, sql: false });

    // Same history, due 50min out: inside the 60min window — both flip.
    const seeded2 = seedCase(db, {
      dueAt: NOW + 50 * 60_000,
      privacy: null,
      requiresJson: null,
      budget,
      liveness,
      durations: [10 * 60_000, 20 * 60_000, 40 * 60_000],
    });
    const windowMs2 = await bindingEscalationWindowMs(db, seeded2.accountId, seeded2.bindingId);
    expect(windowMs2).toBe(60 * 60_000);
    const inside = await verdicts(db, seeded2, {
      claimant: paid,
      dueAt: NOW + 50 * 60_000,
      privacy: null,
      requiresJson: null,
      budget,
      liveness,
      windowMs: windowMs2,
    });
    expect(inside).toEqual({ pure: true, sql: true });

    // No history at all → the 1h default.
    const seeded3 = seedCase(db, {
      dueAt: null,
      privacy: null,
      requiresJson: null,
      budget,
      liveness,
    });
    expect(await bindingEscalationWindowMs(db, seeded3.accountId, seeded3.bindingId)).toBe(
      ESCALATION_WINDOW_NO_HISTORY_MS,
    );
    db.close();
  });
});
