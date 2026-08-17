// An in-memory calendar realm for the `FakeJmapClient` — the same job
// `lib/jmap/demo.ts` does for mail, and the same discipline: mirror the
// SERVER's semantics, warts included, because a fake that is kinder than the
// real thing hides exactly the bugs it should catch.
//
// It lives here, next to the surface, rather than inside `demo.ts`, following
// `lib/console/demoConsole.ts` — one realm per module, so `/calendar`,
// `/contacts` and `/settings` can each grow a fake without three tasks editing
// one file. It attaches with `FakeJmapClient.setHandler`
// (`../jmap/FakeJmapClient.ts:109`), which is the extension point that exists
// for exactly this.
//
// ══════════════════════════════════════════════════════════════════════════
//  ⚠️ THIS FAKE DOES NOT EXPAND RECURRENCE RULES. IT MUST NOT LEARN HOW.
// ══════════════════════════════════════════════════════════════════════════
//
// `CalendarEvent/getOccurrences` here returns CANNED occurrence starts written
// into the fixture — `cannedStarts` is a literal list, and no code path in this
// module reads `recurrenceRules` to produce a date. The real expansion is
// `@bullmoose/calendar-core`, which has ~100 tests against python-dateutil as
// an independent oracle precisely because RRULE expansion is where calendar
// code goes wrong: `.feedback` `common/003` (now closed) found
// `FREQ=YEARLY;BYMONTH=11;BYDAY=4TH` — US Thanksgiving, a rule Apple Calendar
// emits — expanding to "the start day of every November", wrong by up to four
// days, silently. A second expander in the browser would be a second thing to
// be wrong, and it would disagree with CalDAV
// (`services/anglebrackets/src/dav.ts`) over the same account.
//
// The visible consequence, and it is the right one: create a repeating event
// in demo mode and only its first occurrence appears. The screen says so
// (`CalendarView.tsx`). A fake that guessed the rest would be teaching the UI
// to trust a expansion that no oracle ever checked.
//
// The one piece of real timezone arithmetic here — `zonedToUtc` — is SERVER
// work, not UI work: `getOccurrences` returns instants, so a fake server has to
// produce them. It mirrors `calendar-core`'s three-pass offset solve
// (`packages/calendar-core/src/index.ts:153-164`). Nothing in `lib/calendar/*`
// outside this module converts a wall clock into an instant, and this module is
// loaded only under `?demo=1` (a dynamic `import()` in the island), so it never
// reaches a live bundle.

import type { FakeJmapClient, MethodHandler } from "../jmap/FakeJmapClient";
import {
  addDays,
  dayKey,
  formatCivilDateTime,
  parseCivilDateTime,
  weekday,
  zonedFields,
  type CivilDate,
  type CivilDateTime,
} from "./civil";
import { parseDurationMs } from "./draft";
import type { Calendar, CalendarEvent, Occurrence } from "./types";

const ACCOUNT = "acct-fake";

const OWNER_RIGHTS = {
  mayReadItems: true,
  mayWriteAll: true,
  mayAdmin: true,
  mayDelete: true,
} as const;

interface DemoEventRow {
  id: string;
  calendarId: string;
  uid: string;
  event: CalendarEvent;
  /**
   * Fixture-authored occurrence starts (LocalDateTime), INCLUDING the master.
   * Absent ⇒ the event occurs once, at `event.start`. Never derived from
   * `recurrenceRules` — see the header.
   */
  cannedStarts?: string[];
}

export interface DemoCalendarBackend {
  calendars: Calendar[];
  rows: DemoEventRow[];
  handlers: Record<string, MethodHandler>;
  state(): string;
}

// ── the one bit of real zone arithmetic, and it is the server's ───────────

const asUtcMs = (dt: CivilDateTime): number =>
  Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second);

/**
 * Local wall clock in an IANA zone → UTC epoch ms.
 *
 * Iterative because the offset depends on the answer: you cannot know which
 * side of a DST transition a wall clock falls on until you have a candidate
 * instant. Three passes converge everywhere real. Times inside a spring-forward
 * gap resolve to the post-transition reading, matching `calendar-core:153-164`
 * (and Apple).
 */
function zonedToUtc(dt: CivilDateTime, timeZone: string): number {
  if (timeZone === "Etc/UTC" || timeZone === "UTC") return asUtcMs(dt);
  const target = asUtcMs(dt);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const offset = asUtcMs(zonedFields(guess, timeZone)) - guess;
    const next = target - offset;
    if (next === guess) return guess;
    guess = next;
  }
  return guess;
}

// ── fixtures ──────────────────────────────────────────────────────────────

/** Today, as a civil date in UTC. Only used to anchor the fixture month. */
function anchorMonth(nowMs: number): CivilDate {
  const d = new Date(nowMs);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: 1 };
}

/**
 * A literal list of dates, stepped by whole days.
 *
 * ⚠️ Not a rule interpreter and must not become one: it takes a start, a step
 * and a count, and never sees a `RecurrenceRule`. It exists so the fixture can
 * say "twelve Mondays" without twelve lines of ISO strings.
 */
function steppedStarts(first: CivilDate, clock: string, stepDays: number, count: number): string[] {
  const t = parseCivilDateTime(`2000-01-01T${clock}`);
  const hour = t?.hour ?? 0;
  const minute = t?.minute ?? 0;
  return Array.from({ length: count }, (_, i) =>
    formatCivilDateTime({ ...addDays(first, i * stepDays), hour, minute, second: 0 }),
  );
}

export function demoCalendars(): Calendar[] {
  return [
    {
      id: "cal-personal",
      name: "Personal",
      description: null,
      color: "#3b6ea5",
      sortOrder: 0,
      isDefault: true,
      isSubscribed: true,
      myRights: { ...OWNER_RIGHTS },
    },
    {
      id: "cal-elk",
      name: "Project Elk",
      description: "Shared with the team",
      color: "#a8541f",
      sortOrder: 10,
      isDefault: false,
      isSubscribed: true,
      myRights: { ...OWNER_RIGHTS },
    },
  ];
}

/**
 * A structurally varied month: a timed event in the viewer's own zone, one in
 * ANOTHER zone (so the conversion is visible rather than a no-op), an all-day
 * event, a multi-day all-day event, an overlap pair, and one canned series.
 */
export function demoEventRows(nowMs: number = Date.now()): DemoEventRow[] {
  const month = anchorMonth(nowMs);
  const on = (day: number): CivilDate => ({ ...month, day });
  // The first Monday on or after the 1st — the canned series' anchor.
  // `weekday` is 0=Sunday, so Monday is 1.
  const firstMonday = addDays(on(1), (1 - weekday(on(1)) + 7) % 7);

  const rows: DemoEventRow[] = [
    {
      id: "ev-standup",
      calendarId: "cal-elk",
      uid: "urn:uuid:demo-standup",
      event: {
        id: "ev-standup",
        "@type": "Event",
        uid: "urn:uuid:demo-standup",
        title: "Elk standup",
        description: "Fifteen minutes, standing up.",
        start: formatCivilDateTime({ ...firstMonday, hour: 9, minute: 0, second: 0 }),
        duration: "PT15M",
        timeZone: "Etc/UTC",
        recurrenceRules: [{ frequency: "weekly", interval: 1, byDay: [{ day: "mo" }] }],
      },
      // CANNED. The rule above is stored and shown; it is not read to make
      // these. Twelve Mondays either side of the fixture month.
      cannedStarts: steppedStarts(addDays(firstMonday, -28), "09:00", 7, 16),
    },
    {
      id: "ev-review",
      calendarId: "cal-elk",
      uid: "urn:uuid:demo-review",
      event: {
        id: "ev-review",
        "@type": "Event",
        uid: "urn:uuid:demo-review",
        title: "Design review (New York)",
        description: "Deliberately in another timezone — the grid converts it.",
        start: formatCivilDateTime({ ...on(12), hour: 9, minute: 30, second: 0 }),
        duration: "PT1H",
        timeZone: "America/New_York",
        locations: { l1: { "@type": "Location", name: "Room 2" } },
      },
    },
    {
      id: "ev-overlap-a",
      calendarId: "cal-personal",
      uid: "urn:uuid:demo-overlap-a",
      event: {
        id: "ev-overlap-a",
        "@type": "Event",
        uid: "urn:uuid:demo-overlap-a",
        title: "Dentist",
        start: formatCivilDateTime({ ...on(12), hour: 14, minute: 0, second: 0 }),
        duration: "PT1H",
        timeZone: "Etc/UTC",
      },
    },
    {
      id: "ev-overlap-b",
      calendarId: "cal-elk",
      uid: "urn:uuid:demo-overlap-b",
      event: {
        id: "ev-overlap-b",
        "@type": "Event",
        uid: "urn:uuid:demo-overlap-b",
        title: "Budget call",
        start: formatCivilDateTime({ ...on(12), hour: 14, minute: 30, second: 0 }),
        duration: "PT1H30M",
        timeZone: "Etc/UTC",
      },
    },
    {
      id: "ev-holiday",
      calendarId: "cal-personal",
      uid: "urn:uuid:demo-holiday",
      event: {
        id: "ev-holiday",
        "@type": "Event",
        uid: "urn:uuid:demo-holiday",
        title: "Public holiday",
        // All-day, stored exactly the way the CalDAV importer stores a
        // VALUE=DATE DTSTART (`calendar-core/src/ical.ts:473-475`): midnight,
        // Etc/UTC, showWithoutTime, no duration. If the grid ever renders this
        // on the 17th for a viewer in Los Angeles, `place.ts` is broken.
        start: formatCivilDateTime({ ...on(18), hour: 0, minute: 0, second: 0 }),
        timeZone: "Etc/UTC",
        showWithoutTime: true,
      },
    },
    {
      id: "ev-offsite",
      calendarId: "cal-elk",
      uid: "urn:uuid:demo-offsite",
      event: {
        id: "ev-offsite",
        "@type": "Event",
        uid: "urn:uuid:demo-offsite",
        title: "Offsite",
        start: formatCivilDateTime({ ...on(21), hour: 0, minute: 0, second: 0 }),
        duration: "P3D",
        timeZone: "Etc/UTC",
        showWithoutTime: true,
      },
    },
    {
      id: "ev-lastfriday",
      calendarId: "cal-personal",
      uid: "urn:uuid:demo-lastfriday",
      event: {
        id: "ev-lastfriday",
        "@type": "Event",
        uid: "urn:uuid:demo-lastfriday",
        title: "Last-Friday retro",
        start: formatCivilDateTime({ ...on(27), hour: 16, minute: 0, second: 0 }),
        duration: "PT1H",
        timeZone: "Etc/UTC",
        // A rule the EDITOR cannot express (`draft.ts` `repeatFromRules`), so
        // the demo exercises the freeze-and-preserve path: rename it and the
        // rule must still be here afterwards.
        recurrenceRules: [{ frequency: "monthly", byDay: [{ day: "fr", nthOfPeriod: -1 }] }],
      },
      cannedStarts: [formatCivilDateTime({ ...on(27), hour: 16, minute: 0, second: 0 })],
    },
  ];
  return rows;
}

// ── the backend ───────────────────────────────────────────────────────────

export function createDemoCalendar(nowMs: number = Date.now()): DemoCalendarBackend {
  const calendars = demoCalendars();
  const rows = demoEventRows(nowMs);
  let counter = 0;
  const state = (): string => `cal-${counter}`;
  const bump = (): string => `cal-${++counter}`;

  const rowsFor = (ids: string[] | null | undefined): DemoEventRow[] =>
    ids ? rows.filter((r) => ids.includes(r.id)) : rows;

  const toWire = (r: DemoEventRow): CalendarEvent => ({
    ...r.event,
    id: r.id,
    calendarIds: { [r.calendarId]: true },
  });

  /** Occurrence starts for a row — canned, or the master start alone. */
  const startsOf = (r: DemoEventRow): string[] =>
    r.cannedStarts && r.cannedStarts.length > 0
      ? r.cannedStarts
      : typeof r.event.start === "string"
        ? [r.event.start]
        : [];

  const occurrencesOf = (r: DemoEventRow, afterMs: number, beforeMs: number): Occurrence[] => {
    const timeZone = typeof r.event.timeZone === "string" ? r.event.timeZone : "Etc/UTC";
    const allDay = r.event.showWithoutTime === true;
    const durationMs = parseDurationMs(r.event.duration) || (allDay ? 86_400_000 : 0);
    const out: Occurrence[] = [];
    for (const local of startsOf(r)) {
      const dt = parseCivilDateTime(local);
      if (!dt) continue;
      const startMs = zonedToUtc(dt, timeZone);
      const endMs = startMs + durationMs;
      // Same window predicate as the real expander (`calendar-core:489-493`):
      // overlap, not containment.
      if (!(startMs < beforeMs && endMs > afterMs)) continue;
      out.push({
        eventId: r.id,
        calendarId: r.calendarId,
        uid: r.uid,
        recurrenceId: local,
        start: local,
        utcStart: new Date(startMs).toISOString(),
        utcEnd: new Date(endMs).toISOString(),
        title: typeof r.event.title === "string" ? r.event.title : null,
        showWithoutTime: allDay,
      });
    }
    return out;
  };

  const handlers: Record<string, MethodHandler> = {
    "Calendar/get": (args) => {
      const ids = args.ids as string[] | null | undefined;
      const list = ids ? calendars.filter((c) => ids.includes(c.id)) : calendars;
      return {
        accountId: ACCOUNT,
        state: state(),
        list,
        notFound: (ids ?? []).filter((id) => !calendars.some((c) => c.id === id)),
      };
    },

    "CalendarEvent/get": (args) => {
      const ids = args.ids as string[] | null | undefined;
      // De-duplicate: a back-reference off an occurrence list repeats an id
      // once per occurrence, and the server answers each id once.
      const unique = ids ? [...new Set(ids)] : null;
      const found = rowsFor(unique);
      return {
        accountId: ACCOUNT,
        state: state(),
        list: found.map(toWire),
        notFound: (unique ?? []).filter((id) => !rows.some((r) => r.id === id)),
      };
    },

    // Mirrors the server exactly: registered, and it always throws
    // (`services/jmap/src/methods/calendars.ts:392-394`). sVOL `026` owns it.
    "CalendarEvent/queryChanges": () => ["error", { type: "cannotCalculateChanges" }],

    "CalendarEvent/query": (args) => {
      const filter = (args.filter ?? {}) as Record<string, string | undefined>;
      let matched = rows.slice();
      if (filter.inCalendar) matched = matched.filter((r) => r.calendarId === filter.inCalendar);
      if (filter.uid) matched = matched.filter((r) => r.uid === filter.uid);
      if (filter.after !== undefined || filter.before !== undefined) {
        const afterMs = filter.after !== undefined ? Date.parse(filter.after) : -Infinity;
        const beforeMs = filter.before !== undefined ? Date.parse(filter.before) : Infinity;
        matched = matched.filter((r) => occurrencesOf(r, afterMs, beforeMs).length > 0);
      }
      // The `text` filter is a substring LIKE over title + description ONLY —
      // the full scan `scope.ts` refuses to dress up as search
      // (`packages/mailstore/src/index.ts:2277-2284`).
      if (filter.text) {
        const needle = filter.text.toLowerCase();
        matched = matched.filter(
          (r) =>
            String(r.event.title ?? "")
              .toLowerCase()
              .includes(needle) ||
            String(r.event.description ?? "")
              .toLowerCase()
              .includes(needle),
        );
      }
      const position = typeof args.position === "number" ? args.position : 0;
      // The store clamps every limit to 256 (`mailstore/src/index.ts:2297`).
      const limit = Math.min(typeof args.limit === "number" ? args.limit : 100, 256);
      matched.sort((a, b) => String(a.event.start).localeCompare(String(b.event.start)));
      return {
        accountId: ACCOUNT,
        queryState: state(),
        canCalculateChanges: false,
        position,
        ids: matched.slice(position, position + limit).map((r) => r.id),
        ...(args.calculateTotal === true ? { total: matched.length } : {}),
      };
    },

    "CalendarEvent/getOccurrences": (args) => {
      const afterMs = Date.parse(String(args.after));
      const beforeMs = Date.parse(String(args.before));
      if (!Number.isFinite(afterMs) || !Number.isFinite(beforeMs) || beforeMs <= afterMs) {
        return [
          "error",
          {
            type: "invalidArguments",
            description: "after and before (UTCDates, after < before) required",
          },
        ];
      }
      const cap = Math.min(
        typeof args.maxOccurrences === "number" ? args.maxOccurrences : 200,
        1000,
      );
      const inCalendar = typeof args.inCalendar === "string" ? args.inCalendar : undefined;
      const ids = Array.isArray(args.ids) ? (args.ids as string[]) : undefined;

      const list: Occurrence[] = [];
      for (const r of rows) {
        if (ids && !ids.includes(r.id)) continue;
        if (!ids && inCalendar && r.calendarId !== inCalendar) continue;
        list.push(...occurrencesOf(r, afterMs, beforeMs));
      }
      list.sort((a, b) => a.utcStart.localeCompare(b.utcStart));
      // `total` is the count BEFORE the slice, which is what makes truncation
      // observable (`calendars.ts:451`).
      return { accountId: ACCOUNT, list: list.slice(0, cap), total: list.length };
    },

    "CalendarEvent/set": (args) => {
      const oldState = state();
      if (typeof args.ifInState === "string" && args.ifInState !== oldState) {
        return ["error", { type: "stateMismatch" }];
      }
      const created: Record<string, unknown> = {};
      const notCreated: Record<string, unknown> = {};
      const updated: Record<string, null> = {};
      const notUpdated: Record<string, unknown> = {};
      const destroyed: string[] = [];
      const notDestroyed: Record<string, unknown> = {};

      for (const [cid, spec] of Object.entries(
        (args.create as Record<string, Record<string, unknown>>) ?? {},
      )) {
        const calendarId =
          Object.entries((spec.calendarIds as Record<string, boolean>) ?? {}).find(
            ([, v]) => v === true,
          )?.[0] ?? calendars.find((c) => c.isDefault)?.id;
        if (!calendarId || !calendars.some((c) => c.id === calendarId)) {
          notCreated[cid] = { type: "invalidProperties", properties: ["calendarIds"] };
          continue;
        }
        if (typeof spec.start !== "string" || !parseCivilDateTime(spec.start)) {
          notCreated[cid] = {
            type: "invalidProperties",
            description: 'start must be a LocalDateTime ("2026-07-08T09:00:00")',
            properties: ["start"],
          };
          continue;
        }
        const id = `ev-demo-${++counter}`;
        const uid = `urn:uuid:${id}`;
        const nowIso = new Date().toISOString();
        const { calendarIds: _drop, ...rest } = spec;
        rows.push({
          id,
          calendarId,
          uid,
          event: {
            ...(rest as CalendarEvent),
            "@type": "Event",
            id,
            uid,
            created: nowIso,
            updated: nowIso,
          },
        });
        created[cid] = { id, uid, created: nowIso, updated: nowIso };
      }

      for (const [id, patch] of Object.entries(
        (args.update as Record<string, Record<string, unknown>>) ?? {},
      )) {
        const row = rows.find((r) => r.id === id);
        if (!row) {
          notUpdated[id] = { type: "notFound" };
          continue;
        }
        const problem = applyPatch(row, patch, calendars);
        if (problem) notUpdated[id] = { type: "invalidProperties", description: problem };
        else updated[id] = null;
      }

      for (const id of (args.destroy as string[] | undefined) ?? []) {
        const idx = rows.findIndex((r) => r.id === id);
        if (idx < 0) notDestroyed[id] = { type: "notFound" };
        else {
          rows.splice(idx, 1);
          destroyed.push(id);
        }
      }

      const touched =
        Object.keys(created).length + Object.keys(updated).length + destroyed.length > 0;
      return {
        accountId: ACCOUNT,
        oldState,
        newState: touched ? bump() : oldState,
        created,
        notCreated,
        updated,
        notUpdated,
        destroyed,
        notDestroyed,
      };
    },
  };

  return { calendars, rows, handlers, state };
}

/**
 * Mirrors the server's `applyEventPatch` (`calendars.ts:680`): RFC 8620 §5.3
 * paths, `null` deletes, and `id`/`uid` immutable.
 *
 * ⚠️ A canned series is NOT re-derived on edit. That is the fake being honest
 * about being a fake: the real server recomputes the span through `eventSpan`
 * and re-expands on the next read, and this one cannot without becoming the
 * second expander the header forbids.
 */
function applyPatch(
  row: DemoEventRow,
  patch: Record<string, unknown>,
  calendars: Calendar[],
): string | null {
  const next = structuredClone(row.event) as Record<string, unknown>;
  let nextCalendarId = row.calendarId;

  for (const [path, value] of Object.entries(patch)) {
    if (path === "id" || path === "uid") return `${path} is immutable`;
    if (path === "calendarIds") {
      const ids = Object.entries((value as Record<string, boolean>) ?? {})
        .filter(([, v]) => v === true)
        .map(([k]) => k);
      if (ids.length !== 1) return "this server supports exactly one calendar per event";
      if (!calendars.some((c) => c.id === ids[0])) return `no such calendar: ${ids[0]}`;
      nextCalendarId = ids[0]!;
      continue;
    }
    const tokens = path.split("/");
    let parent = next;
    for (const t of tokens.slice(0, -1)) {
      const child = parent[t];
      if (child === null || typeof child !== "object" || Array.isArray(child)) {
        return `patch path "${path}" does not exist`;
      }
      parent = child as Record<string, unknown>;
    }
    const leaf = tokens[tokens.length - 1]!;
    if (value === null) delete parent[leaf];
    else parent[leaf] = value;
  }

  if (typeof next.start !== "string" || !parseCivilDateTime(next.start)) {
    return 'start must be a LocalDateTime ("2026-07-08T09:00:00")';
  }
  next.updated = new Date().toISOString();
  row.event = next as CalendarEvent;
  row.calendarId = nextCalendarId;
  return null;
}

/** Attach the calendar realm to a running demo client. */
export function installDemoCalendar(
  client: FakeJmapClient,
  nowMs: number = Date.now(),
): DemoCalendarBackend {
  const backend = createDemoCalendar(nowMs);
  for (const [name, handler] of Object.entries(backend.handlers)) client.setHandler(name, handler);
  return backend;
}

/** Exported for the fixture's own test — `dayKey` of the anchored month. */
export const demoAnchorKey = (nowMs: number): string => dayKey(anchorMonth(nowMs));
