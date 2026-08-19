import { describe, expect, it } from "vitest";
import {
  BYOK_EXPLAINER,
  BYOK_WRITE_ONLY_NOTE,
  PLATFORM_KEY_COPY,
  REF_COPY,
  bindingByokView,
  dayLabel,
  hostOf,
  tenantByokView,
  type ByokRefStatus,
  type ByokStatus,
} from "./status";

/**
 * s26 T4 — the BYOK shaping layer. Pure functions, so every sentence the two
 * surfaces print is asserted here rather than inside a rendered component.
 *
 * The load-bearing assertions, in one line each:
 *
 *   REFUSAL   every failure status says the agent REFUSES and does NOT fall
 *             back to the platform key. That is #203's guarantee, and a UI
 *             that let someone assume a quiet fallback would give it away
 *             after the server had kept it.
 *   HEADLINE  a refusal outranks a count in the account summary — "1 key
 *             configured" over three dead agents is the reassuring-and-wrong
 *             sentence this surface exists to never print.
 *   NO VALUE  nothing in this module can render a key, because no shape here
 *             has a field one could ride in.
 */

const NOW = Date.parse("2026-08-18T12:00:00Z");
const DAY = 86_400_000;

function status(over: Partial<ByokStatus> = {}): ByokStatus {
  return {
    accountId: "a_eric",
    credentials: [],
    refs: [],
    platformKeyBindings: [],
    keyReadable: false,
    mayWrite: true,
    writeRefusal: null,
    sealableProviders: ["openrouter"],
    ...over,
  };
}

const credential = (over: Partial<ByokStatus["credentials"][number]> = {}) => ({
  credRef: "openrouter",
  kind: "api-key",
  allow: "https://openrouter.ai",
  provider: "openrouter",
  sealedAt: NOW - 3 * DAY,
  rotatedAt: NOW - 3 * DAY,
  grant: { grantId: "bg_1", live: true, createdAt: NOW - 3 * DAY, expiresAt: null, revokedAt: null },
  ...over,
});

const ref = (over: Partial<ByokStatus["refs"][number]> = {}) => ({
  bindingId: "ab_1",
  bindingName: "extractor",
  enabled: true,
  provider: "openrouter",
  credRef: "openrouter",
  status: "live" as ByokRefStatus,
  ...over,
});

describe("the refusal copy", () => {
  const failures = (Object.keys(REF_COPY) as ByokRefStatus[]).filter((s) => s !== "live");

  it("every failure state says the agent REFUSES", () => {
    for (const s of failures) expect(REF_COPY[s].detail).toMatch(/REFUSES/);
  });

  it("every failure state denies a platform-key fallback, in words", () => {
    // The single most important sentence on the page. If a status ever stops
    // saying it, this fails rather than the UI quietly implying the opposite
    // of what models.ts does.
    for (const s of failures) {
      expect(REF_COPY[s].detail.toLowerCase()).toMatch(/(rather than|not) fall(ing)? back|rather than spending/);
    }
  });

  it("every failure state is toned as an error, not a warning — a refusing agent is broken", () => {
    for (const s of failures) expect(REF_COPY[s].tone).toBe("error");
  });

  it("the platform-key case is stated positively, not as an absence", () => {
    expect(PLATFORM_KEY_COPY.detail).toMatch(/platform's provider key/);
    expect(PLATFORM_KEY_COPY.detail).toMatch(/not yours/);
  });

  it("the explainer says the guardrails RIDE the key rather than claiming we implement them", () => {
    const all = BYOK_EXPLAINER.join(" ");
    expect(all).toMatch(/authenticate as YOU/);
    expect(all).toMatch(/does not implement, mirror or read any of it/);
    // And the no-key case, said out loud rather than left to be inferred.
    expect(all).toMatch(/the platform's key and the platform's provider settings/);
  });

  it("the write-only note names the mechanism and rules out a truncated preview", () => {
    expect(BYOK_WRITE_ONLY_NOTE).toMatch(/write-only/);
    expect(BYOK_WRITE_ONLY_NOTE).toMatch(/not even the first few characters/);
  });
});

describe("bindingByokView — one agent's answer to 'whose key pays?'", () => {
  it("a resolving credential reads as the tenant's own", () => {
    const v = bindingByokView(status({ credentials: [credential()], refs: [ref()] }), "ab_1", NOW);
    expect(v.copy).toBe(REF_COPY.live);
    expect(v.host).toBe("openrouter.ai");
    expect(v.sealedLabel).toBe("sealed 3 days ago");
    expect(v.rotatedLabel).toBeNull();
    expect(v.canDetach).toBe(true);
  });

  it("a rotated credential shows both dates — the rotate is the interesting one", () => {
    const v = bindingByokView(
      status({ credentials: [credential({ sealedAt: NOW - 40 * DAY, rotatedAt: NOW - DAY })], refs: [ref()] }),
      "ab_1",
      NOW,
    );
    expect(v.sealedLabel).toBe("sealed 2026-07-09");
    expect(v.rotatedLabel).toBe("rotated yesterday");
  });

  it("a named-but-unresolvable credential is the REFUSING state, not a warning", () => {
    const v = bindingByokView(status({ refs: [ref({ status: "no-credential" })] }), "ab_1", NOW);
    expect(v.copy).toBe(REF_COPY["no-credential"]);
    expect(v.credential).toBeNull();
    // Detach is still offered: it is the one-click way back to a working agent.
    expect(v.canDetach).toBe(true);
  });

  it("a binding that routes to a provider but names nothing reads as the PLATFORM key", () => {
    const v = bindingByokView(
      status({ platformKeyBindings: [{ id: "ab_1", name: "extractor", provider: "openrouter" }] }),
      "ab_1",
      NOW,
    );
    expect(v.copy).toBe(PLATFORM_KEY_COPY);
    expect(v.byokCapable).toBe(true);
    expect(v.canDetach).toBe(false);
  });

  it("a binding with no key-taking route is not BYOK-capable — the section hides rather than lying", () => {
    const v = bindingByokView(status(), "ab_local", NOW);
    expect(v.byokCapable).toBe(false);
    expect(v.ref).toBeNull();
  });

  it("no status at all (an older server) degrades to 'nothing to show'", () => {
    const v = bindingByokView(undefined, "ab_1", NOW);
    expect(v.byokCapable).toBe(false);
    expect(v.credential).toBeNull();
  });
});

describe("tenantByokView — the account summary", () => {
  it("a refusal outranks the count, whatever else is true", () => {
    const v = tenantByokView(
      status({
        credentials: [credential()],
        refs: [ref(), ref({ bindingId: "ab_2", bindingName: "emily", status: "grant-revoked" })],
      }),
      NOW,
    );
    expect(v.summary).toMatch(/1 agent is refusing every model call/);
    expect(v.summary).toMatch(/Nothing falls back to the platform key/);
    expect(v.refusing.map((r) => r.bindingName)).toEqual(["emily"]);
  });

  it("no key + agents that could use one names the platform key explicitly", () => {
    const v = tenantByokView(
      status({ platformKeyBindings: [{ id: "ab_1", name: "extractor", provider: "openrouter" }] }),
      NOW,
    );
    expect(v.summary).toBe(
      "No provider key of your own: 1 agent uses the platform's key and the platform's provider settings.",
    );
  });

  it("no key and no BYOK-capable agent says so without implying anything is wrong", () => {
    expect(tenantByokView(status(), NOW).summary).toBe(
      "No provider key of your own, and no agent that could use one yet.",
    );
  });

  it("a healthy account counts keys and users, and flags anyone still on the platform key", () => {
    const v = tenantByokView(
      status({
        credentials: [credential()],
        refs: [ref()],
        platformKeyBindings: [{ id: "ab_2", name: "emily", provider: "openrouter" }],
      }),
      NOW,
    );
    expect(v.summary).toBe("1 key of your own, used by 1 agent; 1 still on the platform key.");
  });

  it("a sealed key nothing references is visible and labelled, not silently absent", () => {
    // The invisible-live-capability case: granted, spendable the instant an
    // agent names it, and used by nobody.
    const v = tenantByokView(status({ credentials: [credential()] }), NOW);
    expect(v.keys).toHaveLength(1);
    expect(v.keys[0]!.state.label).toBe("not used by any agent");
    expect(v.keys[0]!.usedBy).toEqual([]);
  });

  it("key states mirror the grant's own three ends", () => {
    const revoked = tenantByokView(
      status({
        credentials: [
          credential({ grant: { grantId: "bg_1", live: false, createdAt: 1, expiresAt: null, revokedAt: 9 } }),
        ],
      }),
      NOW,
    );
    expect(revoked.keys[0]!.state.label).toBe("revoked");
    // …and it says the value was NOT deleted, which is the one thing a person
    // could reasonably assume and be wrong about.
    expect(revoked.keys[0]!.state.detail).toMatch(/was not deleted/);

    const expired = tenantByokView(
      status({
        credentials: [
          credential({ grant: { grantId: "bg_1", live: false, createdAt: 1, expiresAt: 5, revokedAt: null } }),
        ],
      }),
      NOW,
    );
    expect(expired.keys[0]!.state.label).toBe("expired");

    const ungranted = tenantByokView(status({ credentials: [credential({ grant: null })] }), NOW);
    expect(ungranted.keys[0]!.state.label).toBe("not authorized");
  });

  it("a credential with no destination is an error state, not a blank field", () => {
    const v = tenantByokView(status({ credentials: [credential({ allow: null })] }), NOW);
    expect(v.keys[0]!.host).toBeNull();
    expect(v.keys[0]!.state).toBe(REF_COPY["no-destination"]);
  });

  it("carries the session's write authority verbatim, so the panel greys rather than offers-then-refuses", () => {
    const v = tenantByokView(
      status({ mayWrite: false, writeRefusal: 'this session does not carry the "vault" scope' }),
    );
    expect(v.mayWrite).toBe(false);
    expect(v.writeRefusal).toMatch(/vault/);
  });

  it("no status at all degrades to an empty, writable-by-nobody view", () => {
    const v = tenantByokView(undefined, NOW);
    expect(v.keys).toEqual([]);
    expect(v.mayWrite).toBe(false);
  });
});

describe("nothing in this module can render a key", () => {
  it("the assembled views serialize to text containing no secret-shaped field", () => {
    const s = status({ credentials: [credential()], refs: [ref()] });
    const text = JSON.stringify([tenantByokView(s, NOW), bindingByokView(s, "ab_1", NOW)]);
    // Field-name level: the wire shape has none of these, so a future addition
    // has to pass this test to arrive.
    for (const forbidden of ["secret", '"key"', "plaintext", "token", "enc_json", "header"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("small derivations", () => {
  it("hostOf strips the scheme and keeps the port", () => {
    expect(hostOf("https://openrouter.ai")).toBe("openrouter.ai");
    expect(hostOf("https://gw.example:8443")).toBe("gw.example:8443");
    // A wildcard allow is not a URL; showing it oddly beats hiding the
    // destination that will actually be enforced.
    expect(hostOf("https://*.example.com")).toBe("*.example.com");
  });

  it("dayLabel is day-grained — a rotation date does not need minutes", () => {
    expect(dayLabel(NOW, NOW)).toBe("today");
    expect(dayLabel(NOW - DAY, NOW)).toBe("yesterday");
    expect(dayLabel(NOW - 6 * DAY, NOW)).toBe("6 days ago");
    expect(dayLabel(NOW - 30 * DAY, NOW)).toBe("2026-07-19");
  });
});
