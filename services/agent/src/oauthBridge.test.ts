import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import { audienceMatches, introspect, isLocalToken, principalFromProps } from "./oauthBridge";

// s02 T4 — the bridge. Two credential systems meet at exactly one point, and
// these pin what may and may not cross it.

const RESOURCE = "https://mcp.bullmoose.cc/mcp";

describe("audience binding (RFC 8707)", () => {
  it("1. accepts a token minted for THIS resource", () => {
    expect(audienceMatches(RESOURCE, RESOURCE)).toBe(true);
    expect(audienceMatches([RESOURCE], RESOURCE)).toBe(true);
  });

  it("2. REFUSES a token minted for another resource — the replay this exists to stop", () => {
    expect(audienceMatches("https://someone-else.example/mcp", RESOURCE)).toBe(false);
  });

  it("3. refuses an ABSENT audience rather than waving it through", () => {
    // `resource` is optional on the wire, so "no audience" is a token that
    // may have been minted for anything. Our AS pins it on every grant, so a
    // token from our own issuer always has one.
    expect(audienceMatches(undefined, RESOURCE)).toBe(false);
    expect(audienceMatches(null, RESOURCE)).toBe(false);
    expect(audienceMatches([], RESOURCE)).toBe(false);
  });

  it("4. is exact — a prefix or origin match is not enough", () => {
    expect(audienceMatches("https://mcp.bullmoose.cc", RESOURCE)).toBe(false);
    expect(audienceMatches("https://mcp.bullmoose.cc/mcp/extra", RESOURCE)).toBe(false);
    expect(audienceMatches("https://mcp.bullmoose.cc.evil.test/mcp", RESOURCE)).toBe(false);
  });

  it("5. accepts a multi-audience token that includes us", () => {
    expect(audienceMatches([ "https://other.example/mcp", RESOURCE ], RESOURCE)).toBe(true);
  });

  it("6. ignores non-string entries rather than coercing them", () => {
    expect(audienceMatches([null, 42, {}], RESOURCE)).toBe(false);
  });
});

function world() {
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: "a_eric",
    tenantId: "t_bm",
    principalId: "p_eric",
    loginEmail: "eric@bullmoose.cc",
    displayName: "Eric",
  });
  return w;
}

describe("principalFromProps — what the grant may become", () => {
  it("10. rebuilds the principal the AS authenticated", async () => {
    const w = world();
    const p = await principalFromProps(w.env, { principalId: "p_eric" }, ["read"]);
    expect(p?.username).toBe("eric@bullmoose.cc");
    expect(p?.accounts.map((a) => a.accountId)).toEqual(["a_eric"]);
  });

  it("11. carries the GRANT's scopes, not the human's full authority", async () => {
    // The escalation this prevents: the owner could have granted `mail`, but
    // this app was granted `read`, and it stays `read`.
    const w = world();
    const p = await principalFromProps(w.env, { principalId: "p_eric" }, ["read"]);
    expect(p?.scopes).toEqual(["read"]);
  });

  it("12. refuses props with no principalId — nothing to become", async () => {
    const w = world();
    expect(await principalFromProps(w.env, {}, ["read"])).toBeNull();
    expect(await principalFromProps(w.env, undefined, ["read"])).toBeNull();
  });

  it("13. refuses a non-string principalId rather than coercing it", async () => {
    const w = world();
    expect(await principalFromProps(w.env, { principalId: 42 }, ["read"])).toBeNull();
    expect(await principalFromProps(w.env, { principalId: { toString: () => "p_eric" } }, ["read"])).toBeNull();
  });

  it("14. refuses a principal that no longer exists — deleting a human revokes their apps", async () => {
    const w = world();
    expect(await principalFromProps(w.env, { principalId: "p_ghost" }, ["read"])).toBeNull();
  });

  it("15. re-derives the account list from D1 on every call, never from the token", async () => {
    // A share revoked after the token was minted must stop working now, not
    // when the token happens to expire.
    const w = world();
    const before = await principalFromProps(w.env, { principalId: "p_eric" }, ["read"]);
    expect(before?.accounts).toHaveLength(1);
    w.db.query(`UPDATE accounts SET deleted_at = 1 WHERE id = 'a_eric'`);
    const after = await principalFromProps(w.env, { principalId: "p_eric" }, ["read"]);
    expect(after?.accounts).toHaveLength(0);
  });

  it("16. an empty grant authorizes nothing rather than everything", async () => {
    const w = world();
    const p = await principalFromProps(w.env, { principalId: "p_eric" }, []);
    expect(p?.scopes).toEqual([]);
  });
});

// The validation hop. OAUTH_KV is bound to the AS and nowhere else — the same
// discipline as the Bureau's master key — so this worker asks rather than
// looks. Most of what follows is about that hop failing SAFELY: an AS outage
// turning into an authorization bypass is the classic fail-open bug, and it
// stays invisible until someone goes looking for it.
function fakeAS(handler: (req: Request) => Response): Fetcher {
  return {
    fetch: (input: RequestInfo, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))),
  } as unknown as Fetcher;
}

const okAS = (props: Record<string, unknown>) =>
  fakeAS(() => new Response(JSON.stringify({ active: true, props })));

describe("credential dispatch", () => {
  it("20. a bm_ token is local and never reaches the AS", () => {
    expect(isLocalToken("bm_abc.def")).toBe(true);
  });

  it("21. anything else is an OAuth token", () => {
    expect(isLocalToken("eyJhbGciOi")).toBe(false);
    expect(isLocalToken("")).toBe(false);
  });
});

describe("introspect — fails CLOSED, always", () => {
  it("30. returns the grant when the AS says the token is active", async () => {
    const got = await introspect(okAS({ principalId: "p_eric", scope: ["read", "calendar"] }), "tok", RESOURCE);
    expect(got?.props.principalId).toBe("p_eric");
    expect(got?.scopes).toEqual(["read", "calendar"]);
  });

  it("30b. addresses the AS AT the canonical resource URI — not at a path on its own host", async () => {
    // Load-bearing, and it cost a production debugging session to learn.
    // The provider decides "which resource server am I" from the REQUEST URL
    // (oauth-provider.js:2694) and refuses a token whose audience does not
    // match it. Our tokens are correctly bound to the MCP resource, so asking
    // at auth.bullmoose.cc/introspect refused EVERY token we mint. The service
    // binding routes to the AS whatever the URL says, so we address it as the
    // resource and the audience check passes on its merits rather than being
    // switched off. Change this URL and every OAuth call 401s.
    let seen = null;
    const as = fakeAS((req) => {
      seen = req.url;
      return new Response(JSON.stringify({ active: true, props: { principalId: "p" } }));
    });
    await introspect(as, "tok", RESOURCE);
    expect(seen).toBe(RESOURCE);
  });

  it("31. forwards the token as a bearer, so the AS validates the real credential", async () => {
    let seen: string | null = null;
    const as = fakeAS((req) => {
      seen = req.headers.get("authorization");
      return new Response(JSON.stringify({ active: true, props: { principalId: "p" } }));
    });
    await introspect(as, "tok-123", RESOURCE);
    expect(seen).toBe("Bearer tok-123");
  });

  it("32. refuses when the AS is DOWN — never falls through to a weaker check", async () => {
    const as = fakeAS(() => {
      throw new Error("connection refused");
    });
    expect(await introspect(as, "tok", RESOURCE)).toBeNull();
  });

  it("33. refuses on a non-2xx", async () => {
    expect(await introspect(fakeAS(() => new Response("nope", { status: 401 })), "tok", RESOURCE)).toBeNull();
    expect(await introspect(fakeAS(() => new Response("boom", { status: 500 })), "tok", RESOURCE)).toBeNull();
  });

  it("34. refuses on a malformed body rather than guessing", async () => {
    expect(await introspect(fakeAS(() => new Response("not json")), "tok", RESOURCE)).toBeNull();
  });

  it("35. refuses when the AS says active:false", async () => {
    const as = fakeAS(() => new Response(JSON.stringify({ active: false, props: { principalId: "p_eric" } })));
    expect(await introspect(as, "tok", RESOURCE)).toBeNull();
  });

  it("36. refuses a truthy-but-not-true active, rather than coercing", async () => {
    const as = fakeAS(() => new Response(JSON.stringify({ active: "yes", props: { principalId: "p_eric" } })));
    expect(await introspect(as, "tok", RESOURCE)).toBeNull();
  });

  it("37. treats an absent scope list as an EMPTY grant, not an unlimited one", async () => {
    const got = await introspect(okAS({ principalId: "p_eric" }), "tok", RESOURCE);
    expect(got?.scopes).toEqual([]);
  });

  it("38. drops non-string scope entries instead of passing them to the gate", async () => {
    const got = await introspect(okAS({ principalId: "p_eric", scope: ["read", 42, null] }), "tok", RESOURCE);
    expect(got?.scopes).toEqual(["read"]);
  });

  it("39. a valid hop still cannot invent a principal that does not exist", async () => {
    // Defence in depth: even a compromised AS answering active:true for a
    // made-up principal produces nothing, because the reach is D1's answer.
    const w = fakeEnv();
    const grant = await introspect(okAS({ principalId: "p_ghost", scope: ["read"] }), "tok", RESOURCE);
    expect(await principalFromProps(w.env, grant!.props, grant!.scopes)).toBeNull();
  });
});
