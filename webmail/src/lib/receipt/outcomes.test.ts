import { describe, expect, it } from "vitest";
import { classifyInvocation, rungLabel, skipShare } from "./outcomes";

// The notes below are COPIED from the agent worker, not paraphrased. That is
// the point of the test: this module classifies on prose another service
// writes, so the assertion has to be against that prose verbatim. If a note is
// reworded upstream, the corresponding case here is the thing that has to
// change, which is exactly the review moment that ought to happen.

describe("classifyInvocation — the ladder's rung, read off the note", () => {
  it("the cue pre-filter is a SKIP: no model call, no money (extract.ts:274)", () => {
    expect(classifyInvocation({ status: "done", note: "no extraction cues — skipped, no model call" })).toBe("skipped");
  });

  it("bulk mail is a skip too — the List-Unsubscribe gate (extract.ts:269)", () => {
    expect(classifyInvocation({ status: "done", note: "skipped: List-Unsubscribe (bulk mail) — no model call" })).toBe(
      "skipped",
    );
  });

  it("the retry-idempotence guard is a skip (extract.ts:283)", () => {
    expect(classifyInvocation({ status: "done", note: "already extracted (retry) — no duplicates" })).toBe("skipped");
  });

  it("other pipelines' sender gates are skips by the same rule — free is free", () => {
    for (const note of [
      "skipped: noreply@vendor.example not in allowedSenders",
      "skipped: auto-generated sender",
      "skipped: no sender address",
      "skipped: outbound bound — recipient not allowed",
    ]) {
      expect(classifyInvocation({ status: "done", note })).toBe("skipped");
    }
  });

  it("the free scout is SCREENED, not skipped — a model ran and its cost was stamped 0", () => {
    // s26 T3 v2. Folding this into `skipped` would misreport the ladder AND
    // the money: a stamped 0 is a recorded number, not a missing one.
    expect(classifyInvocation({ status: "done", note: "scouted: nothing — no paid call" })).toBe("screened");
  });

  it("a paid extraction that produced something RAN", () => {
    expect(classifyInvocation({ status: "done", note: "extracted 3, offered 2" })).toBe("ran");
  });

  it("a paid extraction that found nothing still RAN — it was paid for", () => {
    // The distinction the whole page turns on: "the model looked and found
    // nothing" costs money; "we never called the model" does not.
    expect(classifyInvocation({ status: "done", note: "no commitments/decisions/tasks found" })).toBe("ran");
  });

  it("an unrecognised note is a RUN — the error direction that cannot flatter the ladder", () => {
    expect(classifyInvocation({ status: "done", note: "some wording nobody here has met" })).toBe("ran");
    expect(classifyInvocation({ status: "done", note: null })).toBe("ran");
  });

  it("status wins over the note: a failed row that says 'skipped' still FAILED", () => {
    expect(classifyInvocation({ status: "failed", note: "skipped: no model call" })).toBe("failed");
  });

  it("pending and running are in flight, and never scored", () => {
    expect(classifyInvocation({ status: "pending", note: null })).toBe("inflight");
    expect(classifyInvocation({ status: "running", note: null })).toBe("inflight");
  });

  it("a status this build has not met counts as work that happened, not as a skip", () => {
    expect(classifyInvocation({ status: "quarantined", note: null })).toBe("ran");
  });
});

describe("rungLabel", () => {
  it("every rung says what it means about MONEY, not just what happened", () => {
    expect(rungLabel("skipped")).toContain("no model call");
    expect(rungLabel("screened")).toContain("free model");
    expect(rungLabel("ran")).toContain("model");
    expect(rungLabel("failed")).toBe("failed");
    expect(rungLabel("inflight")).toContain("flight");
  });
});

describe("skipShare — the number s36's economics argument stands on", () => {
  const counts = (over: Partial<Record<string, number>> = {}) => ({
    skipped: 0,
    screened: 0,
    ran: 0,
    failed: 0,
    inflight: 0,
    ...over,
  });

  it("counts skipped AND screened as work the ladder took cheaply", () => {
    expect(skipShare(counts({ skipped: 6, screened: 2, ran: 2 }))).toBe(80);
  });

  it("excludes in-flight rows from the denominator — an unfinished run picked no rung", () => {
    // Without this the rate sags every time the queue is busy, which would read
    // as the pre-filter getting worse when nothing about it changed.
    expect(skipShare(counts({ skipped: 1, ran: 1, inflight: 98 }))).toBe(50);
  });

  it("counts failures in the denominator — a failed run consumed the decision", () => {
    expect(skipShare(counts({ skipped: 1, ran: 2, failed: 1 }))).toBe(25);
  });

  it("is null, not zero, when nothing finished — an empty window has no rate", () => {
    expect(skipShare(counts())).toBeNull();
    expect(skipShare(counts({ inflight: 4 }))).toBeNull();
  });
});
