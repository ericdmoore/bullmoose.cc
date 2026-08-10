import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import {
  createEvent,
  destroyEvent,
  loadCalendars,
  loadWindow,
  refusalOf,
  searchEvents,
  updateEvent,
} from "./api";
import { installDemoCalendar } from "./demoCalendar";
import { gridDays, queryWindow } from "./grid";
import { segmentsByDay } from "./place";

const ACCOUNT = "acct-fake";
/** A fixed "now" so the fixture month is stable: July 2026. */
const NOW = Date.UTC(2026, 6, 15);
const WINDOW = queryWindow(gridDays({ kind: "month", anchor: { year: 2026, month: 7, day: 1 }, weekStartsOn: 0 }));

function backed() {
  const client = new FakeJmapClient();
  const backend = installDemoCalendar(client, NOW);
  return { client, backend };
}

describe("loading the calendar list", () => {
  it("sorts by sortOrder then name", async () => {
    const { client } = backed();
    const { calendars, state } = await loadCalendars(client, ACCOUNT);
    expect(calendars.map((c) => c.id)).toEqual(["cal-personal", "cal-elk"]);
    expect(state).toBe("cal-0");
  });
});

describe("loading a window", () => {
  it("takes ONE round trip for occurrences, the honesty count and the blobs", async () => {
    const { client } = backed();
    await loadWindow(client, ACCOUNT, WINDOW);
    expect(client.sentBatches).toHaveLength(1);
    expect(client.sentBatches[0]!.map((c) => c[0])).toEqual([
      "CalendarEvent/getOccurrences",
      "CalendarEvent/query",
      "CalendarEvent/get",
    ]);
  });

  it("actually ASKS for the total — the query call is pointless without it", async () => {
    // Its ids are discarded; `calculateTotal` is the entire reason it is in
    // the batch. Drop the flag and the 256-candidate ceiling becomes
    // unobservable again while every other assertion here stays green.
    const { client } = backed();
    await loadWindow(client, ACCOUNT, WINDOW);
    const query = client.sentBatches[0]!.find((c) => c[0] === "CalendarEvent/query")![1] as {
      calculateTotal?: boolean;
      filter: { after?: string; before?: string };
    };
    expect(query.calculateTotal).toBe(true);
    // …over the SAME window the occurrences came from, or the count answers a
    // different question than the one the caveat line asks.
    expect(query.filter.after).toBe(WINDOW.after);
    expect(query.filter.before).toBe(WINDOW.before);
  });

  it("back-references the event ids off the occurrence list", async () => {
    const { client } = backed();
    const res = await loadWindow(client, ACCOUNT, WINDOW);
    // The blobs the editor needs — timeZone, duration, recurrenceRules — none
    // of which an occurrence carries.
    expect(Object.keys(res.events)).toContain("ev-standup");
    expect(res.events["ev-standup"]!.recurrenceRules).toBeDefined();
    expect(res.events["ev-review"]!.timeZone).toBe("America/New_York");
  });

  it("expands nothing client-side — the series comes back already expanded", async () => {
    const { client } = backed();
    const res = await loadWindow(client, ACCOUNT, WINDOW);
    const standups = res.occurrences.filter((o) => o.eventId === "ev-standup");
    // More than one occurrence from ONE stored event: the server did that.
    expect(standups.length).toBeGreaterThan(3);
    // Every occurrence names the same underlying event and a distinct key.
    expect(new Set(standups.map((o) => o.recurrenceId)).size).toBe(standups.length);
  });

  it("reports no truncation for an ordinary month", async () => {
    const { client } = backed();
    const res = await loadWindow(client, ACCOUNT, WINDOW);
    expect(res.truncation).toEqual({ occurrences: false, candidates: false });
  });

  it("reports truncation when the per-request cap bites", async () => {
    const { client } = backed();
    const res = await loadWindow(client, ACCOUNT, { ...WINDOW, maxOccurrences: 2 });
    expect(res.occurrences).toHaveLength(2);
    expect(res.truncation.occurrences).toBe(true);
    expect(res.total).toBeGreaterThan(2);
  });

  it("reports candidate truncation from the separate query total", async () => {
    // The whole reason the second call exists: a 300-event month otherwise
    // renders 256 and looks finished.
    const client = new FakeJmapClient({
      handlers: {
        "CalendarEvent/getOccurrences": () => ({ accountId: ACCOUNT, list: [], total: 0 }),
        "CalendarEvent/query": () => ({ accountId: ACCOUNT, ids: [], total: 900 }),
        "CalendarEvent/get": () => ({ accountId: ACCOUNT, state: "s", list: [], notFound: [] }),
      },
    });
    const res = await loadWindow(client, ACCOUNT, WINDOW);
    expect(res.truncation.candidates).toBe(true);
  });

  it("still renders the grid when the honesty count or the blobs fail", async () => {
    // Failing the whole load over either would be worse than a window with no
    // caveat line.
    const client = new FakeJmapClient({
      handlers: {
        "CalendarEvent/getOccurrences": () => ({
          accountId: ACCOUNT,
          list: [
            {
              eventId: "e1",
              calendarId: "c1",
              uid: "u",
              recurrenceId: "2026-07-08T09:00:00",
              start: "2026-07-08T09:00:00",
              utcStart: "2026-07-08T09:00:00Z",
              utcEnd: "2026-07-08T10:00:00Z",
              title: "Kept",
              showWithoutTime: false,
            },
          ],
          total: 1,
        }),
        "CalendarEvent/query": () => ["error", { type: "unsupportedFilter" }],
        "CalendarEvent/get": () => ["error", { type: "serverFail" }],
      },
    });
    const res = await loadWindow(client, ACCOUNT, WINDOW);
    expect(res.occurrences).toHaveLength(1);
    expect(res.events).toEqual({});
    expect(res.truncation.candidates).toBe(false);
  });

  it("throws with a readable message when the occurrence call itself fails", async () => {
    const client = new FakeJmapClient({
      handlers: {
        "CalendarEvent/getOccurrences": () => ["error", { type: "forbidden" }],
      },
    });
    await expect(loadWindow(client, ACCOUNT, WINDOW)).rejects.toThrow(/not allowed/);
  });

  it("passes inCalendar through to both filtered calls", async () => {
    const { client } = backed();
    await loadWindow(client, ACCOUNT, { ...WINDOW, inCalendar: "cal-elk" });
    const [occCall, queryCall] = client.sentBatches[0]!;
    expect((occCall![1] as { inCalendar?: string }).inCalendar).toBe("cal-elk");
    expect((queryCall![1] as { filter: { inCalendar?: string } }).filter.inCalendar).toBe("cal-elk");
  });
});

describe("the window placed on a grid", () => {
  it("puts the all-day fixture on the same date in every timezone", async () => {
    // The end-to-end version of `place.test.ts`: through a fake server, out of
    // getOccurrences, onto a grid.
    const { client } = backed();
    const res = await loadWindow(client, ACCOUNT, WINDOW);
    for (const zone of ["Etc/UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      const byDay = segmentsByDay(res.occurrences, zone);
      const holiday = byDay.get("2026-07-18")?.find((s) => s.eventId === "ev-holiday");
      expect(holiday, zone).toBeDefined();
      expect(holiday!.allDay).toBe(true);
    }
  });

  it("converts the New York fixture into the viewer's zone", async () => {
    const { client } = backed();
    const res = await loadWindow(client, ACCOUNT, WINDOW);
    const inUtc = segmentsByDay(res.occurrences, "Etc/UTC")
      .get("2026-07-12")!
      .find((s) => s.eventId === "ev-review")!;
    const inNy = segmentsByDay(res.occurrences, "America/New_York")
      .get("2026-07-12")!
      .find((s) => s.eventId === "ev-review")!;
    // 09:30 in New York is 13:30 UTC in July.
    expect(inNy.fromMinute).toBe(9 * 60 + 30);
    expect(inUtc.fromMinute).toBe(13 * 60 + 30);
  });
});

describe("writes", () => {
  it("creates an event and reports its id", async () => {
    const { client, backend } = backed();
    const before = backend.rows.length;
    const outcome = await createEvent(client, ACCOUNT, {
      title: "New thing",
      start: "2026-07-09T11:00:00",
      timeZone: "Etc/UTC",
      duration: "PT1H",
      calendarIds: { "cal-personal": true },
    });
    expect(outcome.refusal).toBeUndefined();
    expect(outcome.createdId).toBeTruthy();
    expect(backend.rows).toHaveLength(before + 1);
  });

  it("sends ifInState on every write so a stale view cannot clobber", async () => {
    const { client } = backed();
    await createEvent(
      client,
      ACCOUNT,
      { title: "x", start: "2026-07-09T11:00:00", calendarIds: { "cal-personal": true } },
      { ifInState: "cal-0" },
    );
    const args = client.sentBatches.at(-1)![0]![1] as { ifInState?: string };
    expect(args.ifInState).toBe("cal-0");
  });

  it("refuses the whole call on a stale ifInState, writing nothing", async () => {
    const { client, backend } = backed();
    const before = backend.rows.length;
    const outcome = await createEvent(
      client,
      ACCOUNT,
      { title: "x", start: "2026-07-09T11:00:00", calendarIds: { "cal-personal": true } },
      { ifInState: "not-the-state" },
    );
    expect(outcome.refusal?.type).toBe("stateMismatch");
    expect(outcome.refusal?.message).toMatch(/nothing was written/);
    expect(backend.rows).toHaveLength(before);
  });

  it("skips the round trip entirely for an empty patch", async () => {
    const { client } = backed();
    const outcome = await updateEvent(client, ACCOUNT, "ev-standup", {});
    expect(client.sentBatches).toHaveLength(0);
    expect(outcome.updatedIds).toEqual([]);
  });

  it("applies a patch and leaves an untouched recurrence rule alone", async () => {
    const { client, backend } = backed();
    const outcome = await updateEvent(client, ACCOUNT, "ev-lastfriday", { title: "Renamed" });
    expect(outcome.updatedIds).toEqual(["ev-lastfriday"]);
    const row = backend.rows.find((r) => r.id === "ev-lastfriday")!;
    expect(row.event.title).toBe("Renamed");
    expect(row.event.recurrenceRules).toEqual([
      { frequency: "monthly", byDay: [{ day: "fr", nthOfPeriod: -1 }] },
    ]);
  });

  it("reports per-id failures separately from a whole-call refusal", async () => {
    const { client } = backed();
    const outcome = await updateEvent(client, ACCOUNT, "no-such-event", { title: "x" });
    expect(outcome.refusal).toBeUndefined();
    expect(outcome.problems).toEqual([{ id: "no-such-event", type: "notFound" }]);
  });

  it("destroys an event", async () => {
    const { client, backend } = backed();
    const outcome = await destroyEvent(client, ACCOUNT, "ev-holiday");
    expect(outcome.destroyedIds).toEqual(["ev-holiday"]);
    expect(backend.rows.some((r) => r.id === "ev-holiday")).toBe(false);
  });
});

describe("search", () => {
  it("matches title and description by substring, and nothing else", async () => {
    const { client } = backed();
    const byTitle = await searchEvents(client, ACCOUNT, "standup");
    expect(byTitle.events.map((e) => e.id)).toEqual(["ev-standup"]);

    const byDescription = await searchEvents(client, ACCOUNT, "standing up");
    expect(byDescription.events.map((e) => e.id)).toEqual(["ev-standup"]);

    // Locations are NOT searched — the server's LIKE covers title and
    // $.description only (`mailstore/src/index.ts:2277-2284`).
    const byLocation = await searchEvents(client, ACCOUNT, "Room 2");
    expect(byLocation.events).toEqual([]);
  });

  it("never asks for more than the server would return anyway", async () => {
    const { client } = backed();
    await searchEvents(client, ACCOUNT, "a", 5000);
    const args = client.sentBatches.at(-1)![0]![1] as { limit: number };
    expect(args.limit).toBe(256);
  });
});

describe("refusals become sentences", () => {
  it.each([
    ["forbidden", /calendar. permission/],
    ["stateMismatch", /Reload and try again/],
    ["unknownMethod", /does not serve calendars/],
    ["unknownCapability", /does not serve calendars/],
  ])("explains %s", (type, pattern) => {
    expect(refusalOf({ type }).message).toMatch(pattern);
  });

  it("falls back to the server's own description", () => {
    expect(refusalOf({ type: "invalidArguments", description: "after < before required" }).message).toBe(
      "after < before required",
    );
  });

  it("says something for an undefined detail rather than throwing", () => {
    expect(refusalOf(undefined).message).toContain("error");
  });
});
