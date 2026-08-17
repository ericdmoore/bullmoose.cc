import { describe, expect, it } from "vitest";
import { compareSegments, layoutDay, segmentsByDay, segmentsFor, type DaySegment } from "./place";
import type { Occurrence } from "./types";

const occ = (over: Partial<Occurrence>): Occurrence => ({
  eventId: "ev-1",
  calendarId: "cal-1",
  uid: "urn:uuid:1",
  recurrenceId: "2026-07-08T09:00:00",
  start: "2026-07-08T09:00:00",
  utcStart: "2026-07-08T09:00:00Z",
  utcEnd: "2026-07-08T10:00:00Z",
  title: "Standup",
  showWithoutTime: false,
  ...over,
});

/**
 * The all-day shape the server actually stores: midnight, `Etc/UTC`, no
 * duration — what `CalendarEvent/getOccurrences` emits for a `VALUE=DATE`
 * DTSTART synced in over CalDAV (`calendar-core/src/ical.ts:473-475`).
 */
const allDay = (date: string, days = 1): Occurrence =>
  occ({
    recurrenceId: `${date}T00:00:00`,
    start: `${date}T00:00:00`,
    utcStart: `${date}T00:00:00Z`,
    utcEnd: new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString(),
    title: "Public holiday",
    showWithoutTime: true,
  });

describe("all-day events land on the same DATE in every timezone", () => {
  // This is the bug the module exists to prevent. `utcStart` for an all-day
  // event is midnight resolved through Etc/UTC; converting it into a viewer's
  // zone moves New Year's Day to 31 December for the whole of the Americas.
  const zones = [
    "Etc/UTC",
    "America/Los_Angeles",
    "America/New_York",
    "Asia/Tokyo",
    "Pacific/Kiritimati",
  ];

  it.each(zones)("places 2026-01-01 on 2026-01-01 in %s", (zone) => {
    const segments = segmentsFor(allDay("2026-01-01"), zone);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.day).toBe("2026-01-01");
    expect(segments[0]!.allDay).toBe(true);
  });

  it.each(zones)("places a midsummer all-day event correctly in %s too", (zone) => {
    // Not just a solstice/DST artefact: the same must hold in July.
    expect(segmentsFor(allDay("2026-07-08"), zone)[0]!.day).toBe("2026-07-08");
  });

  it("would fail this test if it converted utcStart — proof the fork matters", () => {
    // The value a naive implementation would produce, spelled out: the same
    // instant read in Los Angeles is the PREVIOUS day.
    const utcMidnight = Date.parse("2026-01-01T00:00:00Z");
    const naive = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(utcMidnight));
    expect(naive).toBe("2025-12-31");
    expect(segmentsFor(allDay("2026-01-01"), "America/Los_Angeles")[0]!.day).toBe("2026-01-01");
  });

  it("spans a multi-day all-day event over consecutive dates", () => {
    const segments = segmentsFor(allDay("2026-07-21", 3), "America/Los_Angeles");
    expect(segments.map((s) => s.day)).toEqual(["2026-07-21", "2026-07-22", "2026-07-23"]);
    expect(segments.map((s) => s.continuesBefore)).toEqual([false, true, true]);
    expect(segments.map((s) => s.continuesAfter)).toEqual([true, true, false]);
  });

  it("takes the span from the DURATION, not from utcEnd's calendar date", () => {
    // A span crossing a spring-forward boundary is 23h per day in a zoned
    // reading; rounding the difference keeps it at whole days.
    const dst = occ({
      start: "2026-03-07T00:00:00",
      utcStart: "2026-03-07T00:00:00Z",
      utcEnd: "2026-03-10T00:00:00Z",
      showWithoutTime: true,
    });
    expect(segmentsFor(dst, "America/New_York").map((s) => s.day)).toEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
    ]);
  });

  it("survives a malformed occurrence rather than rendering a wrong day", () => {
    expect(segmentsFor(occ({ start: "garbage", showWithoutTime: true }), "Etc/UTC")).toEqual([]);
  });
});

describe("timed events are converted into the viewer's zone", () => {
  it("shows a 09:00 New York call at 14:00 in London", () => {
    // 09:00 EDT is 13:00 UTC, which London reads as 14:00 BST in July.
    const call = occ({
      start: "2026-07-08T09:00:00",
      utcStart: "2026-07-08T13:00:00Z",
      utcEnd: "2026-07-08T14:00:00Z",
    });
    const [london] = segmentsFor(call, "Europe/London");
    expect(london!.day).toBe("2026-07-08");
    expect(london!.fromMinute).toBe(14 * 60);
    expect(london!.toMinute).toBe(15 * 60);

    const [ny] = segmentsFor(call, "America/New_York");
    expect(ny!.fromMinute).toBe(9 * 60);
  });

  it("moves an event to the previous local day when the offset says so", () => {
    const late = occ({ utcStart: "2026-07-08T02:00:00Z", utcEnd: "2026-07-08T03:00:00Z" });
    expect(segmentsFor(late, "America/Los_Angeles")[0]!.day).toBe("2026-07-07");
    expect(segmentsFor(late, "Etc/UTC")[0]!.day).toBe("2026-07-08");
  });

  it("splits an event that crosses local midnight across two days", () => {
    const overnight = occ({ utcStart: "2026-07-08T22:00:00Z", utcEnd: "2026-07-09T02:00:00Z" });
    const segments = segmentsFor(overnight, "Etc/UTC");
    expect(segments.map((s) => s.day)).toEqual(["2026-07-08", "2026-07-09"]);
    expect(segments[0]).toMatchObject({
      fromMinute: 22 * 60,
      toMinute: 1440,
      continuesAfter: true,
    });
    expect(segments[1]).toMatchObject({ fromMinute: 0, toMinute: 120, continuesBefore: true });
  });

  it("keeps an event that ENDS at midnight on the day it started", () => {
    // Otherwise every 23:00–00:00 meeting grows a zero-height sliver on the
    // following day, which reads as a second event.
    const upToMidnight = occ({ utcStart: "2026-07-08T23:00:00Z", utcEnd: "2026-07-09T00:00:00Z" });
    const segments = segmentsFor(upToMidnight, "Etc/UTC");
    expect(segments.map((s) => s.day)).toEqual(["2026-07-08"]);
    expect(segments[0]!.toMinute).toBe(1440);
  });

  it("gives a zero-length event a non-negative height", () => {
    const instant = occ({ utcStart: "2026-07-08T09:00:00Z", utcEnd: "2026-07-08T09:00:00Z" });
    const [seg] = segmentsFor(instant, "Etc/UTC");
    expect(seg!.toMinute).toBeGreaterThanOrEqual(seg!.fromMinute);
  });

  it("tolerates an end before its start rather than producing 400 rows", () => {
    const broken = occ({ utcStart: "2026-07-08T09:00:00Z", utcEnd: "2020-01-01T00:00:00Z" });
    expect(segmentsFor(broken, "Etc/UTC")).toHaveLength(1);
  });

  it("falls back to a placeholder title rather than rendering an empty chip", () => {
    expect(segmentsFor(occ({ title: null }), "Etc/UTC")[0]!.title).toBe("(no title)");
  });
});

describe("bucketing and ordering", () => {
  it("buckets by local day and puts all-day rows first", () => {
    const byDay = segmentsByDay(
      [
        occ({ eventId: "b", utcStart: "2026-07-08T14:00:00Z", utcEnd: "2026-07-08T15:00:00Z" }),
        allDay("2026-07-08"),
        occ({ eventId: "a", utcStart: "2026-07-08T09:00:00Z", utcEnd: "2026-07-08T10:00:00Z" }),
      ],
      "Etc/UTC",
    );
    expect(byDay.get("2026-07-08")!.map((s) => s.eventId)).toEqual(["ev-1", "a", "b"]);
    expect(byDay.get("2026-07-08")![0]!.allDay).toBe(true);
  });

  it("orders equal starts by title so the grid does not shuffle between loads", () => {
    const a = { allDay: false, sortKey: 1, fromMinute: 60, title: "Alpha" } as DaySegment;
    const b = { allDay: false, sortKey: 1, fromMinute: 60, title: "Beta" } as DaySegment;
    expect(compareSegments(a, b)).toBeLessThan(0);
  });
});

describe("overlapping events take side-by-side columns", () => {
  const seg = (from: number, to: number, id: string): DaySegment => ({
    day: "2026-07-08",
    eventId: id,
    recurrenceId: id,
    calendarId: "cal-1",
    title: id,
    allDay: false,
    fromMinute: from,
    toMinute: to,
    continuesBefore: false,
    continuesAfter: false,
    sortKey: from,
  });

  it("gives non-overlapping events the full width", () => {
    const laid = layoutDay([seg(540, 600, "a"), seg(660, 720, "b")]);
    expect(laid.map((l) => l.columns)).toEqual([1, 1]);
    expect(laid.map((l) => l.column)).toEqual([0, 0]);
  });

  it("splits two overlapping events in half", () => {
    const laid = layoutDay([seg(540, 660, "a"), seg(600, 720, "b")]);
    expect(laid.map((l) => l.columns)).toEqual([2, 2]);
    expect(laid.map((l) => l.column)).toEqual([0, 1]);
  });

  it("widens the whole cluster when a third event chains onto the second", () => {
    const laid = layoutDay([seg(540, 660, "a"), seg(600, 720, "b"), seg(630, 780, "c")]);
    expect(new Set(laid.map((l) => l.columns))).toEqual(new Set([3]));
    expect(laid.map((l) => l.column)).toEqual([0, 1, 2]);
  });

  it("reuses a freed column after an event ends", () => {
    // `a` ends at 600, so `c` at 600 can take column 0 again — but it still
    // shares a cluster with `b`, which runs past it.
    const laid = layoutDay([seg(540, 600, "a"), seg(550, 720, "b"), seg(600, 660, "c")]);
    const byId = new Map(laid.map((l) => [l.segment.eventId, l]));
    expect(byId.get("c")!.column).toBe(0);
    expect(byId.get("b")!.column).toBe(1);
    expect(byId.get("a")!.columns).toBe(2);
  });

  it("starts a fresh cluster after a gap", () => {
    const laid = layoutDay([seg(540, 660, "a"), seg(600, 720, "b"), seg(780, 840, "c")]);
    const byId = new Map(laid.map((l) => [l.segment.eventId, l]));
    expect(byId.get("a")!.columns).toBe(2);
    expect(byId.get("c")!.columns).toBe(1);
  });

  it("excludes all-day rows — they live in their own band", () => {
    const laid = layoutDay([{ ...seg(0, 1440, "holiday"), allDay: true }, seg(540, 600, "a")]);
    expect(laid.map((l) => l.segment.eventId)).toEqual(["a"]);
  });
});
