#!/usr/bin/env node
// s02 T7 — conformance harness for the PUBLIC front door.
//
// Unlike the other e2e scripts in this directory, this one runs against a
// DEPLOYED origin rather than local dev servers. That is deliberate: what it
// verifies is the discovery chain a stranger's client walks, and most of that
// chain is hostnames, TLS, well-known paths and cross-worker hops — precisely
// the parts a local `wrangler dev` does not have.
//
//   node tools/e2e-mcp-public.mjs
//   MCP_ORIGIN=https://mcp.bullmoose.cc AUTH_ORIGIN=https://auth.bullmoose.cc \
//     BM_E2E_EMAIL=you@example.com BM_E2E_PASSWORD='…' node tools/e2e-mcp-public.mjs
//
// Two phases:
//
//   A — DISCOVERY + REFUSALS. No credentials. Everything a client can learn
//       before it authenticates, plus the refusals that actually bite. Safe
//       to run against production: it reads documents and gets rejected.
//
//   B — THE FULL DANCE. Needs BM_E2E_EMAIL + BM_E2E_PASSWORD. Registers a
//       client, completes PKCE S256 end to end, and calls a tool with the
//       resulting token. Skipped with a notice when credentials are absent,
//       because a harness that silently proves less than it claims is worse
//       than one that says what it did not do.
//
// Phase B WRITES to the deployment it runs against: dynamic client
// registration creates a client, and consent creates a grant plus a row in
// oauth_consents. Both are revocable, and the run reports what it made.

const MCP = (process.env.MCP_ORIGIN ?? "https://mcp.bullmoose.cc").replace(/\/$/, "");
const AUTH = (process.env.AUTH_ORIGIN ?? "https://auth.bullmoose.cc").replace(/\/$/, "");
const RESOURCE = `${MCP}/mcp`;
const V = "2026-07-28";

let failures = 0;
let checks = 0;
const ok = (msg) => { checks++; console.log(`  ok   ${msg}`); };
const fail = (msg, detail) => {
  checks++; failures++;
  console.error(`  FAIL ${msg}${detail ? `\n       ${detail}` : ""}`);
};
const check = (cond, msg, detail) => (cond ? ok(msg) : fail(msg, detail));
const section = (t) => console.log(`\n▸ ${t}`);

const meta = (over = {}) => ({
  "io.modelcontextprotocol/protocolVersion": V,
  "io.modelcontextprotocol/clientCapabilities": {},
  ...over,
});

/** POST a JSON-RPC body to /mcp. `token` optional. */
async function rpc(body, { token, headers = {} } = {}) {
  const res = await fetch(`${MCP}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "MCP-Protocol-Version": V,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not every refusal is JSON */ }
  return { res, json };
}

// ── Phase A ────────────────────────────────────────────────────────────────

section("A1 — the 401 that teaches");
{
  const { res, json } = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta() } });
  check(res.status === 401, "unauthenticated POST /mcp is 401", `got ${res.status}`);
  // Load-bearing: Claude does not honour WWW-Authenticate on a 200, and reads
  // a 200 {isError:true} as an application error handed to the model — so a
  // friendly 200 here means no auth prompt ever appears.
  check(res.status !== 200, "and NOT a 200 — a 200 never triggers an auth prompt");
  const wa = res.headers.get("www-authenticate") ?? "";
  check(/^Bearer/.test(wa), "carries a Bearer challenge", wa || "(absent)");
  const m = /resource_metadata="([^"]+)"/.exec(wa);
  check(!!m, "names resource_metadata", wa || "(absent)");
  check(json?.error?.code === -32001, "body is a JSON-RPC unauthorized", JSON.stringify(json));

  if (m) {
    const prmUrl = m[1];
    const prm = await fetch(prmUrl).then((r) => r.json()).catch(() => null);
    check(!!prm, "the advertised resource_metadata URL resolves", prmUrl);
    check(prm?.resource === RESOURCE, "PRM resource equals the canonical URI", `${prm?.resource} !== ${RESOURCE}`);
    // Claude uses the FIRST entry and does not fall back, so a list longer
    // than one is a silent single point of failure.
    check(Array.isArray(prm?.authorization_servers) && prm.authorization_servers.length === 1,
      "PRM names exactly one authorization server", JSON.stringify(prm?.authorization_servers));
    check(prm?.authorization_servers?.[0] === AUTH, "and it is the expected one", prm?.authorization_servers?.[0]);
    check(!/\/$/.test(prm?.resource ?? "/") && !(prm?.resource ?? "").includes("#"),
      "resource URI has no trailing slash and no fragment (RFC 8707)");
    // A doc URL that 200s with the wrong content is worse than a 404: the
    // reader gets a plausible page and no signal. This once pointed at the
    // marketing homepage.
    if (prm?.resource_documentation) {
      const doc = await fetch(prm.resource_documentation).catch(() => null);
      check(doc?.ok === true, "resource_documentation resolves", prm.resource_documentation);
      check((doc?.headers.get("content-type") ?? "").includes("markdown"),
        "and is served as markdown", doc?.headers.get("content-type") ?? "(none)");
    }
  }
}

section("A2 — protected resource metadata at both well-known paths");
for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
  const res = await fetch(`${MCP}${path}`);
  // RFC 9728 §3.1 is path INSERTION, not suffixing; clients probe the
  // inserted form first and fall back to the root form.
  check(res.ok, `served at ${path}`, `got ${res.status}`);
}

section("A3 — authorization server metadata");
let asMeta = null;
{
  const res = await fetch(`${AUTH}/.well-known/oauth-authorization-server`);
  check(res.ok, "AS metadata is served", `got ${res.status}`);
  asMeta = await res.json().catch(() => null);
  check(asMeta?.issuer === AUTH, "issuer matches the origin", asMeta?.issuer);
  check(!!asMeta?.authorization_endpoint && !!asMeta?.token_endpoint, "authorize + token endpoints present");
  // BOTH CIMD signals or Claude silently falls back to DCR, which registers a
  // fresh client on every connection.
  check(asMeta?.client_id_metadata_document_supported === true,
    "advertises client_id_metadata_document_supported");
  check((asMeta?.token_endpoint_auth_methods_supported ?? []).includes("none"),
    "advertises \"none\" auth method — the second CIMD signal");
  check((asMeta?.code_challenge_methods_supported ?? []).includes("S256"), "advertises PKCE S256");
  check(!(asMeta?.code_challenge_methods_supported ?? []).includes("plain"),
    "and does NOT advertise plain PKCE");
}

section("A4 — refusals that do not need a credential");
{
  const { res } = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta() } },
    { token: "bm_not_a_real_token" });
  check(res.status === 401, "a bogus bearer is refused", `got ${res.status}`);
  check((res.headers.get("www-authenticate") ?? "").includes("resource_metadata"),
    "and still gets the teaching challenge — an expired token must be recoverable");
}
{
  const res = await fetch(`${MCP}/mcp`, { method: "GET" });
  // HTTP+SSE was removed in 2026-07-28 and is not implemented here.
  check(res.status === 405, "GET /mcp is 405 — the SSE era is not implemented", `got ${res.status}`);
}
{
  const res = await fetch(`${MCP}/drain`, { method: "POST" });
  check(res.status === 404, "/drain still refuses without the internal token", `got ${res.status}`);
}

// ── Phase B ────────────────────────────────────────────────────────────────

const EMAIL = process.env.BM_E2E_EMAIL;
const PASSWORD = process.env.BM_E2E_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.log(`\n▸ B — the full OAuth dance: SKIPPED`);
  console.log("  Set BM_E2E_EMAIL and BM_E2E_PASSWORD to run it. Phase A proved the");
  console.log("  discovery chain and the refusals; it did NOT prove that a token can be");
  console.log("  obtained or that /mcp accepts one.");
} else {
  const { deriveLoginKey } = await import("./login-key.mjs");
  const b64url = (buf) => Buffer.from(buf).toString("base64url");
  const { webcrypto } = await import("node:crypto");

  section("B1 — register a client (DCR)");
  const redirectUri = "http://127.0.0.1/callback";
  let clientId = null;
  {
    const res = await fetch(asMeta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "bullmoose e2e harness",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    const body = await res.json().catch(() => null);
    check(res.ok, "dynamic client registration succeeds", `${res.status} ${JSON.stringify(body)}`);
    clientId = body?.client_id;
    check(!!clientId, "and returns a client_id");
    if (clientId) console.log(`       registered client_id=${clientId} (revocable)`);
  }

  section("B2 — authorization code with PKCE S256");
  const verifier = b64url(webcrypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(
    await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ));
  const state = b64url(webcrypto.getRandomValues(new Uint8Array(16)));
  let code = null;
  if (clientId) {
    const authUrl = new URL(asMeta.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "read");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("resource", RESOURCE);

    const page = await fetch(authUrl);
    const html = await page.text();
    check(page.ok, "the consent screen renders", `got ${page.status}`);
    // The spec requires showing where the code will be delivered; CIMD cannot
    // by itself prevent localhost impersonation.
    check(html.includes("127.0.0.1"), "and shows the redirect host to the human");
    const authRequest = /name="authRequest" value="([^"]*)"/.exec(html)?.[1];
    check(!!authRequest, "and carries the authorization request forward");

    if (authRequest) {
      const decode = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
      const form = new URLSearchParams();
      form.set("authRequest", decode(authRequest));
      form.set("scope", "read");
      form.set("decision", "approve");
      form.set("email", EMAIL);
      form.set("loginKey", await deriveLoginKey(EMAIL, PASSWORD));
      const res = await fetch(asMeta.authorization_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
        redirect: "manual",
      });
      check(res.status === 302 || res.status === 303, "approving redirects back to the client",
        `got ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const loc = res.headers.get("location") ?? "";
      const u = loc ? new URL(loc) : null;
      code = u?.searchParams.get("code") ?? null;
      check(!!code, "with an authorization code", loc.slice(0, 120));
      check(u?.searchParams.get("state") === state, "and the state we sent");
      // RFC 9207: the issuer must come back on the redirect so a client cannot
      // be tricked into exchanging a code at the wrong AS.
      check(u?.searchParams.get("iss") === AUTH, "and RFC 9207 iss identifying the AS",
        u?.searchParams.get("iss") ?? "(absent)");
    }
  }

  section("B3 — token exchange");
  let token = null;
  if (code) {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    const res = await fetch(asMeta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const body = await res.json().catch(() => null);
    check(res.ok, "code exchanges for a token", `${res.status} ${JSON.stringify(body)}`);
    token = body?.access_token;
    check(!!token, "an access token comes back");
    check(!!body?.refresh_token, "and a refresh token");
    check(typeof body?.expires_in === "number" && body.expires_in <= 3600,
      "which expires — the first credential in bullmoose that does", String(body?.expires_in));

    // Replay: an authorization code is single-use.
    const again = await fetch(asMeta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    check(!again.ok, "and the code cannot be replayed", `got ${again.status}`);
  }

  section("B4 — the token works against /mcp");
  if (token) {
    const { res, json } = await rpc({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "whoami", arguments: {}, _meta: meta() },
    }, { token });
    check(res.status === 200, "tools/call whoami succeeds with the OAuth token", `${res.status} ${JSON.stringify(json)}`);
    const answer = (() => { try { return JSON.parse(json?.result?.content?.[0]?.text ?? "null"); } catch { return null; } })();
    check(answer?.principal === EMAIL.toLowerCase(), "and it is the human who consented", answer?.principal);
    // The grant was `read`; the token must not carry the human's full authority.
    check(Array.isArray(answer?.tokenScopes) && answer.tokenScopes.join() === "read",
      "carrying THIS grant's scopes, not the account's", JSON.stringify(answer?.tokenScopes));
  }

  section("B5 — refusals that need a token");
  if (token) {
    const { res, json } = await rpc({
      jsonrpc: "2.0", id: 1, method: "tools/list",
      params: { _meta: meta({ "io.modelcontextprotocol/protocolVersion": "2026-07-28" }) },
    }, { token, headers: { "MCP-Protocol-Version": "2025-06-18" } });
    check(json?.error?.code === -32020, "header/_meta mismatch is -32020 HeaderMismatch",
      JSON.stringify(json?.error));
    check(res.status === 400, "with a 400");
  }
  if (token) {
    const { json } = await rpc({
      jsonrpc: "2.0", id: 1, method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": V } },
    }, { token });
    check(json?.error?.code === -32021, "missing clientCapabilities is -32021", JSON.stringify(json?.error));
  }
  if (token) {
    const { json } = await rpc({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "spend_by_month", arguments: { accountId: "t_nope__a_nope" }, _meta: meta() },
    }, { token });
    check(json?.error?.code === -32004, "an account the token cannot reach is -32004",
      JSON.stringify(json?.error));
  }

  section("B6 — both protocol eras on the same endpoint");
  if (token) {
    const res = await fetch(`${MCP}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
    });
    const body = await res.json().catch(() => null);
    check(res.ok && body?.result?.protocolVersion === "2025-11-25",
      "a 2025-era initialize is answered (no MCP-Protocol-Version header sent)",
      JSON.stringify(body));
    // The property that keeps the adapter deletable rather than a second
    // implementation.
    check(!res.headers.get("mcp-session-id"), "and no session id is minted");
  }
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
