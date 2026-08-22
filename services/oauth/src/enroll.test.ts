import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import { deriveLoginKey } from "@bullmoose/auth-core";
import { enrollPage, enrollScript, handleEnroll } from "./enroll.js";

// The second human's door (s33 day-one, #213). The property under test is WHO
// NEVER LEARNS WHAT: the operator mints a link and hands it over, the
// arriving human sets a credential, and no path exists on which the operator,
// the logs, or the wire hold the password. The refusals are the security
// surface — each has a reason and each gets a test.

const PRINCIPAL = "p_brother";
const EMAIL = "brother@bullmoose.cc";
const TOKEN = "a".repeat(64);

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function world(over: { expiresAt?: number; consumedAt?: number | null; credential?: boolean } = {}) {
  const w = fakeEnv();
  await w.env.DB.prepare(
    `INSERT INTO tenants (id, name, created_at) VALUES ('t_bm', 'bm', ?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind(Date.now())
    .run();
  await w.env.DB.prepare(`INSERT INTO principals (id, tenant_id, login_email, created_at) VALUES (?, 't_bm', ?, ?)`)
    .bind(PRINCIPAL, EMAIL, Date.now())
    .run();
  await w.env.DB.prepare(
    `INSERT INTO enrollments (id, principal_id, secret_hash, created_at, expires_at, consumed_at)
     VALUES ('en_1', ?, ?, ?, ?, ?)`,
  )
    .bind(
      PRINCIPAL,
      await sha256hex(TOKEN),
      Date.now(),
      over.expiresAt ?? Date.now() + 86400000,
      over.consumedAt ?? null,
    )
    .run();
  if (over.credential) {
    await w.env.DB.prepare(
      `INSERT INTO credentials (principal_id, pw_algo, pw_hash, pw_salt, pw_iters, updated_at)
       VALUES (?, 'client-pbkdf2-sha256-v1', 'h', 's', 1, ?)`,
    )
      .bind(PRINCIPAL, Date.now())
      .run();
  }
  return w;
}

async function post(w: Awaited<ReturnType<typeof world>>, fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const req = new Request("https://auth.bullmoose.cc/enroll", { method: "POST", body: form });
  return handleEnroll(req, w.env as never);
}

const GOOD = async () => ({
  token: TOKEN,
  email: EMAIL,
  loginKey: await deriveLoginKey(EMAIL, "a long enough password"),
});

describe("the happy path — an arrival, once", () => {
  it("1. sets the credential and bounces to the login door", async () => {
    const w = await world();
    const res = await post(w, await GOOD());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://app.bullmoose.cc/login");
    const cred = w.db.query(`SELECT pw_algo FROM credentials WHERE principal_id = ?`, PRINCIPAL);
    expect(cred).toHaveLength(1);
    // Consumed, not deleted — the row is the audit record of the arrival.
    const row = w.db.query<{ consumed_at: number | null }>(`SELECT consumed_at FROM enrollments WHERE id = 'en_1'`);
    expect(row[0]!.consumed_at).not.toBeNull();
  });

  it("2. the credential is a hash of a DERIVATIVE — no password shape anywhere", async () => {
    const w = await world();
    await post(w, await GOOD());
    const cred = w.db.query<{ pw_hash: string }>(`SELECT pw_hash FROM credentials WHERE principal_id = ?`, PRINCIPAL);
    expect(cred[0]!.pw_hash).not.toContain("password");
    expect(cred[0]!.pw_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the refusals — each is a different conversation", () => {
  it("10. an unknown token is refused, and the page says to ask for a fresh one", async () => {
    const w = await world();
    const res = await post(w, { ...(await GOOD()), token: "f".repeat(64) });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not recognized");
  });

  it("11. a consumed link refuses AND tells the human to raise the alarm", async () => {
    // "Already used" might mean they double-clicked — or that someone else got
    // there first. The page says which conversation to have.
    const w = await world({ consumedAt: Date.now() - 1000 });
    const res = await post(w, await GOOD());
    const text = await res.text(); // a body reads once
    expect(text).toContain("already used");
    // The apostrophe is HTML-escaped on the page (&#39;), so assert around it.
    expect(text).toContain("If that wasn");
  });

  it("12. an expired link refuses without consuming anything", async () => {
    const w = await world({ expiresAt: Date.now() - 1000 });
    const res = await post(w, await GOOD());
    expect(await res.text()).toContain("expired");
    expect(w.db.query(`SELECT 1 FROM credentials WHERE principal_id = ?`, PRINCIPAL)).toHaveLength(0);
  });

  it("13. the wrong address refuses — the human must know WHICH account they claim", async () => {
    const w = await world();
    const res = await post(w, { ...(await GOOD()), email: "someone-else@bullmoose.cc" });
    expect(await res.text()).toContain("does not match");
  });

  it("14. ALREADY ENROLLED refuses — a leaked link is never a takeover", async () => {
    // The one that matters most: arrival only, never a reset. Changing a
    // credential is recovery's job, behind its own ceremony.
    const w = await world({ credential: true });
    const res = await post(w, await GOOD());
    expect(await res.text()).toContain("already set up");
    // And the original credential is untouched.
    const cred = w.db.query<{ pw_hash: string }>(`SELECT pw_hash FROM credentials WHERE principal_id = ?`, PRINCIPAL);
    expect(cred[0]!.pw_hash).toBe("h");
  });

  it("15. two racing tabs set at most ONE credential", async () => {
    // Consume-first, atomically: the UPDATE guards on consumed_at IS NULL, so
    // the second POST loses at the row, not at a race.
    const w = await world();
    const [a, b] = await Promise.all([post(w, await GOOD()), post(w, await GOOD())]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([303, 400]);
    expect(w.db.query(`SELECT 1 FROM credentials WHERE principal_id = ?`, PRINCIPAL)).toHaveLength(1);
  });
});

describe("the page and its script", () => {
  it("20. the page carries the credential-surface CSP and is never cached", () => {
    const res = enrollPage();
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("21. the script moves the FRAGMENT into the form and clears the address bar", async () => {
    // The fragment is why no server log ever saw the token; clearing it after
    // is why a shoulder-surfed address bar shows less.
    const js = await enrollScript().text();
    expect(js).toContain("location.hash");
    expect(js).toContain("replaceState");
    expect(js).toContain("deriveLoginKey");
  });

  it("22. the page's own submit never carries the raw password", async () => {
    const js = await enrollScript().text();
    expect(js).toContain('form.password.value = ""');
  });
});
