import { describe, expect, it } from "vitest";
import { CliError, EXIT } from "./io.js";
import {
  parseEventIcal,
  parseRruleString,
  resolveCalendar,
  rruleReason,
  serializeEventIcal,
  validateRrule,
} from "./calendar.js";

/**
 * The CLI half of sVOL 018. The command bodies talk to JMAP over fetch (driven
 * end-to-end by the composition smoke script); these cover the pure pieces a
 * human or a wrong write actually collides with — the recurrence guard, the
 * iCal round-trip, and typing a calendar by name.
 */

const cal = (id: string, name: string, isDefault = false) => ({ id, name, isDefault });

describe("resolveCalendar", () => {
  const CALS = [cal("cal_p", "Personal", true), cal("cal_w", "Work"), cal("cal_h", "Holidays")];

  it("takes an id verbatim, and a name case-insensitively", () => {
    expect(resolveCalendar(CALS, "cal_w").name).toBe("Work");
    expect(resolveCalendar(CALS, "personal").id).toBe("cal_p");
  });

  it("refuses an ambiguous name rather than guessing (exit 2)", () => {
    const dupes = [...CALS, cal("cal_w2", "Work")];
    expect(() => resolveCalendar(dupes, "Work")).toThrowError(
      expect.objectContaining({ exitCode: EXIT.USAGE }),
    );
  });

  it("a missing calendar is not-found (exit 3)", () => {
    try {
      resolveCalendar(CALS, "Nope");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(EXIT.NOT_FOUND);
    }
  });
});

describe("the recurrence guard (common/003, client side)", () => {
  it("rejects the Thanksgiving shape, naming the discarded part (exit 2)", () => {
    // FREQ=YEARLY;BYDAY=4TH parses clean but the YEARLY branch discards BYDAY,
    // so it would expand to the start day of every November — a wrong write.
    try {
      validateRrule("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(EXIT.USAGE);
      expect((e as CliError).message).toMatch(/BYDAY/);
      expect((e as CliError).message).toMatch(/YEARLY/);
    }
  });

  it("accepts a rule the expander can actually expand", () => {
    const rule = validateRrule("FREQ=WEEKLY;BYDAY=MO,WE,FR;INTERVAL=1");
    expect(rule.frequency).toBe("weekly");
    expect(rule.byDay).toEqual([{ day: "mo" }, { day: "we" }, { day: "fr" }]);
  });

  it("catches the weekly-with-ordinal case a plain part check misses", () => {
    // BYDAY is in the weekly set, so FREQ=WEEKLY;BYDAY=2MO passes a part-level
    // check yet the nthOfPeriod is only read by the MONTHLY branch.
    expect(rruleReason(parseRruleString("FREQ=WEEKLY;BYDAY=2MO"))).toMatch(/MONTHLY/);
    // …but the same ordinal under MONTHLY is fine ("2nd Monday").
    expect(rruleReason(parseRruleString("FREQ=MONTHLY;BYDAY=2MO"))).toBeNull();
  });

  it("names a frequency with no expander branch, and an unknown part", () => {
    expect(rruleReason(parseRruleString("FREQ=HOURLY"))).toMatch(/no expander branch/);
    expect(rruleReason(parseRruleString("FREQ=DAILY;BYHOUR=9"))).toMatch(
      /unknown RRULE part BYHOUR/,
    );
  });
});

describe("iCal round-trip (create ↔ export)", () => {
  it("preserves a timed UTC event through serialize → parse", () => {
    const event = {
      uid: "u1",
      title: "Lunch, w/ Bob",
      start: "2026-07-08T12:00:00",
      timeZone: "Etc/UTC",
      duration: "PT1H",
      recurrenceRules: [{ frequency: "weekly", byDay: [{ day: "tu" }] }],
    };
    const ics = serializeEventIcal(event);
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("DTSTART:20260708T120000Z");
    expect(ics).toContain("SUMMARY:Lunch\\, w/ Bob"); // comma escaped per RFC 5545
    expect(ics).toContain("RRULE:FREQ=WEEKLY;BYDAY=TU");

    const back = parseEventIcal(ics).event!;
    expect(back.title).toBe("Lunch, w/ Bob");
    expect(back.start).toBe("2026-07-08T12:00:00");
    expect(back.timeZone).toBe("Etc/UTC");
    expect(back.duration).toBe("PT1H");
    expect(back.recurrenceRules).toEqual([{ frequency: "weekly", byDay: [{ day: "tu" }] }]);
  });

  it("preserves an all-day event and passes a TZID through", () => {
    const allDay = serializeEventIcal({
      uid: "u2",
      title: "Holiday",
      start: "2026-12-25T00:00:00",
      timeZone: "Etc/UTC",
      showWithoutTime: true,
    });
    expect(allDay).toContain("DTSTART;VALUE=DATE:20261225");
    const back = parseEventIcal(allDay).event!;
    expect(back.showWithoutTime).toBe(true);
    expect(back.start).toBe("2026-12-25T00:00:00");

    const zoned = serializeEventIcal({
      uid: "u3",
      title: "Standup",
      start: "2026-07-08T09:00:00",
      timeZone: "America/Chicago",
      duration: "PT15M",
    });
    expect(zoned).toContain("DTSTART;TZID=America/Chicago:20260708T090000");
    expect(zoned).toContain("DURATION:PT15M");
  });

  it("rejects an unexpandable RRULE arriving via iCal too (not silently dropped)", () => {
    const ics =
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261126T090000Z\r\n" +
      "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    expect(() => parseEventIcal(ics)).toThrowError(
      expect.objectContaining({ exitCode: EXIT.USAGE }),
    );
  });
});
