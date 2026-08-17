// Where an occurrence lands on the grid — and the one fork that decides it.
//
// ══════════════════════════════════════════════════════════════════════════
//  ALL-DAY EVENTS ARE PLACED FROM `start`. TIMED EVENTS ARE PLACED FROM
//  `utcStart`. Getting this backwards is the off-by-one-day bug.
// ══════════════════════════════════════════════════════════════════════════
//
// `CalendarEvent/getOccurrences` returns both spellings of every occurrence
// (`services/jmap/src/methods/calendars.ts:434-445`):
//
//   start     the wall clock in the EVENT's own timezone — "2026-07-08T00:00:00"
//   utcStart  the instant that wall clock names — "2026-07-08T04:00:00Z"
//
// For a **timed** event those are the same moment described twice, and a viewer
// wants it in THEIR zone: a 09:00 New York call is 14:00 in London, and London
// should see it at 14:00. So timed placement reads `utcStart` and converts.
//
// For an **all-day** event `utcStart` is an artefact. Midnight had to be
// resolved through some zone to become an instant at all, and the server uses
// `Etc/UTC` whenever `timeZone` is not a string (`calendar-core:420`) — which
// is also exactly what the CalDAV importer stores for a `VALUE=DATE` DTSTART
// (`packages/calendar-core/src/ical.ts:473`: `timeZone: startInfo.allDay ?
// "Etc/UTC" : timeZone`). Convert that instant into a viewer's zone and every
// browser west of UTC moves the event to the day before: New Year's Day renders
// on 31 December for everyone in the Americas. An all-day event is a DATE, not
// a moment, and the only correct handling is to never let it become one — so
// this module reads civil fields straight out of `start` on that branch and
// never parses `utcStart` for placement.
//
// The same discipline applies to the end. An all-day span's LENGTH comes from
// the `utcEnd - utcStart` difference — a duration, which no zone distorts —
// rather than from `utcEnd`'s calendar date, which has the identical off-by-one
// hazard as its start.

import { addDays, dayKey, daysBetween, minutesOfDay, parseCivilDateTime, zonedFields, type CivilDate } from "./civil";
import type { Occurrence } from "./types";

/** One occurrence as it appears on ONE day of the grid. */
export interface DaySegment {
  /** The local day this row belongs to, "YYYY-MM-DD". */
  day: string;
  eventId: string;
  /** The occurrence key — what `recurrenceOverrides` is keyed by. */
  recurrenceId: string;
  calendarId: string;
  title: string;
  allDay: boolean;
  /** Minutes past local midnight, clipped to this day. All-day: 0 … 1440. */
  fromMinute: number;
  toMinute: number;
  /** The occurrence began before this day / ends after it. */
  continuesBefore: boolean;
  continuesAfter: boolean;
  /**
   * Sort discriminator only. The occurrence's instant for a timed row, and
   * `-Infinity` for all-day — which has no instant, and belongs above
   * everything timed rather than at some hour of the morning.
   */
  sortKey: number;
}

export const MINUTES_PER_DAY = 1440;
/** Guard: a pathological duration must not turn one event into 10,000 rows. */
const MAX_SPAN_DAYS = 400;

/**
 * The days an occurrence covers, and how much of each.
 *
 * `viewerZone` is a parameter rather than read from `Intl` inside, so this is
 * deterministic under any `TZ`. The placement rule is exactly the thing worth
 * pinning in a test, and a function that consults the host clock cannot be.
 */
export function segmentsFor(occ: Occurrence, viewerZone: string): DaySegment[] {
  const base = {
    eventId: occ.eventId,
    recurrenceId: occ.recurrenceId,
    calendarId: occ.calendarId,
    title: occ.title && occ.title.length > 0 ? occ.title : "(no title)",
  };

  if (occ.showWithoutTime) {
    // ── all-day: civil fields only; `utcStart` is never converted ─────────
    const start = parseCivilDateTime(occ.start);
    if (!start) return [];
    const spanDays = allDaySpan(occ);
    return Array.from({ length: spanDays }, (_, i) => ({
      ...base,
      day: dayKey(addDays(start, i)),
      allDay: true,
      fromMinute: 0,
      toMinute: MINUTES_PER_DAY,
      continuesBefore: i > 0,
      continuesAfter: i < spanDays - 1,
      sortKey: Number.NEGATIVE_INFINITY,
    }));
  }

  // ── timed: the instant, read in the viewer's zone ───────────────────────
  const startMs = Date.parse(occ.utcStart);
  if (!Number.isFinite(startMs)) return [];
  const rawEndMs = Date.parse(occ.utcEnd);
  const endMs = Number.isFinite(rawEndMs) && rawEndMs >= startMs ? rawEndMs : startMs;

  const startLocal = zonedFields(startMs, viewerZone);
  const endLocal = zonedFields(endMs, viewerZone);
  const startMinute = minutesOfDay(startLocal);
  const endMinute = minutesOfDay(endLocal);

  let spanDays = daysBetween(startLocal, endLocal) + 1;
  // An event ending exactly at local midnight belongs to the day it started,
  // not to a zero-length sliver at the top of the next one. Folding that day
  // away also means the LAST kept day runs to 24:00 rather than to `endMinute`,
  // which is 0 — otherwise a 23:00–00:00 meeting renders as ending at 23:00.
  const endsAtMidnight = spanDays > 1 && endMinute === 0;
  if (endsAtMidnight) spanDays -= 1;
  spanDays = Math.min(MAX_SPAN_DAYS, Math.max(1, spanDays));

  return Array.from({ length: spanDays }, (_, i) => {
    const first = i === 0;
    const last = i === spanDays - 1;
    const from = first ? startMinute : 0;
    return {
      ...base,
      day: dayKey(addDays(startLocal, i)),
      allDay: false,
      fromMinute: from,
      // The final day ends at the event's end — unless that end was a midnight
      // folded away above, in which case this day runs to 24:00. Never below
      // `from`, or a zero-height row disappears.
      toMinute: last && !endsAtMidnight ? Math.max(from, endMinute) : MINUTES_PER_DAY,
      continuesBefore: !first,
      continuesAfter: !last,
      sortKey: startMs,
    };
  });
}

/**
 * How many days an all-day occurrence covers.
 *
 * From the duration, not from the end date. `getOccurrences` computes
 * `endMs = startMs + durationMs` (`calendars.ts:438-439`) where a
 * `showWithoutTime` event with no explicit `duration` gets exactly one day
 * (`calendar-core:423`), so the difference is a whole number of days. Rounded
 * rather than floored because the two instants can straddle a DST transition
 * and be 23 or 25 hours apart per day.
 */
function allDaySpan(occ: Occurrence): number {
  const startMs = Date.parse(occ.utcStart);
  const endMs = Date.parse(occ.utcEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 1;
  return Math.min(MAX_SPAN_DAYS, Math.max(1, Math.round((endMs - startMs) / 86_400_000)));
}

/**
 * Bucket every occurrence by the local day it shows on.
 *
 * A Map keyed by `dayKey` so a month grid looks each cell up in O(1) instead
 * of filtering the whole occurrence list 42 times.
 */
export function segmentsByDay(occurrences: Occurrence[], viewerZone: string): Map<string, DaySegment[]> {
  const out = new Map<string, DaySegment[]>();
  for (const occ of occurrences) {
    for (const seg of segmentsFor(occ, viewerZone)) {
      const bucket = out.get(seg.day);
      if (bucket) bucket.push(seg);
      else out.set(seg.day, [seg]);
    }
  }
  for (const bucket of out.values()) bucket.sort(compareSegments);
  return out;
}

/** All-day first, then by instant, then by title so the order is stable. */
export function compareSegments(a: DaySegment, b: DaySegment): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
  if (a.fromMinute !== b.fromMinute) return a.fromMinute - b.fromMinute;
  return a.title.localeCompare(b.title);
}

export function segmentsOn(byDay: Map<string, DaySegment[]>, d: CivilDate): DaySegment[] {
  return byDay.get(dayKey(d)) ?? [];
}

// ── overlap layout ────────────────────────────────────────────────────────

export interface LaidOutSegment {
  segment: DaySegment;
  /** 0-based column within its overlap cluster. */
  column: number;
  /** Columns the cluster needs — the divisor for a percentage width. */
  columns: number;
}

/**
 * Side-by-side columns for overlapping timed segments.
 *
 * Greedy interval packing over a cluster: segments that transitively overlap
 * share one width. Two 10:00 meetings each take half the column. A third at
 * 10:30 overlapping only the second still widens the whole cluster to three,
 * because a cluster has a single width — the standard behaviour, and the
 * alternative (per-segment widths) produces a ragged grid that is harder to
 * read than a slightly narrow one.
 *
 * All-day segments are excluded: they render in their own band above the timed
 * area, where they do not compete for horizontal space.
 */
export function layoutDay(segments: DaySegment[]): LaidOutSegment[] {
  const timed = segments.filter((s) => !s.allDay).sort(compareSegments);
  const out: LaidOutSegment[] = [];

  let cluster: LaidOutSegment[] = [];
  let clusterEnd = -1;
  const flush = (): void => {
    const columns = Math.max(1, ...cluster.map((c) => c.column + 1));
    for (const item of cluster) item.columns = columns;
    out.push(...cluster);
    cluster = [];
    clusterEnd = -1;
  };

  for (const segment of timed) {
    // A gap: nothing still open can overlap what comes next, so the cluster's
    // width is settled.
    if (cluster.length > 0 && segment.fromMinute >= clusterEnd) flush();
    const taken = new Set(cluster.filter((c) => c.segment.toMinute > segment.fromMinute).map((c) => c.column));
    let column = 0;
    while (taken.has(column)) column++;
    cluster.push({ segment, column, columns: 1 });
    clusterEnd = Math.max(clusterEnd, segment.toMinute);
  }
  if (cluster.length > 0) flush();
  return out;
}
