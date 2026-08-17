import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fakeD1, fakeKV, type FakeD1, type FakeKV } from "@bullmoose/test-fakes";
import { mintToken } from "@bullmoose/auth-core";
import { verifyBearer } from "@bullmoose/auth-core/principal";
import worker from "./index";
import type { Env } from "./index";

/**
 * Admin lifecycle — update + delete (sVOL `008`), and the agent kill switch
 * (`.feedback/fromClaude/agentic/023`).
 *
 * Driven through the worker's `fetch` so the admin gate, the route table and
 * the handlers are all real. D1 is `@bullmoose/test-fakes` — real SQLite over
 * the live schema, so `REFERENCES domains(domain)`, `PRIMARY KEY (account_id,
 * id)` and the atomic `batch()` all behave as D1 behaves.
 *
 * Two assertions carry most of the weight, and both are written as the QUERY
 * THE OTHER WORKER ACTUALLY RUNS rather than as a column check:
 *
 *  - `enqueueQuery()` is `services/ingest/src/index.ts`'s binding lookup,
 *    verbatim. Asserting `enabled = 0` would pass against a kill switch that
 *    nothing honours; asserting that ingest's own SELECT returns no rows is
 *    the claim that matters.
 *  - `deleteAccount` is checked through `verifyBearer` from
 *    `@bullmoose/auth-core` — a tombstone that still authenticates is not a
 *    delete — and through the KV key, because a D1-only check passes while
 *    mail is still landing.
 */

const ADMIN_TOKEN = "admin-secret";
const DOMAIN = "bullmoose.cc";
const TENANT = "t_bm";

interface Harness {
  db: FakeD1;
  kv: FakeKV;
  env: Env;
  call: (method: string, path: string, body?: unknown) => Promise<Response>;
}

function harness(): Harness {
  const db = fakeD1();
  const kv = fakeKV();
  db.seed("tenants", [{ id: TENANT, name: "Bullmoose", status: "active", created_at: 1 }]);
  db.seed("domains", [{ domain: DOMAIN, tenant_id: TENANT, status: "active", cf_zone_id: "zone1", created_at: 1 }]);

  const env: Env = {
    DB: db,
    ROUTES: kv.ns,
    ADMIN_TOKEN,
    SES_REGION: "us-east-1",
    INGEST_WORKER_NAME: "bullmoose-ingest",
    CF_API_TOKEN: "cf",
    SES_ACCESS_KEY_ID: "ak",
    SES_SECRET_ACCESS_KEY: "sk",
  };

  const call = (method: string, path: string, body?: unknown) =>
    worker.fetch(
      new Request(`https://provision.bullmoose.cc${path}`, {
        method,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );

  return { db, kv, env, call };
}

const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;

/** Create a real account through the real route, so routes + KV are wired. */
async function makeAccount(h: Harness, localpart = "editor"): Promise<string> {
  const res = await h.call("POST", "/accounts", {
    tenantId: TENANT,
    domain: DOMAIN,
    localpart,
    displayName: localpart,
  });
  return (await body<{ accountId: string }>(res)).accountId;
}

async function makeBinding(h: Harness, email: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await h.call("POST", "/agent-bindings", { email, name: "editor", ...over });
  return (await body<{ bindingId: string }>(res)).bindingId;
}

/**
 * `services/ingest/src/index.ts` — the enqueue lookup, copied verbatim. Every
 * delivery runs this; a binding it does not return creates no invocation row,
 * which is what "the agent is off" means end to end.
 */
const enqueueQuery = (db: FakeD1, accountId: string) =>
  db.query(
    `SELECT id, name, sla_seconds FROM agent_bindings
     WHERE account_id = ? AND enabled = 1 AND trigger_on = 'mailbox-delivery'`,
    accountId,
  );

/** `services/agent/src/index.ts` — the drain lookup, same treatment. */
const drainQuery = (db: FakeD1) =>
  db.query(
    `SELECT inv.id FROM agent_invocations inv
     JOIN agent_bindings b ON b.account_id = inv.account_id AND b.id = inv.binding_id
     JOIN accounts a ON a.id = inv.account_id
     WHERE inv.status = 'pending' AND b.enabled = 1 AND a.deleted_at IS NULL`,
  );

function queueInvocation(db: FakeD1, accountId: string, bindingId: string, id = "inv_1") {
  db.seed("agent_invocations", [
    {
      id,
      account_id: accountId,
      binding_id: bindingId,
      binding_name: "editor",
      status: "pending",
      email_id: "e_1",
      context_json: "{}",
      created_at: Date.now(),
    },
  ]);
}

// ── the gate the kill switch rides on ─────────────────────────────────────

/**
 * `enqueueQuery` and `drainQuery` above are COPIES of queries that live in two
 * other workers, and a copy can drift from its original without any test
 * noticing — which would leave a green kill-switch suite over a switch that
 * does nothing.
 *
 * Driving those workers from here is not worth it (ingest needs R2, a DO and a
 * MIME parse; the agent needs a model provider), so the seam is pinned the way
 * this repo pins its other cross-file invariants: by reading the source.
 * `help.test.ts` greps `main.ts`'s switch for the same reason.
 */
describe("both drain paths still honour agent_bindings.enabled", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("ingest filters `enabled = 1` when it enqueues invocations", () => {
    const sql = source("../../ingest/src/index.ts");
    expect(sql).toContain("FROM agent_bindings");
    expect(sql).toMatch(/WHERE account_id = \? AND enabled = 1 AND trigger_on = 'mailbox-delivery'/);
  });

  it("the agent drain filters `b.enabled = 1` and skips tombstoned accounts", () => {
    const sql = source("../../agent/src/index.ts");
    expect(sql).toMatch(/inv\.status = 'pending' AND b\.enabled = 1 AND a\.deleted_at IS NULL/);
  });
});

/**
 * The outbound bound has to be VISIBLE, or the config surface renders a blank
 * where the control is (s10 T4). `GET /agent-bindings` is the only read path
 * for a binding — there is no `AgentBinding/*` JMAP collection and `/console/*`
 * is unserved — so if this projection drops `recipients_book_id`, no client can
 * answer "who may this agent email?".
 *
 * The two states are asserted separately on purpose: NULL and a book id are
 * opposite answers (NULL means CANNOT SEND), and a read that flattened them
 * into "absent" would let a client report a bound agent as unbounded.
 */
describe("GET /agent-bindings projects the outbound bound", () => {
  it("reports recipients_book_id, both when it is set and when it is NULL", async () => {
    const h = harness();
    await makeAccount(h, "editor");
    await makeAccount(h, "shooter");
    await makeBinding(h, `editor@${DOMAIN}`);
    await h.call("POST", "/agent-bindings", {
      email: `shooter@${DOMAIN}`,
      name: "photos",
      recipientsBookId: "ab_invitees",
    });

    const res = await body<{
      bindings: Array<{ name: string; recipients_book_id: string | null }>;
    }>(await h.call("GET", "/agent-bindings"));
    const byName = new Map(res.bindings.map((b) => [b.name, b]));

    // The key is PRESENT on every row — a client distinguishes "no book" from
    // "this worker does not report it" by key presence, so an omitted column
    // would read as unknown rather than as fail-closed.
    expect(byName.get("photos")).toHaveProperty("recipients_book_id", "ab_invitees");
    expect(byName.get("editor")).toHaveProperty("recipients_book_id", null);
  });
});

// ── the kill switch ───────────────────────────────────────────────────────

describe("POST /agent-bindings/{id}/disable — the agent kill switch", () => {
  it("stops ingest enqueueing: the delivery-time binding query returns nothing", async () => {
    const h = harness();
    await makeAccount(h);
    const accountId = (await body<{ accounts: Array<{ id: string }> }>(await h.call("GET", "/accounts"))).accounts[0]!
      .id;
    const bindingId = await makeBinding(h, `editor@${DOMAIN}`);

    // Armed: a delivery right now would create an invocation.
    expect(enqueueQuery(h.db, accountId)).toHaveLength(1);

    const res = await h.call("POST", `/agent-bindings/${bindingId}/disable`);
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ ok: true, bindingId, accountId, enabled: false });

    // ── THE assertion ───────────────────────────────────────────────────
    expect(enqueueQuery(h.db, accountId)).toEqual([]);
  });

  it("writes 0/1, not a JS boolean — one convention for an INTEGER column", async () => {
    const h = harness();
    await makeAccount(h);
    const bindingId = await makeBinding(h, `editor@${DOMAIN}`);

    await h.call("POST", `/agent-bindings/${bindingId}/disable`);
    expect(h.db.query<{ enabled: unknown }>(`SELECT enabled FROM agent_bindings`)[0]?.enabled).toBe(0);
    await h.call("POST", `/agent-bindings/${bindingId}/enable`);
    expect(h.db.query<{ enabled: unknown }>(`SELECT enabled FROM agent_bindings`)[0]?.enabled).toBe(1);
  });

  it("re-enabling puts it back — this is a pause, not a teardown", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    const bindingId = await makeBinding(h, `editor@${DOMAIN}`);

    await h.call("POST", `/agent-bindings/${bindingId}/disable`);
    expect(enqueueQuery(h.db, accountId)).toEqual([]);

    const res = await h.call("POST", `/agent-bindings/${bindingId}/enable`);
    expect(await body(res)).toMatchObject({ enabled: true });
    expect(enqueueQuery(h.db, accountId)).toHaveLength(1);
  });

  it("hides the binding from the agent drain too, not only from ingest", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    const bindingId = await makeBinding(h, `editor@${DOMAIN}`);
    queueInvocation(h.db, accountId, bindingId);

    expect(drainQuery(h.db)).toHaveLength(1);
    await h.call("POST", `/agent-bindings/${bindingId}/disable`);
    expect(drainQuery(h.db)).toEqual([]);
  });

  // ── the queue decision, pinned ──────────────────────────────────────────
  it("HOLDS queued invocations rather than cancelling them, and reports the count", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    const bindingId = await makeBinding(h, `editor@${DOMAIN}`);
    queueInvocation(h.db, accountId, bindingId, "inv_1");
    queueInvocation(h.db, accountId, bindingId, "inv_2");

    const res = await h.call("POST", `/agent-bindings/${bindingId}/disable`);
    expect(await body(res)).toMatchObject({
      pendingInvocations: 2,
      note: expect.stringContaining("HELD, not cancelled"),
    });

    // Still pending, still `pending` — nothing was cancelled or deleted. If a
    // later change decides to cancel on disable, this is the test to argue
    // with rather than to delete.
    expect(h.db.count("agent_invocations", "status = 'pending'")).toBe(2);

    // ...and they drain again the moment it is re-enabled.
    await h.call("POST", `/agent-bindings/${bindingId}/enable`);
    expect(drainQuery(h.db)).toHaveLength(2);
  });

  it("404s an unknown binding instead of reporting a successful no-op", async () => {
    const h = harness();
    const res = await h.call("POST", "/agent-bindings/bind_nope/disable");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("no agent binding bind_nope");
  });

  it("409s an ambiguous id rather than silently disabling one of two agents", async () => {
    const h = harness();
    await makeAccount(h, "one");
    await makeAccount(h, "two");
    const bindingId = await makeBinding(h, `one@${DOMAIN}`);
    // The same id landing on a second account — the case a bare-id route has
    // to answer for.
    const other = h.db.query<{ id: string }>(
      `SELECT id FROM accounts WHERE id NOT IN (SELECT account_id FROM agent_bindings)`,
    )[0]!.id;
    h.db.seed("agent_bindings", [
      {
        id: bindingId,
        account_id: other,
        name: "editor",
        trigger_on: "mailbox-delivery",
        enabled: 1,
        config_json: "{}",
      },
    ]);

    const res = await h.call("POST", `/agent-bindings/${bindingId}/disable`);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("?email=");
    // Nothing was disabled — a partial kill switch is worse than a refusal.
    expect(h.db.count("agent_bindings", "enabled = 1")).toBe(2);
  });

  it("?email= narrows an ambiguous id to exactly one account", async () => {
    const h = harness();
    const accountId = await makeAccount(h, "one");
    await makeAccount(h, "two");
    const bindingId = await makeBinding(h, `one@${DOMAIN}`);
    const other = h.db.query<{ id: string }>(`SELECT id FROM accounts WHERE id != ?`, accountId)[0]!.id;
    h.db.seed("agent_bindings", [
      {
        id: bindingId,
        account_id: other,
        name: "editor",
        trigger_on: "mailbox-delivery",
        enabled: 1,
        config_json: "{}",
      },
    ]);

    const res = await h.call("POST", `/agent-bindings/${bindingId}/disable?email=one@${DOMAIN}`);
    expect(res.status).toBe(200);
    expect(enqueueQuery(h.db, accountId)).toEqual([]);
    expect(enqueueQuery(h.db, other)).toHaveLength(1);
  });
});

describe("DELETE /agent-bindings/{id}", () => {
  it("refuses while invocations are queued — deleting would strand them", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    const bindingId = await makeBinding(h, `editor@${DOMAIN}`);
    queueInvocation(h.db, accountId, bindingId);

    const res = await h.call("DELETE", `/agent-bindings/${bindingId}`);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("disable");
    expect(h.db.count("agent_bindings")).toBe(1);
  });

  it("refuses to ENABLE a binding whose account is deleted, rather than promising a drain", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    const bindingId = await makeBinding(h, `editor@${DOMAIN}`);
    await h.call("DELETE", `/accounts/${accountId}`);

    const res = await h.call("POST", `/agent-bindings/${bindingId}/enable`);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("skips tombstoned accounts");
    // Still off — a refused enable must not half-apply.
    expect(h.db.query<{ enabled: number }>(`SELECT enabled FROM agent_bindings`)[0]?.enabled).toBe(0);
  });

  it("stays addressable by --account after its account is deleted, so cleanup is possible", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    const bindingId = await makeBinding(h, `editor@${DOMAIN}`);
    await h.call("DELETE", `/accounts/${accountId}`);

    // `?email=` is the documented disambiguator; 404ing here would make an
    // ambiguous binding id unremovable exactly when you are cleaning up.
    const res = await h.call("DELETE", `/agent-bindings/${bindingId}?email=editor@${DOMAIN}`);
    expect(res.status).toBe(200);
    expect(h.db.count("agent_bindings")).toBe(0);
  });

  it("drops the watchdog responder with the binding it backs", async () => {
    const h = harness();
    await makeAccount(h);
    const bindingId = await makeBinding(h, `editor@${DOMAIN}`, { slaSeconds: 900 });
    // createAgentBinding arms `watchdog_{id}`; left behind it tells senders the
    // agent is "temporarily unavailable" forever.
    expect(h.db.count("responders", "id = ?", `watchdog_${bindingId}`)).toBe(1);

    const res = await h.call("DELETE", `/agent-bindings/${bindingId}`);
    expect(res.status).toBe(200);
    expect(h.db.count("agent_bindings")).toBe(0);
    expect(h.db.count("responders")).toBe(0);
  });
});

// ── tier 1: reversible ────────────────────────────────────────────────────

describe("PATCH — rename, the fix for a typo that used to be permanent", () => {
  it("renames a tenant, which `INSERT OR IGNORE` made impossible", async () => {
    const h = harness();
    // The old workaround, showing why the route is needed: re-POSTing no-ops.
    await h.call("POST", "/tenants", { tenantId: TENANT, name: "Corrected" });
    expect(h.db.query<{ name: string }>(`SELECT name FROM tenants`)[0]?.name).toBe("Bullmoose");

    const res = await h.call("PATCH", `/tenants/${TENANT}`, { name: "Corrected" });
    expect(res.status).toBe(200);
    expect(h.db.query<{ name: string }>(`SELECT name FROM tenants`)[0]?.name).toBe("Corrected");
  });

  it("404s a rename of a tenant that is not there", async () => {
    const h = harness();
    expect((await h.call("PATCH", "/tenants/t_ghost", { name: "x" })).status).toBe(404);
  });

  it("renames an account", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    expect((await h.call("PATCH", `/accounts/${accountId}`, { displayName: "Editor" })).status).toBe(200);
    expect(h.db.query<{ display_name: string }>(`SELECT display_name FROM accounts`)[0]?.display_name).toBe("Editor");
  });

  it("rejects a status outside the allow-list rather than writing the body through", async () => {
    const h = harness();
    const res = await h.call("PATCH", `/domains/${DOMAIN}`, { status: "pending_ses" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("active, suspended");
  });

  it("answers a missing or malformed body with 400, not a 500 carrying a SyntaxError", async () => {
    const h = harness();
    // `request.json()` throws on both, and an unguarded throw lands in the
    // catch at the top of `fetch` — a server error for a client mistake, and
    // one an operator's monitoring pages on.
    for (const raw of [undefined, "{not json"]) {
      const res = await worker.fetch(
        new Request(`https://provision.bullmoose.cc/tenants/${TENANT}`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
          ...(raw === undefined ? {} : { body: raw }),
        }),
        h.env,
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("name required");
    }
  });
});

describe("PATCH /domains — suspend stops mail, resume puts it back", () => {
  it("suspending removes the ingest key, so delivery resolves to nothing", async () => {
    const h = harness();
    await makeAccount(h);
    expect(h.kv.store.has(`route:${DOMAIN}:editor`)).toBe(true);

    const res = await h.call("PATCH", `/domains/${DOMAIN}`, { status: "suspended" });
    expect(res.status).toBe(200);
    // The status column alone is cosmetic — nothing in the tree reads it — so
    // this, not the column, is what makes "suspended" true.
    expect(h.kv.store.has(`route:${DOMAIN}:editor`)).toBe(false);
    expect(h.db.query<{ status: string }>(`SELECT status FROM domains`)[0]?.status).toBe("suspended");
  });

  it("resume restores forwardTo, which lives ONLY in KV and cannot be rebuilt from D1", async () => {
    const h = harness();
    await makeAccount(h);
    // deliver-and-forward: read by ingest, written by nothing in this worker.
    await h.kv.ns.put(
      `route:${DOMAIN}:editor`,
      JSON.stringify({
        kind: "mailbox",
        accountId: (await body<{ accounts: Array<{ id: string }> }>(await h.call("GET", "/accounts"))).accounts[0]!.id,
        tenantId: TENANT,
        forwardTo: ["editor@gmail.test"],
      }),
    );

    await h.call("PATCH", `/domains/${DOMAIN}`, { status: "suspended" });
    await h.call("PATCH", `/domains/${DOMAIN}`, { status: "active" });

    const restored = JSON.parse(h.kv.store.get(`route:${DOMAIN}:editor`)!.value) as {
      forwardTo?: string[];
    };
    expect(restored.forwardTo).toEqual(["editor@gmail.test"]);
    // And the parked copy is cleaned up, not left to resurrect later.
    expect([...h.kv.store.keys()].filter((k) => k.startsWith("suspended-"))).toEqual([]);
  });

  it("refuses to provision onto a suspended domain, rather than re-arming one address", async () => {
    const h = harness();
    await h.call("PATCH", `/domains/${DOMAIN}`, { status: "suspended" });

    const res = await h.call("POST", "/accounts", {
      tenantId: TENANT,
      domain: DOMAIN,
      localpart: "sneaky",
      displayName: "Sneaky",
    });
    // Otherwise POST /accounts writes a LIVE route key on a domain whose other
    // keys are parked — a partial suspension with no read path that shows it.
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("suspended");
    expect(h.kv.store.has(`route:${DOMAIN}:sneaky`)).toBe(false);
    expect(h.db.count("accounts")).toBe(0);
  });

  it("`domain status` does not un-suspend a domain behind the operator's back", async () => {
    const h = harness();
    await makeAccount(h);
    await h.call("PATCH", `/domains/${DOMAIN}`, { status: "suspended" });

    // checkDomain writes status='active' when SES verifies — a read that
    // happens to write. Without a guard it reports the domain healthy while
    // every message still bounces off the parked keys.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ VerifiedForSendingStatus: true, DkimAttributes: { Status: "SUCCESS" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    try {
      await h.call("GET", `/domains/${DOMAIN}`);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(h.db.query<{ status: string }>(`SELECT status FROM domains`)[0]?.status).toBe("suspended");
    expect(h.kv.store.has(`route:${DOMAIN}:editor`)).toBe(false);
  });

  it("resume rebuilds a key from `routes` when there is no parked copy", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    await h.call("PATCH", `/domains/${DOMAIN}`, { status: "suspended" });
    h.kv.store.clear(); // the parked copy is lost too

    await h.call("PATCH", `/domains/${DOMAIN}`, { status: "active" });
    expect(JSON.parse(h.kv.store.get(`route:${DOMAIN}:editor`)!.value)).toEqual({
      kind: "mailbox",
      accountId,
      tenantId: TENANT,
    });
  });
});

// ── tier 3: hard delete, narrowly ─────────────────────────────────────────

/** Cloudflare + SES both go through global fetch; stub it and record. */
function stubExternals(): { calls: Array<{ method: string; url: string }> } {
  const calls: Array<{ method: string; url: string }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    calls.push({ method, url });
    return new Response(JSON.stringify({ success: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { calls };
}

describe("DELETE /domains — the mistyped-domain case", () => {
  it("409s while an account is still on it, with a readable message and no FK 500", async () => {
    const h = harness();
    await makeAccount(h);

    const res = await h.call("DELETE", `/domains/${DOMAIN}`);
    expect(res.status).toBe(409);
    const err = await body<{ error: string; holds: { routes: number; identities: number } }>(res);
    expect(err.error).toContain("still carries");
    expect(err.error).toContain("suspended");
    expect(err.holds).toEqual({ routes: 1, identities: 1 });
    expect(h.db.count("domains")).toBe(1);
  });

  it("unwinds the catch-all and the SES identity, and SAYS what it left alone", async () => {
    const h = harness();
    const { calls } = stubExternals();
    try {
      const res = await h.call("DELETE", `/domains/${DOMAIN}`);
      expect(res.status).toBe(200);
      const out = await body<{ steps: Array<{ step: string; ok: boolean; detail?: string }> }>(res);
      const step = (name: string) => out.steps.find((s) => s.step === name);

      expect(step("cf:catch-all-disable")?.ok).toBe(true);
      expect(step("ses:delete-identity")?.ok).toBe(true);
      // Symmetry with `addDomain`, which reports which of eight steps failed:
      // the things delete does NOT do are steps too, or an operator walks away
      // believing the domain is gone from Cloudflare.
      expect(step("cf:dns-records")?.detail).toContain("NOT unwound");
      expect(step("cf:email-routing")?.detail).toContain("NOT disabled");

      expect(calls.some((c) => c.method === "PUT" && c.url.includes("rules/catch_all"))).toBe(true);
      expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/identities/"))).toBe(true);
      expect(h.db.count("domains")).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // The headline use case, end to end: a domain is mistyped, an account gets
  // created on it, and the operator has to be able to undo BOTH. Soft delete
  // retains `identities`, so counting all of them as blockers would make the
  // 409 permanent and its own advice ("delete those accounts first")
  // impossible to satisfy.
  it("becomes deletable once its accounts are deleted, even though identities are retained", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    expect((await h.call("DELETE", `/domains/${DOMAIN}`)).status).toBe(409);

    await h.call("DELETE", `/accounts/${accountId}`);
    // The tombstone's identity row is still there — that is the trap.
    expect(h.db.count("identities")).toBe(1);

    stubExternals();
    try {
      expect((await h.call("DELETE", `/domains/${DOMAIN}`)).status).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(h.db.count("domains")).toBe(0);
  });

  it("clears parked route keys, so re-adding the domain cannot resurrect delivery", async () => {
    const h = harness();
    await h.kv.ns.put(`suspended-route:${DOMAIN}:ghost`, JSON.stringify({ kind: "mailbox" }));
    stubExternals();
    try {
      await h.call("DELETE", `/domains/${DOMAIN}`);
      expect(h.kv.store.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("DELETE /tenants", () => {
  it("409s while anything references it, naming what is in the way", async () => {
    const h = harness();
    const res = await h.call("DELETE", `/tenants/${TENANT}`);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("1 domains");
    expect(h.db.count("tenants")).toBe(1);
  });

  // ── the teardown path has to actually terminate ──────────────────────────
  // Soft delete retains `accounts`, `identities` and `principals`, and nothing
  // in the tree deletes any of them. If those counted as blockers, every
  // tenant that ever held one account would be undeletable through the API
  // forever — the hand-edit-D1 situation these verbs exist to remove. So the
  // tenant delete is the terminal verb: tombstones do not block it, they are
  // purged by it.
  it("purges tombstoned accounts and their principals instead of being blocked by them", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    stubExternals();
    try {
      await h.call("DELETE", `/accounts/${accountId}`);
      expect((await h.call("DELETE", `/domains/${DOMAIN}`)).status).toBe(200);

      const res = await h.call("DELETE", `/tenants/${TENANT}`);
      expect(res.status).toBe(200);
      expect(await body(res)).toMatchObject({ purged: { accounts: 1, principals: 1 } });
    } finally {
      vi.unstubAllGlobals();
    }
    // Foreign-key order held: nothing is left dangling in either direction.
    for (const table of ["tenants", "accounts", "principals", "identities", "tokens", "credentials"]) {
      expect(h.db.count(table), table).toBe(0);
    }
  });

  it("still refuses while a LIVE account is on it", async () => {
    const h = harness();
    await makeAccount(h);
    stubExternals();
    try {
      const res = await h.call("DELETE", `/tenants/${TENANT}`);
      expect(res.status).toBe(409);
      expect(await res.text()).toContain("1 liveAccounts");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deletes an empty tenant", async () => {
    const h = harness();
    h.db.seed("tenants", [{ id: "t_typo", name: "Typo", status: "active", created_at: 1 }]);
    expect((await h.call("DELETE", "/tenants/t_typo")).status).toBe(200);
    expect(h.db.count("tenants", "id = 't_typo'")).toBe(0);
  });
});

// ── tier 2: soft delete ───────────────────────────────────────────────────

describe("DELETE /accounts — soft delete, and the three things that must all move", () => {
  it("removes the KV key, so mail bounces instead of landing in a deleted account", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    expect(h.kv.store.has(`route:${DOMAIN}:editor`)).toBe(true);

    const res = await h.call("DELETE", `/accounts/${accountId}`);
    expect(res.status).toBe(200);

    // ingest's resolveRoute reads KV with NO D1 fallback, so this key — not
    // the `routes` row and not the tombstone — is what stops delivery. A
    // D1-only assertion passes while mail is still arriving.
    expect(h.kv.store.has(`route:${DOMAIN}:editor`)).toBe(false);
    expect(h.db.count("routes")).toBe(0);
  });

  it("tombstones rather than dropping the row — the mail is in another database", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    await h.call("DELETE", `/accounts/${accountId}`);

    const row = h.db.query<{ deleted_at: number | null }>(`SELECT deleted_at FROM accounts WHERE id = ?`, accountId)[0];
    expect(row?.deleted_at).toBeTypeOf("number");
    // Identities survive with it: a tombstone nothing can be read off is not
    // forensics, it is just a slower delete.
    expect(h.db.count("identities", "account_id = ?", accountId)).toBe(1);
  });

  it("stops the account authenticating — otherwise the delete is decorative", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    const principalId = h.db.query<{ principal_id: string }>(
      `SELECT principal_id FROM accounts WHERE id = ?`,
      accountId,
    )[0]!.principal_id;
    const minted = await mintToken();
    h.db.seed("tokens", [
      {
        id: minted.id,
        principal_id: principalId,
        secret_hash: minted.secretHash,
        name: "laptop",
        scopes: JSON.stringify(["mail"]),
        created_at: Date.now(),
      },
    ]);

    const before = await verifyBearer(h.db, minted.token);
    expect(before?.accounts.map((a) => a.accountId)).toEqual([accountId]);

    await h.call("DELETE", `/accounts/${accountId}`);

    // This principal owned nothing else, so its credentials went with the
    // account. The token no longer resolves at all.
    expect(await verifyBearer(h.db, minted.token)).toBeNull();
    expect(h.db.count("tokens")).toBe(0);
    expect(h.db.count("credentials")).toBe(0);
  });

  // ── the re-provisioning hole this closes ────────────────────────────────
  // `principals.login_email` is UNIQUE and `createAccount` reuses a principal
  // by that email, so re-creating a deleted address RE-ATTACHES the old
  // principal. Without revoking, every token that could read the old mailbox
  // would silently become a live credential for whoever gets the address next.
  it("an old token cannot follow the address onto a freshly re-created account", async () => {
    const h = harness();
    const first = await makeAccount(h);
    const principalId = h.db.query<{ principal_id: string }>(
      `SELECT principal_id FROM accounts WHERE id = ?`,
      first,
    )[0]!.principal_id;
    const minted = await mintToken();
    h.db.seed("tokens", [
      {
        id: minted.id,
        principal_id: principalId,
        secret_hash: minted.secretHash,
        name: "leaked",
        scopes: JSON.stringify(["mail"]),
        created_at: Date.now(),
      },
    ]);

    await h.call("DELETE", `/accounts/${first}`);
    const second = await makeAccount(h);
    expect(second).not.toBe(first);
    // The new account hangs off the SAME principal — that is the mechanism.
    expect(
      h.db.query<{ principal_id: string }>(`SELECT principal_id FROM accounts WHERE id = ?`, second)[0]?.principal_id,
    ).toBe(principalId);
    // ...and the old credential is dead, so it cannot read the new mailbox.
    expect(await verifyBearer(h.db, minted.token)).toBeNull();
  });

  it("leaves credentials alone when the principal still owns another live account", async () => {
    const h = harness();
    const first = await makeAccount(h, "eric");
    const principalId = h.db.query<{ principal_id: string }>(
      `SELECT principal_id FROM accounts WHERE id = ?`,
      first,
    )[0]!.principal_id;
    // A second mailbox on the same login — the §4 multi-domain model.
    await h.call("POST", "/accounts", {
      tenantId: TENANT,
      domain: DOMAIN,
      localpart: "eric2",
      displayName: "Eric",
      principalEmail: `eric@${DOMAIN}`,
    });
    const minted = await mintToken();
    h.db.seed("tokens", [
      {
        id: minted.id,
        principal_id: principalId,
        secret_hash: minted.secretHash,
        name: "laptop",
        scopes: JSON.stringify(["mail"]),
        created_at: Date.now(),
      },
    ]);

    await h.call("DELETE", `/accounts/${first}`);

    // Deleting one mailbox must not log the other one out.
    const after = await verifyBearer(h.db, minted.token);
    expect(after?.accounts).toHaveLength(1);
    expect(after?.accounts[0]?.accountId).not.toBe(first);
  });

  it("revokes public share links, which resolve on no credential at all", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    // `services/jmap` GET /share/* reads this key and nothing else; absence
    // denies, so deleting it IS the revocation.
    await h.kv.ns.put(
      `share:${accountId}:sh_abc`,
      JSON.stringify({ accountId, shareId: "sh_abc", exp: 2_000_000_000 }),
    );

    const res = await h.call("DELETE", `/accounts/${accountId}`);
    expect(h.kv.store.has(`share:${accountId}:sh_abc`)).toBe(false);
    const out = await body<{ steps: Array<{ step: string; detail?: string }> }>(res);
    expect(out.steps.find((s) => s.step === "kv:share-links")?.detail).toContain("1 link(s)");
  });

  it("tears down alias and catch-all routes too, not only the mailbox route", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    // ingest's resolveRoute falls back to the catch-all, so one left behind
    // keeps delivering into the tombstone — and it would block domain delete.
    h.db.seed("routes", [{ domain: DOMAIN, localpart: "*", kind: "catchall", target: accountId }]);
    await h.kv.ns.put(`route:${DOMAIN}:*`, JSON.stringify({ kind: "catchall", accountId }));

    await h.call("DELETE", `/accounts/${accountId}`);
    expect(h.db.count("routes")).toBe(0);
    expect(h.kv.store.has(`route:${DOMAIN}:*`)).toBe(false);
  });

  // Disable HOLDS the queue; delete CANCELS it. The drain skips tombstoned
  // accounts, so a row left `pending` here could never reach a terminal status
  // — it would block `agent unbind` forever and inflate the held-backlog log.
  it("cancels queued invocations, because they can never run again", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    const bindingId = await makeBinding(h, `editor@${DOMAIN}`);
    queueInvocation(h.db, accountId, bindingId);

    await h.call("DELETE", `/accounts/${accountId}`);
    expect(h.db.count("agent_invocations", "status = 'pending'")).toBe(0);
    expect(h.db.count("agent_invocations", "status = 'failed'")).toBe(1);

    // ...so the binding is still removable, rather than deadlocked.
    expect((await h.call("DELETE", `/agent-bindings/${bindingId}`)).status).toBe(200);
  });

  it("says what it kept, because it keeps a lot", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    const res = await h.call("DELETE", `/accounts/${accountId}`);
    const out = await body<{ retained: string[]; addresses: string[]; note: string }>(res);

    expect(out.addresses).toEqual([`editor@${DOMAIN}`]);
    expect(out.retained.join(" ")).toContain("shard0");
    expect(out.retained.join(" ")).toContain("R2");
    expect(out.note).toContain("NEW account");
  });

  it("disables agent bindings on the way down", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    await makeBinding(h, `editor@${DOMAIN}`);

    await h.call("DELETE", `/accounts/${accountId}`);
    expect(enqueueQuery(h.db, accountId)).toEqual([]);
  });

  it("is idempotent: a second delete writes nothing and says so", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    await h.call("DELETE", `/accounts/${accountId}`);
    const first = h.db.query<{ deleted_at: number }>(`SELECT deleted_at FROM accounts WHERE id = ?`, accountId)[0]!
      .deleted_at;

    const res = await h.call("DELETE", `/accounts/${accountId}`);
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ deleted: false });
    expect(
      h.db.query<{ deleted_at: number }>(`SELECT deleted_at FROM accounts WHERE id = ?`, accountId)[0]?.deleted_at,
    ).toBe(first);
  });

  it("404s an account that never existed", async () => {
    const h = harness();
    expect((await h.call("DELETE", "/accounts/t_bm__a_ghost")).status).toBe(404);
  });

  it("hides the tombstone from `GET /accounts`, and shows it under ?includeDeleted=1", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    await h.call("DELETE", `/accounts/${accountId}`);

    const live = await body<{ accounts: unknown[] }>(await h.call("GET", "/accounts"));
    expect(live.accounts).toEqual([]);

    const all = await body<{ accounts: Array<{ id: string; deleted_at: number }> }>(
      await h.call("GET", "/accounts?includeDeleted=1"),
    );
    expect(all.accounts).toHaveLength(1);
    expect(all.accounts[0]).toMatchObject({ id: accountId });
    expect(all.accounts[0]?.deleted_at).toBeTypeOf("number");
  });

  // The forensic half of a soft delete is worthless if no read path can see
  // it. `?email=` on the admin READ routes deliberately does not filter
  // tombstones — by id is the only way to revoke a grant, and by email is the
  // only way to find the id.
  it("keeps a tombstoned account's grants and bindings findable by address", async () => {
    const h = harness();
    const accountId = await makeAccount(h, "editor");
    await makeAccount(h, "other");
    await makeBinding(h, `editor@${DOMAIN}`);
    await h.call("POST", "/grants", {
      granteeEmail: `other@${DOMAIN}`,
      targetEmail: `editor@${DOMAIN}`,
    });

    await h.call("DELETE", `/accounts/${accountId}`);

    const grants = await body<{ grants: unknown[] }>(await h.call("GET", `/grants?email=editor@${DOMAIN}`));
    expect(grants.grants).toHaveLength(1);
    const bindings = await body<{ bindings: Array<{ enabled: number }> }>(
      await h.call("GET", `/agent-bindings?email=editor@${DOMAIN}`),
    );
    expect(bindings.bindings).toHaveLength(1);
    // ...and it reads as disabled, which is the honest answer.
    expect(bindings.bindings[0]?.enabled).toBe(0);
  });

  it("stops being a grant or binding target once tombstoned", async () => {
    const h = harness();
    const accountId = await makeAccount(h);
    await makeAccount(h, "other");
    await h.call("DELETE", `/accounts/${accountId}`);

    expect((await h.call("POST", "/agent-bindings", { email: `editor@${DOMAIN}`, name: "x" })).status).toBe(404);
    const grant = await h.call("POST", "/grants", {
      granteeEmail: `other@${DOMAIN}`,
      targetEmail: `editor@${DOMAIN}`,
    });
    expect(grant.status).toBe(404);
  });

  it("frees the address: re-creating it builds a NEW account, as the note warns", async () => {
    const h = harness();
    const first = await makeAccount(h);
    await h.call("DELETE", `/accounts/${first}`);

    const second = await makeAccount(h);
    expect(second).not.toBe(first);
    // The tombstone keeps its mail and stays unreachable — stated, not silent.
    expect(h.db.count("accounts")).toBe(2);
    expect(h.db.count("accounts", "deleted_at IS NULL")).toBe(1);
    expect(h.db.query<{ target: string }>(`SELECT target FROM routes WHERE localpart = 'editor'`)[0]?.target).toBe(
      second,
    );
  });
});

// ── grant tombstones (s03.A T2) ───────────────────────────────────────────
// `008` left grants on hard-DELETE with a note that this slice owns their
// lifecycle. Revoke now SETs `revoked_at` instead of DELETEing, and every
// transition is written to grant_lifecycle — so reach ends immediately while
// "who could have reached this account, and when did that change?" survives.
describe("grant lifecycle — revoke tombstones, and the log remembers", () => {
  async function mintGrant(h: Harness): Promise<string> {
    await makeAccount(h, "editor"); // target
    await makeAccount(h, "other"); // grantee
    const res = await h.call("POST", "/grants", {
      granteeEmail: `other@${DOMAIN}`,
      targetEmail: `editor@${DOMAIN}`,
    });
    return (await body<{ grantId: string }>(res)).grantId;
  }

  it("logs a `created` event when a grant is minted", async () => {
    const h = harness();
    const grantId = await mintGrant(h);
    expect(h.db.count("grant_lifecycle", "grant_id = ? AND event = 'created'", grantId)).toBe(1);
  });

  it("revoke TOMBSTONES the row instead of deleting it, and logs `revoked`", async () => {
    const h = harness();
    const grantId = await mintGrant(h);

    const res = await body<{ revoked: boolean }>(await h.call("DELETE", `/grants/${grantId}`));
    expect(res.revoked).toBe(true);

    // The row survives — this is the whole point of a tombstone vs a DELETE.
    expect(h.db.count("grants", "id = ?", grantId)).toBe(1);
    expect(h.db.count("grants", "id = ? AND revoked_at IS NOT NULL", grantId)).toBe(1);
    // ...and the lifecycle log carries both transitions.
    expect(h.db.count("grant_lifecycle", "grant_id = ? AND event = 'revoked'", grantId)).toBe(1);
    expect(h.db.count("grant_lifecycle", "grant_id = ?", grantId)).toBe(2);
  });

  it("revoke, then RE-grant the same pair — the tombstone must not block it", async () => {
    // The bug the s03.A tombstone introduced and nothing caught: `grants_tuple`
    // was a plain UNIQUE index, so a revoked row occupied its tuple forever and
    // `ON CONFLICT DO NOTHING` made the re-grant a silent no-op. The response
    // still said 200 with a fresh grantId that no row carried — the operator
    // was told access was restored when it was not. Fixed by making the index
    // partial on `revoked_at IS NULL`.
    const h = harness();
    const first = await mintGrant(h);
    await h.call("DELETE", `/grants/${first}`);

    const res = await h.call("POST", "/grants", {
      granteeEmail: `other@${DOMAIN}`,
      targetEmail: `editor@${DOMAIN}`,
    });
    expect(res.status).toBe(200);
    const second = (await body<{ grantId: string }>(res)).grantId;
    expect(second).not.toBe(first);

    // A real row, actually live.
    expect(h.db.count("grants", "id = ? AND revoked_at IS NULL", second)).toBe(1);
    expect(h.db.count("grant_lifecycle", "grant_id = ? AND event = 'created'", second)).toBe(1);
    // ...and the tombstone survives beside it, so the history is not rewritten.
    expect(h.db.count("grants", "id = ? AND revoked_at IS NOT NULL", first)).toBe(1);
  });

  it("a duplicate LIVE grant is refused with 409, not a phantom 200", async () => {
    // The other half. Uniqueness still bites for genuinely-live duplicates —
    // the partial index narrows WHICH rows collide, it does not stop collisions.
    // Previously this returned 200 with an id no row carried.
    const h = harness();
    const first = await mintGrant(h);
    const res = await h.call("POST", "/grants", {
      granteeEmail: `other@${DOMAIN}`,
      targetEmail: `editor@${DOMAIN}`,
    });
    expect(res.status).toBe(409);
    const dup = await body<{ error: string; grantId: string | null }>(res);
    expect(dup.error).toMatch(/already covers/);
    // It names the grant that is actually in the way, rather than a new uuid.
    expect(dup.grantId).toBe(first);
    expect(h.db.count("grants", "grantee_account_id IS NOT NULL AND revoked_at IS NULL")).toBe(1);
  });

  it("a second revoke is an idempotent no-op — no phantom log row", async () => {
    const h = harness();
    const grantId = await mintGrant(h);
    await h.call("DELETE", `/grants/${grantId}`);
    const second = await body<{ revoked: boolean }>(await h.call("DELETE", `/grants/${grantId}`));
    expect(second.revoked).toBe(false);
    expect(h.db.count("grant_lifecycle", "grant_id = ? AND event = 'revoked'", grantId)).toBe(1);
  });

  it("the grantee's reach vanishes on revoke, end to end through verifyBearer", async () => {
    const h = harness();
    await makeAccount(h, "editor"); // target
    const granteeId = await makeAccount(h, "other"); // grantee
    const principalId = h.db.query<{ principal_id: string }>(
      `SELECT principal_id FROM accounts WHERE id = ?`,
      granteeId,
    )[0]!.principal_id;
    const minted = await mintToken();
    h.db.seed("tokens", [
      {
        id: minted.id,
        principal_id: principalId,
        secret_hash: minted.secretHash,
        name: "laptop",
        scopes: JSON.stringify(["mail"]),
        created_at: Date.now(),
      },
    ]);
    const grantId = (
      await body<{ grantId: string }>(
        await h.call("POST", "/grants", {
          granteeEmail: `other@${DOMAIN}`,
          targetEmail: `editor@${DOMAIN}`,
        }),
      )
    ).grantId;

    const before = await verifyBearer(h.db, minted.token);
    expect(before?.accounts.some((a) => a.granted)).toBe(true);

    await h.call("DELETE", `/grants/${grantId}`);

    const after = await verifyBearer(h.db, minted.token);
    expect(after?.accounts.some((a) => a.granted)).toBe(false);
    // Reach is gone; the history that explains it is not.
    expect(h.db.count("grant_lifecycle", "grant_id = ?", grantId)).toBe(2);
  });
});
