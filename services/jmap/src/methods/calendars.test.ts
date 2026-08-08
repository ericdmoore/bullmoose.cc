import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerCalendarMethods } from "./calendars";
import type { RequestContext } from "./common";

// The half of .feedback/fromClaude/common/003 that a calendar-core unit test
// cannot reach.
//
// The proposed fix put the supported-parts guard in `rruleToRule`, whose only
// caller is `parseICal` — the ICS/CalDAV import path. But CalendarEvent/set
// accepts JSCalendar DIRECTLY: buildEventRow validates uid, start, timeZone
// and created, and never looks at recurrenceRules. A client posting
// {frequency:"yearly", byMonth:["11"], byDay:[{day:"th",nthOfPeriod:4}]} would
// walk straight past a parser-side guard and land a wrong `end_at` in the
// indexed calendar_events column.
//
// So the guard lives in `eventSpan` instead, and these drive the registered
// method end-to-end — requireAccount → buildEventRow → eventSpan → D1 — to
// prove the front door is actually shut and that nothing is written.
//
// The fakes are @bullmoose/test-fakes (sVOL 002): real SQLite on the live
// schema, and the REAL AccountDO behind ACCOUNT_DO — so "nothing was written"
// is now a row count rather than an absent entry in a writes array, and the
// changelog half of the write choreography is assertable at all.

// ---- fixtures ---------------------------------------------------------

const ACCOUNT = "a_eric";
const CAL = "cal_default";

const calendarRow = {
  id: CAL,
  account_id: ACCOUNT,
  name: "Calendar",
  description: null,
  color: null,
  sort_order: 0,
  is_default: 1,
  is_subscribed: 1,
  ctag: 1,
  created_at: 1,
  updated_at: 1,
};

/**
 * @param scopes the token's scopes. Default `["calendar"]` is what the /set
 *   tests have always run under. Note the asymmetry it exposes, which is the
 *   live convention (`_context.md` §4): calendar WRITES take `calendar`, but
 *   calendar READS — including `CalendarEvent/changes` — take `read`. A token
 *   that can create an event cannot read the changelog that reports it.
 */
function harness(scopes: string[] = ["calendar"]) {
  const w = fakeEnv();
  w.db.seed("calendars", [calendarRow]);

  const registry = new MethodRegistry<RequestContext>();
  registerCalendarMethods(registry);
  const handler = registry.get("CalendarEvent/set")!;
  const changes = registry.get("CalendarEvent/changes")!;

  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "eric@login.example",
      scopes,
      accounts: [{ accountId: ACCOUNT, tenantId: "t_bm", name: "Eric" }],
    },
  };

  const create = (spec: Record<string, unknown>) =>
    handler({ accountId: ACCOUNT, create: { c1: spec } }, ctx) as Promise<{
      created: Record<string, Record<string, unknown>>;
      notCreated: Record<string, { type: string; description?: string; properties?: string[] }>;
    }>;

  const insertedEvents = () => w.db.writes.filter((x) => x.sql.includes("INSERT INTO calendar_events"));
  /** What actually landed in the table — the assertion the old fake could not make. */
  const storedEvents = () => w.db.query(`SELECT * FROM calendar_events WHERE account_id = ?`, ACCOUNT);
  const eventChanges = (sinceState: string) =>
    changes({ accountId: ACCOUNT, sinceState }, ctx) as Promise<{
      created: string[];
      updated: string[];
      destroyed: string[];
    }>;

  return { create, insertedEvents, storedEvents, eventChanges, w };
}

const base = {
  uid: "urn:uuid:thanksgiving",
  title: "Thanksgiving",
  start: "2026-11-26T17:00:00",
  timeZone: "America/New_York",
  duration: "PT4H",
};

// ---- tests ------------------------------------------------------------

describe("CalendarEvent/set refuses rules the expander would mis-expand", () => {
  it("rejects a JSCalendar Thanksgiving rule posted straight at the API", async () => {
    // The exact payload a client would send having never touched ICS.
    const { create, insertedEvents } = harness();
    const res = await create({
      ...base,
      recurrenceRules: [
        { frequency: "yearly", byMonth: ["11"], byDay: [{ day: "th", nthOfPeriod: 4 }] },
      ],
    });
    expect(res.created).toEqual({});
    expect(res.notCreated.c1).toMatchObject({ type: "invalidProperties" });
    expect(res.notCreated.c1!.properties).toEqual(["recurrenceRules"]);
    expect(res.notCreated.c1!.description).toContain("unsupported recurrence rule");
    expect(res.notCreated.c1!.description).toContain("byDay");
    // and nothing reached the indexed columns
    expect(insertedEvents()).toEqual([]);
  });

  it("leaves the TABLE empty on a rejected rule, not just the writes array", async () => {
    // The stronger form of the assertion above. Before the shared harness,
    // "nothing was written" could only mean "no INSERT was attempted"; a fake
    // whose run() pushed to an array had no table to be empty.
    const { create, storedEvents } = harness();
    await create({ ...base, recurrenceRules: [{ frequency: "hourly" }] });
    expect(storedEvents()).toEqual([]);
  });

  it.each([
    ["FREQ=MONTHLY;BYMONTH=11;BYDAY=4TH", { frequency: "monthly", byMonth: ["11"], byDay: [{ day: "th", nthOfPeriod: 4 }] }],
    ["FREQ=DAILY;BYDAY=MO", { frequency: "daily", byDay: [{ day: "mo" }] }],
    ["FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25", { frequency: "yearly", byMonth: ["12"], byMonthDay: [25] }],
    ["FREQ=HOURLY", { frequency: "hourly" }],
  ])("rejects %s and writes nothing", async (_label, rule) => {
    const { create, insertedEvents } = harness();
    const res = await create({ ...base, recurrenceRules: [rule] });
    expect(Object.keys(res.created)).toEqual([]);
    expect(res.notCreated.c1!.properties).toEqual(["recurrenceRules"]);
    expect(insertedEvents()).toEqual([]);
  });

  it("still stores a supported rule, with the true last end in end_at", async () => {
    const { create, insertedEvents } = harness();
    const res = await create({
      ...base,
      uid: "urn:uuid:standup",
      title: "Standup",
      start: "2026-01-15T09:00:00",
      timeZone: "Etc/UTC",
      duration: "PT1H",
      recurrenceRules: [
        { frequency: "monthly", byMonthDay: [15], until: "2026-05-15T09:00:00" },
      ],
    });
    expect(res.notCreated).toEqual({});
    expect(Object.keys(res.created)).toEqual(["c1"]);

    const [insert] = insertedEvents();
    expect(insert).toBeDefined();
    // INSERT column order: id, account_id, calendar_id, uid, event_json,
    // title, start_at, end_at, is_recurring, ...
    const [, , , , , , startAt, endAt, isRecurring] = insert!.args;
    expect(startAt).toBe(1768467600000); // 2026-01-15T09:00Z, per dateutil
    expect(endAt).toBe(1778835600000 + 3_600_000); // 2026-05-15T09:00Z + PT1H
    expect(isRecurring).toBe(1);
  });

  it("still stores a non-recurring event untouched", async () => {
    const { create, insertedEvents } = harness();
    const res = await create({ ...base, uid: "urn:uuid:oneoff", recurrenceRules: undefined });
    expect(res.notCreated).toEqual({});
    expect(insertedEvents()).toHaveLength(1);
  });
});

// The write choreography, not just the write. `_context.md` §3: `Mailstore` is
// a thin data layer that maintains no invariants — the ctag bump and the
// AccountDO changelog commit live in the JMAP method layer, and a write that
// skips them lands the row, reads back fine on a direct `get`, and is invisible
// to every incremental consumer. That is a sync bug that is really a write-path
// bug, and it is the failure sVOL 013 is shaped around.
//
// None of this was assertable before: `ACCOUNT_DO` was a stub returning a
// canned `{oldState:"s1", newState:"s2"}`, which answers "did the changelog
// record it?" identically whether or not it did.
describe("CalendarEvent/set completes the write choreography", () => {
  it("reports the new event through CalendarEvent/changes", async () => {
    const h = harness(["read", "calendar"]); // reading the changelog takes `read`
    const before = await h.w.accountDo.state(ACCOUNT);

    const res = await h.create({ ...base, uid: "urn:uuid:oneoff" });
    const id = res.created.c1!.id as string;

    const delta = await h.eventChanges(before);
    expect(delta.created).toEqual([id]);
    expect(delta.updated).toEqual([]);
    expect(delta.destroyed).toEqual([]);
  });

  it("commits under the CalendarEvent collection, and only that one", async () => {
    const h = harness();
    await h.create({ ...base, uid: "urn:uuid:oneoff" });

    expect(h.w.accountDo.commits).toHaveLength(1);
    expect(h.w.accountDo.commits[0]!.entries.map((e) => e.collection)).toEqual(["CalendarEvent"]);
    // A commit for a collection nobody wrote would be a spurious resync for
    // every client polling it.
    expect((await h.w.accountDo.changes(ACCOUNT, "ContactCard")).created).toEqual([]);
  });

  it("bumps the calendar's ctag, or CalDAV clients never re-poll", async () => {
    // The other half of the choreography (calendars.ts:329). A stale ctag makes
    // an Apple Calendar sync silently skip the collection.
    const h = harness();
    expect(h.w.db.query<{ ctag: number }>(`SELECT ctag FROM calendars WHERE id = ?`, CAL)[0]!.ctag).toBe(1);

    await h.create({ ...base, uid: "urn:uuid:oneoff" });

    expect(h.w.db.query<{ ctag: number }>(`SELECT ctag FROM calendars WHERE id = ?`, CAL)[0]!.ctag).toBe(2);
  });

  it("does not commit anything when the write is rejected", async () => {
    const h = harness();
    await h.create({ ...base, recurrenceRules: [{ frequency: "hourly" }] });

    expect(h.w.accountDo.commits).toEqual([]);
    expect((await h.w.accountDo.changes(ACCOUNT, "CalendarEvent")).created).toEqual([]);
  });
});
