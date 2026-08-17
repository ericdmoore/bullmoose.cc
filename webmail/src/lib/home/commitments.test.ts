import { describe, expect, it } from "vitest";
import type { Annotation } from "../annotations/types";
import { commitments, waitingOn, HOME_ANNOTATIONS_LIMIT } from "./commitments";

// s18 A4 — the two chief-of-staff glances, pure. "What am I waiting on?" is the
// waiting-on detector's items (author 'waiting-on'); "what did I promise?" is
// open commitments. Both drop closed claims and lead with the freshest.

let seq = 0;
function annotation(over: Partial<Annotation> = {}): Annotation {
  seq += 1;
  return {
    id: `an_${seq}`,
    accountId: "acct",
    authorKind: "agent",
    author: "scribe",
    anchor: { realm: "Email", objectId: `e_${seq}` },
    class: "commitment",
    body: "a claim",
    confidence: 0.7,
    status: "open",
    rationale: null,
    sourceRef: `e_${seq}`,
    createdAt: seq,
    updatedAt: seq,
    ...over,
  };
}

describe("waitingOn — what am I waiting on?", () => {
  it("keeps only the OPEN 'waiting-on' items, newest first", () => {
    const rows = [
      annotation({ author: "waiting-on", class: "task", body: "waiting on A", createdAt: 10 }),
      annotation({ author: "waiting-on", class: "task", body: "waiting on B", createdAt: 30 }),
      annotation({ author: "scribe", class: "commitment", body: "a promise" }), // not a wait
      annotation({ author: "waiting-on", class: "task", status: "resolved", body: "answered" }), // closed
    ];
    const res = waitingOn(rows);
    expect(res.rows.map((r) => r.body)).toEqual(["waiting on B", "waiting on A"]);
    expect(res.total).toBe(2);
    expect(res.more).toBe(0);
  });

  it("caps at the limit and counts the overflow", () => {
    const rows = Array.from({ length: HOME_ANNOTATIONS_LIMIT + 3 }, (_, i) =>
      annotation({ author: "waiting-on", class: "task", createdAt: i }),
    );
    const res = waitingOn(rows);
    expect(res.rows).toHaveLength(HOME_ANNOTATIONS_LIMIT);
    expect(res.total).toBe(HOME_ANNOTATIONS_LIMIT + 3);
    expect(res.more).toBe(3);
  });
});

describe("commitments — what did I promise?", () => {
  it("keeps only OPEN commitments, newest first, ignoring the waiting-on tasks", () => {
    const rows = [
      annotation({ class: "commitment", body: "promise old", createdAt: 5 }),
      annotation({ class: "commitment", body: "promise new", createdAt: 50 }),
      annotation({ class: "decision", body: "a decision" }), // not a commitment
      annotation({ author: "waiting-on", class: "task", body: "a wait" }), // not a commitment
      annotation({ class: "commitment", status: "dismissed", body: "not really" }), // closed
    ];
    const res = commitments(rows);
    expect(res.rows.map((r) => r.body)).toEqual(["promise new", "promise old"]);
    expect(res.total).toBe(2);
  });

  it("empties cleanly before the extractor is on", () => {
    // Only waiting-on tasks exist (the graduated detector) — Commitments is empty.
    const res = commitments([annotation({ author: "waiting-on", class: "task" })]);
    expect(res.rows).toEqual([]);
    expect(res.total).toBe(0);
  });
});
