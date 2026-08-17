// Deterministic due-date extraction at the boundary (s11 T1).
//
// The scheduler's `due_at` must exist BEFORE any claim does — sit-free vs
// escalate is a pre-claim decision (jobs-and-facets.md §6) — so extraction
// happens here at enqueue, not in the claiming agent. NO model calls in this
// pass: model extraction is a later, per-binding opt-in.
//
// The governing caution (s11 readme #3): **a wrong `due_at` is worse than
// none.** A mis-read "due in an hour" burns paid budget on non-urgent work,
// and a mis-read past-due date summons the escalation backstop immediately.
// So every rule here is conservative:
//
//   - only DEADLINE-SHAPED text matches: a cue word ("by", "due", "before",
//     "deadline", "until", "no later than") must introduce the date. A bare
//     date in a body ("we met on 2026-08-01") is a reference, not a deadline.
//   - ambiguous or relative-without-anchor → NULL. "tomorrow", "next week",
//     "in two days", "ASAP", "by next Friday" all return NULL — NULL means
//     never-urgent, which is the safe failure.
//   - a deadline that resolves to the PAST → NULL. It is either a mis-parse
//     or moot; stamping it would make the work instantly overdue.
//   - the extracted value is a PROPOSAL, not a hidden field: it surfaces on
//     the approval row beside the two decision clocks and is correctable.
//
// Timezone: there is no account-level timezone anywhere in the schema
// (calendar events carry a per-EVENT timeZone; accounts carry none), so all
// date-only deadlines resolve in UTC and "end of day" is 17:00 UTC. For a US
// account that reads as a morning-to-noon deadline — EARLIER than the sender
// meant, which errs toward escalating sooner, never toward missing the real
// deadline. When an account timezone exists, thread it through `EOD_UTC_HOUR`
// and the UTC arithmetic below.

/** "End of business", as an hour-of-day. UTC — see the timezone note above. */
export const EOD_UTC_HOUR = 17;

/**
 * Deadlines live at the top of a message; the quoted history below restates
 * old ones ("by Friday" from three weeks ago). Scanning only the head keeps
 * stale deadlines out and bounds the regex work per delivery.
 */
export const SCAN_LIMIT = 4096;

export interface DueExtractionInput {
  subject: string;
  /** Plain body text (already HTML-stripped). Only the head is scanned. */
  text: string;
  /** The delivery instant (epoch ms) every relative form resolves against. */
  now: number;
}

/**
 * The deadline cue. Every pattern requires one — this is what makes the
 * extractor conservative rather than eager. "no later than" is matched as the
 * full phrase (a bare "than" would turn "I like Friday better than Monday"
 * into a Monday deadline — exactly the false positive this module must not
 * produce). The optional "on"/"is" absorbs "due on Friday" / "deadline is
 * Friday" without widening what counts as a cue.
 */
const CUE = /\b(?:by|due|before|deadline|until|no\s+later\s+than)\b[\s:]+(?:on\s+|is\s+)?/i;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const WEEKDAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const MONTH_RE = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)";
const WEEKDAY_RE = "(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)";

/**
 * Extract a business deadline, or NULL (= never-urgent).
 *
 * Supported forms, most explicit first (the first hit wins — the subject is
 * scanned before the body, so the most prominent statement of the deadline is
 * the one that lands):
 *
 *   1. cue + ISO date        "by 2026-08-20", "due 2026-08-20 16:30"
 *   2. cue + Month day       "by August 20", "due Aug 20, 2026", "by Sep 3rd"
 *   3. cue + EOD [weekday]   "by EOD", "by end of day Thursday", "before COB"
 *   4. cue + weekday         "by Friday", "due Thu"
 *
 * A date without a stated time resolves to EOD (17:00 UTC) on that date.
 */
export function extractDueAt(input: DueExtractionInput): number | null {
  const haystack = `${input.subject}\n${input.text.slice(0, SCAN_LIMIT)}`;
  const { now } = input;

  return (
    isoDate(haystack, now) ??
    monthDay(haystack, now) ??
    endOfDay(haystack, now) ??
    weekday(haystack, now)
  );
}

/** cue + YYYY-MM-DD, optionally with HH:MM (space or T separator). */
function isoDate(haystack: string, now: number): number | null {
  const re = new RegExp(
    CUE.source + String.raw`(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?\b`,
    "i",
  );
  const m = re.exec(haystack);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m.map(Number) as number[];
  const hasTime = m[4] !== undefined;
  if (hasTime && ((hh as number) > 23 || (mm as number) > 59)) return null;
  const due = Date.UTC(
    y as number,
    (mo as number) - 1,
    d as number,
    hasTime ? (hh as number) : EOD_UTC_HOUR,
    hasTime ? (mm as number) : 0,
  );
  // Round-trip check rejects rolled-over dates (2026-02-30 → March 2).
  const check = new Date(due);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== (mo as number) - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return due > now ? due : null; // a past deadline is a mis-parse or moot
}

/** cue + Month day [, year] — "by August 20", "due Aug 20 2026", "by Sep 3rd". */
function monthDay(haystack: string, now: number): number | null {
  const re = new RegExp(
    CUE.source + MONTH_RE + String.raw`\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`,
    "i",
  );
  const m = re.exec(haystack);
  if (!m) return null;
  const month = MONTHS[(m[1] as string).slice(0, 3).toLowerCase()];
  const day = Number(m[2]);
  if (month === undefined || day < 1 || day > 31) return null;

  if (m[3] !== undefined) {
    const due = Date.UTC(Number(m[3]), month, day, EOD_UTC_HOUR, 0);
    const check = new Date(due);
    if (check.getUTCMonth() !== month || check.getUTCDate() !== day) return null;
    return due > now ? due : null;
  }
  // No year: only THIS year's occurrence is unambiguous. If it already
  // passed, "by March 3" in August is far more likely a reference to a past
  // event than an eleven-month deadline — NULL, never a guess at next year.
  const due = Date.UTC(new Date(now).getUTCFullYear(), month, day, EOD_UTC_HOUR, 0);
  const check = new Date(due);
  if (check.getUTCMonth() !== month || check.getUTCDate() !== day) return null;
  return due > now ? due : null;
}

/** cue + EOD / end of day / COB / close of business, optionally + weekday. */
function endOfDay(haystack: string, now: number): number | null {
  const re = new RegExp(
    CUE.source +
      String.raw`(?:eod|cob|end of (?:the )?day|close of business)\b(?:\s+` +
      WEEKDAY_RE +
      String.raw`\b)?`,
    "i",
  );
  const m = re.exec(haystack);
  if (!m) return null;
  if (m[1] !== undefined) return weekdayEod(m[1], now);
  return todayEod(now); // bare "by EOD": today — or NULL if the day is over
}

/** cue + weekday — "by Friday". "by NEXT Friday" is ambiguous → NULL. */
function weekday(haystack: string, now: number): number | null {
  const re = new RegExp(CUE.source + String.raw`(next\s+)?` + WEEKDAY_RE + String.raw`\b`, "i");
  const m = re.exec(haystack);
  if (!m) return null;
  if (m[1] !== undefined) return null; // "next Friday": this week's or next's? NULL.
  return weekdayEod(m[2] as string, now);
}

/** Today at 17:00 UTC — or NULL when that instant has already passed. */
function todayEod(now: number): number | null {
  const d = new Date(now);
  const due = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), EOD_UTC_HOUR, 0);
  return due > now ? due : null;
}

/**
 * The next occurrence of `name`'s weekday, at 17:00 UTC.
 *
 * Same-day is honored while the day still has business hours left ("by
 * Friday" sent Friday morning means today); after 17:00 the reference is
 * ambiguous (today is over, but "a week from now" is a guess) → NULL.
 */
function weekdayEod(name: string, now: number): number | null {
  const target = WEEKDAYS[name.slice(0, 3).toLowerCase()];
  if (target === undefined) return null;
  const d = new Date(now);
  const delta = (target - d.getUTCDay() + 7) % 7;
  if (delta === 0) return todayEod(now);
  const due = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + delta, EOD_UTC_HOUR, 0);
  return due;
}
