import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_MAX_FAILURES, IP_MAX_FAILURES, LOGIN_WINDOW_MS } from "./loginThrottle";

// The throttle on POST /auth/login. Per .plans/devPrinciples.md the D1 and
// KV clients are injected, so the whole handler runs in plain Node against
// fakes — real crypto, no network.
//
// The assertions that matter are about ORDER, not status. A throttle that
// runs after the credential lookup and the hash still returns 401/429 and
// still looks green, while conserving nothing; so the tests below count
// calls to hashLoginKey and to the credentials query and require them to be
// ZERO on a throttled attempt. Status codes alone would pass either way.

const hash = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@bullmoose/auth-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bullmoose/auth-core")>();
  return {
    ...actual,
    // Wrap, don't stub: verification stays real, we only count entries.
    hashLoginKey: async (key: string) => {
      hash.calls++;
      return actual.hashLoginKey(key);
    },
  };
});

// Static imports are safe here: vitest hoists vi.mock (and vi.hoisted)
// above them, so ./authRoutes binds the wrapped hashLoginKey.
import { hashLoginKey } from "@bullmoose/auth-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { handleLogin } from "./authRoutes";

// The D1 and KV fakes are @bullmoose/test-fakes (sVOL 002). The KV in
// particular used to be local to this file precisely because it honoured
// absolute `expiration` while the copy in mintScopes.test.ts ignored every
// option — two fakes that disagreed about the semantics these tests turn on.

const CRED_SQL = "FROM principals p JOIN credentials";

const GOOD_KEY = "a".repeat(64); // isLoginKey: 64 lowercase hex
const BAD_KEY = "b".repeat(64);
const EMAIL = "eric@bullmoose.cc";
const IP = "203.0.113.7";

let pwHash: string;
beforeAll(async () => {
  pwHash = await hashLoginKey(GOOD_KEY);
});

function harness(principalExists = true) {
  const w = fakeEnv();
  if (principalExists) {
    w.db.seedAccount({ accountId: "a_eric", principalId: "p_eric", loginEmail: EMAIL });
    w.db.seed("credentials", [
      {
        principal_id: "p_eric",
        pw_algo: "client-pbkdf2-sha256-v1",
        pw_hash: pwHash,
        pw_salt: "salt",
        pw_iters: 1,
        updated_at: 1,
      },
    ]);
  }
  const env = w.env;
  /** How many times the credential lookup actually ran. */
  const credLookups = () => w.db.queries.filter((q) => q.includes(CRED_SQL)).length;
  const login = (loginKey = BAD_KEY, email = EMAIL, ip = IP) =>
    handleLogin(
      new Request("https://jmap.bullmoose.cc/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ email, loginKey }),
      }),
      env,
    );
  return { writes: w.db.writes, credLookups, login, store: w.kv.store, kv: w.env.ROUTES, env };
}

/** Status + exact body bytes + the headers a client can see. */
async function shape(res: Response) {
  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get("content-type"),
    retryAfter: res.headers.get("retry-after"),
  };
}

const START = Date.UTC(2026, 6, 14, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  hash.calls = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

describe("handleLogin — online guess throttle", () => {
  it("verifies normally below the email threshold", async () => {
    const h = harness();
    for (let i = 0; i < EMAIL_MAX_FAILURES - 1; i++) {
      const res = await h.login();
      expect(res.status).toBe(401);
    }
    // Every one of those actually reached verification.
    expect(hash.calls).toBe(EMAIL_MAX_FAILURES - 1);
    expect(h.credLookups()).toBe(EMAIL_MAX_FAILURES - 1);
  });

  it("stops hashing once the email window trips (the gate is BEFORE the work)", async () => {
    const h = harness();
    for (let i = 0; i < EMAIL_MAX_FAILURES; i++) await h.login();
    expect(hash.calls).toBe(EMAIL_MAX_FAILURES);

    hash.calls = 0;
    const before = h.credLookups();
    const res = await h.login();

    // The point of the whole change: no hash, no credential read.
    expect(hash.calls).toBe(0);
    expect(h.credLookups()).toBe(before);
    expect(res.status).toBe(401);
  });

  it("even a CORRECT key is not verified while the email window is shut", async () => {
    const h = harness();
    for (let i = 0; i < EMAIL_MAX_FAILURES; i++) await h.login();
    hash.calls = 0;

    const res = await h.login(GOOD_KEY);
    expect(hash.calls).toBe(0);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("token");
  });

  it("the throttled 401 is byte-identical to a wrong-key 401 (no oracle)", async () => {
    const h = harness();
    const normal = await shape(await h.login());
    for (let i = 1; i < EMAIL_MAX_FAILURES; i++) await h.login();
    const throttled = await shape(await h.login());

    expect(throttled).toEqual(normal);
  });

  it("an unknown email trips the window exactly like a real one", async () => {
    const known = harness(true);
    const unknown = harness(false);
    for (let i = 0; i < EMAIL_MAX_FAILURES; i++) {
      await known.login();
      await unknown.login();
    }
    hash.calls = 0;

    const a = await shape(await known.login());
    const b = await shape(await unknown.login());

    // Same status, same body, and neither one reached verification —
    // so "which emails exist" leaks nowhere on the throttled path.
    expect(b).toEqual(a);
    expect(hash.calls).toBe(0);
  });

  it("refuses the IP with 429 once IP_MAX_FAILURES is reached across many emails", async () => {
    const h = harness(false);
    for (let i = 0; i < IP_MAX_FAILURES; i++) {
      const res = await h.login(BAD_KEY, `probe${i}@bullmoose.cc`);
      expect(res.status).toBe(401);
    }
    hash.calls = 0;
    const before = h.credLookups();

    const res = await h.login(BAD_KEY, "probe-next@bullmoose.cc");
    expect(res.status).toBe(429);
    expect(hash.calls).toBe(0);
    expect(h.credLookups()).toBe(before);

    const retry = Number(res.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(LOGIN_WINDOW_MS / 1000);
  });

  it("the 429 is the same for a real email as for a made-up one", async () => {
    const h = harness(true);
    for (let i = 0; i < IP_MAX_FAILURES; i++) await h.login(BAD_KEY, `probe${i}@bullmoose.cc`);

    const real = await shape(await h.login(GOOD_KEY, EMAIL));
    const fake = await shape(await h.login(BAD_KEY, "nobody@bullmoose.cc"));

    expect(real.status).toBe(429);
    expect(fake).toEqual(real);
  });

  it("keys the IP window per caller — a different IP is unaffected", async () => {
    const h = harness(true);
    for (let i = 0; i < IP_MAX_FAILURES; i++) await h.login(BAD_KEY, `probe${i}@bullmoose.cc`, IP);
    expect((await h.login(GOOD_KEY, EMAIL, IP)).status).toBe(429);

    const res = await h.login(GOOD_KEY, EMAIL, "198.51.100.9");
    expect(res.status).toBe(200);
  });

  it("writes nothing to D1 on failed or throttled attempts", async () => {
    const h = harness(true);
    for (let i = 0; i < EMAIL_MAX_FAILURES + 3; i++) await h.login();
    // An unauthenticated guesser must not be able to drive control-plane writes.
    expect(h.writes).toHaveLength(0);
  });

  it("reopens after the window elapses", async () => {
    const h = harness();
    for (let i = 0; i < EMAIL_MAX_FAILURES; i++) await h.login();
    hash.calls = 0;

    advance(LOGIN_WINDOW_MS + 1000);
    const res = await h.login(GOOD_KEY);

    expect(hash.calls).toBe(1);
    expect(res.status).toBe(200);
  });

  it("does not extend the window while it is shut", async () => {
    const h = harness();
    for (let i = 0; i < EMAIL_MAX_FAILURES; i++) await h.login();
    // Keep hammering for most of the window; the reset must not slide.
    for (let i = 0; i < 10; i++) {
      advance(LOGIN_WINDOW_MS / 20);
      expect((await h.login()).status).toBe(401);
    }
    hash.calls = 0;

    advance(LOGIN_WINDOW_MS / 2 + 1000); // just past the ORIGINAL reset
    expect((await h.login(GOOD_KEY)).status).toBe(200);
    expect(hash.calls).toBe(1);
  });

  it("clears both windows on success", async () => {
    const h = harness();
    for (let i = 0; i < EMAIL_MAX_FAILURES - 1; i++) await h.login();

    const ok = await h.login(GOOD_KEY);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { token?: string }).token).toMatch(/^bm_/);
    expect([...h.store.keys()].filter((k) => k.startsWith("login:"))).toHaveLength(0);

    // The counter really restarted: a full fresh run of failures still verifies.
    hash.calls = 0;
    for (let i = 0; i < EMAIL_MAX_FAILURES - 1; i++) await h.login();
    expect(hash.calls).toBe(EMAIL_MAX_FAILURES - 1);
  });

  it("still rejects malformed input with 400 and no throttle state", async () => {
    const h = harness();
    const res = await handleLogin(
      new Request("https://jmap.bullmoose.cc/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": IP },
        body: JSON.stringify({ email: EMAIL, loginKey: "not-hex" }),
      }),
      h.env,
    );
    expect(res.status).toBe(400);
    expect(hash.calls).toBe(0);
    expect([...h.store.keys()]).toHaveLength(0);
  });
});
