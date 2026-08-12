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
// ⚠️ Two timestamps here are DIFFERENT CLOCKS and must never be conflated
// (s07 devPlan §T0, actionProposal.ts:55-61):
//   expiresAt   the PRE-decision deadline — how long the human has to decide.
//               The agent worker's sweep flips `pending`→`expired` past it
//               (services/agent/src/proposals.ts:148-181).
//   holdUntil   the tier-2 POST-approval retraction window — how long an
//               approved action can still be pulled back before it commits.
// The arithmetic that keeps them apart lives in `clocks.ts`, with tests.

/** `pending` is the queue; `held` is the tier-2 hold tray; the rest are history. */
export type ProposalStatus = "pending" | "approved" | "rejected" | "held" | "expired";

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
  | "grant-request";

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

/** The no-thanks signal (arch.md §3). `notNow` is a snooze, not a rejection. */
export type RejectReason = "wrongContent" | "wrongAction" | "notNow";

export interface ProposalDecision {
  by: string;
  reason?: RejectReason;
  note?: string;
  /** The undo handle a tier-1 application keeps (actionProposal.ts:421). */
  undo?: Record<string, unknown>;
}

export interface ActionProposal {
  id: string;
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
  expiresAt: string | null;
  /** The live invocation status — the read-model surface (arch.md §5). */
  invocationStatus: string;
  claimedAt: string | null;
}

/**
 * Coerce one `ActionProposal/get` list entry. Defensive in the same spots the
 * server is (`safeJson` / `safeJsonArray`, actionProposal.ts:590-606): a
 * malformed field degrades to its empty value rather than taking the queue
 * down, but `id` is required — a row with no id is not decidable and is
 * dropped by the caller.
 */
export function parseProposal(raw: Record<string, unknown>): ActionProposal | null {
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const tierNum = typeof raw.tier === "number" ? raw.tier : 0;
  return {
    id: raw.id,
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
    invocationStatus: str(raw.invocationStatus) ?? "",
    claimedAt: str(raw.claimedAt),
  };
}

const STATUSES: ReadonlySet<string> = new Set(["pending", "approved", "rejected", "held", "expired"]);

function isStatus(v: unknown): v is ProposalStatus {
  return typeof v === "string" && STATUSES.has(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
