import { describe, expect, it } from "vitest";
import {
  OriginRefusal,
  SECRET_FIELDS,
  carriesSecret,
  normalizeOrigin,
  readBase,
  resolveTarget,
} from "./origins";

const SITE = "https://mail.bullmoose.cc";
const VAULT = "https://agent.bullmoose.cc";

describe("normalizeOrigin", () => {
  it("reduces a base to its origin", () => {
    expect(normalizeOrigin("https://agent.bullmoose.cc/vault/")).toBe(VAULT);
    expect(normalizeOrigin("https://agent.bullmoose.cc:8443")).toBe(
      "https://agent.bullmoose.cc:8443",
    );
  });

  it("reads blank/garbage as NOT CONFIGURED rather than falling back", () => {
    // The dangerous default this exists to prevent: an empty base collapsing to
    // the current page's origin, which would route a secret through the site.
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin("   ")).toBeNull();
    expect(normalizeOrigin(undefined)).toBeNull();
    expect(normalizeOrigin(null)).toBeNull();
    expect(normalizeOrigin("/vault/credentials")).toBeNull();
    expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
    expect(normalizeOrigin("file:///etc/passwd")).toBeNull();
  });
});

describe("carriesSecret declares rather than sniffs", () => {
  it("is true for every declared secret field", () => {
    for (const f of SECRET_FIELDS) expect(carriesSecret({ [f]: "x" })).toBe(true);
  });
  it("is false for metadata bodies", () => {
    expect(carriesSecret({ name: "aws-mcp", kind: "api-key" })).toBe(false);
    expect(carriesSecret(undefined)).toBe(false);
    expect(carriesSecret(null)).toBe(false);
  });
  it("is true even when the value is empty — the FIELD is the declaration", () => {
    expect(carriesSecret({ secret: "" })).toBe(true);
  });
});

describe("resolveTarget — the T2 boundary", () => {
  it("addresses a secret-bearing request at the vault origin", () => {
    expect(resolveTarget({ vault: VAULT, site: SITE }, "/vault/credentials", "secret")).toBe(
      `${VAULT}/vault/credentials`,
    );
  });

  it("REFUSES when the vault origin is the site's own origin", () => {
    // The exact misconfiguration the rule is about: a "direct POST" that is a
    // POST to the site backend wearing a different name.
    expect(() =>
      resolveTarget({ vault: SITE, site: SITE }, "/vault/credentials", "secret"),
    ).toThrow(OriginRefusal);
    try {
      resolveTarget({ vault: SITE, site: SITE }, "/vault/credentials", "secret");
    } catch (err) {
      expect(String(err)).toContain("this site's own origin");
    }
  });

  it("REFUSES when no vault origin is configured — fail closed, not fall back", () => {
    expect(() => resolveTarget({ vault: "", site: SITE }, "/vault/credentials", "secret")).toThrow(
      OriginRefusal,
    );
    // …and points at the flow that is safe today.
    try {
      resolveTarget({ vault: "", site: SITE }, "/vault/credentials", "secret");
    } catch (err) {
      expect(String(err)).toContain("bullmoose creds set");
    }
  });

  it("REFUSES an absolute path that escapes the vault origin", () => {
    expect(() =>
      resolveTarget({ vault: VAULT, site: SITE }, "https://mail.bullmoose.cc/steal", "secret"),
    ).toThrow(OriginRefusal);
    expect(() =>
      resolveTarget({ vault: VAULT, site: SITE }, "//mail.bullmoose.cc/steal", "secret"),
    ).toThrow(OriginRefusal);
  });

  it("still routes metadata to the vault when one is configured", () => {
    expect(resolveTarget({ vault: VAULT, site: SITE }, "/console/agents", "metadata")).toBe(
      `${VAULT}/console/agents`,
    );
  });

  it("lets a metadata read fall back to the site origin when no vault is set", () => {
    // Reads carry nothing and can return nothing sensitive (bureau.md
    // invariant 1), so an unconfigured vault degrades rather than refusing.
    expect(resolveTarget({ vault: "", site: SITE }, "/console/agents", "metadata")).toBe(
      `${SITE}/console/agents`,
    );
  });
});

describe("readBase — which worker answers, as distinct from what may travel", () => {
  const origins = { vault: VAULT, site: SITE };

  it("sends /vault/* to the vault, always", () => {
    expect(
      resolveTarget(readBase(origins, "/vault/credentials"), "/vault/credentials", "metadata"),
    ).toBe(`${VAULT}/vault/credentials`);
  });

  it("sends the four /console/* reads to the SITE backend even with a vault configured", () => {
    // The regression this exists for: T2 requires a vault origin before a
    // credential may be touched, and `resolveTarget` alone would then send every
    // console read to a worker that neither serves them nor sends CORS headers —
    // breaking the console for exactly the operators who configured it.
    for (const path of [
      "/console/agents",
      "/console/agents/acct_allen",
      "/console/accounts/acct_allen/resources",
      "/console/resources/AddressBook/ab_vendors?at=1&since=0&accountId=acct_eric",
    ]) {
      expect(new URL(resolveTarget(readBase(origins, path), path, "metadata")).origin).toBe(SITE);
    }
  });

  it("never widens the secret rule — it only ever removes the vault, never adds one", () => {
    // A secret-bearing request goes through `resolveTarget(origins, …)`
    // directly (credentials.ts), but if one ever came through here it must
    // still refuse rather than silently address the site.
    expect(() =>
      resolveTarget(readBase(origins, "/console/agents"), "/console/agents", "secret"),
    ).toThrow(OriginRefusal);
  });
});
