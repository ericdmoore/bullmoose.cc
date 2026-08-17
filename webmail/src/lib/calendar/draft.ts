// The editor's model: form fields ⇄ a JSCalendar Event, and the recurrence
// vocabulary the form is allowed to speak.
//
// Two rules shape everything here.
//
// **1. The server refuses recurrence rules it would mis-expand, and the form
// must not offer them.** `CalendarEvent/set` runs every rule through
// `eventSpan` → `unsupportedRuleReason` and returns `invalidProperties` rather
// than storing a rule whose dates would be wrong
// (`services/jmap/src/methods/calendars.ts:530-537`,
// `packages/calendar-core/src/index.ts:281`). That guard is `.feedback`
// `common/003`, now CLOSED — `FREQ=YEARLY;BYMONTH=11;BYDAY=4TH` (US
// Thanksgiving, a rule Apple Calendar emits) used to expand to "the start day
// of every November", wrong by up to four days, silently. The parts each
// frequency actually reads are declared per-frequency in `SUPPORTED_PARTS`
// (`calendar-core:215`), and the union is NOT what any single rule may use:
// `FREQ=DAILY;BYDAY=MO` and `FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25` are both
// refused. `REPEAT_CHOICES` below is a deliberately NARROWER subset of that
// table — narrower, because a form that can build a rule it cannot also read
// back would lose the user's setting on the next open.
//
// **2. A rule the form cannot express must survive being edited.** Someone
// syncs "the last Friday of every month" from Apple Calendar over CalDAV, then
// renames it here. If the patch shipped the form's idea of recurrence, the rule
// would be flattened. So `draftToPatch` emits `recurrenceRules` ONLY when the
// stored rules were expressible AND the form changed them; otherwise the key is
// absent from the PatchObject and the server leaves the stored value alone
// (`applyEventPatch`, `calendars.ts:680`). `frozenRules` carries the
// unexpressible rule so the editor can show it read-only instead of pretending
// it is not there.

import {
  addDays,
  compareDays,
  dayKey,
  daysBetween,
  formatClock,
  formatCivilDateTime,
  parseCivilDateTime,
  parseClock,
  parseDayKey,
  weekday,
  type CivilDate,
} from "./civil";
import type { CalendarEvent, RecurrenceRule } from "./types";

/**
 * The timezone written on an all-day event.
 *
 * `Etc/UTC` exactly matches what the CalDAV importer stores for a
 * `VALUE=DATE` DTSTART (`packages/calendar-core/src/ical.ts:473`), so an
 * all-day event created here and one synced in from Apple Calendar produce
 * byte-identical blobs — and therefore identical `getOccurrences` output and
 * identical placement (`place.ts`). It is also what the expander would have
 * defaulted to anyway (`calendar-core:420`); writing it explicitly means the
 * value never depends on where the browser happens to be.
 */
export const ALL_DAY_ZONE = "Etc/UTC";

export const DAY_CODES = ["mo", "tu", "we", "th", "fr", "sa", "su"] as const;
export type DayCode = (typeof DAY_CODES)[number];
/** `civil.weekday` is 0=Sunday; `DAY_CODES` is RFC 5545 order, 0=Monday. */
const DAY_CODE_FOR_WEEKDAY: DayCode[] = ["su", "mo", "tu", "we", "th", "fr", "sa"];

export const DAY_LABELS: Record<DayCode, string> = {
  mo: "Mon",
  tu: "Tue",
  we: "Wed",
  th: "Thu",
  fr: "Fri",
  sa: "Sat",
  su: "Sun",
};

export type RepeatFrequency = "" | "daily" | "weekly" | "monthly" | "yearly";

/**
 * Every frequency the form offers, with the extra part it is allowed to carry.
 * A strict subset of `SUPPORTED_PARTS` (`calendar-core:215`) — see rule 1.
 */
export const REPEAT_CHOICES: ReadonlyArray<{ value: RepeatFrequency; label: string }> = [
  { value: "", label: "Does not repeat" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];

/**
 * Monthly has two shapes the expander reads, and they must not be combined —
 * the branch is `if (byDay) … else if (byMonthDay)`, so a rule carrying both
 * silently drops one, which `unsupportedRuleReason` refuses outright
 * (`calendar-core:395-400`).
 *   dayOfMonth  — no BY part at all; the branch falls back to `start.day`.
 *   nthWeekday  — `byDay` with `nthOfPeriod`, the ONLY branch that reads it.
 */
export type MonthlyMode = "dayOfMonth" | "nthWeekday";

export interface RepeatForm {
  frequency: RepeatFrequency;
  interval: number;
  /** Weekly only. Empty = "the day the event starts on". */
  weekdays: DayCode[];
  monthlyMode: MonthlyMode;
  ends: "never" | "count" | "until";
  count: number;
  /** "YYYY-MM-DD"; sent as an end-of-day LocalDateTime. */
  until: string;
}

export function emptyRepeat(): RepeatForm {
  return {
    frequency: "",
    interval: 1,
    weekdays: [],
    monthlyMode: "dayOfMonth",
    ends: "never",
    count: 10,
    until: "",
  };
}

export interface EventDraft {
  /** Absent on create. */
  id?: string;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  /** "YYYY-MM-DD". */
  startDate: string;
  /** "HH:MM"; ignored when `allDay`. */
  startTime: string;
  /** Inclusive for all-day (the last day), exclusive-in-effect for timed. */
  endDate: string;
  endTime: string;
  /** IANA zone the wall clocks above are read in. `ALL_DAY_ZONE` when all-day. */
  timeZone: string;
  repeat: RepeatForm;
  /**
   * Stored rules the form cannot express. Present ⇒ the repeat controls are
   * disabled and `draftToPatch` never touches `recurrenceRules`.
   */
  frozenRules?: RecurrenceRule[];
}

// ── ISO 8601 durations ────────────────────────────────────────────────────
// Same grammar as `calendar-core`'s `parseDuration` (`index.ts:71`); see
// `types.ts` for why calendar-core is transcribed rather than imported.

export function parseDurationMs(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const m =
    /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(raw);
  if (!m) return 0;
  const ms =
    (Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 86_400_000 +
    Number(m[4] ?? 0) * 3_600_000 +
    Number(m[5] ?? 0) * 60_000 +
    Number(m[6] ?? 0) * 1000;
  return m[1] === "-" ? -ms : ms;
}

/** ms → "P2D" / "PT1H30M". Whole days collapse to `P<n>D`, matching `ical.ts`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  if (total === 0) return "PT0S";
  if (total % 1440 === 0) return `P${total / 1440}D`;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `PT${hours > 0 ? `${hours}H` : ""}${minutes > 0 ? `${minutes}M` : ""}`;
}

// ── recurrence: form → rules ──────────────────────────────────────────────

/** The nth occurrence of this weekday within its month (1-5), for `nthWeekday`. */
export function nthWeekdayOfMonth(d: CivilDate): number {
  return Math.floor((d.day - 1) / 7) + 1;
}

export function rulesFromRepeat(repeat: RepeatForm, start: CivilDate): RecurrenceRule[] {
  if (repeat.frequency === "") return [];
  const rule: RecurrenceRule = { frequency: repeat.frequency };
  if (repeat.interval > 1) rule.interval = repeat.interval;

  if (repeat.frequency === "weekly" && repeat.weekdays.length > 0) {
    rule.byDay = [...repeat.weekdays]
      .sort((a, b) => DAY_CODES.indexOf(a) - DAY_CODES.indexOf(b))
      .map((day) => ({ day }));
  }
  if (repeat.frequency === "monthly" && repeat.monthlyMode === "nthWeekday") {
    rule.byDay = [
      { day: DAY_CODE_FOR_WEEKDAY[weekday(start)]!, nthOfPeriod: nthWeekdayOfMonth(start) },
    ];
  }

  if (repeat.ends === "count") rule.count = repeat.count;
  // A LocalDateTime, per RFC 8984 — compared in the event's own zone
  // (`calendar-core:507-508`). End of day, so "until the 30th" includes it.
  if (repeat.ends === "until" && repeat.until) rule.until = `${repeat.until}T23:59:59`;
  return [rule];
}

/**
 * Read stored rules back into the form, or `null` when they are outside its
 * vocabulary — which freezes the controls rather than flattening the rule.
 *
 * Narrower than the server on purpose (rule 1 in the header): the server would
 * accept `FREQ=MONTHLY;BYMONTHDAY=1,15`, and this returns `null` for it, so the
 * form shows it read-only and the patch leaves it alone. Refusing to edit is
 * always safe; editing badly is not.
 */
export function repeatFromRules(
  rules: RecurrenceRule[] | undefined,
  start: CivilDate,
): RepeatForm | null {
  if (!rules || rules.length === 0) return emptyRepeat();
  // Multiple rules are legal JSCalendar and the expander unions them; the form
  // has one frequency picker and cannot say that.
  if (rules.length > 1) return null;
  const rule = rules[0]!;

  const frequency = typeof rule.frequency === "string" ? rule.frequency.toLowerCase() : "";
  if (
    frequency !== "daily" &&
    frequency !== "weekly" &&
    frequency !== "monthly" &&
    frequency !== "yearly"
  ) {
    return null;
  }

  const form = emptyRepeat();
  form.frequency = frequency;

  for (const key of Object.keys(rule)) {
    if (key === "frequency" || key === "interval" || key === "count" || key === "until") continue;
    if (key === "@type") continue;
    if (key === "byDay" && (frequency === "weekly" || frequency === "monthly")) continue;
    // firstDayOfWeek, byMonth, byMonthDay, bySetPosition, rscale, skip, or
    // anything unknown: the form has no control for it.
    if (rule[key] === undefined || rule[key] === null) continue;
    if (Array.isArray(rule[key]) && (rule[key] as unknown[]).length === 0) continue;
    return null;
  }

  if (rule.interval !== undefined) {
    if (!Number.isInteger(rule.interval) || rule.interval < 1) return null;
    form.interval = rule.interval;
  }

  const byDay = rule.byDay;
  if (byDay !== undefined && byDay !== null && byDay.length > 0) {
    if (frequency === "weekly") {
      const days: DayCode[] = [];
      for (const spec of byDay) {
        const day = typeof spec?.day === "string" ? (spec.day.toLowerCase() as DayCode) : null;
        // `nthOfPeriod` is read only by the MONTHLY branch; a weekly rule
        // carrying it is refused by the server, and the form must not claim to
        // round-trip one (`calendar-core:348-353`).
        if (!day || !DAY_CODES.includes(day) || spec.nthOfPeriod != null) return null;
        days.push(day);
      }
      form.weekdays = days;
    } else if (frequency === "monthly") {
      if (byDay.length !== 1) return null;
      const spec = byDay[0]!;
      const day = typeof spec.day === "string" ? (spec.day.toLowerCase() as DayCode) : null;
      if (!day || !DAY_CODES.includes(day)) return null;
      // Only the shape this form generates: the nth weekday OF THE START DAY.
      if (spec.nthOfPeriod !== nthWeekdayOfMonth(start)) return null;
      if (day !== DAY_CODE_FOR_WEEKDAY[weekday(start)]) return null;
      form.monthlyMode = "nthWeekday";
    } else {
      return null;
    }
  }

  if (rule.count !== undefined) {
    if (!Number.isInteger(rule.count) || rule.count < 1) return null;
    if (rule.until !== undefined) return null; // both bounds: not a form state
    form.ends = "count";
    form.count = rule.count;
  } else if (rule.until !== undefined) {
    const until = typeof rule.until === "string" ? parseCivilDateTime(rule.until) : null;
    if (!until) return null;
    form.ends = "until";
    form.until = dayKey(until);
  }
  return form;
}

/**
 * A sentence for a rule the form may or may not be able to edit — so an
 * unexpressible rule is still SHOWN rather than silently absent.
 */
export function describeRules(rules: RecurrenceRule[] | undefined): string {
  if (!rules || rules.length === 0) return "Does not repeat";
  if (rules.length > 1) return `${rules.length} recurrence rules`;
  const rule = rules[0]!;
  const freq = typeof rule.frequency === "string" ? rule.frequency.toLowerCase() : "";
  const every = rule.interval && rule.interval > 1 ? `Every ${rule.interval} ` : "Every ";
  const unit =
    { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[freq] ?? freq ?? "period";
  const parts = [`${every}${unit}${rule.interval && rule.interval > 1 ? "s" : ""}`];

  const byDay = rule.byDay;
  if (byDay && byDay.length > 0) {
    const names = byDay.map((b) => {
      const label = DAY_LABELS[(b.day ?? "").toLowerCase() as DayCode] ?? b.day ?? "?";
      return b.nthOfPeriod ? `${ordinal(b.nthOfPeriod)} ${label}` : label;
    });
    parts.push(`on ${names.join(", ")}`);
  }
  if (rule.byMonthDay && rule.byMonthDay.length > 0) {
    parts.push(`on day ${rule.byMonthDay.join(", ")}`);
  }
  if (rule.byMonth && rule.byMonth.length > 0) parts.push(`in month ${rule.byMonth.join(", ")}`);
  if (rule.count !== undefined) parts.push(`, ${rule.count} times`);
  else if (typeof rule.until === "string") {
    const until = parseCivilDateTime(rule.until);
    parts.push(`, until ${until ? dayKey(until) : rule.until}`);
  }
  return parts.join(" ").replace(/ ,/g, ",");
}

function ordinal(n: number): string {
  if (n < 0) return n === -1 ? "last" : `${-n}th-from-last`;
  return ["", "1st", "2nd", "3rd", "4th", "5th"][n] ?? `${n}th`;
}

// ── event → draft ─────────────────────────────────────────────────────────

/** A blank draft for a day the user clicked. */
export function newDraft(day: CivilDate, calendarId: string, timeZone: string): EventDraft {
  return {
    calendarId,
    title: "",
    description: "",
    location: "",
    allDay: false,
    startDate: dayKey(day),
    startTime: "09:00",
    endDate: dayKey(day),
    endTime: "10:00",
    timeZone,
    repeat: emptyRepeat(),
  };
}

export function draftFromEvent(
  event: CalendarEvent,
  fallbackCalendarId: string,
): EventDraft | null {
  const start = typeof event.start === "string" ? parseCivilDateTime(event.start) : null;
  if (!start) return null;
  const allDay = event.showWithoutTime === true;
  const durationMs = parseDurationMs(event.duration) || (allDay ? 86_400_000 : 0);

  const calendarId =
    Object.entries(event.calendarIds ?? {}).find(([, v]) => v === true)?.[0] ?? fallbackCalendarId;
  const location =
    Object.values(event.locations ?? {}).find((l) => typeof l?.name === "string")?.name ?? "";

  let endDate: string;
  let endTime: string;
  if (allDay) {
    // The LAST covered day, so the form reads "8th to 10th" for a 3-day span.
    endDate = dayKey(addDays(start, Math.max(0, Math.round(durationMs / 86_400_000) - 1)));
    endTime = "09:00";
  } else {
    const startMinutes = start.hour * 60 + start.minute;
    const endMinutes = startMinutes + Math.round(durationMs / 60_000);
    endDate = dayKey(addDays(start, Math.floor(endMinutes / 1440)));
    endTime = formatClock(endMinutes);
  }

  const repeat = repeatFromRules(event.recurrenceRules, start);
  return {
    id: event.id,
    calendarId,
    title: typeof event.title === "string" ? event.title : "",
    description: typeof event.description === "string" ? event.description : "",
    location,
    allDay,
    startDate: dayKey(start),
    startTime: formatClock(start.hour * 60 + start.minute),
    endDate,
    endTime,
    // An all-day event's stored zone is an artefact (see ALL_DAY_ZONE); do not
    // surface it as if the user had chosen it.
    timeZone: allDay
      ? ALL_DAY_ZONE
      : typeof event.timeZone === "string"
        ? event.timeZone
        : "Etc/UTC",
    repeat: repeat ?? emptyRepeat(),
    ...(repeat === null ? { frozenRules: event.recurrenceRules } : {}),
  };
}

// ── draft → event ─────────────────────────────────────────────────────────

export function validateDraft(draft: EventDraft): string[] {
  const problems: string[] = [];
  const start = parseDayKey(draft.startDate);
  const end = parseDayKey(draft.endDate);
  if (!start) problems.push("Start date is not a real date.");
  if (!end) problems.push("End date is not a real date.");

  if (draft.allDay) {
    if (start && end && compareDays(end, start) < 0)
      problems.push("The last day is before the first.");
  } else {
    const startMin = parseClock(draft.startTime);
    const endMin = parseClock(draft.endTime);
    if (startMin === null) problems.push("Start time is not a valid time.");
    if (endMin === null) problems.push("End time is not a valid time.");
    if (start && end && startMin !== null && endMin !== null) {
      if (daysBetween(start, end) * 1440 + endMin < startMin)
        problems.push("The end is before the start.");
    }
  }

  const { repeat } = draft;
  if (repeat.frequency !== "") {
    // Mirrors the server's own checks so the refusal happens in the form, where
    // there is a field to point at (`calendar-core:305-312`).
    if (!Number.isInteger(repeat.interval) || repeat.interval < 1) {
      problems.push("Repeat interval must be a whole number of 1 or more.");
    }
    if (repeat.ends === "count" && (!Number.isInteger(repeat.count) || repeat.count < 1)) {
      problems.push("Repeat count must be a whole number of 1 or more.");
    }
    if (repeat.ends === "until" && !parseDayKey(repeat.until)) {
      problems.push("Repeat end date is not a real date.");
    }
  }
  if (!draft.calendarId) problems.push("Pick a calendar.");
  return problems;
}

/** The JSCalendar body shared by create and patch. */
function eventBody(draft: EventDraft): Record<string, unknown> {
  const start = parseDayKey(draft.startDate)!;
  const end = parseDayKey(draft.endDate)!;

  let startLocal: string;
  let durationMs: number;
  if (draft.allDay) {
    startLocal = formatCivilDateTime({ ...start, hour: 0, minute: 0, second: 0 });
    durationMs = (Math.max(0, daysBetween(start, end)) + 1) * 86_400_000;
  } else {
    const startMin = parseClock(draft.startTime)!;
    const endMin = parseClock(draft.endTime)!;
    startLocal = formatCivilDateTime({
      ...start,
      hour: Math.floor(startMin / 60),
      minute: startMin % 60,
      second: 0,
    });
    durationMs = Math.max(0, (daysBetween(start, end) * 1440 + endMin - startMin) * 60_000);
  }

  const body: Record<string, unknown> = {
    title: draft.title,
    start: startLocal,
    timeZone: draft.allDay ? ALL_DAY_ZONE : draft.timeZone,
    showWithoutTime: draft.allDay,
    description: draft.description || null,
  };

  // A single all-day day carries NO duration, exactly as the CalDAV importer
  // leaves it (`ical.ts:494` skips `P1D` for an all-day event) — so the two
  // creation paths produce the same blob rather than two spellings of one day.
  if (!(draft.allDay && durationMs === 86_400_000)) body.duration = formatDuration(durationMs);
  else body.duration = null;

  body.locations = draft.location ? { l1: { "@type": "Location", name: draft.location } } : null;
  return body;
}

export function draftToCreate(draft: EventDraft): Record<string, unknown> {
  const start = parseDayKey(draft.startDate)!;
  const body = eventBody(draft);
  // `null` means "absent" in a create spec; strip rather than send it.
  for (const [k, v] of Object.entries(body)) if (v === null) delete body[k];
  const rules = rulesFromRepeat(draft.repeat, start);
  return {
    ...body,
    calendarIds: { [draft.calendarId]: true },
    ...(rules.length > 0 ? { recurrenceRules: rules } : {}),
  };
}

/**
 * An RFC 8620 §5.3 PatchObject with only what actually changed.
 *
 * Two properties worth stating, both tested:
 *   • `recurrenceRules` appears ONLY when the form could express the stored
 *     rules and the user changed them. A frozen rule is never written, so a
 *     CalDAV-authored "last Friday of the month" survives a rename here.
 *   • `uid`, `created` and `id` are never sent. The server treats `id` and
 *     `uid` as immutable and would refuse the whole update
 *     (`calendars.ts:295-300`).
 */
export function draftToPatch(draft: EventDraft, original: CalendarEvent): Record<string, unknown> {
  const start = parseDayKey(draft.startDate)!;
  const body = eventBody(draft);
  const patch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body)) {
    if (!deepEqual(value, original[key] ?? null)) patch[key] = value;
  }

  const originalCalendarId =
    Object.entries(original.calendarIds ?? {}).find(([, v]) => v === true)?.[0] ?? "";
  if (originalCalendarId !== draft.calendarId) {
    // Whole-object replace: `calendarIds/<old>: null` plus `/<new>: true` would
    // leave the event in zero calendars if the server applied them in that
    // order, and `singleCalendarId` requires exactly one (`calendars.ts:638`).
    patch.calendarIds = { [draft.calendarId]: true };
  }

  if (draft.frozenRules === undefined) {
    const next = rulesFromRepeat(draft.repeat, start);
    const prev = original.recurrenceRules ?? [];
    if (!deepEqual(next, prev)) patch.recurrenceRules = next.length > 0 ? next : null;
  }
  return patch;
}

/** Structural equality over JSON-shaped values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}
