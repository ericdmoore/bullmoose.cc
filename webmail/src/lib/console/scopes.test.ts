import { describe, expect, it } from "vitest";
// TEST-ONLY import of the real gate. `scopes.ts` mirrors `hasScope` rather than
// importing it, because a browser bundle must not reach into a Worker package
// (see `types.ts`) — so the mirror's honesty is asserted HERE, against the
// actual function every server-side gate calls. If `auth-core` changes its rule,
// this file fails and the console stops quietly disagreeing with the enforcer.
// Same pattern `JmapClient.test.ts` uses for `@bullmoose/jmap-core`.
import {
  MAIL_SCOPES as REAL_MAIL_SCOPES,
  REALM_SCOPES as REAL_REALM_SCOPES,
  hasScope as realHasScope,
} from "@bullmoose/auth-core";
import {
  CONCRETE_SCOPES,
  MAIL_SCOPES,
  REALM_SCOPES,
  dangerousCombinations,
  effectiveScopes,
  grantWarnings,
  hasScope,
  hiddenScopes,
  intersectEffective,
} from "./scopes";
import type { ConsoleBureauGrant, ConsoleCredential } from "./types";

describe("the mirror agrees with the gate", () => {
  it("mirrors the scope constants exactly", () => {
    expect([...MAIL_SCOPES]).toEqual([...REAL_MAIL_SCOPES]);
    expect([...REALM_SCOPES]).toEqual([...REAL_REALM_SCOPES]);
  });

  it("agrees with the real hasScope on every (granted, required) pair that matters", () => {
    const universe = [...CONCRETE_SCOPES, "mail", "nonsense"];
    // Every singleton, every pair, plus the bundle cases.
    const lists: string[][] = [[], ...universe.map((s) => [s])];
    for (const a of universe) for (const b of universe) lists.push([a, b]);

    let checked = 0;
    for (const granted of lists) {
      for (const required of universe) {
        expect(
          hasScope(granted, required),
          `hasScope(${JSON.stringify(granted)}, ${required})`,
        ).toBe(realHasScope(granted, required));
        checked++;
      }
    }
    // Guard against the loop silently degenerating to nothing.
    expect(checked).toBeGreaterThan(2000);
  });
});

describe("effective permissions", () => {
  it("expands the `mail` bundle — the case a raw chip understates", () => {
    // readme.md §Non-obvious 1: a chip labelled "mail" reads as innocuous while
    // granting send and delete.
    expect(effectiveScopes(["mail"])).toEqual([
      "read",
      "annotate",
      "draft",
      "move",
      "send",
      "delete",
    ]);
    expect(hiddenScopes(["mail"])).toContain("send");
    expect(hiddenScopes(["mail"])).toContain("delete");
  });

  it("does NOT treat `mail` as a wildcard over the realms (common/001)", () => {
    const eff = effectiveScopes(["mail"]);
    expect(eff).not.toContain("contacts");
    expect(eff).not.toContain("calendar");
    // The sharp one: `vault` holds third-party provider credentials.
    expect(eff).not.toContain("vault");
    expect(eff).not.toContain("admin");
  });

  it("applies the one implication: any write capability implies read (common/027)", () => {
    expect(effectiveScopes(["calendar"])).toContain("read");
    expect(effectiveScopes(["move"])).toContain("read");
    // …and stops there. `delete` is not `send`.
    expect(effectiveScopes(["delete"])).not.toContain("send");
  });

  it("denies unknown strings rather than guessing", () => {
    expect(effectiveScopes(["maiil"])).toEqual([]);
  });

  it("intersects token with grant — a grant alone is never the answer", () => {
    // The grant confers send; the token does not hold it.
    expect(intersectEffective(["read"], ["mail"])).toEqual(["read"]);
    expect(intersectEffective(["mail"], ["mail"])).toContain("send");
  });
});

describe("grant warnings", () => {
  it("names the irreversible permissions and the whole-account shape", () => {
    const w = grantWarnings({ scopes: ["mail"], collection: null, expiresAt: null });
    expect(w.join(" ")).toContain("send —");
    expect(w.join(" ")).toContain("delete —");
    expect(w.join(" ")).toContain("whole-account grant");
    expect(w.join(" ")).toContain("no expiry");
    expect(w.join(" ")).toContain("exfiltration path");
  });

  it("stays quiet about what is not there", () => {
    const w = grantWarnings({
      scopes: ["read"],
      collection: "AddressBook",
      expiresAt: Date.now() + 1000,
    });
    expect(w).toEqual([]);
  });
});

// ── combinations ────────────────────────────────────────────────────────────

const cred = (over: Partial<ConsoleCredential>): ConsoleCredential => ({
  name: "aws-mcp",
  kind: "aws-sigv4",
  allow: "https://ce.us-east-1.amazonaws.com",
  header: null,
  scope: "actor",
  enforcement: "narrow",
  createdAt: 0,
  updatedAt: 0,
  meta: {},
  ...over,
});

const bureau = (over: Partial<ConsoleBureauGrant>): ConsoleBureauGrant => ({
  grantId: "bg_1",
  principalId: "p_allen",
  credRef: "aws-mcp",
  verb: "fetch",
  createdBy: "p_eric",
  createdAt: 0,
  expiresAt: null,
  revokedAt: null,
  ...over,
});

const baseInput = {
  allows: ["read"],
  credentials: [] as ConsoleCredential[],
  bureauGrants: [] as ConsoleBureauGrant[],
  sendsWithoutReview: false,
  unrestrictedSenders: false,
  readsUntrustedMail: false,
  now: 1_000_000,
};

describe("dangerous combinations", () => {
  it("finds send + credentialed egress — each half innocuous alone", () => {
    // readme.md §Non-obvious 2: send + external MCP + WebFetch is an
    // exfiltration path even though each part looks fine alone.
    const sendOnly = dangerousCombinations({ ...baseInput, allows: ["read", "send"] });
    expect(sendOnly.find((c) => c.id === "send-plus-egress")).toBeUndefined();

    const egressOnly = dangerousCombinations({
      ...baseInput,
      credentials: [cred({})],
      bureauGrants: [bureau({})],
    });
    expect(egressOnly.find((c) => c.id === "send-plus-egress")).toBeUndefined();

    const both = dangerousCombinations({
      ...baseInput,
      allows: ["read", "send"],
      credentials: [cred({})],
      bureauGrants: [bureau({})],
      readsUntrustedMail: true,
    });
    const finding = both.find((c) => c.id === "send-plus-egress");
    expect(finding?.severity).toBe("critical");
    expect(finding?.ingredients.length).toBe(3);
    expect(finding?.consequence).toContain("prompt injection");
  });

  it("does not fire on a REVOKED or EXPIRED bureau grant", () => {
    const revoked = dangerousCombinations({
      ...baseInput,
      allows: ["send"],
      credentials: [cred({})],
      bureauGrants: [bureau({ revokedAt: 500_000 })],
    });
    expect(revoked.find((c) => c.id === "send-plus-egress")).toBeUndefined();

    const expired = dangerousCombinations({
      ...baseInput,
      allows: ["send"],
      credentials: [cred({})],
      bureauGrants: [bureau({ expiresAt: 500_000 })],
    });
    expect(expired.find((c) => c.id === "send-plus-egress")).toBeUndefined();
  });

  it("surfaces enforcement=broad as 'only our code enforces this' (bureau.md §5.2)", () => {
    const out = dangerousCombinations({
      ...baseInput,
      credentials: [cred({ enforcement: "broad" })],
      bureauGrants: [bureau({})],
    });
    const f = out.find((c) => c.id === "broad-enforcement:aws-mcp");
    expect(f).toBeDefined();
    expect(f?.consequence).toContain("Rung 3");
    expect(f?.title).toContain("only our own code narrows it");

    // A federated credential is rung 1 and must NOT be flagged.
    const fed = dangerousCombinations({
      ...baseInput,
      credentials: [cred({ enforcement: "federated" })],
      bureauGrants: [bureau({})],
    });
    expect(fed.find((c) => c.id.startsWith("broad-enforcement"))).toBeUndefined();
  });

  it("emits ONE finding per credential, not one per verb held on it", () => {
    // Found by driving the built page: `aws-mcp` held with `fetch` AND
    // `sign_sigv4` printed the same warning twice, which is how a panel trains
    // people to skim it.
    const out = dangerousCombinations({
      ...baseInput,
      credentials: [cred({ enforcement: "broad", allow: "https://*.amazonaws.com" })],
      bureauGrants: [
        bureau({ grantId: "bg_1", verb: "fetch" }),
        bureau({ grantId: "bg_2", verb: "sign_sigv4" }),
      ],
    });
    expect(out.filter((c) => c.id === "broad-enforcement:aws-mcp")).toHaveLength(1);
    expect(new Set(out.map((c) => c.id)).size).toBe(out.length);
    // …and it names both verbs rather than dropping one.
    const f = out.find((c) => c.id === "broad-enforcement:aws-mcp");
    expect(f?.ingredients.join(" ")).toContain("`fetch` and `sign_sigv4`");
  });

  it("renders a wildcard destination as the widening it is (§6.4)", () => {
    const out = dangerousCombinations({
      ...baseInput,
      credentials: [cred({ allow: "https://*.amazonaws.com" })],
      bureauGrants: [bureau({})],
    });
    expect(out.find((c) => c.id === "wildcard-allow:aws-mcp")).toBeDefined();
  });

  it("calls an unbound credential dead weight, not exposure (fails closed, §6.5)", () => {
    const out = dangerousCombinations({
      ...baseInput,
      credentials: [cred({ allow: null })],
      bureauGrants: [bureau({})],
    });
    const f = out.find((c) => c.id === "unbound-credential:aws-mcp");
    expect(f?.consequence).toContain("fails closed");
    expect(f?.consequence).toContain("dead weight rather than exposure");
  });

  it("flags send-without-review only when the sender allowlist is also absent", () => {
    const guarded = dangerousCombinations({ ...baseInput, sendsWithoutReview: true });
    expect(guarded.find((c) => c.id === "send-without-allowlist")).toBeUndefined();
    const open = dangerousCombinations({
      ...baseInput,
      sendsWithoutReview: true,
      unrestrictedSenders: true,
    });
    expect(open.find((c) => c.id === "send-without-allowlist")?.severity).toBe("critical");
  });

  it("says nothing when there is nothing to say", () => {
    expect(dangerousCombinations(baseInput)).toEqual([]);
  });
});
