import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerWatchMethods } from "./watch";
import type { RequestContext } from "./common";

// s20 T1 — the ARM/CANCEL surface. The cron fires watches; this creates and
// cancels them. The load-bearing refusals: a client cannot write status
// 'fired' (only the cron may), and cancel is armed-only (you cannot un-ring a
// bell that already produced its proposal).

const ACCOUNT = "a_eric";
const TENANT = "t_bm";

function harness(scopes: string[] = ["mail"]) {
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: ACCOUNT,
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: "eric@bullmoose.cc",
    displayName: "Eric",
  });
  const registry = new MethodRegistry<RequestContext>();
  registerWatchMethods(registry);
  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "eric@bullmoose.cc",
      scopes,
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
  };
  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!({ accountId: ACCOUNT, ...args }, ctx) as Promise<T>;
  return { w, call };
}

interface SetResult {
  created: Record<string, { id: string; status: string }>;
  notCreated: Record<string, { type: string; description?: string }>;
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string }>;
}

describe("Watch/set — arm", () => {
  it("arms a deadline watch and Watch/get lists it", async () => {
    const h = harness();
    const res = await h.call<SetResult>("Watch/set", {
      create: { new1: { conditionType: "deadline", deadlineAt: 999, actionType: "notify" } },
    });
    const id = res.created.new1!.id;
    expect(id).toMatch(/^w_/);
    expect(res.created.new1!.status).toBe("armed");

    const got = await h.call<{ list: Array<{ id: string; status: string; deadlineAt: number }> }>("Watch/get", {
      ids: null,
    });
    expect(got.list).toHaveLength(1);
    expect(got.list[0]!.status).toBe("armed");
    expect(got.list[0]!.deadlineAt).toBe(999);
  });

  it("refuses a no-reply-from watch with no sender to wait on", async () => {
    const h = harness();
    const res = await h.call<SetResult>("Watch/set", {
      create: {
        bad: {
          conditionType: "no-reply-from",
          deadlineAt: 999,
          actionType: "draft-followup",
          condition: {},
        },
      },
    });
    expect(res.notCreated.bad?.description).toMatch(/needs condition.sender/);
    expect(Object.keys(res.created)).toEqual([]);
  });

  it("refuses unknown condition and action types", async () => {
    const h = harness();
    const res = await h.call<SetResult>("Watch/set", {
      create: {
        badCond: { conditionType: "telepathy", deadlineAt: 999, actionType: "notify" },
        badAct: { conditionType: "deadline", deadlineAt: 999, actionType: "launch-missiles" },
      },
    });
    expect(res.notCreated.badCond?.description).toMatch(/unknown conditionType/);
    expect(res.notCreated.badAct?.description).toMatch(/unknown actionType/);
  });

  it("requires a write scope — a read-only token cannot arm a watch", async () => {
    const h = harness(["read"]);
    await expect(
      h.call("Watch/set", {
        create: { x: { conditionType: "deadline", deadlineAt: 9, actionType: "notify" } },
      }),
    ).rejects.toThrow();
  });
});

describe("Watch/set — cancel, and what a client may NOT do", () => {
  const armOne = async (h: ReturnType<typeof harness>) => {
    const r = await h.call<SetResult>("Watch/set", {
      create: { a: { conditionType: "deadline", deadlineAt: 999, actionType: "notify" } },
    });
    return r.created.a!.id;
  };

  it("cancels an armed watch", async () => {
    const h = harness();
    const id = await armOne(h);
    const res = await h.call<SetResult>("Watch/set", { update: { [id]: { status: "cancelled" } } });
    expect(res.updated).toHaveProperty(id);
    expect(h.w.db.query<{ status: string }>(`SELECT status FROM watches WHERE id = '${id}'`)[0]!.status).toBe(
      "cancelled",
    );
  });

  it("REFUSES to write status 'fired' — only the cron may fire", async () => {
    const h = harness();
    const id = await armOne(h);
    const res = await h.call<SetResult>("Watch/set", { update: { [id]: { status: "fired" } } });
    expect(res.notUpdated[id]?.description).toMatch(/firing is the cron/);
    expect(h.w.db.query<{ status: string }>(`SELECT status FROM watches WHERE id = '${id}'`)[0]!.status).toBe("armed");
  });

  it("REFUSES to cancel a watch that already fired — no un-ringing the bell", async () => {
    const h = harness();
    const id = await armOne(h);
    h.w.db.query(`UPDATE watches SET status = 'fired' WHERE id = '${id}'`);
    const res = await h.call<SetResult>("Watch/set", { update: { [id]: { status: "cancelled" } } });
    expect(res.notUpdated[id]?.description).toMatch(/no armed watch/);
  });
});

describe("Watch/query — the roster is what you're waiting on", () => {
  it("defaults to armed only; a terminal status is asked for explicitly", async () => {
    const h = harness();
    const a = (
      await h.call<SetResult>("Watch/set", {
        create: { a: { conditionType: "deadline", deadlineAt: 1, actionType: "notify" } },
      })
    ).created.a!.id;
    const b = (
      await h.call<SetResult>("Watch/set", {
        create: { b: { conditionType: "deadline", deadlineAt: 2, actionType: "notify" } },
      })
    ).created.b!.id;
    h.w.db.query(`UPDATE watches SET status = 'fired' WHERE id = '${b}'`);

    const armed = await h.call<{ ids: string[] }>("Watch/query", {});
    expect(armed.ids).toEqual([a]);

    const fired = await h.call<{ ids: string[] }>("Watch/query", { filter: { status: "fired" } });
    expect(fired.ids).toEqual([b]);
  });
});
