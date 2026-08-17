// What this screen can and cannot actually reach — stated out loud.
//
// The pattern is `webmail/src/lib/mail/search.ts`, and the lesson behind it is
// `.feedback` `common/004`: mail shipped for months with a search box whose
// scope note was quietly false. A UI that implies it searched everything
// teaches people their data is not there. The calendar realm has THREE limits
// worth a sentence, and unlike mail's they are all still open:
//
//  1. **Event search is a full-scan `LIKE`.** `queryCalendarEvents`
//     (`packages/mailstore/src/index.ts:2273-2284`) matches `title` and
//     `$.description` with `LIKE '%…%'` — the exact pattern `common/004`
//     removed from mail, and it is named as still-outstanding in the s07 plan
//     (`devPlan.md:438-441`, `readme.md:54`). So: no index, no word stemming,
//     no relevance, and cost linear in the account's event count. The box must
//     not imply otherwise, and there is no infinite scroll behind it.
//
//  2. **The window is answered from at most 256 candidate events.**
//     `CalendarEvent/getOccurrences` selects candidates with `limit: 256`
//     (`services/jmap/src/methods/calendars.ts:426`), and the store clamps any
//     limit to 256 anyway (`mailstore/src/index.ts:2297`). The default sort is
//     `start_at ASC`, so past #256 what falls off is the LATEST-starting events
//     in the window — and a long-running unbounded recurrence, whose
//     `start_at` is the day the series began, always keeps its place.
//
//  3. **Occurrences are capped per request.** Default 200, hard ceiling
//     `MAX_OCCURRENCES` = 1000 (`calendars.ts:411-414`,
//     `calendar-core:62`). The response's `total` is the count BEFORE the
//     slice (`calendars.ts:451`), which is what makes the truncation
//     observable rather than a silently short grid.
//
// A month grid that is missing events is worse than one that says it is
// missing events, because nothing else on screen distinguishes the two.

/** `CalendarEvent/getOccurrences`'s candidate `limit` (`calendars.ts:426`). */
export const CANDIDATE_EVENT_LIMIT = 256;
/** Its default `maxOccurrences` (`calendars.ts:412`). */
export const DEFAULT_OCCURRENCE_CAP = 200;
/** `MAX_OCCURRENCES` — the server clamps to this (`calendar-core:62`). */
export const MAX_OCCURRENCE_CAP = 1000;

/** Rendered next to the search box. Mirrors `SEARCH_SCOPE_NOTE` in mail. */
export const EVENT_SEARCH_SCOPE_NOTE =
  "Searches event titles and descriptions only, by substring, with no index — " +
  "a full scan of this account's events. Not searched: attendees, locations, or mail.";

export interface Truncation {
  /** Occurrences dropped because the per-request cap was reached. */
  occurrences: boolean;
  /** Events dropped because more than 256 overlap this window. */
  candidates: boolean;
}

/**
 * Did this window come back complete?
 *
 * `total` is `getOccurrences`'s pre-slice count and `matchingEvents` is
 * `CalendarEvent/query`'s `total` for the same window — the second call exists
 * only so limit 2 above is OBSERVABLE. Without it a 300-event month would
 * render 256 events and look finished.
 */
export function truncationOf(total: number, cap: number, matchingEvents: number | undefined): Truncation {
  return {
    occurrences: total > cap,
    candidates: matchingEvents !== undefined && matchingEvents > CANDIDATE_EVENT_LIMIT,
  };
}

export function isTruncated(t: Truncation): boolean {
  return t.occurrences || t.candidates;
}

/** The sentence to render when something was dropped. Empty when nothing was. */
export function describeTruncation(t: Truncation, shown: number): string {
  const notes: string[] = [];
  if (t.candidates) {
    notes.push(
      `more than ${CANDIDATE_EVENT_LIMIT} events overlap this period, and the server ` +
        `answers from the ${CANDIDATE_EVENT_LIMIT} earliest-starting ones`,
    );
  }
  if (t.occurrences) notes.push(`the per-request occurrence cap was reached`);
  if (notes.length === 0) return "";
  return `Showing ${shown} occurrences — this period is INCOMPLETE because ${notes.join(", and ")}. Narrow to a week or a day to see the rest.`;
}

/**
 * The other honest gap, and a different kind: the fetch window reaches a
 * bounded distance back before the grid (`grid.ts` `WINDOW_PAD_BEFORE_DAYS`),
 * so an event that started longer ago than that and is STILL running is not
 * returned. `getOccurrences` filters on `startMs < before && endMs > after`
 * (`calendar-core:489-493`), so widening the pad is the only fix and it costs
 * a wider scan on every page.
 */
export function spillInNote(maxSpillInDays: number): string {
  return `Events longer than ${maxSpillInDays} days that began before this period may not appear.`;
}
