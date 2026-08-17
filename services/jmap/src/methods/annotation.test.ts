import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerAnnotationMethods } from "./annotation";
import type { RequestContext } from "./common";

// s18 A1 — the Annotation substrate. An Annotation is a CLAIM about a message
// you adjudicate. The load-bearing rules: every annotation is anchored (an
// un-anchored claim is refused — the anti-Clippy invariant), and a correction
// MOVES the status (resolve | dismiss) but never rewrites the claim, so "the
// agent was wrong" survives as a record and as training data.

const ACCOUNT = "a_eric";
const TENANT = "t_bm";
const ANCHOR = { realm: "Email", objectId: "e_1", span: [0, 12] };

function harness(opts: { scopes?: string[]; agent?: { binding?: string; invocation?: string } } = {}) {
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: ACCOUNT,
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: "eric@bullmoose.cc",
    displayName: "Eric",
  });
  const registry = new MethodRegistry<RequestContext>();
  registerAnnotationMethods(registry);
  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "eric@bullmoose.cc",
      scopes: opts.scopes ?? ["mail"],
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
    ...(opts.agent ? { agent: opts.agent } : {}),
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

const commitment = (over: Record<string, unknown> = {}) => ({
  anchor: ANCHOR,
  class: "commitment",
  body: "You told Bob you'd send the load calc by Friday",
  ...over,
});

describe("Annotation/set — file a claim", () => {
  it("files a human annotation (no confidence) and Annotation/get lists it open", async () => {
    const h = harness();
    const res = await h.call<SetResult>("Annotation/set", { create: { c1: commitment() } });
    const id = res.created.c1!.id;
    expect(id).toMatch(/^an_/);
    expect(res.created.c1!.status).toBe("open");

    const got = await h.call<{ list: Array<Record<string, unknown>> }>("Annotation/get", {
      ids: null,
    });
    expect(got.list).toHaveLength(1);
    const a = got.list[0]!;
    expect(a.authorKind).toBe("human");
    expect(a.author).toBe("eric@bullmoose.cc");
    expect(a.class).toBe("commitment");
    expect(a.status).toBe("open");
    expect(a.confidence).toBeNull(); // a human files at no stated confidence
    expect(a.anchor).toEqual(ANCHOR);
  });

  it("an AGENT extraction is authored by its binding and may carry a confidence", async () => {
    const h = harness({ agent: { binding: "emily", invocation: "inv_x" } });
    const res = await h.call<SetResult>("Annotation/set", {
      create: { e: commitment({ confidence: 0.8, rationale: "‘I’ll get it to you Friday’" }) },
    });
    const got = await h.call<{ list: Array<Record<string, unknown>> }>("Annotation/get", {
      ids: [res.created.e!.id],
    });
    const a = got.list[0]!;
    expect(a.authorKind).toBe("agent");
    expect(a.author).toBe("emily");
    expect(a.confidence).toBe(0.8);
    expect(a.rationale).toBe("‘I’ll get it to you Friday’");
  });

  it("REFUSES an un-anchored claim — no comment without an object", async () => {
    const h = harness();
    const res = await h.call<SetResult>("Annotation/set", {
      create: { bad: commitment({ anchor: undefined }) },
    });
    expect(res.notCreated.bad?.description).toMatch(/anchor .* is required/);
    expect(Object.keys(res.created)).toEqual([]);
  });

  it("REFUSES an unknown class and an empty body", async () => {
    const h = harness();
    const res = await h.call<SetResult>("Annotation/set", {
      create: {
        badClass: commitment({ class: "vibe" }),
        badBody: commitment({ body: "   " }),
      },
    });
    expect(res.notCreated.badClass?.description).toMatch(/class must be/);
    expect(res.notCreated.badBody?.description).toMatch(/body .* is required/);
  });

  it("requires a write scope — a read-only token cannot file one", async () => {
    const h = harness({ scopes: ["read"] });
    await expect(h.call("Annotation/set", { create: { x: commitment() } })).rejects.toThrow();
  });
});

describe("Annotation/set — close forward, and what a client may NOT do", () => {
  const fileOne = async (h: ReturnType<typeof harness>) =>
    (await h.call<SetResult>("Annotation/set", { create: { a: commitment() } })).created.a!.id;

  it("resolves an open annotation (it came true)", async () => {
    const h = harness();
    const id = await fileOne(h);
    const res = await h.call<SetResult>("Annotation/set", {
      update: { [id]: { status: "resolved" } },
    });
    expect(res.updated).toHaveProperty(id);
    expect(h.w.db.query<{ status: string }>(`SELECT status FROM annotations WHERE id = '${id}'`)[0]!.status).toBe(
      "resolved",
    );
  });

  it("dismisses an open annotation — the labeled negative", async () => {
    const h = harness();
    const id = await fileOne(h);
    const res = await h.call<SetResult>("Annotation/set", {
      update: { [id]: { status: "dismissed" } },
    });
    expect(res.updated).toHaveProperty(id);
    expect(h.w.db.query<{ status: string }>(`SELECT status FROM annotations WHERE id = '${id}'`)[0]!.status).toBe(
      "dismissed",
    );
  });

  it("REFUSES to rewrite the claim — the body is immutable, you move status", async () => {
    const h = harness();
    const id = await fileOne(h);
    const res = await h.call<SetResult>("Annotation/set", {
      update: { [id]: { body: "actually, never mind" } },
    });
    expect(res.notUpdated[id]?.description).toMatch(/immutable/);
    expect(h.w.db.query<{ body: string }>(`SELECT body FROM annotations WHERE id = '${id}'`)[0]!.body).toMatch(
      /load calc/,
    );
  });

  it("REFUSES an unknown status, and re-deciding a closed one", async () => {
    const h = harness();
    const id = await fileOne(h);
    const bad = await h.call<SetResult>("Annotation/set", {
      update: { [id]: { status: "maybe" } },
    });
    expect(bad.notUpdated[id]?.description).toMatch(/status must be/);

    await h.call<SetResult>("Annotation/set", { update: { [id]: { status: "resolved" } } });
    const again = await h.call<SetResult>("Annotation/set", {
      update: { [id]: { status: "dismissed" } },
    });
    expect(again.notUpdated[id]?.description).toMatch(/no open annotation/);
    expect(h.w.db.query<{ status: string }>(`SELECT status FROM annotations WHERE id = '${id}'`)[0]!.status).toBe(
      "resolved",
    );
  });
});

describe("Annotation/query — the live claims, filterable", () => {
  it("defaults to open; a terminal status is asked for explicitly", async () => {
    const h = harness();
    const a = (await h.call<SetResult>("Annotation/set", { create: { a: commitment() } })).created.a!.id;
    const b = (await h.call<SetResult>("Annotation/set", { create: { b: commitment() } })).created.b!.id;
    await h.call<SetResult>("Annotation/set", { update: { [b]: { status: "dismissed" } } });

    const open = await h.call<{ ids: string[] }>("Annotation/query", {});
    expect(open.ids).toEqual([a]);
    const dismissed = await h.call<{ ids: string[] }>("Annotation/query", {
      filter: { status: "dismissed" },
    });
    expect(dismissed.ids).toEqual([b]);
  });

  it("filters by class and by anchored objectId", async () => {
    const h = harness();
    const c = (
      await h.call<SetResult>("Annotation/set", {
        create: { c: commitment({ class: "commitment" }) },
      })
    ).created.c!.id;
    await h.call<SetResult>("Annotation/set", {
      create: { t: commitment({ class: "task", anchor: { realm: "Email", objectId: "e_2" } }) },
    });

    const commitments = await h.call<{ ids: string[] }>("Annotation/query", {
      filter: { class: "commitment" },
    });
    expect(commitments.ids).toEqual([c]);

    const onE1 = await h.call<{ ids: string[] }>("Annotation/query", {
      filter: { objectId: "e_1" },
    });
    expect(onE1.ids).toEqual([c]);
  });
});
