import { describe, expect, it } from "vitest";
import { defaultSession } from "../jmap/FakeJmapClient";
import { planSearch, type SearchPlan } from "./plan";
import { deriveScopeNote, SHARED_NOT_SEARCHED } from "./scope";

const fullPlan = (): SearchPlan => planSearch(defaultSession(), "elk");

describe("the scope note — the T6 deliverable, verbatim", () => {
  // These strings are the page's honesty. If a change here surprises you, the
  // change is wrong, not the test: the note may only move when the
  // searchability table (`plan.ts` REALMS) or the gap list really moved.

  it("says what was searched, grouped by tier, indexed first", () => {
    expect(deriveScopeNote(fullPlan()).searchedLine).toBe(
      "searched: mail bodies (indexed) · contacts, calendar (scanned)",
    );
  });

  it("names what was NOT searched: the extraction gap, then files", () => {
    expect(deriveScopeNote(fullPlan()).notSearchedLines).toEqual([
      "attachment contents — requires the extraction index",
      "files — no search path yet",
    ]);
  });
});

describe("the note is derived from coverage, so the data moves it", () => {
  it("re-tiers contacts into the indexed group when its index ships", () => {
    // The refinement-4 constraint made checkable: giving contacts the FTS5
    // treatment changes DATA (one REALMS row), and the note follows without
    // any consumer changing shape.
    const plan = fullPlan();
    const contacts = plan.coverage.find((c) => c.realm === "contacts");
    if (!contacts) throw new Error("contacts coverage missing");
    contacts.tier = "indexed";
    expect(deriveScopeNote(plan).searchedLine).toBe("searched: mail bodies, contacts (indexed) · calendar (scanned)");
  });

  it("drops the attachment line when the extraction index exists", () => {
    const plan = { ...fullPlan(), gaps: [] };
    expect(deriveScopeNote(plan).notSearchedLines).toEqual(["files — no search path yet"]);
  });

  it("moves a refused realm into the not-searched list with its reason", () => {
    const plan = fullPlan();
    const calendar = plan.coverage.find((c) => c.realm === "calendar");
    if (!calendar) throw new Error("calendar coverage missing");
    calendar.searched = false;
    calendar.reason = "this session has no access";
    const note = deriveScopeNote(plan);
    expect(note.searchedLine).toBe("searched: mail bodies (indexed) · contacts (scanned)");
    expect(note.notSearchedLines).toContain("calendar — this session has no access");
  });

  it("appends the decision-4 line only when shared accounts exist", () => {
    expect(deriveScopeNote(fullPlan()).notSearchedLines).not.toContain(SHARED_NOT_SEARCHED);
    const withShared = { ...fullPlan(), sharedAccountsExcluded: 2 };
    expect(deriveScopeNote(withShared).notSearchedLines).toContain(SHARED_NOT_SEARCHED);
  });

  it("admits when nothing at all is searchable", () => {
    const plan = fullPlan();
    for (const c of plan.coverage) {
      c.searched = false;
      if (c.reason === undefined) c.reason = "this session has no access";
    }
    expect(deriveScopeNote(plan).searchedLine).toBe("searched: nothing — this session reaches no searchable realm");
  });
});
