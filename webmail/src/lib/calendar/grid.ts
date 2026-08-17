// Which days are on screen, and which window to ask the server for.
//
// Two separate questions, and keeping them separate is what makes the surface
// correct without a second timezone solver in the browser:
//
//   `gridDays`     — the civil dates the user sees. Pure calendar arithmetic;
//                    no zone, no instants (`civil.ts`).
//   `queryWindow`  — the `after`/`before` UTCDates handed to
//                    `CalendarEvent/getOccurrences`. Deliberately WIDER than
//                    the grid.
//
// ⚠️ The window is padded, and the padding is load-bearing rather than lazy.
// An exact window would need the viewer's UTC offset at each boundary — the
// wall-clock → instant direction, which is ambiguous across a DST transition
// and needs the three-pass solve `calendar-core` does server-side
// (`packages/calendar-core/src/index.ts:153`). Over-fetching by a bounded pad
// and then placing each occurrence precisely (`place.ts`) gets the same screen
// with none of that. The pad also does a second job we would have needed
// anyway: an event that STARTS before the grid and runs into it is only
// returned when the window reaches back far enough to contain its start.
//
// `getOccurrences` filters on `startMs < before && endMs > after`
// (`calendar-core:489-493`), so the pad has to cover the longest event the
// grid should show spilling in from off-screen, plus the largest possible
// zone offset (UTC+14 … UTC-12, plus an hour of DST).

import { addDays, addMonths, dayKey, utcMsOf, weekday, type CivilDate } from "./civil";

export type ViewKind = "month" | "week" | "day";

/** 0 = Sunday, 1 = Monday. Matches `Date.getUTCDay` / `civil.weekday`. */
export type WeekStart = 0 | 1;

export interface GridSpec {
  kind: ViewKind;
  /** Any date inside the period; the grid is derived, not stored. */
  anchor: CivilDate;
  weekStartsOn: WeekStart;
}

/**
 * How far past the grid edges to ask.
 *
 * 2 days covers every real UTC offset (UTC+14 to UTC-12 is 26h) with room for
 * a DST hour, and 31 further days reach back for a month-long event that
 * started before the grid. Anything longer than 31 days that overlaps the grid
 * without starting in the window is missed — a known, bounded gap, surfaced by
 * `scope.ts` rather than hidden.
 */
export const WINDOW_PAD_BEFORE_DAYS = 33;
export const WINDOW_PAD_AFTER_DAYS = 2;

/** The longest spill-in the window is guaranteed to catch. */
export const MAX_SPILL_IN_DAYS = WINDOW_PAD_BEFORE_DAYS - WINDOW_PAD_AFTER_DAYS;

/** The first day of the week containing `d`, per `weekStartsOn`. */
export function startOfWeek(d: CivilDate, weekStartsOn: WeekStart): CivilDate {
  return addDays(d, -((weekday(d) - weekStartsOn + 7) % 7));
}

/**
 * The days on screen, in order.
 *
 * Month is a fixed SIX rows (42 days), not "however many the month needs".
 * A grid that changes height between months makes every row jump when you page
 * through the year, and 6 rows is the only count that fits every case (a
 * 31-day month starting on the last day of a week spans 6).
 */
export function gridDays(spec: GridSpec): CivilDate[] {
  const { kind, anchor, weekStartsOn } = spec;
  if (kind === "day") return [anchor];
  if (kind === "week") {
    const first = startOfWeek(anchor, weekStartsOn);
    return Array.from({ length: 7 }, (_, i) => addDays(first, i));
  }
  const first = startOfWeek({ ...anchor, day: 1 }, weekStartsOn);
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

/** Which of the grid's days belong to the anchored month (month view only). */
export function isInPeriod(spec: GridSpec, d: CivilDate): boolean {
  if (spec.kind !== "month") return true;
  return d.year === spec.anchor.year && d.month === spec.anchor.month;
}

/**
 * Page forward/back by one period.
 *
 * The month case normalises to the 1st before adding, which is what stops
 * 31 January + 1 month from becoming 3 March. `gridDays` ignores the anchor's
 * DAY in a month view anyway, so nothing is lost.
 */
export function shiftGrid(spec: GridSpec, delta: number): GridSpec {
  if (spec.kind === "month") return { ...spec, anchor: addMonths({ ...spec.anchor, day: 1 }, delta) };
  return { ...spec, anchor: addDays(spec.anchor, delta * (spec.kind === "week" ? 7 : 1)) };
}

/**
 * Switch view without losing your place — the anchor is carried through
 * untouched.
 *
 * It deliberately does NOT normalise a month anchor to the 1st. It used to,
 * and driving the built page in a browser is what caught it: opening on the
 * month and pressing "Week" landed you on the week containing the 1st rather
 * than the week containing today, because the day had already been thrown
 * away. A month grid reads only the anchor's year and month (`gridDays`,
 * `gridTitle`, `isInPeriod`), so keeping the day costs nothing and is the only
 * way week and day views can know which day you meant.
 */
export function withView(spec: GridSpec, kind: ViewKind): GridSpec {
  return kind === spec.kind ? spec : { ...spec, kind };
}

export interface QueryWindow {
  /** UTCDate for `CalendarEvent/getOccurrences.after`. */
  after: string;
  before: string;
}

/**
 * The padded window for the grid. See the header for why it is not exact.
 *
 * Both bounds are built from `Date.UTC` on a civil date, so this function is
 * deterministic under any `TZ` — the padding absorbs the offset rather than a
 * calculation removing it.
 */
export function queryWindow(days: CivilDate[]): QueryWindow {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) throw new Error("queryWindow needs at least one day");
  return {
    after: new Date(utcMsOf(first) - WINDOW_PAD_BEFORE_DAYS * 86_400_000).toISOString(),
    // `last` is a date; the day itself ends 24h later, then pad.
    before: new Date(utcMsOf(last) + (1 + WINDOW_PAD_AFTER_DAYS) * 86_400_000).toISOString(),
  };
}

/**
 * Stable identity for a grid's FETCH WINDOW, so a load effect refires only when
 * the days on screen actually change.
 *
 * Keyed by what `gridDays` reads, not by the raw anchor: a month view ignores
 * the anchor's day and a week view ignores which day of the week it is, so
 * moving the anchor inside the same period must not re-request the window.
 * That matters now that `withView` carries the day through.
 */
export function windowKey(spec: GridSpec): string {
  const suffix = `:${spec.weekStartsOn}`;
  if (spec.kind === "month") {
    return `month:${spec.anchor.year}-${String(spec.anchor.month).padStart(2, "0")}${suffix}`;
  }
  if (spec.kind === "week") return `week:${dayKey(startOfWeek(spec.anchor, spec.weekStartsOn))}${suffix}`;
  return `day:${dayKey(spec.anchor)}${suffix}`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Short weekday headings in grid order. */
export function weekdayHeadings(weekStartsOn: WeekStart): string[] {
  return Array.from({ length: 7 }, (_, i) => WEEKDAYS[(i + weekStartsOn) % 7]!.slice(0, 3));
}

/**
 * What the period is called. Hand-rolled rather than `toLocaleDateString`
 * because that reads the HOST zone and locale — the same nondeterminism the
 * rest of this module is built to avoid, and it would put a test's expected
 * string at the mercy of the machine's ICU data.
 */
export function gridTitle(spec: GridSpec): string {
  const { kind, anchor } = spec;
  const month = MONTHS[anchor.month - 1] ?? "";
  if (kind === "month") return `${month} ${anchor.year}`;
  if (kind === "day") return `${WEEKDAYS[weekday(anchor)]}, ${month} ${anchor.day}, ${anchor.year}`;
  const days = gridDays(spec);
  const first = days[0]!;
  const last = days[6]!;
  const firstMonth = MONTHS[first.month - 1] ?? "";
  const lastMonth = MONTHS[last.month - 1] ?? "";
  if (first.year !== last.year) {
    return `${firstMonth} ${first.day}, ${first.year} – ${lastMonth} ${last.day}, ${last.year}`;
  }
  if (first.month !== last.month) {
    return `${firstMonth} ${first.day} – ${lastMonth} ${last.day}, ${last.year}`;
  }
  return `${firstMonth} ${first.day}–${last.day}, ${first.year}`;
}
