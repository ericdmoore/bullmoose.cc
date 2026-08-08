import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { registerCalendarMethods } from "./calendars";
import type { RequestContext } from "./common";
import type { Env } from "../index";

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

// ---- fakes ------------------------------------------------------------

const ACCOUNT = "a_eric";
const CAL = "cal_default";

const calendarRow = {
  id: CAL,
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

/** A fake D1 that routes by SQL and records every write for assertions. */
function fakeD1() {
  const writes: Array<{ sql: string; args: unknown[] }> = [];

  const rowsFor = (sql: string): unknown[] => {
    if (sql.includes("FROM calendars")) return [calendarRow];
    return []; // no uid collisions, no existing events
  };

  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    return {
      sql,
      bound: () => bound,
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async first() {
        return (rowsFor(sql)[0] as Record<string, unknown> | undefined) ?? null;
      },
      async all() {
        return { results: rowsFor(sql) };
      },
      async run() {
        writes.push({ sql, args: bound });
        return { meta: { changes: 1 } };
      },
    };
  };

  const batch = async (stmts: Array<{ sql: string; bound: () => unknown[] }>) => {
    for (const s of stmts) writes.push({ sql: s.sql, args: s.bound() });
    return stmts.map((s) => ({ results: rowsFor(s.sql) }));
  };

  return { db: { prepare, batch }, writes };
}

function fakeAccountDo() {
  const stub = {
    async fetch(input: RequestInfo | URL) {
      const url = String(input instanceof Request ? input.url : input);
      const body = url.endsWith("/state")
        ? { state: "s1" }
        : { oldState: "s1", newState: "s2" };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { idFromName: (n: string) => n, get: () => stub };
}

function harness() {
  const { db, writes } = fakeD1();
  const registry = new MethodRegistry<RequestContext>();
  registerCalendarMethods(registry);
  const handler = registry.get("CalendarEvent/set")!;

  const ctx: RequestContext = {
    env: {
      DB: db,
      BLOBS: {},
      ACCOUNT_DO: fakeAccountDo(),
    } as unknown as Env,
    principal: {
      username: "eric@login.example",
      scopes: ["calendar"],
      accounts: [{ accountId: ACCOUNT, tenantId: "t_bm", name: "Eric" }],
    },
  };

  const create = (spec: Record<string, unknown>) =>
    handler({ accountId: ACCOUNT, create: { c1: spec } }, ctx) as Promise<{
      created: Record<string, Record<string, unknown>>;
      notCreated: Record<string, { type: string; description?: string; properties?: string[] }>;
    }>;

  const insertedEvents = () => writes.filter((w) => w.sql.includes("INSERT INTO calendar_events"));

  return { create, insertedEvents, writes };
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
