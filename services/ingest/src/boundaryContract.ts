// s12-B contract: the pure-engine surface of `@bullmoose/boundary`.
//
// A PARALLEL wave (s12 1-B) is building the real engines — sieve rules, the
// per-account Bayes filter, the graduation policy — as a package. This file
// is the CONTRACT the cascade in boundary.ts is wired against: the exported
// names and signatures here are exactly the package's exports, and every
// implementation below is a deliberate PASS-THROUGH stub (sieve always
// passes, Bayes always scores clean, nothing graduates), so the wired stages
// 3–4 are no-ops until the package lands. When it does, this file's stubs
// are replaced by `export { ... } from "@bullmoose/boundary"` and nothing in
// boundary.ts moves.
//
// BoundaryMessage is defined HERE (wave 1-A owns it): it is what ingest can
// honestly hand a pure engine — envelope + parsed header/text material, no
// D1, no R2 handle. Both waves and the next build against this shape.

/** What a cascade stage sees of one inbound message. Pure data. */
export interface BoundaryMessage {
  /** Envelope MAIL FROM, normalized (trimmed, lowercased); "" for the null sender. */
  sender: string;
  /** Domain of `sender`, normalized (lowercase, no leading/trailing dot); "" if none. */
  senderDomain: string;
  /** Envelope RCPT TO, lowercased. Keeps any plus-tag (route lookup strips it). */
  recipient: string;
  subject: string;
  /**
   * The text/plain body, or the HTML part stripped to words — the same text
   * the FTS index gets (`bodyTextOf` in index.ts).
   */
  text: string;
  /** RFC 5322 headers in document order (topmost first), keys lowercased. */
  headers: Array<{ key: string; value: string }>;
  /** Raw RFC 5322 size in bytes. */
  size: number;
  hasAttachment: boolean;
}

// s12-B contract: rule shape is 1-B's to finalize; `id` is the one field the
// cascade depends on (REJECT reasons are recorded as `sieve:<ruleId>`).
export interface SieveRule {
  id: string;
  [key: string]: unknown;
}

// s12-B contract: opaque to the cascade — trained per account, fed by
// quarantine rescues as labeled corrections. `null` at the call site means
// "no trained state stored", and stage 4 skips entirely.
export interface BayesState {
  [key: string]: unknown;
}

// s12-B contract: thresholds/windows are 1-B's to define.
export interface GraduationPolicy {
  [key: string]: unknown;
}

// s12-B contract: first FAILing rule wins; PASS when no rule fires.
export function sieveVerdict(
  rules: SieveRule[],
  msg: BoundaryMessage,
): { verdict: "PASS" | "FAIL"; ruleId?: string } {
  void rules;
  void msg;
  return { verdict: "PASS" }; // stub: no rule engine yet — every message passes
}

// s12-B contract: spam probability in [0,1]; the cascade applies the two
// thresholds (T_reject / T_clean), never this function.
export function bayesClassify(state: BayesState, msg: BoundaryMessage): { score: number } {
  void state;
  void msg;
  return { score: 0 }; // stub: no classifier yet — everything scores clean
}

// s12-B contract: which domains have earned graduation into the industrial
// deny list (N expensive-stage rejects, no rescues). Returns domains.
export function graduationDue(
  counts: Array<{ domain: string; rejects: number; rescues: number }>,
  policy: GraduationPolicy,
): string[] {
  void counts;
  void policy;
  return []; // stub: no graduation policy yet — nothing graduates
}
