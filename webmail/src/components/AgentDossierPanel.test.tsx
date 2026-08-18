/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import AgentDossierPanel from "./AgentDossierPanel";
import { buildDossierView, type DossierView } from "../lib/agents/dossier";
import type { AgentDossier } from "../lib/console/types";

// s26 T1 — render tests (plain Node, preact-render-to-string, the ui.test.tsx
// pattern). The DERIVATIONS are tested in lib/agents/dossier.test.ts; here we
// prove the MARKUP: the µUSD labels reach the page verbatim, the spend meter
// is a class-swap (no inline style — the CSP), state is never color alone,
// and the kill-switch state names the verb's real home.

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const HOUR = 3_600_000;

const DOSSIER: AgentDossier = {
  accountId: "acct_allen",
  principalId: "p_allen",
  principal: "allen@bullmoose.cc",
  tokenScopes: ["mail"],
  bindings: [
    {
      bindingId: "ab_1",
      name: "allen",
      triggerOn: "mailbox-delivery",
      slaSeconds: 120,
      enabled: true,
      config: { pipeline: "extract", replyMode: "draft", senderAllowlist: { active: true, count: 2 } },
      economics: {
        budgetMicros: 2_000_000,
        defaultModel: "cheap",
        modelMenu: [
          { alias: "cheap", candidates: ["workers-ai/llama-3.3-70b", "openrouter/gemini-2.5-flash"] },
          { alias: "smart", candidates: ["openrouter/claude-sonnet-4"] },
        ],
        exploreRate: 0.1,
      },
    },
    {
      bindingId: "ab_2",
      name: "allen-digest",
      triggerOn: "schedule",
      slaSeconds: null,
      enabled: false,
      config: { pipeline: "ledger", replyMode: null },
      economics: { budgetMicros: null, defaultModel: null, modelMenu: [], exploreRate: null },
    },
  ],
  credentials: [],
  bureauGrants: [],
  grantsHeld: [],
  grantsGiven: [],
  invocations: [
    {
      invocationId: "inv_1",
      bindingId: "ab_1",
      bindingName: "allen",
      status: "done",
      emailId: "em_1",
      note: null,
      createdAt: NOW - HOUR,
      doneAt: NOW - HOUR + 60_000,
      costMicros: 4_200,
      model: "workers-ai/llama-3.3-70b",
    },
    {
      invocationId: "inv_2",
      bindingId: "ab_1",
      bindingName: "allen",
      status: "failed",
      emailId: null,
      note: "model provider returned 429",
      createdAt: NOW - 2 * HOUR,
      doneAt: NOW - 2 * HOUR,
      costMicros: null,
      model: null,
    },
  ],
  spend: null,
  ledgers: [
    {
      bindingId: "ab_1",
      pending: 3,
      running: 1,
      done: 40,
      failed: 2,
      oldestPendingAt: NOW - 3 * HOUR,
      monthSpendMicros: 1_130_000,
      monthOverageMicros: 0,
    },
  ],
  ledgerMonthStart: Date.UTC(2026, 7, 1),
};

const view = (bindingId: string): DossierView => {
  const v = buildDossierView(DOSSIER, bindingId, NOW);
  if (!v) throw new Error(`no such binding ${bindingId}`);
  return v;
};

describe("AgentDossierPanel — identity", () => {
  const html = render(<AgentDossierPanel view={view("ab_1")} />);

  it("carries name, address, pipeline and the enabled badge", () => {
    expect(html).toContain('aria-label="Dossier for allen"');
    expect(html).toContain("allen@bullmoose.cc");
    expect(html).toContain(">extract<");
    expect(html).toContain(">enabled<");
    expect(html).toContain("SLA 120s");
    expect(html).toContain("sender allowlist (2)");
  });

  it("renders the budget as text AND a class-swap meter — never inline style", () => {
    expect(html).toContain("$2.00 / month");
    expect(html).toContain("$1.13 spent this month");
    expect(html).toContain("$0.87 remaining");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("w-7/12"); // 56.5% of the cap, snapped to twelfths
    expect(html).toContain("bg-brand-600");
    expect(html).not.toContain("style=");
  });

  it("lists the model menu with the default marked, and the frontier rate", () => {
    expect(html).toContain("workers-ai/llama-3.3-70b → openrouter/gemini-2.5-flash");
    expect(html).toContain(">default<");
    expect(html).toContain("explores 10% of runs");
  });

  it("shows the four ledger counts and the oldest-pending age", () => {
    expect(html).toContain(">pending<");
    expect(html).toContain(">running<");
    expect(html).toContain(">done<");
    expect(html).toContain(">failed<");
    expect(html).toContain("oldest pending waited 3h 0m");
  });

  it("renders per-run cost through costLabel's rule — null is 'not recorded'", () => {
    expect(html).toContain("4,200 µ$ · workers-ai/llama-3.3-70b");
    expect(html).toContain("cost not recorded");
    expect(html).toContain("model provider returned 429");
  });
});

describe("AgentDossierPanel — the disabled binding", () => {
  const html = render(<AgentDossierPanel view={view("ab_2")} />);

  it("says the kill switch is thrown and where the verb lives (no session door)", () => {
    expect(html).toContain(">disabled<");
    expect(html).toContain("kill switch");
    expect(html).toContain("bullmoose admin agent enable ab_2");
  });

  it("no cap and no menu render honest empties, not zeros", () => {
    expect(html).toContain("no monthly cap is set");
    expect(html).toContain("$0.00 spent this month");
    expect(html).toContain("No aliases configured");
    expect(html).toContain("Nothing recorded yet for this agent.");
  });
});
