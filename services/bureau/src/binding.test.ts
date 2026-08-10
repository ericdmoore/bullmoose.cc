import { describe, expect, it } from "vitest";
import {
  destinationAllowed,
  parseAllowEntry,
  parseDestination,
  parseHeaderRecipe,
  readAllowlist,
  renderHeaderValue,
  verbPermittedForKind,
  VERBS_BY_KIND,
} from "./binding";

/**
 * T3 — the two pure gates, tested adversarially (bureau.md §4.1, §6).
 *
 * §6 says destination binding is "the primary control" and then lists six
 * details that decide "whether it actually holds". Five of them are decidable
 * without any I/O, so they are tested here, exhaustively and in microseconds,
 * rather than through a worker. The sixth — redirects — needs a live response
 * and lives in `fetchVerb.test.ts`.
 *
 * The bias throughout is toward the REFUSALS. A destination binding that accepts
 * the right host is a feature; one that refuses every near-miss is the control.
 */

const allow = (...raw: string[]) => {
  const list = readAllowlist({ allow: raw.length === 1 ? raw[0] : raw });
  if (!list.ok) throw new Error(`test fixture is not a valid allowlist: ${list.reason}`);
  return list.entries;
};

const permits = (entries: ReturnType<typeof allow>, url: string) =>
  destinationAllowed(new URL(url), entries);

describe("§4.1 — a verb is permitted only if it matches the credential's kind", () => {
  it("types each kind to its documented verb set", () => {
    expect(VERBS_BY_KIND).toEqual({
      "api-key": ["fetch"],
      "oauth-refresh": ["oauth_token", "fetch"],
      "aws-sigv4": ["sign_sigv4", "fetch"],
      "hmac-key": ["hmac_sha256"],
    });
  });

  it("refuses generic HMAC against an AWS secret — the whole reason kind exists", () => {
    // If a caller can compute HMAC(kSecret, anything) they can walk
    // kDate → kRegion → kService → kSigning and forge any SigV4 signature for
    // the account. The verb is narrower than a closure; the defect is identical.
    expect(verbPermittedForKind("aws-sigv4", "hmac_sha256")).toBe(false);
    expect(verbPermittedForKind("aws-sigv4", "sign_sigv4")).toBe(true);
  });

  it("keeps hmac-key off the proxy, and every other kind off hmac", () => {
    expect(verbPermittedForKind("hmac-key", "fetch")).toBe(false);
    for (const kind of ["api-key", "oauth-refresh", "aws-sigv4"]) {
      expect(verbPermittedForKind(kind, "hmac_sha256"), kind).toBe(false);
    }
  });

  it("permits fetch for exactly the three bearer-shaped kinds", () => {
    expect(verbPermittedForKind("api-key", "fetch")).toBe(true);
    expect(verbPermittedForKind("oauth-refresh", "fetch")).toBe(true);
    expect(verbPermittedForKind("aws-sigv4", "fetch")).toBe(true);
  });

  it("permits nothing at all for a kind it does not recognise", () => {
    // A row minted by a future version of the mint path is not a row this
    // version understands. "Understand it later" is the safe direction.
    for (const verb of ["fetch", "oauth_token", "sign_sigv4", "hmac_sha256"]) {
      expect(verbPermittedForKind("some-future-kind", verb), verb).toBe(false);
      expect(verbPermittedForKind("", verb), verb).toBe(false);
    }
  });
});

describe("§6.2 — the allowlist matches scheme+host+port exactly, never substring", () => {
  it("admits the exact origin, at any path or query", () => {
    const entries = allow("https://api.stripe.com");
    expect(permits(entries, "https://api.stripe.com/v1/charges")).toBe(true);
    expect(permits(entries, "https://api.stripe.com/?q=1#frag")).toBe(true);
    expect(permits(entries, "https://API.Stripe.COM/v1")).toBe(true); // URL lowercases
  });

  it("refuses the classic startsWith bug", () => {
    // startsWith("https://api.stripe.com") would accept every line below.
    const entries = allow("https://api.stripe.com");
    expect(permits(entries, "https://api.stripe.com.evil.com/v1")).toBe(false);
    expect(permits(entries, "https://api.stripe.com.attacker.io/v1")).toBe(false);
    expect(permits(entries, "https://api.stripe.computer.io/v1")).toBe(false);
    expect(permits(entries, "https://api.stripe.com-evil.io/v1")).toBe(false);
  });

  it("refuses the classic substring bug", () => {
    // A substring test for "api.stripe.com" would accept both of these.
    const entries = allow("https://api.stripe.com");
    expect(permits(entries, "https://evil.com/?x=api.stripe.com")).toBe(false);
    expect(permits(entries, "https://evil.com/api.stripe.com/v1")).toBe(false);
  });

  it("refuses a subdomain, a parent, and a sibling of an exact entry", () => {
    const entries = allow("https://api.stripe.com");
    expect(permits(entries, "https://evil.api.stripe.com/v1")).toBe(false);
    expect(permits(entries, "https://stripe.com/v1")).toBe(false);
    expect(permits(entries, "https://files.stripe.com/v1")).toBe(false);
  });

  it("refuses a scheme mismatch in both directions", () => {
    expect(permits(allow("https://api.stripe.com"), "http://api.stripe.com/v1")).toBe(false);
    expect(permits(allow("http://localhost:8787"), "https://localhost:8787/v1")).toBe(false);
  });

  it("refuses a port mismatch, and treats the default port as written or omitted", () => {
    const entries = allow("https://api.stripe.com");
    expect(permits(entries, "https://api.stripe.com:443/v1")).toBe(true); // 443 IS the default
    expect(permits(entries, "https://api.stripe.com:8443/v1")).toBe(false);
    expect(permits(entries, "https://api.stripe.com:80/v1")).toBe(false);

    const pinned = allow("https://api.stripe.com:8443");
    expect(permits(pinned, "https://api.stripe.com:8443/v1")).toBe(true);
    expect(permits(pinned, "https://api.stripe.com/v1")).toBe(false);
  });

  it("refuses hosts that only LOOK like the allowlisted one after IDNA", () => {
    // `。` is the ideographic full stop; WHATWG normalizes it to a real dot, so
    // this is `api.stripe.com.evil.io` by the time anything compares it. The
    // point is that the comparison happens AFTER normalization — matching the
    // raw string would have accepted it.
    const entries = allow("https://api.stripe.com");
    expect(permits(entries, "https://api.stripe.com。evil.io/v1")).toBe(false);
    expect(permits(allow("https://*.stripe.com"), "https://api.stripe.com。evil.io/v1")).toBe(false);
    // The same normalization the other way: a fullwidth spelling of the allowed
    // host IS the allowed host, and refusing it would be a bug, not a control.
    expect(permits(entries, "https://ＡＰＩ.stripe.com/v1")).toBe(true);
    // A trailing empty label is a different name, not the same one.
    expect(permits(entries, "https://api.stripe.com../v1")).toBe(false);
  });

  it("refuses the userinfo trick, which parses to an origin nobody read", () => {
    // `https://api.stripe.com@evil.com/` LOOKS allowlisted to a human and
    // parses to host `evil.com`. Two layers refuse it: the URL never matches,
    // and `parseDestination` rejects userinfo outright.
    const entries = allow("https://api.stripe.com");
    expect(permits(entries, "https://api.stripe.com@evil.com/v1")).toBe(false);
    expect(parseDestination("https://api.stripe.com@evil.com/v1").ok).toBe(false);
  });
});

describe("§6.4 — wildcards are a deliberate widening, and only a suffix", () => {
  it("admits any subdomain of the suffix", () => {
    const entries = allow("https://*.amazonaws.com");
    expect(permits(entries, "https://ce.us-east-1.amazonaws.com/")).toBe(true);
    expect(permits(entries, "https://email.us-east-1.amazonaws.com/v2/email")).toBe(true);
  });

  it("still refuses a look-alike that merely CONTAINS the suffix", () => {
    const entries = allow("https://*.stripe.com");
    // The dot must be a real label boundary. `api.stripe.com.evil.io` ends with
    // `.evil.io`; `.stripe.com` appears only in the middle, where nothing looks.
    expect(permits(entries, "https://api.stripe.com.evil.io/v1")).toBe(false);
    expect(permits(entries, "https://evil-stripe.com/v1")).toBe(false);
    expect(permits(entries, "https://xstripe.com/v1")).toBe(false);
  });

  it("does not admit the apex, and does not admit an empty label", () => {
    const entries = allow("https://*.amazonaws.com");
    expect(permits(entries, "https://amazonaws.com/")).toBe(false);
    expect(permits(entries, "https://.amazonaws.com/")).toBe(false);
  });

  it("binds the wildcard's scheme and default port too", () => {
    const entries = allow("https://*.amazonaws.com");
    expect(permits(entries, "http://ce.us-east-1.amazonaws.com/")).toBe(false);
    expect(permits(entries, "https://ce.us-east-1.amazonaws.com:8443/")).toBe(false);
  });

  it("refuses a wildcard too broad to mean anything", () => {
    // `*.com` and a bare `*` are policies nobody should be able to write down.
    expect(parseAllowEntry("*.com")).toBeNull();
    expect(parseAllowEntry("*")).toBeNull();
    expect(parseAllowEntry("https://*")).toBeNull();
    expect(parseAllowEntry("*.*.com")).toBeNull();
    // A wildcard in the middle is not a wildcard form at all.
    expect(parseAllowEntry("https://api.*.com")).toBeNull();
  });
});

describe("§6.5 / invariant 5 — no allowlist means unusable", () => {
  it("fails closed on absent, empty and blank allowlists", () => {
    for (const meta of [{}, { allow: undefined }, { allow: null }, { allow: "" }, { allow: [] }, { allow: "   " }]) {
      const list = readAllowlist(meta as Record<string, unknown>);
      expect(list.ok, JSON.stringify(meta)).toBe(false);
    }
  });

  it("fails closed on a non-string allowlist", () => {
    expect(readAllowlist({ allow: 1 }).ok).toBe(false);
    expect(readAllowlist({ allow: { host: "api.stripe.com" } }).ok).toBe(false);
    expect(readAllowlist({ allow: true }).ok).toBe(false);
  });

  it("poisons the whole list on one malformed entry rather than silently narrowing", () => {
    // Skipping the bad entry would leave a credential that still worked, for one
    // host, and the operator who typo'd the other would never learn.
    const list = readAllowlist({ allow: ["https://api.stripe.com", "ftp://files.stripe.com"] });
    expect(list.ok).toBe(false);
    expect(list.ok === false && list.reason).toMatch(/unparseable/);
  });

  it("refuses a non-http scheme anywhere", () => {
    for (const raw of ["ftp://f.stripe.com", "file:///etc/passwd", "javascript:alert(1)"]) {
      expect(parseAllowEntry(raw), raw).toBeNull();
    }
    for (const raw of ["ftp://f.stripe.com", "file:///etc/passwd", "data:text/plain,x"]) {
      expect(parseDestination(raw).ok, raw).toBe(false);
    }
  });

  it("accepts a multi-entry allowlist and binds each entry independently", () => {
    const entries = allow("https://api.stripe.com", "https://*.amazonaws.com");
    expect(permits(entries, "https://api.stripe.com/v1")).toBe(true);
    expect(permits(entries, "https://ce.us-east-1.amazonaws.com/")).toBe(true);
    expect(permits(entries, "https://api.amazonaws.com.evil.io/")).toBe(false);
  });
});

describe("invariant 8 — the recipe can only produce a header", () => {
  it("parses a name and a value template with the {} slot", () => {
    expect(parseHeaderRecipe("Authorization: Bearer {}")).toEqual({
      name: "Authorization",
      template: "Bearer {}",
    });
    expect(parseHeaderRecipe("X-Api-Key: {}")).toEqual({ name: "X-Api-Key", template: "{}" });
  });

  it("refuses anything that is not a header recipe", () => {
    for (const raw of [
      undefined,
      null,
      42,
      "",
      "no-colon-here {}",
      "Authorization: Bearer", // no slot: nothing to inject into
      ": Bearer {}", // no name
      "Bad Header: {}", // space is not a field-name token character
      "?key={}", // the query-parameter shape, which must not parse
    ]) {
      expect(parseHeaderRecipe(raw as unknown), String(raw)).toBeNull();
    }
  });

  it("renders every slot, and does not interpret $ patterns inside the secret", () => {
    const recipe = parseHeaderRecipe("X-Sig: {}-{}")!;
    expect(renderHeaderValue(recipe, "abc")).toBe("abc-abc");
    // String.replace would turn `$&` into the matched text and mangle the key
    // into something that looks like a wrong credential rather than a bug here.
    expect(renderHeaderValue(parseHeaderRecipe("X-K: {}")!, "a$&b$'c")).toBe("a$&b$'c");
  });

  it("refuses a rendered value carrying a line break", () => {
    expect(renderHeaderValue(parseHeaderRecipe("X-K: {}")!, "abc\r\nX-Evil: 1")).toBeNull();
  });
});
