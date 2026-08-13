// The message slice the boundary cascade judges (s12). This is the ONE shape
// every engine in this package reads — the ingest/wiring layer builds it once
// from the parsed MIME and hands the same object to sieve and Bayes. Nothing
// here is a raw RFC 5322 message: it is the pre-digested, judgment-relevant
// projection, so the engines stay pure and never touch parsing.

/** The judged projection of an inbound message. All strings as-parsed;
 * the engines lowercase internally where matching demands it. */
export interface BoundaryMessage {
  /** Envelope/header From address, e.g. "alice@example.com". */
  from: string;
  /** The domain part of `from`, pre-split by the caller, e.g. "example.com". */
  fromDomain: string;
  subject: string;
  /** Decoded text body (text/plain part, or stripped HTML) — NOT raw MIME. */
  textBody: string;
  /** Selected headers, name → value. Name lookup in this package is
   * case-insensitive, so callers may use any casing. */
  headers: Record<string, string>;
  sizeBytes: number;
  hasAttachments: boolean;
}
