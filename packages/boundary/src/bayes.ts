// Cascade stage 4 — the Bayes filter with TWO thresholds (s12 readme,
// commitment 1.4): score ≥ T_reject → REJECT, ≤ T_clean → CONTINUE-as-clean,
// between → the MID-BAND that escalates to the model. One threshold makes a
// binary gate; two make a cascade. Trained per-account; quarantine RESCUES
// are its labeled corrections (a rescue → bayesTrain(state, msg, "ham")),
// and a forwarded "this is spam" directive → bayesTrain(state, msg, "spam")
// — the escape hatch feeds the filter.
//
// Everything here is pure and deterministic: no clocks, no randomness, state
// in/state out. `BayesState` is plain JSON — it round-trips through
// JSON.stringify unchanged, so the wiring layer can persist it wherever it
// likes (D1 TEXT, KV, a config row) without this package knowing.
//
// ── The model ──────────────────────────────────────────────────────────────
// Bernoulli-flavored naive Bayes over the UNIQUE tokens of a message
// (presence, not multiplicity — repeating "viagra" 500 times must not buy
// 500 votes). Laplace (+1) smoothing on every token probability AND on the
// class prior, so an empty or hapax-heavy state never divides by zero or
// takes log(0). All accumulation happens in LOG space as a running log-odds,
// squashed once at the end through a numerically stable sigmoid — a
// 10k-token message drives the odds to ±∞ gracefully (score saturates to
// exactly 0 or 1) instead of underflowing to NaN.

import type { BoundaryMessage } from "./message.js";

/** Per-token evidence: how many spam (`s`) / ham (`h`) TRAINING MESSAGES
 * contained the token (unique-per-message, so s ≤ spamCount always). */
export interface TokenCounts {
  s: number;
  h: number;
}

/** The whole filter state — plain JSON-serializable counts, nothing else. */
export interface BayesState {
  /** Messages trained as spam. */
  spamCount: number;
  /** Messages trained as ham. */
  hamCount: number;
  tokens: Record<string, TokenCounts>;
}

/** A fresh, untrained state. Classifies everything at exactly 0.5 → MID_BAND
 * (the honest answer when the filter knows nothing). */
export function emptyBayesState(): BayesState {
  return { spamCount: 0, hamCount: 0, tokens: {} };
}

/**
 * The two thresholds of commitment 1.4. REJECT is checked first, so a
 * degenerate config with reject ≤ clean still yields a deterministic answer.
 * Both comparisons are INCLUSIVE, per the spec's "≥ T_reject" / "≤ T_clean".
 */
export const DEFAULT_THRESHOLDS = { reject: 0.98, clean: 0.2 } as const;

/** Vocab cap — see `prunedTokens` for the deterministic eviction rule. */
export const VOCAB_CAP = 50_000;

// ── Tokenizer ──────────────────────────────────────────────────────────────
// Lowercase word tokens plus domain-shaped tokens: the pattern keeps dotted/
// hyphenated runs whole, so "mail.spam-farm.biz" is ONE token (domains are
// exactly the evidence the graduation loop later aggregates on). Tokens are
// field-prefixed (`subj:`, `hdr:<name>:`) so "free" in a subject and "free"
// in a body are separate evidence — the classic SpamBayes move. The From
// address and domain are always tokenized (`from:`/`domain:`), giving the
// filter a per-sender memory on top of per-word.

/** Headers (lowercase) whose values are tokenized. Deliberately small: these
 * carry sender-infrastructure signal without dragging in Received noise. */
export const BAYES_HEADERS = ["list-id", "reply-to", "x-mailer"] as const;

const TOKEN_RE = /[a-z0-9]+(?:[.\-'][a-z0-9]+)*/g;
const MIN_TOKEN = 2;
const MAX_TOKEN = 40;

function words(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) {
    const w = m[0];
    if (w.length >= MIN_TOKEN && w.length <= MAX_TOKEN) out.push(w);
  }
  return out;
}

/** Case-insensitive header lookup (first insertion-order match wins). */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return headers[key];
  }
  return undefined;
}

/** The unique token set of a message — the ONE tokenization both train and
 * classify use (they must agree or training evidence never fires). */
export function bayesTokens(msg: BoundaryMessage): Set<string> {
  const toks = new Set<string>();
  const from = msg.from.toLowerCase();
  const domain = msg.fromDomain.toLowerCase();
  if (from) toks.add(`from:${from}`);
  if (domain) toks.add(`domain:${domain}`);
  for (const w of words(msg.subject)) toks.add(`subj:${w}`);
  for (const w of words(msg.textBody)) toks.add(w);
  for (const name of BAYES_HEADERS) {
    const v = headerValue(msg.headers, name);
    if (v !== undefined) for (const w of words(v)) toks.add(`hdr:${name}:${w}`);
  }
  return toks;
}

// ── Classify ───────────────────────────────────────────────────────────────

/**
 * Spam probability in [0, 1]. Running log-odds:
 *
 *   logOdds = ln((spamCount+1)/(hamCount+1))                      — prior
 *           + Σ_t [ ln((s_t+1)/(spamCount+2)) − ln((h_t+1)/(hamCount+2)) ]
 *
 * over the message's UNIQUE tokens t (unseen tokens contribute a small,
 * finite nudge — Laplace keeps every log argument > 0). Squash:
 * score = 1/(1+e^−logOdds); e^±∞ saturates to 0/1, never NaN.
 */
export function bayesClassify(state: BayesState, msg: BoundaryMessage): { score: number } {
  const spamN = state.spamCount;
  const hamN = state.hamCount;
  let logOdds = Math.log((spamN + 1) / (hamN + 1));
  for (const tok of bayesTokens(msg)) {
    const c = state.tokens[tok];
    const s = c === undefined ? 0 : c.s;
    const h = c === undefined ? 0 : c.h;
    logOdds += Math.log((s + 1) / (spamN + 2)) - Math.log((h + 1) / (hamN + 2));
  }
  return { score: 1 / (1 + Math.exp(-logOdds)) };
}

/**
 * The two-threshold verdict (commitment 1.4). Inclusive on both boundaries;
 * REJECT is evaluated first. The MID_BAND result IS the escalation channel —
 * it is not an error, it is the cascade asking for the model's judgment.
 */
export function bayesVerdict(
  score: number,
  t: { reject: number; clean: number },
): "REJECT" | "CONTINUE_CLEAN" | "MID_BAND" {
  if (score >= t.reject) return "REJECT";
  if (score <= t.clean) return "CONTINUE_CLEAN";
  return "MID_BAND";
}

// ── Train ──────────────────────────────────────────────────────────────────

/**
 * Fold one labeled message into the state. PURE: returns a NEW state; the
 * input is never mutated (untouched token entries are structurally shared —
 * treat states as immutable values). Each unique token of the message adds
 * exactly 1 to its class count. If the vocabulary exceeds VOCAB_CAP after
 * the fold, it is pruned (see `prunedTokens`).
 */
export function bayesTrain(
  state: BayesState,
  msg: BoundaryMessage,
  label: "spam" | "ham",
): BayesState {
  const tokens: Record<string, TokenCounts> = { ...state.tokens };
  for (const tok of bayesTokens(msg)) {
    const prev = tokens[tok] ?? { s: 0, h: 0 };
    tokens[tok] =
      label === "spam" ? { s: prev.s + 1, h: prev.h } : { s: prev.s, h: prev.h + 1 };
  }
  return {
    spamCount: state.spamCount + (label === "spam" ? 1 : 0),
    hamCount: state.hamCount + (label === "ham" ? 1 : 0),
    tokens: Object.keys(tokens).length > VOCAB_CAP ? prunedTokens(tokens, VOCAB_CAP) : tokens,
  };
}

/**
 * Deterministic vocab prune — the "LRU-ish" cap, approximated by FREQUENCY
 * because the state shape carries no recency: evict lowest total count
 * (s + h) first; among equals, evict the lexicographically SMALLER token
 * first (arbitrary but fixed — same input map, same survivors, always).
 * Hapaxes (total = 1) — typically Base64 shrapnel and one-off tracking ids —
 * are exactly what goes first; repeated discriminative tokens are never at
 * risk while any hapax remains. Kept entries are returned in sorted-key
 * order, so a pruned state has one canonical serialization.
 */
export function prunedTokens(
  tokens: Record<string, TokenCounts>,
  cap: number,
): Record<string, TokenCounts> {
  const entries = Object.entries(tokens);
  if (entries.length <= cap) return tokens;
  entries.sort((a, b) => {
    const byCount = a[1].s + a[1].h - (b[1].s + b[1].h);
    if (byCount !== 0) return byCount;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  const keep = entries.slice(entries.length - cap);
  keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return Object.fromEntries(keep);
}
