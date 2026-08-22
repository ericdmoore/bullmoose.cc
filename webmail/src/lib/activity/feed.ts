// Feed presentation rules (s23 v1): how the retrospective orders, groups and
// words itself. Pure and tested — the island stays markup-only, the same
// split as `../approvals/rows.ts`.
//
// Design stance carried from the sprint doc:
//   • anti-star — nothing here is filed, tagged or "marked reviewed"; the
//     feed is generated wholly from events already written.
//   • legibility over completeness — v1 renders the two sources that already
//     have JMAP surfaces (decided proposals, fired watches); the other audit
//     tables wait for their read models rather than being dumped as syslog.
//   • read-only — if a row needs attention it belongs in /approvals as a
//     proposal, not here as a chore.

import { hasAgentCapability } from "../jmap/capabilities";
import type { Session } from "../jmap/types";
import { formatDuration, waitedForMs } from "../approvals/clocks";
import { describeReason, summarizeProposal } from "../approvals/rows";
import type { CollectionGroup } from "../shell/collections";
import type { ActivityItem, DecidedItem, FiredWatch } from "./types";

// ── the gate ──────────────────────────────────────────────────────────────

export type ActivityGateState = "open" | "no-capability";

export interface ActivityGate {
  state: ActivityGateState;
  reason: string;
}

/**
 * The plain-client floor (arch.md §8.6), same shape as `approvalsGate` but
 * its own sentence — "no agent can act" and "nothing to approve" are
 * different claims, and this one is about the record, not the queue.
 */
export function activityGate(session: Pick<Session, "capabilities"> | undefined): ActivityGate {
  if (!session) return { state: "no-capability", reason: "no session yet" };
  if (!hasAgentCapability(session)) {
    return {
      state: "no-capability",
      reason:
        "This server does not advertise the bullmoose agent capability, so no agent can act " +
        "in your name and there is no activity to record. Mail, contacts and calendar are unaffected.",
    };
  }
  return { state: "open", reason: "agent capability advertised" };
}

// ── collections ───────────────────────────────────────────────────────────

/** v1 groups. By-agent / by-date pickers are v2 (s24's IA names them). */
export type ActivityCollectionId = "all" | "decided" | "watches";

export function filterFeed(items: readonly ActivityItem[], collection: string): ActivityItem[] {
  switch (collection) {
    case "decided":
      return items.filter((i) => i.type === "decided");
    case "watches":
      return items.filter((i) => i.type === "watch-fired");
    default:
      return [...items];
  }
}

/** The CollectionColumn's groups, with live counts. Counts of 0 still render
 *  the group — an empty history is an answer ("nothing fired"), not noise. */
export function activityCollections(items: readonly ActivityItem[]): CollectionGroup[] {
  const decided = items.filter((i) => i.type === "decided").length;
  const watches = items.length - decided;
  return [
    {
      id: "feed",
      label: "Activity",
      items: [
        { id: "all", label: "All activity", count: items.length },
        { id: "decided", label: "Decided", count: decided },
        { id: "watches", label: "Watches fired", count: watches },
      ],
    },
  ];
}

// ── ordering ──────────────────────────────────────────────────────────────

/**
 * Newest first — a retrospective reads backwards from now. Undated rows
 * (occurredAt 0) sink to the end rather than masquerading as ancient or
 * fresh; id breaks ties so the order is stable across reloads.
 */
export function orderFeed(items: readonly ActivityItem[]): ActivityItem[] {
  return [...items].sort((a, b) => b.occurredAt - a.occurredAt || a.id.localeCompare(b.id));
}

// ── wording ───────────────────────────────────────────────────────────────

/**
 * WHEN, relative — "3h ago". Undated is said plainly; a clock-skewed future
 * instant reads "just now" rather than a negative duration.
 */
export function agoLabel(occurredAt: number, now: number): string {
  if (!Number.isFinite(occurredAt) || occurredAt <= 0) return "undated";
  if (occurredAt > now) return "just now";
  return `${formatDuration(now - occurredAt)} ago`;
}

/**
 * The decision line: WHO decided and on what grounds — the `decision_json.by`
 * fact the whole s23 readme hangs on (*"did I approve this, or did CJ?"* is
 * answerable from data on disk; this renders the answer).
 *
 * Rejection reasons go through `describeReason`, never raw: a decision
 * recorded under a retired taxonomy renders as itself, marked retired —
 * history is read, not migrated.
 */
export function decisionLabel(item: DecidedItem): string {
  const p = item.proposal;
  const by = p.decision?.by ?? "unknown";
  switch (item.status) {
    case "approved":
      return p.editedPayload ? `approved after edit by ${by}` : `approved by ${by}`;
    case "rejected": {
      const reason = p.decision?.reason ? ` — ${describeReason(p.decision.reason)}` : "";
      return `declined by ${by}${reason}`;
    }
    case "expired":
      // No decidedAt, no decision: nobody decided, the clock did. Naming that
      // is the point — an expiry is a chance the human lost, not a soft no.
      return "expired undecided — the deadline passed with no decision";
    case "yanked":
      return `yanked from the hold tray by ${by} — pulled back before it sent`;
    case "closed":
      // Not a decline: nobody decided this row — the thing it depended on
      // was declined or expired, and the ground vanished. The server wrote
      // the mechanism into decision.note; render it verbatim.
      return p.decision?.note ?? "closed — the thing it depended on went away";
  }
}

/**
 * How long the proposal sat before it left the queue — always PAST tense
 * here, which is why this does not reuse `waitedLabel`: that function keys
 * its tense off `proposal.status`, and a yanked row's parsed status reads
 * "pending" (types.ts header), which would render a history row as still
 * waiting. The freeze arithmetic itself is `waitedForMs`, unchanged: it
 * freezes at `decidedAt` (set for approved/rejected/yanked) or at
 * `expiresAt` for the expired.
 */
export function satWithYouLabel(item: DecidedItem, now: number): string {
  const p = item.proposal;
  const ms = waitedForMs(item.status === "expired" ? { ...p, status: "expired" } : p, now);
  return `sat with you ${formatDuration(ms)}`;
}

/** The short status word a list row leads with. */
export function statusWord(item: ActivityItem): string {
  return item.type === "watch-fired" ? "fired" : item.status === "rejected" ? "declined" : item.status;
}

/**
 * A fired watch's one-line summary: what was watched, and what firing DID —
 * both halves matter, because "a watch fired" alone says neither.
 */
export function summarizeWatch(w: FiredWatch): string {
  const did =
    w.actionType === "draft-followup"
      ? "drafted a follow-up for your approval"
      : w.actionType === "notify"
        ? "sent you a notification"
        : `ran "${w.actionType}"`;
  if (w.conditionType === "no-reply-from") {
    const sender = typeof w.condition.sender === "string" ? w.condition.sender : "(unknown sender)";
    return `No reply from ${sender} by the deadline — ${did}`;
  }
  if (w.conditionType === "deadline") {
    return `A deadline you set arrived — ${did}`;
  }
  return `Watch "${w.conditionType}" fired — ${did}`;
}

/** One headline per feed item, whatever its source. */
export function summarizeItem(item: ActivityItem): string {
  return item.type === "decided" ? summarizeProposal(item.proposal) : summarizeWatch(item.watch);
}

/** WHO acted for the list row's meta line: the binding for a proposal, the
 *  watch's owner-side framing otherwise (a watch is the HUMAN's standing
 *  order; the agent only executes the fire). */
export function actorLabel(item: ActivityItem): string {
  return item.type === "decided" ? item.proposal.agent : "your watch";
}

/** The honest caveat under the fan-in (sprint doc, "one honest omission"):
 *  shown whenever the feed spans more than one account. */
export const FAN_IN_NOTE =
  "Ordered per event timestamp across accounts that share no clock — items from " +
  "different accounts may interleave imprecisely.";

/** What the section IS, said on its face. */
export const ACTIVITY_SUB =
  "What was decided without you — and by you — and on whose authority. Approvals, declines, " +
  "expiries, retractions, and the watches that fired. Read-only: anything still live is in Approvals.";

/** The proposals-only caveat when no account serves Watch. */
export const WATCHES_UNAVAILABLE_NOTE =
  "This server does not serve Watch, so the feed shows decided proposals only — " + "no claim is made about watches.";
