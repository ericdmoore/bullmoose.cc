import { describe, expect, it } from "vitest";
import {
  chipLabel,
  describeSession,
  isBlank,
  newSession,
  refine,
  removeRefinement,
  retract,
  toSearchSpec,
  type FinderRefinement,
  type FinderSession,
} from "./session";

// The Finder session model (s20 T5): a directed find is a query plus an
// ordered refinement chain. These tests hold the chain's algebra — one chip
// per kind, individually removable, compiling to the SAME SearchSpec the
// mail surface builds — because the island renders chips and decides nothing.

const NOW = () => Date.parse("2026-08-15T12:00:00Z");

describe("newSession", () => {
  it("trims the query and stamps the injected clock", () => {
    const s = newSession("  elk  ", NOW);
    expect(s.query).toBe("elk");
    expect(s.startedAt).toBe("2026-08-15T12:00:00.000Z");
    expect(s.refinements).toEqual([]);
    expect(s.lastRunAt).toBeUndefined();
  });

  it("mints distinct ids even within one clock tick", () => {
    expect(newSession("a", NOW).id).not.toBe(newSession("a", NOW).id);
  });
});

describe("refine — the chain's algebra", () => {
  const base = newSession("elk", NOW);

  it("appends, oldest first", () => {
    const s = refine(refine(base, { kind: "from", value: "grace" }), { kind: "attachment" });
    expect(s.refinements.map((r) => r.kind)).toEqual(["from", "attachment"]);
  });

  it("REPLACES a same-kind chip and moves it to the end — 'Aug' over 'Jul' means move the window, not intersect to nothing", () => {
    const jul: FinderRefinement = {
      kind: "window",
      label: "Jul 2026",
      after: "2026-07-01T00:00:00.000Z",
      before: "2026-08-01T00:00:00.000Z",
    };
    const aug: FinderRefinement = {
      kind: "window",
      label: "Aug 2026",
      after: "2026-08-01T00:00:00.000Z",
      before: "2026-09-01T00:00:00.000Z",
    };
    const s = refine(refine(refine(base, jul), { kind: "attachment" }), aug);
    expect(s.refinements).toEqual([{ kind: "attachment" }, aug]);
  });

  it("keeps from and to as distinct kinds that coexist", () => {
    const s = refine(refine(base, { kind: "from", value: "grace" }), { kind: "to", value: "eric" });
    expect(s.refinements).toHaveLength(2);
  });

  it("never mutates the input session", () => {
    refine(base, { kind: "attachment" });
    expect(base.refinements).toEqual([]);
  });
});

describe("backing out — array edits, never history", () => {
  const chained = refine(refine(newSession("elk", NOW), { kind: "from", value: "grace" }), { kind: "attachment" });

  it("removes one chip by index", () => {
    expect(removeRefinement(chained, 0).refinements).toEqual([{ kind: "attachment" }]);
    expect(removeRefinement(chained, 1).refinements).toEqual([{ kind: "from", value: "grace" }]);
  });

  it("retracts the last chip", () => {
    expect(retract(chained).refinements).toEqual([{ kind: "from", value: "grace" }]);
  });
});

describe("isBlank", () => {
  it("is blank with no text and no chips — running it would be browsing, not finding", () => {
    expect(isBlank(newSession("", NOW))).toBe(true);
    expect(isBlank(newSession("   ", NOW))).toBe(true);
  });

  it("a chip alone is a legitimate find ('everything from grace in July')", () => {
    expect(isBlank(refine(newSession("", NOW), { kind: "from", value: "grace" }))).toBe(false);
    expect(isBlank(newSession("elk", NOW))).toBe(false);
  });
});

describe("toSearchSpec — compiles to the spec /mail's search builds", () => {
  it("maps every kind onto a condition the server implements", () => {
    let s = newSession("elk", NOW);
    s = refine(s, { kind: "from", value: "grace" });
    s = refine(s, { kind: "to", value: "eric" });
    s = refine(s, { kind: "mailbox", id: "mb-inbox", name: "Inbox" });
    s = refine(s, {
      kind: "window",
      label: "Jul 2026",
      after: "2026-07-01T00:00:00.000Z",
      before: "2026-08-01T00:00:00.000Z",
    });
    s = refine(s, { kind: "attachment" });
    expect(toSearchSpec(s)).toEqual({
      text: "elk",
      from: "grace",
      to: "eric",
      inMailbox: "mb-inbox",
      after: "2026-07-01T00:00:00.000Z",
      before: "2026-08-01T00:00:00.000Z",
      hasAttachment: true,
    });
  });

  it("omits the text clause when the query is empty", () => {
    const s = refine(newSession("", NOW), { kind: "attachment" });
    expect(toSearchSpec(s)).toEqual({ hasAttachment: true });
  });
});

describe("chip and session labels", () => {
  it("names each chip kind", () => {
    expect(chipLabel({ kind: "from", value: "grace" })).toBe("from: grace");
    expect(chipLabel({ kind: "to", value: "eric" })).toBe("to: eric");
    expect(chipLabel({ kind: "mailbox", id: "x", name: "Inbox" })).toBe("in: Inbox");
    expect(chipLabel({ kind: "window", label: "Aug 2026", after: "a", before: "b" })).toBe("Aug 2026");
    expect(chipLabel({ kind: "attachment" })).toBe("has attachment");
  });

  it("summarises a session as query + filter count", () => {
    const s: FinderSession = refine(refine(newSession("elk", NOW), { kind: "attachment" }), {
      kind: "from",
      value: "g",
    });
    expect(describeSession(newSession("elk", NOW))).toBe("elk");
    expect(describeSession(retract(s))).toBe("elk +1 filter");
    expect(describeSession(s)).toBe("elk +2 filters");
    expect(describeSession(newSession("", NOW))).toBe("(no text)");
  });
});
