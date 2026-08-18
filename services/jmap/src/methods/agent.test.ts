import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerAgentMethods } from "./agent";
import type { RequestContext } from "./common";

/**
 * AgentInvocation/set create + destroy — the sVOL 007 on-demand trigger.
 *
 * Harness is @bullmoose/test-fakes (real node:sqlite on the live schema, real
 * AccountDO). The load-bearing assertion is the CHOREOGRAPHY one: a create that
 * lands the row but skips commitChanges reads back fine on a direct /get and is
 * invisible to /changes — the exact class of bug (`_context.md` §3) a direct get
 * cannot catch. So the create test asks AgentInvocation/changes what happened.
 *
 * The interlock (008 kill switch) gets its own test: a disabled binding must be
 * refused AND must leave no pending row, because a queued invocation nobody will
 * ever drain is worse than a rejection (done-when #3).
 */

const ACCOUNT = "a_eric";
const ACCOUNT2 = "a_allen";
const TENANT = "t_bm";
const EMAIL = "e_ctx";

interface SetResult {
  oldState: string;
  newState: string;
  created: Record<string, Record<string, unknown>>;
  notCreated: Record<string, { type: string; description?: string; properties?: string[] }>;
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string; properties?: string[] }>;
  destroyed: string[];
  notDestroyed: Record<string, { type: string; description?: string; properties?: string[] }>;
}

function harness(scopes: string[] = ["read", "draft"]) {
  const w = fakeEnv();
  const registry = new MethodRegistry<RequestContext>();
  registerAgentMethods(registry);

  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "eric@login.example",
      scopes,
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
  };

  // enabled defaults to 1, trigger_on/config_json to their column defaults, so
  // a fixture is just the identity of the binding.
  w.db.seed("agent_bindings", [
    { id: "bind_emily", account_id: ACCOUNT, name: "emily" },
    { id: "bind_off", account_id: ACCOUNT, name: "off", enabled: 0 },
    { id: "bind_allen", account_id: ACCOUNT2, name: "allen" }, // another account
  ]);
  // A message to act on — the create validates it exists.
  w.db.seed("emails", [{ id: EMAIL, account_id: ACCOUNT, blob_id: "b1", thread_id: "t1", size: 10, received_at: 1 }]);

  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!(args, ctx) as Promise<T>;
  const set = (args: Record<string, unknown>, account = ACCOUNT) =>
    call<SetResult>("AgentInvocation/set", { accountId: account, ...args });

  return { w, ctx, call, set };
}

// ---- create: the on-demand trigger ---------------------------------------

describe("AgentInvocation/set create lands a drainable pending row", () => {
  it("queues a pending invocation visible to /changes (choreography) and /query", async () => {
    const h = harness();
    const res = await h.set({
      create: { c: { bindingName: "emily", emailId: EMAIL, note: "take a look" } },
    });

    const inv = res.created.c!;
    expect(res.notCreated).toEqual({});
    expect(inv).toMatchObject({
      bindingId: "bind_emily",
      bindingName: "emily",
      status: "pending",
      emailId: EMAIL,
    });
    const invId = inv.id as string;

    // The load-bearing assertion: the commit reached the changelog, so an
    // incremental consumer (bullmoose agent serve over WebSocket) sees the id.
    const changes = await h.w.accountDo.changes(ACCOUNT, "AgentInvocation", "0");
    expect(changes.created).toContain(invId);

    // And it is a real pending row the runtimes' query surface returns.
    const q = await h.call<{ ids: string[] }>("AgentInvocation/query", {
      accountId: ACCOUNT,
      status: "pending",
    });
    expect(q.ids).toContain(invId);

    // The persisted row carries the human note in context and the email_id
    // column the cloud runtime hard-requires — the shape the drain selects.
    const row = h.w.db.query<{ status: string; email_id: string; context_json: string }>(
      "SELECT status, email_id, context_json FROM agent_invocations WHERE account_id = ? AND id = ?",
      ACCOUNT,
      invId,
    )[0]!;
    expect(row.status).toBe("pending");
    expect(row.email_id).toBe(EMAIL);
    expect(JSON.parse(row.context_json)).toMatchObject({ emailId: EMAIL, note: "take a look" });
    // No synthetic envelope — inventing one would mis-steer the ledger digest.
    expect(JSON.parse(row.context_json).envelopeTo).toBeUndefined();
  });

  it("resolves a binding by id as well as by name", async () => {
    const h = harness();
    const res = await h.set({ create: { c: { bindingId: "bind_emily", emailId: EMAIL } } });
    expect(res.created.c).toMatchObject({ bindingId: "bind_emily", status: "pending" });
  });
});

// ---- THE INTERLOCK: 008 kill switch --------------------------------------

describe("AgentInvocation/set create respects the 008 kill switch", () => {
  it("REFUSES a disabled binding and leaves no pending row", async () => {
    const h = harness();
    const res = await h.set({ create: { c: { bindingName: "off", emailId: EMAIL } } });

    expect(res.created).toEqual({});
    expect(res.notCreated.c!.type).toBe("forbidden");
    expect(res.notCreated.c!.description).toMatch(/disabled/);

    // A queued invocation against a disabled binding is a black hole — both
    // drain paths gate on enabled and neither cancels it. So the refusal MUST
    // write nothing: no row, and no state bump.
    expect(h.w.db.count("agent_invocations", "binding_id = ?", "bind_off")).toBe(0);
    expect(res.newState).toBe(res.oldState);
  });
});

describe("AgentInvocation/set create rejects each bad target distinguishably", () => {
  it("a binding on another account is notFound, no row", async () => {
    const h = harness();
    const res = await h.set({ create: { c: { bindingName: "allen", emailId: EMAIL } } });
    expect(res.created).toEqual({});
    expect(res.notCreated.c!.type).toBe("notFound");
    expect(h.w.db.count("agent_invocations")).toBe(0);
  });

  it("a nonexistent emailId is invalidProperties(emailId), no row", async () => {
    const h = harness();
    const res = await h.set({ create: { c: { bindingName: "emily", emailId: "e_ghost" } } });
    expect(res.created).toEqual({});
    expect(res.notCreated.c!.type).toBe("invalidProperties");
    expect(res.notCreated.c!.properties).toContain("emailId");
    expect(h.w.db.count("agent_invocations")).toBe(0);
  });

  it("no binding selector is invalidProperties", async () => {
    const h = harness();
    const res = await h.set({ create: { c: { emailId: EMAIL } } });
    expect(res.notCreated.c!.type).toBe("invalidProperties");
    expect(h.w.db.count("agent_invocations")).toBe(0);
  });
});

// ---- destroy --------------------------------------------------------------

describe("AgentInvocation/set create and the one verb that acts on no message", () => {
  // s20 T3. The emailId requirement exists because the runtime hard-required
  // email context; `compose` is dispatched ABOVE that check now (services/agent
  // index.ts), so refusing it here would refuse a verb the human pressed for a
  // reason that is no longer true. The list is deliberately tiny and everything
  // outside it keeps the hard requirement verbatim.
  it("a compose may carry no emailId, and lands a drainable row with email_id NULL", async () => {
    const h = harness();
    const res = await h.set({
      create: {
        c: { bindingName: "emily", params: { verb: "compose", person: "sergio@boards.example", intent: "ask Sergio" } },
      },
    });
    expect(res.notCreated).toEqual({});
    expect(res.created.c!.emailId).toBeNull();

    const row = h.w.db.query<{ email_id: string | null; status: string; context_json: string }>(
      `SELECT email_id, status, context_json FROM agent_invocations`,
    )[0]!;
    expect(row.email_id).toBeNull();
    expect(row.status).toBe("pending");
    // The context carries the params and NOT an emailId key it does not have.
    const context = JSON.parse(row.context_json);
    expect(context.emailId).toBeUndefined();
    expect(context.params.verb).toBe("compose");
  });

  it("a compose MAY still name background, and a fake id is still refused", async () => {
    const h = harness();
    const ok = await h.set({
      create: { c: { bindingName: "emily", emailId: EMAIL, params: { verb: "compose", person: "s@x.test" } } },
    });
    expect(ok.notCreated).toEqual({});
    expect(ok.created.c!.emailId).toBe(EMAIL);

    const bad = await h.set({
      create: { c: { bindingName: "emily", emailId: "e_ghost", params: { verb: "compose" } } },
    });
    expect(bad.notCreated.c!.type).toBe("invalidProperties");
    expect(bad.notCreated.c!.properties).toContain("emailId");
  });

  it("every OTHER verb keeps the hard requirement — including one with no params at all", async () => {
    const h = harness();
    const answer = await h.set({ create: { c: { bindingName: "emily", params: { verb: "answer" } } } });
    expect(answer.notCreated.c!.type).toBe("invalidProperties");
    expect(answer.notCreated.c!.properties).toContain("emailId");

    const bare = await h.set({ create: { c: { bindingName: "emily" } } });
    expect(bare.notCreated.c!.type).toBe("invalidProperties");

    const junk = await h.set({ create: { c: { bindingName: "emily", params: ["compose"] } } });
    expect(junk.notCreated.c!.type).toBe("invalidProperties");

    expect(h.w.db.count("agent_invocations")).toBe(0);
  });
});

describe("AgentInvocation/set destroy purges an invocation", () => {
  it("destroys a pending invocation; it leaves /get and appears in /changes", async () => {
    const h = harness();
    const made = await h.set({ create: { c: { bindingName: "emily", emailId: EMAIL } } });
    const invId = made.created.c!.id as string;
    // Capture the post-create state so the changelog cannot collapse the
    // create-then-destroy pair to nothing (filenode.test.ts's technique).
    const afterCreate = made.newState;

    const res = await h.set({ destroy: [invId] });
    expect(res.destroyed).toEqual([invId]);
    expect(res.notDestroyed).toEqual({});

    const got = await h.call<{ list: unknown[]; notFound: string[] }>("AgentInvocation/get", {
      accountId: ACCOUNT,
      ids: [invId],
    });
    expect(got.list).toEqual([]);
    expect(got.notFound).toEqual([invId]);

    const changes = await h.w.accountDo.changes(ACCOUNT, "AgentInvocation", afterCreate);
    expect(changes.destroyed).toContain(invId);
  });

  it("REFUSES to destroy a running invocation (a runtime is mid-flight)", async () => {
    const h = harness();
    h.w.db.seed("agent_invocations", [
      {
        id: "inv_run",
        account_id: ACCOUNT,
        binding_id: "bind_emily",
        binding_name: "emily",
        status: "running",
        email_id: EMAIL,
        created_at: 1,
        claimed_at: 2,
      },
    ]);
    const res = await h.set({ destroy: ["inv_run"] });
    expect(res.destroyed).toEqual([]);
    expect(res.notDestroyed.inv_run!.type).toBe("forbidden");
    // Still there — only the runtime may move it out of running.
    expect(h.w.db.count("agent_invocations", "id = ?", "inv_run")).toBe(1);
  });

  it("destroy on an unknown id is notFound", async () => {
    const h = harness();
    const res = await h.set({ destroy: ["inv_nope"] });
    expect(res.notDestroyed.inv_nope!.type).toBe("notFound");
  });
});

// ---- scope ----------------------------------------------------------------

describe("AgentInvocation/set create gates on the draft scope", () => {
  it("a read-only token cannot create (draft is not implied by read — common/027)", async () => {
    const h = harness(["read"]);
    await expect(h.set({ create: { c: { bindingName: "emily", emailId: EMAIL } } })).rejects.toThrow(
      /forbidden|draft/i,
    );
  });
});

// ---- the watchdog's alert marker (s11 T3) ---------------------------------

describe("AgentInvocation projects and filters the watchdog's alert marker", () => {
  /** Two pending rows, one of which the T3 sweep marked as stuck past due. */
  function seedAlerted(h: ReturnType<typeof harness>) {
    h.w.db.seed("agent_invocations", [
      {
        id: "inv_pin",
        account_id: ACCOUNT,
        binding_id: "bind_emily",
        binding_name: "emily",
        status: "pending",
        email_id: EMAIL,
        created_at: 1,
        due_at: 1_000,
        privacy: "pinned",
        alert_kind: "overdue-pinned",
        alert_at: 2_000,
      },
      {
        id: "inv_ok",
        account_id: ACCOUNT,
        binding_id: "bind_emily",
        binding_name: "emily",
        status: "pending",
        email_id: EMAIL,
        created_at: 2,
      },
    ]);
  }

  it("/get projects it as a typed notice (and null where none was raised)", async () => {
    const h = harness();
    seedAlerted(h);
    const got = await h.call<{ list: Array<Record<string, unknown>> }>("AgentInvocation/get", {
      accountId: ACCOUNT,
      ids: ["inv_pin", "inv_ok"],
    });
    const byId = new Map(got.list.map((r) => [r.id as string, r]));
    expect(byId.get("inv_pin")!.alert).toEqual({
      kind: "overdue-pinned",
      at: new Date(2_000).toISOString(),
    });
    // The DefaultCase stays null — an unmarked invocation reads exactly as before.
    expect(byId.get("inv_ok")!.alert).toBeNull();
  });

  it("/query narrows to alerted rows — 'silently' is what the invariant forbids, so this must be findable", async () => {
    const h = harness();
    seedAlerted(h);
    const all = await h.call<{ ids: string[] }>("AgentInvocation/query", { accountId: ACCOUNT });
    expect(all.ids.sort()).toEqual(["inv_ok", "inv_pin"]);

    const alerted = await h.call<{ ids: string[] }>("AgentInvocation/query", {
      accountId: ACCOUNT,
      alerted: true,
    });
    expect(alerted.ids).toEqual(["inv_pin"]);
  });
});
