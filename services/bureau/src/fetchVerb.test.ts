import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { fakeD1 } from "@bullmoose/test-fakes";
import { runFetchVerb } from "./fetchVerb";
import worker from "./index";
import type { Env } from "./models";

/**
 * T3 — the Class A `fetch` runtime, end to end through the real worker
 * (bureau.md §3, §6, invariants 1, 4, 5, 8).
 *
 * Driven through `worker.fetch` with a REALLY sealed credential and a REALLY
 * minted bearer, so every step the design names actually runs: `verifyBearer`'s
 * token crypto, the grant lookup, the kind gate, the destination binding, the
 * AES unseal, the injection. The only fake is the upstream itself — stubbed
 * global `fetch`, which records exactly what went on the wire.
 *
 * That recording is the point. Most of these assertions are not about the status
 * code the caller got; they are about **what reached the upstream and what did
 * not** — because "the credential never leaves" is a claim about the wire, and a
 * test that only reads the response cannot see it.
 */

const MASTER = "test-vault-master-key-0123456789abcdef";
const INTERNAL = "internal-test-token";
/** Distinctive on purpose: every leak assertion greps for this string. */
const SECRET = "bm-canary-DO-NOT-USE-leakprobe-9f3d1c";
const ALLEN = { principalId: "p_allen", email: "allen@bullmoose.cc", accountId: "a_allen" };

const STRIPE_ONLY = {
  allow: "https://api.stripe.com",
  header: "Authorization: Bearer {}",
  scope: "actor",
};

let allenToken: { id: string; token: string; secretHash: string };
beforeAll(async () => {
  allenToken = await mintToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One outbound request, as the upstream saw it. */
interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  redirect: string | undefined;
}

/**
 * The fake upstream. Returns the live recording array — assertions read it
 * AFTER the call, so "the credential was never sent to evil.io" is checkable as
 * an absence rather than inferred from a status code.
 */
function upstream(handler: (seen: Seen) => Response): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const record: Seen = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
      redirect: init?.redirect,
    };
    seen.push(record);
    return handler(record);
  });
  return seen;
}

const ok = (body: string, contentType = "application/json") =>
  new Response(body, { status: 200, headers: { "content-type": contentType } });

const redirectTo = (location: string, status = 302) => new Response(null, { status, headers: { location } });

interface Harness {
  env: Env;
  /** POST /bureau/use as allen@, with `args` as the fetch verb's request. */
  use: (args: Record<string, unknown>) => Promise<Response>;
  /** The same, for an arbitrary verb — used by the §4.1 kind-gate tests. */
  useVerb: (verb: string, args?: Record<string, unknown>) => Promise<Response>;
}

async function harness(
  opts: { kind?: string; meta?: Record<string, unknown>; verb?: string; secret?: string } = {},
): Promise<Harness> {
  const kind = opts.kind ?? "api-key";
  const verb = opts.verb ?? "fetch";
  const db = fakeD1();
  db.seedAccount({
    accountId: ALLEN.accountId,
    principalId: ALLEN.principalId,
    loginEmail: ALLEN.email,
  });
  db.seed("tokens", [
    {
      id: allenToken.id,
      principal_id: ALLEN.principalId,
      kind: "bearer",
      secret_hash: allenToken.secretHash,
      name: "invocation",
      scopes: JSON.stringify(["mail"]),
      created_at: 1,
      expires_at: null,
      last_used_at: Date.now(),
    },
  ]);
  db.seed("bureau_grants", [
    {
      id: "bg_test",
      principal_id: ALLEN.principalId,
      cred_name: "stripe",
      verb,
      created_by: "admin",
      created_at: 1,
      expires_at: null,
      revoked_at: null,
    },
  ]);

  const env: Env = { DB: db, VAULT_MASTER_KEY: MASTER, INTERNAL_TOKEN: INTERNAL };

  // Sealed for real, through the worker's own mint route — so the value the
  // runtime injects is one that came back out of AES-GCM, not a fixture.
  const sealed = await worker.fetch(
    new Request("https://bureau.internal/internal/bureau/seal", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": INTERNAL },
      body: JSON.stringify({
        mode: "mint",
        principalId: ALLEN.principalId,
        name: "stripe",
        kind,
        metaJson: JSON.stringify(opts.meta ?? STRIPE_ONLY),
        secret: opts.secret ?? SECRET,
      }),
    }),
    env,
  );
  expect(sealed.status, "seeding the credential").toBe(200);

  const call = (body: unknown) =>
    worker.fetch(
      new Request("https://bureau.internal/bureau/use", {
        method: "POST",
        headers: {
          authorization: `Bearer ${allenToken.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      env,
    );

  return {
    env,
    use: (args) => call({ verb: "fetch", credRef: "stripe", request: args }),
    useVerb: (v, args) => call({ verb: v, credRef: "stripe", request: args ?? {} }),
  };
}

interface Envelope {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: "text" | "base64";
  redirects: number;
}

const envelope = async (res: Response): Promise<Envelope> => (await res.json()) as Envelope;

describe("the allowlisted origin succeeds, with the credential injected server-side", () => {
  it("proxies the call and returns only the result", async () => {
    const seen = upstream(() => ok(JSON.stringify({ id: "ch_1", amount: 100 })));
    const h = await harness();

    const res = await h.use({
      url: "https://api.stripe.com/v1/charges",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "amount=100",
    });

    expect(res.status).toBe(200);
    const out = await envelope(res);
    expect(out).toMatchObject({ ok: true, status: 200, bodyEncoding: "text", redirects: 0 });
    expect(JSON.parse(out.body)).toEqual({ id: "ch_1", amount: 100 });

    // The wire: the Bureau put the value there, not the caller.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.body).toBe("amount=100");
    expect(seen[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("injects a header and NEVER a query parameter (invariant 8)", async () => {
    const seen = upstream(() => ok("{}"));
    const h = await harness({ meta: { allow: "https://api.stripe.com", header: "X-Api-Key: {}" } });

    await h.use({ url: "https://api.stripe.com/v1/charges?expand=customer" });

    // A key in a URL lands in access logs, referrers and history. The recipe's
    // shape makes that unreachable, and this is the assertion that says so.
    expect(seen[0]!.url).toBe("https://api.stripe.com/v1/charges?expand=customer");
    expect(seen[0]!.url).not.toContain(SECRET);
    expect(seen[0]!.headers["x-api-key"]).toBe(SECRET);
  });

  it("asks the platform NOT to follow redirects", async () => {
    // The mechanism behind invariant 4. If this regresses to the default
    // ("follow"), every cross-origin redirect test below would still pass while
    // the credential quietly travelled — so the mechanism is asserted directly.
    const seen = upstream(() => ok("{}"));
    const h = await harness();
    await h.use({ url: "https://api.stripe.com/v1/charges" });
    expect(seen[0]!.redirect).toBe("manual");
  });

  it("follows the wildcard entry to a real subdomain", async () => {
    const seen = upstream(() => ok("{}"));
    const h = await harness({
      kind: "aws-sigv4",
      meta: { allow: "https://*.amazonaws.com", header: "X-Amz-Security-Token: {}" },
    });
    const res = await h.use({ url: "https://ce.us-east-1.amazonaws.com/" });
    expect(res.status).toBe(200);
    expect(seen[0]!.headers["x-amz-security-token"]).toBe(SECRET);
  });
});

describe("§6 — a destination outside the allowlist is refused, and nothing is sent", () => {
  const refusals: Array<[string, string]> = [
    ["a look-alike host", "https://api.stripe.com.evil.io/v1/charges"],
    ["a subdomain of the look-alike", "https://evil-api.stripe.com.attacker.io/v1"],
    ["a scheme mismatch", "http://api.stripe.com/v1/charges"],
    ["a port mismatch", "https://api.stripe.com:8443/v1/charges"],
    ["a subdomain of the allowed host", "https://uploads.api.stripe.com/v1"],
    ["the parent domain", "https://stripe.com/v1/charges"],
    ["the userinfo trick", "https://api.stripe.com@evil.io/v1/charges"],
    ["an unrelated host mentioning it in the query", "https://evil.io/?x=https://api.stripe.com"],
  ];

  for (const [label, url] of refusals) {
    it(`refuses ${label}`, async () => {
      const seen = upstream(() => ok("{}"));
      const h = await harness();
      const res = await h.use({ url });
      // 403 for a policy refusal, 400 for one the URL could not even survive
      // parsing (userinfo) — the distinction is real, the outcome is the same.
      expect([400, 403], url).toContain(res.status);
      // The assertion that matters: no request left the Bureau at all, so the
      // credential was not merely withheld — there was nowhere for it to go.
      expect(seen, url).toHaveLength(0);
    });
  }

  it("names the refused origin so an operator can widen --allow deliberately", async () => {
    upstream(() => ok("{}"));
    const h = await harness();
    const res = await h.use({ url: "https://api.stripe.com.evil.io/v1" });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/not in the allowlist/);
  });
});

describe("invariant 5 — a credential with no allowlist is unusable", () => {
  it("refuses even its own would-be destination, and unseals nothing", async () => {
    const seen = upstream(() => ok("{}"));
    const h = await harness({ meta: { header: "Authorization: Bearer {}", scope: "actor" } });
    const res = await h.use({ url: "https://api.stripe.com/v1/charges" });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no destination allowlist/);
    expect(seen).toHaveLength(0);
  });

  it("refuses a credential with no header recipe — there is no other way in", async () => {
    const seen = upstream(() => ok("{}"));
    const h = await harness({ meta: { allow: "https://api.stripe.com", scope: "actor" } });
    const res = await h.use({ url: "https://api.stripe.com/v1/charges" });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/header injection recipe/);
    expect(seen).toHaveLength(0);
  });
});

describe("invariant 4 — the credential is never carried across an origin change", () => {
  it("refuses to follow a redirect to another origin, and sends nothing there", async () => {
    const seen = upstream((req) =>
      req.url.startsWith("https://api.stripe.com")
        ? redirectTo("https://evil.io/collect")
        : ok(JSON.stringify({ stolen: true })),
    );
    const h = await harness();

    const res = await h.use({ url: "https://api.stripe.com/v1/charges" });

    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/changes origin/);
    // Bypass-by-trusted-server, closed: exactly one request happened, to the
    // allowlisted host, and evil.io was never contacted — so it received neither
    // the credential nor the fact that a request was made.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.stripe.com/v1/charges");
    expect(seen.some((s) => s.url.includes("evil.io"))).toBe(false);
  });

  it("refuses even when the redirect target is ALSO on the allowlist", async () => {
    // Invariant 4 is written as "never carried across a redirect that changes
    // origin", not "never carried outside the allowlist". The strict reading is
    // the one implemented: a cross-origin hop ends the call regardless.
    const seen = upstream((req) =>
      req.url.startsWith("https://api.stripe.com") ? redirectTo("https://files.stripe.com/v1/f") : ok("{}"),
    );
    const h = await harness({
      meta: {
        allow: ["https://api.stripe.com", "https://files.stripe.com"],
        header: "Authorization: Bearer {}",
      },
    });
    const res = await h.use({ url: "https://api.stripe.com/v1/charges" });
    expect(res.status).toBe(502);
    expect(seen).toHaveLength(1);
  });

  it("refuses a scheme downgrade dressed up as a redirect", async () => {
    const seen = upstream((req) =>
      req.url.startsWith("https:") ? redirectTo("http://api.stripe.com/v1/charges") : ok("{}"),
    );
    const h = await harness();
    expect((await h.use({ url: "https://api.stripe.com/v1/charges" })).status).toBe(502);
    expect(seen).toHaveLength(1);
  });

  it("refuses a redirect to a non-http scheme", async () => {
    const seen = upstream(() => redirectTo("data:text/plain,hi"));
    const h = await harness();
    const res = await h.use({ url: "https://api.stripe.com/v1/charges" });
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/scheme/);
    expect(seen).toHaveLength(1);
  });

  it("DOES follow a same-origin redirect, re-injecting on the new hop", async () => {
    // The positive control for the four refusals above: without it, "refuses
    // every redirect" would pass every one of them and be wrong.
    const seen = upstream((req) =>
      req.url.endsWith("/v1/charges") ? redirectTo("/v1/charges/ch_1") : ok(JSON.stringify({ id: "ch_1" })),
    );
    const h = await harness();

    const res = await h.use({
      url: "https://api.stripe.com/v1/charges",
      method: "POST",
      body: "amount=1",
    });

    expect(res.status).toBe(200);
    expect(await envelope(res).then((e) => e.redirects)).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.url).toBe("https://api.stripe.com/v1/charges/ch_1");
    expect(seen[1]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    // 302 degrades to GET, so the body does not ride along to the new path.
    expect(seen[1]!.method).toBe("GET");
    expect(seen[1]!.body).toBeNull();
  });

  it("gives up on a same-origin redirect loop rather than holding the secret forever", async () => {
    let n = 0;
    const seen = upstream(() => redirectTo(`/v1/hop/${(n += 1)}`));
    const h = await harness();
    const res = await h.use({ url: "https://api.stripe.com/v1/charges" });
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/too many redirects/);
    expect(seen.length).toBeLessThanOrEqual(6);
  });
});

describe("§4.1 — a verb outside the credential's kind is refused", () => {
  it("refuses generic HMAC pointed at an AWS credential", async () => {
    const seen = upstream(() => ok("{}"));
    const h = await harness({ kind: "aws-sigv4", verb: "hmac_sha256" });
    const res = await h.useVerb("hmac_sha256");
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/not permitted for a .*aws-sigv4.* credential/);
    expect(seen).toHaveLength(0);
  });

  it("refuses fetch against an hmac-key, even with a live grant and a good allowlist", async () => {
    const seen = upstream(() => ok("{}"));
    const h = await harness({ kind: "hmac-key" });
    const res = await h.use({ url: "https://api.stripe.com/v1/charges" });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/not permitted for a .*hmac-key.* credential/);
    // The grant said yes and the destination was allowlisted. Only the kind
    // refused — which is what makes `kind` load-bearing rather than decorative.
    expect(seen).toHaveLength(0);
  });

  it("refuses a kind this version does not recognise", async () => {
    const h = await harness({ kind: "quantum-key" });
    expect((await h.use({ url: "https://api.stripe.com/v1" })).status).toBe(403);
  });

  it("still answers 501 for a Class B verb on a kind that permits it", async () => {
    // T5's honest state, now reached only from BEHIND the kind gate.
    const h = await harness({ kind: "aws-sigv4", verb: "sign_sigv4" });
    expect((await h.useVerb("sign_sigv4")).status).toBe(501);
  });
});

describe("§2 — the caller names the operation and supplies no policy", () => {
  it("ignores an allowlist and a header recipe smuggled into the request", async () => {
    const seen = upstream(() => ok("{}"));
    const h = await harness();
    const res = await h.use({
      url: "https://evil.io/collect",
      allow: "https://evil.io",
      header: "Authorization: Bearer {}",
      credential: SECRET,
    });
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("refuses a caller that tries to set the injected header itself", async () => {
    const seen = upstream(() => ok("{}"));
    const h = await harness();
    const res = await h.use({
      url: "https://api.stripe.com/v1/charges",
      headers: { authorization: "Bearer probing" },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/may not set the injected header/);
    expect(seen).toHaveLength(0);
  });

  it("drops hop-by-hop headers and forwards the rest", async () => {
    const seen = upstream(() => ok("{}"));
    const h = await harness();
    await h.use({
      url: "https://api.stripe.com/v1/charges",
      headers: { "Stripe-Version": "2024-06-20", Host: "evil.io", Connection: "close" },
    });
    expect(seen[0]!.headers["stripe-version"]).toBe("2024-06-20");
    expect(seen[0]!.headers.host).toBeUndefined();
    expect(seen[0]!.headers.connection).toBeUndefined();
  });

  it("refuses an unsupported method rather than passing it through", async () => {
    const seen = upstream(() => ok("{}"));
    const h = await harness();
    expect((await h.use({ url: "https://api.stripe.com/v1", method: "TRACE" })).status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe("invariant 1 — the credential never reaches the caller", () => {
  it("returns no trace of the value on ANY path, success or refusal", async () => {
    // The assertion this whole task exists for, written as a sweep rather than
    // a claim about one handler: whatever these calls answer — a result, a
    // policy refusal, an argument error, an upstream refusal — none of it
    // contains the value, in body, in headers, or in any cheap encoding of it.
    const seen = upstream((req) =>
      req.url.includes("/redirect") ? redirectTo("https://evil.io/x") : ok(JSON.stringify({ id: "ch_1" })),
    );
    const h = await harness();

    const probes: Array<Record<string, unknown>> = [
      { url: "https://api.stripe.com/v1/charges" }, // 200, the value DID go out
      { url: "https://api.stripe.com/redirect" }, // 502, cross-origin redirect
      { url: "https://api.stripe.com.evil.io/v1" }, // 403, look-alike
      { url: "http://api.stripe.com/v1" }, // 403, scheme
      { url: "https://api.stripe.com:8443/v1" }, // 403, port
      { url: "https://api.stripe.com/v1", headers: { authorization: "x" } }, // 400
      { url: "https://api.stripe.com/v1", method: "TRACE" }, // 400
      { url: "not-a-url" }, // 400
      {}, // 400
    ];

    const encodings = [SECRET, btoa(SECRET), hex(SECRET), encodeURIComponent(SECRET)];

    for (const probe of probes) {
      const res = await h.use(probe);
      const label = JSON.stringify(probe);
      let surface = await res.text();
      res.headers.forEach((value, name) => {
        surface += `\n${name}: ${value}`;
      });
      for (const form of encodings) {
        expect(surface, `${label} leaked ${form.slice(0, 12)}…`).not.toContain(form);
      }
    }

    // The paired half of the claim, and the reason the sweep is not vacuous:
    // the value really was applied — it went OUT on the wire, server-side — and
    // still came back to the caller nowhere.
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  it("does not hand the caller a session cookie minted for the Bureau", async () => {
    upstream(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "set-cookie": "sid=abc; HttpOnly" },
        }),
    );
    const h = await harness();
    const out = await envelope(await h.use({ url: "https://api.stripe.com/v1/charges" }));
    expect(out.headers["set-cookie"]).toBeUndefined();
    expect(out.headers["content-type"]).toBe("application/json");
  });
});

describe("the response path is a clean seam for T4 (§7 redaction)", () => {
  it("hands the egress filter the exact value that was injected", async () => {
    // T4 lands by replacing the default filter and nothing else. This drives the
    // seam directly to prove that: an echoing endpoint (the §7 ACCIDENT case,
    // the one redaction is FOR) with a filter installed comes back scrubbed.
    upstream((req) => ok(JSON.stringify({ echoed: req.headers.authorization })));

    const h = await harness();
    const injectedSeen: string[][] = [];
    const res = await runFetchVerb(
      h.env,
      { principalId: ALLEN.principalId, credRef: "stripe", kind: "api-key", meta: STRIPE_ONLY },
      { url: "https://api.stripe.com/v1/charges" },
      {
        redact: (text, injected) => {
          injectedSeen.push([...injected]);
          return injected.reduce((acc, v) => acc.split(v).join("[redacted:stripe]"), text);
        },
      },
    );

    expect(injectedSeen).toEqual([[SECRET]]);
    const out = await envelope(res);
    expect(out.body).not.toContain(SECRET);
    expect(out.body).toContain("[redacted:stripe]");
  });

  it("passes binary through as base64 rather than mangling it as text", async () => {
    // §7: scan text-ish content types, stream binary through with header
    // inspection only, "or large file responses break". Decoding a PNG as UTF-8
    // to look for a secret corrupts the PNG and finds nothing.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    upstream(() => new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    const h = await harness();

    const out = await envelope(await h.use({ url: "https://api.stripe.com/v1/files/f_1" }));
    expect(out.bodyEncoding).toBe("base64");
    expect([...atob(out.body)].map((c) => c.charCodeAt(0))).toEqual([...png]);
  });

  it("reports the upstream status without adopting it", async () => {
    // A 402 from Stripe is a RESULT, not a Bureau refusal — collapsing the two
    // would make "the Bureau said no" and "the API said no" indistinguishable.
    upstream(() => new Response(JSON.stringify({ error: "card_declined" }), { status: 402 }));
    const h = await harness();
    const res = await h.use({ url: "https://api.stripe.com/v1/charges", method: "POST" });
    expect(res.status).toBe(200);
    expect(await envelope(res)).toMatchObject({ ok: true, status: 402 });
  });

  it("surfaces an upstream network failure as a Bureau-level 502", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("connection refused");
    });
    const h = await harness();
    const res = await h.use({ url: "https://api.stripe.com/v1/charges" });
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/upstream request failed/);
  });
});

function hex(value: string): string {
  return [...new TextEncoder().encode(value)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
