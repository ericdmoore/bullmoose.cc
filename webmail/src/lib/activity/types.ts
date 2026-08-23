// The Activity feed's item model (s23 v1) — the retrospective twin of the
// approvals queue. Nothing here is a new server collection: a decided
// proposal is an `ActionProposal` row whose status left the live set, and a
// fired watch is a `Watch` row the cron already flipped. This module only
// names the shapes the feed renders.
//
// ⚠️ Why decided rows get their OWN parser instead of riding `parseProposal`
// alone: `parseProposal` coerces an UNKNOWN status to "pending". For a QUEUE
// that is the safe degradation; for a HISTORY it would be the exact lie this
// section exists to end — a retracted action re-presented as waiting. The
// approvals enum has since learned `yanked` (it mirrors the server exactly,
// rows.test.ts holds it there), but this partition still reads the RAW status
// string and keeps it, so a state the enum meets AFTER this build ships
// renders as itself here rather than as "pending".

import { parseProposal, type ActionProposal } from "../approvals/types";

/** Everything non-live — the statuses that make a proposal history. */
export const DECIDED_STATUSES = ["approved", "rejected", "expired", "yanked", "closed"] as const;
export type DecidedStatus = (typeof DECIDED_STATUSES)[number];

export function isDecidedStatus(v: unknown): v is DecidedStatus {
  return typeof v === "string" && (DECIDED_STATUSES as readonly string[]).includes(v);
}

/** One decided proposal in the feed. `status` is read RAW off the wire (see
 *  module header) and is the truth even if `proposal.status` ever degrades. */
export interface DecidedItem {
  type: "decided";
  /** Feed-unique key — prefixed so a proposal id and a watch id can never
   *  collide in the merged list. */
  id: string;
  accountId: string;
  /** Epoch ms when the row left the live queue: `decidedAt`, or `expiresAt`
   *  for an expired row (nobody decided; the clock did). 0 = undated. */
  occurredAt: number;
  status: DecidedStatus;
  proposal: ActionProposal;
}

/** A `Watch` row as `Watch/get` serves it (services/jmap/src/methods/watch.ts
 *  `toJmap`), narrowed to what the feed renders. Timestamps are epoch ms on
 *  the wire, kept that way. */
export interface FiredWatch {
  id: string;
  accountId: string;
  /** "deadline" | "no-reply-from" — open string; the server stores TEXT. */
  conditionType: string;
  condition: Record<string, unknown>;
  deadlineAt: number | null;
  /** "notify" | "draft-followup" — open string, same reason. */
  actionType: string;
  action: Record<string, unknown>;
  firedAt: number | null;
  /** The proposal the fire produced, when the action drafts one. */
  proposalId: string | null;
  sourceRef: string | null;
  createdAt: number | null;
}

export interface WatchItem {
  type: "watch-fired";
  /** Feed-unique key (see `DecidedItem.id`). */
  id: string;
  accountId: string;
  /** Epoch ms when it fired; falls back to the deadline it fired for. */
  occurredAt: number;
  watch: FiredWatch;
}

export type ActivityItem = DecidedItem | WatchItem;

/**
 * Coerce one `ActionProposal/get` list entry into a decided feed item, or
 * null when the row is still live (pending / info-requested / held) — the
 * live queue is `/approvals`' realm, never this one — or unparseable.
 */
export function parseDecided(raw: Record<string, unknown>, fallbackAccountId = ""): DecidedItem | null {
  if (!isDecidedStatus(raw.status)) return null;
  const proposal = parseProposal(raw, fallbackAccountId);
  if (!proposal) return null;
  return {
    type: "decided",
    id: `decided:${proposal.id}`,
    accountId: proposal.accountId,
    occurredAt: firstDate(proposal.decidedAt, proposal.expiresAt, proposal.createdAt),
    status: raw.status,
    proposal,
  };
}

/**
 * Coerce one `Watch/get` list entry into a fired feed item. Rows in any other
 * status are dropped — the query filters server-side, but a feed of "watches
 * fired" must not render an armed one because a fake or an older server
 * over-served.
 */
export function parseFiredWatch(raw: Record<string, unknown>, fallbackAccountId = ""): WatchItem | null {
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (raw.status !== "fired") return null;
  const watch: FiredWatch = {
    id: raw.id,
    accountId: str(raw.accountId) ?? fallbackAccountId,
    conditionType: str(raw.conditionType) ?? "unknown",
    condition: obj(raw.condition),
    deadlineAt: msOrNull(raw.deadlineAt),
    actionType: str(raw.actionType) ?? "unknown",
    action: obj(raw.action),
    firedAt: msOrNull(raw.firedAt),
    proposalId: str(raw.proposalId),
    sourceRef: str(raw.sourceRef),
    createdAt: msOrNull(raw.createdAt),
  };
  return {
    type: "watch-fired",
    id: `watch:${watch.id}`,
    accountId: watch.accountId,
    occurredAt: watch.firedAt ?? watch.deadlineAt ?? watch.createdAt ?? 0,
    watch,
  };
}

/** First parseable instant, as epoch ms; 0 when none is — "undated", which the
 *  feed renders as such rather than inventing a date. */
function firstDate(...candidates: Array<string | null>): number {
  for (const c of candidates) {
    if (c === null) continue;
    const t = Date.parse(c);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function msOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}
