import { describe, expect, it } from "vitest";
import {
  MAX_OCCURRENCES,
  SUPPORTED_PARTS,
  UnsupportedRecurrenceError,
  eventSpan,
  expandOccurrences,
  parseICal,
  rruleToRule,
  ruleToRrule,
  serializeICal,
  unsupportedRuleReason,
  type RecurrenceRule,
} from "./index";

// Regression suite for .feedback/fromClaude/common/003 — the RRULE parser
// accepted rules the expander silently mis-expands.
//
// The defect: `SUPPORTED_PARTS` did not exist. `ical.ts` parsed BYDAY /
// BYMONTHDAY / BYSETPOS regardless of FREQ, while `expandRule`'s yearly branch
// reads only byMonth + start.day and its daily branch reads nothing at all. So
// `FREQ=YEARLY;BYMONTH=11;BYDAY=4TH` (US Thanksgiving — a shape Apple Calendar
// emits) parsed clean and expanded to "the start day of every November", and
// `eventSpan` wrote that wrong last-occurrence into the INDEXED
// calendar_events.end_at column.
//
// ─── WHERE THE EXPECTED DATES COME FROM ──────────────────────────────────
// Every date asserted below was produced by python-dateutil (an independent
// RFC 5545 implementation) plus CPython's zoneinfo (system IANA tzdata) — NOT
// by running this expander and recording what it said. Reproduce with:
//
//   pip install python-dateutil
//   python3 - <<'EOF'
//   from dateutil.rrule import rrulestr
//   from datetime import datetime
//   from zoneinfo import ZoneInfo
//   z = ZoneInfo("America/New_York")
//   for d in rrulestr("RRULE:FREQ=MONTHLY;BYDAY=2MO;COUNT=6",
//                     dtstart=datetime.fromisoformat("2026-01-12T09:00:00")):
//       print(d.strftime("%Y-%m-%dT%H:%M:%S"), int(d.replace(tzinfo=z).timestamp()*1000))
//   EOF
//
// Both the local wall-clock string AND the UTC epoch-ms are asserted, so a
// timezone-conversion regression cannot hide behind a correct date sequence.
//
// Every DTSTART below is chosen to be a genuine first occurrence of its own
// rule. This module deliberately always seeds the master start (index.ts, the
// `baseStarts.set(...)` before the rule loop), which RFC 5545 does not; picking
// matching DTSTARTs keeps that documented divergence out of these assertions.

const HOUR = 3_600_000;

interface Case {
  label: string;
  start: string;
  timeZone: string;
  rule: RecurrenceRule;
  /** [local wall-clock, UTC epoch ms] straight from the dateutil run. */
  expect: Array<[string, number]>;
}

const event = (start: string, timeZone: string, rules: RecurrenceRule[]) => ({
  "@type": "Event",
  uid: "urn:uuid:test",
  start,
  timeZone,
  duration: "PT1H",
  recurrenceRules: rules,
});

// ── rules the expander genuinely supports ─────────────────────────────────

const SUPPORTED: Case[] = [
  {
    label: "FREQ=DAILY;COUNT=5",
    start: "2026-03-05T09:00:00",
    timeZone: "Etc/UTC",
    rule: { frequency: "daily", count: 5 },
    expect: [
      ["2026-03-05T09:00:00", 1772701200000],
      ["2026-03-06T09:00:00", 1772787600000],
      ["2026-03-07T09:00:00", 1772874000000],
      ["2026-03-08T09:00:00", 1772960400000],
      ["2026-03-09T09:00:00", 1773046800000],
    ],
  },
  {
    label: "FREQ=DAILY;INTERVAL=3;COUNT=4",
    start: "2026-03-05T09:00:00",
    timeZone: "Etc/UTC",
    rule: { frequency: "daily", interval: 3, count: 4 },
    expect: [
      ["2026-03-05T09:00:00", 1772701200000],
      ["2026-03-08T09:00:00", 1772960400000],
      ["2026-03-11T09:00:00", 1773219600000],
      ["2026-03-14T09:00:00", 1773478800000],
    ],
  },
  {
    label: "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=7",
    start: "2026-03-04T09:00:00",
    timeZone: "America/New_York",
    rule: {
      frequency: "weekly",
      count: 7,
      byDay: [{ day: "mo" }, { day: "we" }, { day: "fr" }],
    },
    expect: [
      ["2026-03-04T09:00:00", 1772632800000],
      ["2026-03-06T09:00:00", 1772805600000],
      ["2026-03-09T09:00:00", 1773061200000],
      ["2026-03-11T09:00:00", 1773234000000],
      ["2026-03-13T09:00:00", 1773406800000],
      ["2026-03-16T09:00:00", 1773666000000],
      ["2026-03-18T09:00:00", 1773838800000],
    ],
  },
  {
    label: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=5",
    start: "2026-03-03T09:00:00",
    timeZone: "America/New_York",
    rule: { frequency: "weekly", interval: 2, count: 5, byDay: [{ day: "tu" }] },
    expect: [
      ["2026-03-03T09:00:00", 1772546400000],
      ["2026-03-17T09:00:00", 1773752400000],
      ["2026-03-31T09:00:00", 1774962000000],
      ["2026-04-14T09:00:00", 1776171600000],
      ["2026-04-28T09:00:00", 1777381200000],
    ],
  },
  {
    // Spans the 2026-03-08 US spring-forward: the wall clock must stay
    // 09:00 while the UTC instants shift by an hour.
    label: "FREQ=WEEKLY;BYDAY=SU;COUNT=4 across DST",
    start: "2026-03-01T09:00:00",
    timeZone: "America/New_York",
    rule: { frequency: "weekly", count: 4, byDay: [{ day: "su" }] },
    expect: [
      ["2026-03-01T09:00:00", 1772373600000],
      ["2026-03-08T09:00:00", 1772974800000],
      ["2026-03-15T09:00:00", 1773579600000],
      ["2026-03-22T09:00:00", 1774184400000],
    ],
  },
  {
    label: "FREQ=MONTHLY;BYDAY=2MO;COUNT=6",
    start: "2026-01-12T09:00:00",
    timeZone: "America/New_York",
    rule: { frequency: "monthly", count: 6, byDay: [{ day: "mo", nthOfPeriod: 2 }] },
    expect: [
      ["2026-01-12T09:00:00", 1768226400000],
      ["2026-02-09T09:00:00", 1770645600000],
      ["2026-03-09T09:00:00", 1773061200000],
      ["2026-04-13T09:00:00", 1776085200000],
      ["2026-05-11T09:00:00", 1778504400000],
      ["2026-06-08T09:00:00", 1780923600000],
    ],
  },
  {
    label: "FREQ=MONTHLY;BYDAY=-1FR;COUNT=6",
    start: "2026-01-30T17:00:00",
    timeZone: "America/New_York",
    rule: { frequency: "monthly", count: 6, byDay: [{ day: "fr", nthOfPeriod: -1 }] },
    expect: [
      ["2026-01-30T17:00:00", 1769810400000],
      ["2026-02-27T17:00:00", 1772229600000],
      ["2026-03-27T17:00:00", 1774645200000],
      ["2026-04-24T17:00:00", 1777064400000],
      ["2026-05-29T17:00:00", 1780088400000],
      ["2026-06-26T17:00:00", 1782507600000],
    ],
  },
  {
    label: "FREQ=MONTHLY;BYMONTHDAY=15;COUNT=4",
    start: "2026-01-15T09:00:00",
    timeZone: "Etc/UTC",
    rule: { frequency: "monthly", count: 4, byMonthDay: [15] },
    expect: [
      ["2026-01-15T09:00:00", 1768467600000],
      ["2026-02-15T09:00:00", 1771146000000],
      ["2026-03-15T09:00:00", 1773565200000],
      ["2026-04-15T09:00:00", 1776243600000],
    ],
  },
  {
    // Short months must not clamp to the 31st.
    label: "FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=5",
    start: "2026-01-31T09:00:00",
    timeZone: "Etc/UTC",
    rule: { frequency: "monthly", count: 5, byMonthDay: [-1] },
    expect: [
      ["2026-01-31T09:00:00", 1769850000000],
      ["2026-02-28T09:00:00", 1772269200000],
      ["2026-03-31T09:00:00", 1774947600000],
      ["2026-04-30T09:00:00", 1777539600000],
      ["2026-05-31T09:00:00", 1780218000000],
    ],
  },
  {
    label: "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=4 (last weekday)",
    start: "2026-01-30T17:00:00",
    timeZone: "Etc/UTC",
    rule: {
      frequency: "monthly",
      count: 4,
      byDay: [{ day: "mo" }, { day: "tu" }, { day: "we" }, { day: "th" }, { day: "fr" }],
      bySetPosition: [-1],
    },
    expect: [
      ["2026-01-30T17:00:00", 1769792400000],
      ["2026-02-27T17:00:00", 1772211600000],
      ["2026-03-31T17:00:00", 1774976400000],
      ["2026-04-30T17:00:00", 1777568400000],
    ],
  },
  {
    label: "FREQ=YEARLY;COUNT=4",
    start: "2026-07-04T12:00:00",
    timeZone: "Etc/UTC",
    rule: { frequency: "yearly", count: 4 },
    expect: [
      ["2026-07-04T12:00:00", 1783166400000],
      ["2027-07-04T12:00:00", 1814702400000],
      ["2028-07-04T12:00:00", 1846324800000],
      ["2029-07-04T12:00:00", 1877860800000],
    ],
  },
  {
    label: "FREQ=YEARLY;BYMONTH=3,6,9,12;COUNT=6",
    start: "2026-03-05T09:00:00",
    timeZone: "Etc/UTC",
    rule: { frequency: "yearly", count: 6, byMonth: ["3", "6", "9", "12"] },
    expect: [
      ["2026-03-05T09:00:00", 1772701200000],
      ["2026-06-05T09:00:00", 1780650000000],
      ["2026-09-05T09:00:00", 1788598800000],
      ["2026-12-05T09:00:00", 1796461200000],
      ["2027-03-05T09:00:00", 1804237200000],
      ["2027-06-05T09:00:00", 1812186000000],
    ],
  },
  {
    label: "FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=2026-05-15T09:00:00",
    start: "2026-01-15T09:00:00",
    timeZone: "Etc/UTC",
    rule: { frequency: "monthly", byMonthDay: [15], until: "2026-05-15T09:00:00" },
    expect: [
      ["2026-01-15T09:00:00", 1768467600000],
      ["2026-02-15T09:00:00", 1771146000000],
      ["2026-03-15T09:00:00", 1773565200000],
      ["2026-04-15T09:00:00", 1776243600000],
      ["2026-05-15T09:00:00", 1778835600000],
    ],
  },
];

describe("expandOccurrences — supported rules match python-dateutil", () => {
  for (const c of SUPPORTED) {
    it(c.label, () => {
      const occ = expandOccurrences(event(c.start, c.timeZone, [c.rule]));
      expect(occ.map((o) => [o.start, o.startMs])).toEqual(c.expect);
      expect(occ.every((o) => o.endMs === o.startMs + HOUR)).toBe(true);
    });

    it(`${c.label} — the guard accepts it`, () => {
      expect(unsupportedRuleReason(c.rule)).toBeNull();
    });
  }

  it("keeps the wall clock fixed while UTC shifts across spring-forward", () => {
    const dst = SUPPORTED.find((c) => c.label.includes("across DST"))!;
    const occ = expandOccurrences(event(dst.start, dst.timeZone, [dst.rule]));
    expect(new Set(occ.map((o) => o.start.slice(11)))).toEqual(new Set(["09:00:00"]));
    // 2026-03-01 09:00 EST → 2026-03-08 09:00 EDT is 167 hours, not 168.
    expect(occ[1]!.startMs - occ[0]!.startMs).toBe(167 * HOUR);
    expect(occ[2]!.startMs - occ[1]!.startMs).toBe(168 * HOUR);
  });
});

// ── the four confirmed mis-expansions ─────────────────────────────────────
//
// Each carries the dates a correct expander (dateutil) would produce and the
// dates this expander produced BEFORE the guard. Neither set is asserted as an
// expectation — the rule is refused. They are recorded so the next person can
// see exactly what was at stake, and so anyone implementing the missing
// branches has the oracle already written down.

interface Defect {
  label: string;
  start: string;
  timeZone: string;
  rule: RecurrenceRule;
  rrule: string;
  /** dateutil's answer — what the user actually asked for. */
  correct: string[];
  /** what this expander produced before the guard landed. */
  wasExpandedTo: string;
  /** the exact wrong dates it produced, captured with the guard disabled. */
  wrongDates: string[];
  /** substring the rejection reason must name. */
  reason: RegExp;
}

const DEFECTS: Defect[] = [
  {
    label: "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH — US Thanksgiving, as Apple emits it",
    start: "2026-11-26T17:00:00",
    timeZone: "America/New_York",
    rule: { frequency: "yearly", byMonth: ["11"], byDay: [{ day: "th", nthOfPeriod: 4 }], count: 4 },
    rrule: "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=4",
    correct: [
      "2026-11-26T17:00:00",
      "2027-11-25T17:00:00",
      "2028-11-23T17:00:00",
      "2029-11-22T17:00:00",
    ],
    wasExpandedTo: "the 26th of every November (byDay never read by the yearly branch)",
    wrongDates: ["2027-11-26T17:00:00", "2028-11-26T17:00:00", "2029-11-26T17:00:00"],
    reason: /byDay is discarded by the FREQ=YEARLY/,
  },
  {
    label: "FREQ=MONTHLY;BYMONTH=11;BYDAY=4TH — monthly branch never reads byMonth",
    start: "2026-11-26T17:00:00",
    timeZone: "America/New_York",
    rule: { frequency: "monthly", byMonth: ["11"], byDay: [{ day: "th", nthOfPeriod: 4 }], count: 4 },
    rrule: "FREQ=MONTHLY;BYMONTH=11;BYDAY=4TH;COUNT=4",
    correct: [
      "2026-11-26T17:00:00",
      "2027-11-25T17:00:00",
      "2028-11-23T17:00:00",
      "2029-11-22T17:00:00",
    ],
    wasExpandedTo: "the 4th Thursday of EVERY month, not just November",
    wrongDates: ["2026-12-24T17:00:00", "2027-01-28T17:00:00", "2027-02-25T17:00:00"],
    reason: /byMonth is discarded by the FREQ=MONTHLY/,
  },
  {
    label: "FREQ=DAILY;BYDAY=MO — daily branch reads no BY parts at all",
    start: "2026-03-05T09:00:00",
    timeZone: "Etc/UTC",
    rule: { frequency: "daily", byDay: [{ day: "mo" }], count: 4 },
    rrule: "FREQ=DAILY;BYDAY=MO;COUNT=4",
    correct: [
      "2026-03-09T09:00:00",
      "2026-03-16T09:00:00",
      "2026-03-23T09:00:00",
      "2026-03-30T09:00:00",
    ],
    wasExpandedTo: "every single day",
    wrongDates: ["2026-03-06T09:00:00", "2026-03-07T09:00:00", "2026-03-08T09:00:00"],
    reason: /byDay is discarded by the FREQ=DAILY/,
  },
  {
    label: "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25 from a Dec-20 start",
    start: "2026-12-20T09:00:00",
    timeZone: "Etc/UTC",
    rule: { frequency: "yearly", byMonth: ["12"], byMonthDay: [25], count: 4 },
    rrule: "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25;COUNT=4",
    correct: [
      "2026-12-25T09:00:00",
      "2027-12-25T09:00:00",
      "2028-12-25T09:00:00",
      "2029-12-25T09:00:00",
    ],
    wasExpandedTo: "December 20th forever — five days early, every year",
    wrongDates: ["2027-12-20T09:00:00", "2028-12-20T09:00:00", "2029-12-20T09:00:00"],
    reason: /byMonthDay is discarded by the FREQ=YEARLY/,
  },
];

describe("mis-expandable rules are refused, not expanded", () => {
  for (const d of DEFECTS) {
    describe(d.label, () => {
      const ev = () => event(d.start, d.timeZone, [d.rule]);

      it("unsupportedRuleReason names the discarded part", () => {
        expect(unsupportedRuleReason(d.rule)).toMatch(d.reason);
      });

      it("eventSpan throws — the write boundary both surfaces funnel through", () => {
        // services/jmap/src/methods/calendars.ts and
        // services/anglebrackets/src/dav.ts both catch this and return 4xx.
        expect(() => eventSpan(ev())).toThrow(UnsupportedRecurrenceError);
        expect(() => eventSpan(ev())).toThrow(/unsupported recurrence rule/);
      });

      it("rruleToRule returns the module's existing null 'unsupported' signal", () => {
        expect(rruleToRule(d.rrule, d.timeZone)).toBeNull();
      });

      it("parseICal drops the RRULE and warns instead of importing it wrong", () => {
        const { event: parsed, warnings } = parseICal(ics(d.start, d.timeZone, d.rrule));
        expect(parsed).not.toBeNull();
        expect(parsed!.recurrenceRules).toBeUndefined();
        expect(warnings.join(" ")).toContain("unsupported RRULE");
      });

      it("reading a row already stored with it yields the master start ONLY", () => {
        // The event does not vanish — expandOccurrences seeds the master
        // start — it just stops repeating on dates nobody asked for.
        const occ = expandOccurrences(ev());
        expect(occ.map((o) => o.start)).toEqual([d.start]);
        // and specifically none of the wrong dates it used to produce
        expect(occ).toHaveLength(1);
      });

      it(`emits none of the wrong dates it used to (${d.wasExpandedTo})`, () => {
        // `wrongDates` was captured by disabling the guard and recording
        // what came out; `correct` is dateutil's answer. We emit neither:
        // the rule is refused, so only the DTSTART survives. Implementing
        // the missing branches would let `correct` be asserted instead.
        const got = new Set(expandOccurrences(ev()).map((o) => o.start));
        for (const wrong of d.wrongDates) expect(got.has(wrong)).toBe(false);
        for (const right of d.correct.slice(1)) expect(got.has(right)).toBe(false);
        expect(got.size).toBe(1);
      });
    });
  }

  it("the bounded Thanksgiving rule no longer writes a wrong end_at", () => {
    // Previously eventSpan returned endMs 1858892400000 (2028-11-26T23:00Z)
    // as the last occurrence of a COUNT=3 Thanksgiving rule whose real last
    // occurrence is 2028-11-23, and that value landed in the INDEXED
    // calendar_events.end_at column with nothing to later re-derive it.
    const ev = event("2026-11-26T17:00:00", "America/New_York", [
      { frequency: "yearly", byMonth: ["11"], byDay: [{ day: "th", nthOfPeriod: 4 }], count: 3 },
    ]);
    expect(() => eventSpan(ev)).toThrow(UnsupportedRecurrenceError);
  });
});

// ── everything else the parser used to wave through ───────────────────────

const REJECTED: Array<[string, RecurrenceRule, RegExp]> = [
  [
    // Parsed clean, matched no expander branch, yielded zero occurrences.
    "FREQ=HOURLY has no branch",
    { frequency: "hourly", interval: 6 },
    /has no expander branch/,
  ],
  ["FREQ missing entirely", { interval: 2 }, /has no expander branch/],
  ["FREQ=MINUTELY", { frequency: "minutely" }, /has no expander branch/],
  [
    // `Number("abc")` → NaN → Math.max(1, NaN) → NaN → addDays(NaN).
    "INTERVAL=abc parses to NaN",
    { frequency: "daily", interval: Number("abc") },
    /interval must be a positive integer/,
  ],
  ["INTERVAL=0", { frequency: "daily", interval: 0 }, /interval must be a positive integer/],
  ["INTERVAL=1.5", { frequency: "daily", interval: 1.5 }, /interval must be a positive integer/],
  ["COUNT=abc", { frequency: "daily", count: Number("abc") }, /count must be a positive integer/],
  [
    // Silently dropped by the expander → a bounded series stored unbounded.
    "UNTIL that is not a LocalDateTime",
    { frequency: "daily", until: "next tuesday" },
    /until must be a LocalDateTime/,
  ],
  [
    // The case a Record<Frequency, Set<part>> cannot express: byDay IS in
    // the weekly set, yet nthOfPeriod is ignored and this expands to every
    // Monday rather than the 2nd Monday.
    "FREQ=WEEKLY;BYDAY=2MO",
    { frequency: "weekly", byDay: [{ day: "mo", nthOfPeriod: 2 }] },
    /nthOfPeriod is only read by the FREQ=MONTHLY/,
  ],
  [
    "FREQ=YEARLY;BYDAY=-1SU",
    { frequency: "yearly", byDay: [{ day: "su", nthOfPeriod: -1 }] },
    /byDay is discarded by the FREQ=YEARLY/,
  ],
  [
    "FREQ=WEEKLY;BYMONTHDAY=15",
    { frequency: "weekly", byMonthDay: [15] },
    /byMonthDay is discarded by the FREQ=WEEKLY/,
  ],
  [
    "FREQ=WEEKLY;BYSETPOS=1;BYDAY=MO",
    { frequency: "weekly", byDay: [{ day: "mo" }], bySetPosition: [1] },
    /bySetPosition is discarded by the FREQ=WEEKLY/,
  ],
  [
    "FREQ=YEARLY;BYSETPOS=-1;BYMONTH=1",
    { frequency: "yearly", byMonth: ["1"], bySetPosition: [-1] },
    /bySetPosition is discarded by the FREQ=YEARLY/,
  ],
  [
    // The monthly branch is `if (byDay) … else if (byMonthDay)`, so this
    // emits every Monday and discards the 15th rather than intersecting.
    "FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=15",
    { frequency: "monthly", byDay: [{ day: "mo" }], byMonthDay: [15] },
    /not intersected by the monthly branch/,
  ],
  [
    // Filtered out by the expander, which then falls back to start.month.
    "BYMONTH=13",
    { frequency: "yearly", byMonth: ["13"] },
    /is not a month number/,
  ],
  ["BYMONTH=0", { frequency: "yearly", byMonth: ["0"] }, /is not a month number/],
  ["BYMONTHDAY=0", { frequency: "monthly", byMonthDay: [0] }, /out of range/],
  ["BYMONTHDAY=32", { frequency: "monthly", byMonthDay: [32] }, /out of range/],
  [
    // applySetPos: pos 0 → candidates[-1] → undefined → dropped.
    "BYSETPOS=0",
    { frequency: "monthly", byDay: [{ day: "mo" }], bySetPosition: [0] },
    /must be a non-zero integer/,
  ],
  [
    // Selects from a one-element candidate set, so |pos| > 1 matches
    // nothing and the month loop spins to MAX_ITERATIONS for zero dates.
    "BYSETPOS with no other BY part",
    { frequency: "monthly", bySetPosition: [2] },
    /needs byDay or byMonthDay/,
  ],
  [
    "BYDAY with a bogus day code",
    { frequency: "weekly", byDay: [{ day: "xx" }] },
    /is not a day code/,
  ],
  [
    "nthOfPeriod=0",
    { frequency: "monthly", byDay: [{ day: "mo", nthOfPeriod: 0 }] },
    /nthOfPeriod must be a non-zero integer/,
  ],
  [
    // JSCalendar defines these; this expander reads none of them.
    "byWeekNo",
    { frequency: "yearly", byWeekNo: [20] },
    /unknown rule part "byWeekNo"/,
  ],
  ["byYearDay", { frequency: "yearly", byYearDay: [100] }, /unknown rule part "byYearDay"/],
  ["byHour", { frequency: "daily", byHour: [9, 17] }, /unknown rule part "byHour"/],
  [
    "a non-Gregorian rscale",
    { frequency: "yearly", rscale: "hebrew" },
    /rscale=hebrew is not supported/,
  ],
  [
    // The weekly branch anchors on Monday, which only shows when whole
    // weeks are skipped.
    "WKST=SU with FREQ=WEEKLY;INTERVAL=2",
    { frequency: "weekly", interval: 2, byDay: [{ day: "su" }], firstDayOfWeek: "su" },
    /anchors weeks on Monday/,
  ],
];

describe("value-level and unknown parts are refused too", () => {
  for (const [label, rule, reason] of REJECTED) {
    it(label, () => {
      expect(unsupportedRuleReason(rule)).toMatch(reason);
      expect(() => eventSpan(event("2026-03-05T09:00:00", "Etc/UTC", [rule]))).toThrow(
        UnsupportedRecurrenceError,
      );
    });
  }
});

describe("the guard does not over-reject", () => {
  const ok: Array<[string, RecurrenceRule]> = [
    ["@type on the rule object", { frequency: "daily", "@type": "RecurrenceRule" }],
    ["an explicit gregorian rscale", { frequency: "daily", rscale: "gregorian" }],
    ["skip=omit", { frequency: "monthly", byMonthDay: [31], skip: "omit" }],
    // Google Calendar emits WKST=SU on nearly every RRULE it writes.
    ["WKST=SU when INTERVAL is 1", { frequency: "weekly", byDay: [{ day: "mo" }], firstDayOfWeek: "su" }],
    ["WKST=SU on a non-weekly rule", { frequency: "monthly", byMonthDay: [1], firstDayOfWeek: "su" }],
    ["empty BY arrays (a no-op here)", { frequency: "yearly", byDay: [], byMonthDay: [] }],
    ["COUNT and UNTIL together", { frequency: "daily", count: 5, until: "2026-12-31T23:59:59" }],
    ["BYMONTH as numbers rather than strings", { frequency: "yearly", byMonth: [3, 9] as unknown as string[] }],
    ["BYMONTHDAY=-31", { frequency: "monthly", byMonthDay: [-31] }],
  ];
  for (const [label, rule] of ok) {
    it(label, () => expect(unsupportedRuleReason(rule)).toBeNull());
  }

  it("a non-recurring event is untouched", () => {
    const span = eventSpan({ start: "2026-03-05T09:00:00", timeZone: "Etc/UTC", duration: "PT1H" });
    expect(span).toEqual({ startMs: 1772701200000, endMs: 1772701200000 + HOUR, isRecurring: false });
  });
});

// ── eventSpan, the value that lands in the indexed column ────────────────

describe("eventSpan", () => {
  it("derives the true last end for a bounded rule", () => {
    const span = eventSpan(
      event("2026-01-15T09:00:00", "Etc/UTC", [
        { frequency: "monthly", byMonthDay: [15], until: "2026-05-15T09:00:00" },
      ]),
    );
    expect(span.isRecurring).toBe(true);
    expect(span.startMs).toBe(1768467600000); // 2026-01-15T09:00Z
    expect(span.endMs).toBe(1778835600000 + HOUR); // 2026-05-15T09:00Z + PT1H
  });

  it("leaves endMs null for an unbounded rule", () => {
    const span = eventSpan(event("2026-01-15T09:00:00", "Etc/UTC", [{ frequency: "weekly" }]));
    expect(span).toMatchObject({ endMs: null, isRecurring: true });
  });

  it("gates unbounded rules too — they never reach expandOccurrences", () => {
    // eventSpan short-circuits on `unbounded` before materializing, so the
    // check has to run ahead of that branch or an unbounded bad rule slips
    // through with endMs null and no complaint.
    expect(() =>
      eventSpan(event("2026-11-26T17:00:00", "America/New_York", [
        { frequency: "yearly", byMonth: ["11"], byDay: [{ day: "th", nthOfPeriod: 4 }] },
      ])),
    ).toThrow(UnsupportedRecurrenceError);
  });
});

// ── iCalendar round-trip ─────────────────────────────────────────────────

function ics(start: string, timeZone: string, rrule: string): string {
  const stamp = start.replace(/[-:]/g, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VEVENT",
    "UID:urn:uuid:test",
    "DTSTAMP:20260101T000000Z",
    `DTSTART;TZID=${timeZone}:${stamp}`,
    "DURATION:PT1H",
    `RRULE:${rrule}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

describe("iCalendar codec agrees with the same table", () => {
  it("imports a supported RRULE without warnings", () => {
    const { event: parsed, warnings } = parseICal(
      ics("2026-01-12T09:00:00", "America/New_York", "FREQ=MONTHLY;BYDAY=2MO;COUNT=6"),
    );
    expect(warnings).toEqual([]);
    expect(parsed!.recurrenceRules).toEqual([
      { frequency: "monthly", count: 6, byDay: [{ day: "mo", nthOfPeriod: 2 }] },
    ]);
    // and the imported rule expands to dateutil's dates
    expect(expandOccurrences(parsed!).map((o) => o.start)).toEqual(
      SUPPORTED.find((c) => c.label === "FREQ=MONTHLY;BYDAY=2MO;COUNT=6")!.expect.map(([l]) => l),
    );
  });

  it("round-trips a supported rule through serialize → parse", () => {
    const original = event("2026-01-30T17:00:00", "America/New_York", [
      { frequency: "monthly", count: 6, byDay: [{ day: "fr", nthOfPeriod: -1 }] },
    ]);
    const { event: back } = parseICal(serializeICal(original));
    expect(back!.recurrenceRules).toEqual(original.recurrenceRules);
  });

  it("round-trips WKST rather than silently dropping it", () => {
    const rule: RecurrenceRule = { frequency: "weekly", byDay: [{ day: "mo" }], firstDayOfWeek: "su" };
    expect(ruleToRrule(rule, "Etc/UTC")).toContain("WKST=SU");
    expect(rruleToRule("FREQ=WEEKLY;BYDAY=MO;WKST=SU", "Etc/UTC")).toEqual(rule);
  });

  it("keeps rejecting genuinely unknown RRULE parts", () => {
    expect(rruleToRule("FREQ=DAILY;BYWEEKNO=20", "Etc/UTC")).toBeNull();
  });
});

// ── the table itself ─────────────────────────────────────────────────────

describe("SUPPORTED_PARTS is the single source of truth", () => {
  it("declares exactly the four frequencies the expander branches on", () => {
    expect(Object.keys(SUPPORTED_PARTS).sort()).toEqual(["daily", "monthly", "weekly", "yearly"]);
  });

  it("gives every frequency the parts that need no branch support", () => {
    for (const parts of Object.values(SUPPORTED_PARTS)) {
      for (const p of ["interval", "count", "until"]) expect(parts.has(p)).toBe(true);
    }
  });

  it("does not let the yearly branch claim byDay/byMonthDay/bySetPosition", () => {
    // The exact over-claim the README and the module header used to make.
    for (const p of ["byDay", "byMonthDay", "bySetPosition"]) {
      expect(SUPPORTED_PARTS.yearly.has(p)).toBe(false);
    }
  });

  it("caps expansion regardless", () => {
    const occ = expandOccurrences(event("2026-01-01T09:00:00", "Etc/UTC", [{ frequency: "daily" }]), {
      before: Date.UTC(2100, 0, 1),
    });
    expect(occ.length).toBeLessThanOrEqual(MAX_OCCURRENCES);
  });
});
