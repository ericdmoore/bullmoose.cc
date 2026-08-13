/**
 * Book governance (s10 T1/T2) — the pure half of the contact-write chokepoint.
 *
 * A governed address book IS an agent's outbound send authority ("the bound is
 * an address book", .plans/s10-agents/readme.md), so writing a contact grants
 * send reach. Everything here is decision logic over plain values: the policy
 * gate, the address-contribution model, and the fold-reconciliation invariant.
 * The I/O half (reading policies, emitting chain rows in the same db.batch as
 * the card write) lives on the Mailstore class, which is the ONE place every
 * write path — JMAP, CardDAV, MCP, CLI — funnels through.
 */

import type { JSContactCard } from "./index";

/**
 * Per-book write policy (address_books.write_policy):
 *   open      direct writes under ordinary grants — today's behavior.
 *   propose   humans write directly; AGENT writes are refused with a typed
 *             error telling them to file a proposal.
 *   governed  the outbound bound: agent writes refused unless authorized by
 *             an approved proposal; humans write through (devPlan decision 4).
 */
export type BookWritePolicy = "open" | "propose" | "governed";

/**
 * Who is performing a contact-card write — the chokepoint's required input.
 * Same shape the callers already thread as `WriteProvenance`, plus the
 * human/agent discriminator the policy gate turns on and the T3 authorization.
 */
export interface ContactWriter {
  /** Acting login email — mirrors `WriteProvenance.principal` / grant_audit. */
  principal: string;
  /**
   * 'agent' when an agent drove the write: an agent-marked token (the "agent"
   * scope), the MCP tool surface, or agent provenance (`ctx.agent`) riding a
   * JMAP call. Policy enforcement turns on this; humans always write through.
   */
  kind: "human" | "agent";
  /** Binding/invocation attribution when known (provenance parity). */
  binding?: string | null;
  invocation?: string | null;
  /**
   * T3: the approved grant-request proposal authorizing a governed write.
   * The chokepoint accepts and RECORDS it (via_proposal_id on the chain row);
   * it verifies only non-emptiness here.
   * TODO(s10 T3): verify the proposal exists and is `approved` before
   * honouring it — T3's executor is the intended caller and passes its own id.
   */
  authorization?: { proposalId: string };
}

/** Why a write was refused at the chokepoint. */
export type BookWriteRefusalReason = "agent-requires-proposal" | "nested-group";

/**
 * The typed refusal the chokepoint throws. JMAP surfaces it as a `forbidden`
 * SetError, CardDAV as a 403 — the message is written for the refused agent:
 * it names the path that IS allowed (a proposal).
 */
export class BookWriteRefused extends Error {
  constructor(
    readonly policy: Exclude<BookWritePolicy, "open">,
    readonly bookId: string,
    readonly reason: BookWriteRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "BookWriteRefused";
  }
}

export const refusedDirectWrite = (
  policy: Exclude<BookWritePolicy, "open">,
  bookId: string,
): BookWriteRefused =>
  new BookWriteRefused(
    policy,
    bookId,
    "agent-requires-proposal",
    policy === "governed"
      ? `address book ${bookId} is governed (an agent's outbound bound): agents never write it directly — file a grant-request proposal for a human to approve`
      : `address book ${bookId} has write policy 'propose': agents do not write it directly — file a create-contact proposal for a human to approve`,
  );

export const refusedNestedGroup = (bookId: string, memberUid: string): BookWriteRefused =>
  new BookWriteRefused(
    "governed",
    bookId,
    "nested-group",
    `governed book ${bookId} refuses nested groups: member ${memberUid} is itself a group — adding one member to a nested group would silently widen an agent`,
  );

/**
 * Allowlist normalization: lowercase, trimmed, NOTHING else. Deliberately no
 * plus-tag folding (bob+x@ ≠ bob@), no LIKE, no substring — contact search may
 * scan loosely; an allowlist must not (devPlan T1 "fail-closed, exact-match").
 */
export function normalizeAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

/** The card's own email addresses (JSContact `emails` map), normalized. */
export function cardOwnEmails(card: JSContactCard): Set<string> {
  const out = new Set<string>();
  const emails = card.emails as Record<string, { address?: unknown }> | undefined;
  if (emails && typeof emails === "object") {
    for (const e of Object.values(emails)) {
      if (typeof e?.address === "string" && e.address.trim() !== "") {
        out.add(normalizeAddress(e.address));
      }
    }
  }
  return out;
}

/** Member uids of a JSContact group card (RFC 9553 `members`: uid → true). */
export function cardMemberUids(card: JSContactCard): string[] {
  if (card.kind !== "group") return [];
  const members = card.members as Record<string, unknown> | undefined;
  if (!members || typeof members !== "object") return [];
  return Object.keys(members);
}

/**
 * The addresses one card contributes to its book's effective membership:
 * its own emails, plus — for a group — its members' own emails, resolved by
 * uid, ONE level deep. A member that is itself a group contributes nothing
 * (fail-closed; the chokepoint refuses nesting into governed books anyway).
 */
export function cardContribution(
  card: JSContactCard,
  resolveUid: (uid: string) => JSContactCard | null,
): Set<string> {
  const out = cardOwnEmails(card);
  for (const uid of cardMemberUids(card)) {
    const member = resolveUid(uid);
    if (!member || member.kind === "group") continue;
    for (const a of cardOwnEmails(member)) out.add(a);
  }
  return out;
}

/** One chain event, as `reconcileBookMembership` folds it. */
export interface BookMembershipEvent {
  event: "added" | "removed";
  address: string;
}

/**
 * The fold-reconciliation invariant (s10 T2): replaying the chain must
 * reproduce the book's current effective membership.
 *
 * The fold COUNTS per address rather than toggling, because one address can be
 * contributed more than once (a card's own email and a group referencing it are
 * two contributions, each logged); membership is "count > 0".
 *
 *   missing  the chain says member, the book disagrees — an unlogged removal.
 *   extra    the book says member, the chain never added it — an unlogged
 *            write, i.e. a path that bypassed the chokepoint. The tamper case.
 *
 * Either is an alarm, not a log line: cheap enough to run in CI and on a
 * schedule.
 */
export function reconcileBookMembership(
  log: BookMembershipEvent[],
  currentMembers: Iterable<string>,
): { consistent: boolean; missing: string[]; extra: string[] } {
  const counts = new Map<string, number>();
  for (const row of log) {
    const a = normalizeAddress(row.address);
    counts.set(a, (counts.get(a) ?? 0) + (row.event === "added" ? 1 : -1));
  }
  const folded = new Set([...counts].filter(([, n]) => n > 0).map(([a]) => a));
  const current = new Set([...currentMembers].map(normalizeAddress));
  const missing = [...folded].filter((a) => !current.has(a)).sort();
  const extra = [...current].filter((a) => !folded.has(a)).sort();
  return { consistent: missing.length === 0 && extra.length === 0, missing, extra };
}

/** added/removed sets between two contributions — the chain delta of a write. */
export function contributionDelta(
  prev: ReadonlySet<string>,
  next: ReadonlySet<string>,
): { added: string[]; removed: string[] } {
  return {
    added: [...next].filter((a) => !prev.has(a)).sort(),
    removed: [...prev].filter((a) => !next.has(a)).sort(),
  };
}
