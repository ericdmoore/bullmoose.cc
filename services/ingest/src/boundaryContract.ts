// The seam between the cascade (this worker) and the pure engines
// (`@bullmoose/boundary`, s12 wave 1-B). Wave 1-A stubbed this file against a
// pinned contract; the package landed, so the stubs are gone and the engines
// are re-exported through ONE adapter.
//
// BoundaryMessage is defined HERE (ingest owns it): it is what this worker can
// honestly hand a pure engine — envelope + parsed header/text material, no D1,
// no R2 handle. The package's message shape differs deliberately (it has no
// envelope concept, and its headers are a flat Record); `toEngineMessage` is
// the single place the two shapes meet.

import {
  type SieveRule,
  type BayesState,
  type GraduationPolicy,
  type BoundaryMessage as EngineMessage,
  sieveVerdict as engineSieveVerdict,
  bayesClassify as engineBayesClassify,
  graduationDue,
} from "@bullmoose/boundary";

export { DEFAULT_GRADUATION_POLICY, DEFAULT_THRESHOLDS, bayesVerdict } from "@bullmoose/boundary";
export type { SieveRule, BayesState, GraduationPolicy };
export { graduationDue };

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

/**
 * Ingest shape → engine shape. Headers collapse to a Record with the TOPMOST
 * occurrence winning — the same trust order stage 2 applies to
 * Authentication-Results (RFC 8601: our edge prepends, forgeries sit below).
 */
export function toEngineMessage(msg: BoundaryMessage): EngineMessage {
  const headers: Record<string, string> = {};
  for (const { key, value } of msg.headers) {
    if (!(key in headers)) headers[key] = value;
  }
  return {
    from: msg.sender,
    fromDomain: msg.senderDomain,
    subject: msg.subject,
    textBody: msg.text,
    headers,
    sizeBytes: msg.size,
    hasAttachments: msg.hasAttachment,
  };
}

export function sieveVerdict(
  rules: SieveRule[],
  msg: BoundaryMessage,
): { verdict: "PASS" | "FAIL"; ruleId?: string } {
  return engineSieveVerdict(rules, toEngineMessage(msg));
}

export function bayesClassify(state: BayesState, msg: BoundaryMessage): { score: number } {
  return engineBayesClassify(state, toEngineMessage(msg));
}
