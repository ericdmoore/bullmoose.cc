import { describe, expect, it } from "vitest";
import { ACCESS_LOG_CAVEATS, PROVENANCE_CAVEATS } from "./caveats";
import { DEMO_NOW, VENDORS_BOOK, demoConsoleData } from "./demoConsole";
import {
  buildResourceView,
  coversResource,
  liveAt,
  parseAuditMethod,
  whoCould,
  whoDid,
} from "./perResource";
import type { ConsoleGrant, ResourceDossier } from "./types";

const DAY = 86_400_000;
const dossier = demoConsoleData().resourceDossiers["AddressBook:ab_vendors"] as ResourceDossier;
const at = (days: number): number => DEMO_NOW - days * DAY;

const grant = (over: Partial<ConsoleGrant>): ConsoleGrant => ({
  grantId: "g",
  scopes: ["read"],
  allows: [],
  collection: null,
  collectionId: null,
  createdBy: "p_eric",
  createdAt: 0,
  expiresAt: null,
  revokedAt: null,
  ...over,
});

// ── point-in-time correctness ───────────────────────────────────────────────

describe("liveAt — the point-in-time predicate", () => {
  it("is false before the grant existed", () => {
    expect(liveAt({ createdAt: 100, expiresAt: null, revokedAt: null }, 50)).toBe(false);
    expect(liveAt({ createdAt: 100, expiresAt: null, revokedAt: null }, 150)).toBe(true);
  });
  it("closes at revocation and at expiry, whichever the row records", () => {
    expect(liveAt({ createdAt: 0, expiresAt: null, revokedAt: 100 }, 150)).toBe(false);
    expect(liveAt({ createdAt: 0, expiresAt: null, revokedAt: 100 }, 50)).toBe(true);
    expect(liveAt({ createdAt: 0, expiresAt: 100, revokedAt: null }, 150)).toBe(false);
  });
});

describe("coversResource", () => {
  it("treats a whole-account grant as covering everything — the shape most often mistaken for narrow", () => {
    expect(coversResource(grant({ collection: null }), VENDORS_BOOK)).toBe(true);
  });
  it("does not let a grant on one collection reach another", () => {
    expect(
      coversResource(
        grant({ collection: "AddressBook", collectionId: "ab_personal" }),
        VENDORS_BOOK,
      ),
    ).toBe(false);
    expect(
      coversResource(grant({ collection: "Calendar", collectionId: "ab_vendors" }), VENDORS_BOOK),
    ).toBe(false);
  });
});

describe("whoCould — the authorization set, reconstructed", () => {
  it("INCLUDES a since-revoked grant for the window in which it was live", () => {
    // devPlan.md T3 done-when, and the whole reason grant tombstones had to
    // exist: a hard-deleted grant is unanswerable.
    const whenLive = whoCould(dossier, at(9), DEMO_NOW);
    const ids = whenLive.map((c) => c.grant.grantId);
    expect(ids).toContain("g_temp_vendors");
    const dana = whenLive.find((c) => c.grant.grantId === "g_temp_vendors");
    expect(dana?.stillLive).toBe(false);
    expect(dana?.party?.address).toBe("dana@example.com");
  });

  it("EXCLUDES it for an instant after the revocation", () => {
    const now = whoCould(dossier, DEMO_NOW, DEMO_NOW);
    expect(now.map((c) => c.grant.grantId)).not.toContain("g_temp_vendors");
  });

  it("excludes it for an instant before it was created", () => {
    const early = whoCould(dossier, at(90), DEMO_NOW);
    expect(early.map((c) => c.grant.grantId)).not.toContain("g_temp_vendors");
  });

  it("labels how each grant reaches the resource", () => {
    const now = whoCould(dossier, DEMO_NOW, DEMO_NOW);
    expect(now.find((c) => c.grant.grantId === "g_allen_mail")?.reach).toBe("whole-account");
    expect(now.find((c) => c.grant.grantId === "g_analyst_read")?.reach).toBe("this-collection");
  });

  it("expands each grant to what it ALLOWS, not what it stores", () => {
    const now = whoCould(dossier, DEMO_NOW, DEMO_NOW);
    const allen = now.find((c) => c.grant.grantId === "g_allen_mail");
    expect(allen?.grant.scopes).toEqual(["mail", "contacts"]);
    expect(allen?.allows).toContain("delete");
    expect(allen?.allows).toContain("contacts");
  });
});

// ── who did ─────────────────────────────────────────────────────────────────

describe("parseAuditMethod covers all four shapes", () => {
  it("matches `bureau:` BEFORE the generic domain:scope fallthrough", () => {
    // Otherwise a credential use renders as a scope literally named "fetch:aws-mcp".
    expect(parseAuditMethod("bureau:fetch:aws-mcp")).toBe(
      "Bureau `fetch` on credential `aws-mcp`",
    );
    expect(parseAuditMethod("bureau:oauth_token")).toBe("Bureau verb `oauth_token`");
  });
  it("handles mcp, jmap, and the multi-scope jmap form", () => {
    expect(parseAuditMethod("mcp:contacts_upsert_card")).toContain("contacts_upsert_card");
    expect(parseAuditMethod("contacts:contacts")).toBe("JMAP contacts (contacts)");
    // `<domain>:<a>+<b>` renders as a scope named "draft+delete" if split naively.
    expect(parseAuditMethod("mail:draft+delete")).toBe("JMAP mail (draft + delete)");
  });
  it("falls back to the literal rather than inventing structure", () => {
    expect(parseAuditMethod("weird")).toBe("weird");
  });
});

describe("whoDid joins the audit trail with provenance", () => {
  const did = whoDid(dossier);

  it("includes both sources, newest first", () => {
    expect(did.some((d) => d.source === "grant-audit")).toBe(true);
    expect(did.some((d) => d.source === "provenance")).toBe(true);
    const times = did.map((d) => d.at ?? 0);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("attributes an agent acting on its OWN account — the case grant_audit alone misses", () => {
    // devPlan.md T3 done-when. The owner's write is invisible to grant_audit by
    // construction; the provenance stamp is what makes it attributable.
    const owner = did.find((d) => d.actor === "eric@bullmoose.cc");
    expect(owner?.source).toBe("provenance");
    // …and the binding/invocation are recovered where they were captured.
    const byAllen = did.find((d) => d.source === "provenance" && d.actor === "allen@bullmoose.cc");
    expect(byAllen?.binding).toBe("allen");
    expect(byAllen?.invocation).toBe("inv_8");
  });

  it("keeps a NULL writer as null rather than blanking it into a name", () => {
    const uncaptured = did.filter((d) => d.source === "provenance" && d.actor === null);
    expect(uncaptured).toHaveLength(1);
  });
});

// ── the gap ─────────────────────────────────────────────────────────────────

describe("the gap is the finding", () => {
  const view = buildResourceView(dossier, { at: DEMO_NOW, since: at(30) }, DEMO_NOW);
  const kinds = view.findings.map((f) => f.kind);

  it("renders one list of statements, not two unrelated tables", () => {
    expect(view.findings.length).toBeGreaterThan(0);
    for (const f of view.findings) {
      expect(f.headline.length).toBeGreaterThan(0);
      expect(f.detail.length).toBeGreaterThan(0);
    }
  });

  it("calls a held-but-unused grant over-permissioning, and refuses to call it proof of inaction", () => {
    const over = view.findings.find((f) => f.kind === "over-permissioned");
    expect(over?.actor).toBe("analyst@bullmoose.cc");
    expect(over?.detail).toContain("NOT as proof of inaction");
    expect(over?.detail).toContain("attempts");
  });

  it("flags an action with no covering grant, and names the owner case first", () => {
    const unexplained = view.findings.filter((f) => f.kind === "unexplained");
    expect(unexplained.length).toBeGreaterThan(0);
    expect(unexplained[0]?.detail).toContain("OWNER");
    expect(unexplained[0]?.detail).toContain("hard-deleted before tombstones existed");
  });

  it("distinguishes a Bureau REFUSAL from an unexplained action", () => {
    // `grant_id = 'none'` means nothing authorized the attempt. Rendering it as
    // "acted without a grant" would invert its meaning.
    const refused = view.findings.find((f) => f.kind === "refused-attempt");
    expect(refused?.actor).toBe("editor@bullmoose.cc");
    expect(refused?.detail).toContain("every ATTEMPTED use, allowed or refused");
    expect(kinds.filter((k) => k === "unexplained")).not.toContain(refused?.kind);
  });

  it("explains the action taken under the since-revoked grant, and says it was revoked", () => {
    const explained = view.findings.filter((f) => f.kind === "explained");
    const dana = explained.find((f) => f.actor === "dana@example.com");
    expect(dana?.headline).toContain("g_temp_vendors");
    expect(dana?.detail).toContain("has since been revoked");
    expect(dana?.detail).toContain("tombstone, not a delete");
  });

  it("renders a NULL writer as not-captured, never as nobody (common/033)", () => {
    const gap = view.findings.find((f) => f.kind === "not-captured");
    expect(gap?.headline).toContain("writer was not captured");
    expect(gap?.detail).toContain("recording gap, not an anonymous actor");
    expect(gap?.detail).toContain("common/033");
  });

  it("summarizes the gap in one line, up front", () => {
    expect(view.gapSummary).toContain("could have");
    expect(view.gapSummary).toContain("recorded");
    expect(view.gapSummary).toContain("no covering grant");
    expect(view.gapSummary).toContain("over-permissioning to review");
  });
});

// ── the caveats are not optional ────────────────────────────────────────────

describe("the view cannot be built without its caveats", () => {
  const view = buildResourceView(dossier, { at: DEMO_NOW, since: at(30) }, DEMO_NOW);

  it("carries all four grant_audit caveats", () => {
    expect(view.accessLogCaveats).toEqual(ACCESS_LOG_CAVEATS);
    expect(view.accessLogCaveats).toHaveLength(4);
  });

  it("carries the provenance gap", () => {
    expect(view.provenanceCaveats).toEqual(PROVENANCE_CAVEATS);
  });

  it("carries the point-in-time note", () => {
    expect(view.pointInTimeNote).toContain("tombstones (s03.A)");
  });

  it("explains an EMPTY audit trail instead of showing nothing", () => {
    const quiet: ResourceDossier = { ...dossier, audit: [] };
    const v = buildResourceView(quiet, { at: DEMO_NOW, since: at(30) }, DEMO_NOW);
    expect(v.emptyMeans).not.toBeNull();
    expect(v.emptyMeans).toContain("not the same as");
    // …and it stays quiet when there IS a trail.
    expect(view.emptyMeans).toBeNull();
  });
});
