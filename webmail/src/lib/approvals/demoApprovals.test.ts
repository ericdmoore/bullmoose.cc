import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { NEAR_EXPIRY_MS, rowClocks } from "./clocks";
import { demoApprovalsOptions, demoProposals, installApprovalsDemo } from "./demoApprovals";

const ACCOUNT = "acct-fake";
const NOW = Date.parse("2026-08-11T12:00:00Z");

function harness(opts: Parameters<typeof installApprovalsDemo>[1] = {}) {
  const client = new FakeJmapClient();
  const backend = installApprovalsDemo(client, { now: NOW, ...opts });
  return { client, backend };
}

describe("the fixture set covers what the task needs drivable", () => {
  const rows = demoProposals(NOW);

  it("has a near-expiry pending row — under the urgency line, still decidable", () => {
    const near = rows.filter(
      (p) => p.status === "pending" && rowClocks(p, NOW).expiresInMs !== null && rowClocks(p, NOW).expiresInMs! < NEAR_EXPIRY_MS,
    );
    expect(near.map((p) => p.id)).toEqual(["ap-reply-elk"]);
    expect(rowClocks(near[0]!, NOW).expiresInMs).toBeGreaterThan(0);
  });

  it("has one already-held row with a live retraction window and a decidedAt", () => {
    const held = rows.filter((p) => p.status === "held");
    expect(held.map((p) => p.id)).toEqual(["ap-held-agenda"]);
    const clocks = rowClocks(held[0]!, NOW);
    expect(clocks.holdRemainingMs).toBeGreaterThan(0);
    expect(clocks.expiresInMs).toBeNull(); // held renders holdUntil, never expiresAt
  });

  it("has an approved-after-edit row whose original and edit BOTH survive", () => {
    const edited = rows.find((p) => p.id === "ap-edited-weekly")!;
    expect(edited.status).toBe("approved");
    expect(edited.editedPayload).not.toBeNull();
    expect(edited.editedPayload!.text).not.toBe(edited.payload.text);
  });

  it("rationale is non-empty on every row (invariant §8.3)", () => {
    for (const p of rows) expect(p.rationale.length, p.id).toBeGreaterThan(0);
  });

  it("has an OPEN needsInfo row — waiting on the agent, deadline paused (s10 T3)", () => {
    const open = rows.filter((p) => p.status === "info-requested");
    expect(open.map((p) => p.id)).toEqual(["ap-info-subscribe"]);
    const row = open[0]!;
    expect(row.question).not.toBeNull();
    expect(row.expiresAt).toBeNull(); // banked server-side, not running
    const last = row.amendments[row.amendments.length - 1]!;
    expect(last.answer).toBeNull(); // the answer is owed
  });

  it("has a challenged-then-returned row whose Q&A dialogue BOTH survives and reads answered", () => {
    const back = rows.find((p) => p.id === "ap-grant-crm")!;
    expect(back.status).toBe("pending"); // decidable again, dialogue attached
    expect(back.question).toBeNull();
    expect(back.amendments).toHaveLength(1);
    expect(back.amendments[0]!.answer).not.toBeNull();
    // ...and it is the recipient widening, so the new grant shape is drivable.
    expect(back.payload.grantType).toBe("recipient");
  });

  it("every row carries evidence — what the agent looked at", () => {
    for (const p of rows) expect(p.evidence.length, p.id).toBeGreaterThan(0);
  });
});

describe("server-wart mirrors (actionProposal.ts)", () => {
  it("refuses create with the server's sentence — the worker produces proposals", async () => {
    const { client } = harness();
    await expect(
      client.requestOne("ActionProposal/set", { accountId: ACCOUNT, create: { c1: { kind: "reply-draft" } } }),
    ).rejects.toThrow(/invalidArguments/);
  });

  it("refuses an unknown query filter property", async () => {
    const { client } = harness();
    await expect(
      client.requestOne("ActionProposal/query", { accountId: ACCOUNT, filter: { agent: "Emily" } }),
    ).rejects.toThrow(/unsupportedFilter/);
  });

  it("filters by status, single or set, newest first", async () => {
    const { client } = harness();
    const single = await client.requestOne("ActionProposal/query", {
      accountId: ACCOUNT,
      filter: { status: "held" },
    });
    expect(single.ids).toEqual(["ap-held-agenda"]);
    const set = await client.requestOne("ActionProposal/query", {
      accountId: ACCOUNT,
      filter: { status: ["approved", "rejected"] },
    });
    expect(set.ids).toEqual(["ap-edited-weekly", "ap-event-webinar"]);
  });

  it("ActionProposal/queryChanges always throws, as the server's does", async () => {
    const { client } = harness();
    await expect(client.requestOne("ActionProposal/queryChanges", { accountId: ACCOUNT })).rejects.toThrow(
      /cannotCalculateChanges/,
    );
  });

  it("refuses to destroy a pending row — decide it, don't drop it", async () => {
    const { client } = harness();
    const res = await client.requestOne("ActionProposal/set", { accountId: ACCOUNT, destroy: ["ap-reply-elk"] });
    expect((res.notDestroyed as Record<string, { description?: string }>)["ap-reply-elk"]?.description).toContain(
      "decide a pending proposal",
    );
    // A decided one purges fine (housekeeping).
    const ok = await client.requestOne("ActionProposal/set", { accountId: ACCOUNT, destroy: ["ap-event-webinar"] });
    expect(ok.destroyed).toEqual(["ap-event-webinar"]);
  });

  it("rejects a decision.reason outside the enum", async () => {
    const { client } = harness();
    const res = await client.requestOne("ActionProposal/set", {
      accountId: ACCOUNT,
      update: { "ap-reply-elk": { status: "rejected", decision: { reason: "meh" } } },
    });
    const err = (res.notUpdated as Record<string, { description?: string }>)["ap-reply-elk"];
    expect(err?.description).toContain("wrongContent | wrongAction | notNow");
  });

  it("requires the draft scope for the whole method, like requireAccount does", async () => {
    const { client } = harness({ scopes: ["read"] });
    await expect(
      client.requestOne("ActionProposal/set", {
        accountId: ACCOUNT,
        update: { "ap-reply-elk": { status: "approved" } },
      }),
    ).rejects.toThrow(/forbidden/);
  });

  it("the sweep flips overdue pending rows to expired — reads never do", async () => {
    const { client, backend } = harness();
    const past = NOW + 40 * 60_000; // past ap-reply-elk's 35-minute deadline
    // A read after the deadline still says pending: expiry is the worker
    // cron's job (services/agent/src/proposals.ts:153), not the read path's.
    const before = await client.requestOne("ActionProposal/get", { accountId: ACCOUNT, ids: ["ap-reply-elk"] });
    expect((before.list as Array<{ status: string }>)[0]?.status).toBe("pending");
    backend.sweep(past);
    const after = await client.requestOne("ActionProposal/get", { accountId: ACCOUNT, ids: ["ap-reply-elk"] });
    expect((after.list as Array<{ status: string }>)[0]?.status).toBe("expired");
  });
});

describe("demoApprovalsOptions — the ?send=0 knob", () => {
  it("drops only the send scope, so the tier-3 capability wall is drivable", () => {
    expect(demoApprovalsOptions("?demo=1&send=0")).toEqual({
      scopes: ["read", "annotate", "draft", "move", "delete"],
    });
  });

  it("is a no-op otherwise — the default demo session is a full human token", () => {
    expect(demoApprovalsOptions("?demo=1")).toEqual({});
  });
});
