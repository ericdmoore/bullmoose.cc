import { describe, expect, it } from "vitest";
import { EXPLORE_COOKIE, b64urlBytes, b64urlDecode } from "./cookie";
import { ERIC, EXPLORE_HOST, harness } from "./harness";

/**
 * The explorer as an ordinary OAuth client (s20 step 3).
 *
 * `services/oauth` is deployed and conformant, and NOTHING here changes it:
 * the explorer does the client's half — authorization code + PKCE S256,
 * redeemed server-side — and then mints its OWN host-only cookie, because an
 * authorization server cannot set a cookie for another host. That asymmetry is
 * the whole reason `explore.bullmoose.cc` costs nothing to separate.
 *
 * The AS is reached over the OAUTH service binding, so these tests inject a
 * `Fetcher` and assert on exactly what the explorer sent it — no network, no
 * global stub.
 */

const AUTHORIZE = "https://auth.bullmoose.cc/authorize";
const TOKEN = "https://auth.bullmoose.cc/token";
const RESOURCE = "https://mcp.bullmoose.cc/mcp";
const CLIENT_ID = "client_explorer_test";

interface Recorded {
  url: string;
  method: string;
  body: string;
  authorization: string | null;
}

interface FakeAs {
  binding: Fetcher;
  calls: Recorded[];
}

function fakeAs(opts: {
  token?: Record<string, unknown> | null;
  tokenStatus?: number;
  introspect?: Record<string, unknown>;
  introspectStatus?: number;
} = {}): FakeAs {
  const calls: Recorded[] = [];
  const binding = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input);
      const headers = new Headers((init?.headers ?? {}) as HeadersInit);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
        authorization: headers.get("authorization"),
      });
      if (url === TOKEN) {
        const status = opts.tokenStatus ?? 200;
        const body = opts.token === null ? {} : (opts.token ?? { access_token: "at_live", token_type: "Bearer" });
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === RESOURCE) {
        return new Response(
          JSON.stringify(
            opts.introspect ?? {
              active: true,
              props: { principalId: "p_eric", loginEmail: "eric@bullmoose.cc", scope: ["read"] },
            },
          ),
          { status: opts.introspectStatus ?? 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { binding, calls };
}

async function wired(overrides: Partial<Parameters<typeof fakeAs>[0]> = {}) {
  const as = fakeAs(overrides);
  const h = await harness({ env: { EXPLORE_CLIENT_ID: CLIENT_ID, OAUTH: as.binding } });
  return { h, as };
}

/** Drive /oauth/start and hand back the state the AS would echo. */
async function start(h: Awaited<ReturnType<typeof harness>>): Promise<{ res: Response; state: string; verifier: string }> {
  const res = await h.explore("/oauth/start", { cookie: null });
  const location = new URL(res.headers.get("location") ?? "");
  const state = location.searchParams.get("state") ?? "";
  const stored = JSON.parse((h.w.kv.store.get(`explore:pkce:${state}`)?.value ?? "{}") as string) as {
    verifier?: string;
  };
  return { res, state, verifier: stored.verifier ?? "" };
}

describe("/oauth/start", () => {
  it("redirects to the AS with PKCE S256 and nothing secret in the URL", async () => {
    const { h } = await wired();
    const { res, state, verifier } = await start(h);

    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(`https://${EXPLORE_HOST}/oauth/callback`);
    expect(url.searchParams.get("scope")).toBe("read");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(RESOURCE);
    expect(state).toHaveLength(32);

    // The CHALLENGE travels; the VERIFIER never leaves this worker.
    const expected = b64urlBytes(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    );
    expect(url.searchParams.get("code_challenge")).toBe(expected);
    expect(verifier).toHaveLength(64);
    expect(url.toString()).not.toContain(verifier);
    expect(url.toString()).not.toContain("code_verifier");
  });

  it("asks for `read` and only `read`", async () => {
    const { h } = await wired();
    const { res } = await start(h);
    expect(new URL(res.headers.get("location")!).searchParams.get("scope")).toBe("read");
  });

  it("says exactly what is missing when it is not configured", async () => {
    const h = await harness({ env: { OAUTH: undefined } });
    const res = await h.explore("/oauth/start", { cookie: null });
    expect(res.status).toBe(503);
    const body = await h.json<{ error: string; detail: string }>(res);
    expect(body.error).toBe("explorer_not_configured");
    expect(body.detail).toContain("EXPLORE_CLIENT_ID");
    expect(body.detail).toContain("OAUTH");
  });
});

describe("/oauth/callback", () => {
  it("redeems the code, introspects, and sets a short-lived host-only cookie", async () => {
    const { h, as } = await wired();
    const { state, verifier } = await start(h);

    const res = await h.explore(`/oauth/callback?code=ac_1&state=${state}`, { cookie: null });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://${EXPLORE_HOST}/`);

    // What went to the token endpoint.
    const token = as.calls.find((c) => c.url === TOKEN)!;
    const form = new URLSearchParams(token.body);
    expect(token.method).toBe("POST");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("ac_1");
    expect(form.get("code_verifier")).toBe(verifier);
    expect(form.get("redirect_uri")).toBe(`https://${EXPLORE_HOST}/oauth/callback`);
    expect(form.get("client_id")).toBe(CLIENT_ID);
    // A public client by default — PKCE is what binds the code.
    expect(form.get("client_secret")).toBeNull();

    // Introspection is addressed AT the resource URI, carrying the token.
    const who = as.calls.find((c) => c.url === RESOURCE)!;
    expect(who.authorization).toBe("Bearer at_live");

    // The cookie's attributes.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=900"); // minutes, not days
    expect(setCookie).toContain("Path=/");
    // Host-only: a Domain= would send this read-everything credential to the
    // apex and to app.bullmoose.cc.
    expect(setCookie.toLowerCase()).not.toContain("domain=");
  });

  it("the cookie carries `read` only, whatever the grant said", async () => {
    const { h } = await wired({
      introspect: {
        active: true,
        props: { principalId: "p_eric", scope: ["mail", "contacts", "calendar"] },
      },
    });
    const { state } = await start(h);
    const res = await h.explore(`/oauth/callback?code=ac_1&state=${state}`, { cookie: null });

    const session = decodeCookie(res.headers.get("set-cookie")!);
    expect(session.s).toEqual(["read"]);
    expect(session.p).toBe("p_eric");
    // Nothing replayable: no token, no email, no account list.
    expect(Object.keys(session).sort()).toEqual(["e", "p", "s", "v"]);
  });

  it("never puts the access token in the cookie or in the redirect", async () => {
    const { h } = await wired();
    const { state } = await start(h);
    const res = await h.explore(`/oauth/callback?code=ac_1&state=${state}`, { cookie: null });
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).not.toContain("at_live");
    expect(b64urlDecode(setCookie.split(";")[0]!.split("=")[1]!.split(".")[0]!)).not.toContain("at_live");
    expect(res.headers.get("location")).not.toContain("at_live");
  });

  it("the cookie it minted actually works", async () => {
    const { h } = await wired();
    const { state } = await start(h);
    const res = await h.explore(`/oauth/callback?code=ac_1&state=${state}`, { cookie: null });
    const value = res.headers.get("set-cookie")!.split(";")[0]!.slice(EXPLORE_COOKIE.length + 1);

    const listed = await h.explore("/Email", { cookie: value });
    expect(listed.status).toBe(200);
    expect((await h.json<{ _meta: { accountId: string } }>(listed))._meta.accountId).toBe(ERIC);
  });

  it("a state is single-use: a replayed callback is refused", async () => {
    const { h } = await wired();
    const { state } = await start(h);
    expect((await h.explore(`/oauth/callback?code=ac_1&state=${state}`, { cookie: null })).status).toBe(302);
    const replay = await h.explore(`/oauth/callback?code=ac_1&state=${state}`, { cookie: null });
    expect(replay.status).toBe(400);
    expect((await h.json<{ error: string }>(replay)).error).toBe("unknown_state");
    expect(replay.headers.get("set-cookie")).toBeNull();
  });

  it("a grant that does not include read is refused, with no cookie set", async () => {
    const { h } = await wired({
      introspect: { active: true, props: { principalId: "p_eric", scope: ["admin"] } },
    });
    const { state } = await start(h);
    const res = await h.explore(`/oauth/callback?code=ac_1&state=${state}`, { cookie: null });
    expect(res.status).toBe(403);
    expect((await h.json<{ error: string }>(res)).error).toBe("insufficient_scope");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("an inactive grant is refused", async () => {
    const { h } = await wired({ introspect: { active: false } });
    const { state } = await start(h);
    const res = await h.explore(`/oauth/callback?code=ac_1&state=${state}`, { cookie: null });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("a validation hop that fails REFUSES — it never falls through to a weaker check", async () => {
    for (const broken of [
      { tokenStatus: 500 },
      { token: null },
      { introspectStatus: 500 },
    ] as const) {
      const { h } = await wired(broken);
      const { state } = await start(h);
      const res = await h.explore(`/oauth/callback?code=ac_1&state=${state}`, { cookie: null });
      expect(res.status, JSON.stringify(broken)).toBe(502);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("an AS-reported error is surfaced, not swallowed", async () => {
    const { h } = await wired();
    const res = await h.explore("/oauth/callback?error=access_denied&error_description=nope", {
      cookie: null,
    });
    expect(res.status).toBe(400);
    expect((await h.json<{ error: string; detail: string }>(res)).detail).toContain("access_denied");
  });

  it("a confidential registration sends its secret; a public one has none to send", async () => {
    const as = fakeAs();
    const h = await harness({
      env: { EXPLORE_CLIENT_ID: CLIENT_ID, EXPLORE_CLIENT_SECRET: "s3cret", OAUTH: as.binding },
    });
    const { state } = await start(h);
    await h.explore(`/oauth/callback?code=ac_1&state=${state}`, { cookie: null });
    const form = new URLSearchParams(as.calls.find((c) => c.url === TOKEN)!.body);
    expect(form.get("client_secret")).toBe("s3cret");
  });
});

describe("/signout", () => {
  it("clears the cookie and sends you back to the door", async () => {
    const { h } = await wired();
    const res = await h.explore("/signout");
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  });
});

function decodeCookie(setCookie: string): { v: number; p: string; s: string[]; e: number } {
  const value = setCookie.split(";")[0]!.slice(EXPLORE_COOKIE.length + 1);
  return JSON.parse(b64urlDecode(value.slice(0, value.lastIndexOf(".")))) as {
    v: number;
    p: string;
    s: string[];
    e: number;
  };
}
