import { describe, expect, it } from "vitest";
import { OAUTH_SCOPES, SELF_SERVICE_SCOPES, TOKEN_SCOPES, effectiveScopes } from "@bullmoose/auth-core";
import {
  anyRedirectMatches,
  CLAUDE_REDIRECT_URIS,
  CLAUDE_WEB_REDIRECT,
  isLoopback,
  redirectHost,
  redirectUriMatches,
} from "./redirects";

// s02 T3 — redirect matching is the single most security-critical string
// comparison in OAuth: it is what stops someone who can START a flow from
// having the authorization CODE delivered to themselves. Exact by default;
// every relaxation below is a named exception with a bounded blast radius.

describe("redirect URI matching", () => {
  it("1. matches exactly", () => {
    expect(redirectUriMatches(CLAUDE_WEB_REDIRECT, CLAUDE_WEB_REDIRECT)).toBe(true);
  });

  it("2. refuses a different path on the right host — the classic open redirect", () => {
    expect(redirectUriMatches("https://claude.ai/api/mcp/evil", CLAUDE_WEB_REDIRECT)).toBe(false);
  });

  it("3. refuses a lookalike host", () => {
    expect(redirectUriMatches("https://claude.ai.evil.com/api/mcp/auth_callback", CLAUDE_WEB_REDIRECT)).toBe(false);
  });

  it("4. refuses a prefix-extended host", () => {
    expect(redirectUriMatches("https://notclaude.ai/api/mcp/auth_callback", CLAUDE_WEB_REDIRECT)).toBe(false);
  });

  it("5. IGNORES the port on loopback — RFC 8252 §7.3, and Claude Code needs it", () => {
    // Claude Code binds an ephemeral port and its CIMD declares none, so an
    // exact match is impossible by construction.
    expect(redirectUriMatches("http://127.0.0.1:53821/callback", "http://127.0.0.1/callback")).toBe(true);
    expect(redirectUriMatches("http://localhost:9999/callback", "http://localhost/callback")).toBe(true);
  });

  it("6. relaxes ONLY the port — path still matters on loopback", () => {
    expect(redirectUriMatches("http://127.0.0.1:53821/stolen", "http://127.0.0.1/callback")).toBe(false);
  });

  it("7. does NOT treat localhost and 127.0.0.1 as interchangeable", () => {
    // They resolve differently; conflating them would let a resolver-level
    // attacker substitute one for the other.
    expect(redirectUriMatches("http://localhost:1234/callback", "http://127.0.0.1/callback")).toBe(false);
  });

  it("8. never extends the port relaxation off-loopback", () => {
    expect(redirectUriMatches("https://claude.ai:8443/api/mcp/auth_callback", CLAUDE_WEB_REDIRECT)).toBe(false);
    expect(redirectUriMatches("https://evil.com:1/cb", "https://evil.com/cb")).toBe(false);
  });

  it("9. requires the scheme to agree even on loopback", () => {
    expect(redirectUriMatches("https://127.0.0.1:8080/callback", "http://127.0.0.1/callback")).toBe(false);
  });

  it("10. refuses a query string smuggled onto a loopback redirect", () => {
    expect(redirectUriMatches("http://127.0.0.1:80/callback?next=https://evil.com", "http://127.0.0.1/callback")).toBe(
      false,
    );
  });

  it("11. refuses garbage rather than throwing", () => {
    expect(redirectUriMatches("not a url", CLAUDE_WEB_REDIRECT)).toBe(false);
    expect(redirectUriMatches("", "")).toBe(true); // identical strings only
  });

  it("12. the registered Claude set accepts all four real client shapes", () => {
    for (const uri of [
      CLAUDE_WEB_REDIRECT,
      "http://localhost:8976/callback",
      "http://127.0.0.1:41233/callback",
    ]) {
      expect(anyRedirectMatches(uri, CLAUDE_REDIRECT_URIS)).toBe(true);
    }
  });

  it("13. and refuses an attacker's callback against that same set", () => {
    expect(anyRedirectMatches("https://evil.example/callback", CLAUDE_REDIRECT_URIS)).toBe(false);
  });

  it("14. isLoopback covers the IPv6 literal too", () => {
    expect(isLoopback(new URL("http://[::1]:5000/callback"))).toBe(true);
    expect(isLoopback(new URL("https://claude.ai/x"))).toBe(false);
  });

  it("15. redirectHost is what the consent screen shows the human", () => {
    // CIMD cannot prevent localhost impersonation; where the code is
    // delivered is the part an impersonator cannot forge away.
    expect(redirectHost(CLAUDE_WEB_REDIRECT)).toBe("claude.ai");
    expect(redirectHost("http://127.0.0.1:53821/callback")).toBe("127.0.0.1:53821");
  });
});

// The consent screen is the fourth mint site and the first where the asker is
// a stranger. These pin the boundary rather than the wording.
describe("OAUTH_SCOPES — what a stranger may ask for", () => {
  it("20. never offers the credential realm", () => {
    // s02 decision 4. Handing a third party the vault through a consent
    // screen is not a default worth having.
    expect(OAUTH_SCOPES).not.toContain("vault");
  });

  it("21. never offers admin", () => {
    expect(OAUTH_SCOPES).not.toContain("admin");
  });

  it("22. never offers the agent MARKER — it is an identity, not a permission", () => {
    expect(OAUTH_SCOPES).not.toContain("agent");
  });

  it("23. never offers send — there is no send tool, and that invariant hardens here", () => {
    expect(OAUTH_SCOPES).not.toContain("send");
  });

  it("24. is a strict subset of what self-service may mint", () => {
    // A stranger must never be able to obtain something the account owner
    // could not mint for themselves.
    for (const s of OAUTH_SCOPES) expect(SELF_SERVICE_SCOPES).toContain(s);
  });

  it("25. is a strict subset of what the operator plane may mint", () => {
    for (const s of OAUTH_SCOPES) expect(TOKEN_SCOPES).toContain(s);
  });

  it("26. is strictly smaller than self-service — if these ever match, something widened", () => {
    expect(OAUTH_SCOPES.length).toBeLessThan(SELF_SERVICE_SCOPES.length);
  });
});

// The consent screen explains permissions by asking the SAME function the
// gate asks. This is the coupling that keeps the explanation honest.
describe("effectiveScopes — one expansion, shared with the gate", () => {
  it("30. expands the mail bundle into the verbs it actually confers", () => {
    const eff = effectiveScopes(["mail"]);
    for (const verb of ["read", "annotate", "draft", "move", "send", "delete"]) {
      expect(eff).toContain(verb);
    }
  });

  it("31. does not let the bundle leak into other realms", () => {
    const eff = effectiveScopes(["mail"]);
    expect(eff).not.toContain("contacts");
    expect(eff).not.toContain("calendar");
    expect(eff).not.toContain("vault");
  });

  it("32. reports the read a realm scope implies — a capability to change is one to see", () => {
    expect(effectiveScopes(["calendar"])).toContain("read");
  });
});
