// The receipt's shapes (s36) — "what has the agent been doing, and what did it
// cost?", answered without anyone running `wrangler d1 execute`.
//
// s36's readme says *"do not estimate it — MEASURE it"* four different ways,
// and `invocationCost` has been stamping real per-invocation cost against a
// binding's budget since s07 T5. Nothing read it back for a human. That is the
// only thing this realm exists to fix: it invents no number, derives nothing
// the server did not serve, and where the data to answer a question is not
// reachable it says so BY NAME (`UnavailableMetric`) rather than rendering a
// zero that reads like an answer.
//
// ⚠️ THE MONEY RULE, which this repo enforces everywhere and which is easiest
// to break in an aggregate: `cost_micros` NULL ≠ 0. NULL means "not recorded"
// (unpriceable model, no reported usage, a pre-migration row); 0 means "known
// and genuinely free" — a Workers AI call inside the free allocation really did
// cost nothing. Summing a column of NULLs into `$0.00` turns "we do not know"
// into "it was free", which is the most flattering possible lie about a feature
// whose whole pitch is that it is cheap. `money.ts` keeps the two apart by
// construction: a NULL cannot reach the sum, only the `unrecorded` count.

import type { EconomicsView } from "../agents/dossier";

// ── the window ─────────────────────────────────────────────────────────────

/**
 * How far back the receipt looks. Deliberately two coarse choices and not a
 * date picker: this surface is read to form a JUDGEMENT ("is the extractor any
 * good yet?"), and a judgement wants a comparable window, not an arbitrary one.
 */
export const RECEIPT_WINDOWS = [
  { id: "7d", label: "last 7 days", days: 7 },
  { id: "30d", label: "last 30 days", days: 30 },
] as const;

export type ReceiptWindowId = (typeof RECEIPT_WINDOWS)[number]["id"];

export const DEFAULT_WINDOW: ReceiptWindowId = "7d";

export interface ReceiptWindow {
  id: ReceiptWindowId;
  label: string;
  /** epoch ms; rows older than this are out of the window. */
  since: number;
}

export function receiptWindow(id: ReceiptWindowId, now: number): ReceiptWindow {
  const spec = RECEIPT_WINDOWS.find((w) => w.id === id) ?? RECEIPT_WINDOWS[0];
  return { id: spec.id, label: spec.label, since: now - spec.days * 24 * 60 * 60 * 1000 };
}

// ── the ladder ─────────────────────────────────────────────────────────────

/**
 * s36's rungs, as an invocation's OUTCOME. The mix between these IS the
 * ladder's economics made visible — *"rung 1 is free, rung 2 is small, and only
 * what survives deserves a better model"* — so a receipt that showed only
 * "ran / failed" would hide the entire argument for the design.
 *
 *   skipped   the deterministic pre-filter ended it. NO model call, no money.
 *   screened  a free scout model ended it before the paid one ran (s26 T3 v2).
 *             A model DID run, so this is not a skip; it cost 0, not NULL.
 *   ran       the pipeline's real model call happened.
 *   failed    the run errored.
 *   inflight  pending or running — counted, never scored.
 */
export type LadderRung = "skipped" | "screened" | "ran" | "failed" | "inflight";

/** Render order — cheapest rung first, so the eye reads the ladder upward. */
export const RUNG_ORDER: readonly LadderRung[] = ["skipped", "screened", "ran", "failed", "inflight"] as const;

export type RungCounts = Record<LadderRung, number>;

/**
 * The outcome mix over the invocations we could actually see.
 *
 * ⚠️ `sampled` is not "how many ran" — it is how many rows the reachable read
 * served. The console caps its invocation list (`CONSOLE_INVOCATION_CAP`), so
 * on a busy account this is a SAMPLE of the newest rows and `truncated` says
 * so. `LedgerTotals` beside it carries the real (all-time, un-windowed) counts
 * the server aggregated itself. Presenting a sample as a census is the exact
 * failure this surface exists to end, so the two never share a number.
 */
export interface InvocationMix {
  counts: RungCounts;
  sampled: number;
  truncated: boolean;
  /** epoch ms of the oldest / newest sampled row; null when nothing sampled. */
  from: number | null;
  to: number | null;
}

/**
 * ⚠️ MIRRORS `INVOCATION_LIMIT` in `services/jmap/src/console.ts`. It is not on
 * the wire — the payload is a bare array — so "did the server truncate?" can
 * only be inferred from the length, and inferring it needs the number. If the
 * server's limit rises, this under-reports truncation (says census, served a
 * sample); it never over-reports it.
 */
export const CONSOLE_INVOCATION_CAP = 25;

/** The server's own queue aggregate: all-time, every binding row, un-windowed. */
export interface LedgerTotals {
  pending: number;
  running: number;
  done: number;
  failed: number;
}

// ── what was produced ──────────────────────────────────────────────────────

export interface ClassCount {
  label: string;
  count: number;
}

/**
 * The output side of the ledger: annotations by class, proposals by kind. Both
 * come from the JMAP read models rather than being parsed out of an invocation
 * note — the note is prose the pipeline writes for a human, and counting from
 * prose is how a metric quietly becomes fiction.
 */
export interface ProducedView {
  /** By class, descending by count then label. */
  annotations: ClassCount[];
  annotationTotal: number;
  /** "Not a real one" — the labelled negative the extractor trains on. */
  dismissed: number;
  /** By kind, descending by count then label. */
  proposals: ClassCount[];
  proposalTotal: number;
}

// ── one binding's receipt ──────────────────────────────────────────────────

export interface BindingReceipt {
  /** `accountId/bindingId`, the same row id shape the agents realm uses. */
  id: string;
  accountId: string;
  bindingId: string;
  /** The binding's name — what an annotation's `author` and a proposal's
   *  `agent` both carry, and therefore the join key for everything produced. */
  name: string;
  /** The account's address — whose mail this binding reads. */
  principal: string;
  pipeline: string;
  enabled: boolean;
  mix: InvocationMix;
  ledger: LedgerTotals;
  produced: ProducedView;
  /**
   * False when this account's `ActionProposal` / `Annotation` reads failed, so
   * `produced` is an empty shape rather than a measurement. The distinction is
   * the whole point: "the agent produced nothing" and "we could not ask" look
   * identical in a count, and only one of them is a fact about the agent.
   */
  producedComplete: boolean;
  /** Cost of the SAMPLED invocations only — see `InvocationMix`. */
  windowCost: MoneyTotal;
  /**
   * Cap vs month spend, in the claim gate's own arithmetic. Reused from the
   * agents realm rather than re-derived: two surfaces disagreeing about when a
   * binding runs out of money would be worse than one of them being absent.
   */
  economics: EconomicsView;
}

// ── money ──────────────────────────────────────────────────────────────────

/**
 * An aggregate of `cost_micros` values that REFUSES to collapse NULL into 0.
 *
 * `micros` sums only what was recorded. `unrecorded` counts what was not, and
 * is carried all the way to the label so a reader is never shown a total that
 * silently excludes rows. `free` is the honest zero — runs that genuinely cost
 * nothing, which on a Workers AI menu is most of them and is the point.
 */
export interface MoneyTotal {
  micros: number;
  /** Rows carrying a recorded cost — 0 counts, because free is an answer. */
  recorded: number;
  /** Rows carrying no cost at all. Never folded into `micros`. */
  unrecorded: number;
  /** Of `recorded`, how many were exactly 0. */
  free: number;
}

// ── named absences ─────────────────────────────────────────────────────────

/**
 * A metric this surface CANNOT compute, rendered as itself.
 *
 * The alternative — showing 0%, or omitting the row — is how a gap becomes
 * invisible and then becomes permanent. s36 names two metrics as the ones that
 * matter; exactly one of them is computable today, and the honest rendering of
 * the other is a sentence saying what is missing and what would fix it.
 */
export interface UnavailableMetric {
  name: string;
  /** The question it would answer. */
  question: string;
  /** What does not exist yet. */
  missing: string;
  /** What would have to be built. */
  wouldNeed: string;
}

/**
 * The `unintendedInvocation` rate — s36's second named metric, and the one that
 * IS computable: `decline-taxonomy.md` calls a rising rate *"a UI defect
 * report"*, because that reason is the only one that steers the agent nothing.
 * It says the human mis-clicked.
 *
 * `rate` is null when nothing was decided in the window. That is not 0% —
 * "nobody decided anything" and "nobody mis-clicked" are different facts, and a
 * defect metric that reads 0% on an empty window is a false all-clear.
 */
export interface DeclineMetric {
  /** Proposals in the window carrying a recorded decision. */
  decided: number;
  unintended: number;
  /** 0–100, or null when `decided` is 0. */
  rate: number | null;
}

export interface Receipt {
  window: ReceiptWindow;
  bindings: BindingReceipt[];
  /** Work whose author matches no binding on any dossier — a renamed binding,
   *  a human-filed annotation, a deleted agent. Shown rather than dropped: a
   *  ledger that silently discards rows is not a ledger. */
  unattributed: ProducedView;
  declines: DeclineMetric;
  /** Cost across every binding on the receipt, same NULL-vs-0 discipline. */
  totalCost: MoneyTotal;
  absent: UnavailableMetric[];
}
