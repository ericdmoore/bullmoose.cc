import { describe, expect, it } from "vitest";
import {
  NEAR_EXPIRY_MS,
  expiryLabel,
  formatDuration,
  holdLabel,
  isNearExpiry,
  orderQueue,
  rowClocks,
  waitedForMs,
  waitedLabel,
} from "./clocks";
import type { ActionProposal } from "./types";

const NOW = Date.parse("2026-08-11T12:00:00Z");
const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function proposal(partial: Partial<ActionProposal> & Pick<ActionProposal, "id">): ActionProposal {
  return {
    agent: "Emily",
    kind: "reply-draft",
    tier: 2,
    subject: { realm: "Email", objectId: "e-1" },
    payload: {},
    editedPayload: null,
    rationale: "why",
    evidence: [],
    status: "pending",
    decision: null,
    createdAt: new Date(NOW - HOUR).toISOString(),
    decidedAt: null,
    holdUntil: null,
    expiresAt: null,
    question: null,
    amendments: [],
    invocationStatus: "done",
    claimedAt: null,
    ...partial,
  };
}

describe("the two clocks run OPPOSITE ways", () => {
  const p = proposal({
    id: "p",
    createdAt: new Date(NOW - 2 * HOUR).toISOString(),
    expiresAt: new Date(NOW + 3 * HOUR).toISOString(),
  });

  it("waited-for GROWS as now advances — it shames the human", () => {
    const early = rowClocks(p, NOW);
    const late = rowClocks(p, NOW + 10 * MIN);
    expect(early.waitedMs).toBe(2 * HOUR);
    expect(late.waitedMs).toBe(2 * HOUR + 10 * MIN);
    expect(late.waitedMs).toBeGreaterThan(early.waitedMs);
  });

  it("expires-in SHRINKS as now advances — it shames the clock", () => {
    const early = rowClocks(p, NOW);
    const late = rowClocks(p, NOW + 10 * MIN);
    expect(early.expiresInMs).toBe(3 * HOUR);
    expect(late.expiresInMs).toBe(3 * HOUR - 10 * MIN);
    expect(late.expiresInMs!).toBeLessThan(early.expiresInMs!);
  });

  it("a proposal with no expiresAt has NO deadline clock — never an invented one", () => {
    const open = proposal({ id: "open", expiresAt: null });
    expect(rowClocks(open, NOW).expiresInMs).toBeNull();
    expect(expiryLabel(null)).toBe("no deadline");
  });

  it("past the deadline the label says the window PASSED, not a negative count", () => {
    expect(expiryLabel(-5 * MIN)).toBe("decision window passed 5m 0s ago");
  });
});

describe("expiresAt and holdUntil are DIFFERENT clocks (s07 §T0)", () => {
  // The bug this file exists to prevent: one row carrying BOTH timestamps, and
  // each clock must come from its own field or not at all.
  const both = {
    expiresAt: new Date(NOW + 6 * DAY).toISOString(),
    holdUntil: new Date(NOW + 3 * MIN).toISOString(),
  };

  it("a HELD row renders the retraction window and NOT the decision deadline", () => {
    const held = proposal({ id: "h", status: "held", decidedAt: new Date(NOW - 2 * MIN).toISOString(), ...both });
    const clocks = rowClocks(held, NOW);
    expect(clocks.holdRemainingMs).toBe(3 * MIN); // from holdUntil…
    expect(clocks.expiresInMs).toBeNull(); // …never from expiresAt
  });

  it("a PENDING row renders the decision deadline and NOT a retraction window", () => {
    const pending = proposal({ id: "p", status: "pending", ...both });
    const clocks = rowClocks(pending, NOW);
    expect(clocks.expiresInMs).toBe(6 * DAY);
    expect(clocks.holdRemainingMs).toBeNull();
  });

  it("the hold label never claims egress — before OR after the window lapses", () => {
    // Committing out of the hold tray is s03.D T2 and does not exist, so both
    // phases must say nothing has been sent rather than implying a send.
    expect(holdLabel(3 * MIN)).toContain("nothing has been sent");
    expect(holdLabel(-1)).toContain("still not sent");
    expect(holdLabel(-1)).toContain("s03.D T2");
  });
});

describe("waited-for freezes when it stops sitting on the human", () => {
  it("freezes at decidedAt for a decided row — history stops accruing shame", () => {
    const decided = proposal({
      id: "d",
      status: "approved",
      createdAt: new Date(NOW - 5 * HOUR).toISOString(),
      decidedAt: new Date(NOW - 2 * HOUR).toISOString(),
    });
    expect(waitedForMs(decided, NOW)).toBe(3 * HOUR);
    expect(waitedForMs(decided, NOW + DAY)).toBe(3 * HOUR); // frozen
  });

  it("freezes at expiresAt for an EXPIRED row — the sweep writes no decidedAt", () => {
    const expired = proposal({
      id: "x",
      status: "expired",
      createdAt: new Date(NOW - 9 * DAY).toISOString(),
      decidedAt: null,
      expiresAt: new Date(NOW - 2 * DAY).toISOString(),
    });
    expect(waitedForMs(expired, NOW)).toBe(7 * DAY);
    expect(waitedForMs(expired, NOW + DAY)).toBe(7 * DAY);
  });

  it("labels present tense while pending, past tense after", () => {
    const p = proposal({ id: "p", createdAt: new Date(NOW - 2 * HOUR).toISOString() });
    expect(waitedLabel(p, rowClocks(p, NOW))).toBe("waiting on you 2h 0m");
    const done = proposal({ ...p, id: "q", status: "approved", decidedAt: new Date(NOW).toISOString() });
    expect(waitedLabel(done, rowClocks(done, NOW))).toBe("sat with you 2h 0m");
  });
});

describe("urgency", () => {
  it("flags near-expiry under the one-hour line, on the expiry clock only", () => {
    const near = proposal({ id: "n", expiresAt: new Date(NOW + 35 * MIN).toISOString() });
    const far = proposal({ id: "f", expiresAt: new Date(NOW + NEAR_EXPIRY_MS + MIN).toISOString() });
    expect(isNearExpiry(rowClocks(near, NOW))).toBe(true);
    expect(isNearExpiry(rowClocks(far, NOW))).toBe(false);
    // A held row's shrinking hold window is NOT expiry urgency.
    const held = proposal({ id: "h", status: "held", holdUntil: new Date(NOW + MIN).toISOString() });
    expect(isNearExpiry(rowClocks(held, NOW))).toBe(false);
  });
});

describe("orderQueue — pending first, by urgency", () => {
  const rows: ActionProposal[] = [
    proposal({ id: "expired", status: "expired", decidedAt: null, expiresAt: new Date(NOW - DAY).toISOString() }),
    proposal({ id: "held", status: "held", decidedAt: new Date(NOW - 2 * MIN).toISOString(), holdUntil: new Date(NOW + 3 * MIN).toISOString() }),
    proposal({ id: "no-deadline", createdAt: new Date(NOW - 3 * DAY).toISOString(), expiresAt: null }),
    proposal({ id: "soon", expiresAt: new Date(NOW + 35 * MIN).toISOString() }),
    proposal({ id: "later", expiresAt: new Date(NOW + 2 * DAY).toISOString() }),
    proposal({ id: "approved", status: "approved", decidedAt: new Date(NOW - 26 * HOUR).toISOString() }),
    proposal({ id: "rejected", status: "rejected", decidedAt: new Date(NOW - 2 * DAY).toISOString() }),
    // s10 T3: waiting on the AGENT — after everything decidable, before the
    // hold tray; expiresAt is null because the server banked it (paused).
    proposal({ id: "asked-late", status: "info-requested", createdAt: new Date(NOW - HOUR).toISOString(), expiresAt: null }),
    proposal({ id: "asked-early", status: "info-requested", createdAt: new Date(NOW - 5 * HOUR).toISOString(), expiresAt: null }),
  ];

  it("orders pending by soonest deadline, deadline-less last; then info-requested oldest-ask first; then held; then history newest-decided first", () => {
    expect(orderQueue(rows).map((p) => p.id)).toEqual([
      "soon",
      "later",
      "no-deadline",
      "asked-early",
      "asked-late",
      "held",
      "approved",
      "rejected",
      "expired",
    ]);
  });

  it("breaks pending deadline ties by the longest-waiting row", () => {
    const deadline = new Date(NOW + DAY).toISOString();
    const older = proposal({ id: "older", createdAt: new Date(NOW - 2 * DAY).toISOString(), expiresAt: deadline });
    const newer = proposal({ id: "newer", createdAt: new Date(NOW - HOUR).toISOString(), expiresAt: deadline });
    expect(orderQueue([newer, older]).map((p) => p.id)).toEqual(["older", "newer"]);
  });

  it("does not mutate its input", () => {
    const input = [...rows];
    orderQueue(input);
    expect(input.map((p) => p.id)).toEqual(rows.map((p) => p.id));
  });
});

describe("formatDuration", () => {
  it("is coarse with slack, seconds when short", () => {
    expect(formatDuration(2 * DAY + 3 * HOUR + 20 * MIN)).toBe("2d 3h");
    expect(formatDuration(3 * HOUR + 12 * MIN)).toBe("3h 12m");
    expect(formatDuration(35 * MIN)).toBe("35m");
    expect(formatDuration(4 * MIN + 10_000)).toBe("4m 10s");
    expect(formatDuration(41_000)).toBe("41s");
    expect(formatDuration(0)).toBe("0s");
  });
});
