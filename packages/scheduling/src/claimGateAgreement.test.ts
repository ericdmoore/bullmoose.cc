import { describe, expect, it } from "vitest";
import { fakeD1, type FakeD1 } from "@bullmoose/test-fakes";
import {
  ESCALATION_WINDOW_NO_HISTORY_MS,
  mayClaim,
  type BudgetState,
  type ClaimantIdentity,
} from "./mayClaim.js";
import {
  bindingEscalationWindowMs,
  budgetMonthStartMs,
  claimGateBinds,
  claimGateSql,
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

/** Budget variants: binding config + this-month spend rows + what the pure
 * side should be told. `spendPerMonth` in micro-USD. */
const BUDGETS: Record<
  string,
  { config: string; monthSpendMicros: number; lastMonthSpendMicros?: number; exhausted: boolean }
> = {
  "budget-none": { config: "{}", monthSpendMicros: 0, exhausted: false },
  "budget-under": {
    config: JSON.stringify({ budgets: { spendPerMonth: 5_000_000 } }),
    monthSpendMicros: 1_000_000,
    exhausted: false,
  },
  "budget-over": {
    config: JSON.stringify({ budgets: { spendPerMonth: 5_000_000 } }),
    monthSpendMicros: 5_000_000,
    exhausted: true,
  },
  // Only LAST month's spend exceeds the cap — proves the month bucketing.
  "budget-lastmonth": {
    config: JSON.stringify({ budgets: { spendPerMonth: 5_000_000 } }),
    monthSpendMicros: 0,
    lastMonthSpendMicros: 9_000_000,
    exhausted: false,
  },
  // A zero budget = "never spend paid": exhausted from the first moment.
  "budget-zero": {
    config: JSON.stringify({ budgets: { spendPerMonth: 0 } }),
    monthSpendMicros: 0,
    exhausted: true,
  },
  // Garbage tolerance: junk config can only FAIL to constrain.
  "budget-junk-config": { config: "not json {", monthSpendMicros: 9_000_000, exhausted: false },
  "budget-string-cap": {
    config: JSON.stringify({ budgets: { spendPerMonth: "5" } }),
    monthSpendMicros: 9_000_000,
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
    doneRow({ claimed_at: NOW - HOUR, done_at: NOW - HOUR + 1, cost_micros: opts.budget.monthSpendMicros });
  }
  if (opts.budget.lastMonthSpendMicros) {
    doneRow({
      claimed_at: MONTH_START - 2,
      done_at: MONTH_START - 1,
      cost_micros: opts.budget.lastMonthSpendMicros,
    });
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
    const outside = await verdicts(db, seeded, { claimant: paid, dueAt, privacy: null, requiresJson: null, budget, liveness, windowMs });
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
    const inside = await verdicts(db, seeded2, { claimant: paid, dueAt: NOW + 50 * 60_000, privacy: null, requiresJson: null, budget, liveness, windowMs: windowMs2 });
    expect(inside).toEqual({ pure: true, sql: true });

    // No history at all → the 1h default.
    const seeded3 = seedCase(db, { dueAt: null, privacy: null, requiresJson: null, budget, liveness });
    expect(await bindingEscalationWindowMs(db, seeded3.accountId, seeded3.bindingId)).toBe(
      ESCALATION_WINDOW_NO_HISTORY_MS,
    );
    db.close();
  });
});
