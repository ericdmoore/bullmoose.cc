import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import { audienceMatches, principalFromProps } from "./oauthBridge";

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
