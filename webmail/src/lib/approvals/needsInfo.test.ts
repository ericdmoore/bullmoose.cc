import { describe, expect, it } from "vitest";
import type { ProposalAmendment } from "./types";
import {
  NEEDS_INFO_HINT,
  WAITING_ON_AGENT_NOTE,
  answeredRounds,
  needsInfoAvailable,
  openQuestion,
  questionProblem,
} from "./needsInfo";

const round = (over: Partial<ProposalAmendment> = {}): ProposalAmendment => ({
  question: "Why Bob?",
  answer: "Bob signed both invoices.",
  askedAt: "2026-08-11T10:00:00Z",
  answeredAt: "2026-08-11T10:05:00Z",
  askedBy: "eric@login.example",
  ...over,
});

describe("needsInfoAvailable — everywhere reject is offered, and only there", () => {
  it("is offered on pending rows only", () => {
    expect(needsInfoAvailable({ status: "pending" })).toBe(true);
    for (const status of ["info-requested", "held", "approved", "rejected", "expired"] as const) {
      expect(needsInfoAvailable({ status }), status).toBe(false);
    }
  });
});

describe("questionProblem — the question is required, locally", () => {
  it("refuses empty and whitespace-only questions", () => {
    expect(questionProblem("")).toContain("required");
    expect(questionProblem("   \n ")).toContain("required");
  });

  it("accepts a real question", () => {
    expect(questionProblem("Why do you need to email Bob?")).toBeNull();
  });
});

describe("the dialogue reads", () => {
  it("openQuestion is the LAST round iff unanswered — the one the agent owes", () => {
    const open = round({ question: "And why now?", answer: null, answeredAt: null });
    expect(openQuestion({ question: "And why now?", amendments: [round(), open] })).toEqual(open);
    // All answered → nothing owed, even though `question` may lag.
    expect(openQuestion({ question: null, amendments: [round()] })).toBeNull();
    expect(openQuestion({ question: null, amendments: [] })).toBeNull();
  });

  it("answeredRounds keeps only completed Q&A, preserving order", () => {
    const first = round();
    const second = round({ question: "And why now?", answer: "The invoice is due Friday." });
    const open = round({ question: "Third?", answer: null, answeredAt: null });
    expect(answeredRounds({ amendments: [first, second, open] })).toEqual([first, second]);
  });
});

describe("wording — the surface is the contract", () => {
  it("the hint says it is NOT a decline and that the clock pauses", () => {
    expect(NEEDS_INFO_HINT).toContain("Not a decline");
    expect(NEEDS_INFO_HINT).toContain("pauses");
  });

  it("the waiting note says who the ball is with and that the clock is paused", () => {
    expect(WAITING_ON_AGENT_NOTE).toContain("waiting on the agent");
    expect(WAITING_ON_AGENT_NOTE).toContain("paused");
  });
});
