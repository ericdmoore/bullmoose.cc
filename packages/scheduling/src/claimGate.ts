// The eligibility gate as SQL — the WHERE-clause fold (jobs-and-facets §5).
//
// "The server derives the WHERE from facets + the claimant's capabilities;
// the claimant may narrow it further, never widen it. Eligibility is enforced
// in the guarded UPDATE server-side." This module renders `mayClaim` (the
// pure function in mayClaim.ts) as a SQL fragment appended to every claim
// statement's WHERE, so the pending→running transition itself refuses an
// ineligible claim — a hostile claimant that self-filters generously still
// cannot claim outside its set, and the refusal is atomic with the claim.
//
// The fragment reads the ROW's facets (due_at, privacy, requires_json) and
// the world (binding budget, month spend, free-runtime liveness) inside the
// statement; the CLAIMANT's identity and the per-binding escalation window
// arrive as bound parameters computed server-side — nothing a claimant sends
// reaches the SQL as anything but a normalized bind.
//
// claimGateAgreement.test.ts runs this fragment and the pure `mayClaim` over
// one table of cases and requires identical verdicts — the two formulations
// are kept in PROVABLE agreement, not comment-level agreement.

import {
  FREE_RUNTIME_LIVE_MS,
  escalationWindowMs,
  type ClaimantIdentity,
} from "./mayClaim.js";

/**
 * The gate fragment, to be appended to a claim statement's WHERE (it begins
 * with ` AND`). `inv` is how the statement refers to the agent_invocations
 * row under test: the table name itself in an UPDATE, the FROM-alias in a
 * SELECT. Placeholders are positional — bind `claimGateBinds()` in order,
 * after the statement's own binds.
 *
 * Two structural notes:
 *   - fit mirrors `fit()` exactly, including the garbage tolerance:
 *     `json_type` = 'true' is JSON true (a string "true" is not), and a
 *     non-numeric contextTokens is no constraint — same as `typeof !==
 *     "number"` on the pure side.
 *   - liveness counts CLAIMS (claimed_at), not completions, and counts them
 *     regardless of the row's current status: a free claim that already
 *     finished still proves a free runtime was here.
 */
export function claimGateSql(inv: string): string {
  return (
    `\n AND (${inv}.requires_json IS NULL` +
    `\n      OR NOT json_valid(${inv}.requires_json)` +
    `\n      OR ? = 0` +
    `\n      OR ((COALESCE(json_type(${inv}.requires_json, '$.vision'), 'x') <> 'true' OR ? = 1)` +
    `\n          AND (COALESCE(json_type(${inv}.requires_json, '$.tools'), 'x') <> 'true' OR ? = 1)` +
    `\n          AND (COALESCE(json_type(${inv}.requires_json, '$.contextTokens'), 'x') NOT IN ('integer', 'real')` +
    `\n               OR ? IS NULL` +
    `\n               OR json_extract(${inv}.requires_json, '$.contextTokens') <= ?)))` +
    `\n AND (? = 1` +
    `\n      OR (COALESCE(${inv}.privacy, '') <> 'pinned'` +
    `\n          AND NOT EXISTS (` +
    `\n                SELECT 1 FROM agent_bindings gate_b` +
    `\n                WHERE gate_b.account_id = ${inv}.account_id AND gate_b.id = ${inv}.binding_id` +
    `\n                  AND json_valid(gate_b.config_json)` +
    `\n                  AND json_type(gate_b.config_json, '$.budgets.spendPerMonth') IN ('integer', 'real')` +
    `\n                  AND (SELECT COALESCE(SUM(gate_s.cost_micros), 0) FROM agent_invocations gate_s` +
    `\n                       WHERE gate_s.account_id = ${inv}.account_id` +
    `\n                         AND gate_s.binding_id = ${inv}.binding_id` +
    `\n                         AND gate_s.done_at IS NOT NULL AND gate_s.done_at >= ?)` +
    `\n                      >= json_extract(gate_b.config_json, '$.budgets.spendPerMonth'))` +
    `\n          AND (CASE WHEN ${inv}.due_at IS NOT NULL THEN ${inv}.due_at - ? <= ?` +
    `\n                ELSE NOT EXISTS (` +
    `\n                  SELECT 1 FROM agent_invocations gate_l` +
    `\n                  WHERE gate_l.account_id = ${inv}.account_id` +
    `\n                    AND gate_l.claimant_free = 1` +
    `\n                    AND gate_l.claimed_at IS NOT NULL` +
    `\n                    AND gate_l.claimed_at >= ?)` +
    `\n                END)))`
  );
}

export interface ClaimGateParams {
  /** Claim wall-clock, epoch ms. */
  now: number;
  /** Normalized claimant (normalizeClaimant) — never the raw wire value. */
  claimant: ClaimantIdentity;
  /** This binding's escalation window (bindingEscalationWindowMs). Only read
   * when the row has a due_at and the claimant is paid; bind the no-history
   * default when the caller knows it will not be consulted. */
  escalationWindowMs: number;
  /** budgetMonthStartMs(now) — start of the current UTC month. */
  monthStartMs: number;
}

/** The binds for `claimGateSql`, in placeholder order. */
export function claimGateBinds(p: ClaimGateParams): Array<number | null> {
  const caps = p.claimant.capabilities;
  const ctx = typeof caps?.contextTokens === "number" ? caps.contextTokens : null;
  return [
    caps ? 1 : 0, // a vector was declared at all (undeclared = claimable, T2-FIT-CONTRACT)
    caps?.vision === true ? 1 : 0,
    caps?.tools === true ? 1 : 0,
    ctx,
    ctx,
    p.claimant.isFree ? 1 : 0,
    p.monthStartMs,
    p.escalationWindowMs,
    p.now,
    p.now - FREE_RUNTIME_LIVE_MS,
  ];
}

/**
 * Month bucket for `budgets.spendPerMonth`: the current UTC calendar month,
 * anchored on `done_at` (when the cost was frozen by finish()). UTC on
 * purpose — the budget is a config number, not a human's local billing cycle,
 * and a claim gate must not depend on the worker's locale.
 */
export function budgetMonthStartMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * The escalation window for one binding: median done_at−claimed_at over its
 * most recent completed (`done`) invocations, folded by escalationWindowMs().
 * Failed runs are excluded — refusals and crashes finish in milliseconds and
 * would drag the median toward "escalate late", the unsafe direction. 101
 * most recent keeps the median recency-weighted and the scan bounded.
 */
export async function bindingEscalationWindowMs(
  db: D1Database,
  accountId: string,
  bindingId: string,
): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT done_at - claimed_at AS d FROM agent_invocations
       WHERE account_id = ? AND binding_id = ? AND status = 'done'
         AND claimed_at IS NOT NULL AND done_at IS NOT NULL AND done_at >= claimed_at
       ORDER BY done_at DESC LIMIT 101`,
    )
    .bind(accountId, bindingId)
    .all<{ d: number }>();
  return escalationWindowMs(results.map((r) => r.d));
}
