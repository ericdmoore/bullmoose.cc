// Wall-clock date arithmetic, with the browser's own timezone kept OUT of it.
//
// The rule this module exists to enforce: **a calendar grid is made of civil
// dates, not of instants.** "Tuesday the 8th" is a label on a wall, not a
// moment; `new Date("2026-07-08T09:00:00")` is a moment, and which moment
// depends on where the machine running it happens to be. Building a grid out of
// `Date` and local getters is how a calendar renders the wrong week for anyone
// east of the author, and how a test passes in `TZ=America/New_York` and fails
// in CI.
//
// So: dates are `{year, month, day}` records, arithmetic is done in UTC (which
// has no DST and therefore no 23- or 25-hour days to trip over), and the ONE
// place a zone enters is `zonedFields` — reading which wall clock an instant
// shows in a NAMED zone. The zone is always a parameter, never
// `Intl…resolvedOptions()` reached for in a helper, so every function here is
// deterministic under any `TZ`.
//
// ⚠️ There is deliberately no wall-clock → instant conversion here (the
// direction `calendar-core`'s `zonedToUtc` handles with a three-pass offset
// solve, `packages/calendar-core/src/index.ts:153-164`). Nothing in this
// surface needs it: query windows are PADDED rather than exact (`grid.ts`), and
// the editor writes the wall clock the user typed straight through as
// JSCalendar's `start` — which is what JSCalendar wants anyway. Not needing it
// is the point; a second offset solver in the browser is a second thing to be
// wrong about DST.

/** A day on a wall calendar. `month` is 1-12, matching JSCalendar, not Date. */
export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** A civil date plus a wall clock, i.e. JSCalendar's LocalDateTime fields. */
export interface CivilDateTime extends CivilDate {
  hour: number;
  minute: number;
  second: number;
}

const p2 = (n: number): string => String(n).padStart(2, "0");

/** "2026-07-08" — the key every day-bucketed structure here is keyed by. */
export function dayKey(d: CivilDate): string {
  return `${String(d.year).padStart(4, "0")}-${p2(d.month)}-${p2(d.day)}`;
}

/** "2026-07-08T09:00:00" — JSCalendar's LocalDateTime spelling. */
export function formatCivilDateTime(dt: CivilDateTime): string {
  return `${dayKey(dt)}T${p2(dt.hour)}:${p2(dt.minute)}:${p2(dt.second)}`;
}

/**
 * Parse a JSCalendar LocalDateTime by REGEX, never by `new Date(s)`.
 *
 * `new Date("2026-07-08T09:00:00")` is specified to mean local time, so it
 * silently mixes the browser's zone into a value that is supposed to be
 * zone-free. Same shape as `calendar-core`'s `parseLocalDateTime`
 * (`packages/calendar-core/src/index.ts:93`), for the same reason.
 */
export function parseCivilDateTime(s: string): CivilDateTime | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6] ?? 0),
  };
}

/** Parse "2026-07-08" (an `<input type="date">` value). */
export function parseDayKey(s: string): CivilDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  // Reject 2026-02-31: `Date.UTC` would roll it into March and the grid would
  // quietly show a month the user did not ask for.
  return dayKey(fromUtcMs(utcMsOf(d))) === s ? d : null;
}

/** Parse "09:30" (an `<input type="time">` value) to minutes past midnight. */
export function parseClock(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Minutes past midnight → "09:30". */
export function formatClock(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${p2(Math.floor(m / 60))}:${p2(m % 60)}`;
}

/**
 * A civil date as UTC epoch ms — the arithmetic carrier, NOT an instant with
 * any meaning of its own. Never render this; only add to it and compare it.
 */
export function utcMsOf(d: CivilDate): number {
  return Date.UTC(d.year, d.month - 1, d.day);
}

function fromUtcMs(ms: number): CivilDate {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function addDays(d: CivilDate, days: number): CivilDate {
  return fromUtcMs(utcMsOf(d) + days * 86_400_000);
}

/** Whole days from `a` to `b`. Exact, because both sides are UTC midnights. */
export function daysBetween(a: CivilDate, b: CivilDate): number {
  return Math.round((utcMsOf(b) - utcMsOf(a)) / 86_400_000);
}

export function addMonths(d: CivilDate, months: number): CivilDate {
  const total = d.year * 12 + (d.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  // Clamp rather than roll: "one month after Jan 31" must be in February.
  return { year, month, day: Math.min(d.day, daysInMonth(year, month)) };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0=Sunday … 6=Saturday, matching `Date.getUTCDay` and `weekStartsOn`. */
export function weekday(d: CivilDate): number {
  return new Date(utcMsOf(d)).getUTCDay();
}

export function sameDay(a: CivilDate, b: CivilDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

export function compareDays(a: CivilDate, b: CivilDate): number {
  return utcMsOf(a) - utcMsOf(b);
}

// ── the one place a timezone is read ──────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/**
 * Which wall clock does `utcMs` read as in `timeZone`?
 *
 * The only zone-aware operation the calendar surface performs, and the safe
 * direction: one `Intl` lookup, exact, no iteration. (The other direction —
 * wall clock → instant — needs an offset solve because a wall clock can be
 * ambiguous or nonexistent across a DST boundary. We never do it; see the
 * header.) Mirrors `calendar-core`'s `wallClockAt`
 * (`packages/calendar-core/src/index.ts:132`) so the two agree on the hour-24
 * quirk some ICU builds emit for midnight.
 */
export function zonedFields(utcMs: number, timeZone: string): CivilDateTime {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: hour === 24 ? 0 : hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Minutes past local midnight, the vertical coordinate of a timed view. */
export function minutesOfDay(dt: Pick<CivilDateTime, "hour" | "minute">): number {
  return dt.hour * 60 + dt.minute;
}

/** The viewer's own zone. Isolated here so no pure function reaches for it. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
