import { describe, expect, it } from "vitest";
import { FakeJmapClient, type MethodHandler } from "../jmap/FakeJmapClient";
import { loadActivity } from "./api";
import { installActivityDemo } from "./demoActivity";

const ACCOUNT = "acct-fake";
const NOW = Date.parse("2026-08-11T12:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const HOUR = 3600_000;

describe("loadActivity over the demo backend — the /activity?demo=1 path", () => {
  function harness(): FakeJmapClient {
    const client = new FakeJmapClient();
    installActivityDemo(client, { now: NOW });
    return client;
  }

  it("serves ONLY the decided partition — live rows stay the queue's", async () => {
    const { items } = await loadActivity(harness(), [ACCOUNT]);
    const decided = items.filter((i) => i.type === "decided");
    // The approvals fixture set carries pending/info-requested/held rows too;
    // none of them may reach the record.
    expect(decided.length).toBeGreaterThanOrEqual(4);
    for (const d of decided) {
      if (d.type !== "decided") continue;
      expect(["approved", "rejected", "expired", "yanked"]).toContain(d.status);
    }
  });

  it("keeps the yanked row AS yanked — the coercion trap does not reach the feed", async () => {
    const { items } = await loadActivity(harness(), [ACCOUNT]);
    const yanked = items.find((i) => i.type === "decided" && i.status === "yanked");
    expect(yanked).toBeDefined();
    expect(yanked!.id).toBe("decided:ap-yanked-sergio");
  });

  it("serves the fired watches and never the armed one", async () => {
    const { items, watchesUnavailable } = await loadActivity(harness(), [ACCOUNT]);
    const watches = items.filter((i) => i.type === "watch-fired");
    expect(watches.map((w) => w.id).sort()).toEqual(["watch:w-invoice-ack", "watch:w-sergio-boards"]);
    expect(watchesUnavailable).toBe(false);
  });

  it("reads everything in ONE batch — 4 invocations per account", async () => {
    const client = harness();
    await loadActivity(client, [ACCOUNT]);
    expect(client.sentBatches).toHaveLength(1);
    expect(client.sentBatches[0]).toHaveLength(4);
  });
});

/** A hand-rolled two-account server, so the merge and its failure modes are
 *  drivable — the same shape as `../approvals/api.test.ts` `twoAccounts`. */
describe("loadActivity — the merged record and its failure modes", () => {
  const OWN = "acct-own";
  const EMILY = "acct-emily";

  function row(id: string, accountId: string, decidedAgo: number): Record<string, unknown> {
    return {
      id,
      accountId,
      agent: "Emily",
      kind: "reply-draft",
      tier: 2,
      subject: { realm: "Email", objectId: "e1" },
      payload: { to: "x@example.test", subject: "Re: x" },
      editedPayload: null,
      rationale: "why",
      evidence: [],
      status: "approved",
      decision: { by: "eric@bullmoose.test" },
      createdAt: iso(NOW - decidedAgo - HOUR),
      decidedAt: iso(NOW - decidedAgo),
      holdUntil: null,
      expiresAt: null,
      dueAt: null,
      question: null,
      amendments: [],
      invocationStatus: "done",
      claimedAt: null,
    };
  }

  function server(opts: { refuseProposals?: string[]; refuseWatches?: string[] } = {}): FakeJmapClient {
    const rows: Record<string, Record<string, unknown>[]> = {
      [OWN]: [row("own-1", OWN, HOUR)],
      [EMILY]: [row("em-1", EMILY, 2 * HOUR)],
    };
    const watches: Record<string, Record<string, unknown>[]> = {
      [OWN]: [
        {
          id: "w-own",
          accountId: OWN,
          conditionType: "deadline",
          condition: {},
          deadlineAt: NOW - HOUR,
          actionType: "notify",
          action: {},
          status: "fired",
          sourceRef: null,
          createdAt: NOW - 4 * HOUR,
          firedAt: NOW - HOUR,
          proposalId: null,
        },
      ],
      [EMILY]: [],
    };
    const client = new FakeJmapClient();
    const q =
      (refuse: string[] | undefined, key: "proposals" | "watches"): MethodHandler =>
      (args) => {
        const acct = args.accountId as string;
        if (refuse?.includes(acct)) return ["error", { type: "forbidden", description: `no ${key} for ${acct}` }];
        const list = (key === "proposals" ? rows : watches)[acct] ?? [];
        return { accountId: acct, queryState: "0", ids: list.map((r) => r.id as string) };
      };
    const g =
      (key: "proposals" | "watches"): MethodHandler =>
      (args) => {
        const acct = args.accountId as string;
        const list = (key === "proposals" ? rows : watches)[acct] ?? [];
        const ids = args.ids as string[] | null | undefined;
        return {
          accountId: acct,
          state: "0",
          list: ids == null ? list : list.filter((r) => ids.includes(r.id as string)),
          notFound: [],
        };
      };
    client.setHandler("ActionProposal/query", q(opts.refuseProposals, "proposals"));
    client.setHandler("ActionProposal/get", g("proposals"));
    client.setHandler("Watch/query", q(opts.refuseWatches, "watches"));
    client.setHandler("Watch/get", g("watches"));
    return client;
  }

  it("merges both accounts' history into one feed", async () => {
    const res = await loadActivity(server(), [OWN, EMILY]);
    expect(res.items.map((i) => i.id).sort()).toEqual(["decided:em-1", "decided:own-1", "watch:w-own"]);
    expect(res.failures).toEqual({});
    expect(res.watchesUnavailable).toBe(false);
  });

  it("one account's refusal is VISIBLE beside the others' rows, never silent", async () => {
    const res = await loadActivity(server({ refuseProposals: [EMILY] }), [OWN, EMILY]);
    expect(res.items.map((i) => i.id).sort()).toEqual(["decided:own-1", "watch:w-own"]);
    expect(res.failures[EMILY]).toContain("no proposals for acct-emily");
  });

  it("a watch-only refusal keeps that account's decided rows and names the gap", async () => {
    const res = await loadActivity(server({ refuseWatches: [EMILY] }), [OWN, EMILY]);
    expect(res.items.map((i) => i.id).sort()).toEqual(["decided:em-1", "decided:own-1", "watch:w-own"]);
    expect(res.failures[EMILY]).toBe("watches: no watches for acct-emily");
    expect(res.watchesUnavailable).toBe(false);
  });

  it("no account serving Watch is a roster-wide fact, not N failure walls", async () => {
    const client = server();
    // An older server: the method does not exist at all.
    const unknown: MethodHandler = () => ["error", { type: "unknownMethod" }];
    client.setHandler("Watch/query", unknown);
    client.setHandler("Watch/get", unknown);
    const res = await loadActivity(client, [OWN, EMILY]);
    expect(res.watchesUnavailable).toBe(true);
    // The per-account watch notes fold into the flag; nothing else failed.
    expect(res.failures).toEqual({});
    expect(res.items.map((i) => i.id).sort()).toEqual(["decided:em-1", "decided:own-1"]);
  });

  it("every proposal read failing is a hard error — a feed that shows nothing must not explain nothing", async () => {
    await expect(loadActivity(server({ refuseProposals: [OWN, EMILY] }), [OWN, EMILY])).rejects.toThrow(
      /no proposals for/,
    );
  });

  it("an empty roster resolves to an empty record without a round trip", async () => {
    const client = server();
    const res = await loadActivity(client, []);
    expect(res.items).toEqual([]);
    expect(client.sentBatches).toHaveLength(0);
  });
});
