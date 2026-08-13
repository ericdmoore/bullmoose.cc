// Facet stamping at the boundary (s11 T6) — the mechanical half.
//
// Facets are CONSTRAINTS the future claim gate (T2's `mayClaim`) reads, never
// prescriptions (jobs-and-facets.md §2). Ingest is the author of exactly the
// facets derivable from the work itself with no model call and no judgment:
// capability requirements from size and MIME types, and the privacy class
// composed from the binding's configured floor. Judged facets — sender class,
// privacy STAMPS above the floor, effort priors — belong to the s12 boundary
// agent (bouncer@) and are left NULL here; inventing a classifier in ingest
// would be building s12 badly.
//
// The one hard invariant in this wave is THE FLOOR RULE (jobs-and-facets.md
// §6): a mis-stamped privacy facet is not cosmetic — `open` stamped on what
// should be `pinned` routes private mail to a paid cloud model. So privacy
// composes MAX-wise against every implicated binding floor: a stamp may RAISE
// the class, never lower it below a floor. Floors are config, written once;
// stamps are per-message. A compromised boundary can then delay or
// over-tighten work — annoying, visible — but cannot leak it downward.
//
// DefaultCase is structural: an invocation with no facets (all NULL) is
// claimable exactly as today. Everything here returns NULL when there is
// nothing honest to say, and `stampInvocationFacets` writes nothing at all in
// that case — the unfaceted enqueue IS today's enqueue, byte for byte.

/**
 * Privacy is a class, not a score (jobs-and-facets.md §2): a small enum with
 * checkable boundary meanings — may it leave the LAN, may it transit a paid
 * API, may the prompt be logged — where invalid reasoning ("average privacy")
 * is unrepresentable. Ordered: open < internal < pinned.
 */
export type PrivacyClass = "open" | "internal" | "pinned";

const PRIVACY_ORDER: Record<PrivacyClass, number> = { open: 0, internal: 1, pinned: 2 };

export function isPrivacyClass(v: unknown): v is PrivacyClass {
  return v === "open" || v === "internal" || v === "pinned";
}

/**
 * THE FLOOR RULE. The effective privacy facet is the max of the stamp and
 * every implicated binding's floor (today one binding implicates an
 * invocation; T7 Jobs may implicate more — hence the array).
 *
 *   - stamp below a floor → the floor wins (a stamp can never lower)
 *   - stamp above every floor → the stamp wins (a stamp may raise)
 *   - no stamp, no floors → NULL: no facet at all, the DefaultCase
 *   - no stamp, a floor → the floor (config alone classifies the binding's work)
 *
 * Pure, so T2's gate and any future stamp site share one definition.
 */
export function composePrivacy(
  stamp: PrivacyClass | null,
  floors: ReadonlyArray<PrivacyClass | null | undefined>,
): PrivacyClass | null {
  let effective: PrivacyClass | null = stamp;
  for (const floor of floors) {
    if (floor === null || floor === undefined) continue;
    if (effective === null || PRIVACY_ORDER[floor] > PRIVACY_ORDER[effective]) {
      effective = floor;
    }
  }
  return effective;
}

/**
 * The binding's declared floor, out of `config_json.privacyFloor`.
 *
 * Junk-tolerant on purpose: config is operator-written TEXT, and a typo'd
 * floor must degrade to "no floor declared" (NULL), never throw on the
 * delivery path. (It cannot degrade the other way — a typo can only fail to
 * raise, never lower, because composePrivacy treats NULL as absence.)
 */
export function privacyFloorOf(configJson: string): PrivacyClass | null {
  try {
    const cfg = JSON.parse(configJson) as { privacyFloor?: unknown };
    return isPrivacyClass(cfg?.privacyFloor) ? cfg.privacyFloor : null;
  } catch {
    return null;
  }
}

/**
 * `requires_json` — derived capability REQUIREMENTS (capability, not model:
 * requirements constrain, the optimizer chooses; jobs-and-facets.md §2).
 */
export interface RequiresFacet {
  /** Context the work needs a claimant to hold, in tokens. */
  contextTokens?: number;
  /** The work includes an image the model may need to see. */
  vision?: true;
  /** Reserved: no mechanical signal for tool need exists at ingest today. */
  tools?: true;
}

/**
 * Mechanical capability derivation: "message is LONG" → context-length
 * requirement; "attachment is an image" → vision (jobs-and-facets.md §5,
 * "capabilities are also derived" — computed from the work itself, no model).
 *
 * The bytes→tokens heuristic: ~4 characters per token, the BPE average for
 * English prose. Measured over the PARSED body text, not the raw RFC 5322
 * bytes — raw size counts base64 attachment bloat the model never reads.
 * Whitespace-heavy or non-Latin text tokenizes denser than 4:1, so this can
 * OVERESTIMATE the requirement — the safe direction, because requires_json
 * gates FIT, not authority: an overestimate excludes a small model from work
 * it might have managed; an underestimate hands work to a model that will
 * truncate it.
 */
export const CHARS_PER_TOKEN = 4;

export function mechanicalRequires(opts: {
  bodyTextChars: number;
  attachmentTypes: readonly string[];
}): RequiresFacet | null {
  const requires: RequiresFacet = {};
  if (opts.bodyTextChars > 0) {
    requires.contextTokens = Math.ceil(opts.bodyTextChars / CHARS_PER_TOKEN);
  }
  if (opts.attachmentTypes.some((t) => t.toLowerCase().startsWith("image/"))) {
    requires.vision = true;
  }
  return Object.keys(requires).length > 0 ? requires : null;
}

/** What ingest stamps. effort_prior stays s12's mid-band LLM's (a later wave). */
export interface FacetStamp {
  dueAt: number | null;
  privacy: PrivacyClass | null;
  requires: RequiresFacet | null;
  /**
   * s12 1-A: stage 1's verdict on the sender — 'known' (in the recipient's
   * default book) or 'unknown' (a default book exists and the sender is not
   * in it). NULL when the account has no known-good set to classify against
   * (the DefaultCase — the stamp stays absent exactly as pre-s12). 'blocked'
   * never reaches this stamp: blocked mail is rejected before enqueue.
   */
  senderClass: "known" | "unknown" | null;
}

/**
 * Stamp the mechanical facets onto an already-enqueued invocation.
 *
 * A separate UPDATE after the (unchanged) enqueue INSERT, on purpose, twice
 * over:
 *
 *   1. DefaultCase stays byte-identical: the INSERT that creates the row is
 *      the same statement it was before s11, and when there is nothing to
 *      stamp no second statement runs at all.
 *   2. The facet migrations stay NON-blockers: on a shard that predates
 *      `invocation-due-at` / `invocation-facet-columns` this UPDATE throws,
 *      is swallowed here, and delivery proceeds with an unfaceted invocation
 *      — facets tighten, they never bounce mail.
 *
 * The claim race in the gap between INSERT and stamp is harmless by
 * construction in this wave (nothing reads facets at claim time), and stays
 * harmless under T2: a claim that beats the stamp simply saw the DefaultCase.
 */
export async function stampInvocationFacets(
  db: D1Database,
  accountId: string,
  invocationId: string,
  stamp: FacetStamp,
): Promise<void> {
  if (
    stamp.dueAt === null &&
    stamp.privacy === null &&
    stamp.requires === null &&
    stamp.senderClass === null
  ) {
    return;
  }
  try {
    await db
      .prepare(
        `UPDATE agent_invocations SET due_at = ?, privacy = ?, requires_json = ?, sender_class = ?
         WHERE account_id = ? AND id = ?`,
      )
      .bind(
        stamp.dueAt,
        stamp.privacy,
        stamp.requires !== null ? JSON.stringify(stamp.requires) : null,
        stamp.senderClass,
        accountId,
        invocationId,
      )
      .run();
  } catch (err) {
    console.error(
      `facet stamp skipped for ${invocationId} (shard likely predates the s11 facet migrations): ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}
