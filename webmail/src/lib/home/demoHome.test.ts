import { describe, expect, it } from "vitest";
import { createDemoBackend } from "../jmap/demo";
import type { Occurrence } from "../calendar/types";
import { horizonEventRows, installHomeDemo } from "./demoHome";

const NOW = Date.parse("2026-08-11T12:00:00Z");
const ACCOUNT = "acct-fake";
const ZONE = "Etc/UTC";

describe("installHomeDemo — the union of two realms' fakes", () => {
  it("serves the approvals realm (composed installApprovalsDemo)", async () => {
    const { client } = createDemoBackend();
    installHomeDemo(client, { now: NOW, viewerZone: ZONE });
    const res = await client.requestOne("ActionProposal/query", { accountId: ACCOUNT });
    expect(Array.isArray(res.ids)).toBe(true);
    expect((res.ids as string[]).length).toBeGreaterThan(0);
  });

  it("serves the calendar realm with today/tomorrow events seeded onto the horizon", async () => {
    const { client } = createDemoBackend();
    installHomeDemo(client, { now: NOW, viewerZone: ZONE });
    const res = await client.requestOne("CalendarEvent/getOccurrences", {
      accountId: ACCOUNT,
      after: new Date(NOW - 86_400_000).toISOString(),
      before: new Date(NOW + 3 * 86_400_000).toISOString(),
      maxOccurrences: 200,
    });
    const ids = (res.list as Occurrence[]).map((o) => o.eventId);
    expect(ids).toContain("ev-home-today");
    expect(ids).toContain("ev-home-tomorrow");
  });

  it("does not duplicate fixtures — it adds exactly two horizon rows", () => {
    const rows = horizonEventRows(NOW, ZONE);
    expect(rows.map((r) => r.id)).toEqual(["ev-home-today", "ev-home-tomorrow"]);
    expect(rows[1]!.event.showWithoutTime).toBe(true); // the all-day one
  });
});
