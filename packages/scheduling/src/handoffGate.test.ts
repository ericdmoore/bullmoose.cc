import { describe, expect, it } from "vitest";
import { fakeD1, type FakeD1 } from "@bullmoose/test-fakes";
import {
  budgetMonthStartMs,
  budgetPeriodKey,
  claimGateBinds,
  claimGateSql,
  handoffOriginBudgetExhaustedSql,
} from "./claimGate.js";
import { budgetExhausted, mayClaim, type BudgetState, type ClaimantIdentity } from "./mayClaim.js";

/**
 * s17 — BUDGET FOLLOWS THE WORK, HONESTLY.
 *
 * The decision this file enforces, stated once:
 *
 *   THE PURSE IS THE RECEIVER'S — a handed-off node runs on the receiving
 *   binding, so its `cost_micros` lands on the receiving row and the
 *   receiver's monthly sum sees it. Correct attribution: the receiver made
 *   the call, so the receiver's dossier shows the money.
 *
 *   THE GATE IS BOTH — the claim must clear the receiving binding's month AND
 *   the HANDING binding's. A binding that has spent its month must not be able
 *   to keep working by handing its backlog to a colleague; that is the
 *   authority-laundering shape, one level up, in money.
 *
 * The arithmetic is `budgetExhaustedSql`'s, moved one join across: same UTC
 * month, same sum over FINISHED rows, same `cap + approved overage` ceiling.
 * The pure twin is `budgetExhausted()` applied to the origin binding's numbers
 * and carried into `mayClaim` as `BudgetState.handoffOriginBudgetExhausted` —
 * one predicate, two formulations, held together here the way
 * `claimGateAgreement.test.ts` holds the rest of the gate.
 */

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const MONTH_START = budgetMonthStartMs(NOW);
const PERIOD = budgetPeriodKey(NOW);
const FREE: ClaimantIdentity = { isFree: true, capabilities: null };
const PAID: ClaimantIdentity = { isFree: false, capabilities: null };

let n = 0;

interface Seed {
  /** The HANDING binding's monthly cap, micro-USD. null = none configured. */
  originCapMicros?: number | null;
  /** Finished spend on the HANDING binding, this month. `null` = a NULL cost. */
  originSpend?: Array<number | null>;
  /** Spend on the handing binding in a PREVIOUS month — must not count. */
  originLastMonthSpend?: number;
  /** An approved overage on the HANDING binding, this period. */
  originOverageMicros?: number;
  /** Overwrite the row's context_json wholesale (junk cases). */
  contextJson?: string;
  /** Point the provenance at a binding that does not exist. */
  danglingOrigin?: boolean;
  /** Omit the handoff provenance entirely — an ordinary invocation. */
  noHandoff?: boolean;
}

/**
 * One account, two bindings (`cj` hands, `allen` receives) and one pending row
 * on `allen` carrying handoff provenance. `allen` itself has NO cap, so the
 * only money term that can bite is the one under test.
 */
function seedCase(db: FakeD1, opts: Seed) {
  n += 1;
  const accountId = `a_ho_${n}`;
  const origin = `b_cj_${n}`;
  const receiver = `b_allen_${n}`;
  const invId = `inv_ho_${n}`;

  const originConfig =
    opts.originCapMicros === undefined || opts.originCapMicros === null
      ? "{}"
      : JSON.stringify({ budgets: { spendPerMonth: opts.originCapMicros } });

  db.seed("agent_bindings", [
    { id: origin, account_id: accountId, name: `cj${n}`, config_json: originConfig },
    { id: receiver, account_id: accountId, name: `allen${n}`, config_json: "{}" },
  ]);

  const context = opts.noHandoff
    ? { kind: "job-node", op: "echo" }
    : {
        kind: "job-node",
        op: "echo",
        handoff: {
          from: {
            invocationId: `inv_from_${n}`,
            bindingId: opts.danglingOrigin ? `b_gone_${n}` : origin,
            bindingName: `cj${n}`,
          },
          to: { bindingId: receiver, bindingName: `allen${n}` },
          reason: "Allen owns spend questions",
          hop: 1,
          at: NOW,
        },
      };

  const rows: Array<Record<string, unknown>> = [
    {
      id: invId,
      account_id: accountId,
      binding_id: receiver,
      binding_name: `allen${n}`,
      status: "pending",
      created_at: 1,
      context_json: opts.contextJson ?? JSON.stringify(context),
    },
  ];
  (opts.originSpend ?? []).forEach((cost, i) => {
    rows.push({
      id: `inv_spend_${n}_${i}`,
      account_id: accountId,
      binding_id: origin,
      binding_name: `cj${n}`,
      status: "done",
      created_at: 1,
      done_at: MONTH_START + 1000,
      cost_micros: cost,
      context_json: "{}",
    });
  });
  if (opts.originLastMonthSpend !== undefined) {
    rows.push({
      id: `inv_old_${n}`,
      account_id: accountId,
      binding_id: origin,
      binding_name: `cj${n}`,
      status: "done",
      created_at: 1,
      done_at: MONTH_START - 1000,
      cost_micros: opts.originLastMonthSpend,
      context_json: "{}",
    });
  }
  db.seed("agent_invocations", rows);

  if (opts.originOverageMicros !== undefined) {
    db.seed("agent_budget_overages", [
      {
        account_id: accountId,
        binding_id: origin,
        period_key: PERIOD,
        amount_micros: opts.originOverageMicros,
        approved_at: NOW,
        proposal_id: `p_${n}`,
      },
    ]);
  }

  return { accountId, origin, receiver, invId };
}

/** Would the gate let `claimant` take this row right now? */
async function claimable(db: FakeD1, s: { accountId: string; invId: string }, claimant: ClaimantIdentity) {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM agent_invocations
       WHERE account_id = ? AND id = ? AND status = 'pending'${claimGateSql("agent_invocations")}`,
    )
    .bind(
      s.accountId,
      s.invId,
      ...claimGateBinds({ now: NOW, claimant, escalationWindowMs: 60 * 60_000, monthStartMs: MONTH_START }),
    )
    .first<{ hit: number }>();
  return row !== null;
}

/** The term ALONE, so its verdict can be read without the rest of the gate. */
async function originExhausted(db: FakeD1, s: { accountId: string; invId: string }) {
  const row = await db
    .prepare(
      `SELECT ${handoffOriginBudgetExhaustedSql("agent_invocations")} AS hit
         FROM agent_invocations WHERE account_id = ? AND id = ?`,
    )
    .bind(MONTH_START, PERIOD, s.accountId, s.invId)
    .first<{ hit: number }>();
  return row?.hit === 1;
}

describe("the handing binding's month gates handed-off work", () => {
  it("origin UNDER its cap: the handed-off row claims (the control)", async () => {
    const db = fakeD1();
    const s = seedCase(db, { originCapMicros: 1000, originSpend: [400] });
    expect(await originExhausted(db, s)).toBe(false);
    expect(await claimable(db, s, PAID)).toBe(true);
    db.close();
  });

  it("origin OUT of budget: the paid claimant is refused, though the RECEIVER has no cap at all", async () => {
    const db = fakeD1();
    const s = seedCase(db, { originCapMicros: 1000, originSpend: [600, 500] });
    expect(await originExhausted(db, s)).toBe(true);
    expect(await claimable(db, s, PAID)).toBe(false);
    db.close();
  });

  it("a FREE claimant still takes it — exhaustion narrows the claimant set, it never fails the work", async () => {
    // The term sits INSIDE the `isFree` short-circuit with the other money
    // terms, and this is the assertion that keeps it there. A homelab run costs
    // the handing binding nothing, so its cap is not a reason to strand the row.
    const db = fakeD1();
    const s = seedCase(db, { originCapMicros: 1000, originSpend: [2000] });
    expect(await claimable(db, s, FREE)).toBe(true);
    db.close();
  });

  it("HELD, not cancelled: the refused row is untouched and claims again once the month is funded", async () => {
    const db = fakeD1();
    const s = seedCase(db, { originCapMicros: 1000, originSpend: [2000] });
    expect(await claimable(db, s, PAID)).toBe(false);
    const [before] = db.query<{ status: string; claimed_at: number | null; done_at: number | null }>(
      `SELECT status, claimed_at, done_at FROM agent_invocations WHERE id = ?`,
      s.invId,
    );
    expect(before).toEqual({ status: "pending", claimed_at: null, done_at: null });

    // An approved T9 overrun on the SENDER releases handed-off work exactly as
    // it releases the sender's own — one arithmetic, one answer.
    db.seed("agent_budget_overages", [
      {
        account_id: s.accountId,
        binding_id: s.origin,
        period_key: PERIOD,
        amount_micros: 5000,
        approved_at: NOW,
        proposal_id: "p_late",
      },
    ]);
    expect(await claimable(db, s, PAID)).toBe(true);
    db.close();
  });

  it("an approved overage on the origin raises its effective ceiling", async () => {
    const db = fakeD1();
    const s = seedCase(db, { originCapMicros: 1000, originSpend: [1500], originOverageMicros: 1000 });
    expect(await originExhausted(db, s)).toBe(false);
    db.close();
  });

  it("last month's spend does not count — the bucket is the current UTC month", async () => {
    const db = fakeD1();
    const s = seedCase(db, { originCapMicros: 1000, originSpend: [100], originLastMonthSpend: 9999 });
    expect(await originExhausted(db, s)).toBe(false);
    db.close();
  });

  it("NULL costs sum as NOTHING — unknown is not a spend, and 0 is a known free run", async () => {
    const db = fakeD1();
    // Three finished runs on the origin: two undetermined, one genuinely free.
    // Neither reading may be collapsed into the other: NULL means "not
    // recorded" and 0 means "known and free", and summing NULLs as anything
    // but nothing would strand a binding on costs nobody ever measured.
    const unknown = seedCase(db, { originCapMicros: 100, originSpend: [null, null, 0] });
    expect(await originExhausted(db, unknown)).toBe(false);
    // …and a real spend of exactly the cap DOES exhaust it (>=, not >).
    const spent = seedCase(db, { originCapMicros: 100, originSpend: [null, 100] });
    expect(await originExhausted(db, spent)).toBe(true);
    db.close();
  });

  it("only FINISHED runs count — a claim in flight on the origin has not spent anything yet", async () => {
    const db = fakeD1();
    const s = seedCase(db, { originCapMicros: 1000 });
    db.seed("agent_invocations", [
      {
        id: `inv_running_${n}`,
        account_id: s.accountId,
        binding_id: s.origin,
        binding_name: "cj",
        status: "running",
        created_at: 1,
        claimed_at: NOW,
        cost_micros: 9999,
        context_json: "{}",
      },
    ]);
    expect(await originExhausted(db, s)).toBe(false);
    db.close();
  });
});

describe("the three absences, all of which read as NOT exhausted", () => {
  it("an ORDINARY invocation is untouched by the term existing (DefaultCase)", async () => {
    const db = fakeD1();
    const s = seedCase(db, { noHandoff: true, originCapMicros: 100, originSpend: [9999] });
    expect(await originExhausted(db, s)).toBe(false);
    expect(await claimable(db, s, PAID)).toBe(true);
    db.close();
  });

  it("JUNK context_json degrades to 'not a handoff' rather than throwing", async () => {
    // SQLite's `json_extract` THROWS on malformed JSON rather than returning
    // NULL, so the `json_valid` guard is what stops one corrupt row from taking
    // down every claim query on the account.
    const db = fakeD1();
    for (const junk of ["", "not json", "[1,2,3]", '{"handoff": "the-board"}']) {
      const s = seedCase(db, { contextJson: junk, originCapMicros: 100, originSpend: [9999] });
      expect(await originExhausted(db, s), junk).toBe(false);
      expect(await claimable(db, s, PAID), junk).toBe(true);
    }
    db.close();
  });

  it("a DANGLING origin binding reads as no cap — and the AUTHORITY side is what fails closed there", async () => {
    // Absence-is-not-evidence, the same rule `budgetExhaustedSql` follows. This
    // is not a hole: `chainBindingAuthority` DENIES a chain whose ancestor
    // binding no longer exists, so such a node fails its pre-flight long before
    // anybody asks what it may spend.
    const db = fakeD1();
    const s = seedCase(db, { danglingOrigin: true, originCapMicros: 100, originSpend: [9999] });
    expect(await originExhausted(db, s)).toBe(false);
    db.close();
  });

  it("an origin with NO configured cap never exhausts", async () => {
    const db = fakeD1();
    const s = seedCase(db, { originCapMicros: null, originSpend: [9_000_000] });
    expect(await originExhausted(db, s)).toBe(false);
    db.close();
  });

  it("a non-numeric spendPerMonth is no cap the gate can read", async () => {
    const db = fakeD1();
    const s = seedCase(db, { originSpend: [9999] });
    db.query(
      `UPDATE agent_bindings SET config_json = ? WHERE id = ?`,
      JSON.stringify({ budgets: { spendPerMonth: "lots" } }),
      s.origin,
    );
    expect(await originExhausted(db, s)).toBe(false);
    db.close();
  });
});

describe("the pure twin and the SQL agree", () => {
  const CASES: Array<{ name: string; seed: Seed; capMicros: number | null; spent: number; overage: number }> = [
    { name: "no cap", seed: { originCapMicros: null, originSpend: [500] }, capMicros: null, spent: 500, overage: 0 },
    { name: "under", seed: { originCapMicros: 1000, originSpend: [400] }, capMicros: 1000, spent: 400, overage: 0 },
    {
      name: "exactly at",
      seed: { originCapMicros: 1000, originSpend: [1000] },
      capMicros: 1000,
      spent: 1000,
      overage: 0,
    },
    {
      name: "over",
      seed: { originCapMicros: 1000, originSpend: [900, 900] },
      capMicros: 1000,
      spent: 1800,
      overage: 0,
    },
    {
      name: "over, with an overage that covers it",
      seed: { originCapMicros: 1000, originSpend: [1500], originOverageMicros: 800 },
      capMicros: 1000,
      spent: 1500,
      overage: 800,
    },
    {
      name: "over, with an overage that does not",
      seed: { originCapMicros: 1000, originSpend: [3000], originOverageMicros: 800 },
      capMicros: 1000,
      spent: 3000,
      overage: 800,
    },
    { name: "zero cap", seed: { originCapMicros: 0, originSpend: [] }, capMicros: 0, spent: 0, overage: 0 },
  ];

  for (const c of CASES) {
    it(`${c.name}: SQL and \`budgetExhausted\` reach the same verdict, and so does \`mayClaim\``, async () => {
      const db = fakeD1();
      const s = seedCase(db, c.seed);
      const sql = await originExhausted(db, s);
      const pure = budgetExhausted({ capMicros: c.capMicros, spentMicros: c.spent, overageMicros: c.overage });
      expect(sql, "the term itself").toBe(pure);

      // …and the whole gate agrees with the whole pure predicate, with the new
      // field carried through `BudgetState`.
      const budget: BudgetState = {
        budgetExhausted: false,
        handoffOriginBudgetExhausted: pure,
        freeRuntimeLive: false,
        escalationWindowMs: 60 * 60_000,
      };
      const facets = { dueAt: null, privacy: null, requires: null };
      expect(await claimable(db, s, PAID), "paid").toBe(mayClaim(facets, PAID, budget, NOW));
      expect(await claimable(db, s, FREE), "free").toBe(mayClaim(facets, FREE, budget, NOW));
      db.close();
    });
  }

  it("an ABSENT `handoffOriginBudgetExhausted` is exactly today's verdict — the DefaultCase", () => {
    const budget: BudgetState = { budgetExhausted: false, freeRuntimeLive: false, escalationWindowMs: 60 * 60_000 };
    expect(mayClaim({ dueAt: null, privacy: null, requires: null }, PAID, budget, NOW)).toBe(true);
  });

  it("the term is a CONJUNCTION with the row's own budget, never a substitution", () => {
    // Both true, either true, or neither — the verdict is the AND, so a
    // receiver with headroom cannot rescue an exhausted sender and vice versa.
    const base = { freeRuntimeLive: false, escalationWindowMs: 60 * 60_000 };
    const facets = { dueAt: null, privacy: null, requires: null };
    expect(mayClaim(facets, PAID, { ...base, budgetExhausted: false, handoffOriginBudgetExhausted: false }, NOW)).toBe(
      true,
    );
    expect(mayClaim(facets, PAID, { ...base, budgetExhausted: true, handoffOriginBudgetExhausted: false }, NOW)).toBe(
      false,
    );
    expect(mayClaim(facets, PAID, { ...base, budgetExhausted: false, handoffOriginBudgetExhausted: true }, NOW)).toBe(
      false,
    );
    expect(mayClaim(facets, PAID, { ...base, budgetExhausted: true, handoffOriginBudgetExhausted: true }, NOW)).toBe(
      false,
    );
  });

  it("the fragment takes exactly the two placeholders `claimGateBinds` now supplies for it", () => {
    expect(handoffOriginBudgetExhaustedSql("inv").split("?")).toHaveLength(3);
    // Two more binds than before s17, added immediately after the monthly pair
    // so no existing caller re-ordered anything by hand.
    expect(claimGateBinds({ now: NOW, claimant: PAID, escalationWindowMs: 1, monthStartMs: MONTH_START })).toEqual([
      0,
      0,
      0,
      null,
      null,
      0,
      MONTH_START,
      PERIOD,
      MONTH_START,
      PERIOD,
      1,
      NOW,
      NOW - 15 * 60_000,
    ]);
  });
});
