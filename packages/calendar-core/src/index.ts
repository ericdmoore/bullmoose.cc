/**
 * calendar-core — the recurrence/timezone engine under the JSCalendar
 * core (devPlan-handoff Phase 4: "the concentrated risk lands here").
 *
 * JSCalendar (RFC 8984) events carry a LOCAL wall-clock `start`
 * ("2026-07-08T09:00:00") plus an IANA `timeZone`; recurrence steps in
 * WALL-CLOCK time (a 9am weekly standup stays 9am across DST), so the
 * expander does its arithmetic on local date fields and converts each
 * occurrence to UTC through the zone's offset at that instant (derived
 * from Intl — no bundled tz database).
 *
 * Expansion is on-demand and CAPPED (locked decision: never pre-compute
 * unbounded series). Supported rule parts: FREQ daily/weekly/monthly/
 * yearly, INTERVAL, COUNT, UNTIL, BYDAY (with nthOfPeriod, e.g. 2nd
 * Monday / last Friday), BYMONTHDAY, BYMONTH, BYSETPOS; plus
 * recurrenceOverrides (excluded occurrences, per-occurrence patches,
 * and added RDATE-style occurrences).
 */

export type JSCalendarEvent = Record<string, unknown>;

export interface Occurrence {
  /** Master event id is supplied by the caller; this is the recurrence id. */
  recurrenceId: string; // LocalDateTime of the (unmodified) occurrence start
  /** UTC epoch ms of the actual (possibly overridden) start. */
  startMs: number;
  /** UTC epoch ms of the end (start + duration). */
  endMs: number;
  /** Local wall-clock start actually in effect (after overrides). */
  start: string;
  /** Title override if the occurrence patches it. */
  title?: string;
  excluded?: boolean;
}

export interface RecurrenceRule {
  frequency?: string;
  interval?: number;
  count?: number;
  until?: string; // LocalDateTime
  byDay?: Array<{ day?: string; nthOfPeriod?: number }>;
  byMonthDay?: number[];
  byMonth?: string[]; // RFC 8984: month numbers as strings ("1".."12")
  bySetPosition?: number[];
  [key: string]: unknown;
}

/** Hard cap on occurrences materialized per expansion call. */
export const MAX_OCCURRENCES = 1000;
/** Iteration guard for sparse rules (e.g. Feb 30 never matches). */
const MAX_ITERATIONS = 20000;

// ---- ISO 8601 duration -----------------------------------------------

/** "PT1H30M" | "P1D" | "PT45M" → milliseconds (dates approximate: D=24h). */
export function parseDuration(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const m = raw.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return 0;
  const [, sign, w, d, h, min, s] = m;
  const ms =
    (Number(w ?? 0) * 7 + Number(d ?? 0)) * 86_400_000 +
    Number(h ?? 0) * 3_600_000 +
    Number(min ?? 0) * 60_000 +
    Number(s ?? 0) * 1000;
  return sign === "-" ? -ms : ms;
}

// ---- local wall-clock ⇄ UTC ------------------------------------------

export interface LocalDateTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
}

export function parseLocalDateTime(s: string): LocalDateTime | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  };
}

export function formatLocalDateTime(dt: LocalDateTime): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${String(dt.year).padStart(4, "0")}-${p2(dt.month)}-${p2(dt.day)}T${p2(dt.hour)}:${p2(dt.minute)}:${p2(dt.second)}`;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function tzFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
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
    dtfCache.set(timeZone, f);
  }
  return f;
}

/** What wall-clock does `utcMs` read as in `timeZone`? */
function wallClockAt(utcMs: number, timeZone: string): LocalDateTime {
  const parts = tzFormatter(timeZone).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") === 24 ? 0 : get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

const asUtcMs = (dt: LocalDateTime) =>
  Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second);

/**
 * Local wall-clock in an IANA zone → UTC epoch ms. Two-pass offset
 * resolution handles DST; times inside a spring-forward gap resolve to
 * the post-transition reading (Apple-compatible behavior).
 */
export function zonedToUtc(dt: LocalDateTime, timeZone: string): number {
  if (timeZone === "Etc/UTC" || timeZone === "UTC") return asUtcMs(dt);
  const target = asUtcMs(dt);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const offset = asUtcMs(wallClockAt(guess, timeZone)) - guess;
    const next = target - offset;
    if (next === guess) return guess;
    guess = next;
  }
  return guess;
}

// ---- date field arithmetic (calendar-safe) -----------------------------

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

function addDays(dt: LocalDateTime, days: number): LocalDateTime {
  const d = new Date(asUtcMs(dt) + days * 86_400_000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: dt.hour,
    minute: dt.minute,
    second: dt.second,
  };
}

function addMonths(dt: LocalDateTime, months: number): LocalDateTime {
  const total = dt.year * 12 + (dt.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return { ...dt, year, month, day: Math.min(dt.day, daysInMonth(year, month)) };
}

/** 0=Monday … 6=Sunday (RFC 5545 week semantics, WKST=MO). */
function weekday(dt: LocalDateTime): number {
  const wd = new Date(asUtcMs(dt)).getUTCDay(); // 0=Sun
  return (wd + 6) % 7;
}

const DAY_CODES = ["mo", "tu", "we", "th", "fr", "sa", "su"];

// ---- recurrence expansion ----------------------------------------------

export interface ExpandOptions {
  /** Window (UTC ms); occurrences overlapping [after, before) return. */
  after?: number;
  before?: number;
  maxOccurrences?: number;
}

/**
 * Expand an event's occurrences (including the non-recurring single
 * occurrence). Overrides apply: excluded ones are dropped, patched ones
 * shift/rename, and override keys not generated by the rule are ADDED.
 */
export function expandOccurrences(event: JSCalendarEvent, opts: ExpandOptions = {}): Occurrence[] {
  const timeZone = typeof event.timeZone === "string" ? event.timeZone : "Etc/UTC";
  const start = typeof event.start === "string" ? parseLocalDateTime(event.start) : null;
  if (!start) return [];
  const durationMs = parseDuration(event.duration) || (event.showWithoutTime ? 86_400_000 : 0);
  const max = Math.min(opts.maxOccurrences ?? MAX_OCCURRENCES, MAX_OCCURRENCES);

  const rules = Array.isArray(event.recurrenceRules)
    ? (event.recurrenceRules as RecurrenceRule[])
    : [];
  const overrides = (event.recurrenceOverrides ?? {}) as Record<string, Record<string, unknown>>;

  // Base series: the master start plus rule expansions (deduped).
  // Generation runs to the WINDOW horizon (or the hard cap), never the
  // caller's result cap — otherwise a small cap would stop the series
  // before it reaches the window.
  const baseStarts = new Map<string, LocalDateTime>();
  baseStarts.set(formatLocalDateTime(start), start);
  for (const rule of rules) {
    for (const dt of expandRule(start, rule, timeZone, opts, MAX_OCCURRENCES)) {
      baseStarts.set(formatLocalDateTime(dt), dt);
    }
  }

  const out: Occurrence[] = [];
  const push = (recurrenceId: string, dt: LocalDateTime, patch?: Record<string, unknown>) => {
    let effStart = dt;
    let effDuration = durationMs;
    let title: string | undefined;
    if (patch) {
      if (typeof patch.start === "string") {
        const p = parseLocalDateTime(patch.start);
        if (p) effStart = p;
      }
      if (typeof patch.duration === "string") effDuration = parseDuration(patch.duration);
      if (typeof patch.title === "string") title = patch.title;
    }
    const startMs = zonedToUtc(effStart, timeZone);
    out.push({
      recurrenceId,
      startMs,
      endMs: startMs + effDuration,
      start: formatLocalDateTime(effStart),
      ...(title !== undefined ? { title } : {}),
    });
  };

  for (const [rid, dt] of baseStarts) {
    const patch = overrides[rid];
    if (patch && patch.excluded === true) continue;
    push(rid, dt, patch);
  }
  // RDATE-style additions: override keys the rule never generated.
  for (const [rid, patch] of Object.entries(overrides)) {
    if (baseStarts.has(rid) || patch.excluded === true) continue;
    const dt = parseLocalDateTime(rid);
    if (dt) push(rid, dt, patch);
  }

  out.sort((a, b) => a.startMs - b.startMs);

  const windowed = out.filter(
    (o) =>
      (opts.before === undefined || o.startMs < opts.before) &&
      (opts.after === undefined || o.endMs > opts.after),
  );
  return windowed.slice(0, max);
}

function expandRule(
  start: LocalDateTime,
  rule: RecurrenceRule,
  timeZone: string,
  opts: ExpandOptions,
  max: number,
): LocalDateTime[] {
  const freq = (rule.frequency ?? "").toLowerCase();
  const interval = Math.max(1, rule.interval ?? 1);
  const count = rule.count;
  const until = typeof rule.until === "string" ? parseLocalDateTime(rule.until) : null;
  const untilMs = until ? zonedToUtc(until, timeZone) : null;
  const horizonMs = opts.before;

  const out: LocalDateTime[] = [];
  let produced = 0;
  const emit = (dt: LocalDateTime): boolean => {
    const ms = zonedToUtc(dt, timeZone);
    if (untilMs !== null && ms > untilMs) return false;
    out.push(dt);
    produced++;
    if (count !== undefined && produced >= count) return false;
    if (produced >= max) return false;
    return true;
  };
  const pastHorizon = (dt: LocalDateTime): boolean =>
    horizonMs !== undefined && count === undefined && zonedToUtc(dt, timeZone) >= horizonMs;

  if (freq === "daily") {
    let cur = start;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (pastHorizon(cur)) break;
      if (!emit(cur)) break;
      cur = addDays(cur, interval);
    }
    return out;
  }

  if (freq === "weekly") {
    const days = (rule.byDay ?? []).map((b) => DAY_CODES.indexOf((b.day ?? "").toLowerCase()));
    const wanted = days.filter((d) => d >= 0);
    if (wanted.length === 0) wanted.push(weekday(start));
    wanted.sort((a, b) => a - b);
    // Anchor at the Monday of the start week; step whole weeks.
    let weekStart = addDays(start, -weekday(start));
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      let done = false;
      for (const wd of wanted) {
        const cand = addDays(weekStart, wd);
        if (asUtcMs(cand) < asUtcMs(start)) continue;
        if (pastHorizon(cand)) return out;
        if (!emit(cand)) {
          done = true;
          break;
        }
      }
      if (done) break;
      weekStart = addDays(weekStart, 7 * interval);
    }
    return out;
  }

  if (freq === "monthly") {
    const byDay = rule.byDay ?? [];
    const byMonthDay = rule.byMonthDay ?? [];
    let anchor = { ...start, day: 1 };
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const candidates: LocalDateTime[] = [];
      const dim = daysInMonth(anchor.year, anchor.month);
      if (byDay.length > 0) {
        for (const spec of byDay) {
          const wd = DAY_CODES.indexOf((spec.day ?? "").toLowerCase());
          if (wd < 0) continue;
          const matches: LocalDateTime[] = [];
          for (let d = 1; d <= dim; d++) {
            const cand = { ...anchor, day: d };
            if (weekday(cand) === wd) matches.push(cand);
          }
          const nth = spec.nthOfPeriod;
          if (nth === undefined || nth === 0) candidates.push(...matches);
          else if (nth > 0 && matches[nth - 1]) candidates.push(matches[nth - 1]!);
          else if (nth < 0 && matches[matches.length + nth]) candidates.push(matches[matches.length + nth]!);
        }
      } else if (byMonthDay.length > 0) {
        for (const md of byMonthDay) {
          const d = md > 0 ? md : dim + md + 1;
          if (d >= 1 && d <= dim) candidates.push({ ...anchor, day: d });
        }
      } else {
        if (start.day <= dim) candidates.push({ ...anchor, day: start.day });
      }
      candidates.sort((a, b) => asUtcMs(a) - asUtcMs(b));
      const chosen = applySetPos(candidates, rule.bySetPosition);
      let done = false;
      for (const cand of chosen) {
        if (asUtcMs(cand) < asUtcMs(start)) continue;
        if (pastHorizon(cand)) return out;
        if (!emit(cand)) {
          done = true;
          break;
        }
      }
      if (done) break;
      anchor = addMonths(anchor, interval);
    }
    return out;
  }

  if (freq === "yearly") {
    const months =
      (rule.byMonth ?? []).map(Number).filter((m) => m >= 1 && m <= 12).length > 0
        ? (rule.byMonth ?? []).map(Number).filter((m) => m >= 1 && m <= 12)
        : [start.month];
    let year = start.year;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const candidates: LocalDateTime[] = [];
      for (const month of months) {
        const dim = daysInMonth(year, month);
        if (start.day <= dim) candidates.push({ ...start, year, month });
      }
      candidates.sort((a, b) => asUtcMs(a) - asUtcMs(b));
      let done = false;
      for (const cand of candidates) {
        if (asUtcMs(cand) < asUtcMs(start)) continue;
        if (pastHorizon(cand)) return out;
        if (!emit(cand)) {
          done = true;
          break;
        }
      }
      if (done) break;
      year += interval;
    }
    return out;
  }

  return out;
}

function applySetPos(candidates: LocalDateTime[], bySetPos?: number[]): LocalDateTime[] {
  if (!bySetPos || bySetPos.length === 0) return candidates;
  const out: LocalDateTime[] = [];
  for (const pos of bySetPos) {
    const pick = pos > 0 ? candidates[pos - 1] : candidates[candidates.length + pos];
    if (pick) out.push(pick);
  }
  return out.sort((a, b) => asUtcMs(a) - asUtcMs(b));
}

// ---- write-time extraction ---------------------------------------------

export interface EventSpan {
  startMs: number | null;
  /** null = unbounded recurrence (treat as +infinity in queries). */
  endMs: number | null;
  isRecurring: boolean;
}

/** Indexed span for the calendar_events columns: first start → last end. */
export function eventSpan(event: JSCalendarEvent): EventSpan {
  const timeZone = typeof event.timeZone === "string" ? event.timeZone : "Etc/UTC";
  const start = typeof event.start === "string" ? parseLocalDateTime(event.start) : null;
  if (!start) return { startMs: null, endMs: null, isRecurring: false };
  const durationMs = parseDuration(event.duration) || (event.showWithoutTime ? 86_400_000 : 0);
  const startMs = zonedToUtc(start, timeZone);

  const rules = Array.isArray(event.recurrenceRules)
    ? (event.recurrenceRules as RecurrenceRule[])
    : [];
  const hasOverrideAdds = Object.keys((event.recurrenceOverrides ?? {}) as object).length > 0;
  if (rules.length === 0 && !hasOverrideAdds) {
    return { startMs, endMs: startMs + durationMs, isRecurring: false };
  }

  // Bounded if every rule has count/until: materialize (capped) to find
  // the true end. Any unbounded rule → endMs null.
  const unbounded = rules.some((r) => r.count === undefined && r.until === undefined);
  if (unbounded) return { startMs, endMs: null, isRecurring: true };
  const occ = expandOccurrences(event, { maxOccurrences: MAX_OCCURRENCES });
  const last = occ[occ.length - 1];
  return {
    startMs,
    endMs: occ.length >= MAX_OCCURRENCES ? null : (last?.endMs ?? startMs + durationMs),
    isRecurring: true,
  };
}
