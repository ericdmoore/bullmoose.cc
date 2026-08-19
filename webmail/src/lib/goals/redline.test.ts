import { describe, expect, it } from "vitest";
import {
  redlineActionLabel,
  redlineActionNote,
  redlineDecision,
  rowsChanged,
  rowsToTasks,
  sketchToRows,
  type RedlineRow,
} from "./redline";
import { contactAllowed, budgetLine, contractLines } from "./contract";
import type { GoalContract, PlanPayload } from "./types";

/**
 * s20 T6 — "edit IS approval, inline" (readme principle 6), as rules.
 *
 * The claim under test is a claim about the DATA MODEL, not about a widget:
 * whichever way a redline goes, the call it produces is one of the two ordinary
 * `ActionProposal/set` verbs — so the same proposal, decision and provenance
 * rows are written as if it had gone through the queue. The venue moves; the
 * ledger does not.
 */

const CONTRACT: GoalContract = {
  may: { tools: [], contact: ["ana@structural.example", "@structural.example"] },
  mayNot: ["commit me to a date"],
  escalateWhen: { afterMs: 3 * 86_400_000 },
  doneWhen: "three engineers have said yes",
  budgetUsd: 750,
};

const PAYLOAD: PlanPayload = {
  goalId: "job_attic",
  statement: "get three structural engineers willing to evaluate the attic",
  tasks: [
    { key: "reach-1", context: { kind: "job-node", op: "outreach", to: "ana@structural.example" } },
    { key: "reach-2", context: { kind: "job-node", op: "outreach", to: "bo@structural.example" } },
    { key: "compile", needs: ["reach-1", "reach-2"], context: { kind: "job-node", op: "summarize" } },
  ],
};

const rows = () => sketchToRows(PAYLOAD);

describe("reading and writing the sketch", () => {
  it("reads each task into an editable row", () => {
    const r = rows();
    expect(r.map((x) => x.key)).toEqual(["reach-1", "reach-2", "compile"]);
    expect(r[0]!.op).toBe("outreach");
    expect(r[0]!.to).toBe("ana@structural.example");
    expect(r[2]!.needs).toEqual(["reach-1", "reach-2"]);
  });

  it("a payload it cannot read yields no rows rather than a pretend sketch", () => {
    expect(sketchToRows(null)).toEqual([]);
    expect(sketchToRows({ tasks: "everything" } as PlanPayload)).toEqual([]);
  });

  it("striking a task also prunes the needs that pointed at it", () => {
    // A join left waiting on a task nobody will create blocks forever, and the
    // human who struck one message out did not mean to wedge the summary.
    const edited = rows().map((r) => (r.key === "reach-2" ? { ...r, dropped: true } : r));
    const tasks = rowsToTasks(edited, PAYLOAD);
    expect(tasks.map((t) => t.key)).toEqual(["reach-1", "compile"]);
    expect(tasks[1]!.needs).toEqual(["reach-1"]);
  });

  it("a redline AMENDS: everything the agent wrote rides through untouched", () => {
    const edited = rows().map((r) => (r.key === "reach-1" ? { ...r, to: "cy@structural.example" } : r));
    const tasks = rowsToTasks(edited, PAYLOAD);
    expect(tasks[0]!.context).toEqual({ kind: "job-node", op: "outreach", to: "cy@structural.example" });
  });
});

describe("an edit that leaves nothing unresolved IS the approval", () => {
  it("an untouched sketch approves CLEAN — no editedPayload", () => {
    const decision = redlineDecision({ rows: rows(), payload: PAYLOAD, contract: CONTRACT });
    expect(decision.problems).toEqual([]);
    expect(decision.verb).toBe("approve");
    // "Approved clean" and "approved after edit" are different outcomes with
    // different meanings; opening the editor must not move a row between them.
    expect(decision.editedPayload).toBeUndefined();
    expect(redlineActionLabel(decision)).toBe("Approve the plan");
  });

  it("a redline approves WITH the edit — and there is no second confirm step", () => {
    const edited = rows().map((r) => (r.key === "reach-2" ? { ...r, dropped: true } : r));
    const decision = redlineDecision({ rows: edited, payload: PAYLOAD, contract: CONTRACT });
    expect(decision.verb).toBe("approve");
    expect(decision.editedPayload!.tasks as unknown[]).toHaveLength(2);
    // The original payload's other fields ride along — the server matches the
    // payload's goalId against the planner's own Job.
    expect(decision.editedPayload!.goalId).toBe("job_attic");
    expect(redlineActionLabel(decision)).toBe("Approve these changes");
    expect(redlineActionNote(decision)).toContain("IS the approval");
  });

  it("rowsChanged is the whole test of `did anything move`", () => {
    expect(rowsChanged(rows(), PAYLOAD)).toBe(false);
    expect(
      rowsChanged(
        rows().map((r) => ({ ...r, to: r.to })),
        PAYLOAD,
      ),
    ).toBe(false);
    expect(
      rowsChanged(
        rows().map((r, i) => (i === 0 ? { ...r, to: "x@structural.example" } : r)),
        PAYLOAD,
      ),
    ).toBe(true);
  });
});

describe("an edit that leaves an open question is the needsInfo cycle", () => {
  it("a typed question routes to needsInfo, carrying no verdict and no edit", () => {
    const decision = redlineDecision({
      rows: rows(),
      payload: PAYLOAD,
      contract: CONTRACT,
      question: "who is the third engineer?",
    });
    expect(decision.verb).toBe("needsInfo");
    expect(decision.question).toBe("who is the third engineer?");
    // The server refuses a decision on this verb precisely so needsInfo can
    // never produce a rejection record; this module never builds one.
    expect(decision.editedPayload).toBeUndefined();
    expect(redlineActionLabel(decision)).toBe("Ask the planner");
    expect(redlineActionNote(decision)).toContain("Nothing is created");
  });

  it("whitespace is not a question", () => {
    expect(redlineDecision({ rows: rows(), payload: PAYLOAD, contract: CONTRACT, question: "   " }).verb).toBe(
      "approve",
    );
  });
});

describe("problems are refusals, not questions — said before the round trip", () => {
  it("refuses a recipient outside the goal's contract, naming the reach", () => {
    const edited = rows().map((r) => (r.key === "reach-1" ? { ...r, to: "stranger@elsewhere.example" } : r));
    const decision = redlineDecision({ rows: edited, payload: PAYLOAD, contract: CONTRACT });
    expect(decision.problems).toHaveLength(1);
    expect(decision.problems[0]).toContain("outside this goal");
    expect(decision.problems[0]).toContain("ana@structural.example");
  });

  it("refuses an outreach with no address at all", () => {
    const edited = rows().map((r) => (r.key === "reach-1" ? { ...r, to: "  " } : r));
    expect(redlineDecision({ rows: edited, payload: PAYLOAD, contract: CONTRACT }).problems[0]).toContain("reach-1");
  });

  it("striking EVERY task is something to undo, never something to ask about", () => {
    const edited: RedlineRow[] = rows().map((r) => ({ ...r, dropped: true }));
    const decision = redlineDecision({ rows: edited, payload: PAYLOAD, contract: CONTRACT });
    expect(decision.problems[0]).toContain("no workflow left");
  });

  it("a goal whose contract cannot be read still lets a redline through — the server is the enforcement", () => {
    const edited = rows().map((r) => (r.key === "reach-1" ? { ...r, to: "stranger@elsewhere.example" } : r));
    expect(redlineDecision({ rows: edited, payload: PAYLOAD, contract: null }).problems).toEqual([]);
  });
});

describe("the client's copy of the contact rule agrees with the server's", () => {
  // The same table `packages/scheduling/src/goalContract.test.ts` walks. Two
  // copies exist on purpose (see contract.ts); this is what keeps them honest.
  it.each([
    [["ana@structural.example"], "ana@structural.example", true],
    [["ana@structural.example"], "ANA@Structural.Example", true],
    [["@structural.example"], "bo@structural.example", true],
    [["@structural.example"], "bo@notstructural.example", false],
    [["ana@structural.example"], "ana@structural.example.attacker.test", false],
    [[], "anyone@anywhere.test", false],
    [["@x.test"], "not-an-address", false],
  ])("%s admits %s → %s", (patterns, address, expected) => {
    expect(contactAllowed(patterns as string[], address as string)).toBe(expected);
  });
});

describe("the contract, rendered", () => {
  it("says all four clauses, and renders may-not VERBATIM", () => {
    const lines = contractLines(CONTRACT);
    expect(lines.map((l) => l.label)).toEqual(["May", "May not", "Escalate when", "Done when"]);
    expect(lines[1]!.value).toContain("commit me to a date");
    expect(lines[3]!.value).toBe("three engineers have said yes");
  });

  it("an unreadable contract says its bounds are UNKNOWN rather than showing blanks", () => {
    expect(contractLines(null)[0]!.value).toContain("unknown");
  });

  it("the spend line refuses to imply it bounds what anyone may promise", () => {
    expect(budgetLine(750_000_000, 12_500)).toContain("not money promised to anyone");
    expect(budgetLine(null, 0)).toContain("no aggregate bound");
  });
});
