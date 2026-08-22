// Which offers belong beside which message.
//
// PURE. The margin (s36 V1 item 5) renders the SAME `ActionProposal` the
// queue lists — one record, one decision, one state. This module only decides
// which of them sit beside the message you have open.
//
// ## Why this needs no request of its own
//
// `ActionProposal/query` filters on `status` and nothing else — there is no
// "anchored to this email" filter, so the obvious design (ask per thread) is
// not available anyway. That turns out to be the better answer:
//
//   PENDING proposals are a small set. Fetch them ONCE, index them by the
//   message they are about, and every message you open afterwards costs zero
//   requests.
//
// Which is exactly what the margin needs. Eric: *"offers … may need to all be
// pre-fetched & cached in order to not seem slow."* A round trip to discover
// whether there is anything to decide puts the wait back precisely where the
// design removed it.
//
// ## The cache is PAINT-FIRST, never the source of truth
//
// A proposal is mutable in the way an Email is not: it moves to approved,
// declined or expired, possibly on another device or by expiry. And it cannot
// delta-sync — `ActionProposal/query` advertises `canCalculateChanges: false`.
// So this index is a snapshot with a shelf life. Render from it; verify on
// decide. `ActionProposal/set` refuses a non-pending row, so a stale approve
// gets a clear refusal rather than a second decision.

import type { ActionProposal } from "./types";

/** Offers grouped by the message they are about. */
export type AnchoredOffers = ReadonlyMap<string, readonly ActionProposal[]>;

/**
 * Index proposals by the object they are anchored to.
 *
 * Only PENDING ones are indexed. A decided proposal is history and belongs in
 * the queue's record, not beside a message as though it still wanted
 * something — the margin's whole claim is "this needs you", and a settled
 * offer sitting there makes that claim false.
 */
export function indexByAnchor(proposals: readonly ActionProposal[]): AnchoredOffers {
  const out = new Map<string, ActionProposal[]>();
  for (const p of proposals) {
    if (p.status !== "pending") continue;
    const id = p.subject?.objectId;
    if (typeof id !== "string" || id === "") continue;
    const list = out.get(id) ?? [];
    list.push(p);
    out.set(id, list);
  }
  return out;
}

/**
 * The offers for one thread — every message in it, in reading order.
 *
 * A thread is many messages and an offer anchors to ONE of them, so the margin
 * of a thread has to gather across its emails. De-duplicated by id because a
 * proposal anchored to a message that appears twice in a thread must not be
 * offered twice; the reader would decide it once and watch the other stay.
 */
export function offersForThread(index: AnchoredOffers, emailIds: readonly string[]): ActionProposal[] {
  const seen = new Set<string>();
  const out: ActionProposal[] = [];
  for (const emailId of emailIds) {
    for (const p of index.get(emailId) ?? []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
  }
  return out;
}

/**
 * Drop an offer the reader has just decided, so it does not flash back on the
 * next paint from an index that has not caught up.
 *
 * The server already tombstones for re-OFFERING (s36 rung 3 keys its dupe
 * check on the moment, across every status). This is the same idea one layer
 * out: an answer already given is never shown as a question again, whichever
 * surface asked it.
 */
export function withoutOffer(index: AnchoredOffers, proposalId: string): AnchoredOffers {
  const out = new Map<string, readonly ActionProposal[]>();
  for (const [anchor, list] of index) {
    const kept = list.filter((p) => p.id !== proposalId);
    if (kept.length > 0) out.set(anchor, kept);
  }
  return out;
}
