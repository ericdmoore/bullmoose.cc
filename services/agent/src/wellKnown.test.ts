import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import worker from "./index";
import { OAUTH_SCOPES } from "@bullmoose/auth-core";
import {
  NOT_ADVERTISED_SCOPES,
  PUBLIC_SCOPES,
  handleWellKnown,
  originAllowed,
  protectedResourceMetadata,
  resourceUri,
  unauthorized,
} from "./wellKnown";

// s02 T1 — the public front door's discovery half.
//
// These assert the parts a third-party client actually depends on, and every
// one of them is a documented failure mode rather than a hypothetical:
//
//  - a 401 without `resource_metadata` leaves the client nowhere to go;
//  - a 200 carrying an auth error never prompts for auth at all (Anthropic's
//    docs are explicit that WWW-Authenticate is ignored on a 200);
//  - PRM served only at the ROOT well-known path is missed, because clients
//    probe the path-inserted form first (RFC 9728 §3.1);
//  - `resource` that does not equal the URL the user typed fails to match,
//    silently;
//  - an over-strict Origin check rejects claude.ai, which connects from
//    Anthropic's cloud rather than from anyone's browser.

const env = () => fakeEnv().env;
const get = (path: string, origin = "https://mcp.bullmoose.cc") =>
  new Request(`${origin}${path}`, { method: "GET" });

describe("s02 T1 — RFC 9728 protected resource metadata", () => {
  it("1. is served at the PATH-INSERTED well-known, which clients probe first", async () => {
    const url = new URL("https://mcp.bullmoose.cc/.well-known/oauth-protected-resource/mcp");
    const res = handleWellKnown(get(url.pathname), url, env());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.resource).toBe("https://mcp.bullmoose.cc/mcp");
  });

  it("2. is ALSO served at the root form, the documented fallback", async () => {
    const url = new URL("https://mcp.bullmoose.cc/.well-known/oauth-protected-resource");
    const res = handleWellKnown(get(url.pathname), url, env());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  it("3. names exactly ONE authorization server — Claude uses the first and never falls back", async () => {
    const url = new URL("https://mcp.bullmoose.cc/.well-known/oauth-protected-resource/mcp");
    const body = (await handleWellKnown(get(url.pathname), url, env())!.json()) as any;
    expect(body.authorization_servers).toHaveLength(1);
    expect(body.authorization_servers[0]).toBe("https://auth.bullmoose.cc");
  });

  it("4. carries the MCP-mandated fields on top of RFC 9728's minimum", async () => {
    const url = new URL("https://mcp.bullmoose.cc/.well-known/oauth-protected-resource/mcp");
    const body = (await handleWellKnown(get(url.pathname), url, env())!.json()) as any;
    expect(body.bearer_methods_supported).toEqual(["header"]);
    expect(Array.isArray(body.scopes_supported)).toBe(true);
  });

  it("5. never advertises vault or admin as scopes a stranger may request", async () => {
    // s02 decision 4: handing a third party the credential realm through a
    // consent screen is not a default worth having.
    const url = new URL("https://mcp.bullmoose.cc/.well-known/oauth-protected-resource/mcp");
    const body = (await handleWellKnown(get(url.pathname), url, env())!.json()) as any;
    expect(body.scopes_supported).not.toContain("vault");
    expect(body.scopes_supported).not.toContain("admin");
  });

  it("6. the resource URI has no trailing slash and no fragment (RFC 8707)", () => {
    const uri = resourceUri(new URL("https://mcp.bullmoose.cc/mcp"), env());
    expect(uri).not.toMatch(/\/$/);
    expect(uri).not.toContain("#");
    expect(uri).toMatch(/^https:\/\//);
  });

  it("7. an explicit MCP_RESOURCE_URI overrides the derived one", () => {
    // The escape hatch for a proxy that rewrites the origin: the value must
    // equal what the user typed, and only the operator knows that.
    const e = { ...env(), MCP_RESOURCE_URI: "https://mail.example.com/mcp" };
    expect(resourceUri(new URL("https://internal.workers.dev/mcp"), e)).toBe("https://mail.example.com/mcp");
    const meta = protectedResourceMetadata(new URL("https://internal.workers.dev/mcp"), e);
    expect(meta.resource).toBe("https://mail.example.com/mcp");
  });

  it("8. is not served on a path that merely looks similar", () => {
    const url = new URL("https://mcp.bullmoose.cc/.well-known/openid-configuration");
    expect(handleWellKnown(get(url.pathname), url, env())).toBeNull();
  });
});

describe("s02 T1 — the 401 that teaches", () => {
  it("9. is a 401, NOT a 200 — a 200 never triggers an auth prompt", async () => {
    const res = unauthorized(new URL("https://mcp.bullmoose.cc/mcp"), env());
    expect(res.status).toBe(401);
  });

  it("10. points at the PRM document by absolute URL", () => {
    const res = unauthorized(new URL("https://mcp.bullmoose.cc/mcp"), env());
    const header = res.headers.get("www-authenticate")!;
    expect(header).toContain("Bearer");
    expect(header).toContain(
      'resource_metadata="https://mcp.bullmoose.cc/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("11. the pointer it emits actually resolves to the PRM document", async () => {
    // The two halves are derived independently; this is the test that would
    // catch them drifting apart.
    const res = unauthorized(new URL("https://mcp.bullmoose.cc/mcp"), env());
    const pointer = /resource_metadata="([^"]+)"/.exec(res.headers.get("www-authenticate")!)![1]!;
    const url = new URL(pointer);
    const doc = handleWellKnown(get(url.pathname), url, env());
    expect(doc).not.toBeNull();
    const body = (await doc!.json()) as any;
    expect(body.resource).toBe(resourceUri(new URL("https://mcp.bullmoose.cc/mcp"), env()));
  });
});

describe("s02 T1 — Origin, not CORS", () => {
  const url = new URL("https://mcp.bullmoose.cc/mcp");

  it("12. ACCEPTS a request with no Origin — that is claude.ai, not an attacker", () => {
    // The whole point. DNS rebinding needs a browser to be the confused
    // deputy; a request with no Origin did not come from one. An over-strict
    // check here is the documented way to lock Claude out.
    expect(originAllowed(new Request(url), url)).toBe(true);
  });

  it("13. accepts a same-origin browser request", () => {
    expect(originAllowed(new Request(url, { headers: { Origin: "https://mcp.bullmoose.cc" } }), url)).toBe(true);
  });

  it("14. refuses a cross-site browser Origin — the rebinding case", () => {
    expect(originAllowed(new Request(url, { headers: { Origin: "https://evil.example" } }), url)).toBe(false);
  });

  it("15. refuses a malformed Origin rather than parsing it loosely", () => {
    expect(originAllowed(new Request(url, { headers: { Origin: "not-a-url" } }), url)).toBe(false);
  });
});

describe("s02 T1 — the route is public, /drain and /internal/* are not", () => {
  const post = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://mcp.bullmoose.cc${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  it("16. /mcp with NO internal token reaches the auth layer, not a 404", async () => {
    // Before T1 this fell past the x-internal-token wrapper to a bare 404 —
    // opaque by design, and fatal for a client that cannot hold our secret.
    const w = fakeEnv();
    const res = await worker.fetch!(post("/mcp"), w.env, ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("17. the historical /mcp/analytics alias behaves identically", async () => {
    const w = fakeEnv();
    const res = await worker.fetch!(post("/mcp/analytics"), w.env, ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("18. a bearer that does not resolve ALSO gets the teaching challenge", async () => {
    // An expired token is the most common way a working connection stops
    // working; the client can only recover if we tell it where to re-auth.
    const w = fakeEnv();
    const res = await worker.fetch!(post("/mcp", { Authorization: "Bearer bm_nope" }), w.env, ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("19. GET /mcp is 405 — the SSE era's transport is not implemented", async () => {
    const w = fakeEnv();
    const res = await worker.fetch!(
      new Request("https://mcp.bullmoose.cc/mcp", { method: "GET" }),
      w.env,
      ctx,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("20. /drain STILL requires the internal token — the wrapper only came off /mcp", async () => {
    const w = fakeEnv();
    const res = await worker.fetch!(post("/drain"), w.env, ctx);
    expect(res.status).toBe(404);
  });

  it("21. /internal/* STILL requires the internal token", async () => {
    const w = fakeEnv();
    const res = await worker.fetch!(post("/internal/refresh-pricing"), w.env, ctx);
    expect(res.status).toBe(404);
  });

  it("21b. /drain WITH the internal token still works — the refactor moved it, not broke it", async () => {
    // The actual regression risk of lifting /mcp out of the wrapper: the
    // remaining internal routes had to keep working, and "they 404 without a
    // token" is only half the proof.
    const w = fakeEnv();
    const res = await worker.fetch!(
      post("/drain", { "x-internal-token": w.env.INTERNAL_TOKEN }),
      w.env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toHaveProperty("handled");
  });

  it("21c. an OAuth bearer authenticates through the AS and reaches a tool (s02 T4)", async () => {
    // The whole bridge, through the real worker entry: a non-bm_ token goes
    // to the AS over the OAUTH binding, comes back as props, becomes a
    // principal, and runs a tool — with no bm_ token anywhere in the request.
    const w = fakeEnv();
    w.db.seedAccount({
      accountId: "a_eric",
      tenantId: "t_bm",
      principalId: "p_eric",
      loginEmail: "eric@bullmoose.cc",
      displayName: "Eric",
    });
    (w.env as { OAUTH: Fetcher }).OAUTH = {
      fetch: async () =>
        new Response(JSON.stringify({ active: true, props: { principalId: "p_eric", scope: ["read"] } })),
    } as unknown as Fetcher;

    const res = await worker.fetch!(
      new Request("https://mcp.bullmoose.cc/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer oauth-access-token",
          "MCP-Protocol-Version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "whoami",
            arguments: {},
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
      w.env,
      ctx,
    );
    expect(res.status).toBe(200);
    const answer = JSON.parse(((await res.json()) as any).result.content[0].text);
    expect(answer.principal).toBe("eric@bullmoose.cc");
    expect(answer.tokenScopes).toEqual(["read"]);
  });

  it("21d. an OAuth bearer the AS rejects gets the teaching 401, not a fallback", async () => {
    // Fail-closed at the route, not just in the bridge: a refused token must
    // not then be tried as a bm_ token.
    const w = fakeEnv();
    (w.env as { OAUTH: Fetcher }).OAUTH = {
      fetch: async () => new Response("no", { status: 401 }),
    } as unknown as Fetcher;
    const res = await worker.fetch!(
      post("/mcp", { Authorization: "Bearer some-oauth-token" }),
      w.env,
      ctx,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("22. discovery is reachable with no credential of any kind", async () => {
    const w = fakeEnv();
    const res = await worker.fetch!(
      get("/.well-known/oauth-protected-resource/mcp"),
      w.env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect((await res.json() as any).resource).toBe("https://mcp.bullmoose.cc/mcp");
  });
});

describe("s02 T1 — the advertisement must not drift from what the AS will grant", () => {
  // PUBLIC_SCOPES was hand-kept beside OAUTH_SCOPES and drifted: `files`
  // shipped in #128 and never reached the advertisement, so the metadata told
  // every agent the files realm did not exist. It is derived now, and these
  // three assertions are what keep the derivation honest — the third is the
  // one that matters, because a stale exemption reads exactly like a decision.

  it("11. advertises every scope the AS will grant, except the named few", () => {
    const missing = OAUTH_SCOPES.filter(
      (s) => !PUBLIC_SCOPES.includes(s) && !(s in NOT_ADVERTISED_SCOPES),
    );
    expect(missing, `the AS grants these but nothing advertises them: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("12. advertises nothing the AS would refuse — under-promise, never over", () => {
    const phantom = PUBLIC_SCOPES.filter((s) => !OAUTH_SCOPES.includes(s));
    expect(phantom, `advertised but not grantable: ${phantom.join(", ")}`).toEqual([]);
  });

  it("13. every withheld scope is still a real one — a stale exemption fails here", () => {
    const stale = Object.keys(NOT_ADVERTISED_SCOPES).filter((s) => !OAUTH_SCOPES.includes(s));
    expect(
      stale,
      `NOT_ADVERTISED names ${stale.join(", ")}, which the AS no longer grants — ` +
        `delete the entry rather than leaving a reason for a scope that is gone`,
    ).toEqual([]);
  });

  it("14. `files` specifically is advertised — the regression that motivated this", () => {
    expect(PUBLIC_SCOPES).toContain("files");
  });
});
