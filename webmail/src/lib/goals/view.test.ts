import { describe, expect, it } from "vitest";
import {
  checkpointLine,
  milestoneLine,
  openPlanCheckpoint,
  orderGoals,
  orderMilestones,
  progressLine,
  statusLabel,
  statusNote,
} from "./view";
import type { Goal, Milestone } from "./types";

/**
 * s20 T6 — what the goal view SAYS.
 *
 * Two sentences carry the whole screen, and both are tested here because both
 * are claims rather than decoration:
 *
 *   "which checkpoints still stop for me" — because silently-widening autonomy
 *   is the one failure the whole product exists to prevent, and a widening only
 *   stays un-silent if the un-widened state is legible;
 *
 *   "every task finished" ≠ "done" — a Job's status can say the work ran; it
 *   cannot read a done-when clause, and a surface that conflated the two would
 *   be the system marking its own homework.
 */

const base: Goal = {
  id: "job_attic",
  statement: "get three structural engineers willing to evaluate the attic",
  contract: {
    may: { tools: [], contact: ["ana@structural.example"] },
    mayNot: [],
    escalateWhen: null,
    doneWhen: "three engineers have said yes",
    budgetUsd: 750,
  },
  contractReadable: true,
  checkpoints: {
    plan: { mode: "manual", graduable: true },
    email: { mode: "manual", graduable: false },
    summary: { mode: "manual", graduable: false },
  },
  status: "running",
  createdBy: "eric@login.example",
  createdAt: 100,
  cancelledAt: null,
  cancelledBy: null,
  acceptedAt: null,
  acceptedBy: null,
  escalationWatchId: null,
  budgetMicros: 750_000_000,
  maxNodes: 8,
  spentMicros: 0,
  progress: { total: 5, pending: 2, running: 1, done: 2, failed: 0 },
  milestones: [],
};

const milestone = (over: Partial<Milestone>): Milestone => ({
  proposalId: "p1",
  kind: "goal-plan",
  checkpointClass: "plan",
  status: "pending",
  createdAt: 1,
  decidedAt: null,
  summary: "here is how I would do it",
  ...over,
});

describe("status never overstates what happened", () => {
  it("an open plan checkpoint says nothing has been created yet", () => {
    expect(statusLabel("awaiting-plan")).toContain("awaiting your approval");
    expect(statusNote({ ...base, status: "awaiting-plan" })).toContain("Nothing has been created yet");
  });

  it("every task finished is offered for acceptance, never declared complete", () => {
    const note = statusNote({ ...base, status: "done" });
    expect(note).toContain("three engineers have said yes");
    expect(note).toContain("yours to say");
  });

  it("the two AUTHORED verdicts name the person who made them", () => {
    expect(statusNote({ ...base, status: "cancelled", cancelledBy: "eric@login.example" })).toContain(
      "eric@login.example",
    );
    expect(statusNote({ ...base, status: "accepted", acceptedBy: "eric@login.example" })).toContain("done-when");
  });
});

describe("progress is counted, never stored", () => {
  it("says every bucket that has anything in it", () => {
    expect(progressLine(base)).toBe("2 of 5 done · 1 running · 2 waiting");
    expect(progressLine({ ...base, progress: { total: 0, pending: 0, running: 0, done: 0, failed: 0 } })).toBe(
      "No tasks yet.",
    );
    expect(progressLine({ ...base, progress: { ...base.progress, failed: 1 } })).toContain("1 failed");
  });
});

describe("which checkpoints still stop for me", () => {
  it("a manual class that CAN graduate says only that it stops", () => {
    expect(checkpointLine("plan", { mode: "manual", graduable: true })).toBe("The plan: stops for you every time.");
  });

  it("a manual class that cannot graduate says WHY — the line that keeps the toggle honest", () => {
    const line = checkpointLine("email", { mode: "manual", graduable: false });
    expect(line).toContain("cannot graduate yet");
    expect(line).toContain("through your approvals");
  });

  it("an automatic class names who widened it and says it no longer stops", () => {
    const line = checkpointLine("plan", { mode: "auto", graduable: true, by: "eric@login.example" });
    expect(line).toContain("eric@login.example");
    expect(line).toContain("no longer stops for you");
  });
});

describe("milestones are the goal's proposals, time-ordered", () => {
  it("reads each one as what it is and what became of it", () => {
    expect(milestoneLine(milestone({}))).toBe("the plan — waiting on you");
    expect(milestoneLine(milestone({ kind: "goal-outreach", status: "approved" }))).toBe("a message — approved");
    expect(milestoneLine(milestone({ kind: "goal-summary", status: "rejected" }))).toBe("the summary — declined");
    expect(milestoneLine(milestone({ status: "info-requested" }))).toContain("asked a question");
  });

  it("orders by when they happened, and finds the one open plan checkpoint", () => {
    const list = [milestone({ proposalId: "b", createdAt: 20 }), milestone({ proposalId: "a", createdAt: 10 })];
    expect(orderMilestones(list).map((m) => m.proposalId)).toEqual(["a", "b"]);
    const goal = { ...base, milestones: [milestone({ status: "approved" }), milestone({ proposalId: "open" })] };
    expect(openPlanCheckpoint(goal)?.proposalId).toBe("open");
    expect(openPlanCheckpoint({ ...base, milestones: [milestone({ status: "approved" })] })).toBeUndefined();
  });
});

describe("the roster reads live goals first", () => {
  it("settled goals sink, and the rest are newest first", () => {
    const list: Goal[] = [
      { ...base, id: "old", createdAt: 1 },
      { ...base, id: "cancelled", createdAt: 99, status: "cancelled" },
      { ...base, id: "new", createdAt: 50 },
    ];
    expect(orderGoals(list).map((g) => g.id)).toEqual(["new", "old", "cancelled"]);
  });
});
