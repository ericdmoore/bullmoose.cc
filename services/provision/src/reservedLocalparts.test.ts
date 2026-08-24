import { describe, expect, it } from "vitest";
import { fakeD1, fakeKV } from "@bullmoose/test-fakes";
import worker from "./index";
import type { Env } from "./index";
import { reservedReason } from "./reservedLocalparts";

// s33's 🔴, previously enforced nowhere: a human must not be able to claim
// postmaster@ (the internet expects it to reach the operator) or an agent
// role address (a human holding bouncer@ receives the boundary agent's
// mail). The override is explicit and audited; the safe default is what a
// future self-serve caller inherits by writing nothing.

describe("reservedReason", () => {
  it("names the reason per class", () => {
    expect(reservedReason("postmaster")).toContain("RFC 2142");
    expect(reservedReason("bouncer")).toContain("agent role");
    expect(reservedReason("mailer-daemon")).toContain("infrastructure");
    expect(reservedReason("ada")).toBeNull();
  });

  it("is case-insensitive and plus-strip aware — the delivery equivalences", () => {
    expect(reservedReason("Postmaster")).not.toBeNull();
    expect(reservedReason("postmaster+anything")).not.toBeNull();
  });
});

const ADMIN_TOKEN = "admin-secret";
const TENANT = "t_bm";
const DOMAIN = "example.test";

function harness() {
  const db = fakeD1();
  const kv = fakeKV();
  db.seed("tenants", [{ id: TENANT, name: "T", status: "active", created_at: 1 }]);
  db.seed("domains", [{ domain: DOMAIN, tenant_id: TENANT, status: "active", cf_zone_id: "z", created_at: 1 }]);
  const env: Env = {
    DB: db,
    ROUTES: kv.ns,
    ADMIN_TOKEN,
    SES_REGION: "us-east-1",
    INGEST_WORKER_NAME: "bullmoose-ingest",
    CF_API_TOKEN: "cf",
    SES_ACCESS_KEY_ID: "ak",
    SES_SECRET_ACCESS_KEY: "sk",
  } as Env;
  const create = (payload: Record<string, unknown>) =>
    worker.fetch(
      new Request("https://provision.test/accounts", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ tenantId: TENANT, domain: DOMAIN, displayName: "x", ...payload }),
      }),
      env,
    );
  return { db, create };
}

describe("POST /accounts refuses reserved local-parts", () => {
  it("422 naming the reason and the override — and NOTHING was written", async () => {
    const h = harness();
    const res = await h.create({ localpart: "postmaster" });
    expect(res.status).toBe(422);
    const out = (await res.json()) as { error: string; reserved: string };
    expect(out.error).toContain("postmaster@ is reserved");
    expect(out.error).toContain("allowReserved");
    // The refusal fires before ANY write: no principal, no route, no account.
    expect(h.db.query("SELECT id FROM accounts")).toEqual([]);
    expect(h.db.query("SELECT id FROM principals")).toEqual([]);
  });

  it("an agent role address passes the ADMIN path freely — creating them is the operator's job", async () => {
    // The 51-test lesson: `editor@` + a binding IS how an agent comes to
    // exist, and the admin API is that path. The full vocabulary (including
    // agent roles) still refuses on the future self-serve gate, which uses
    // reservedReason, not adminRefusalReason.
    const h = harness();
    expect((await h.create({ localpart: "bouncer" })).status).toBe(200);
    expect(reservedReason("bouncer")).not.toBeNull(); // self-serve will refuse it
  });

  it("the operator's explicit override works, once stated", async () => {
    const h = harness();
    const res = await h.create({ localpart: "postmaster", allowReserved: true });
    expect(res.status).toBe(200);
  });

  it("an unreserved name never sees the gate", async () => {
    const h = harness();
    expect((await h.create({ localpart: "ada" })).status).toBe(200);
  });
});
