import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  compareDays,
  dayKey,
  daysBetween,
  daysInMonth,
  formatCivilDateTime,
  formatClock,
  minutesOfDay,
  parseCivilDateTime,
  parseClock,
  parseDayKey,
  sameDay,
  utcMsOf,
  weekday,
  zonedFields,
} from "./civil";

describe("civil dates are wall-calendar values, not instants", () => {
  it("parses a LocalDateTime by field, never through Date's local-time rule", () => {
    // `new Date("2026-07-08T09:00:00")` would mean 09:00 wherever the machine
    // is; these fields must be the same under any TZ.
    expect(parseCivilDateTime("2026-07-08T09:30:15")).toEqual({
      year: 2026, month: 7, day: 8, hour: 9, minute: 30, second: 15,
    });
  });

  it("accepts a LocalDateTime with no seconds, and rejects a bare date", () => {
    expect(parseCivilDateTime("2026-07-08T09:30")?.second).toBe(0);
    expect(parseCivilDateTime("2026-07-08")).toBeNull();
    expect(parseCivilDateTime("nonsense")).toBeNull();
  });

  it("round-trips through the JSCalendar spelling", () => {
    const s = "2026-11-26T17:00:00";
    expect(formatCivilDateTime(parseCivilDateTime(s)!)).toBe(s);
  });

  it("keeps a wall clock inside a DST GAP, which `new Date` silently moves", () => {
    // The one input where parsing by regex and parsing through `Date` really
    // diverge, and the reason the header forbids the latter. 02:30 on 8 March
    // 2026 does not exist in New York — the clocks jump 02:00 → 03:00 — so
    // `new Date("2026-03-08T02:30:00").getHours()` is 3. A recurring 02:30
    // event stored with `timeZone: "America/Europe"` would drift an hour every
    // time the browser round-tripped it through the editor.
    const original = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      expect(new Date("2026-03-08T02:30:00").getHours()).toBe(3); // the trap
      expect(parseCivilDateTime("2026-03-08T02:30:00")).toMatchObject({
        year: 2026, month: 3, day: 8, hour: 2, minute: 30,
      });
      expect(formatCivilDateTime(parseCivilDateTime("2026-03-08T02:30:00")!)).toBe(
        "2026-03-08T02:30:00",
      );
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("refuses a date-shaped string that names no real day", () => {
    // Date.UTC would roll 2026-02-31 into March and the grid would silently
    // show a month nobody asked for.
    expect(parseDayKey("2026-02-31")).toBeNull();
    expect(parseDayKey("2026-13-01")).toBeNull();
    expect(parseDayKey("2026-02-28")).toEqual({ year: 2026, month: 2, day: 28 });
    expect(parseDayKey("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
  });

  it("formats and parses clock values", () => {
    expect(parseClock("09:05")).toBe(545);
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("09:60")).toBeNull();
    expect(formatClock(545)).toBe("09:05");
    expect(formatClock(0)).toBe("00:00");
    expect(minutesOfDay({ hour: 14, minute: 30 })).toBe(870);
  });
});

describe("date arithmetic crosses months, years and leap days", () => {
  it("adds days across a month boundary", () => {
    expect(dayKey(addDays({ year: 2026, month: 1, day: 31 }, 1))).toBe("2026-02-01");
    expect(dayKey(addDays({ year: 2026, month: 3, day: 1 }, -1))).toBe("2026-02-28");
    expect(dayKey(addDays({ year: 2028, month: 3, day: 1 }, -1))).toBe("2028-02-29");
  });

  it("adds days across a DST transition without losing one", () => {
    // The whole reason arithmetic runs in UTC: 8 March 2026 is a spring-forward
    // day in the US, and a local-time `+86400000` would land on the same date.
    expect(dayKey(addDays({ year: 2026, month: 3, day: 7 }, 1))).toBe("2026-03-08");
    expect(dayKey(addDays({ year: 2026, month: 3, day: 8 }, 1))).toBe("2026-03-09");
    expect(daysBetween({ year: 2026, month: 3, day: 1 }, { year: 2026, month: 3, day: 31 })).toBe(30);
  });

  it("clamps rather than rolls when adding months", () => {
    expect(dayKey(addMonths({ year: 2026, month: 1, day: 31 }, 1))).toBe("2026-02-28");
    expect(dayKey(addMonths({ year: 2026, month: 12, day: 15 }, 1))).toBe("2027-01-15");
    expect(dayKey(addMonths({ year: 2026, month: 1, day: 15 }, -1))).toBe("2025-12-15");
  });

  it("knows how long a month is", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it("reports weekdays with 0 = Sunday", () => {
    expect(weekday({ year: 2026, month: 11, day: 26 })).toBe(4); // a Thursday
    expect(weekday({ year: 2026, month: 8, day: 9 })).toBe(0); // a Sunday
  });

  it("compares and equates days", () => {
    const a = { year: 2026, month: 7, day: 8 };
    expect(sameDay(a, { ...a })).toBe(true);
    expect(sameDay(a, { ...a, day: 9 })).toBe(false);
    expect(compareDays(a, { ...a, day: 9 })).toBeLessThan(0);
    expect(utcMsOf(a)).toBe(Date.UTC(2026, 6, 8));
  });
});

describe("zonedFields is the one zone-aware read, and it is exact", () => {
  it("reads an instant as the wall clock of a named zone", () => {
    const utc = Date.parse("2026-07-08T13:00:00Z");
    expect(zonedFields(utc, "Etc/UTC")).toMatchObject({ year: 2026, month: 7, day: 8, hour: 13 });
    // July: New York is UTC-4.
    expect(zonedFields(utc, "America/New_York")).toMatchObject({ month: 7, day: 8, hour: 9 });
    // Tokyo is UTC+9 and has already rolled to the 8th at 22:00.
    expect(zonedFields(utc, "Asia/Tokyo")).toMatchObject({ month: 7, day: 8, hour: 22 });
  });

  it("moves the calendar DAY when the offset crosses midnight", () => {
    // The behaviour the all-day rule exists to avoid applying to a date.
    const utc = Date.parse("2026-07-08T02:00:00Z");
    expect(zonedFields(utc, "America/Los_Angeles")).toMatchObject({ day: 7, hour: 19 });
    expect(zonedFields(utc, "Etc/UTC")).toMatchObject({ day: 8, hour: 2 });
  });

  it("tracks the offset change across a DST boundary", () => {
    // 1 Jan: New York is UTC-5, not UTC-4.
    expect(zonedFields(Date.parse("2026-01-08T13:00:00Z"), "America/New_York")).toMatchObject({
      hour: 8,
    });
  });

  it("normalises a 24:00 midnight reading to hour 0", () => {
    const midnightUtc = Date.parse("2026-07-08T00:00:00Z");
    expect(zonedFields(midnightUtc, "Etc/UTC").hour).toBe(0);
  });
});
