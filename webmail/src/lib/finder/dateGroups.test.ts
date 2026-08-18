import { describe, expect, it } from "vitest";
import { deriveDateGroups, monthLabel, monthWindow, windowRefinement, yearWindow } from "./dateGroups";

// Year › Month date groups (s20 T5): derived from result receivedAt values,
// UTC throughout, newest first at both levels. The window arithmetic is the
// part that would bite silently (December rollover, exclusive `before`), so
// it gets exact-string assertions.

describe("deriveDateGroups", () => {
  it("groups by UTC year and month, newest first at both levels", () => {
    const groups = deriveDateGroups([
      "2026-07-01T09:00:00Z",
      "2026-07-15T09:00:00Z",
      "2026-08-02T09:00:00Z",
      "2025-12-31T23:59:59Z",
    ]);
    expect(groups).toEqual([
      {
        year: 2026,
        count: 3,
        months: [
          { year: 2026, month: 8, count: 1 },
          { year: 2026, month: 7, count: 2 },
        ],
      },
      { year: 2025, count: 1, months: [{ year: 2025, month: 12, count: 1 }] },
    ]);
  });

  it("groups in UTC, not the viewer's zone — an instant late on the 31st UTC stays in that month", () => {
    // 2026-01-31T23:30Z is already February 1st in zones east of UTC+0:30;
    // the grouping must not depend on where the browser sits.
    const groups = deriveDateGroups(["2026-01-31T23:30:00Z"]);
    expect(groups).toEqual([{ year: 2026, count: 1, months: [{ year: 2026, month: 1, count: 1 }] }]);
  });

  it("drops missing and unparseable values rather than inventing a month", () => {
    expect(deriveDateGroups([undefined, "not-a-date", ""])).toEqual([]);
  });
});

describe("windows — after inclusive, before exclusive", () => {
  it("spans a month exactly", () => {
    expect(monthWindow(2026, 7)).toEqual({
      after: "2026-07-01T00:00:00.000Z",
      before: "2026-08-01T00:00:00.000Z",
    });
  });

  it("rolls December into January of the next year", () => {
    expect(monthWindow(2026, 12)).toEqual({
      after: "2026-12-01T00:00:00.000Z",
      before: "2027-01-01T00:00:00.000Z",
    });
  });

  it("spans a year exactly", () => {
    expect(yearWindow(2026)).toEqual({
      after: "2026-01-01T00:00:00.000Z",
      before: "2027-01-01T00:00:00.000Z",
    });
  });
});

describe("labels and refinements", () => {
  it("labels months deterministically, locale-free", () => {
    expect(monthLabel(2026, 8)).toBe("Aug 2026");
    expect(monthLabel(2026, 1)).toBe("Jan 2026");
  });

  it("builds the window chip a date leaf applies", () => {
    expect(windowRefinement(2026, 8)).toEqual({
      kind: "window",
      label: "Aug 2026",
      after: "2026-08-01T00:00:00.000Z",
      before: "2026-09-01T00:00:00.000Z",
    });
    expect(windowRefinement(2026)).toEqual({
      kind: "window",
      label: "2026",
      after: "2026-01-01T00:00:00.000Z",
      before: "2027-01-01T00:00:00.000Z",
    });
  });
});
