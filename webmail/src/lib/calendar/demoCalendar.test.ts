import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { createDemoCalendar, demoEventRows, installDemoCalendar } from "./demoCalendar";

const ACCOUNT = "acct-fake";
const NOW = Date.UTC(2026, 6, 15); // July 2026
const call = async (client: FakeJmapClient, name: string, args: Record<string, unknown>) =>
  client.requestOne(name, { accountId: ACCOUNT, ...args });

const wideWindow = { after: "2026-01-01T00:00:00Z", before: "2027-01-01T00:00:00Z" };

describe("the fake never learns to expand a recurrence rule", () => {
  it("has no reference to recurrenceRules outside the fixture literals", () => {
    // The invariant this module is built around, held by a test rather than a
    // comment. `calendar-core` is the ONE expander (~100 tests, python-dateutil
    // as oracle); a second one in the browser would be a second thing to be
    // wrong and would disagree with CalDAV.
    const src = readFileSync(fileURLToPath(new URL("./demoCalendar.ts", import.meta.url)), "utf8");
    // Below the fixtures, no code reads the field an expander would have to.
    const body = src.slice(src.indexOf("// ── the backend"));
    expect(body).not.toContain("recurrenceRules");
    // And the real expander is never imported — only named in prose explaining
    // why. `import` lines are the thing that would put it in the bundle.
    const imports = src.split("\n").filter((l) => /^\s*import\b|\bfrom "/.test(l));
    expect(imports.join("\n")).not.toContain("calendar-core");
  });

  it("returns exactly the canned starts for the series, and nothing between", async () => {
    const client = new FakeJmapClient();
    installDemoCalendar(client, NOW);
    const res = (await call(client, "CalendarEvent/getOccurrences", {
      ...wideWindow,
      ids: ["ev-standup"],
      maxOccurrences: 1000,
    })) as { list: Array<{ recurrenceId: string }> };
    const rows = demoEventRows(NOW);
    const canned = rows.find((r) => r.id === "ev-standup")!.cannedStarts!;
    expect(res.list.map((o) => o.recurrenceId)).toEqual(canned);
  });

  it("gives a newly created repeating event ONE occurrence — the honest fake answer", async () => {
    const client = new FakeJmapClient();
    installDemoCalendar(client, NOW);
    const created = (await call(client, "CalendarEvent/set", {
      create: {
        c1: {
          title: "Weekly thing",
          start: "2026-07-09T10:00:00",
          timeZone: "Etc/UTC",
          duration: "PT1H",
          calendarIds: { "cal-personal": true },
          recurrenceRules: [{ frequency: "weekly" }],
        },
      },
    })) as { created: Record<string, { id: string }> };
    const id = created.created.c1!.id;
    const res = (await call(client, "CalendarEvent/getOccurrences", {
      ...wideWindow,
      ids: [id],
      maxOccurrences: 1000,
    })) as { list: unknown[] };
    expect(res.list).toHaveLength(1);
  });
});

describe("the fake mirrors the server's semantics, warts included", () => {
  it("throws cannotCalculateChanges from queryChanges, exactly as the server does", async () => {
    const client = new FakeJmapClient();
    installDemoCalendar(client, NOW);
    // `calendars.ts:392-394` registers it and always throws; sVOL 026 owns it.
    await expect(call(client, "CalendarEvent/queryChanges", {})).rejects.toThrow(
      /cannotCalculateChanges/,
    );
  });

  it("reports canCalculateChanges: false from query", async () => {
    const client = new FakeJmapClient();
    installDemoCalendar(client, NOW);
    const res = (await call(client, "CalendarEvent/query", {})) as { canCalculateChanges: boolean };
    expect(res.canCalculateChanges).toBe(false);
  });

  it("refuses a window with before <= after", async () => {
    const client = new FakeJmapClient();
    installDemoCalendar(client, NOW);
    await expect(
      call(client, "CalendarEvent/getOccurrences", {
        after: "2026-07-01T00:00:00Z",
        before: "2026-07-01T00:00:00Z",
      }),
    ).rejects.toThrow(/invalidArguments/);
  });

  it("clamps a query limit to 256, as the store does", async () => {
    const client = new FakeJmapClient();
    installDemoCalendar(client, NOW);
    const res = (await call(client, "CalendarEvent/query", { limit: 9000 })) as { ids: string[] };
    expect(res.ids.length).toBeLessThanOrEqual(256);
  });

  it("reports total BEFORE the occurrence cap, so truncation is observable", async () => {
    const client = new FakeJmapClient();
    installDemoCalendar(client, NOW);
    const res = (await call(client, "CalendarEvent/getOccurrences", {
      ...wideWindow,
      maxOccurrences: 3,
    })) as { list: unknown[]; total: number };
    expect(res.list).toHaveLength(3);
    expect(res.total).toBeGreaterThan(3);
  });

  it("uses OVERLAP, not containment, as the window predicate", async () => {
    // Matches `calendar-core:489-493`: startMs < before && endMs > after. The
    // 3-day offsite starting on the 21st must appear in a window opening on
    // the 22nd.
    const client = new FakeJmapClient();
    installDemoCalendar(client, NOW);
    const res = (await call(client, "CalendarEvent/getOccurrences", {
      after: "2026-07-22T00:00:00Z",
      before: "2026-07-23T00:00:00Z",
      ids: ["ev-offsite"],
    })) as { list: unknown[] };
    expect(res.list).toHaveLength(1);
  });

  it("de-duplicates the ids a back-reference repeats", async () => {
    const client = new FakeJmapClient();
    installDemoCalendar(client, NOW);
    const res = (await call(client, "CalendarEvent/get", {
      ids: ["ev-standup", "ev-standup", "ev-standup"],
    })) as { list: unknown[] };
    expect(res.list).toHaveLength(1);
  });

  it("refuses an event with no parseable start", async () => {
    const client = new FakeJmapClient();
    installDemoCalendar(client, NOW);
    const res = (await call(client, "CalendarEvent/set", {
      create: { c1: { title: "x", start: "soon", calendarIds: { "cal-personal": true } } },
    })) as { notCreated: Record<string, { properties?: string[] }> };
    expect(res.notCreated.c1!.properties).toEqual(["start"]);
  });

  it("refuses to move an event into a calendar that does not exist", async () => {
    const client = new FakeJmapClient();
    installDemoCalendar(client, NOW);
    const res = (await call(client, "CalendarEvent/set", {
      update: { "ev-holiday": { calendarIds: { "cal-nope": true } } },
    })) as { notUpdated: Record<string, { description?: string }> };
    expect(res.notUpdated["ev-holiday"]!.description).toMatch(/no such calendar/);
  });

  it("treats id and uid as immutable", async () => {
    const client = new FakeJmapClient();
    installDemoCalendar(client, NOW);
    const res = (await call(client, "CalendarEvent/set", {
      update: { "ev-holiday": { uid: "urn:uuid:other" } },
    })) as { notUpdated: Record<string, { description?: string }> };
    expect(res.notUpdated["ev-holiday"]!.description).toMatch(/immutable/);
  });

  it("bumps state only when something was actually written", async () => {
    const client = new FakeJmapClient();
    const backend = installDemoCalendar(client, NOW);
    const before = backend.state();
    await call(client, "CalendarEvent/set", { update: { nope: { title: "x" } } });
    expect(backend.state()).toBe(before);
    await call(client, "CalendarEvent/set", { update: { "ev-holiday": { title: "x" } } });
    expect(backend.state()).not.toBe(before);
  });
});

describe("the fixture", () => {
  it("anchors on the month containing `now`, so the demo opens on data", () => {
    const rows = demoEventRows(Date.UTC(2027, 1, 3));
    expect(String(rows.find((r) => r.id === "ev-holiday")!.event.start)).toMatch(/^2027-02-18T/);
  });

  it("stores the all-day fixture exactly as the CalDAV importer would", () => {
    // midnight + Etc/UTC + showWithoutTime + no duration — `ical.ts:473-475`
    // and `:494`. If this drifts, `place.ts`'s off-by-one test stops testing
    // the real shape.
    const holiday = demoEventRows(NOW).find((r) => r.id === "ev-holiday")!.event;
    expect(holiday.start).toMatch(/T00:00:00$/);
    expect(holiday.timeZone).toBe("Etc/UTC");
    expect(holiday.showWithoutTime).toBe(true);
    expect(holiday.duration).toBeUndefined();
  });

  it("anchors the canned series on a Monday, matching the rule it displays", () => {
    const standup = demoEventRows(NOW).find((r) => r.id === "ev-standup")!;
    for (const start of standup.cannedStarts!) {
      const [y, m, d] = start.slice(0, 10).split("-").map(Number);
      expect(new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(), start).toBe(1);
    }
  });

  it("carries one rule the editor cannot express, so the freeze path is drivable", () => {
    const retro = demoEventRows(NOW).find((r) => r.id === "ev-lastfriday")!;
    expect(retro.event.recurrenceRules![0]!.byDay![0]!.nthOfPeriod).toBe(-1);
  });

  it("converts a zoned wall clock to the right instant", async () => {
    const client = new FakeJmapClient();
    installDemoCalendar(client, NOW);
    const res = (await call(client, "CalendarEvent/getOccurrences", {
      ...wideWindow,
      ids: ["ev-review"],
    })) as { list: Array<{ start: string; utcStart: string }> };
    // 09:30 in New York on 12 July 2026 is 13:30Z — EDT, UTC-4.
    expect(res.list[0]!.start).toBe("2026-07-12T09:30:00");
    expect(res.list[0]!.utcStart).toBe("2026-07-12T13:30:00.000Z");
  });

  it("resolves a winter wall clock through the OTHER offset", () => {
    // Proves the zone solve is real rather than a fixed -4: in January New
    // York is UTC-5.
    const backend = createDemoCalendar(NOW);
    backend.rows.push({
      id: "ev-winter",
      calendarId: "cal-personal",
      uid: "urn:uuid:winter",
      event: {
        id: "ev-winter",
        title: "Winter",
        start: "2026-01-12T09:30:00",
        duration: "PT1H",
        timeZone: "America/New_York",
      },
    });
    const res = backend.handlers["CalendarEvent/getOccurrences"]!({
      after: "2026-01-01T00:00:00Z",
      before: "2026-02-01T00:00:00Z",
      ids: ["ev-winter"],
    }) as { list: Array<{ utcStart: string }> };
    expect(res.list[0]!.utcStart).toBe("2026-01-12T14:30:00.000Z");
  });
});
