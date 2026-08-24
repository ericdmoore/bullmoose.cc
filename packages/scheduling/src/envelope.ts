import { INVOCATION_STANDING_SCOPES } from "@bullmoose/auth-core/invocation";

/**
 * s44 slice 1 — THE ENVELOPE, as a projection of authority that is already
 * enforced somewhere else.
 *
 * The tool loop's governing question (`.plans/s44-tool-loop`) is what a human
 * approves when an agent's STEPS cannot be known in advance. Steps are
 * predictions and die on first tool result; principles are interpretations the
 * model grades itself against. The envelope binds — which tools, which realms,
 * how much money, which recipients, how far back — because every one of those
 * is checked by a machine at use time.
 *
 * ⚠️ THIS MODULE INVENTS NOTHING. Every field below names an enforcer that
 * exists today, and the pairing is the point:
 *
 *   scopes         `INVOCATION_STANDING_SCOPES` (auth-core/invocation), the set
 *                  a `bmi_` token carries — checked by `authorizeAccount` on
 *                  every tool call, before the envelope is consulted at all.
 *   toolCeiling    `config_json.jobs.tools` → `bindingCeiling` (nodeAuthority),
 *                  folded by `effectiveNodeAuthority` and enforced at
 *                  `mayUse` — see the honesty note on `toolCeilingApplies`.
 *   credentials    the same fold's credential axis (services/bureau grants.ts).
 *   budget         `budgetExhaustedSql`'s own arithmetic: cap + overages −
 *                  spend-this-month, refused INSIDE the claim UPDATE.
 *   recipients     `outboundBound.ts`: no book id, no send — fail-closed, and
 *                  the binding cannot email anyone at all.
 *   allowedSenders who may TRIGGER it (services/agent index.ts), the inbound
 *                  twin; empty means the gate is off.
 *   historyFloor   the s26 floor (`config_json.historyFloor`), enforced by the
 *                  provisioner's backfill door.
 *   enabled        the 008 kill switch, refused OUTSIDE the free short-circuit
 *                  in `claimGateSql` — a disabled binding reaches NOTHING, so
 *                  it is rendered first and everything else reads as moot.
 *
 * A projection that drifted from its enforcer would be worse than none: it is
 * read to decide whether an ask is proportionate. Where the truth is "not
 * bounded here", the field is null and the RENDERER must say so in words —
 * never an empty list, which asserts "none".
 */

/** What a binding may reach, as a human reads it before approving more. */
export interface BindingEnvelope {
  bindingId: string;
  name: string;
  /** The 008 kill switch. False = reaches nothing; every other field is moot. */
  enabled: boolean;
  /** The standing scopes a `bmi_` invocation token carries. */
  scopes: string[];
  /** `config_json.jobs.tools`. NULL = no binding-level tool ceiling. */
  toolCeiling: string[] | null;
  /**
   * Whether that ceiling BITES today. A job-less invocation folds to
   * `tools: null` (nodeAuthority: `job_id IS NULL` → no delegation), so a
   * ceiling declared on a binding whose work is not part of a Job bounds
   * nothing — the honest projection says which.
   */
  toolCeilingApplies: "jobs-only";
  /** `config_json.jobs.credentials`. NULL = no binding-level ceiling. */
  credentialCeiling: string[] | null;
  /** Job-graph caps (`config_json.jobs`), null where unset. */
  maxNodes: number | null;
  maxDepth: number | null;
  /** The money axis. `capMicros` null = no cap recorded (unbounded). */
  budget: {
    capMicros: number | null;
    spentMicros: number;
    overageMicros: number;
    /** cap + overage − spent, or null when there is no cap to remain within. */
    remainingMicros: number | null;
  };
  /** Who it may email. NULL = fail-closed: no governing book, no send. */
  recipientsBookId: string | null;
  /**
   * Who may TRIGGER it, as a DERIVED FACT — never the addresses. The
   * allowlist holds third parties' data (console.ts's own rule: derived
   * facts, never the config), and an envelope reader needs to know the gate
   * exists and how wide it is, not who is in it. `active: false` = the gate
   * is off and any human sender may trigger.
   */
  senderGate: { active: boolean; count: number };
  /** The s26 history floor as epoch ms, or null when none is recorded (the
   *  backfill door then fails closed). */
  historyFloorAt: number | null;
}

/** The raw row the projection reads — exactly the columns that are enforced. */
export interface EnvelopeBindingRow {
  id: string;
  name: string;
  enabled: number;
  config_json: string;
  recipients_book_id: string | null;
}

/** Spend facts, computed where they are enforced (console readLedgers /
 *  budgetExhaustedSql), passed in rather than re-derived here. */
export interface EnvelopeSpend {
  spentMicros: number;
  overageMicros: number;
}

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : null;

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Build the envelope. Junk-tolerant by construction: an unreadable
 * `config_json` reads as "nothing declared", which is what `bindingCeiling`
 * itself does with a corrupt config — the projection must not be stricter
 * than the enforcer, or it would show a bound nobody applies.
 */
export function bindingEnvelope(row: EnvelopeBindingRow, spend: EnvelopeSpend): BindingEnvelope {
  let cfg: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.config_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cfg = parsed as Record<string, unknown>;
  } catch {
    // corrupt config = nothing declared, exactly as bindingCeiling reads it
  }
  const jobs = (cfg.jobs ?? {}) as Record<string, unknown>;
  const budgets = (cfg.budgets ?? {}) as Record<string, unknown>;
  const capMicros = finite(budgets.spendPerMonth);

  return {
    bindingId: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    scopes: [...INVOCATION_STANDING_SCOPES],
    toolCeiling: strings(jobs.tools),
    toolCeilingApplies: "jobs-only",
    credentialCeiling: strings(jobs.credentials),
    maxNodes: finite(jobs.maxNodes),
    maxDepth: finite(jobs.maxDepth),
    budget: {
      capMicros,
      spentMicros: spend.spentMicros,
      overageMicros: spend.overageMicros,
      // Null cap means nothing to remain WITHIN — not "infinite remaining".
      remainingMicros: capMicros === null ? null : capMicros + spend.overageMicros - spend.spentMicros,
    },
    recipientsBookId: row.recipients_book_id,
    senderGate: (() => {
      const list = strings(cfg.allowedSenders) ?? [];
      return { active: list.length > 0, count: list.length };
    })(),
    historyFloorAt: finite(cfg.historyFloor),
  };
}
