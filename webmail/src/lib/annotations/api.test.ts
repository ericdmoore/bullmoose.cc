import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { closeAnnotation, loadAnnotations, loadMarginAnnotations } from "./api";

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

// ── s18 A3 — the margin's fetch + verbs ─────────────────────────────────────

/** A fake mirroring the server's per-status query over one account's rows. */
function marginFake(rows: Record<string, unknown>[], opts: { refuseSet?: boolean; requestLog?: number[] } = {}) {
  return new FakeJmapClient({
    handlers: {
      "Annotation/query": (args) => {
        opts.requestLog?.push(1);
        const filter = (args.filter ?? {}) as { status?: string; objectId?: string };
        const status = filter.status ?? "open";
        const ids = rows
          .filter((r) => r.status === status)
          .filter((r) => !filter.objectId || (r.anchor as { objectId?: string }).objectId === filter.objectId)
          .map((r) => r.id as string);
        return { accountId: args.accountId as string, queryState: "1", ids };
      },
      "Annotation/get": (args) => {
        const ids = Array.isArray(args.ids) ? (args.ids as string[]) : [];
        return {
          accountId: args.accountId as string,
          state: "1",
          list: rows.filter((r) => ids.includes(r.id as string)),
          notFound: [],
        };
      },
      "Annotation/set": (args) => {
        if (opts.refuseSet) return ["error", { type: "forbidden", description: "token lacks scope: annotate" }];
        const update = (args.update as Record<string, { status?: string }>) ?? {};
        const updated: Record<string, null> = {};
        const notUpdated: Record<string, unknown> = {};
        for (const [id, patch] of Object.entries(update)) {
          const r = rows.find((x) => x.id === id && x.status === "open");
          if (!r) {
            notUpdated[id] = {
              type: "invalidProperties",
              description: "no open annotation with that id (already resolved, dismissed or unknown)",
            };
            continue;
          }
          r.status = patch.status;
          updated[id] = null;
        }
        return {
          accountId: args.accountId as string,
          oldState: "1",
          newState: "2",
          created: {},
          notCreated: {},
          updated,
          notUpdated,
          destroyed: [],
          notDestroyed: {},
        };
      },
    },
  });
}

describe("loadMarginAnnotations", () => {
  it("returns [] for an empty thread without a round trip", async () => {
    const res = await loadMarginAnnotations(marginFake([]), "a1", []);
    expect(res).toEqual({ annotations: [], failure: null });
  });

  it("fetches every margin status per message — open AND the closed history", async () => {
    const rows = [
      row("open1", { anchor: { realm: "Email", objectId: "e1" } }),
      row("done", { anchor: { realm: "Email", objectId: "e1" }, status: "resolved" }),
      row("waved", { anchor: { realm: "Email", objectId: "e2" }, status: "dismissed" }),
      row("other", { anchor: { realm: "Email", objectId: "e-not-here" } }),
    ];
    const res = await loadMarginAnnotations(marginFake(rows), "a1", ["e1", "e2"]);
    expect(res.annotations.map((a) => a.id).sort()).toEqual(["done", "open1", "waved"]);
    expect(res.failure).toBeNull();
  });

  it("batches the whole thread into ONE request (the loadThread discipline)", async () => {
    const requestLog: number[] = [];
    const client = marginFake([row("x", { anchor: { realm: "Email", objectId: "e1" } })], { requestLog });
    const request = client.request.bind(client);
    let posts = 0;
    client.request = (calls, o) => {
      posts += 1;
      return request(calls, o);
    };
    await loadMarginAnnotations(client, "a1", ["e1", "e2", "e3"]);
    expect(posts).toBe(1);
    expect(requestLog.length).toBe(9); // 3 messages × 3 statuses, each query answered
  });
});

describe("closeAnnotation", () => {
  it("resolves an open claim in one status write", async () => {
    const rows = [row("a", {})];
    const res = await closeAnnotation(marginFake(rows), "a1", "a", "resolved");
    expect(res).toEqual({ ok: true });
    expect(rows[0]!.status).toBe("resolved");
  });

  it("a forbidden refusal names the missing verb and flags forbidden — the caller greys the verbs", async () => {
    const res = await closeAnnotation(marginFake([row("a")], { refuseSet: true }), "a1", "a", "dismissed");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.forbidden).toBe(true);
      expect(res.message).toContain("annotate");
    }
  });

  it("a per-id refusal (already closed) surfaces the server's sentence, not forbidden", async () => {
    const rows = [row("a", { status: "dismissed" })];
    const res = await closeAnnotation(marginFake(rows), "a1", "a", "resolved");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.forbidden).toBe(false);
      expect(res.message).toContain("already resolved, dismissed or unknown");
    }
  });
});
