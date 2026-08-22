// The receipt, assembled — every derivation the surface renders, as tested
// functions. `ReceiptView.tsx` is markup over this and decides nothing, the
// same split `lib/agents/dossier.ts` holds for the agents realm and
// `lib/activity/feed.ts` for the record.
//
// ## The joins, and why they are the ones they are
//
// A binding is the unit, because a binding is what has a budget. Three
// different keys reach it, and none of them is `binding_id`:
//
//   invocations  → `bindingId`     (the console projects it)
//   proposals    → `agent`         (the binding NAME, projected from the
//                                   invocation by `proposalToJmap`)
//   annotations  → `author`        (the binding NAME, written by extract.ts)
//
// So the produced work joins on `(accountId, name)` and the runs join on
// `(accountId, bindingId)`. A rename between the write and this read leaves
// rows that match no binding, and those are collected into `unattributed`
// rather than dropped — see `Receipt.unattributed`.

import { agentRowId, economicsView, ledgerFor } from "../agents/dossier";
import type { Annotation } from "../annotations/types";
import type { ActionProposal } from "../approvals/types";
import type { AgentDossier, ConsoleInvocation } from "../console/types";
import { EMPTY_MONEY, sumMoney, totalCost } from "./money";
import { classifyInvocation } from "./outcomes";
import {
  CONSOLE_INVOCATION_CAP,
  RUNG_ORDER,
  type BindingReceipt,
  type ClassCount,
  type DeclineMetric,
  type InvocationMix,
  type LedgerTotals,
  type ProducedView,
  type Receipt,
  type ReceiptWindow,
  type RungCounts,
  type UnavailableMetric,
} from "./types";

// ── the named absences ─────────────────────────────────────────────────────

/**
 * s36's FIRST named metric, and it cannot be computed. Worth stating precisely,
 * because the gap is on the write side only and that is a much smaller thing to
 * fix than "we have no telemetry".
 *
 * The plan's design: where the extractor found a date but did not claim it, the
 * margin offers `+ Cal`, and pressing it *"is a labelled negative, recorded
 * exactly the way `Not a real one` already is for annotations"* — because
 * *"manual-schedule rate IS the extractor's miss rate, measured on real mail"*.
 *
 * The READ is already here. `Annotation/get` projects `authorKind`, and
 * `Annotation/set` stamps `'human'` for a human caller, so a human-filed `event`
 * annotation is `authorKind === "human" && class === "event"` — data this
 * surface already loads. What does not exist is anything that WRITES one: the
 * margin's `+ Cal` affordance is s36 V1 item 5, built last on purpose.
 *
 * Rendering 0% today would therefore report a perfect extractor, which is the
 * single most misleading number this page could show.
 */
export const MANUAL_SCHEDULE_ABSENCE: UnavailableMetric = {
  name: "Manual scheduling rate",
  question: "How often did the reader schedule something the extractor missed? (s36: the miss rate, on real mail)",
  missing:
    "Nothing records a manual schedule. The margin's “+ Cal” fallback — the labelled negative this metric counts — " +
    "is s36 V1 item 5 and is deliberately built last, so no row exists to count.",
  wouldNeed:
    "No new read. A human-filed event annotation already arrives here as authorKind 'human' with class 'event'; " +
    "the moment “+ Cal” writes one through Annotation/set, this number computes from data the page already loads.",
};

/**
 * The sentence that must ride beside any outcome mix on a busy account. Not an
 * error and not a warning: the reachable read is capped, so the mix is a sample
 * of the newest runs and saying so is what keeps it usable.
 */
export const TRUNCATION_NOTE =
  `The reachable read serves at most ${CONSOLE_INVOCATION_CAP} invocations per account, newest first, and carries ` +
  `no time filter. This account hit that cap, so the outcome mix below is a SAMPLE of the most recent runs — not a ` +
  `count of the window. The queue totals beside it are the server's own aggregate and are complete.`;

// ── counting ───────────────────────────────────────────────────────────────

const emptyRungs = (): RungCounts => ({ skipped: 0, screened: 0, ran: 0, failed: 0, inflight: 0 });

/**
 * The outcome mix over one binding's visible invocations.
 *
 * `truncated` is an ACCOUNT-level fact pushed down: the console's cap applies to
 * the account's whole list, so once it bites, every binding's slice of that list
 * may be short. Attributing it per binding would let a quiet binding on a busy
 * account claim a census it does not have.
 */
export function invocationMix(rows: readonly ConsoleInvocation[], truncated: boolean): InvocationMix {
  const counts = emptyRungs();
  let from: number | null = null;
  let to: number | null = null;
  for (const r of rows) {
    counts[classifyInvocation({ status: r.status, note: r.note })] += 1;
    if (from === null || r.createdAt < from) from = r.createdAt;
    if (to === null || r.createdAt > to) to = r.createdAt;
  }
  return { counts, sampled: rows.length, truncated, from, to };
}

/** Descending by count, then alphabetical — a stable order across reloads. */
function tally(values: readonly string[]): ClassCount[] {
  const by = new Map<string, number>();
  for (const v of values) by.set(v, (by.get(v) ?? 0) + 1);
  return [...by.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function producedView(annotations: readonly Annotation[], proposals: readonly ActionProposal[]): ProducedView {
  return {
    annotations: tally(annotations.map((a) => a.class)),
    annotationTotal: annotations.length,
    dismissed: annotations.filter((a) => a.status === "dismissed").length,
    proposals: tally(proposals.map((p) => p.kind)),
    proposalTotal: proposals.length,
  };
}

export const EMPTY_PRODUCED: ProducedView = {
  annotations: [],
  annotationTotal: 0,
  dismissed: 0,
  proposals: [],
  proposalTotal: 0,
};

function ledgerTotals(dossier: AgentDossier, bindingId: string): LedgerTotals {
  const l = ledgerFor(dossier, bindingId);
  // Absence means all-zero, not unknown — the server omits the row for a
  // binding that has never been invoked (console.ts `readLedgers`).
  return { pending: l?.pending ?? 0, running: l?.running ?? 0, done: l?.done ?? 0, failed: l?.failed ?? 0 };
}

// ── the s36 metrics ────────────────────────────────────────────────────────

/**
 * The `unintendedInvocation` rate. The denominator is proposals that a HUMAN
 * decided — `decision` is written by the decide path and stays null for the
 * agent worker's expiry sweep, so an expired row is correctly not a decision
 * somebody made.
 *
 * `rate: null` on an empty denominator; see `DeclineMetric`.
 */
export function declineMetric(proposals: readonly ActionProposal[]): DeclineMetric {
  const decided = proposals.filter((p) => p.decision !== null);
  const unintended = decided.filter((p) => p.decision?.reason === "unintendedInvocation").length;
  return {
    decided: decided.length,
    unintended,
    rate: decided.length === 0 ? null : (unintended / decided.length) * 100,
  };
}

// ── assembly ───────────────────────────────────────────────────────────────

export interface ReceiptInput {
  dossiers: readonly AgentDossier[];
  proposals: readonly ActionProposal[];
  annotations: readonly Annotation[];
  window: ReceiptWindow;
  /** accountIds whose produced-work read failed (`loadReceipt`'s
   *  `producedFailures`). Their bindings render `producedComplete: false`. */
  producedFailures?: Readonly<Record<string, string>>;
}

/** `(accountId, bindingName)` — the join key for everything an agent PRODUCED. */
const authorKey = (accountId: string, name: string): string => `${accountId}\u0000${name}`;

export function buildReceipt(input: ReceiptInput): Receipt {
  const { since } = input.window;

  // ⚠️ `createdAt` is a NUMBER on an annotation and an ISO STRING on a proposal
  // — the two read models genuinely differ (annotations/types.ts says so). A
  // proposal whose timestamp will not parse is KEPT: dropping a row because its
  // clock is odd would quietly shrink every number on the page.
  const proposals = input.proposals.filter((p) => {
    const at = Date.parse(p.createdAt);
    return !Number.isFinite(at) || at >= since;
  });
  const annotations = input.annotations.filter((a) => a.createdAt === 0 || a.createdAt >= since);

  const byAuthorAnnotations = new Map<string, Annotation[]>();
  for (const a of annotations) push(byAuthorAnnotations, authorKey(a.accountId, a.author), a);
  const byAuthorProposals = new Map<string, ActionProposal[]>();
  for (const p of proposals) push(byAuthorProposals, authorKey(p.accountId, p.agent), p);

  const claimed = new Set<string>();
  const bindings: BindingReceipt[] = [];

  for (const dossier of input.dossiers) {
    const truncated = dossier.invocations.length >= CONSOLE_INVOCATION_CAP;
    for (const binding of dossier.bindings) {
      const key = authorKey(dossier.accountId, binding.name);
      claimed.add(key);
      const rows = dossier.invocations.filter((i) => i.bindingId === binding.bindingId && i.createdAt >= since);
      bindings.push({
        id: agentRowId(dossier.accountId, binding.bindingId),
        accountId: dossier.accountId,
        bindingId: binding.bindingId,
        name: binding.name,
        principal: dossier.principal,
        pipeline: binding.config.pipeline ?? "reply",
        enabled: binding.enabled,
        mix: invocationMix(rows, truncated),
        ledger: ledgerTotals(dossier, binding.bindingId),
        produced: producedView(byAuthorAnnotations.get(key) ?? [], byAuthorProposals.get(key) ?? []),
        producedComplete: input.producedFailures?.[dossier.accountId] === undefined,
        windowCost: totalCost(rows.map((r) => r.costMicros)),
        economics: economicsView(binding, ledgerFor(dossier, binding.bindingId)),
      });
    }
  }

  // Owned accounts first, then by binding name — the agents realm's order, so
  // moving between the two surfaces does not reshuffle the same list.
  bindings.sort((a, b) => a.principal.localeCompare(b.principal) || a.name.localeCompare(b.name));

  const orphanAnnotations = annotations.filter((a) => !claimed.has(authorKey(a.accountId, a.author)));
  const orphanProposals = proposals.filter((p) => !claimed.has(authorKey(p.accountId, p.agent)));

  return {
    window: input.window,
    bindings,
    unattributed: producedView(orphanAnnotations, orphanProposals),
    declines: declineMetric(proposals),
    totalCost: bindings.length === 0 ? { ...EMPTY_MONEY } : sumMoney(bindings.map((b) => b.windowCost)),
    absent: [MANUAL_SCHEDULE_ABSENCE],
  };
}

/** Every rung with a nonzero count, in ladder order — what the mix renders. */
export function mixRows(mix: InvocationMix): Array<{ rung: (typeof RUNG_ORDER)[number]; count: number }> {
  return RUNG_ORDER.filter((r) => mix.counts[r] > 0).map((rung) => ({ rung, count: mix.counts[rung] }));
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
