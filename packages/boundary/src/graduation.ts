// The graduation loop (s12 readme, commitment 1, "the cascade optimizes its
// own cost"): a domain repeatedly rejected by the EXPENSIVE stages (sieve /
// Bayes), with no rescues, graduates DOWNWARD into the industrial denylist —
// its future mail then costs nanoseconds (stage-1 bloom + exact check)
// instead of Bayes compute. Repetition → policy, applied to spam.
//
// This module is the pure POLICY only. Inputs are the per-domain daily
// counter rows the industrial tier keeps (counters, never per-message chain
// rows — an attacker must not make us pay D1 writes per spam); output is the
// list of domains due for the deny-list. The wiring layer owns aggregation,
// the write, and the evidence record ("graduated: 20×bayes@0.99, 0 rescues").
//
// ── demotionOn(rescue) — the inverse, DOCUMENTED here, WRITTEN elsewhere ──
// A quarantine rescue of a graduated domain is the human correction, and the
// human correction always wins (readme: false-positive conversation 2). The
// wiring layer implements, atomically with the rescue:
//   1. REMOVE the domain from the industrial denylist (which invalidates /
//      rebuilds the stage-1 bloom — the bloom is a derived index);
//   2. RESET the domain's reject/rescue counters to zero — graduation must
//      re-earn ALL of minRejects from scratch, not resume at N−1, otherwise
//      one more stray spam re-graduates a domain a human just vouched for;
//   3. RECORD the demotion with the rescue's provenance (chained, citing the
//      rescuing directive/message-id).
// Because counters reset, a demoted domain also stops satisfying
// `graduationDue` immediately — policy and write agree by construction.

/** Graduation thresholds. A domain is due when BOTH hold:
 *  rejects ≥ minRejects  AND  rescues ≤ maxRescues. */
export interface GraduationPolicy {
  /** Minimum expensive-stage rejects before graduation. */
  minRejects: number;
  /** Maximum rescues tolerated — any rescue beyond this blocks graduation
   * (default 0: ONE rescue means a human wanted something from there). */
  maxRescues: number;
}

export const DEFAULT_GRADUATION_POLICY: GraduationPolicy = {
  minRejects: 10,
  maxRescues: 0,
};

/**
 * Which domains are due for the industrial denylist. Pure over counter rows;
 * deterministic output order = first-qualifying appearance in the input
 * (rows are expected one-per-domain; defensive dedupe keeps the first).
 * Empty input → empty output, trivially.
 */
export function graduationDue(
  counts: Array<{ domain: string; rejects: number; rescues: number }>,
  policy: GraduationPolicy,
): string[] {
  const due: string[] = [];
  const seen = new Set<string>();
  for (const row of counts) {
    if (seen.has(row.domain)) continue;
    if (row.rejects >= policy.minRejects && row.rescues <= policy.maxRescues) {
      seen.add(row.domain);
      due.push(row.domain);
    }
  }
  return due;
}
