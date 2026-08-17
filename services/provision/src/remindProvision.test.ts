import { describe, expect, it } from "vitest";
import { fakeD1, fakeKV, type FakeD1, type FakeKV } from "@bullmoose/test-fakes";
import worker from "./index";
import type { Env } from "./index";

/**
 * POST /remind (s20 wave 2) — mints the tenant's remind@ account, its
 * reply-only governing book of the HUMAN principals, and the 'remind' binding
 * (pipeline "remind") whose allowedSenders mirrors the book. Structurally the
 * bouncer's shape minus persona/model and minus supervisory grants (a fired
 * reminder lands on the ASKER's account, so remind@ owns no proposals to
 * supervise). Explicit call per tenant; never auto-provisioned.
 */

const ADMIN_TOKEN = "admin-secret";
const DOMAIN = "family.test";
const TENANT = "t_fam";

interface Harness {
  db: FakeD1;
  kv: FakeKV;
  call: (path: string, body: Record<string, unknown>) => Promise<Response>;
}

function harness(): Harness {
  const db = fakeD1();
  const kv = fakeKV();
  db.seed("tenants", [{ id: TENANT, name: "Family", status: "active", created_at: 1 }]);
  db.seed("domains", [
    { domain: DOMAIN, tenant_id: TENANT, status: "active", cf_zone_id: "z1", created_at: 1 },
  ]);
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
  const call = (path: string, body: Record<string, unknown>) =>
    worker.fetch(
      new Request(`https://provision.test${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
  return { db, kv, call };
}

/** Two human accounts + one agent account (analyst@, which has a binding). */
async function seedHousehold(h: Harness): Promise<void> {
  for (const localpart of ["dad", "mom", "analyst"]) {
    const res = await h.call("/accounts", {
      tenantId: TENANT,
      domain: DOMAIN,
      localpart,
      displayName: localpart,
    });
    expect(res.status).toBe(200);
  }
  const res = await h.call("/agent-bindings", { email: `analyst@${DOMAIN}`, name: "allen" });
  expect(res.status).toBe(200);
}

describe("POST /remind", () => {
  it("mints account + governed book (humans only) + 'remind' binding mirroring the book", async () => {
    const h = harness();
    await seedHousehold(h);

    const res = await h.call("/remind", { tenantId: TENANT, domain: DOMAIN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      created: boolean;
      accountId: string;
      bindingId: string;
      recipientsBookId: string;
      allowedSenders: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);
    // Humans only: the agent principal (analyst@) is excluded structurally.
    expect(body.allowedSenders).toEqual([`dad@${DOMAIN}`, `mom@${DOMAIN}`]);

    const binding = h.db.query<{
      trigger_on: string;
      config_json: string;
      recipients_book_id: string;
    }>(
      `SELECT trigger_on, config_json, recipients_book_id FROM agent_bindings WHERE account_id = ? AND name = 'remind'`,
      body.accountId,
    )[0]!;
    expect(binding.trigger_on).toBe("mailbox-delivery"); // ingest's fan-out will mint invocations
    expect(binding.recipients_book_id).toBe(body.recipientsBookId);
    const cfg = JSON.parse(binding.config_json) as {
      pipeline: string;
      replyMode: string;
      allowedSenders: string[];
    };
    expect(cfg.pipeline).toBe("remind");
    expect(cfg.replyMode).toBe("send");
    expect(cfg.allowedSenders).toEqual(body.allowedSenders);

    // The governing book: governed policy + the membership chain in one stroke.
    const book = h.db.query<{ write_policy: string }>(
      `SELECT write_policy FROM address_books WHERE account_id = ? AND id = ?`,
      body.accountId,
      body.recipientsBookId,
    )[0]!;
    expect(book.write_policy).toBe("governed");
    const chain = h.db.query<{ address: string; event: string }>(
      `SELECT address, event FROM book_membership_log WHERE account_id = ? AND book_id = ? ORDER BY address`,
      body.accountId,
      body.recipientsBookId,
    );
    expect(chain).toEqual([
      { address: `dad@${DOMAIN}`, event: "added" },
      { address: `mom@${DOMAIN}`, event: "added" },
    ]);

    // Delivery is wired: mail to remind@ resolves (pattern B's trigger path).
    expect(h.kv.store.get(`route:${DOMAIN}:remind`)).toBeDefined();

    // No supervisory grant is minted for remind@ — the one divergence from
    // bouncer. A fired reminder is a proposal on the ASKER's account, not
    // remind@'s, so there is nothing on remind@'s account to supervise.
    expect(
      h.db.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM grants WHERE grantee_account_id = ?1 OR target_account_id = ?1`,
        body.accountId,
      )[0]!.n,
    ).toBe(0);
  });

  it("is idempotent: a second call reports the existing binding, writes nothing new", async () => {
    const h = harness();
    await seedHousehold(h);
    const first = (await (
      await h.call("/remind", { tenantId: TENANT, domain: DOMAIN })
    ).json()) as { bindingId: string };
    const res = await h.call("/remind", { tenantId: TENANT, domain: DOMAIN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; created: boolean; bindingId: string };
    expect(body).toMatchObject({ ok: true, created: false, bindingId: first.bindingId });
    expect(
      h.db.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM agent_bindings WHERE name = 'remind'`,
      )[0]!.n,
    ).toBe(1);
  });

  it("refuses a tenant with no human principals — a remind@ that could remind nobody", async () => {
    const h = harness();
    await h.call("/accounts", {
      tenantId: TENANT,
      domain: DOMAIN,
      localpart: "analyst",
      displayName: "A",
    });
    await h.call("/agent-bindings", { email: `analyst@${DOMAIN}`, name: "allen" });

    const res = await h.call("/remind", { tenantId: TENANT, domain: DOMAIN });
    expect(res.status).toBe(422);
    expect(h.db.query(`SELECT * FROM agent_bindings WHERE name = 'remind'`)).toEqual([]);
    // Nothing half-written: no remind account either.
    expect(h.db.query(`SELECT * FROM routes WHERE localpart = 'remind'`)).toEqual([]);
  });
});
