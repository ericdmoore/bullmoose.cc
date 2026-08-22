import { describe, expect, it } from "vitest";
import { fakeD1, fakeKV, type FakeD1, type FakeKV } from "@bullmoose/test-fakes";
import worker from "./index";
import type { Env } from "./index";

// POST /principals/enrollment-link (s33 day-one, #213). The property under
// test on THIS side of the flow is what the operator holds afterwards: a URL
// whose secret exists in the response once, as a hash in the row, and nowhere
// else — and a mint that supersedes, so a mis-sent link can be killed.

const ADMIN_TOKEN = "admin-secret";
const TENANT = "t_bm";
const EMAIL = "brother@bullmoose.cc";

interface Harness {
  db: FakeD1;
  kv: FakeKV;
  call: (method: string, path: string, body?: unknown) => Promise<Response>;
}

function harness(): Harness {
  const db = fakeD1();
  const kv = fakeKV();
  db.seed("tenants", [{ id: TENANT, name: "Bullmoose", status: "active", created_at: 1 }]);
  db.seed("principals", [{ id: "p_bro", tenant_id: TENANT, login_email: EMAIL, created_at: 1 }]);
  const env = {
    DB: db,
    ROUTES: kv.ns,
    ADMIN_TOKEN,
    SES_REGION: "us-east-1",
    INGEST_WORKER_NAME: "bullmoose-ingest",
    CF_API_TOKEN: "cf",
    SES_ACCESS_KEY_ID: "ak",
    SES_SECRET_ACCESS_KEY: "sk",
  } as Env;
  const call = (method: string, path: string, body?: unknown) =>
    worker.fetch(
      new Request(`https://provision.bullmoose.cc${path}`, {
        method,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  return { db, kv, call };
}

describe("POST /principals/enrollment-link", () => {
  it("1. mints a fragment-carried URL and stores ONLY the hash", async () => {
    const h = harness();
    const res = await h.call("POST", "/principals/enrollment-link", { email: EMAIL });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; expiresAt: number };
    // The fragment is the whole point: browsers do not send it, so no server
    // log and no Referer ever holds the secret.
    expect(body.url).toMatch(/^https:\/\/auth\.bullmoose\.cc\/enroll#[0-9a-f]{64}$/);
    const secret = body.url.split("#")[1]!;
    const rows = h.db.query<{ secret_hash: string; consumed_at: number | null }>(
      `SELECT secret_hash, consumed_at FROM enrollments WHERE principal_id = 'p_bro'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.secret_hash).not.toBe(secret); // hash, never plaintext
    expect(rows[0]!.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.consumed_at).toBeNull();
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("2. minting again SUPERSEDES — the mis-sent link dies", async () => {
    // The operator texted the link to the wrong number. The kill switch is a
    // fresh mint: the old row is consumed (audit intact), and only the new
    // secret opens the door.
    const h = harness();
    await h.call("POST", "/principals/enrollment-link", { email: EMAIL });
    await h.call("POST", "/principals/enrollment-link", { email: EMAIL });
    const rows = h.db.query<{ consumed_at: number | null }>(
      `SELECT consumed_at FROM enrollments WHERE principal_id = 'p_bro' ORDER BY created_at, id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.consumed_at === null)).toHaveLength(1);
  });

  it("3. an unknown principal is a 404, not a silently useless link", async () => {
    const h = harness();
    const res = await h.call("POST", "/principals/enrollment-link", { email: "nobody@bullmoose.cc" });
    expect(res.status).toBe(404);
  });

  it("4. a missing email is a 400", async () => {
    const h = harness();
    expect((await h.call("POST", "/principals/enrollment-link", {})).status).toBe(400);
  });
});
