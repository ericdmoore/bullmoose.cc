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

import { FREE_RUNTIME_LIVE_MS, escalationWindowMs, type ClaimantIdentity } from "./mayClaim.js";
import { jobBudgetExhaustedSql, needsSatisfiedSql } from "./jobGraph.js";

// ── The fragments, and why they are exported one by one ────────────────────
// The gate is a CONJUNCTION, and s11 T3's watchdog needs a strict SUBSET of
// its terms: the overdue backstop claims OUTSIDE the policy gate (a gated
// claim would refuse budget-exhausted overdue work — which is the whole point
// of a backstop) while KEEPING the privacy pin, fit, and the 008 kill switch
// (devPlan decision 0: pinned work sits and the human is alerted; and a
// deadline is not a reason to run an agent an operator switched off). So each
// term is its own exported expression and `claimGateSql` is their fold, rather
// than the backstop re-typing a hand-copied `privacy <> 'pinned'` that could
// drift from this one the day the pin gains a second class.
//
// Every fragment below returns a BARE boolean expression (parenthesized, no
// leading ` AND`) so it can be conjoined, negated, or dropped. Placeholders
// are positional in the order the fragments appear in the statement.

/**
 * FIT — the capability half of the gate, 5 placeholders (`claimFitBinds`).
 * Mirrors `fit()` exactly, including the garbage tolerance: `json_type` =
 * 'true' is JSON true (a string "true" is not), and a non-numeric
 * contextTokens is no constraint — same as `typeof !== "number"` on the pure
 * side. Never NULL, so `NOT claimFitSql(...)` is a total complement (T3's
 * alert pass reads it that way).
 */
export function claimFitSql(inv: string): string {
  return (
    `(${inv}.requires_json IS NULL` +
    `\n      OR NOT json_valid(${inv}.requires_json)` +
    `\n      OR ? = 0` +
    `\n      OR ((COALESCE(json_type(${inv}.requires_json, '$.vision'), 'x') <> 'true' OR ? = 1)` +
    `\n          AND (COALESCE(json_type(${inv}.requires_json, '$.tools'), 'x') <> 'true' OR ? = 1)` +
    `\n          AND (COALESCE(json_type(${inv}.requires_json, '$.contextTokens'), 'x') NOT IN ('integer', 'real')` +
    `\n               OR ? IS NULL` +
    `\n               OR json_extract(${inv}.requires_json, '$.contextTokens') <= ?)))`
  );
}

/** The 5 binds `claimFitSql` takes, in placeholder order. */
export function claimFitBinds(claimant: ClaimantIdentity): Array<number | null> {
  const caps = claimant.capabilities;
  const ctx = typeof caps?.contextTokens === "number" ? caps.contextTokens : null;
  return [
    caps ? 1 : 0, // a vector was declared at all (undeclared = claimable, T2-FIT-CONTRACT)
    caps?.vision === true ? 1 : 0,
    caps?.tools === true ? 1 : 0,
    ctx,
    ctx,
  ];
}

/**
 * THE PRIVACY PIN, alone — 0 placeholders. True when the row may go to a paid
 * cloud runtime at all. This is the ONE policy term the s11 T3 backstop keeps
 * when it claims past `due_at`: privacy beats liveness (devPlan decision 0),
 * so pinned work sits however overdue and the human is alerted instead.
 */
export function notPinnedSql(inv: string): string {
  return `(COALESCE(${inv}.privacy, '') <> 'pinned')`;
}

/**
 * The binding's monthly spend cap, reached — 2 placeholders, in order:
 * `monthStartMs` (the spend bucket) and `periodKey` (the overage bucket).
 * Exhaustion NARROWS the claimant set (free only); it never fails the
 * invocation, and the T3 backstop deliberately drops this term.
 *
 * s11 T9 — THE EFFECTIVE CEILING IS `cap + approved overage`. An approved
 * `budget-overrun` proposal writes a bounded, period-scoped amount into
 * `agent_budget_overages`; this is where the gate honors it, so an approval is
 * a real widening of the claimant set rather than a row nobody reads. The twin
 * of `budgetExhausted()` in mayClaim.ts, and claimGateAgreement.test.ts holds
 * the two to the same verdict WITH the overage term included.
 *
 * Both buckets are the same UTC calendar month, and that is what makes the
 * grant expire by ARITHMETIC: at the month roll the spend sum resets and the
 * `period_key` stops matching in the same instant. No sweep, no cleanup, no
 * overage that outlives the question it answered.
 *
 * `COALESCE(SUM(...), 0)` over an empty overage table is 0, so a binding that
 * was never granted anything compares exactly as it did before T9.
 */
export function budgetExhaustedSql(inv: string): string {
  return (
    `EXISTS (` +
    `\n                SELECT 1 FROM agent_bindings gate_b` +
    `\n                WHERE gate_b.account_id = ${inv}.account_id AND gate_b.id = ${inv}.binding_id` +
    `\n                  AND json_valid(gate_b.config_json)` +
    `\n                  AND json_type(gate_b.config_json, '$.budgets.spendPerMonth') IN ('integer', 'real')` +
    `\n                  AND (SELECT COALESCE(SUM(gate_s.cost_micros), 0) FROM agent_invocations gate_s` +
    `\n                       WHERE gate_s.account_id = ${inv}.account_id` +
    `\n                         AND gate_s.binding_id = ${inv}.binding_id` +
    `\n                         AND gate_s.done_at IS NOT NULL AND gate_s.done_at >= ?)` +
    `\n                      >= json_extract(gate_b.config_json, '$.budgets.spendPerMonth')` +
    `\n                         + (SELECT COALESCE(SUM(gate_o.amount_micros), 0)` +
    `\n                            FROM agent_budget_overages gate_o` +
    `\n                            WHERE gate_o.account_id = ${inv}.account_id` +
    `\n                              AND gate_o.binding_id = ${inv}.binding_id` +
    `\n                              AND gate_o.period_key = ?))`
  );
}

/**
 * THE 008 KILL SWITCH — 0 placeholders. True when this row's binding is
 * switched OFF, i.e. when the claim must be refused. Folded as
 * `NOT bindingDisabledSql(...)` in `claimGateSql`.
 *
 * ── Why the gate needed it ────────────────────────────────────────────────
 * `AgentBinding/set` (s26 T2) made the switch session-reachable, and the
 * Settings→Agents page promises exactly this: "Disabling holds queued work;
 * nothing is cancelled." The refusal existed at CREATE (agent.ts's interlock)
 * and in the cloud drain's SELECT join — but neither touches the rows a human
 * queued BEFORE flipping the switch, which is the entire point of the
 * sentence. Those stayed claimable through `AgentInvocation/set` by any
 * claimant, and by a FREE one in particular: the fleet host and the
 * `bullmoose agent` CLI both declare `isFree: true`. The switch stopped new
 * work and let the backlog keep running.
 *
 * ── Why it sits OUTSIDE the `isFree` short-circuit ────────────────────────
 * Every money term (`budgetExhaustedSql`, `jobBudgetExhaustedSql`, the
 * envelope) lives INSIDE it, because exhaustion is a reason to prefer the
 * runtime that costs nothing — a free claimant is the answer to a budget, not
 * a party to it. An off switch is not a budget. "Your homelab may still run
 * it for free" is not what a human clicking Disable is agreeing to, so this
 * term binds every claimant, exactly like `needsSatisfiedSql`.
 *
 * ── It is a WAIT, not an error and not a fault ────────────────────────────
 * Structurally identical to `budgetExhaustedSql`: it NARROWS the claimant set
 * inside the guarded UPDATE, so a refused row simply does not transition. It
 * stays `pending`, keeps its facets and its clocks, costs nothing, and
 * becomes claimable again the instant the binding is re-enabled — no
 * requeue, no new row, nothing cancelled. Completion (`done`/`failed`) is
 * never gated by anything, here included: a runtime that legitimately claimed
 * before the flip still owns its invocation and must be able to record what
 * happened.
 *
 * ── The two absences, which are NOT the same absence ──────────────────────
 * `EXISTS` false — no binding row at all — reads as NOT disabled, i.e. the
 * row claims exactly as it did before this term. That is the same
 * absence-is-not-evidence rule `budgetExhaustedSql` follows, and it is
 * deliberate: the promise being kept here is about DISABLED bindings, while
 * an invocation whose binding was destroyed is a different question already
 * answered elsewhere (both drain SELECTs INNER JOIN `agent_bindings`, and
 * auth-core refuses to resolve such a row's invocation token). Stranding it
 * silently here would be a second, unasked-for behaviour change.
 *
 * The COALESCE runs the OTHER way, and that asymmetry is the honest part.
 * `agent_bindings.enabled` is `NOT NULL DEFAULT 1`, so the COALESCE cannot
 * fire today; it is there so that if the column ever becomes nullable, an
 * UNREADABLE switch reads as OFF. An unreadable budget cap honestly means "no
 * cap was set"; an unreadable kill switch does not mean "the human left it
 * on". Same reason `<> 1` and not `= 0`: only the literal enabled value
 * counts as enabled.
 */
export function bindingDisabledSql(inv: string): string {
  return (
    `EXISTS (` +
    `\n                SELECT 1 FROM agent_bindings gate_k` +
    `\n                WHERE gate_k.account_id = ${inv}.account_id AND gate_k.id = ${inv}.binding_id` +
    `\n                  AND COALESCE(gate_k.enabled, 0) <> 1)`
  );
}

/**
 * Pure twin of `bindingDisabledSql` — the same predicate stated as a function
 * so the two cannot drift (the `needsSatisfied` / `jobBudgetExhausted`
 * discipline; killSwitch.test.ts holds them to one table).
 *
 * `null`/`undefined` = the EXISTS found no binding row → NOT disabled.
 * A present row's `enabled` is disabled unless it is exactly 1, with an
 * unreadable value reading as OFF — see the SQL for why the two absences
 * point in opposite directions.
 */
export function bindingDisabled(binding: { enabled: number | null } | null | undefined): boolean {
  if (binding === null || binding === undefined) return false;
  return (binding.enabled ?? 0) !== 1;
}

/**
 * THE BACKFILL ENVELOPE EXISTS — 0 placeholders (s26 T3 v2). True when this
 * row is backfill-tagged (`context_json.backfill === true`, the flag both the
 * manual verb and the surplus pass stamp) AND carries its own money
 * (`backfillBudgetMicros`, which only the manual verb writes, and only when
 * the caller named one). Same garbage tolerance as `claimFitSql`: junk
 * context, a string "true", or a string budget all read as NO envelope —
 * degrading a row to the monthly gate (today's behavior), never widening its
 * money.
 *
 * Exported alone because two callers need the predicate WITHOUT the
 * exhaustion sum: `claimGateSql`'s CASE picks which purse a row draws from,
 * and `budgetOverrun.ts` excludes envelope rows from its stranded
 * counterfactual — a monthly overage cannot release a row that does not read
 * the monthly budget, and asking a human to approve money that would release
 * nothing is worse than not asking (the jobBudget precedent, jobGraph.ts).
 */
export function backfillEnvelopeSql(inv: string): string {
  return (
    `(${inv}.context_json IS NOT NULL` +
    `\n      AND json_valid(${inv}.context_json)` +
    `\n      AND COALESCE(json_type(${inv}.context_json, '$.backfill'), 'x') = 'true'` +
    `\n      AND COALESCE(json_type(${inv}.context_json, '$.backfillBudgetMicros'), 'x') IN ('integer', 'real'))`
  );
}

/**
 * THE BACKFILL ENVELOPE, spent through — 0 placeholders. Only meaningful
 * under `backfillEnvelopeSql` (the CASE guard guarantees the row's
 * context_json is valid before `json_extract` runs). The twin of
 * `backfillEnvelopeExhausted()` in mayClaim.ts, in `budgetExhaustedSql`'s
 * exact arithmetic style:
 *
 *   SUM(cost_micros) over this binding's FINISHED backfill-tagged rows
 *     ≥ this row's `backfillBudgetMicros`
 *
 * ALL-TIME, deliberately — an envelope is per-request money, not a monthly
 * allowance, so there is no month bucket and no period key (and therefore no
 * placeholders: every existing caller's bind order is untouched). NULL costs
 * sum as nothing — unknown is not a spend — same as the monthly gate; and a
 * T9 monthly overage does not raise an envelope, because the human who
 * approved "spend more this month" was not asked about the archive.
 *
 * ── How it composes with the monthly cap ──────────────────────────────────
 * As a SUBSTITUTION, not a conjunction (contrast jobBudgetExhaustedSql): an
 * envelope row never reads the monthly cap at claim time. Its spend still
 * LANDS in `cost_micros` like any other run, so the monthly sum sees it and
 * live work stops earlier that month — total spend stays bounded by
 * cap + envelope, the conservative direction. Splitting the monthly sum's
 * population was considered and refused: the dossier (console.ts) and the
 * surplus projection mirror that sum verbatim, and a gate that counted
 * differently from every surface reading it would be the drift this package
 * exists to prevent.
 */
export function backfillEnvelopeExhaustedSql(inv: string): string {
  return (
    `((SELECT COALESCE(SUM(gate_bf.cost_micros), 0) FROM agent_invocations gate_bf` +
    `\n        WHERE gate_bf.account_id = ${inv}.account_id` +
    `\n          AND gate_bf.binding_id = ${inv}.binding_id` +
    `\n          AND gate_bf.done_at IS NOT NULL` +
    `\n          AND gate_bf.context_json IS NOT NULL` +
    `\n          AND json_valid(gate_bf.context_json)` +
    `\n          AND COALESCE(json_type(gate_bf.context_json, '$.backfill'), 'x') = 'true')` +
    `\n     >= json_extract(${inv}.context_json, '$.backfillBudgetMicros'))`
  );
}

/**
 * THE ABSENCE-INFERENCE (readme decision 3) — 1 placeholder, the cutoff
 * `freeRuntimeLiveCutoff(now)`. A free claimant claimed on this row's account
 * within FREE_RUNTIME_LIVE_MS, i.e. "a homelab runtime is here right now".
 * Counts CLAIMS (claimed_at), not completions, and counts them regardless of
 * the row's current status: a free claim that already finished still proves a
 * free runtime was here. Negated, it is the "your homelab is down" signal the
 * T3 sweep reports on.
 */
export function freeRuntimeLiveSql(inv: string): string {
  return (
    `EXISTS (` +
    `\n                  SELECT 1 FROM agent_invocations gate_l` +
    `\n                  WHERE gate_l.account_id = ${inv}.account_id` +
    `\n                    AND gate_l.claimant_free = 1` +
    `\n                    AND gate_l.claimed_at IS NOT NULL` +
    `\n                    AND gate_l.claimed_at >= ?)`
  );
}

/** The single bind `freeRuntimeLiveSql` takes. */
export function freeRuntimeLiveCutoff(now: number): number {
  return now - FREE_RUNTIME_LIVE_MS;
}

/**
 * THE TIMING TERM — 3 placeholders, in order: `escalationWindowMs`, `now`,
 * `freeRuntimeLiveCutoff(now)`. "Is a PAID claimant allowed to take this yet,
 * on the clock?" — due within the escalation window, or no deadline at all and
 * no free runtime live to sit for (`policy` cases 3 and 4).
 *
 * Its own exported fragment because s11 T9 needs the gate MINUS the budget
 * term: "would this row be claimable if the budget were not spent?" is the
 * exact counterfactual that makes a binding budget-STRANDED rather than merely
 * waiting, and composing it from the same expression `claimGateSql` folds is
 * what stops the sweep's idea of stranded from drifting from the gate's idea of
 * eligible. Same discipline that gave T3 `notPinnedSql`/`claimFitSql`.
 */
export function dueWindowSql(inv: string): string {
  return (
    `(CASE WHEN ${inv}.due_at IS NOT NULL THEN ${inv}.due_at - ? <= ?` +
    `\n       ELSE NOT ${freeRuntimeLiveSql(inv)}` +
    `\n       END)`
  );
}

/** The 3 binds `dueWindowSql` takes, in placeholder order. */
export function dueWindowBinds(p: { now: number; escalationWindowMs: number }): number[] {
  return [p.escalationWindowMs, p.now, freeRuntimeLiveCutoff(p.now)];
}

/**
 * The whole gate, to be appended to a claim statement's WHERE (it begins with
 * ` AND`) — switched-on ∧ fit ∧ needs ∧ (free ∨ (pin ∧ budget ∧ jobBudget ∧
 * due)), the fold of the fragments above. `inv` is how the statement refers
 * to the agent_invocations row under test: the table name itself in an
 * UPDATE, the FROM-alias in a SELECT. Placeholders are positional — bind
 * `claimGateBinds()` in order, after the statement's own binds.
 *
 * s11 T7 adds the two DAG terms, and WHERE each sits is the whole design:
 *
 *   needsSatisfiedSql   OUTSIDE the `isFree` short-circuit. Execution ordering
 *                       is structural, not policy — a free runtime may no more
 *                       run a join node before its inputs exist than a paid one
 *                       can. This is the "no new queues" clause: the pending
 *                       TASK queue is `status='pending' AND needs satisfied`,
 *                       computed here, never stored.
 *   jobBudgetExhausted  INSIDE it, beside the binding's monthly cap, because a
 *                       money cap narrows the claimant set rather than failing
 *                       the work — and a free claimant costs the Job nothing.
 *
 * Both take zero placeholders (the graph is entirely in the rows), so every
 * existing caller's bind order is untouched.
 *
 * s26 T3 v2 replaces the bare monthly term with a CASE: an envelope-carrying
 * backfill row (`backfillEnvelopeSql`) draws from its own envelope INSTEAD OF
 * the monthly cap — see `backfillEnvelopeExhaustedSql` for why substitution,
 * not conjunction. Both new fragments take zero placeholders, and the monthly
 * term keeps its two inside the ELSE (placeholders are positional whatever
 * branch runs), so `claimGateBinds` and every caller are again untouched.
 * The pure statement of the same CASE is `effectiveBudgetExhausted`
 * (mayClaim.ts); the agreement test's envelope table holds the two together.
 *
 * s26 T2 follow-up adds `bindingDisabledSql` — the 008 kill switch — as the
 * FIRST term and OUTSIDE the `isFree` short-circuit, so a disabled binding's
 * already-queued rows are claimable by nobody rather than by everyone free.
 * Zero placeholders again; every caller's bind order is untouched.
 */
export function claimGateSql(inv: string): string {
  return (
    `\n AND NOT ${bindingDisabledSql(inv)}` +
    `\n AND ${claimFitSql(inv)}` +
    `\n AND ${needsSatisfiedSql(inv)}` +
    `\n AND (? = 1` +
    `\n      OR (${notPinnedSql(inv)}` +
    `\n          AND (CASE WHEN ${backfillEnvelopeSql(inv)}` +
    `\n               THEN NOT ${backfillEnvelopeExhaustedSql(inv)}` +
    `\n               ELSE NOT ${budgetExhaustedSql(inv)} END)` +
    `\n          AND NOT ${jobBudgetExhaustedSql(inv)}` +
    `\n          AND ${dueWindowSql(inv)}))`
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
export function claimGateBinds(p: ClaimGateParams): Array<number | string | null> {
  return [
    ...claimFitBinds(p.claimant),
    p.claimant.isFree ? 1 : 0,
    p.monthStartMs,
    // The overage bucket. Derived from monthStartMs, NOT from `now`, so the two
    // halves of the budget comparison can never key different months — a
    // sweep that straddles midnight UTC on the 1st still compares one period
    // against itself.
    budgetPeriodKey(p.monthStartMs),
    ...dueWindowBinds(p),
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
 * The budget PERIOD's name — 'YYYY-MM', UTC (s11 T9). The same bucket
 * `budgetMonthStartMs` opens, spelled as a key so it can be stored on a row
 * (`agent_budget_overages.period_key`) and compared with `=` instead of a
 * range. One period = one month = one ask; the T9 proposal's idempotence and
 * its expiry are both keyed to it.
 */
export function budgetPeriodKey(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The instant the current budget period ENDS (= the next month's start, UTC).
 *
 * s11 T9 sets a `budget-overrun` proposal's `expiresAt` here, because an
 * unanswered overage question is MOOT next month: the spend sum resets, the
 * binding is under its cap again, and the work the question was about is
 * claimable without anyone deciding anything. A proposal that outlived its
 * period would ask a human to authorize spending against a budget that no
 * longer needs it.
 */
export function budgetPeriodEndMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * What one invocation of this binding typically COSTS — the median of its past
 * `cost_micros` (the s07 T5 history), micro-USD. The number a `budget-overrun`
 * proposal multiplies by the waiting count to answer "what would it cost to
 * clear the queue?", and the reason that answer is a FACT rather than a guess.
 *
 * `cost_micros > 0` is the population, deliberately: 0 means "known and
 * genuinely free" (a Workers-AI allocation run, or a homelab claimant), and a
 * free run predicts nothing about what the PAID cloud will charge to drain this
 * queue — averaging zeros in would under-quote the human by construction. NULL
 * (undetermined) is excluded for the same reason it renders "not recorded"
 * everywhere else: it is not a zero.
 *
 * No qualifying history → `null`, and every caller must carry that null through
 * as "unknown" rather than substituting a number. 101 most recent keeps the
 * median recency-weighted and the scan bounded (same shape as
 * `bindingEscalationWindowMs`).
 */
export async function bindingMedianCostMicros(
  db: D1Database,
  accountId: string,
  bindingId: string,
): Promise<number | null> {
  const { results } = await db
    .prepare(
      `SELECT cost_micros AS c FROM agent_invocations
       WHERE account_id = ? AND binding_id = ? AND status = 'done'
         AND cost_micros IS NOT NULL AND cost_micros > 0
       ORDER BY done_at DESC LIMIT 101`,
    )
    .bind(accountId, bindingId)
    .all<{ c: number }>();
  return medianMicros(results.map((r) => r.c));
}

/** The fold behind `bindingMedianCostMicros`. Pure; empty → null (unknown). */
export function medianMicros(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The escalation window for one binding: median done_at−claimed_at over its
 * most recent completed (`done`) invocations, folded by escalationWindowMs().
 * Failed runs are excluded — refusals and crashes finish in milliseconds and
 * would drag the median toward "escalate late", the unsafe direction. 101
 * most recent keeps the median recency-weighted and the scan bounded.
 */
export async function bindingEscalationWindowMs(db: D1Database, accountId: string, bindingId: string): Promise<number> {
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
