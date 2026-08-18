/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import AgentDossierPanel, { type BindingCredential } from "./AgentDossierPanel";
import { ByokPanel } from "./SettingsAgentsSection";
import { buildDossierView } from "../lib/agents/dossier";
import { bindingByokView, tenantByokView, type ByokStatus } from "../lib/byok/status";
import type { AgentDossier } from "../lib/console/types";

// s26 T4 — render tests for BOTH halves of the BYOK surface (plain Node,
// preact-render-to-string; no jsdom). The derivations live in
// lib/byok/status.test.ts; here we prove the MARKUP:
//
//   • the dossier says whose key pays for THIS agent, and when it is refusing
//     it says so in a way nobody can read as "it fell back";
//   • Settings owns the key itself — add / replace / revoke — and the paste
//     field is a password field with no name;
//   • the write gate renders as an EXPLANATION when the session lacks `vault`,
//     never as a hidden section;
//   • no rendered byte anywhere is, or could be, a key.

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const DAY = 86_400_000;

const DOSSIER: AgentDossier = {
  accountId: "acct_a",
  principalId: "p_a",
  principal: "allen@bullmoose.cc",
  tokenScopes: ["mail"],
  bindings: [
    {
      bindingId: "ab_1",
      name: "allen",
      triggerOn: "mailbox-delivery",
      slaSeconds: null,
      enabled: true,
      config: { pipeline: "extract", replyMode: "draft" },
      economics: { budgetMicros: null, defaultModel: null, modelMenu: [], exploreRate: null },
    },
  ],
  credentials: [],
  bureauGrants: [],
  grantsHeld: [],
  grantsGiven: [],
  invocations: [],
  spend: null,
  ledgers: [],
  ledgerMonthStart: NOW,
} as unknown as AgentDossier;

const status = (over: Partial<ByokStatus> = {}): ByokStatus => ({
  accountId: "acct_a",
  credentials: [],
  refs: [],
  platformKeyBindings: [],
  keyReadable: false,
  mayWrite: true,
  writeRefusal: null,
  sealableProviders: ["openrouter"],
  ...over,
});

const CREDENTIAL = {
  credRef: "openrouter",
  kind: "api-key",
  allow: "https://openrouter.ai",
  provider: "openrouter",
  sealedAt: NOW - 3 * DAY,
  rotatedAt: NOW - DAY,
  grant: { grantId: "bg_1", live: true, createdAt: NOW - 3 * DAY, expiresAt: null, revokedAt: null },
};

const REF = {
  bindingId: "ab_1",
  bindingName: "allen",
  enabled: true,
  provider: "openrouter",
  credRef: "openrouter",
  status: "live" as const,
};

function dossierHtml(s: ByokStatus | undefined): string {
  const view = buildDossierView(DOSSIER, "ab_1", NOW)!;
  const credential: BindingCredential = {
    view: bindingByokView(s, "ab_1", NOW),
    busy: false,
    onDetach: () => {
      throw new Error("onDetach must not fire during render");
    },
  };
  return render(<AgentDossierPanel view={view} credential={credential} />);
}

const noop = () => {
  throw new Error("handlers must not fire during render");
};

function settingsHtml(s: ByokStatus | undefined, over: Partial<Parameters<typeof ByokPanel>[0]> = {}): string {
  return render(
    <ByokPanel
      view={tenantByokView(s, NOW)}
      accountLabel="allen@bullmoose.cc"
      busy={false}
      draft=""
      onDraft={noop}
      provider="openrouter"
      onProvider={noop}
      onSeal={noop}
      onRevoke={noop}
      {...over}
    />,
  );
}

// ── the dossier: whose key pays for THIS agent ────────────────────────────

describe("AgentDossierPanel — the provider-key section", () => {
  it("names the credential, the ONLY host it can be spent at, and when it was sealed", () => {
    const html = dossierHtml(status({ credentials: [CREDENTIAL], refs: [REF] }));
    expect(html).toContain("Provider key");
    expect(html).toContain("openrouter");
    expect(html).toContain("spendable only at openrouter.ai");
    expect(html).toContain("sealed 3 days ago");
    expect(html).toContain("rotated yesterday");
    // The promise, restated where someone might look for a "reveal" affordance.
    expect(html).toContain("the key itself is never shown");
  });

  it("REFUSING renders as an error that rules out a silent fallback", () => {
    const html = dossierHtml(status({ refs: [{ ...REF, status: "no-credential" }] }));
    expect(html).toContain("REFUSES every model call");
    expect(html).toContain("rather than spending the platform's key");
    // Never colour alone: the chip's word says it too (WCAG 1.4.1).
    expect(html).toContain(">refusing<");
    expect(html).toContain("text-red-700");
  });

  it("the platform-key case is stated, not left as an empty section", () => {
    const html = dossierHtml(status({ platformKeyBindings: [{ id: "ab_1", name: "allen", provider: "openrouter" }] }));
    expect(html).toContain("platform key");
    expect(html).toContain("not yours");
    // Nothing to detach, so no button offering it.
    expect(html).not.toContain("Use the platform key instead");
  });

  it("the detach verb says what it does NOT do", () => {
    const html = dossierHtml(status({ credentials: [CREDENTIAL], refs: [REF] }));
    expect(html).toContain("Use the platform key instead");
    expect(html).toContain("THIS agent only");
    expect(html).toContain("stays sealed");
    // …and points at where the tenant-level verb actually lives — the
    // discriminator, taught in place rather than in a doc.
    expect(html).toContain("revoke it in Settings");
  });

  it("a binding with no key-taking route renders no section at all", () => {
    // Better than an empty panel saying "n/a": a Workers AI agent has no
    // provider key question to answer.
    expect(dossierHtml(status())).not.toContain("Provider key");
  });

  it("no status (an older server) renders no section — and does not break the dossier", () => {
    const html = dossierHtml(undefined);
    expect(html).not.toContain("Provider key");
    expect(html).toContain("Work ledger");
  });

  it("renders no inline style anywhere — the CSP forbids it", () => {
    expect(dossierHtml(status({ credentials: [CREDENTIAL], refs: [REF] }))).not.toMatch(/ style="/);
  });
});

// ── Settings: the key itself ──────────────────────────────────────────────

describe("ByokPanel — the tenant's key lives in Settings", () => {
  it("explains what BYOK is before asking for anything", () => {
    const html = settingsHtml(status());
    expect(html).toContain("authenticate as YOU");
    expect(html).toContain("guardrails and PII redaction");
    // The claim we must NOT make, and the one we do.
    expect(html).toContain("does not implement, mirror or read any of it");
    expect(html).toContain("the platform's key and the platform's provider settings");
  });

  it("the paste field is a password field with no name, and says the value is unreadable afterwards", () => {
    const html = settingsHtml(status());
    expect(html).toContain('type="password"');
    expect(html).toContain('autocomplete="off"');
    // No `name` — a stray form submit could not serialize a key into a URL.
    expect(html).not.toMatch(/<input[^>]*\sname=/);
    expect(html).toContain("write-only");
    expect(html).toContain("not even the first few characters");
  });

  it("switches from Add to Replace once a key exists — rotation is the same act, not a second flow", () => {
    expect(settingsHtml(status())).toContain("Add your key");
    const withKey = settingsHtml(status({ credentials: [CREDENTIAL], refs: [REF] }));
    expect(withKey).toContain("Replace your key");
    expect(withKey).toContain("Replace key");
  });

  it("lists each key with its destination, its dates and its state — and never a value", () => {
    const html = settingsHtml(status({ credentials: [CREDENTIAL], refs: [REF] }));
    expect(html).toContain("spendable only at openrouter.ai");
    expect(html).toContain("sealed 3 days ago");
    expect(html).toContain("in use");
    expect(html).toContain("used by");
    expect(html).toContain("Revoke");
  });

  it("a refusal is the headline, above the key list", () => {
    const html = settingsHtml(status({ credentials: [CREDENTIAL], refs: [{ ...REF, status: "grant-revoked" }] }));
    expect(html).toContain("refusing every model call");
    expect(html).toContain("Nothing falls back to the platform key");
    expect(html).toContain('role="alert"');
    // The summary precedes the per-key list in document order — the point of
    // putting it there is that it is read first.
    expect(html.indexOf("Nothing falls back")).toBeLessThan(html.indexOf("Revoke"));
  });

  it("a sealed key nobody uses is visible and labelled, not silently missing", () => {
    const html = settingsHtml(status({ credentials: [CREDENTIAL] }));
    expect(html).toContain("not used by any agent");
    expect(html).toContain("It is not lost");
  });

  it("names the agents still on the platform key — the empty state, made concrete", () => {
    const html = settingsHtml(status({ platformKeyBindings: [{ id: "ab_1", name: "allen", provider: "openrouter" }] }));
    expect(html).toContain("On the platform key: allen");
    expect(html).toContain("No provider key of your own");
  });

  it("a session without `vault` gets the EXPLANATION, not a hidden form", () => {
    const html = settingsHtml(
      status({
        mayWrite: false,
        writeRefusal:
          'this session does not carry the "vault" scope, which custody of a provider key requires. ' +
          "Hosted sign-in cannot grant it",
        credentials: [CREDENTIAL],
        refs: [REF],
      }),
    );
    // The refusal is on the page…
    expect(html).toContain("does not carry the &quot;vault&quot; scope");
    expect(html).toContain("Hosted sign-in cannot grant it");
    // …the write affordances are gone…
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("Revoke");
    // …and the STATUS is still fully readable, which is the whole point of
    // gating the read lower than the write.
    expect(html).toContain("spendable only at openrouter.ai");
  });

  it("shows the server's refusal verbatim when a write is rejected", () => {
    const html = settingsHtml(status(), { error: 'forbidden: token lacks the "vault" scope' });
    expect(html).toContain("token lacks the &quot;vault&quot; scope");
    expect(html).toContain('role="alert"');
  });

  it("the success notice reports the handle and destination, and repeats the promise", () => {
    const html = settingsHtml(status(), {
      notice: "Sealed “openrouter”, spendable only at https://openrouter.ai. The key itself is not readable.",
    });
    expect(html).toContain("Sealed");
    expect(html).toContain("not readable");
  });

  it("renders no inline style anywhere — the CSP forbids it", () => {
    expect(settingsHtml(status({ credentials: [CREDENTIAL], refs: [REF] }))).not.toMatch(/ style="/);
  });
});
