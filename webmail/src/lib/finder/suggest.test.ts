import { describe, expect, it } from "vitest";
import type { FinderHit } from "./run";
import { chipLabel, newSession, refine, toSearchSpec, type FinderSession } from "./session";
import { MAX_SUGGESTIONS, SUGGEST_NOTE, applySuggestion, sharesNameWord, suggestRefinements } from "./suggest";

// s20 T5b — agent-directed refinement. The governing rule is the anti-star
// one: suggestions are OFFERS. So the properties under test are less about
// what gets suggested than about what a suggestion is allowed to be —
// something you can ignore for free, that never changes anything until you
// click, and that cannot silently narrow the find you are looking at.

const NOW = () => Date.parse("2026-08-15T12:00:00Z");

const hit = (o: Partial<FinderHit> & Pick<FinderHit, "id" | "receivedAt">): FinderHit => ({
  threadId: `t-${o.id}`,
  subject: "(no subject)",
  sender: "Someone",
  senderEmail: "someone@example.test",
  preview: "",
  hasAttachment: false,
  ...o,
});

const from = (n: number, sender: string, senderEmail: string, when: string): FinderHit[] =>
  Array.from({ length: n }, (_, i) =>
    hit({ id: `${senderEmail}-${i}-${when}`, sender, senderEmail, receivedAt: when }),
  );

const session = (query: string, chips: FinderSession["refinements"] = []): FinderSession =>
  chips.reduce(refine, newSession(query, NOW));

describe("suggestRefinements — offers, and only offers", () => {
  it("says nothing at all when there is nothing worth saying", () => {
    // A blank find, one result, one sender in one month: no offer is better
    // than a made-up one, and an empty strip renders as nothing.
    expect(suggestRefinements(session(""), [])).toEqual([]);
    expect(suggestRefinements(session("elk"), [hit({ id: "a", receivedAt: "2026-08-01T00:00:00Z" })])).toEqual([]);
    expect(suggestRefinements(session("elk"), from(6, "Grace", "grace@x.test", "2026-08-01T00:00:00Z"))).toEqual([]);
  });

  it("never offers a chip the chain already carries — an offer that does nothing is noise", () => {
    const hits = [
      ...from(8, "Sergio Ruiz", "sergio@x.test", "2026-08-01T00:00:00Z"),
      ...from(4, "Kim", "kim@x.test", "2026-08-02T00:00:00Z"),
    ];
    const withChip = session("permit", [{ kind: "from", value: "sergio@x.test" }]);
    expect(suggestRefinements(withChip, hits).some((s) => s.refinement.kind === "from")).toBe(false);
  });

  it("caps the strip — past three, a suggestion becomes a menu", () => {
    const hits = [
      ...from(4, "Sergio Ruiz", "sergio@x.test", "2026-03-02T00:00:00Z"),
      ...from(3, "Sergio's assistant", "asst@x.test", "2026-04-02T00:00:00Z"),
      ...from(3, "Kim", "kim@x.test", "2026-05-02T00:00:00Z"),
    ];
    const s = suggestRefinements(session("notes from sergio about the attached permit in March 2026"), hits);
    expect(s.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
  });

  it("every offer carries a reason a person can read", () => {
    const hits = [
      ...from(9, "Sergio Ruiz", "sergio@x.test", "2026-08-01T00:00:00Z"),
      ...from(3, "Kim", "kim@x.test", "2026-08-02T00:00:00Z"),
    ];
    for (const s of suggestRefinements(session("permit"), hits)) {
      expect(s.reason.length).toBeGreaterThan(10);
      expect(chipLabel(s.refinement).length).toBeGreaterThan(0);
    }
  });

  it("the strip's own note says the thing that matters most about a suggestion", () => {
    expect(SUGGEST_NOTE).toContain("ignore");
    expect(SUGGEST_NOTE).toContain("nothing is applied");
  });
});

describe("read out of the results — “from Sergio, not Sergio's assistant”", () => {
  const hits = [
    ...from(5, "Sergio Ruiz", "sergio@example.test", "2026-08-01T00:00:00Z"),
    ...from(4, "Sergio's assistant", "assistant@example.test", "2026-08-02T00:00:00Z"),
    ...from(3, "Grace", "grace@example.test", "2026-08-03T00:00:00Z"),
  ];

  it("names the collision and offers BOTH sides — a collision is a question, not a verdict", () => {
    const senders = suggestRefinements(session("elk permit"), hits).filter((s) => s.refinement.kind === "from");
    const values = senders.map((s) => (s.refinement.kind === "from" ? s.refinement.value : ""));
    expect(values).toEqual(["sergio@example.test", "assistant@example.test"]);
    expect(senders[0]!.reason).toContain("assistant@example.test");
    expect(senders[0]!.reason).toContain("rather than both");
  });

  it("a dominant sender with no twin is one observation, not a list", () => {
    const plain = [
      ...from(9, "Grace Hopper", "grace@example.test", "2026-08-01T00:00:00Z"),
      ...from(2, "Kim", "kim@example.test", "2026-08-02T00:00:00Z"),
    ];
    const senders = suggestRefinements(session("elk"), plain).filter((s) => s.refinement.kind === "from");
    expect(senders).toHaveLength(1);
    expect(senders[0]!.reason).toBe("9 of these 11 are from Grace Hopper <grace@example.test>.");
  });

  it("a result-derived offer can never empty your search — it is computed FROM the results", () => {
    const offers = suggestRefinements(session("elk permit"), hits).filter((s) => s.fromResults);
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      // The chip's own value is present in the set it was derived from, so
      // the narrowed query has at least one match by construction. This is the
      // promise a model could not make.
      const survivors = hits.filter((h) => keeps(offer.refinement, h));
      expect(survivors.length).toBeGreaterThan(0);
    }
  });

  it("shares a name word case-insensitively, and is not fooled by short words", () => {
    expect(sharesNameWord("Sergio Ruiz", "Sergio's assistant")).toBe(true);
    expect(sharesNameWord("Grace Hopper", "Kim Stanley")).toBe(false);
    // "the" is a stopword and two-letter words do not count — otherwise every
    // pair of names would "collide".
    expect(sharesNameWord("The Bank", "The Printer")).toBe(false);
  });
});

describe("read out of the results — “you probably mean these three months”", () => {
  it("offers the dominant month when the page piles into one", () => {
    const hits = [
      ...from(8, "Grace", "grace@x.test", "2026-08-01T00:00:00Z"),
      ...from(2, "Grace", "grace@x.test", "2026-02-01T00:00:00Z"),
    ];
    const window = suggestRefinements(session("elk"), hits).find((s) => s.refinement.kind === "window")!;
    expect(chipLabel(window.refinement)).toBe("Aug 2026");
    expect(window.reason).toBe("8 of these 10 landed in Aug 2026.");
  });

  it("offers the STRETCH when the results are in a run rather than a month", () => {
    const hits = [
      ...from(3, "Grace", "grace@x.test", "2026-06-10T00:00:00Z"),
      ...from(3, "Grace", "grace@x.test", "2026-07-10T00:00:00Z"),
      ...from(3, "Grace", "grace@x.test", "2026-08-10T00:00:00Z"),
      ...from(1, "Grace", "grace@x.test", "2024-01-10T00:00:00Z"),
    ];
    const window = suggestRefinements(session("elk"), hits).find((s) => s.refinement.kind === "window")!;
    expect(chipLabel(window.refinement)).toBe("Jun 2026 – Aug 2026");
    expect(window.reason).toContain("one 3-month stretch");
    // The window is a real half-open range over the whole run.
    if (window.refinement.kind === "window") {
      expect(window.refinement.after).toBe("2026-06-01T00:00:00.000Z");
      expect(window.refinement.before).toBe("2026-09-01T00:00:00.000Z");
    }
  });

  it("says nothing when the results are genuinely spread — narrowing by date is then the human's call", () => {
    const hits = [
      ...from(1, "Grace", "grace@x.test", "2021-01-10T00:00:00Z"),
      ...from(1, "Grace", "grace@x.test", "2022-05-10T00:00:00Z"),
      ...from(1, "Grace", "grace@x.test", "2023-09-10T00:00:00Z"),
      ...from(1, "Grace", "grace@x.test", "2024-11-10T00:00:00Z"),
      ...from(1, "Grace", "grace@x.test", "2026-03-10T00:00:00Z"),
    ];
    expect(suggestRefinements(session("elk"), hits).filter((s) => s.refinement.kind === "window")).toEqual([]);
  });

  it("an unparseable date is dropped, never invented into a month", () => {
    const hits = [
      ...from(4, "Grace", "grace@x.test", "2026-08-01T00:00:00Z"),
      hit({ id: "junk", receivedAt: "sometime last year", sender: "Grace", senderEmail: "grace@x.test" }),
    ];
    // One readable month left → nothing to choose between, so no window offer.
    expect(suggestRefinements(session("elk"), hits).filter((s) => s.refinement.kind === "window")).toEqual([]);
  });
});

describe("read out of the question — the plain-language half", () => {
  it("offers to read “from sergio” as a sender, and says what it will do to your words", () => {
    // The case the whole half exists for: as full text this matches messages
    // with the literal word "sergio" in the BODY, which is not what was meant.
    const offer = suggestRefinements(session("what did sergio say from sergio about the elk permit"), [])[0]!;
    expect(offer.refinement).toEqual({ kind: "from", value: "sergio" });
    expect(offer.fromResults).toBe(false);
    expect(offer.reason).toContain("from sergio");
    expect(offer.reason).toContain("sender");
    expect(offer.query).toBe("what did sergio say about the elk permit");
  });

  it("works with zero results — which is exactly when a plain-language question needs it", () => {
    // A sentence run as full text usually matches nothing. If the suggester
    // only read the RESULTS it would be silent in the one case it is for.
    const offers = suggestRefinements(session("the permit from sergio in March 2026"), []);
    expect(offers.map((s) => s.refinement.kind)).toEqual(["from", "window"]);
  });

  it("refuses a month with no year — picking which year is exactly the invention this module will not do", () => {
    expect(suggestRefinements(session("the permit in March"), [])).toEqual([]);
  });

  it("refuses a vague stretch of time outright — a wrong bound that LOOKS authoritative is worse than none", () => {
    expect(suggestRefinements(session("what sergio said last summer"), [])).toEqual([]);
  });

  it("does not read a stopword as a person", () => {
    expect(suggestRefinements(session("the receipt from the printer"), [])).toEqual([]);
  });

  it("offers has-attachment when the question says so, and lifts the word out", () => {
    const offer = suggestRefinements(session("the permit sergio attached"), [])[0]!;
    expect(offer.refinement).toEqual({ kind: "attachment" });
    expect(offer.query).toBe("the permit sergio");
  });
});

describe("applySuggestion — accepting one is an ORDINARY chip, and nothing more", () => {
  it("goes through refine(), so an accepted offer is indistinguishable from a typed one", () => {
    const base = session("elk permit");
    const offer = suggestRefinements(session("elk permit from sergio"), [])[0]!;
    const next = applySuggestion(base, offer);
    expect(next.refinements).toEqual([{ kind: "from", value: "sergio" }]);
    // Removable exactly like every other chip — array edits on native
    // structure, no privileged agent state anywhere.
    expect(next.refinements).toHaveLength(1);
    expect(toSearchSpec(next).from).toBe("sergio");
  });

  it("rewrites the free text only when the offer said it would", () => {
    const base = session("elk permit from sergio");
    const withQuery = suggestRefinements(base, [])[0]!;
    expect(applySuggestion(base, withQuery).query).toBe("elk permit");

    const hits = [
      ...from(9, "Grace Hopper", "grace@x.test", "2026-08-01T00:00:00Z"),
      ...from(2, "Kim", "kim@x.test", "2026-08-02T00:00:00Z"),
    ];
    const plain = session("elk");
    const noQuery = suggestRefinements(plain, hits).find((s) => s.fromResults)!;
    expect(noQuery.query).toBeUndefined();
    expect(applySuggestion(plain, noQuery).query).toBe("elk");
  });

  it("is the ONLY mutation — computing suggestions never touches the session", () => {
    const base = session("elk permit from sergio");
    const snapshot = JSON.stringify(base);
    suggestRefinements(base, from(9, "Grace", "grace@x.test", "2026-08-01T00:00:00Z"));
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it("replaces same-kind rather than intersecting — moving a window, not emptying it", () => {
    const base = session("elk", [{ kind: "window", label: "Jul 2026", after: "a", before: "b" }]);
    const hits = [
      ...from(8, "Grace", "grace@x.test", "2026-08-01T00:00:00Z"),
      ...from(2, "Grace", "grace@x.test", "2026-02-01T00:00:00Z"),
    ];
    const offer = suggestRefinements(base, hits).find((s) => s.refinement.kind === "window")!;
    const next = applySuggestion(base, offer);
    expect(next.refinements).toHaveLength(1);
    expect(chipLabel(next.refinements[0]!)).toBe("Aug 2026");
  });
});

/** Would this chip keep that hit? Only the facets a hit can answer locally —
 *  enough for the non-empty guarantee above. */
function keeps(r: FinderSession["refinements"][number], h: FinderHit): boolean {
  switch (r.kind) {
    case "from":
      return h.senderEmail.toLowerCase().includes(r.value.toLowerCase());
    case "window": {
      const ms = Date.parse(h.receivedAt);
      return ms >= Date.parse(r.after) && ms < Date.parse(r.before);
    }
    case "attachment":
      return h.hasAttachment;
    default:
      return true;
  }
}
