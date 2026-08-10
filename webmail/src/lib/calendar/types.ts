// The wire shapes `/calendar` reads, transcribed from the server rather than
// imported from it.
//
// ⚠️ Transcribed ON PURPOSE, and the reason is worth knowing before "fixing"
// it. The authoritative definitions live in `@bullmoose/mailstore` (CalendarRow,
// JSCalendarEventBlob) and `@bullmoose/calendar-core` (Occurrence,
// RecurrenceRule), and both are Worker/package source. Two things go wrong if
// this module imports them:
//
//   1. `@bullmoose/calendar-core` would come into the BROWSER BUNDLE, and with
//      it `expandOccurrences` — a second RRULE expander sitting one import away
//      from a UI that must never call it. The whole point of
//      `CalendarEvent/getOccurrences` is that expansion happens once, on the
//      server, against the implementation with ~100 tests and python-dateutil
//      as the oracle (`packages/calendar-core/src/index.test.ts`). A browser
//      copy would be a second thing to be subtly wrong, and it would disagree
//      with the CalDAV face (`services/anglebrackets/src/dav.ts:12`) which
//      serves the server's expansion to Apple/Thunderbird.
//   2. Workspace packages resolve through `node_modules/@bullmoose/*`, whose
//      symlinks point at the ROOT checkout — so in a git worktree an
//      `astro build` would bundle a DIFFERENT branch's source than the one
//      being typechecked. `vitest.config.ts:8-16` documents exactly this trap
//      and pins around it for tests; `astro build` has no such pin.
//
// Same trade-off `webmail/src/lib/mail/search.ts` and `types.ts` already make.
// If the server's shape changes, change it here too — the failure mode is a
// field the UI ignores, not a wrong date.

/** `Calendar/get` list entry (`services/jmap/src/methods/calendars.ts:483`). */
export interface Calendar {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  sortOrder: number;
  isDefault: boolean;
  isSubscribed: boolean;
  myRights: {
    mayReadItems: boolean;
    mayWriteAll: boolean;
    mayAdmin: boolean;
    mayDelete: boolean;
  };
}

/**
 * One entry of a JSCalendar `recurrenceRules` array (RFC 8984).
 *
 * ⚠️ Declaring a field here is NOT a claim the server will accept it. The
 * expander supports a different set of parts PER FREQUENCY
 * (`calendar-core/src/index.ts:215` `SUPPORTED_PARTS`) and the write boundary
 * REFUSES anything outside it rather than expanding it wrong — see
 * `draft.ts`, which mirrors that table for the editor.
 */
export interface RecurrenceRule {
  frequency?: string;
  interval?: number;
  count?: number;
  until?: string;
  byDay?: Array<{ day?: string; nthOfPeriod?: number }>;
  byMonthDay?: number[];
  byMonth?: string[];
  bySetPosition?: number[];
  firstDayOfWeek?: string;
  [key: string]: unknown;
}

/**
 * A JSCalendar Event as `CalendarEvent/get` returns it.
 *
 * The three fields that decide how anything renders:
 *   • `start` — a LOCAL wall clock ("2026-07-08T09:00:00"), never an instant.
 *   • `timeZone` — the IANA zone that wall clock is read in. May be absent;
 *     the server then treats it as `Etc/UTC` (`calendar-core:420`).
 *   • `showWithoutTime` — all-day. Changes what `start` MEANS: a date, not a
 *     moment, and one that must not be converted into anybody's zone.
 */
export interface CalendarEvent {
  id: string;
  uid?: string;
  calendarIds?: Record<string, boolean>;
  title?: string;
  description?: string | null;
  locations?: Record<string, { "@type"?: string; name?: string }>;
  start?: string;
  duration?: string;
  timeZone?: string | null;
  showWithoutTime?: boolean;
  recurrenceRules?: RecurrenceRule[];
  recurrenceOverrides?: Record<string, Record<string, unknown>>;
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

/**
 * One row of `CalendarEvent/getOccurrences` (`calendars.ts:434-445`).
 *
 * ⚠️ `start` and `utcStart` are NOT two spellings of the same thing, and the
 * difference is the whole timezone story:
 *   • `start`    — the occurrence's wall clock IN THE EVENT'S OWN ZONE.
 *   • `utcStart` — the instant that wall clock names, in UTC.
 * For a timed event a viewer wants the instant rendered in THEIR zone, so
 * `utcStart` is right. For an all-day event `utcStart` is an artefact of
 * midnight having been resolved through *some* zone, and converting it into
 * the viewer's zone is the classic off-by-one-day bug. `place.ts` is where
 * that fork lives; nothing else may make it.
 *
 * Note the response carries NO `timeZone` — the occurrence cannot tell you
 * which zone `start` is in. `CalendarEvent/get` can, which is why the page
 * fetches both.
 */
export interface Occurrence {
  eventId: string;
  calendarId: string;
  uid: string;
  /** LocalDateTime of the unmodified occurrence start — the override key. */
  recurrenceId: string;
  /** Wall clock in the EVENT's zone. */
  start: string;
  utcStart: string;
  utcEnd: string;
  title: string | null;
  showWithoutTime: boolean;
}
