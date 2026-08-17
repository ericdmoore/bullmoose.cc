import { commitChanges } from "@bullmoose/account-do";
import {
  ESCALATION_WINDOW_MAX_MS,
  bindingEscalationWindowMs,
  bindingMedianCostMicros,
  budgetExhaustedSql,
  budgetMonthStartMs,
  budgetPeriodEndMs,
  budgetPeriodKey,
  claimFitBinds,
  claimFitSql,
  dueWindowBinds,
  dueWindowSql,
  jobBudgetExhaustedSql,
  needsSatisfiedSql,
  notPinnedSql,
  type ClaimantIdentity,
} from "@bullmoose/scheduling";
import { emitProposal } from "./proposals.js";
import type { Env } from "./models.js";

/**
 * s11 T9 — budget overrun is a DECISION, not a dead end.
 *
 * THE HOLE (found by T3): an invocation whose binding is out of monthly budget
 * sits while no free runtime is live. The policy gate says "budget exhausted →
 * free claimants only" (exhaustion narrows the claimant set rather than failing
 * the work) and the overdue backstop cannot help a row with no deadline — no
 * `due_at`, so it never fires. The work waits for the month to roll.
 *
 * THE RESOLUTION, and the line worth stating once:
 *
 *   **Marker when nothing can be decided; proposal when something can.**
 *
 * T3 chose a durable marker for pinned-overdue *because privacy admits no human
 * override* — there is no question to ask, so a proposal row would duplicate a
 * fact the invocation already holds. Budget is the opposite: *"spend anyway?"*
 * is a real question with a real answer, so it earns the queue. The two
 * mechanisms are not rivals; the distinction is whether a human choice exists.
 *
 * Here they COMPOSE rather than duplicate: the marker (`alert_kind`, reused from
 * T3) is the machine fact and the idempotence key; the proposal is the human
 * question. Mark once → ask once.
 *
 * ── Design decisions, and why ──────────────────────────────────────────────
 *
 * BATCH PER BINDING, NEVER PER INVOCATION. One proposal — "photos@ is out of
 * budget; 12 invocations waiting; approve overage?" — never twelve. A
 * per-invocation proposal would be an alert storm wearing a decision's clothes,
 * and the queue's whole value is that it is short.
 *
 * "BECAUSE OF BUDGET" IS A COUNTERFACTUAL, not a vibe. A row counts as stranded
 * only if a paid claimant WOULD take it were the budget not spent: fit ∧
 * notPinned ∧ dueWindow (the timing term — due inside the escalation window, or
 * no deadline and no free runtime live to sit for). Those are the very
 * fragments `claimGateSql` folds (@bullmoose/scheduling), used piecewise here
 * exactly as T3 uses `notPinnedSql`/`claimFitSql` — so this sweep's idea of
 * "stranded" cannot drift from the gate's idea of "eligible". A far-from-due
 * row is sitting because it is early, not because of money; a pinned row is
 * T3's problem; and a NULL-due row with a live homelab is sitting on purpose.
 * `claimGateAgreement.test.ts` proves the decomposition.
 *
 * s11 T7 adds the two DAG terms to that counterfactual, and both are about not
 * asking a human for money that would buy nothing. A Job node whose `needs` are
 * unfinished is waiting on its SIBLING, not on the budget — approving an
 * overage would not release it. A node whose JOB has spent its aggregate budget
 * is held by a different ceiling than the binding's month, and the same
 * approval would not release that either. Both are excluded, so every
 * invocation this sweep counts is one an approval genuinely frees.
 *
 * THE ESTIMATE IS HISTORY, NOT A GUESS. Cost-to-clear = median past
 * `cost_micros` of this binding (s07 T5) × the waiting count. No paid history →
 * `null`, carried through to the payload, the rationale and the surfaces as
 * "unknown". Reporting an unknown honestly is the whole reason `needsInfo`
 * ("what would it cost?") can be answered from the record instead of invented.
 */

/** How many stranded bindings one sweep may ASK about. Bounds a pathological
 * fan-out; the same reason T3 caps its alert pass. */
const OVERRUN_BINDING_LIMIT = 25;

/**
 * The headroom on the requested bound, over the estimate. A MEDIAN under-shoots
 * half the time by construction, so a bound set to the bare estimate would
 * strand the tail of the queue again — silently, because the marker has already
 * been raised for this period. 25% buys the tail without turning a bounded ask
 * into a blank cheque; the number is in the rationale, and the human can edit it
 * (`editedPayload`) before approving.
 */
const OVERAGE_HEADROOM = 1.25;

/**
 * The requested bound when there is NO paid history to estimate from, and the
 * cap cannot stand in for one: $1.00.
 *
 * The usual fallback is one month's cap — a number the operator already sized
 * and authorized once. That fails for the one binding shape where "no history"
 * is genuinely reachable: `spendPerMonth: 0`, i.e. "never spend paid", which is
 * exhausted from its first moment with nothing ever spent and therefore nothing
 * to learn from. A zero bound would be a grant of nothing, so the ask needs a
 * number, and when you do not know, ask for LITTLE. Nominal, said out loud in
 * the rationale, and editable before approval — which is the honest shape for a
 * figure nobody derived.
 */
const NOMINAL_UNKNOWN_BOUND_MICROS = 1_000_000;

/** The marker's kind, period-scoped: `budget-stranded:2026-08`. */
export const BUDGET_MARKER_PREFIX = "budget-stranded";
export function budgetMarkerKind(periodKey: string): string {
  return `${BUDGET_MARKER_PREFIX}:${periodKey}`;
}

/** The proposal kind. Tier 1 — see `proposeOne` for why it cannot be 2 or 3. */
export const BUDGET_OVERRUN_KIND = "budget-overrun";

interface Candidate {
  account_id: string;
  binding_id: string;
  binding_name: string;
}

/**
 * The sweep. Runs on the agent worker's cron beside T3's, and is SILENT unless
 * a binding is genuinely stranded — no budget configured, nothing waiting, or
 * budget not exhausted all produce nothing at all (DefaultCase).
 *
 * @param claimant the runtime the counterfactual is asked ABOUT. Defaults to
 *   the paid cloud (this worker's identity): "stranded" means the PAID claimant
 *   is the one being held off, which is the only claimant a budget can hold off
 *   — `policy` never restricts a free one.
 * @returns how many proposals this sweep raised.
 */
export async function proposeBudgetOverruns(
  env: Env,
  claimant: ClaimantIdentity = { isFree: false, capabilities: null },
): Promise<{ asked: number }> {
  const now = Date.now();
  const periodKey = budgetPeriodKey(now);
  const markerKind = budgetMarkerKind(periodKey);

  // ---- pass 1: candidate bindings ----------------------------------------
  // The escalation window is per-binding (a median over history, computed in
  // JS), so this pass uses the WIDEST possible window (4h) and pass 2 applies
  // the exact one — the same superset discipline the drain's SELECT uses, and
  // for the same reason: one statement cannot carry N windows. A superset here
  // costs at most a binding that pass 2 then finds has nothing waiting.
  const { results: candidates } = await env.DB.prepare(
    `SELECT DISTINCT inv.account_id, inv.binding_id, inv.binding_name
       FROM agent_invocations inv
       JOIN agent_bindings b ON b.account_id = inv.account_id AND b.id = inv.binding_id
       JOIN accounts a ON a.id = inv.account_id
      WHERE inv.status = 'pending' AND b.enabled = 1 AND a.deleted_at IS NULL
        AND ${budgetExhaustedSql("inv")}
        AND ${notPinnedSql("inv")}
        AND ${claimFitSql("inv")}
        AND ${dueWindowSql("inv")}
        AND ${needsSatisfiedSql("inv")}
        AND NOT ${jobBudgetExhaustedSql("inv")}
        -- ALREADY ASKED THIS PERIOD? The marker is the key, and it is read
        -- WITHOUT a status filter on purpose: once the overage is approved the
        -- marked row gets claimed and completes, and a re-ask must still not
        -- happen. The marker outlives the wait it recorded.
        AND NOT EXISTS (
              SELECT 1 FROM agent_invocations mk
               WHERE mk.account_id = inv.account_id
                 AND mk.binding_id = inv.binding_id
                 AND mk.alert_kind = ?)
      ORDER BY inv.binding_name LIMIT ${OVERRUN_BINDING_LIMIT}`,
  )
    .bind(
      budgetMonthStartMs(now),
      periodKey,
      ...claimFitBinds(claimant),
      ...dueWindowBinds({ now, escalationWindowMs: ESCALATION_WINDOW_MAX_MS }),
      markerKind,
    )
    .all<Candidate>();

  let asked = 0;
  for (const c of candidates) {
    if (await proposeOne(env, c, claimant, now, periodKey, markerKind)) asked += 1;
  }
  return { asked };
}

/** One binding's ask, or nothing. Returns whether a proposal was raised. */
async function proposeOne(
  env: Env,
  c: Candidate,
  claimant: ClaimantIdentity,
  now: number,
  periodKey: string,
  markerKind: string,
): Promise<boolean> {
  // ---- pass 2: the exact window, and the numbers -------------------------
  const windowMs = await bindingEscalationWindowMs(env.DB, c.account_id, c.binding_id);
  const strandedSql = `FROM agent_invocations inv
      WHERE inv.account_id = ? AND inv.binding_id = ? AND inv.status = 'pending'
        AND ${notPinnedSql("inv")}
        AND ${claimFitSql("inv")}
        AND ${dueWindowSql("inv")}
        AND ${needsSatisfiedSql("inv")}
        AND NOT ${jobBudgetExhaustedSql("inv")}`;
  const strandedBinds = [
    c.account_id,
    c.binding_id,
    ...claimFitBinds(claimant),
    ...dueWindowBinds({ now, escalationWindowMs: windowMs }),
  ];

  const counted = await env.DB.prepare(`SELECT COUNT(*) AS n ${strandedSql}`)
    .bind(...strandedBinds)
    .first<{ n: number }>();
  const waitingCount = counted?.n ?? 0;
  // The superset in pass 1 found this binding under the widest window; its own
  // window may be narrower. Nothing waiting under the real window is nothing to
  // ask about.
  if (waitingCount === 0) return false;

  const money = await env.DB.prepare(
    `SELECT json_extract(b.config_json, '$.budgets.spendPerMonth') AS cap,
            (SELECT COALESCE(SUM(s.cost_micros), 0) FROM agent_invocations s
              WHERE s.account_id = ? AND s.binding_id = ?
                AND s.done_at IS NOT NULL AND s.done_at >= ?) AS spent,
            (SELECT COALESCE(SUM(o.amount_micros), 0) FROM agent_budget_overages o
              WHERE o.account_id = ? AND o.binding_id = ? AND o.period_key = ?) AS granted
       FROM agent_bindings b WHERE b.account_id = ? AND b.id = ?`,
  )
    .bind(
      c.account_id,
      c.binding_id,
      budgetMonthStartMs(now),
      c.account_id,
      c.binding_id,
      periodKey,
      c.account_id,
      c.binding_id,
    )
    .first<{ cap: number | null; spent: number; granted: number }>();
  if (!money || typeof money.cap !== "number") return false; // raced a config edit

  // The effective ceiling, which is what the human is actually being asked to
  // lift: the configured cap PLUS anything already granted this period.
  const capMicros = money.cap + money.granted;
  const medianMicros = await bindingMedianCostMicros(env.DB, c.account_id, c.binding_id);
  const estimateMicros = medianMicros !== null ? Math.round(medianMicros * waitingCount) : null;
  const overageMicros =
    estimateMicros !== null
      ? Math.ceil(estimateMicros * OVERAGE_HEADROOM)
      : // No paid history to estimate from. The bound falls back to ONE MONTH'S
        // CAP — a number the operator already sized and authorized once — rather
        // than to a guess dressed as an estimate, and to a nominal $1 when even
        // that is zero ("never spend paid"). Said out loud in the rationale, and
        // editable before approval.
        Math.max(money.cap, NOMINAL_UNKNOWN_BOUND_MICROS);

  // ---- the marker: mark once → ask once ----------------------------------
  // A guarded UPDATE, exactly T3's shape, on ONE representative row: the oldest
  // stranded invocation of this binding. The guard admits a row that is unmarked
  // OR carries a budget marker from a PREVIOUS period (a new period is a new
  // question) and never clobbers `overdue-pinned`/`overdue-unfit`, which are
  // permanent facts about a passed deadline.
  const representative = await env.DB.prepare(
    `SELECT inv.id ${strandedSql}
        AND (inv.alert_kind IS NULL
             OR (inv.alert_kind LIKE '${BUDGET_MARKER_PREFIX}:%' AND inv.alert_kind <> ?))
      ORDER BY inv.created_at, inv.id LIMIT 1`,
  )
    .bind(...strandedBinds, markerKind)
    .first<{ id: string }>();
  if (!representative) return false;

  const marked = await env.DB.prepare(
    `UPDATE agent_invocations SET alert_kind = ?, alert_at = ?
      WHERE account_id = ? AND id = ? AND status = 'pending'
        AND (alert_kind IS NULL
             OR (alert_kind LIKE '${BUDGET_MARKER_PREFIX}:%' AND alert_kind <> ?))`,
  )
    .bind(markerKind, now, c.account_id, representative.id, markerKind)
    .run();
  // Zero changes = a raced sweep marked it first (both sweeps pick the SAME
  // representative — the ordering is total — so exactly one can win), or the row
  // was claimed in between. Either way the question is already asked, or moot.
  if (marked.meta.changes !== 1) return false;

  // ---- the proposal ------------------------------------------------------
  // A proposal's id IS its invocation's id (agent_proposals PK == the
  // invocation's), so this ask gets its OWN invocation rather than hanging off
  // the representative: that row is still pending work, and when it eventually
  // runs its own pipeline would try to emit a proposal under the same key. The
  // carrier is finished on arrival (`done`, cost 0 — no model was called), the
  // same shape every other proposal's invocation is in by the time a human sees
  // it.
  const carrierId = `inv_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO agent_invocations
       (id, account_id, binding_id, binding_name, status, context_json,
        created_at, claimed_at, done_at, cost_micros, result_json)
     VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, 0, ?)`,
  )
    .bind(
      carrierId,
      c.account_id,
      c.binding_id,
      c.binding_name,
      JSON.stringify({ kind: BUDGET_OVERRUN_KIND, periodKey, waitingCount }),
      now,
      now,
      now,
      JSON.stringify({ kind: BUDGET_OVERRUN_KIND, periodKey, markedInvocation: representative.id }),
    )
    .run();

  const payload = {
    bindingId: c.binding_id,
    bindingName: c.binding_name,
    waitingCount,
    monthSpentMicros: money.spent,
    capMicros,
    estimateMicros,
    periodKey,
    // Not in the devPlan's field list, and load-bearing anyway: this is the
    // BOUND an approve applies. Keeping it in the payload (rather than deriving
    // it at apply time) is what makes it EDITABLE — a human who wants a smaller
    // ceiling changes this one number and the diff is retained against the
    // agent's original, like every other approve-after-edit.
    overageMicros,
  };

  // Tier 1, and the tier is forced rather than chosen. Tier 2 parks an approve
  // in the hold tray and NEVER applies (the commit-out-of-tray is s03.D T2, not
  // built) — an approved overage that grants nothing is worse than no question.
  // Tier 3 demands the `send` capability, which is the wrong wall: nothing
  // egresses here. Tier 1 is also honest about reversibility: the GRANT is
  // reversible (the undo handle revokes the row and the cap snaps back), even
  // though money spent under it is not — which is exactly why the grant is
  // BOUNDED and period-scoped rather than a raised cap.
  await emitProposal(
    env,
    { id: carrierId, account_id: c.account_id },
    {
      kind: BUDGET_OVERRUN_KIND,
      tier: 1,
      subject: { realm: "AgentBinding", objectId: c.binding_id },
      payload,
      // The numbers ARE the rationale — this is not a persuasion surface.
      rationale:
        `${c.binding_name} has spent ${usd(money.spent)} of its ${usd(capMicros)} budget for ` +
        `${periodKey} and ${waitingCount} invocation${waitingCount === 1 ? "" : "s"} ` +
        `${waitingCount === 1 ? "is" : "are"} waiting that no free runtime has taken. ` +
        (estimateMicros !== null
          ? `Clearing them costs about ${usd(estimateMicros)} (median of this binding's past paid ` +
            `runs, ${usd(medianMicros ?? 0)} each, × ${waitingCount}); the requested overage is ` +
            `${usd(overageMicros)} — the estimate plus ${Math.round((OVERAGE_HEADROOM - 1) * 100)}% ` +
            "headroom, because a median under-shoots half the time. "
          : "This binding has no paid cost history, so the cost to clear them is UNKNOWN — " +
            `no number is guessed here. The requested overage is a nominal ${usd(overageMicros)}; ` +
            "edit it before approving if you want a different ceiling. ") +
        `Approving grants that amount for ${periodKey} only, to this binding only; the configured ` +
        `cap is not changed. Declining leaves the work queued — nothing is cancelled and nothing ` +
        "is recorded against the agent.",
      evidence: [
        {
          realm: "AgentBinding",
          objectId: c.binding_id,
          note: `spendPerMonth ${usd(money.cap)}${money.granted > 0 ? ` + ${usd(money.granted)} already approved this period` : ""}; spent ${usd(money.spent)} in ${periodKey}`,
        },
        {
          realm: "AgentInvocation",
          objectId: representative.id,
          note: `oldest of ${waitingCount} waiting invocation${waitingCount === 1 ? "" : "s"}; marked ${markerKind}`,
        },
      ],
      // The period IS the deadline. An unanswered overage question is MOOT next
      // month: the spend sum resets, the binding is under its cap again, and the
      // work moves without anyone deciding anything. An expiry beyond the period
      // would ask a human to authorize spending nobody needs any more.
      // Absolute rather than a duration, so it lands exactly on the boundary the
      // spend sum and the overage's period_key both turn over at.
      expiresAt: budgetPeriodEndMs(now),
    },
  );

  await commitChanges(env.ACCOUNT_DO, c.account_id, [
    {
      collection: "AgentInvocation",
      created: [carrierId],
      updated: [representative.id],
      destroyed: [],
    },
  ]);

  console.warn(
    `agent budget: ${c.binding_name} is out of budget for ${periodKey} — ${waitingCount} ` +
      `invocation(s) waiting, ${usd(money.spent)}/${usd(capMicros)} spent; asked for a bounded ` +
      `${usd(overageMicros)} overage (proposal ${carrierId})`,
  );
  return true;
}

/** micro-USD → "$1.23". The unit the whole budget path speaks in; rendered once
 * here so the rationale and the log line cannot disagree. */
export function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}
