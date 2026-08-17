import { describe, expect, it } from "vitest";
import { MethodRegistry, MethodError } from "@bullmoose/jmap-core";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { mintToken } from "@bullmoose/auth-core";
import { verifyBearer } from "@bullmoose/auth-core/principal";
import { registerAgentMethods } from "./agent";
import type { RequestContext } from "./common";

/**
 * s11 T8 — the fleet host's AUTHORITY leg, proven against the real method.
 *
 * The design (jobs-and-facets.md §4): one daemon logs in ONCE as a runtime
 * principal; each agent account GRANTS that principal claim authority via the
 * existing cross-account grant machinery. This suite is the test written FIRST
 * to verify that machinery already carries the claim path end to end:
 *
 *   grants row → verifyBearer (resolution) → authorizeAccount (decision)
 *   → AgentInvocation/set claim (the guarded UPDATE)
 *
 * No mocked authorization anywhere: the principal is resolved from a REAL
 * minted token over the live control-plane schema, and the claim runs through
 * the registered method. What the claim demands (read the method): the `draft`
 * scope in the `mail` domain — so the grant must be whole-account
 * (collection = NULL; an AddressBook grant covers only `contacts`) with scopes
 * whose token ∩ grant intersection satisfies `draft` (`mail` bundles it).
 *
 * One structural precondition, worth naming for provisioning: the runtime
 * principal must OWN at least one account (the grantee_account_id), because
 * grant resolution in verifyBearer hangs off the principal's owned accounts.
 * `alpaca-daemon` is a real (if empty) account, not a bare login.
 */

const TENANT = "t_bm";
const DAEMON = "a_daemon"; // the fleet host's own (empty) account
const HERMES = "a_hermes"; // agent account 1 — grants the daemon claim
const ALLEN = "a_allen"; //  agent account 2 — does NOT (until a test says so)

interface SetResult {
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string }>;
}

async function harness() {
  const w = fakeEnv();
  const registry = new MethodRegistry<RequestContext>();
  registerAgentMethods(registry);

  w.db
    .seedAccount({
      accountId: DAEMON,
      principalId: "p_daemon",
      loginEmail: "alpaca-daemon@bullmoose.cc",
    })
    .seedAccount({ accountId: HERMES, principalId: "p_hermes" })
    .seedAccount({ accountId: ALLEN, principalId: "p_allen" });

  // The runtime principal's ONE login: a real minted bearer token. `mail`
  // bundles draft; the `agent` marker rides along as it would in production
  // (it narrows contact writes, never widens anything).
  const minted = await mintToken();
  w.db.seed("tokens", [
    {
      id: minted.id,
      principal_id: "p_daemon",
      kind: "bearer",
      secret_hash: minted.secretHash,
      name: "alpaca-daemon",
      scopes: JSON.stringify(["mail", "agent"]),
      created_at: 1,
    },
  ]);

  // hermes GRANTS the daemon claim authority: whole-account, mail scopes.
  // allen grants a DIFFERENT runtime (a_other) — so "ungranted" below means
  // "a claim grant on the target exists, just not for YOU". Without this row
  // the ungranted-cannot test passes trivially even under a grantee-confusion
  // bug (any-grant-resolves-for-anyone), which the mutation check caught.
  w.db.seedAccount({ accountId: "a_other", principalId: "p_other" });
  w.db.seed("grants", [
    {
      id: "g_hermes",
      tenant_id: TENANT,
      grantee_account_id: DAEMON,
      target_account_id: HERMES,
      scopes: JSON.stringify(["mail"]),
      created_by: "p_hermes",
      created_at: 1,
    },
    {
      id: "g_allen_other",
      tenant_id: TENANT,
      grantee_account_id: "a_other",
      target_account_id: ALLEN,
      scopes: JSON.stringify(["mail"]),
      created_by: "p_allen",
      created_at: 1,
    },
  ]);

  // A pending invocation on each agent account.
  for (const [account, binding, inv] of [
    [HERMES, "hermes-responder", "inv_hermes"],
    [ALLEN, "allen-analyst", "inv_allen"],
  ] as const) {
    w.db.seed("agent_bindings", [{ id: `bind_${binding}`, account_id: account, name: binding }]);
    w.db.seed("emails", [
      {
        id: `e_${account}`,
        account_id: account,
        blob_id: "b1",
        thread_id: "t1",
        size: 10,
        received_at: 1,
      },
    ]);
    w.db.seed("agent_invocations", [
      {
        id: inv,
        account_id: account,
        binding_id: `bind_${binding}`,
        binding_name: binding,
        status: "pending",
        email_id: `e_${account}`,
        created_at: 1,
      },
    ]);
  }

  // Resolve the principal EXACTLY as every daemon request does — through the
  // token, not a hand-built fixture. Re-resolving after a grants change is the
  // revocation-propagation mechanism itself, so tests call this again freely.
  const resolve = async () => {
    const principal = await verifyBearer(w.env.DB, minted.token);
    if (!principal) throw new Error("token failed to resolve — fixture bug");
    return principal;
  };

  const call = async <T = Record<string, unknown>>(method: string, args: Record<string, unknown>): Promise<T> => {
    const ctx: RequestContext = { env: w.env, principal: await resolve() };
    return registry.get(method)!(args, ctx) as Promise<T>;
  };
  const claim = (account: string, invId: string) =>
    call<SetResult>("AgentInvocation/set", {
      accountId: account,
      update: { [invId]: { status: "running" } },
    });

  return { w, call, claim, resolve };
}

const status = (w: FakeWorker, account: string, invId: string): string =>
  w.db.query<{ status: string }>(
    "SELECT status FROM agent_invocations WHERE account_id = ? AND id = ?",
    account,
    invId,
  )[0]!.status;

// ---- the core security pair -----------------------------------------------

describe("fleet host authority: granted-can-claim / ungranted-cannot", () => {
  it("a granted runtime principal claims on the target account (pending → running)", async () => {
    const h = await harness();

    // Discovery half: the resolved principal SEES the granted account…
    const principal = await h.resolve();
    expect(principal.accounts.map((a) => a.accountId)).toContain(HERMES);

    // …its query surface lists the pending work…
    const q = await h.call<{ ids: string[] }>("AgentInvocation/query", {
      accountId: HERMES,
      status: "pending",
    });
    expect(q.ids).toContain("inv_hermes");

    // …and the claim lands through the guarded UPDATE.
    const res = await h.claim(HERMES, "inv_hermes");
    expect(res.updated).toHaveProperty("inv_hermes");
    expect(status(h.w, HERMES, "inv_hermes")).toBe("running");

    // The grant leaves its audit trail — cross-account claims are visible.
    const audit = h.w.db.query<{ grant_id: string; method: string }>(
      "SELECT grant_id, method FROM grant_audit WHERE account_id = ?",
      HERMES,
    );
    expect(audit.some((a) => a.grant_id === "g_hermes" && a.method === "mail:draft")).toBe(true);
  });

  it("the SAME principal cannot claim on an account that granted it nothing", async () => {
    const h = await harness();
    await expect(h.claim(ALLEN, "inv_allen")).rejects.toMatchObject({ type: "accountNotFound" });
    expect(status(h.w, ALLEN, "inv_allen")).toBe("pending");
    expect(h.w.db.count("grant_audit", "account_id = ?", ALLEN)).toBe(0);
  });

  it("a grant whose scopes lack draft cannot claim (token ∩ grant bites)", async () => {
    const h = await harness();
    h.w.db.seed("grants", [
      {
        id: "g_allen_ro",
        tenant_id: TENANT,
        grantee_account_id: DAEMON,
        target_account_id: ALLEN,
        scopes: JSON.stringify(["read"]),
        created_by: "p_allen",
        created_at: 1,
      },
    ]);
    // read-only grant: the queue is VISIBLE (discovery works)…
    const q = await h.call<{ ids: string[] }>("AgentInvocation/query", {
      accountId: ALLEN,
      status: "pending",
    });
    expect(q.ids).toContain("inv_allen");
    // …but the claim is refused: AgentInvocation/set demands `draft`.
    await expect(h.claim(ALLEN, "inv_allen")).rejects.toMatchObject({ type: "forbidden" });
    expect(status(h.w, ALLEN, "inv_allen")).toBe("pending");
  });

  it("a collection-scoped (AddressBook) grant does not unlock the mail-domain claim", async () => {
    const h = await harness();
    h.w.db.seed("grants", [
      {
        id: "g_allen_book",
        tenant_id: TENANT,
        grantee_account_id: DAEMON,
        target_account_id: ALLEN,
        scopes: JSON.stringify(["mail", "contacts"]),
        collection: "AddressBook",
        collection_id: "ab_1",
        created_by: "p_allen",
        created_at: 1,
      },
    ]);
    await expect(h.claim(ALLEN, "inv_allen")).rejects.toMatchObject({ type: "forbidden" });
    expect(status(h.w, ALLEN, "inv_allen")).toBe("pending");
  });
});

// ---- revocation is live ----------------------------------------------------

describe("fleet host authority: revoking the grant stops claims, no restart", () => {
  it("a tombstoned grant stops resolving on the very next request", async () => {
    const h = await harness();

    // Sanity: claims work while the grant is live.
    const res = await h.claim(HERMES, "inv_hermes");
    expect(res.updated).toHaveProperty("inv_hermes");

    // hermes revokes. The daemon process does NOT restart — every request
    // re-resolves the token, and verifyBearer filters `revoked_at IS NULL`.
    h.w.db.query("UPDATE grants SET revoked_at = ? WHERE id = ?", Date.now(), "g_hermes");

    const principal = await h.resolve();
    expect(principal.accounts.map((a) => a.accountId)).not.toContain(HERMES);

    // Seed a second pending invocation; the post-revocation claim must fail.
    h.w.db.seed("agent_invocations", [
      {
        id: "inv_hermes2",
        account_id: HERMES,
        binding_id: "bind_hermes-responder",
        binding_name: "hermes-responder",
        status: "pending",
        email_id: `e_${HERMES}`,
        created_at: 2,
      },
    ]);
    await expect(h.claim(HERMES, "inv_hermes2")).rejects.toMatchObject({ type: "accountNotFound" });
    expect(status(h.w, HERMES, "inv_hermes2")).toBe("pending");
  });
});

// ---- the error is the transport contract the daemon drops accounts on ------

describe("fleet host authority: refusal shapes the daemon relies on", () => {
  it("accountNotFound and forbidden are MethodErrors (→ JMAP error types on the wire)", async () => {
    const h = await harness();
    const err = await h.claim(ALLEN, "inv_allen").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MethodError);
    // The CLI daemon (packages/cli/src/agent.ts isAuthzRefusal) drops a served
    // account when it sees these two types; renaming them breaks live
    // revocation in the fleet host, so the names are load-bearing.
    expect((err as MethodError).type).toBe("accountNotFound");
  });
});
