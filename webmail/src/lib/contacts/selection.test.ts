import { describe, expect, it } from "vitest";
import {
  DELETE_VERB,
  MOVE_VERB,
  confirmDeleteCards,
  describeBatchOutcome,
  describeSelection,
  headerCheck,
  retainSelected,
  toggleAll,
  toggleSelected,
} from "./selection";

// s34 — the bulk selection model, tested where it lives: plain Node, no DOM.
// The island holds a Set and renders checkboxes; every RULE about what that
// Set may mean is here, because the two rules that matter (what "select all"
// covers over a paged list, and that an outcome is never a bare "done") are
// invisible to a DOM query and unrecoverable when wrong — there is no trash
// for a contact.

const ids = (...xs: string[]) => new Set(xs);

describe("toggleSelected", () => {
  it("adds what is absent and removes what is present, without mutating", () => {
    const before = ids("a", "b");
    const added = toggleSelected(before, "c");
    expect([...added].sort()).toEqual(["a", "b", "c"]);
    expect([...before].sort()).toEqual(["a", "b"]);
    expect([...toggleSelected(added, "a")].sort()).toEqual(["b", "c"]);
  });
});

describe("headerCheck — the three states of the select-all box", () => {
  const visible = ["a", "b", "c"];

  it("none when nothing on screen is selected", () => {
    expect(headerCheck(visible, ids())).toBe("none");
    expect(headerCheck(visible, ids("z"))).toBe("none");
  });

  it("some — the INDETERMINATE state — when part of the screen is selected", () => {
    expect(headerCheck(visible, ids("b"))).toBe("some");
    expect(headerCheck(visible, ids("a", "c"))).toBe("some");
  });

  it("all when every visible row is selected, extras notwithstanding", () => {
    expect(headerCheck(visible, ids("a", "b", "c"))).toBe("all");
    expect(headerCheck(visible, ids("a", "b", "c", "off-screen"))).toBe("all");
  });

  it("an EMPTY list is none, not the vacuous all", () => {
    // `[].every(...)` is true, which would tick select-all above no rows and
    // arm Delete for a selection that does not exist.
    expect(headerCheck([], ids())).toBe("none");
    expect(headerCheck([], ids("a"))).toBe("none");
  });
});

describe("toggleAll", () => {
  const visible = ["a", "b", "c"];

  it("selects every visible row from none, and from the indeterminate middle", () => {
    expect([...toggleAll(visible, ids())].sort()).toEqual(["a", "b", "c"]);
    expect([...toggleAll(visible, ids("b"))].sort()).toEqual(["a", "b", "c"]);
  });

  it("clears the visible rows when they are all selected", () => {
    expect([...toggleAll(visible, ids("a", "b", "c"))]).toEqual([]);
  });

  it("never touches ids that are selected but not on screen", () => {
    // Paging in more rows then hitting select-all must not silently discard a
    // selection made three pages up — in either direction.
    expect([...toggleAll(visible, ids("page1"))].sort()).toEqual(["a", "b", "c", "page1"]);
    expect([...toggleAll(visible, ids("a", "b", "c", "page1"))]).toEqual(["page1"]);
  });

  it("round-trips: select-all then select-all again is where it started", () => {
    const start = ids("page1");
    expect([...toggleAll(visible, toggleAll(visible, start))]).toEqual([...start]);
  });
});

describe("retainSelected — what survives a partial failure", () => {
  it("keeps only the named ids", () => {
    expect([...retainSelected(ids("a", "b", "c"), ["b", "c"])].sort()).toEqual(["b", "c"]);
  });

  it("ignores names that were never selected", () => {
    expect([...retainSelected(ids("a"), ["a", "ghost"])]).toEqual(["a"]);
  });

  it("an empty retain is an empty selection", () => {
    expect([...retainSelected(ids("a", "b"), [])]).toEqual([]);
  });
});

describe("describeSelection", () => {
  it("says nothing grandiose about nothing", () => {
    expect(describeSelection(0)).toBe("None selected");
  });

  it("counts, with thousands separators — the numbers here are four digits", () => {
    expect(describeSelection(1)).toBe("1 selected");
    expect(describeSelection(3557)).toBe("3,557 selected");
  });

  it("names the LOADED denominator, never the total match count", () => {
    // The list is paged over a full-scan query: "412 of 1,203 loaded" is true,
    // "412 of 3,557" would imply a selection the screen cannot have made.
    expect(describeSelection(412, 1203)).toBe("412 of 1,203 loaded selected");
    // Everything loaded is selected — no denominator worth printing.
    expect(describeSelection(50, 50)).toBe("50 selected");
  });
});

describe("confirmDeleteCards — the prompt that has to carry the number", () => {
  it("states the EXACT count in the first line", () => {
    expect(confirmDeleteCards(412).split("\n")[0]).toBe("Delete 412 contacts?");
    expect(confirmDeleteCards(3557).split("\n")[0]).toBe("Delete 3,557 contacts?");
  });

  it("agrees with itself about one", () => {
    expect(confirmDeleteCards(1).split("\n")[0]).toBe("Delete 1 contact?");
  });

  it("says there is no undo, because there is no trash for a card", () => {
    expect(confirmDeleteCards(2)).toMatch(/cannot be undone/);
    expect(confirmDeleteCards(2)).toMatch(/trash/);
  });
});

describe("describeBatchOutcome — never a bare “done”", () => {
  const fail = (id: string, message: string) => ({ id, message });

  it("a clean run counts what it did", () => {
    expect(describeBatchOutcome(DELETE_VERB, { done: ["a", "b"], failed: [] })).toBe("Deleted 2 contacts.");
    expect(describeBatchOutcome(DELETE_VERB, { done: ["a"], failed: [] })).toBe("Deleted 1 contact.");
    expect(describeBatchOutcome(MOVE_VERB, { done: ["a", "b", "c"], failed: [] })).toBe("Moved 3 contacts.");
  });

  it("a partial run reports BOTH sides and names the failures", () => {
    const said = describeBatchOutcome(
      DELETE_VERB,
      { done: ["a", "b"], failed: [fail("c", "no longer there")] },
      (id) => ({ a: "Ada", b: "Babbage", c: "Grace" })[id] ?? id,
    );
    expect(said).toContain("Deleted 2 of 3 contacts.");
    expect(said).toContain("1 could not be deleted");
    expect(said).toContain("Grace (no longer there)");
    // The thing this test really guards: a partial result never reads as success.
    expect(said).not.toBe("Deleted 2 contacts.");
  });

  it("a total failure says so rather than reporting a silent zero", () => {
    const said = describeBatchOutcome(MOVE_VERB, {
      done: [],
      failed: [fail("a", "read-only"), fail("b", "read-only")],
    });
    expect(said).toContain("No contacts were moved.");
    expect(said).toContain("2 could not be moved");
    expect(said).toContain("a (read-only)");
  });

  it("names the first few and counts the rest — a toast is not a log", () => {
    const failed = Array.from({ length: 9 }, (_, i) => fail(`id${i}`, "refused"));
    const said = describeBatchOutcome(DELETE_VERB, { done: ["ok"], failed });
    expect(said).toContain("Deleted 1 of 10 contacts.");
    expect(said).toContain("9 could not be deleted");
    expect(said).toContain("id0 (refused)");
    expect(said).toContain("id2 (refused)");
    expect(said).not.toContain("id3 (refused)");
    expect(said).toContain("and 6 more");
  });

  it("falls back to the raw id when nothing can name it — worse, but still specific", () => {
    expect(describeBatchOutcome(DELETE_VERB, { done: [], failed: [fail("cc-x9", "gone")] })).toContain("cc-x9 (gone)");
  });

  it("an empty run is honest about having done nothing", () => {
    expect(describeBatchOutcome(DELETE_VERB, { done: [], failed: [] })).toBe("Nothing was deleted.");
  });
});
