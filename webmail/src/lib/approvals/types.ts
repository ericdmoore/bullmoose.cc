// The `ActionProposal` read model as the server projects it — the shape
// `/approvals` renders and decides against.
//
// This mirrors `proposalToJmap` (services/jmap/src/methods/actionProposal.ts:560-581)
// field for field, because that projection IS the contract: the collection is a
// read model over `agent_invocations` (s03.D/arch.md §1), so `agent`,
// `invocationStatus` and `claimedAt` ride in from the invocation and everything
// else comes off `agent_proposals`. Nothing here invents a field the server
// does not serve — the s03.E lesson was two complete screens against data that
// was not reachable.
//
// ⚠️ THREE timestamps here are DIFFERENT CLOCKS and must never be conflated
// (s07 devPlan §T0, actionProposal.ts:55-61; s11 T1 adds the third):
//   expiresAt   the PRE-decision deadline — how long the human has to decide.
//               The agent worker's sweep flips `pending`→`expired` past it
//               (services/agent/src/proposals.ts:148-181).
//   holdUntil   the tier-2 POST-approval retraction window — how long an
//               approved action can still be pulled back before it commits.
//   dueAt       the WORK's own business deadline ("review this by Friday") —
//               inferred at the boundary, projected from the invocation, and
//               the field the s11 scheduler reads. Null = never-urgent. It is
//               a proposal the human can CORRECT (api.ts `correctDueAt`),
//               never a hidden field.
// The arithmetic that keeps them apart lives in `clocks.ts`, with tests.

/** `pending` is the queue; `info-requested` is waiting on the AGENT to answer a
 * needsInfo question (s10 T3 — the decision clock is paused); `held` is the
 * tier-2 hold tray; the rest are history. */
export type ProposalStatus = "pending" | "info-requested" | "approved" | "rejected" | "held" | "expired";

/** Reversibility, and therefore what approve is allowed to do (arch.md §2). */
export type ProposalTier = 1 | 2 | 3;

/**
 * The kinds the arch names (arch.md §1). Kept open (`string` fallback in
 * `parseProposal`) because the server stores kind as TEXT and a queue that
 * crashed on a kind it had not met would be worse than one that renders it
 * generically.
 */
export type ProposalKind =
  | "reply-draft"
  | "unsubscribe"
  | "create-event"
  | "start-thread"
  | "create-contact"
  | "organize-files"
  | "grant-request"
  // s11 T9 — "this binding is out of budget and N invocations are waiting;
  // approve a bounded overage?" The one kind whose payload is entirely numbers,
  // which is why its summary leads with them (`summarizeProposal`).
  | "budget-overrun"
  // s12 — "the boundary held N messages it could not judge; release or
  // confirm?" The mid-band is definitionally the band bouncer@ cannot decide,
  // so it comes here as ONE batched question instead of accruing in a folder
  // nobody owns.
  | "held-mail-review"
  // s20 T1↔T4 — the anti-star: "you emailed X and haven't heard back; want me
  // to watch this and draft a follow-up?" The agent NOTICED — you flagged
  // nothing. Approving arms a no-reply-from Watch (reversible, tier 1).
  | "watch-offer";

/** What the proposal acts on. */
export interface ProposalSubject {
  realm: string;
  objectId: string;
}

/** What the agent looked at — rendered under every row, next to `rationale`. */
export interface ProposalEvidence {
  realm: string;
  objectId: string;
  note?: string;
}

/**
 * The no-thanks signal (arch.md §3) as the decline panel may WRITE it — exactly
 * the server's enum (actionProposal.ts `REJECT_REASONS`), because a reason this
 * type offers and the server refuses is a decline that fails at the round trip.
 *
 * Each steers a different correction (decline-taxonomy.md): `wrongContent`
 * fixes generation, `wrongAction` fixes selection, and `unsafe` is
 * categorically separate — the hard negative, not a stronger "no". `notNow` is
 * RETIRED: it conflated "I'll do it myself", "not due yet" (now a `dueAt`
 * correction, which records nothing) and "meh, later".
 */
export type RejectReason = "wrongContent" | "wrongAction" | "unsafe";

/**
 * What a STORED decision may carry, which is deliberately NOT the same set.
 * Reasons retire from the write path over time and history is never rewritten,
 * so a read must accept a reason this build no longer offers. Render through
 * `describeReason` (rows.ts): a retired value shows as itself, marked retired —
 * never dropped, never silently remapped to a live reason.
 */
export type RecordedRejectReason = RejectReason | (string & {});

export interface ProposalDecision {
  by: string;
  /** As RECORDED — may predate the current enum (see `RecordedRejectReason`). */
  reason?: RecordedRejectReason;
  note?: string;
  /** The undo handle a tier-1 application keeps (actionProposal.ts:421). */
  undo?: Record<string, unknown>;
}

/**
 * One needsInfo Q&A round (s10 T3). `amendments` is APPEND-ONLY, mirroring the
 * server's `amendments_json`: the human's needsInfo pushes an open round
 * (`answer: null`), the agent's answer fills it — the proposal's original
 * rationale/evidence are never rewritten (the `editedPayload` discipline).
 */
export interface ProposalAmendment {
  question: string;
  answer: string | null;
  askedAt: string;
  answeredAt: string | null;
  askedBy: string;
}

export interface ActionProposal {
  id: string;
  /**
   * WHICH account this row came off (s10 T7). The queue merges every account
   * the human can reach — their own, plus each agent account a supervisory
   * grant opens — so a row that does not carry its account cannot be decided
   * (the `/set` needs one) and cannot be labelled. Served by the projection,
   * never inferred here.
   */
  accountId: string;
  /** Binding name — Allen, Emily. Projected from the invocation (§8.5). */
  agent: string;
  kind: string;
  tier: ProposalTier;
  subject: ProposalSubject;
  /** Kind-specific — the AGENT's version, the retained source of truth. */
  payload: Record<string, unknown>;
  /**
   * The HUMAN's edit, and only ever the human's edit. The server writes it
   * beside `payload`, never over it (actionProposal.ts:222-228), because the
   * diff between the two is the highest-signal feedback the system collects
   * (s07 §T4: "approved after edit" is its own outcome). `null` = never edited.
   */
  editedPayload: Record<string, unknown> | null;
  /** The "why" — always present (invariant §8.3). */
  rationale: string;
  evidence: ProposalEvidence[];
  status: ProposalStatus;
  decision: ProposalDecision | null;
  createdAt: string;
  decidedAt: string | null;
  holdUntil: string | null;
  /** NULL while a needsInfo round is open — the clock is paused server-side. */
  expiresAt: string | null;
  /** s11 T1 — the WORK's deadline (the third clock). Null = never-urgent. */
  dueAt: string | null;
  /** needsInfo (s10 T3): the human's OPEN question; null when no round is open. */
  question: string | null;
  /** The append-only Q&A dialogue — every needsInfo round, answered or open. */
  amendments: ProposalAmendment[];
  /** The live invocation status — the read-model surface (arch.md §5). */
  invocationStatus: string;
  claimedAt: string | null;
  /** s07 T5's frozen cost. null = "not recorded" (absent usage / unpriceable),
   *  0 = genuinely free — the two must never collapse (the queue renders them
   *  differently on purpose). */
  costMicros: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  /** "provider/model" that produced it, when one did. */
  costModel: string | null;
}

/**
 * Coerce one `ActionProposal/get` list entry. Defensive in the same spots the
 * server is (`safeJson` / `safeJsonArray`, actionProposal.ts:590-606): a
 * malformed field degrades to its empty value rather than taking the queue
 * down, but `id` is required — a row with no id is not decidable and is
 * dropped by the caller.
 */
export function parseProposal(raw: Record<string, unknown>, fallbackAccountId = ""): ActionProposal | null {
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const tierNum = typeof raw.tier === "number" ? raw.tier : 0;
  return {
    id: raw.id,
    // Falls back to the response envelope's account (the caller passes it):
    // a pre-T7 server does not project `accountId` on the row, and a queue
    // that dropped those rows would reintroduce the bug it fixes.
    accountId: str(raw.accountId) ?? fallbackAccountId,
    agent: str(raw.agent) ?? "unknown agent",
    kind: str(raw.kind) ?? "unknown",
    // An out-of-range tier reads as 3: when the reversibility of a row is not
    // known, the only honest assumption is "irreversible" — fail closed, the
    // same direction the Bureau's invariant 5 takes.
    tier: tierNum === 1 || tierNum === 2 ? tierNum : 3,
    subject: obj(raw.subject) as unknown as ProposalSubject,
    payload: obj(raw.payload),
    editedPayload: raw.editedPayload == null ? null : obj(raw.editedPayload),
    rationale: str(raw.rationale) ?? "",
    evidence: Array.isArray(raw.evidence)
      ? raw.evidence.filter((e): e is ProposalEvidence => e !== null && typeof e === "object")
      : [],
    status: isStatus(raw.status) ? raw.status : "pending",
    decision: raw.decision == null ? null : (obj(raw.decision) as unknown as ProposalDecision),
    createdAt: str(raw.createdAt) ?? "",
    decidedAt: str(raw.decidedAt),
    holdUntil: str(raw.holdUntil),
    expiresAt: str(raw.expiresAt),
    dueAt: str(raw.dueAt),
    question: str(raw.question),
    amendments: Array.isArray(raw.amendments)
      ? raw.amendments.filter(
          (a): a is ProposalAmendment =>
            a !== null && typeof a === "object" && typeof (a as ProposalAmendment).question === "string",
        )
      : [],
    invocationStatus: str(raw.invocationStatus) ?? "",
    claimedAt: str(raw.claimedAt),
    costMicros: typeof raw.costMicros === "number" ? raw.costMicros : null,
    tokensIn: typeof raw.tokensIn === "number" ? raw.tokensIn : null,
    tokensOut: typeof raw.tokensOut === "number" ? raw.tokensOut : null,
    costModel: str(raw.costModel),
  };
}

const STATUSES: ReadonlySet<string> = new Set(["pending", "info-requested", "approved", "rejected", "held", "expired"]);

function isStatus(v: unknown): v is ProposalStatus {
  return typeof v === "string" && STATUSES.has(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
