import { describe, expect, it } from "vitest";
import { orderQueue } from "../approvals/clocks";
import type { ActionProposal } from "../approvals/types";
import { HOME_APPROVALS_LIMIT, waitingApprovals } from "./waiting";

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
    invocationStatus: "done",
    claimedAt: null,
    ...partial,
  };
}

describe("waitingApprovals — the condensed pending glance", () => {
  // Deliberately NOT in urgency order — so a module that forgot to reuse
  // `orderQueue` and merely filtered the input would produce a different order
  // and the reuse test below would bite.
  const rows: ActionProposal[] = [
    proposal({ id: "no-deadline", createdAt: new Date(NOW - 3 * DAY).toISOString(), expiresAt: null }),
    proposal({ id: "later", expiresAt: new Date(NOW + 2 * DAY).toISOString() }),
    proposal({ id: "approved", status: "approved", decidedAt: new Date(NOW - 26 * HOUR).toISOString() }),
    proposal({ id: "soon", expiresAt: new Date(NOW + 35 * MIN).toISOString() }),
    proposal({ id: "expired", status: "expired", expiresAt: new Date(NOW - DAY).toISOString() }),
    proposal({ id: "held", status: "held", decidedAt: new Date(NOW - 2 * MIN).toISOString(), holdUntil: new Date(NOW + 3 * MIN).toISOString() }),
  ];

  it("shows PENDING only — held rows and history are not here", () => {
    const shown = waitingApprovals(rows).rows.map((p) => p.id);
    expect(shown).not.toContain("held");
    expect(shown).not.toContain("approved");
    expect(shown).not.toContain("expired");
    expect(shown).toEqual(["soon", "later", "no-deadline"]);
  });

  it("REUSES orderQueue's urgency order rather than sorting again", () => {
    // The pending prefix of the shared order IS the glance order — if this
    // module ever re-sorted, this equality would be the thing that broke.
    const viaQueue = orderQueue(rows)
      .filter((p) => p.status === "pending")
      .map((p) => p.id);
    expect(waitingApprovals(rows).rows.map((p) => p.id)).toEqual(viaQueue);
  });

  it("caps to a glance and reports the honest 'more' remainder", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      proposal({ id: `p${i}`, expiresAt: new Date(NOW + (i + 1) * HOUR).toISOString() }),
    );
    const res = waitingApprovals(many);
    expect(res.rows).toHaveLength(HOME_APPROVALS_LIMIT);
    expect(res.pendingTotal).toBe(8);
    expect(res.more).toBe(8 - HOME_APPROVALS_LIMIT);
    // The cap keeps the most urgent, not an arbitrary slice.
    expect(res.rows[0]!.id).toBe("p0");
  });

  it("reports no remainder when everything fits", () => {
    const res = waitingApprovals(rows);
    expect(res.more).toBe(0);
    expect(res.pendingTotal).toBe(3);
  });
});
