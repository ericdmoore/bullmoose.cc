import { describe, expect, it } from "vitest";
import { fakeD1, fakeKV, type FakeD1, type FakeKV } from "@bullmoose/test-fakes";
import worker, { SUPERVISORY_GRANT_SCOPES, type Env } from "./index";

/**
 * s10 T7, provisioning half — *creating an agent must let its owner see what it
 * proposes.*
 *
 * `POST /agent-bindings` and `POST /bouncer` minted an agent account with NO
 * grant back to the operator, so every new agent was born invisible: its
 * proposals landed on its own account, under its own principal, and the human's
 * `/approvals` correctly showed nothing. This suite pins the grant that closes
 * that, its exact scopes, its idempotency, and — the part a migration could
 * never do safely — its REFUSAL when ownership cannot be established.
 */

const ADMIN_TOKEN = "admin-secret";
const DOMAIN = "solo.test";
const TENANT = "t_solo";

interface Harness {
  db: FakeD1;
  kv: FakeKV;
  post: (path: string, body: Record<string, unknown>) => Promise<Response>;
  get: (path: string) => Promise<Response>;
}

function harness(tenant = TENANT, domain = DOMAIN): Harness {
  const db = fakeD1();
  const kv = fakeKV();
  db.seed("tenants", [{ id: tenant, name: tenant, status: "active", created_at: 1 }]);
  db.seed("domains", [{ domain, tenant_id: tenant, status: "active", cf_zone_id: "z1", created_at: 1 }]);
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
  const post = (path: string, body: Record<string, unknown>) =>
    worker.fetch(
      new Request(`https://provision.test${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
  const get = (path: string) =>
    worker.fetch(
      new Request(`https://provision.test${path}`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env,
    );
  return { db, kv, post, get, env } as Harness & { env: Env };
}

interface Supervision {
  granted: boolean;
  grantId?: string;
  created?: boolean;
  scopes?: string[];
  owner?: { email: string; accountId: string };
  reason?: string;
}

async function account(h: Harness, localpart: string, domain = DOMAIN, tenantId = TENANT) {
  const res = await h.post("/accounts", {
    tenantId,
    domain,
    localpart,
    displayName: localpart,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { accountId: string };
}

const liveGrants = (h: Harness, grantee: string, target: string) =>
  h.db.query<{ id: string; scopes: string; collection: string | null }>(
    `SELECT id, scopes, collection FROM grants
      WHERE grantee_account_id = ? AND target_account_id = ? AND revoked_at IS NULL`,
    grantee,
    target,
  );

// ---- the scope set ---------------------------------------------------------

describe("the supervisory grant's scopes", () => {
  it("is exactly read+draft — and NOT send, which a false premise once bought", () => {
    // Each one is load-bearing, and the set is asserted rather than described:
    //   read  → ActionProposal/get + /query
    //   draft → ActionProposal/set (approve / decline / needsInfo / dueAt)
    //
    // `send` was here, justified by "a reply-draft is tier 3 — precisely the
    // kind that produced this bug". That premise is FALSE: reply-draft is
    // emitted at tier 2 (services/agent/src/proposals.ts), so the wall's
    // `if (row.tier === 3)` never fires for it. A tier-2 approve parks in the
    // hold tray and is committed later by the cron, server-side — never under
    // the approver's token. So `draft` suffices, and `send` was a real
    // widening: it let the supervising human send mail AS the agent.
    //
    // This assertion is exact on purpose. If a tier-3 KIND ships, adding
    // `send` back is correct — but it must be re-argued from the tier that
    // actually produces it, not from this one, which never did.
    expect([...SUPERVISORY_GRANT_SCOPES]).toEqual(["read", "annotate", "draft"]);
    expect(SUPERVISORY_GRANT_SCOPES as readonly string[]).not.toContain("send");
    // NOT the `mail` bundle: that adds move/delete, i.e. the authority to
    // reorganise and DELETE the agent's mailbox. Supervision is not custody —
    // but `annotate` (2026-08-18) is IN: marking the supervised mail read or
    // flagged while reviewing it is exactly what a supervisor does, and a
    // keyword flip is reversible state, not structure.
    expect(SUPERVISORY_GRANT_SCOPES as readonly string[]).not.toContain("mail");
    expect(SUPERVISORY_GRANT_SCOPES as readonly string[]).not.toContain("move");
    expect(SUPERVISORY_GRANT_SCOPES as readonly string[]).not.toContain("delete");
    // …and no realm: deciding proposals is no business of the agent's address
    // book, its calendar or the credential store.
    for (const realm of ["contacts", "calendar", "files", "vault", "admin"]) {
      expect(SUPERVISORY_GRANT_SCOPES as readonly string[]).not.toContain(realm);
    }
  });
});

// ---- POST /agent-bindings --------------------------------------------------

describe("POST /agent-bindings mints the supervisory grant", () => {
  it("a fresh agent is visible to its owner with NO manual grant", async () => {
    const h = harness();
    const eric = await account(h, "eric");
    const emily = await account(h, "editor");

    const res = await h.post("/agent-bindings", { email: `editor@${DOMAIN}`, name: "emily" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; supervision: Supervision };
    expect(body.ok).toBe(true);
    expect(body.supervision.granted).toBe(true);
    expect(body.supervision.created).toBe(true);
    expect(body.supervision.owner).toEqual({ email: `eric@${DOMAIN}`, accountId: eric.accountId });
    expect(body.supervision.scopes).toEqual(["read", "annotate", "draft"]);

    // The row: whole-account (collection NULL — the mail domain has no
    // collection-scoped grant, so a scoped one could not carry the queue).
    const rows = liveGrants(h, eric.accountId, emily.accountId);
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]!.scopes)).toEqual(["read", "annotate", "draft"]);
    expect(rows[0]!.collection).toBeNull();
    // …and its birth is in the lifecycle chain, like every other grant.
    expect(h.db.count("grant_lifecycle", "grant_id = ? AND event = 'created'", rows[0]!.id)).toBe(1);
  });

  it("an explicit ownerEmail wins over the structural guess", async () => {
    const h = harness();
    await account(h, "dad");
    const mom = await account(h, "mom");
    const emily = await account(h, "editor");

    const res = await h.post("/agent-bindings", {
      email: `editor@${DOMAIN}`,
      name: "emily",
      ownerEmail: `mom@${DOMAIN}`,
    });
    const body = (await res.json()) as { supervision: Supervision };
    expect(body.supervision.granted).toBe(true);
    expect(body.supervision.owner!.accountId).toBe(mom.accountId);
    expect(liveGrants(h, mom.accountId, emily.accountId).length).toBe(1);
  });

  it("REFUSES to guess when the tenant has several humans — and says so", async () => {
    const h = harness();
    await account(h, "dad");
    await account(h, "mom");
    const emily = await account(h, "editor");

    const res = await h.post("/agent-bindings", { email: `editor@${DOMAIN}`, name: "emily" });
    const body = (await res.json()) as { ok: boolean; bindingId: string; supervision: Supervision };
    // The BINDING still lands — a half-created agent would be worse than an
    // unsupervised one, and the supervision is recoverable (see the backfill).
    expect(body.ok).toBe(true);
    expect(body.supervision.granted).toBe(false);
    expect(body.supervision.reason).toMatch(/ambiguous/i);
    expect(body.supervision.reason).toMatch(/ownerEmail/);
    // Nothing invented: no grant row at all, for anyone.
    expect(h.db.count("grants", "target_account_id = ?", emily.accountId)).toBe(0);
  });

  it("does not grant an agent bound to its OWNER's own account", async () => {
    const h = harness();
    const eric = await account(h, "eric");

    // Derived: the schema cannot distinguish "the owner's own account" from
    // "an agent-only tenant", so the sentence covers both rather than guessing.
    const derived = (await (
      await h.post("/agent-bindings", { email: `eric@${DOMAIN}`, name: "inbox-tidy" })
    ).json()) as { supervision: Supervision };
    expect(derived.supervision.granted).toBe(false);
    expect(derived.supervision.reason).toMatch(/own account/);
    expect(h.db.count("grants", "target_account_id = ?", eric.accountId)).toBe(0);

    // Named explicitly, it IS distinguishable — and there is genuinely nothing
    // to grant: the proposals land in the queue that human already reads. A
    // grantee = target row would be refused by the grant model anyway.
    const named = (await (
      await h.post("/agent-bindings", {
        email: `eric@${DOMAIN}`,
        name: "inbox-tidy-2",
        ownerEmail: `eric@${DOMAIN}`,
      })
    ).json()) as { supervision: Supervision };
    expect(named.supervision.granted).toBe(false);
    expect(named.supervision.reason).toMatch(/own account/);
    expect(h.db.count("grants", "target_account_id = ?", eric.accountId)).toBe(0);
  });

  it("never grants across tenants", async () => {
    const h = harness();
    // A second tenant with its own domain and human.
    h.db.seed("tenants", [{ id: "t_other", name: "other", status: "active", created_at: 1 }]);
    h.db.seed("domains", [
      {
        domain: "other.test",
        tenant_id: "t_other",
        status: "active",
        cf_zone_id: "z2",
        created_at: 1,
      },
    ]);
    const stranger = await account(h, "sam", "other.test", "t_other");
    const emily = await account(h, "editor");

    const res = await h.post("/agent-bindings", {
      email: `editor@${DOMAIN}`,
      name: "emily",
      ownerEmail: "sam@other.test",
    });
    const body = (await res.json()) as { supervision: Supervision };
    expect(body.supervision.granted).toBe(false);
    expect(body.supervision.reason).toMatch(/different tenant/);
    expect(liveGrants(h, stranger.accountId, emily.accountId).length).toBe(0);
  });
});

// ---- the backfill ----------------------------------------------------------

describe("POST /agent-bindings/{id}/supervisor — the backfill for agents that predate T7", () => {
  it("mints the missing grant, and a re-run adds nothing", async () => {
    const h = harness();
    const eric = await account(h, "eric");
    const emily = await account(h, "editor");
    // An agent as it exists TODAY: bound, with the grant deleted to simulate a
    // pre-T7 binding.
    const created = (await (await h.post("/agent-bindings", { email: `editor@${DOMAIN}`, name: "emily" })).json()) as {
      bindingId: string;
    };
    h.db.query("DELETE FROM grants");
    h.db.query("DELETE FROM grant_lifecycle");
    expect(liveGrants(h, eric.accountId, emily.accountId).length).toBe(0);

    const first = (await (await h.post(`/agent-bindings/${created.bindingId}/supervisor`, {})).json()) as {
      ok: boolean;
      supervision: Supervision;
    };
    expect(first.ok).toBe(true);
    expect(first.supervision.created).toBe(true);
    expect(first.supervision.scopes).toEqual(["read", "annotate", "draft"]);

    // IDEMPOTENT: an operator must be able to run this over every binding
    // without thinking about which ones already have it.
    const again = (await (await h.post(`/agent-bindings/${created.bindingId}/supervisor`, {})).json()) as {
      supervision: Supervision;
    };
    expect(again.supervision.granted).toBe(true);
    expect(again.supervision.created).toBe(false);
    expect(again.supervision.grantId).toBe(first.supervision.grantId);
    expect(liveGrants(h, eric.accountId, emily.accountId).length).toBe(1);
    expect(h.db.count("grant_lifecycle", "grant_id = ?", first.supervision.grantId!)).toBe(1);
  });

  it("REFUSES (422) when ownership is ambiguous, and takes ownerEmail to resolve it", async () => {
    const h = harness();
    await account(h, "dad");
    const mom = await account(h, "mom");
    const emily = await account(h, "editor");
    const created = (await (await h.post("/agent-bindings", { email: `editor@${DOMAIN}`, name: "emily" })).json()) as {
      bindingId: string;
    };

    const refused = await h.post(`/agent-bindings/${created.bindingId}/supervisor`, {});
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toMatch(/ambiguous/i);
    expect(h.db.count("grants", "target_account_id = ?", emily.accountId)).toBe(0);

    const named = await h.post(`/agent-bindings/${created.bindingId}/supervisor`, {
      ownerEmail: `mom@${DOMAIN}`,
    });
    expect(named.status).toBe(200);
    expect(liveGrants(h, mom.accountId, emily.accountId).length).toBe(1);
  });

  it("does not widen a supervisory grant an operator narrowed", async () => {
    const h = harness();
    const eric = await account(h, "eric");
    const emily = await account(h, "editor");
    const created = (await (await h.post("/agent-bindings", { email: `editor@${DOMAIN}`, name: "emily" })).json()) as {
      bindingId: string;
    };
    // The operator decides this one is watch-only.
    h.db.query(
      `UPDATE grants SET scopes = ? WHERE grantee_account_id = ? AND target_account_id = ?`,
      JSON.stringify(["read"]),
      eric.accountId,
      emily.accountId,
    );

    const res = (await (await h.post(`/agent-bindings/${created.bindingId}/supervisor`, {})).json()) as {
      supervision: Supervision;
    };
    // Reported as it IS, not as provisioning would like it: a re-run must never
    // silently restore authority a human deliberately removed.
    expect(res.supervision.created).toBe(false);
    expect(res.supervision.scopes).toEqual(["read"]);
    expect(JSON.parse(liveGrants(h, eric.accountId, emily.accountId)[0]!.scopes)).toEqual(["read"]);
  });

  it("404s on an unknown binding rather than inventing one", async () => {
    const h = harness();
    const res = await h.post("/agent-bindings/bind_nope/supervisor", {});
    expect(res.status).toBe(404);
  });

  it("a revoked supervisory grant is re-mintable (the tombstone is not a wall)", async () => {
    const h = harness();
    const eric = await account(h, "eric");
    const emily = await account(h, "editor");
    const created = (await (await h.post("/agent-bindings", { email: `editor@${DOMAIN}`, name: "emily" })).json()) as {
      bindingId: string;
      supervision: Supervision;
    };
    const revoke = await worker.fetch(
      new Request(`https://provision.test/grants/${created.supervision.grantId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      (h as unknown as { env: Env }).env,
    );
    expect(((await revoke.json()) as { revoked: boolean }).revoked).toBe(true);
    expect(liveGrants(h, eric.accountId, emily.accountId).length).toBe(0);

    const again = (await (await h.post(`/agent-bindings/${created.bindingId}/supervisor`, {})).json()) as {
      supervision: Supervision;
    };
    expect(again.supervision.created).toBe(true);
    expect(again.supervision.grantId).not.toBe(created.supervision.grantId);
    expect(liveGrants(h, eric.accountId, emily.accountId).length).toBe(1);
  });
});

// ---- POST /bouncer ---------------------------------------------------------

describe("POST /bouncer supervises the whole household", () => {
  it("grants every human principal — the same list bouncer@ answers to", async () => {
    const h = harness();
    const dad = await account(h, "dad");
    const mom = await account(h, "mom");
    // An agent account, so the household query has something to exclude.
    await account(h, "analyst");
    await h.post("/agent-bindings", { email: `analyst@${DOMAIN}`, name: "allen" });

    const res = await h.post("/bouncer", { tenantId: TENANT, domain: DOMAIN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      created: boolean;
      accountId: string;
      allowedSenders: string[];
      supervision: Supervision[];
    };
    expect(body.created).toBe(true);
    // One grant per human, and the humans are exactly bouncer@'s allowedSenders
    // — no third list to drift.
    expect(body.supervision.map((s) => s.owner!.email).sort()).toEqual(body.allowedSenders);
    expect(body.supervision.every((s) => s.granted && s.created)).toBe(true);
    for (const human of [dad, mom]) {
      const rows = liveGrants(h, human.accountId, body.accountId);
      expect(rows.length).toBe(1);
      expect(JSON.parse(rows[0]!.scopes)).toEqual(["read", "annotate", "draft"]);
    }
    // The agent account is NOT a supervisor of the bouncer.
    expect(h.db.count("grants", "grantee_account_id NOT IN (?, ?)", dad.accountId, mom.accountId)).toBe(0);
  });

  it("a re-run BACKFILLS a bouncer provisioned before T7, and duplicates nothing", async () => {
    const h = harness();
    const dad = await account(h, "dad");
    const first = (await (await h.post("/bouncer", { tenantId: TENANT, domain: DOMAIN })).json()) as {
      accountId: string;
    };
    // Simulate the live pre-T7 bouncer: binding and book intact, no grant.
    h.db.query("DELETE FROM grants");
    expect(liveGrants(h, dad.accountId, first.accountId).length).toBe(0);

    const rerun = await h.post("/bouncer", { tenantId: TENANT, domain: DOMAIN });
    const body = (await rerun.json()) as { created: boolean; supervision: Supervision[] };
    // The binding is untouched (created: false) — only the grant is minted.
    expect(body.created).toBe(false);
    expect(body.supervision.length).toBe(1);
    expect(body.supervision[0]!.created).toBe(true);
    expect(liveGrants(h, dad.accountId, first.accountId).length).toBe(1);

    // And a THIRD run writes nothing new.
    const third = (await (await h.post("/bouncer", { tenantId: TENANT, domain: DOMAIN })).json()) as {
      supervision: Supervision[];
    };
    expect(third.supervision[0]!.created).toBe(false);
    expect(liveGrants(h, dad.accountId, first.accountId).length).toBe(1);
  });
});
