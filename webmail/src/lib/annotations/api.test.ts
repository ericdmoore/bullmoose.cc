import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { loadAnnotations } from "./api";

// s18 A4 — loadAnnotations batches query→get across accounts (loadQueues'
// shape). The properties that matter: it merges every account, threads the
// request account in as the row's fallback accountId, and — unlike the queue —
// a refused account is collected, never thrown, because a home glance must not
// take the page down.

function row(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    authorKind: "agent",
    author: "scribe",
    anchor: { realm: "Email", objectId: `e_${id}` },
    class: "commitment",
    body: `claim ${id}`,
    confidence: 0.7,
    status: "open",
    rationale: null,
    sourceRef: `e_${id}`,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

/** A fake that serves per-account annotation rows, or refuses named accounts. */
function fake(byAccount: Record<string, Record<string, unknown>[]>, refuse: Set<string> = new Set()) {
  const rowsFor = (acct: string) => byAccount[acct] ?? [];
  return new FakeJmapClient({
    handlers: {
      "Annotation/query": (args) => {
        const acct = args.accountId as string;
        if (refuse.has(acct)) return ["error", { type: "forbidden", description: "no grant" }];
        return { accountId: acct, queryState: "1", ids: rowsFor(acct).map((r) => r.id as string) };
      },
      "Annotation/get": (args) => {
        const acct = args.accountId as string;
        const ids = Array.isArray(args.ids) ? (args.ids as string[]) : [];
        return {
          accountId: acct,
          state: "1",
          list: rowsFor(acct).filter((r) => ids.includes(r.id as string)),
          notFound: [],
        };
      },
    },
  });
}

describe("loadAnnotations", () => {
  it("returns [] for no accounts without a round trip", async () => {
    const res = await loadAnnotations(fake({}), []);
    expect(res).toEqual({ annotations: [], failures: {} });
  });

  it("merges annotations across accounts and stamps the fallback accountId", async () => {
    const client = fake({ a1: [row("x")], a2: [row("y"), row("z")] });
    const res = await loadAnnotations(client, ["a1", "a2"]);
    expect(res.failures).toEqual({});
    expect(res.annotations.map((a) => a.id).sort()).toEqual(["x", "y", "z"]);
    // The row carries no accountId of its own; the request account fills it in.
    expect(res.annotations.find((a) => a.id === "x")!.accountId).toBe("a1");
    expect(res.annotations.find((a) => a.id === "z")!.accountId).toBe("a2");
  });

  it("collects a refused account into failures and still returns the rest — never throws", async () => {
    const client = fake({ a1: [row("x")], a2: [row("y")] }, new Set(["a2"]));
    const res = await loadAnnotations(client, ["a1", "a2"]);
    expect(res.annotations.map((a) => a.id)).toEqual(["x"]);
    expect(res.failures.a2).toMatch(/no grant/);
  });

  it("does NOT throw even when every account refuses — an empty glance, not a dead page", async () => {
    const client = fake({ a1: [row("x")] }, new Set(["a1"]));
    const res = await loadAnnotations(client, ["a1"]);
    expect(res.annotations).toEqual([]);
    expect(res.failures.a1).toBeTruthy();
  });
});
