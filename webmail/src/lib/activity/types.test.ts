import { describe, expect, it } from "vitest";
import { DECIDED_STATUSES, isDecidedStatus, parseDecided, parseFiredWatch } from "./types";

const NOW = Date.parse("2026-08-11T12:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** A complete raw proposal row, as `ActionProposal/get` would serve it. */
function rawProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p1",
    accountId: "acct-a",
    agent: "Emily",
    kind: "reply-draft",
    tier: 2,
    subject: { realm: "Email", objectId: "e1" },
    payload: { to: "grace@example.test", subject: "Re: hello" },
    editedPayload: null,
    rationale: "why",
    evidence: [],
    status: "approved",
    decision: { by: "eric@bullmoose.test" },
    createdAt: iso(NOW - 3 * HOUR),
    decidedAt: iso(NOW - 1 * HOUR),
    holdUntil: null,
    expiresAt: null,
    dueAt: null,
    question: null,
    amendments: [],
    invocationStatus: "done",
    claimedAt: null,
    costMicros: null,
    tokensIn: null,
    tokensOut: null,
    costModel: null,
    ...overrides,
  };
}

function rawWatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "w1",
    accountId: "acct-a",
    conditionType: "no-reply-from",
    condition: { sender: "sergio@example.test" },
    deadlineAt: NOW - 5 * HOUR,
    actionType: "draft-followup",
    action: {},
    status: "fired",
    sourceRef: "email:e1",
    createdAt: NOW - 3 * DAY,
    firedAt: NOW - 5 * HOUR,
    proposalId: "p-followup",
    ...overrides,
  };
}

describe("the decided partition", () => {
  it("is exactly the four non-live statuses", () => {
    expect([...DECIDED_STATUSES]).toEqual(["approved", "rejected", "expired", "yanked"]);
    for (const s of DECIDED_STATUSES) expect(isDecidedStatus(s)).toBe(true);
  });

  it("refuses the live statuses — the queue's realm, never activity's", () => {
    for (const s of ["pending", "info-requested", "held"]) {
      expect(isDecidedStatus(s), s).toBe(false);
      expect(parseDecided(rawProposal({ status: s, decidedAt: null }))).toBeNull();
    }
  });
});

describe("parseDecided", () => {
  it("keeps the raw status — including `yanked`, which parseProposal cannot carry", () => {
    // The approvals client type has no `yanked` (its queue never renders one),
    // so `parseProposal` coerces it to "pending" — the safe queue degradation
    // that would be a LIE here: a retracted action re-presented as waiting.
    const item = parseDecided(rawProposal({ status: "yanked" }))!;
    expect(item.status).toBe("yanked");
    expect(item.proposal.status).toBe("pending"); // the coercion, named
    expect(item.type).toBe("decided");
  });

  it("prefixes the feed id so a proposal and a watch can never collide", () => {
    expect(parseDecided(rawProposal())!.id).toBe("decided:p1");
    expect(parseFiredWatch(rawWatch({ id: "p1" }))!.id).toBe("watch:p1");
  });

  it("dates the row at decidedAt", () => {
    expect(parseDecided(rawProposal())!.occurredAt).toBe(NOW - 1 * HOUR);
  });

  it("dates an expired row at its lapse — nobody decided, the clock did", () => {
    const item = parseDecided(
      rawProposal({
        status: "expired",
        decision: null,
        decidedAt: null,
        expiresAt: iso(NOW - 2 * DAY),
        createdAt: iso(NOW - 9 * DAY),
      }),
    )!;
    expect(item.occurredAt).toBe(NOW - 2 * DAY);
  });

  it("degrades an undatable row to 0, never an invented date", () => {
    const item = parseDecided(rawProposal({ decidedAt: null, expiresAt: null, createdAt: "not a date" }))!;
    expect(item.occurredAt).toBe(0);
  });

  it("drops a row with no id — not renderable, not addressable", () => {
    expect(parseDecided(rawProposal({ id: "" }))).toBeNull();
  });

  it("falls back to the request's account when the row does not carry one", () => {
    const item = parseDecided(rawProposal({ accountId: undefined }), "acct-fallback")!;
    expect(item.accountId).toBe("acct-fallback");
    expect(item.proposal.accountId).toBe("acct-fallback");
  });
});

describe("parseFiredWatch", () => {
  it("parses the server's toJmap shape, epoch ms kept as-is", () => {
    const item = parseFiredWatch(rawWatch())!;
    expect(item.type).toBe("watch-fired");
    expect(item.watch.conditionType).toBe("no-reply-from");
    expect(item.watch.condition.sender).toBe("sergio@example.test");
    expect(item.watch.deadlineAt).toBe(NOW - 5 * HOUR);
    expect(item.watch.proposalId).toBe("p-followup");
    expect(item.occurredAt).toBe(NOW - 5 * HOUR);
  });

  it("drops anything not fired — an over-serving fake must not fake a fire", () => {
    for (const s of ["armed", "cancelled", "expired"]) {
      expect(parseFiredWatch(rawWatch({ status: s })), s).toBeNull();
    }
  });

  it("falls back from firedAt to the deadline it fired for, then createdAt", () => {
    expect(parseFiredWatch(rawWatch({ firedAt: null }))!.occurredAt).toBe(NOW - 5 * HOUR);
    expect(parseFiredWatch(rawWatch({ firedAt: null, deadlineAt: null }))!.occurredAt).toBe(NOW - 3 * DAY);
    expect(parseFiredWatch(rawWatch({ firedAt: null, deadlineAt: null, createdAt: null }))!.occurredAt).toBe(0);
  });

  it("drops a row with no id", () => {
    expect(parseFiredWatch(rawWatch({ id: "" }))).toBeNull();
  });
});
