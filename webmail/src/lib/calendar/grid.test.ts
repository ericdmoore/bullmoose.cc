import { describe, expect, it } from "vitest";
import { dayKey, type CivilDate } from "./civil";
import {
  MAX_SPILL_IN_DAYS,
  WINDOW_PAD_AFTER_DAYS,
  WINDOW_PAD_BEFORE_DAYS,
  gridDays,
  gridTitle,
  isInPeriod,
  queryWindow,
  shiftGrid,
  startOfWeek,
  weekdayHeadings,
  windowKey,
  withView,
  type GridSpec,
} from "./grid";

const july = (day: number): CivilDate => ({ year: 2026, month: 7, day });
const month = (anchor: CivilDate, weekStartsOn: 0 | 1 = 0): GridSpec => ({
  kind: "month",
  anchor,
  weekStartsOn,
});

describe("the month grid", () => {
  it("is always six rows, so paging does not resize the page", () => {
    for (let m = 1; m <= 12; m++) {
      expect(gridDays(month({ year: 2026, month: m, day: 1 }))).toHaveLength(42);
    }
  });

  it("starts on the configured first day of the week", () => {
    // 1 July 2026 is a Wednesday, so a Sunday-start grid opens on 28 June.
    expect(dayKey(gridDays(month(july(1), 0))[0]!)).toBe("2026-06-28");
    expect(dayKey(gridDays(month(july(1), 1))[0]!)).toBe("2026-06-29");
  });

  it("contains the whole anchored month", () => {
    const days = gridDays(month(july(15))).map(dayKey);
    expect(days).toContain("2026-07-01");
    expect(days).toContain("2026-07-31");
  });

  it("marks the leading and trailing days as outside the period", () => {
    const spec = month(july(1));
    const days = gridDays(spec);
    expect(isInPeriod(spec, days[0]!)).toBe(false); // 28 June
    expect(isInPeriod(spec, july(15))).toBe(true);
    // A week view has no "outside".
    expect(isInPeriod({ ...spec, kind: "week" }, days[0]!)).toBe(true);
  });

  it("does not care which day of the anchored month it was given", () => {
    expect(gridDays(month(july(1))).map(dayKey)).toEqual(gridDays(month(july(31))).map(dayKey));
  });
});

describe("week and day grids", () => {
  it("gives a week seven days from the configured start", () => {
    const days = gridDays({ kind: "week", anchor: july(8), weekStartsOn: 0 });
    expect(days.map(dayKey)).toEqual([
      "2026-07-05",
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
      "2026-07-11",
    ]);
  });

  it("gives a day exactly one day", () => {
    expect(gridDays({ kind: "day", anchor: july(8), weekStartsOn: 0 }).map(dayKey)).toEqual(["2026-07-08"]);
  });

  it("anchors a week on the requested first day", () => {
    expect(dayKey(startOfWeek(july(8), 0))).toBe("2026-07-05");
    expect(dayKey(startOfWeek(july(8), 1))).toBe("2026-07-06");
    // Already the first day: stays put.
    expect(dayKey(startOfWeek(july(5), 0))).toBe("2026-07-05");
  });
});

describe("paging and switching views", () => {
  it("pages a month at a time without drifting on short months", () => {
    // The trap: 31 Jan + 1 month must not become 3 March. `shiftGrid`
    // normalises to the 1st for exactly this.
    let spec = month({ year: 2026, month: 1, day: 31 });
    spec = shiftGrid(spec, 1);
    expect(dayKey(spec.anchor)).toBe("2026-02-01");
    spec = shiftGrid(spec, 1);
    expect(dayKey(spec.anchor)).toBe("2026-03-01");
  });

  it("pages a week by seven days and a day by one", () => {
    expect(dayKey(shiftGrid({ kind: "week", anchor: july(8), weekStartsOn: 0 }, 1).anchor)).toBe("2026-07-15");
    expect(dayKey(shiftGrid({ kind: "day", anchor: july(8), weekStartsOn: 0 }, -1).anchor)).toBe("2026-07-07");
  });

  it("keeps the anchored DAY when switching month → week → day", () => {
    // Caught by driving the built page: normalising the month anchor to the
    // 1st meant pressing "Week" landed on the week containing the 1st rather
    // than the week containing today.
    const asWeek = withView(month(july(23)), "week");
    expect(dayKey(asWeek.anchor)).toBe("2026-07-23");
    expect(gridDays(asWeek).map(dayKey)).toContain("2026-07-23");
    expect(dayKey(withView(asWeek, "day").anchor)).toBe("2026-07-23");
    // And back: a month grid ignores the day, so nothing changes on screen.
    expect(gridDays(withView(asWeek, "month")).map(dayKey)).toEqual(gridDays(month(july(1))).map(dayKey));
  });

  it("keys a window by the DAYS ON SCREEN, not by the raw anchor", () => {
    // Moving the anchor inside a period must not refetch — which only matters
    // because `withView` now carries the day through.
    expect(windowKey(month(july(1)))).toBe("month:2026-07:0");
    expect(windowKey(month(july(23)))).toBe(windowKey(month(july(1))));
    expect(windowKey(month(july(1)))).not.toBe(windowKey(month(july(1), 1)));
    expect(windowKey(month(july(1)))).not.toBe(windowKey(month({ year: 2026, month: 8, day: 1 })));

    const week = (day: number): GridSpec => ({ kind: "week", anchor: july(day), weekStartsOn: 0 });
    expect(windowKey(week(8))).toBe(windowKey(week(5)));
    expect(windowKey(week(8))).not.toBe(windowKey(week(12)));

    const day = (d: number): GridSpec => ({ kind: "day", anchor: july(d), weekStartsOn: 0 });
    expect(windowKey(day(8))).not.toBe(windowKey(day(9)));
  });
});

describe("the query window is wider than the grid, on purpose", () => {
  it("reaches back before the first day and past the last", () => {
    const days = gridDays(month(july(1)));
    const { after, before } = queryWindow(days);
    const firstMs = Date.UTC(2026, 5, 28);
    const lastMs = Date.UTC(2026, 7, 8); // the 42nd day, 8 August
    expect(Date.parse(after)).toBe(firstMs - WINDOW_PAD_BEFORE_DAYS * 86_400_000);
    expect(Date.parse(before)).toBe(lastMs + (1 + WINDOW_PAD_AFTER_DAYS) * 86_400_000);
  });

  it("pads enough after the grid to cover every real UTC offset", () => {
    // A viewer at UTC+14 sees the last grid day end 14h before it does in UTC;
    // a viewer at UTC-12 sees it end 12h after. Two days covers both, with a
    // DST hour to spare.
    expect(WINDOW_PAD_AFTER_DAYS * 24).toBeGreaterThan(14 + 1);
  });

  it("reaches back far enough to catch a month-long event spilling in", () => {
    // `getOccurrences` returns an occurrence when start < before AND end >
    // after (calendar-core:489-493), so an event is only found if its START is
    // inside the window. The pad is what makes a long event visible at all.
    expect(MAX_SPILL_IN_DAYS).toBeGreaterThanOrEqual(31);
  });

  it("is deterministic — it never reads the host timezone", () => {
    const days = gridDays(month(july(1)));
    const a = queryWindow(days);
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati";
      expect(queryWindow(gridDays(month(july(1))))).toEqual(a);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("refuses an empty grid rather than inventing a window", () => {
    expect(() => queryWindow([])).toThrow(/at least one day/);
  });
});

describe("labels", () => {
  it("names a month, a day and three shapes of week", () => {
    expect(gridTitle(month(july(1)))).toBe("July 2026");
    expect(gridTitle({ kind: "day", anchor: july(8), weekStartsOn: 0 })).toBe("Wednesday, July 8, 2026");
    expect(gridTitle({ kind: "week", anchor: july(8), weekStartsOn: 0 })).toBe("July 5–11, 2026");
    expect(gridTitle({ kind: "week", anchor: july(1), weekStartsOn: 0 })).toBe("June 28 – July 4, 2026");
    expect(gridTitle({ kind: "week", anchor: { year: 2025, month: 12, day: 31 }, weekStartsOn: 0 })).toBe(
      "December 28, 2025 – January 3, 2026",
    );
  });

  it("rotates the weekday headings with the first day of the week", () => {
    expect(weekdayHeadings(0)[0]).toBe("Sun");
    expect(weekdayHeadings(1)[0]).toBe("Mon");
    expect(weekdayHeadings(1)[6]).toBe("Sun");
  });
});
