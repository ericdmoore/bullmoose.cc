import { bindingMedianCostMicros, budgetMonthStartMs, budgetPeriodEndMs, budgetPeriodKey } from "@bullmoose/scheduling";
import { usd } from "./budgetOverrun.js";
import type { Env } from "./models.js";

/**
 * s26 T3 v2 — SURPLUS BURNS THE BACKLOG (devPlan rule 2).
 *
 * The queue-as-cursor answers forward progress; the manual backfill verb
 * (services/provision, s26 T3 v1) mints the historical half on demand. This
 * pass is the third leg: near the END of a budget cycle, when the projected
 * surplus is safely estimable, the agent works its backlog with money the
 * human already approved — "this spends the APPROVED money instead of wasting
 * it". No new approval, because there is no new spend authority: minted rows
 * are ordinary pending invocations, still claimed through the s11 gate, still
 * inside the binding's monthly cap.
 *
 * ── The projection, and why every rounding leans the same way ──────────────
 *
 * Terms IDENTICAL to `budgetExhaustedSql`'s (packages/scheduling/claimGate.ts)
 * — the one spend arithmetic in the system, reused rather than reinvented:
 *
 *   spent        SUM(cost_micros) of this binding's runs finished this UTC
 *                month (`done_at >= budgetMonthStartMs(now)`);
 *   capEffective `budgets.spendPerMonth` + SUM(agent_budget_overages) for
 *                this period — the same ceiling the claim gate enforces.
 *
 * On top of those, the projection of what LIVE work will still cost:
 *
 *   surplus = capEffective − spent − (spent / elapsedDays) × remainingDays
 *
 * with elapsedDays FLOORED (inflates the daily average) and remainingDays
 * CEILED (inflates the projected live spend) — both roundings shrink the
 * surplus, so an estimation error strands a little money rather than minting
 * work the month cannot pay for. Even a wrong projection cannot overspend:
 * minting is QUEUEING, not spending, and the claim gate still refuses paid
 * claims the moment the cap is genuinely reached.
 *
 * ── The gates, in order, and what each refusal means ───────────────────────
 *
 *   window   only the last SURPLUS_WINDOW_DAYS of the UTC month: earlier, the
 *            projection is mostly extrapolation ("safely estimable" it is not);
 *   floor    surplus must clear SURPLUS_FLOOR_FRACTION of capEffective — a
 *            thin surplus is noise, not headroom;
 *   history  the mint is bounded below by the binding's HISTORY FLOOR
 *            (`historyFloor ?? createdAt`, devPlan rule 1). No floor = a
 *            pre-s26 binding = fail CLOSED and say so: guessing a window would
 *            reprocess an archive nobody approved;
 *   sizing   the batch is min(backlog, what the surplus buys at the binding's
 *            median per-run cost, SURPLUS_MINT_CAP). An unknown median (no
 *            paid history) is carried as null — never a guessed number — and
 *            the batch cap alone bounds the mint, which is safe for the same
 *            queueing-not-spending reason;
 *   marker   idempotent per (binding, period): the T9 period-marker pattern in
 *            its guarded-INSERT flavor (frontierDigest.ts) — a deterministic
 *            carrier-row id makes the primary key the guard, so one period
 *            gets ONE surplus mint and every later tick is a cheap no-op. The
 *            per-email guard inside each mint already prevents duplicates;
 *            the marker only stops the wasted re-scan.
 *
 * The marker's result_json carries the ledger the dossier renders —
 * "backfilling: surplus $0.83 of $2.00, 41 of 210 messages" — so the numbers
 * are read from the record, never re-derived.
 *
 * The whole pass FAILS OPEN with loud logs: a broken projection must never
 * take the cron's real work (drain, backstops, proposals) down with it.
 */

/** Only the last N days of the UTC month: before that, the projection is
 * mostly extrapolation and "safely estimable" (devPlan rule 2) is a stretch. */
export const SURPLUS_WINDOW_DAYS = 5;

/** The mint threshold, as a fraction of the effective cap. Below it the
 * surplus is projection noise, not headroom worth burning. */
export const SURPLUS_FLOOR_FRACTION = 0.25;

/** How many invocations one surplus mint may create. Bounds the write burst
 * exactly as BACKFILL_MINT_CAP bounds the manual verb's (provision, v1). */
export const SURPLUS_MINT_CAP = 100;

/** How many bindings one sweep may consider — the OVERRUN_BINDING_LIMIT
 * discipline: a pathological fan-out stays bounded. */
const SURPLUS_BINDING_LIMIT = 25;

const DAY_MS = 86_400_000;

/** The marker's deterministic id — the idempotence key IS the primary key
 * (PK is (account_id, id), so the binding id in the string scopes it). */
export function surplusMarkerId(bindingId: string, periodKey: string): string {
  return `inv_surplus-backfill_${bindingId}_${periodKey}`;
}

/** Inside the mint window? Pure — the clock is an argument, never read here. */
export function inSurplusWindow(now: number): boolean {
  return now >= budgetPeriodEndMs(now) - SURPLUS_WINDOW_DAYS * DAY_MS;
}

export interface SurplusInputs {
  now: number;
  monthStartMs: number;
  periodEndMs: number;
  /** `budgets.spendPerMonth`, micro-USD. */
  capMicros: number;
  /** SUM(agent_budget_overages.amount_micros) for this period. */
  grantedMicros: number;
  /** SUM(cost_micros) finished this month — budgetExhaustedSql's spend term. */
  spentMicros: number;
}

export interface SurplusProjection {
  capEffectiveMicros: number;
  /** Floored, min 1 — INFLATES the daily average (the conservative direction). */
  elapsedDays: number;
  /** Ceiled — INFLATES the projected live spend (the conservative direction). */
  remainingDays: number;
  /** ceil(dailyAverage × remainingDays): what live work is projected to cost. */
  projectedMicros: number;
  /** capEffective − spent − projected. May be negative (over-pace month). */
  surplusMicros: number;
  /** The mint threshold: SURPLUS_FLOOR_FRACTION of the effective cap. */
  floorMicros: number;
}

/** The projection, pure and deterministic — every input is an argument, every
 * rounding leans toward a SMALLER surplus (see the module comment). */
export function projectSurplus(p: SurplusInputs): SurplusProjection {
  const capEffectiveMicros = p.capMicros + p.grantedMicros;
  const elapsedDays = Math.max(1, Math.floor((p.now - p.monthStartMs) / DAY_MS));
  const remainingDays = Math.max(0, Math.ceil((p.periodEndMs - p.now) / DAY_MS));
  const projectedMicros = Math.ceil((p.spentMicros / elapsedDays) * remainingDays);
  const surplusMicros = capEffectiveMicros - p.spentMicros - projectedMicros;
  const floorMicros = Math.ceil(capEffectiveMicros * SURPLUS_FLOOR_FRACTION);
  return { capEffectiveMicros, elapsedDays, remainingDays, projectedMicros, surplusMicros, floorMicros };
}

// ---- helpers MIRRORED from services/provision/src/index.ts ---------------
// The two workers share no module (provision depends only on auth-core), so
// the v1 backfill's floor/privacy readers and its guarded INSERT…SELECT are
// mirrored here VERBATIM rather than imported. If either side changes, change
// both — backfill.test.ts (provision) and surplusBackfill.test.ts (here) pin
// the shared behaviour from their own ends.

/** config_json, parsed junk-tolerantly (provision `safeConfig`): operator
 * TEXT must degrade to "nothing declared", never throw. */
function safeConfig(configJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(configJson || "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The binding's EFFECTIVE HISTORY FLOOR (provision `effectiveHistoryFloor`,
 * devPlan rule 1): `historyFloor` (an approved widening) beats `createdAt`
 * (the birth default); neither = pre-s26 binding = UNKNOWN, and unknown is
 * not "unbounded" — the caller fails closed. */
function effectiveHistoryFloor(configJson: string): {
  floorMs: number | null;
  source: "historyFloor" | "createdAt" | null;
} {
  const cfg = safeConfig(configJson);
  if (typeof cfg.historyFloor === "number" && Number.isFinite(cfg.historyFloor)) {
    return { floorMs: cfg.historyFloor, source: "historyFloor" };
  }
  if (typeof cfg.createdAt === "number" && Number.isFinite(cfg.createdAt)) {
    return { floorMs: cfg.createdAt, source: "createdAt" };
  }
  return { floorMs: null, source: null };
}

/** The binding's declared privacy floor, junk-tolerant (provision
 * `backfillPrivacy`): a typo can only fail to raise, never lower. */
function backfillPrivacy(configJson: string): string | null {
  const v = safeConfig(configJson).privacyFloor;
  return v === "open" || v === "internal" || v === "pinned" ? v : null;
}

// ---- the pass ------------------------------------------------------------

interface CandidateBinding {
  id: string;
  account_id: string;
  name: string;
  config_json: string;
  cap: number;
}

/**
 * The surplus sweep. Runs LAST on the agent cron and is SILENT unless a
 * binding genuinely has burnable surplus (DefaultCase — mid-month, thin
 * surplus, no backlog, already minted this period all produce nothing).
 *
 * @param now injected for determinism (tests pin it); production passes
 *   nothing and gets the wall clock ONCE, here, never deeper.
 * @returns bindings that minted this tick, and the total rows minted.
 */
export async function surplusBackfill(
  env: Env,
  now: number = Date.now(),
): Promise<{ bindings: number; minted: number }> {
  try {
    return await sweep(env, now);
  } catch (err) {
    // FAIL OPEN: this is an optimization pass. A broken projection must not
    // take the cron's real work down with it — but it must be LOUD.
    console.error(`agent surplus-backfill: pass failed open — ${String(err).slice(0, 500)}`);
    return { bindings: 0, minted: 0 };
  }
}

async function sweep(env: Env, now: number): Promise<{ bindings: number; minted: number }> {
  if (!inSurplusWindow(now)) return { bindings: 0, minted: 0 };

  const monthStartMs = budgetMonthStartMs(now);
  const periodEndMs = budgetPeriodEndMs(now);
  // Keyed to monthStartMs, not now — the claimGateBinds discipline: the two
  // halves of the budget comparison must never key different months.
  const periodKey = budgetPeriodKey(monthStartMs);

  // Backfillable = a pipeline whose work is per-message and idempotent per
  // (binding, email). v1: `extract` only — reply would re-answer old mail,
  // ledger re-book old receipts.
  const { results: candidates } = await env.DB.prepare(
    `SELECT b.id, b.account_id, b.name, b.config_json,
            json_extract(b.config_json, '$.budgets.spendPerMonth') AS cap
       FROM agent_bindings b
       JOIN accounts a ON a.id = b.account_id
      WHERE b.enabled = 1 AND a.deleted_at IS NULL
        AND json_valid(b.config_json)
        AND json_extract(b.config_json, '$.pipeline') = 'extract'
        AND json_type(b.config_json, '$.budgets.spendPerMonth') IN ('integer', 'real')
        AND json_extract(b.config_json, '$.budgets.spendPerMonth') > 0
      ORDER BY b.name LIMIT ${SURPLUS_BINDING_LIMIT}`,
  ).all<CandidateBinding>();

  let bindings = 0;
  let minted = 0;
  for (const b of candidates) {
    try {
      const n = await burnOne(env, b, now, monthStartMs, periodEndMs, periodKey);
      if (n > 0) {
        bindings += 1;
        minted += n;
      }
    } catch (err) {
      // Per-binding fail-open: one binding's bad config must not starve the
      // rest of the sweep.
      console.error(`agent surplus-backfill: ${b.name} (${b.id}) failed open — ${String(err).slice(0, 500)}`);
    }
  }
  return { bindings, minted };
}

/** One binding's burn, or nothing. Returns how many rows were minted. */
async function burnOne(
  env: Env,
  b: CandidateBinding,
  now: number,
  monthStartMs: number,
  periodEndMs: number,
  periodKey: string,
): Promise<number> {
  // ---- the money, in budgetExhaustedSql's exact terms --------------------
  const money = await env.DB.prepare(
    `SELECT (SELECT COALESCE(SUM(s.cost_micros), 0) FROM agent_invocations s
              WHERE s.account_id = ?1 AND s.binding_id = ?2
                AND s.done_at IS NOT NULL AND s.done_at >= ?3) AS spent,
            (SELECT COALESCE(SUM(o.amount_micros), 0) FROM agent_budget_overages o
              WHERE o.account_id = ?1 AND o.binding_id = ?2 AND o.period_key = ?4) AS granted`,
  )
    .bind(b.account_id, b.id, monthStartMs, periodKey)
    .first<{ spent: number; granted: number }>();
  if (!money) return 0;

  const proj = projectSurplus({
    now,
    monthStartMs,
    periodEndMs,
    capMicros: b.cap,
    grantedMicros: money.granted,
    spentMicros: money.spent,
  });
  // Thin (or negative) surplus: DefaultCase silence, and NO marker — the
  // projection improves as the month runs out, so a later tick may still
  // qualify this period.
  if (proj.surplusMicros < proj.floorMicros) return 0;

  // ---- the history floor (devPlan rule 1) --------------------------------
  const floor = effectiveHistoryFloor(b.config_json);
  if (floor.floorMs === null) {
    // Pre-s26 binding: fail CLOSED, loudly, pointing at the verb that
    // establishes a floor on purpose (the provision v1 posture, verbatim).
    console.warn(
      `agent surplus-backfill: ${b.name} (${b.id}) has surplus ${usd(proj.surplusMicros)} but NO history ` +
        `floor (no createdAt, no historyFloor) — backfill fails closed. Establish one: ` +
        `POST /agent-bindings/${b.id}/floor-request {toEpochMs}`,
    );
    return 0;
  }

  // ---- the backlog, and what the surplus can buy -------------------------
  const backlogRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM emails e
      WHERE e.account_id = ?1 AND e.received_at >= ?2 AND e.received_at < ?3
        AND NOT EXISTS (SELECT 1 FROM agent_invocations ai
                        WHERE ai.account_id = e.account_id AND ai.binding_id = ?4 AND ai.email_id = e.id)`,
  )
    .bind(b.account_id, floor.floorMs, now, b.id)
    .first<{ n: number }>();
  const backlog = backlogRow?.n ?? 0;
  if (backlog === 0) return 0;

  // What one run typically costs (s07 T5 history, the T9 estimator). NULL =
  // no paid history = UNKNOWN, carried as null — never a guessed number. The
  // batch is then bounded by SURPLUS_MINT_CAP alone, which is safe because
  // minting is queueing, not spending: the claim gate still enforces the cap.
  const medianMicros = await bindingMedianCostMicros(env.DB, b.account_id, b.id);
  const affordable = medianMicros !== null && medianMicros > 0 ? Math.floor(proj.surplusMicros / medianMicros) : null;
  const target = Math.min(backlog, SURPLUS_MINT_CAP, affordable ?? SURPLUS_MINT_CAP);
  // A surplus that cannot buy ONE run at the median price is not headroom.
  // No marker for the same reason as the floor check above.
  if (target <= 0) return 0;

  // ---- the marker: mint once per (binding, period) -----------------------
  // T9's period-marker idempotence in its guarded-INSERT flavor
  // (frontierDigest.ts): the deterministic id makes the PK the guard, so a
  // raced tick loses on `changes` rather than double-scanning. Written BEFORE
  // the mint (mark once → mint once); a failed mint deletes it so the next
  // tick retries rather than burning the period.
  const markerId = surplusMarkerId(b.id, periodKey);
  const marked = await env.DB.prepare(
    `INSERT OR IGNORE INTO agent_invocations
       (id, account_id, binding_id, binding_name, status, context_json,
        created_at, claimed_at, done_at, cost_micros, result_json)
     VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, 0, ?)`,
  )
    .bind(
      markerId,
      b.account_id,
      b.id,
      b.name,
      JSON.stringify({ kind: "surplus-backfill", periodKey }),
      now,
      now,
      now,
      JSON.stringify({ kind: "surplus-backfill", periodKey }),
    )
    .run();
  if (marked.meta.changes !== 1) return 0; // a prior tick already burned this period

  try {
    // ---- the mint: NEWEST-FIRST, NULL-due, idempotent per (binding, email) —
    // the v1 shape (provision backfillBinding), mirrored exactly: the SELECT
    // is only the shortlist; the NOT EXISTS re-check INSIDE each INSERT is the
    // idempotence guarantee under concurrency, shared with the manual verb so
    // a surplus tick racing a manual backfill still cannot double-mint.
    const { results: mailCandidates } = await env.DB.prepare(
      `SELECT e.id, e.thread_id FROM emails e
        WHERE e.account_id = ?1 AND e.received_at >= ?2 AND e.received_at < ?3
          AND NOT EXISTS (SELECT 1 FROM agent_invocations ai
                          WHERE ai.account_id = e.account_id AND ai.binding_id = ?4 AND ai.email_id = e.id)
        ORDER BY e.received_at DESC
        LIMIT ?5`,
    )
      .bind(b.account_id, floor.floorMs, now, b.id, target)
      .all<{ id: string; thread_id: string }>();

    const privacy = backfillPrivacy(b.config_json);
    let mintedHere = 0;
    if (mailCandidates.length > 0) {
      const statements = mailCandidates.map((e) =>
        env.DB.prepare(
          `INSERT INTO agent_invocations
             (id, account_id, binding_id, binding_name, status, email_id, context_json, created_at, privacy)
           SELECT ?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8
            WHERE NOT EXISTS (SELECT 1 FROM agent_invocations
                              WHERE account_id = ?2 AND binding_id = ?3 AND email_id = ?5)`,
        ).bind(
          `inv_${crypto.randomUUID()}`,
          b.account_id,
          b.id,
          b.name,
          e.id,
          // `backfill: true` is the scout trigger (extract.ts, rule 3a) — the
          // same flag the manual verb stamps. due_at stays NULL: sit-free
          // work a live homelab claimant may eat at $0.
          JSON.stringify({ emailId: e.id, threadId: e.thread_id, backfill: true, surplusPeriod: periodKey }),
          now,
          privacy,
        ),
      );
      const results = await env.DB.batch(statements);
      mintedHere = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
    }

    // The dossier's ledger line, on the marker — "backfilling: surplus $x of
    // $y, n of m" is read from here, never re-derived. `affordable` stays
    // null when the per-run cost is unknown (NULL-vs-0 honesty).
    await env.DB.prepare(`UPDATE agent_invocations SET result_json = ? WHERE account_id = ? AND id = ?`)
      .bind(
        JSON.stringify({
          kind: "surplus-backfill",
          periodKey,
          surplusMicros: proj.surplusMicros,
          capEffectiveMicros: proj.capEffectiveMicros,
          spentMicros: money.spent,
          projectedMicros: proj.projectedMicros,
          medianMicros,
          affordable,
          backlog,
          minted: mintedHere,
        }),
        b.account_id,
        markerId,
      )
      .run();

    console.log(
      `agent surplus-backfill: ${b.name} backfilling — surplus ${usd(proj.surplusMicros)} of ` +
        `${usd(proj.capEffectiveMicros)}, minted ${mintedHere} of ${backlog} message(s) for ${periodKey}` +
        (affordable === null ? " (per-run cost unknown — batch bounded by cap only)" : ""),
    );
    return mintedHere;
  } catch (err) {
    // Unmark so the next tick retries rather than losing the period to a
    // transient failure. The per-email guard makes the retry safe.
    await env.DB.prepare(`DELETE FROM agent_invocations WHERE account_id = ? AND id = ?`)
      .bind(b.account_id, markerId)
      .run();
    throw err;
  }
}
