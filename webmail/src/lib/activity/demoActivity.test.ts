import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { demoWatches, demoYankedProposal, installActivityDemo } from "./demoActivity";

const ACCOUNT = "acct-fake";
const NOW = Date.parse("2026-08-11T12:00:00Z");

function harness() {
  const client = new FakeJmapClient();
  const backend = installActivityDemo(client, { now: NOW });
  return { client, backend };
}

describe("the composed backend", () => {
  it("rides the approvals installer — decided fixtures come from THERE, not clones", async () => {
    const { client } = harness();
    const res = await client.requestOne("ActionProposal/query", { accountId: ACCOUNT });
    const ids = res.ids as string[];
    // The approvals set's own history rows, plus the one activity-only fixture.
    for (const id of ["ap-edited-weekly", "ap-event-webinar", "ap-thread-vendor", "ap-files-receipts"]) {
      expect(ids, id).toContain(id);
    }
    expect(ids).toContain("ap-yanked-sergio");
  });

  it("the yanked fixture records who pulled it back — the record needs its principal", () => {
    const p = demoYankedProposal(NOW) as unknown as Record<string, unknown>;
    expect(p.status).toBe("yanked");
    expect((p.decision as { by?: string }).by).toBe("fake@bullmoose.test");
    expect(p.decidedAt).toBeTruthy();
  });
});

describe("the Watch handlers mirror the server, warts included", () => {
  it("the DEFAULT view is armed-only — a roster, not a graveyard (watch.ts)", async () => {
    const { client } = harness();
    const res = await client.requestOne("Watch/query", { accountId: ACCOUNT });
    expect(res.ids).toEqual(["w-grace-agenda"]);
  });

  it("a terminal status must be asked for by name; fired sorts by deadline", async () => {
    const { client } = harness();
    const res = await client.requestOne("Watch/query", { accountId: ACCOUNT, filter: { status: "fired" } });
    // deadline ASC: the invoice watch (2d ago) before the boards watch (5h ago).
    expect(res.ids).toEqual(["w-invoice-ack", "w-sergio-boards"]);
  });

  it("Watch/get resolves ids and reports the missing", async () => {
    const { client } = harness();
    const res = await client.requestOne("Watch/get", { accountId: ACCOUNT, ids: ["w-invoice-ack", "w-nope"] });
    const list = res.list as Array<{ id: string; status: string; firedAt: number | null }>;
    expect(list.map((w) => w.id)).toEqual(["w-invoice-ack"]);
    expect(list[0]!.status).toBe("fired");
    expect(res.notFound).toEqual(["w-nope"]);
  });

  it("the fixture set keeps one armed watch, so the fired filter is PROVEN, not assumed", () => {
    const statuses = demoWatches(NOW).map((w) => w.status);
    expect(statuses.filter((s) => s === "fired")).toHaveLength(2);
    expect(statuses).toContain("armed");
  });
});
