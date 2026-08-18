import { describe, expect, it } from "vitest";
import { flattenItems } from "../shell/collections";
import { buildFinderCollections, parseCollectionId, savedNote, sessionNote, shortDate } from "./collections";
import { deriveDateGroups } from "./dateGroups";
import { newSession, type FinderSession } from "./session";
import type { SavedQuery } from "./store";

// The Finder's CollectionColumn feed (s20 T5). The honesty rules live in the
// row text and are asserted here: a saved count is stamped with when it was
// measured, empty groups keep an explanatory disabled row, and every id the
// builder mints parses back to a target the island can act on.

const NOW = () => Date.parse("2026-08-15T12:00:00Z");

const saved = (partial: Partial<SavedQuery> = {}): SavedQuery => ({
  id: "q-1",
  name: "invoices from billing",
  query: "invoice",
  refinements: [],
  savedAt: "2026-08-01T00:00:00.000Z",
  ...partial,
});

describe("the honesty of the row text", () => {
  it("stamps a saved query's count with WHEN it was measured — never a bare live-looking number", () => {
    expect(savedNote(saved({ lastCount: 12, lastRunAt: "2026-08-12T09:00:00.000Z" }))).toBe("12 on Aug 12");
  });

  it("says 'never run' when there is no measurement at all", () => {
    expect(savedNote(saved())).toBe("never run");
    // A count without its timestamp is meaningless — refuse to render it.
    expect(savedNote(saved({ lastCount: 12 }))).toBe("never run");
  });

  it("annotates a session with its last-run count and date, or just when it began", () => {
    const ran: FinderSession = { ...newSession("elk", NOW), lastRunAt: "2026-08-14T00:00:00.000Z", resultCount: 7 };
    expect(sessionNote(ran)).toBe("7 · Aug 14");
    expect(sessionNote(newSession("elk", NOW))).toBe("Aug 15");
  });

  it("shortDate is UTC and deterministic", () => {
    expect(shortDate("2026-08-12T23:30:00Z")).toBe("Aug 12");
    expect(shortDate("garbage")).toBe("?");
  });
});

describe("buildFinderCollections", () => {
  it("builds the three groups in order: saved, sessions, by-date", () => {
    const groups = buildFinderCollections({ saved: [], sessions: [], dateGroups: [] });
    expect(groups.map((g) => g.id)).toEqual(["saved", "sessions", "dates"]);
    expect(groups.map((g) => g.label)).toEqual(["Saved queries", "Sessions", "By date"]);
  });

  it("keeps an explanatory DISABLED row in every empty group — an empty collection still exists", () => {
    const groups = buildFinderCollections({ saved: [], sessions: [], dateGroups: [] });
    for (const g of groups) {
      expect(g.items).toHaveLength(1);
      expect(g.items[0]?.disabled).toBe(true);
      expect(g.items[0]?.reason?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("renders sessions newest-first with the current one unmuted", () => {
    const a = newSession("older", NOW);
    const b = newSession("newer", NOW);
    const groups = buildFinderCollections({ saved: [], sessions: [b, a], currentId: b.id, dateGroups: [] });
    const items = groups[1]!.items;
    expect(items.map((i) => i.label)).toEqual(["newer", "older"]);
    expect(items[0]?.muted).toBeUndefined();
    expect(items[1]?.muted).toBe(true);
  });

  it("nests months under their year — the one level of nesting the picker allows", () => {
    const dateGroups = deriveDateGroups(["2026-08-02T09:00:00Z", "2026-07-15T09:00:00Z", "2026-07-01T09:00:00Z"]);
    const groups = buildFinderCollections({ saved: [], sessions: [], dateGroups });
    const year = groups[2]!.items[0]!;
    expect(year).toMatchObject({ id: "date:2026", label: "2026", count: 3 });
    expect(year.children).toEqual([
      { id: "date:2026-08", label: "Aug 2026", count: 1 },
      { id: "date:2026-07", label: "Jul 2026", count: 2 },
    ]);
    // The renderer walks expanded children — the ids must all be visible rows.
    expect(flattenItems(groups, new Set(["date:2026"])).map((i) => i.id)).toContain("date:2026-07");
  });
});

describe("parseCollectionId — every minted id round-trips to a target", () => {
  it("decodes each row family", () => {
    expect(parseCollectionId("saved:q-1")).toEqual({ type: "saved", id: "q-1" });
    expect(parseCollectionId("session:f-abc")).toEqual({ type: "session", id: "f-abc" });
    expect(parseCollectionId("date:2026")).toEqual({ type: "year", year: 2026 });
    expect(parseCollectionId("date:2026-07")).toEqual({ type: "month", year: 2026, month: 7 });
  });

  it("refuses the placeholder rows and junk", () => {
    expect(parseCollectionId("saved:none")).toBeUndefined();
    expect(parseCollectionId("session:none")).toBeUndefined();
    expect(parseCollectionId("date:none")).toBeUndefined();
    expect(parseCollectionId("nonsense")).toBeUndefined();
  });

  it("round-trips every id the builder mints", () => {
    const ran: FinderSession = { ...newSession("elk", NOW), lastRunAt: "2026-08-14T00:00:00.000Z", resultCount: 7 };
    const groups = buildFinderCollections({
      saved: [saved()],
      sessions: [ran],
      currentId: ran.id,
      dateGroups: deriveDateGroups(["2026-08-02T09:00:00Z"]),
    });
    for (const item of flattenItems(groups, new Set(["date:2026"]))) {
      if (item.disabled) continue;
      expect(parseCollectionId(item.id), item.id).toBeDefined();
    }
  });
});
