import { describe, expect, it } from "vitest";
import {
  ALL_DAY_ZONE,
  describeRules,
  draftFromEvent,
  draftToCreate,
  draftToPatch,
  emptyRepeat,
  formatDuration,
  newDraft,
  nthWeekdayOfMonth,
  parseDurationMs,
  repeatFromRules,
  rulesFromRepeat,
  validateDraft,
  type EventDraft,
} from "./draft";
import type { CalendarEvent } from "./types";

const july8 = { year: 2026, month: 7, day: 8 };

const draft = (over: Partial<EventDraft> = {}): EventDraft => ({
  ...newDraft(july8, "cal-1", "America/New_York"),
  title: "Standup",
  ...over,
});

describe("ISO 8601 durations", () => {
  it("parses the shapes the server emits", () => {
    expect(parseDurationMs("PT1H")).toBe(3_600_000);
    expect(parseDurationMs("PT1H30M")).toBe(5_400_000);
    expect(parseDurationMs("P3D")).toBe(3 * 86_400_000);
    expect(parseDurationMs("P1W")).toBe(7 * 86_400_000);
    expect(parseDurationMs("nonsense")).toBe(0);
    expect(parseDurationMs(undefined)).toBe(0);
  });

  it("collapses whole days to P<n>D, matching the ICS writer", () => {
    expect(formatDuration(86_400_000)).toBe("P1D");
    expect(formatDuration(3 * 86_400_000)).toBe("P3D");
    expect(formatDuration(5_400_000)).toBe("PT1H30M");
    expect(formatDuration(3_600_000)).toBe("PT1H");
    expect(formatDuration(15 * 60_000)).toBe("PT15M");
    expect(formatDuration(0)).toBe("PT0S");
  });
});

describe("all-day events are written the way CalDAV writes them", () => {
  it("stores midnight, Etc/UTC and showWithoutTime", () => {
    // `parseICal` stores `timeZone: "Etc/UTC"` for a VALUE=DATE DTSTART
    // (`packages/calendar-core/src/ical.ts:473-475`). Matching it means an
    // all-day event created here and one synced from Apple Calendar produce
    // the same blob — and therefore the same placement.
    const spec = draftToCreate(
      draft({ allDay: true, startDate: "2026-07-08", endDate: "2026-07-08" }),
    );
    expect(spec.start).toBe("2026-07-08T00:00:00");
    expect(spec.timeZone).toBe(ALL_DAY_ZONE);
    expect(spec.showWithoutTime).toBe(true);
  });

  it("omits duration for a single all-day day, exactly as the ICS importer does", () => {
    // ical.ts:494 skips writing `P1D` for an all-day event; a create that added
    // one would be a second spelling of the same day.
    const spec = draftToCreate(
      draft({ allDay: true, startDate: "2026-07-08", endDate: "2026-07-08" }),
    );
    expect(spec.duration).toBeUndefined();
  });

  it("writes an inclusive last day as a whole-day duration", () => {
    const spec = draftToCreate(
      draft({ allDay: true, startDate: "2026-07-21", endDate: "2026-07-23" }),
    );
    expect(spec.duration).toBe("P3D");
  });

  it("never writes the browser's timezone onto an all-day event", () => {
    const spec = draftToCreate(
      draft({
        allDay: true,
        timeZone: "Asia/Tokyo",
        startDate: "2026-07-08",
        endDate: "2026-07-08",
      }),
    );
    expect(spec.timeZone).toBe(ALL_DAY_ZONE);
  });
});

describe("timed events carry the wall clock the user typed, plus their zone", () => {
  it("writes start as a LocalDateTime and the zone alongside", () => {
    const spec = draftToCreate(draft({ startTime: "09:30", endTime: "10:45" }));
    expect(spec.start).toBe("2026-07-08T09:30:00");
    expect(spec.timeZone).toBe("America/New_York");
    expect(spec.duration).toBe("PT1H15M");
    expect(spec.showWithoutTime).toBe(false);
  });

  it("handles an event running past midnight", () => {
    const spec = draftToCreate(
      draft({ startTime: "22:00", endDate: "2026-07-09", endTime: "01:30" }),
    );
    expect(spec.duration).toBe("PT3H30M");
  });

  it("puts the event in exactly one calendar", () => {
    expect(draftToCreate(draft()).calendarIds).toEqual({ "cal-1": true });
  });
});

describe("validation refuses in the form what the server would refuse on the wire", () => {
  it("accepts a well-formed draft", () => {
    expect(validateDraft(draft())).toEqual([]);
  });

  it("catches an end before its start", () => {
    expect(validateDraft(draft({ startTime: "10:00", endTime: "09:00" }))).toContain(
      "The end is before the start.",
    );
  });

  it("catches an all-day last day before its first", () => {
    expect(
      validateDraft(draft({ allDay: true, startDate: "2026-07-10", endDate: "2026-07-08" })),
    ).toContain("The last day is before the first.");
  });

  it("catches a date that names no real day", () => {
    expect(validateDraft(draft({ startDate: "2026-02-31" }))).toContain(
      "Start date is not a real date.",
    );
  });

  it("mirrors the server's interval and count checks", () => {
    // `unsupportedRuleReason` rejects a non-positive-integer interval or count
    // (`calendar-core:305-312`); catching it here points at a field.
    const bad = draft({ repeat: { ...emptyRepeat(), frequency: "weekly", interval: 0 } });
    expect(validateDraft(bad)).toContain("Repeat interval must be a whole number of 1 or more.");
    const badCount = draft({
      repeat: { ...emptyRepeat(), frequency: "daily", ends: "count", count: 0 },
    });
    expect(validateDraft(badCount)).toContain("Repeat count must be a whole number of 1 or more.");
  });

  it("requires a calendar", () => {
    expect(validateDraft(draft({ calendarId: "" }))).toContain("Pick a calendar.");
  });
});

describe("the repeat form speaks a strict subset of what the expander supports", () => {
  it("builds a plain daily rule with no BY parts", () => {
    // FREQ=DAILY;BYDAY=MO is REFUSED by the server — the daily branch reads no
    // BY part and would expand to every day (.feedback common/003). The form
    // has no weekday control for daily, so it cannot build one.
    expect(rulesFromRepeat({ ...emptyRepeat(), frequency: "daily", interval: 2 }, july8)).toEqual([
      { frequency: "daily", interval: 2 },
    ]);
  });

  it("builds a weekly rule with plain byDay, never an nth", () => {
    expect(
      rulesFromRepeat({ ...emptyRepeat(), frequency: "weekly", weekdays: ["we", "mo"] }, july8),
    ).toEqual([{ frequency: "weekly", byDay: [{ day: "mo" }, { day: "we" }] }]);
  });

  it("builds monthly two ways, and never both at once", () => {
    // The monthly branch is `if (byDay) … else if (byMonthDay)`, so a rule
    // carrying both drops one and is refused (`calendar-core:395-400`).
    expect(rulesFromRepeat({ ...emptyRepeat(), frequency: "monthly" }, july8)).toEqual([
      { frequency: "monthly" },
    ]);
    const nth = rulesFromRepeat(
      { ...emptyRepeat(), frequency: "monthly", monthlyMode: "nthWeekday" },
      july8,
    );
    // 8 July 2026 is the second Wednesday.
    expect(nth).toEqual([{ frequency: "monthly", byDay: [{ day: "we", nthOfPeriod: 2 }] }]);
    expect(nth[0]!.byMonthDay).toBeUndefined();
  });

  it("builds a plain yearly rule — no byMonth, no byMonthDay", () => {
    // FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25 is refused: the yearly branch reads
    // byMonth and carries `start.day` through, so the December date would come
    // out as the start day. The form cannot express it.
    expect(rulesFromRepeat({ ...emptyRepeat(), frequency: "yearly" }, july8)).toEqual([
      { frequency: "yearly" },
    ]);
  });

  it("writes an end-of-day LocalDateTime for `until`, so the last day counts", () => {
    const [rule] = rulesFromRepeat(
      { ...emptyRepeat(), frequency: "weekly", ends: "until", until: "2026-09-30" },
      july8,
    );
    expect(rule!.until).toBe("2026-09-30T23:59:59");
  });

  it("counts the nth weekday of a month", () => {
    expect(nthWeekdayOfMonth({ year: 2026, month: 7, day: 1 })).toBe(1);
    expect(nthWeekdayOfMonth({ year: 2026, month: 7, day: 8 })).toBe(2);
    expect(nthWeekdayOfMonth({ year: 2026, month: 7, day: 29 })).toBe(5);
  });
});

describe("reading rules back, and refusing to when they do not fit", () => {
  const roundTrip = (over: Parameters<typeof rulesFromRepeat>[0]) => {
    const rules = rulesFromRepeat(over, july8);
    return repeatFromRules(rules, july8);
  };

  it("round-trips everything the form can build", () => {
    for (const form of [
      { ...emptyRepeat(), frequency: "daily" as const, interval: 3 },
      { ...emptyRepeat(), frequency: "weekly" as const, weekdays: ["mo", "fr"] as never },
      { ...emptyRepeat(), frequency: "monthly" as const, monthlyMode: "nthWeekday" as const },
      { ...emptyRepeat(), frequency: "yearly" as const, ends: "count" as const, count: 5 },
      {
        ...emptyRepeat(),
        frequency: "weekly" as const,
        ends: "until" as const,
        until: "2026-09-30",
      },
    ]) {
      expect(roundTrip(form), JSON.stringify(form)).toEqual(form);
    }
  });

  it("reads an empty rule list as `does not repeat`", () => {
    expect(repeatFromRules(undefined, july8)).toEqual(emptyRepeat());
    expect(repeatFromRules([], july8)).toEqual(emptyRepeat());
  });

  it.each([
    [
      "a nth-weekday that is not the start day's",
      [{ frequency: "monthly", byDay: [{ day: "fr", nthOfPeriod: -1 }] }],
    ],
    ["byMonthDay, which has no control", [{ frequency: "monthly", byMonthDay: [1, 15] }]],
    ["byMonth, which has no control", [{ frequency: "yearly", byMonth: ["11"] }]],
    ["bySetPosition", [{ frequency: "monthly", byDay: [{ day: "fr" }], bySetPosition: [-1] }]],
    [
      "a weekly nthOfPeriod the server itself refuses",
      [{ frequency: "weekly", byDay: [{ day: "mo", nthOfPeriod: 2 }] }],
    ],
    ["an unexpandable frequency", [{ frequency: "hourly" }]],
    ["a missing frequency", [{ interval: 2 }]],
    ["two rules at once", [{ frequency: "daily" }, { frequency: "weekly" }]],
    ["both count and until", [{ frequency: "daily", count: 3, until: "2026-09-30T23:59:59" }]],
    ["a fractional interval", [{ frequency: "daily", interval: 1.5 }]],
    ["an unparseable until", [{ frequency: "daily", until: "soon" }]],
  ])("refuses to edit %s", (_label, rules) => {
    expect(repeatFromRules(rules, july8)).toBeNull();
  });

  it("tolerates the @type marker JSCalendar allows", () => {
    expect(repeatFromRules([{ "@type": "recurrencerule", frequency: "daily" }], july8)).toEqual({
      ...emptyRepeat(),
      frequency: "daily",
    });
  });
});

describe("a rule the editor cannot express SURVIVES being edited", () => {
  const lastFriday: CalendarEvent = {
    id: "ev-retro",
    uid: "urn:uuid:retro",
    title: "Retro",
    start: "2026-07-31T16:00:00",
    duration: "PT1H",
    timeZone: "Etc/UTC",
    calendarIds: { "cal-1": true },
    recurrenceRules: [{ frequency: "monthly", byDay: [{ day: "fr", nthOfPeriod: -1 }] }],
  };

  it("freezes the rule instead of flattening it into the form", () => {
    const d = draftFromEvent(lastFriday, "cal-1")!;
    expect(d.frozenRules).toEqual(lastFriday.recurrenceRules);
    expect(d.repeat).toEqual(emptyRepeat());
  });

  it("omits recurrenceRules from the patch, so the server leaves it alone", () => {
    // The data-loss bug this prevents: rename a CalDAV-authored "last Friday of
    // the month" here and the rule must still be here afterwards. An absent key
    // in a PatchObject is "unchanged" (`calendars.ts:680`).
    const d = draftFromEvent(lastFriday, "cal-1")!;
    const patch = draftToPatch({ ...d, title: "Retro (renamed)" }, lastFriday);
    expect(patch.title).toBe("Retro (renamed)");
    expect(patch).not.toHaveProperty("recurrenceRules");
  });

  it("still writes recurrenceRules when the form DID own the rule", () => {
    const weekly: CalendarEvent = {
      ...lastFriday,
      recurrenceRules: [{ frequency: "weekly", byDay: [{ day: "mo" }] }],
    };
    const d = draftFromEvent(weekly, "cal-1")!;
    expect(d.frozenRules).toBeUndefined();
    const changed = { ...d, repeat: { ...d.repeat, interval: 2 } };
    expect(draftToPatch(changed, weekly).recurrenceRules).toEqual([
      { frequency: "weekly", interval: 2, byDay: [{ day: "mo" }] },
    ]);
  });

  it("clears the rule with null when the user turns repeating off", () => {
    const weekly: CalendarEvent = {
      ...lastFriday,
      recurrenceRules: [{ frequency: "weekly", byDay: [{ day: "mo" }] }],
    };
    const d = draftFromEvent(weekly, "cal-1")!;
    const patch = draftToPatch({ ...d, repeat: emptyRepeat() }, weekly);
    expect(patch.recurrenceRules).toBeNull();
  });
});

describe("patches carry only what changed", () => {
  const stored: CalendarEvent = {
    id: "ev-1",
    uid: "urn:uuid:1",
    title: "Standup",
    description: null,
    start: "2026-07-08T09:00:00",
    duration: "PT1H",
    timeZone: "America/New_York",
    showWithoutTime: false,
    locations: null as never,
    calendarIds: { "cal-1": true },
  };

  it("is empty when nothing changed", () => {
    const d = draftFromEvent(stored, "cal-1")!;
    expect(draftToPatch(d, stored)).toEqual({});
  });

  it("never sends id or uid, which the server treats as immutable", () => {
    const d = draftFromEvent(stored, "cal-1")!;
    const patch = draftToPatch({ ...d, title: "New" }, stored);
    expect(patch).not.toHaveProperty("id");
    expect(patch).not.toHaveProperty("uid");
  });

  it("replaces calendarIds wholesale when the event moves calendar", () => {
    // A `calendarIds/<old>: null` + `/<new>: true` pair could leave the event
    // in zero calendars, and `singleCalendarId` requires exactly one.
    const d = draftFromEvent(stored, "cal-1")!;
    expect(draftToPatch({ ...d, calendarId: "cal-2" }, stored).calendarIds).toEqual({
      "cal-2": true,
    });
  });

  it("switching to all-day rewrites start, zone and duration together", () => {
    const d = draftFromEvent(stored, "cal-1")!;
    const patch = draftToPatch({ ...d, allDay: true, endDate: d.startDate }, stored);
    expect(patch.showWithoutTime).toBe(true);
    expect(patch.start).toBe("2026-07-08T00:00:00");
    expect(patch.timeZone).toBe(ALL_DAY_ZONE);
    expect(patch.duration).toBeNull();
  });
});

describe("reading an event into the form", () => {
  it("derives the end from start + duration", () => {
    const d = draftFromEvent(
      { id: "e", start: "2026-07-08T09:00:00", duration: "PT90M", timeZone: "Etc/UTC" },
      "cal-1",
    )!;
    expect(d.startTime).toBe("09:00");
    expect(d.endDate).toBe("2026-07-08");
    expect(d.endTime).toBe("10:30");
  });

  it("rolls the end date when the duration crosses midnight", () => {
    const d = draftFromEvent(
      { id: "e", start: "2026-07-08T22:00:00", duration: "PT4H", timeZone: "Etc/UTC" },
      "cal-1",
    )!;
    expect(d.endDate).toBe("2026-07-09");
    expect(d.endTime).toBe("02:00");
  });

  it("shows an all-day span as its INCLUSIVE last day", () => {
    const d = draftFromEvent(
      { id: "e", start: "2026-07-21T00:00:00", duration: "P3D", showWithoutTime: true },
      "cal-1",
    )!;
    expect(d.allDay).toBe(true);
    expect(d.startDate).toBe("2026-07-21");
    expect(d.endDate).toBe("2026-07-23");
  });

  it("treats a single all-day day with no duration as one day", () => {
    const d = draftFromEvent(
      { id: "e", start: "2026-07-08T00:00:00", showWithoutTime: true },
      "cal-1",
    )!;
    expect(d.endDate).toBe("2026-07-08");
  });

  it("reads the location out of the JSCalendar locations map", () => {
    const d = draftFromEvent(
      {
        id: "e",
        start: "2026-07-08T09:00:00",
        locations: { l1: { "@type": "Location", name: "Room 2" } },
      },
      "cal-1",
    )!;
    expect(d.location).toBe("Room 2");
  });

  it("refuses an event with no parseable start rather than inventing one", () => {
    expect(draftFromEvent({ id: "e" }, "cal-1")).toBeNull();
    expect(draftFromEvent({ id: "e", start: "garbage" }, "cal-1")).toBeNull();
  });
});

describe("describing a rule the form cannot edit", () => {
  it("says something true about every shape", () => {
    expect(describeRules(undefined)).toBe("Does not repeat");
    expect(describeRules([{ frequency: "weekly", byDay: [{ day: "mo" }, { day: "fr" }] }])).toBe(
      "Every week on Mon, Fri",
    );
    expect(describeRules([{ frequency: "monthly", byDay: [{ day: "fr", nthOfPeriod: -1 }] }])).toBe(
      "Every month on last Fri",
    );
    expect(describeRules([{ frequency: "daily", interval: 3, count: 10 }])).toBe(
      "Every 3 days, 10 times",
    );
    expect(describeRules([{ frequency: "yearly", byMonth: ["11"] }])).toBe(
      "Every year in month 11",
    );
    expect(describeRules([{ frequency: "daily", until: "2026-09-30T23:59:59" }])).toBe(
      "Every day, until 2026-09-30",
    );
  });
});
