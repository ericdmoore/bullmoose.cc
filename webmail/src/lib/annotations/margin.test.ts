import { describe, expect, it } from "vitest";
import type { Annotation } from "./types";
import { classLabel, marginFor, personOpenItems, speakClaim, statusLabel, voiceFor, whyLine } from "./margin";

// s18 A3 — the margin's presentation logic. The properties under test are the
// design rules themselves: confidence is VOICE (never a number), a NULL
// rationale is "not stated" (never invented), and an anchor binds to the
// ORIGINAL message (a quoted copy never grows a duplicate).

function anno(id: string, over: Partial<Annotation> = {}): Annotation {
  return {
    id,
    accountId: "acct",
    authorKind: "agent",
    author: "scribe",
    anchor: { realm: "Email", objectId: "e1" },
    class: "commitment",
    body: `claim ${id}`,
    confidence: 0.7,
    status: "open",
    rationale: null,
    sourceRef: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

describe("voiceFor", () => {
  it("NULL confidence asserts — certain (human-filed, or a deterministic detector), not estimated", () => {
    expect(voiceFor(null)).toBe("assert");
  });
  it("≥0.9 asserts plainly", () => {
    expect(voiceFor(0.9)).toBe("assert");
    expect(voiceFor(0.95)).toBe("assert");
  });
  it("0.6–0.9 sounds like", () => {
    expect(voiceFor(0.6)).toBe("sounds");
    expect(voiceFor(0.89)).toBe("sounds");
  });
  it("<0.6 hedges", () => {
    expect(voiceFor(0.59)).toBe("might");
    expect(voiceFor(0)).toBe("might");
  });
});

describe("speakClaim", () => {
  it("asserts a high-confidence claim untouched — no hedge, no number", () => {
    expect(speakClaim("You told Bob you'd send the calc Friday", 0.95)).toBe("You told Bob you'd send the calc Friday");
    expect(speakClaim("Waiting on Sergio's reply", null)).toBe("Waiting on Sergio's reply");
  });
  it("mid confidence reads 'Sounds like …', folding the claim into the sentence", () => {
    expect(speakClaim("You told Bob you'd send the calc Friday", 0.7)).toBe(
      "Sounds like you told Bob you'd send the calc Friday",
    );
  });
  it("low confidence hedges", () => {
    expect(speakClaim("Invoice 0042 wants paying", 0.3)).toBe("Might be nothing, but invoice 0042 wants paying");
  });
  it("keeps 'I' and I-contractions capitalized inside a hedge", () => {
    expect(speakClaim("I'll send the calc Friday", 0.7)).toBe("Sounds like I'll send the calc Friday");
    expect(speakClaim("I promised a reply", 0.7)).toBe("Sounds like I promised a reply");
  });
  it("keeps an acronym-led claim capitalized inside a hedge", () => {
    expect(speakClaim("IRS wants a reply by June", 0.7)).toBe("Sounds like IRS wants a reply by June");
  });
});

describe("whyLine", () => {
  it("a NULL rationale renders 'not stated' — never invented", () => {
    expect(whyLine(null)).toBe("Why: not stated");
    expect(whyLine("   ")).toBe("Why: not stated");
  });
  it("a stated rationale renders verbatim", () => {
    expect(whyLine("“I'll get it to you Friday.”")).toBe("Why: “I'll get it to you Friday.”");
  });
});

describe("labels", () => {
  it("classLabel covers the closed vocabulary and survives an unknown class", () => {
    expect(classLabel("commitment")).toBe("Commitment");
    expect(classLabel("decision")).toBe("Decision");
    expect(classLabel("task")).toBe("Task");
    expect(classLabel("hunch")).toBe("Hunch");
  });
  it("statusLabel names the dismissal for what it is — the labeled negative", () => {
    expect(statusLabel("resolved")).toBe("Resolved");
    expect(statusLabel("dismissed")).toBe("Dismissed — not a real one");
  });
});

describe("marginFor", () => {
  it("groups under the ORIGINAL message only — an anchor outside the thread never renders", () => {
    const rows = [
      anno("a", { anchor: { realm: "Email", objectId: "e1" } }),
      anno("b", { anchor: { realm: "Email", objectId: "e2" } }),
      anno("elsewhere", { anchor: { realm: "Email", objectId: "e-other-thread" } }),
      anno("not-mail", { anchor: { realm: "Watch", objectId: "e1" } }),
      anno("unanchored", { anchor: null }),
    ];
    const m = marginFor(rows, ["e1", "e2"]);
    expect([...m.keys()].sort()).toEqual(["e1", "e2"]);
    expect(m.get("e1")!.map((a) => a.id)).toEqual(["a"]);
    expect(m.get("e2")!.map((a) => a.id)).toEqual(["b"]);
  });

  it("never duplicates: the same id reported twice renders once", () => {
    const twice = anno("dup");
    const m = marginFor([twice, { ...twice }], ["e1"]);
    expect(m.get("e1")!.map((a) => a.id)).toEqual(["dup"]);
  });

  it("orders a message's notes: open first (they carry verbs), then closed, each oldest-first", () => {
    const rows = [
      anno("closed-old", { status: "dismissed", createdAt: 100 }),
      anno("open-new", { createdAt: 900 }),
      anno("open-old", { createdAt: 200 }),
      anno("closed-new", { status: "resolved", createdAt: 800 }),
    ];
    expect(
      marginFor(rows, ["e1"])
        .get("e1")!
        .map((a) => a.id),
    ).toEqual(["open-old", "open-new", "closed-old", "closed-new"]);
  });
});

describe("personOpenItems", () => {
  it("keeps only OPEN commitments and tasks anchored in this thread, newest first", () => {
    const rows = [
      anno("commit", { class: "commitment", createdAt: 100 }),
      anno("task", { class: "task", createdAt: 300 }),
      anno("decision", { class: "decision" }),
      anno("dismissed", { class: "commitment", status: "dismissed" }),
      anno("other-thread", { class: "task", anchor: { realm: "Email", objectId: "ex" } }),
    ];
    expect(personOpenItems(rows, ["e1"]).map((a) => a.id)).toEqual(["task", "commit"]);
  });
});
