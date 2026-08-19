// The eligibility gate (s11 T2) — `mayClaim`, pure.
//
// The three-term gate of jobs-and-facets.md §6:
//
//   eligible = authority(claimant.grants)         -- MAY it act    (server-verified; NOT here —
//                                                    requireAccount / the drain's own identity)
//            ∧ fit(claimant.capabilities, facets) -- CAN it succeed (self-declared; this module)
//            ∧ policy(facets, budgetState, now)   -- SHOULD it, yet (this module)
//
// This module is the SINGLE definition of terms two and three. It is pure and
// table-tested; `claimGate.ts` is the same predicate as SQL, folded into every
// claim UPDATE's WHERE so a generous client-side self-filter cannot widen the
// eligible set (jobs-and-facets §5: preference is client-side, eligibility is
// not). `claimGateAgreement.test.ts` proves the two stay in agreement.
//
// ── Claimant identity: trust-but-audit, never attestation ──────────────────
// The claimant declares `{ isFree, capabilities }` on the claim call. Both are
// FIT-SHAPED, not authority-shaped: lying about `isFree` or a capability earns
// you work you should not have taken, never permissions you do not hold — the
// same argument that makes self-declared capabilities safe (§6: history
// punishes over-claiming). So the server TRUSTS the declaration for the gate
// and RECORDS it on the claim (`claimant_free`, `claimant_caps_json`), where
// the score/audit machinery catches a "free" claimant whose invocations keep
// stamping nonzero cost_micros. Remote attestation is deliberately not
// attempted. Absent declaration = paid, no capabilities — the conservative
// default for `policy`; for `fit` an UNDECLARED vector claims exactly as today
// (see `fit` below — the T2-FIT-CONTRACT obligation).
//
// ── The NULL-due reading (PLAN DELTA, authoritative) ───────────────────────
// devPlan T2 said "due_at NULL → free-runtime-only, indefinitely". Composed
// with a production deployment that runs NO homelab daemon, that would strand
// every NULL-due invocation forever — violating jobs-and-facets' "facets
// tighten, never strand" and its DefaultCase ("no facets = claimable exactly
// as today"). The reading built here instead applies the sit-free rule ONLY
// while a free runtime is demonstrably live: a free claimant claimed on this
// account within FREE_RUNTIME_LIVE_MS (readme decision 3's absence-inference —
// liveness is inferred from recent claims, no heartbeat). No live free runtime
// → paid is eligible immediately. DefaultCase is thereby preserved in the
// default WORLD (no homelab = today's behavior, byte-identical), and the
// sit-free optimism only ever manifests when someone free is actually there
// to pick the work up.

/** Privacy is a class, not a score (jobs-and-facets §2). Mirrors ingest's. */
export type PrivacyClass = "open" | "internal" | "pinned";

/**
 * The claimant's self-declared capability vector — same shape the fleet host
 * declares in fleet.json (`HostCapabilities` in packages/cli/src/agent.ts,
 * which cannot import this package: the CLI has no workspace deps by design).
 */
export interface ClaimCapabilities {
  vision?: boolean;
  contextTokens?: number;
  tools?: boolean;
}

/**
 * Who is claiming. `capabilities: null` = no vector declared (distinct from
 * a declared-but-empty `{}`, which means "I can do nothing special").
 */
export interface ClaimantIdentity {
  isFree: boolean;
  capabilities: ClaimCapabilities | null;
}

/** The facet slice `policy`/`fit` read off the invocation row. */
export interface ClaimFacets {
  /** `due_at` — epoch ms, or null = no known deadline. */
  dueAt: number | null;
  /** `privacy` — the stamped class, or null (DefaultCase). */
  privacy: string | null;
  /** Parsed `requires_json`, or null. Kept `unknown`: it is stored TEXT. */
  requires: unknown;
}

/**
 * The time-varying world-state `policy` needs, computed by the claim site
 * (in SQL, by the same claim statement — see claimGate.ts).
 */
export interface BudgetState {
  /**
   * The binding's `config_json.budgets.spendPerMonth` (micro-USD) is set to a
   * number AND the current UTC calendar month's summed `cost_micros` for the
   * binding has reached the EFFECTIVE ceiling. No spendPerMonth configured →
   * never exhausted. A spendPerMonth of 0 means "never spend paid" and is
   * exhausted from the first moment.
   *
   * Fold it with `budgetExhausted()` below rather than by hand: since s11 T9
   * the ceiling is `cap + approved overage`, and the overage term is the whole
   * point of the T9 proposal.
   */
  budgetExhausted: boolean;
  /**
   * s17 — this row is HANDED-OFF work and the binding that handed it is out of
   * money for the month. Pure twin of `handoffOriginBudgetExhaustedSql`.
   *
   * OPTIONAL, and absent means false, which is the DefaultCase in the strong
   * sense: an ordinary invocation was not handed to anyone, so there is no
   * second month to consult and a caller that predates handoffs states nothing
   * and gets exactly today's verdict. Compute it with `budgetExhausted()` over
   * the HANDING binding's numbers — same function, different binding — so the
   * two months can never be arithmetically different questions.
   */
  handoffOriginBudgetExhausted?: boolean;
  /**
   * A free claimant (`claimant_free = 1`) claimed on this account within
   * FREE_RUNTIME_LIVE_MS of now — readme decision 3's absence-inference.
   */
  freeRuntimeLive: boolean;
  /** The escalation window for this invocation's binding — escalationWindowMs(). */
  escalationWindowMs: number;
}

/**
 * Liveness horizon for the absence-inference (readme decision 3): a free
 * runtime that claimed within the last 15 minutes is "here". The fleet host
 * drains at least every 5 minutes when healthy, so 15 minutes = three missed
 * ticks — dead, not slow. Worst case after a homelab death, NULL-due work
 * waits one horizon before the cloud takes it.
 */
export const FREE_RUNTIME_LIVE_MS = 15 * 60_000;

/** Escalation window bounds — devPlan decision 1, resolved cost-scaled. */
export const ESCALATION_WINDOW_NO_HISTORY_MS = 60 * 60_000; // no history → 1h
export const ESCALATION_WINDOW_MIN_MS = 15 * 60_000;
export const ESCALATION_WINDOW_MAX_MS = 4 * 60 * 60_000;
/** Paid escalates at 3× the typical runtime before due — room for one retry
 * and a fallback, which is what the window exists to buy. */
export const ESCALATION_RETRY_FACTOR = 3;

/**
 * The escalation window (devPlan decision 1 — cost-scaled, not fixed):
 *
 *   window = clamp(3 × median(past durations of this binding), 15min, 4h)
 *   no history → 1h
 *
 * "Duration" is done_at − claimed_at of past `done` invocations of the same
 * binding (the per-kind cost estimate's population, time instead of dollars —
 * history beats hints). Pure: callers fetch the durations; this only folds.
 */
export function escalationWindowMs(pastDurationsMs: readonly number[]): number {
  if (pastDurationsMs.length === 0) return ESCALATION_WINDOW_NO_HISTORY_MS;
  const sorted = [...pastDurationsMs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.min(ESCALATION_WINDOW_MAX_MS, Math.max(ESCALATION_WINDOW_MIN_MS, ESCALATION_RETRY_FACTOR * median));
}

/**
 * THE BUDGET TERM, pure (s11 T9) — the fold behind `BudgetState.budgetExhausted`
 * and the twin of `budgetExhaustedSql`'s comparison.
 *
 *   exhausted  ⟺  cap is a number  ∧  spent ≥ cap + approvedOverage
 *
 * The overage is what an APPROVED `budget-overrun` proposal grants: this
 * binding, this period, an AMOUNT (micro-USD, the same unit as the cap and as
 * `cost_micros`). It raises the ceiling for one period and nothing else — the
 * cap in config is untouched, which is what keeps "spend a bit more this month"
 * from silently becoming standing policy (devPlan T9).
 *
 * Amount rather than count, and the arithmetic is why: a count bounds no money
 * (one expensive invocation outspends ten cheap ones), and an amount composes
 * with the comparison that already exists — one addition, on both sides of the
 * pure/SQL agreement, instead of a second and differently-shaped predicate.
 *
 * `capMicros: null` = no cap configured (or a non-numeric one) → never
 * exhausted, and an overage against no cap is inert rather than a licence.
 */
export function budgetExhausted(p: { capMicros: number | null; spentMicros: number; overageMicros: number }): boolean {
  if (p.capMicros === null) return false;
  return p.spentMicros >= p.capMicros + p.overageMicros;
}

/**
 * THE BACKFILL ENVELOPE, pure (s26 T3 v2) — the twin of
 * `backfillEnvelopeExhaustedSql`'s comparison.
 *
 * A manual backfill (`POST /agent-bindings/{id}/backfill {budgetMicros}`)
 * names its own money: the envelope rides on every row it mints
 * (`context_json.backfillBudgetMicros`), and an envelope-carrying row draws
 * from THAT purse, not the binding's monthly cap — the admin already sized
 * this spend when they typed the number, and a monthly gate would make the
 * archive compete with live mail for a budget that was never meant to cover
 * it.
 *
 *   exhausted  ⟺  backfillSpent ≥ envelope
 *
 * `backfillSpent` is the binding's ALL-TIME summed `cost_micros` over
 * finished backfill-tagged runs — all time, not month-bucketed, because an
 * envelope is per-request money, not a monthly allowance; and NULL costs add
 * nothing (unknown is not a spend), exactly as in the monthly sum. A later
 * request's envelope therefore reads as a TOTAL backfill ceiling: prior
 * backfill spend counts against it, which is the conservative direction.
 *
 * A 0 envelope is exhausted from the first moment — "mint the rows, spend
 * nothing paid" — mirroring `spendPerMonth: 0`. Exhaustion is NOT an error
 * and narrows the claimant set exactly as the monthly cap does: the rows sit
 * pending, a free (homelab) runtime may still eat them at $0, and the next
 * envelope or surplus pass picks them back up.
 */
export function backfillEnvelopeExhausted(p: { envelopeMicros: number; backfillSpentMicros: number }): boolean {
  return p.backfillSpentMicros >= p.envelopeMicros;
}

/**
 * The ONE budget verdict a row gets — the fold callers use to fill
 * `BudgetState.budgetExhausted`, stated here so the pure and SQL formulations
 * of the envelope CASE cannot drift apart (claimGateAgreement.test.ts holds
 * them together):
 *
 *   envelope-carrying backfill row → its envelope, INSTEAD OF the monthly cap;
 *   every other row (live work, an envelope-less manual backfill, a surplus
 *   mint) → the monthly cap, exactly as before.
 *
 * `backfillEnvelopeMicros` is non-null ONLY when the row is backfill-tagged
 * (`context_json.backfill === true`) AND carries a numeric
 * `backfillBudgetMicros` — the caller's contract, matching
 * `backfillEnvelopeSql`. Junk degrades to null, i.e. to the monthly gate:
 * garbage can reroute a row back to today's behavior, never widen its money.
 */
export function effectiveBudgetExhausted(p: {
  capMicros: number | null;
  spentMicros: number;
  overageMicros: number;
  backfillEnvelopeMicros: number | null;
  backfillSpentMicros: number;
}): boolean {
  if (p.backfillEnvelopeMicros !== null) {
    return backfillEnvelopeExhausted({
      envelopeMicros: p.backfillEnvelopeMicros,
      backfillSpentMicros: p.backfillSpentMicros,
    });
  }
  return budgetExhausted(p);
}

/**
 * Parse the untrusted `claimant` argument off a claim call. Absent or
 * malformed → paid with no vector — the conservative default. `isFree` counts
 * only as the literal boolean true; capability fields keep only well-typed
 * values (a garbage `vision: "yes"` degrades to "cannot", never to "can").
 */
export function normalizeClaimant(raw: unknown): ClaimantIdentity {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { isFree: false, capabilities: null };
  }
  const r = raw as { isFree?: unknown; capabilities?: unknown };
  let capabilities: ClaimCapabilities | null = null;
  if (typeof r.capabilities === "object" && r.capabilities !== null && !Array.isArray(r.capabilities)) {
    const c = r.capabilities as { vision?: unknown; contextTokens?: unknown; tools?: unknown };
    capabilities = {};
    if (typeof c.vision === "boolean") capabilities.vision = c.vision;
    if (typeof c.tools === "boolean") capabilities.tools = c.tools;
    if (typeof c.contextTokens === "number" && Number.isFinite(c.contextTokens)) {
      capabilities.contextTokens = c.contextTokens;
    }
  }
  return { isFree: r.isFree === true, capabilities };
}

/**
 * FIT — can this claimant succeed at this work?
 *
 * Semantics are deliberately IDENTICAL to the fleet host's client-side
 * `fitsRequirements` (packages/cli/src/agent.ts), which becomes pure
 * preference now that this is enforced server-side:
 *
 *   - no `requires` facet (null / not an object)     → no fit constraint
 *   - NO DECLARED VECTOR (`capabilities: null`)      → claimable, as today.
 *     This is the T2-FIT-CONTRACT obligation, and it is a deliberate
 *     asymmetry with `isFree` (where absence = conservative): treating an
 *     undeclared vector as "can do nothing" would make every requires-stamped
 *     invocation unclaimable by every pre-T2 claimant — facets would strand,
 *     not tighten. Under-declaring fit only costs the claimant work; the
 *     stale-claim sweeper and the score punish OVER-claiming.
 *   - within a declared vector: booleans default to "cannot"; an unstated
 *     contextTokens means "no known limit".
 */
export function fit(capabilities: ClaimCapabilities | null | undefined, requires: unknown): boolean {
  if (requires === null || requires === undefined || typeof requires !== "object") return true;
  if (!capabilities) return true;
  const r = requires as { vision?: unknown; tools?: unknown; contextTokens?: unknown };
  if (r.vision === true && capabilities.vision !== true) return false;
  if (r.tools === true && capabilities.tools !== true) return false;
  if (
    typeof r.contextTokens === "number" &&
    typeof capabilities.contextTokens === "number" &&
    r.contextTokens > capabilities.contextTokens
  ) {
    return false;
  }
  return true;
}

/**
 * POLICY — should this claimant take it YET?
 *
 * Policy never restricts a FREE claimant: every rule below is about when the
 * PAID cloud becomes eligible, so `isFree` short-circuits true. For paid:
 *
 *   1. privacy = 'pinned'  → never. A hard constraint, past due included —
 *      devPlan decision 0: privacy beats liveness; pinned work MAY sit, and
 *      alerting on overdue pinned work is T3's, not the gate's.
 *   2. budget exhausted    → never, regardless of due-ness. Exhaustion narrows
 *      the claimant set; it does not fail the invocation. (Past-due liveness
 *      is T3's watchdog, which claims OUTSIDE this gate.)
 *   2b. the HANDING binding's budget exhausted (s17, handed-off rows only) →
 *      never, for the same reason and by the same arithmetic.
 *   3. due_at set          → eligible from (due_at − escalationWindow) on,
 *      past-due included.
 *   4. due_at NULL         → eligible unless a free runtime is live (the
 *      sit-free rule under the absence-inference — see the header note; this
 *      is the stranding guard).
 */
export function policy(
  facets: Pick<ClaimFacets, "dueAt" | "privacy">,
  claimant: Pick<ClaimantIdentity, "isFree">,
  budget: BudgetState,
  now: number,
): boolean {
  if (claimant.isFree) return true;
  if (facets.privacy === "pinned") return false;
  if (budget.budgetExhausted) return false;
  // s17 — and the HANDING binding's month, for handed-off work only. A
  // CONJUNCTION with the line above, never a substitution: a binding that has
  // spent its month must not be able to keep working on a colleague's money by
  // handing its backlog over. See `handoffOriginBudgetExhaustedSql` for the
  // full budget decision and for why the sender's cap is a gate rather than a
  // purse.
  if (budget.handoffOriginBudgetExhausted === true) return false;
  if (facets.dueAt !== null) return facets.dueAt - budget.escalationWindowMs <= now;
  return !budget.freeRuntimeLive;
}

/**
 * The gate: fit ∧ policy. Authority is the first term and lives with the
 * claim sites (requireAccount; the drain's own service identity) — it is
 * hard, server-verified, and no concern of this module's.
 */
export function mayClaim(facets: ClaimFacets, claimant: ClaimantIdentity, budget: BudgetState, now: number): boolean {
  return fit(claimant.capabilities, facets.requires) && policy(facets, claimant, budget, now);
}
