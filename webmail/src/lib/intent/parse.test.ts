import { describe, expect, it } from "vitest";
import { draftLooksBlank, intentClauses, parseIntent } from "./parse";

// s20 T3 — the intent parse. Free, instant, deterministic, and shown back to
// the human as an editable plan, which is why it is allowed to be shallow: a
// miss costs a correction, and a name it cannot find is asked for rather than
// guessed at.

describe("parseIntent — the plan's acceptance sentence", () => {
  const SENTENCE =
    "ask Sergio whether he's comfortable with me selling assembled boards — supportive tone, no big commitment";

  it("reads the recipient, the tone and the limit out of it", () => {
    const plan = parseIntent(SENTENCE);
    expect(plan.who).toBe("Sergio");
    expect(plan.whoIsAddress).toBe(false);
    expect(plan.tone).toBe("supportive");
    expect(plan.constraints).toEqual(["no big commitment"]);
  });

  it("keeps the sentence verbatim — the agent is given what the human said", () => {
    expect(parseIntent(SENTENCE).raw).toBe(SENTENCE);
  });
});

describe("parseIntent — who", () => {
  it("takes an address in the sentence over any name in it", () => {
    const plan = parseIntent("ask Sergio at sergio.ramos@boards.example whether he minds");
    expect(plan.who).toBe("sergio.ramos@boards.example");
    expect(plan.whoIsAddress).toBe(true);
  });

  it("reads a lowercase sentence without swallowing the next word", () => {
    expect(parseIntent("ask sergio whether he's comfortable").who).toBe("sergio");
  });

  it("joins a capitalised surname, and only a capitalised one", () => {
    expect(parseIntent("email Dana Ruiz about the invoice").who).toBe("Dana Ruiz");
    expect(parseIntent("email Dana about the invoice").who).toBe("Dana");
  });

  it("handles the shapes people actually type", () => {
    expect(parseIntent("let Sam know the boards shipped").who).toBe("Sam");
    expect(parseIntent("follow up with Priya on the quote").who).toBe("Priya");
    expect(parseIntent("write to Sergio, gently").who).toBe("Sergio");
    expect(parseIntent("Ask Sergio whether he minds").who).toBe("Sergio");
  });

  it("refuses to call a pronoun a person", () => {
    expect(parseIntent("tell them we are ready").who).toBeNull();
    expect(parseIntent("ask everyone about Friday").who).toBeNull();
  });

  it("names nobody when the sentence names nobody", () => {
    expect(parseIntent("draft something about the board quote").who).toBeNull();
    expect(parseIntent("").who).toBeNull();
  });
});

describe("parseIntent — tone", () => {
  it("reads '<word> tone', 'tone: <word>' and a bare tone clause", () => {
    expect(parseIntent("ask Sergio — supportive tone").tone).toBe("supportive");
    expect(parseIntent("ask Sergio, tone: formal").tone).toBe("formal");
    expect(parseIntent("ask Sergio — warm").tone).toBe("warm");
    expect(parseIntent("ask Sergio in a friendly way").tone).toBe("friendly");
  });

  it("does not mistake prose for a register", () => {
    expect(parseIntent("ask Sergio about the warm-up run").tone).toBeNull();
    expect(parseIntent("tell Dana the tone of the last email was wrong").tone).toBeNull();
  });
});

describe("parseIntent — limits", () => {
  it("collects the clauses that set one, in the human's own words", () => {
    const plan = parseIntent("ask Sergio about the boards — no big commitment, don't mention the price");
    expect(plan.constraints).toEqual(["no big commitment", "don't mention the price"]);
  });

  it("does not turn the ask itself into a limit", () => {
    expect(parseIntent("tell Sam the shipment is late").constraints).toEqual([]);
  });

  it("caps the list rather than growing without bound", () => {
    const many = ["ask Sergio", ...Array.from({ length: 9 }, (_, i) => `no thing${i}`)].join(", ");
    expect(parseIntent(many).constraints).toHaveLength(6);
  });
});

describe("intentClauses", () => {
  it("splits on the punctuation people actually steer with", () => {
    expect(intentClauses("ask Sergio — supportive tone, no big commitment")).toEqual([
      "ask Sergio",
      "supportive tone",
      "no big commitment",
    ]);
  });
});

describe("draftLooksBlank — the rule that decides the DEFAULT mode", () => {
  const blank = { to: [], cc: [], bcc: [], subject: "", text: "" };

  it("is blank when nothing has been typed and nobody addressed", () => {
    expect(draftLooksBlank(blank)).toBe(true);
  });

  it("counts a signature as blank — configuring one must not cost you the mode", () => {
    expect(draftLooksBlank({ ...blank, text: "\n\n-- \nEric Moore\nbullmoose.cc\n" })).toBe(true);
  });

  // s20 T3 constraint 1: intent mode is NEVER the default over a draft someone
  // is already writing. A reply, a forward and a resumed draft all fail here.
  it("is not blank once there is a recipient, a subject or a word of prose", () => {
    expect(draftLooksBlank({ ...blank, to: [{ name: null, email: "a@b.c" }] })).toBe(false);
    expect(draftLooksBlank({ ...blank, subject: "Re: the board quote" })).toBe(false);
    expect(draftLooksBlank({ ...blank, text: "Sergio,\n\nthanks for the quote\n\n-- \nEric" })).toBe(false);
    expect(draftLooksBlank({ ...blank, cc: [{ name: null, email: "c@d.e" }] })).toBe(false);
  });
});
