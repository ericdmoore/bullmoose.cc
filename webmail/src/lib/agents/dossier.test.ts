import { describe, expect, it } from "vitest";
import type { AgentSummary } from "../console/ConsoleClient";
import type { AgentDossier, ConsoleBinding, ConsoleBindingLedger } from "../console/types";
import {
  agentCollections,
  agentListRows,
  agentRowId,
  buildDossierView,
  economicsView,
  filterAgentRows,
  invocationRows,
  ledgerView,
  microsLabel,
  modelMenuView,
  parseAgentRowId,
  spendBarToneClass,
  spendBarWidthClass,
} from "./dossier";

// s26 T1 — the dossier's pure shaping. The µUSD discipline (null ≠ 0), the
// gate-mirroring budget arithmetic (ceiling = cap + overage), and the CSP
// bar (discrete class steps, never a computed style) are the load-bearing
// rules; each gets pinned here so the component can stay markup.

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const HOUR = 3_600_000;

function binding(over: Partial<ConsoleBinding> = {}): ConsoleBinding {
  return {
    bindingId: "ab_1",
    name: "allen",
    triggerOn: "mailbox-delivery",
    slaSeconds: null,
    enabled: true,
    config: { pipeline: "extract", replyMode: "draft" },
    economics: {
      budgetMicros: 2_000_000,
      defaultModel: "cheap",
      modelMenu: [
        { alias: "cheap", candidates: ["workers-ai/llama-3.3-70b", "openrouter/gemini-flash"] },
        { alias: "smart", candidates: ["openrouter/claude-sonnet"] },
      ],
      exploreRate: 0.1,
    },
    ...over,
  };
}

function ledger(over: Partial<ConsoleBindingLedger> = {}): ConsoleBindingLedger {
  return {
    bindingId: "ab_1",
    pending: 3,
    running: 1,
    done: 40,
    failed: 2,
    oldestPendingAt: NOW - 3 * HOUR,
    monthSpendMicros: 1_130_000,
    monthOverageMicros: 0,
    ...over,
  };
}

function dossier(over: Partial<AgentDossier> = {}): AgentDossier {
  return {
    accountId: "acct_allen",
    principalId: "p_allen",
    principal: "allen@bullmoose.cc",
    tokenScopes: ["mail"],
    bindings: [binding()],
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
        status: "done",
        emailId: null,
        note: "skipped",
        createdAt: NOW - 2 * HOUR,
        doneAt: NOW - 2 * HOUR,
        costMicros: null,
        model: null,
      },
      {
        invocationId: "inv_3",
        bindingId: "ab_1",
        bindingName: "allen",
        status: "done",
        emailId: "em_3",
        note: null,
        createdAt: NOW - 3 * HOUR,
        doneAt: NOW - 3 * HOUR,
        costMicros: 0,
        model: "workers-ai/llama-3.3-70b",
      },
      {
        invocationId: "inv_other",
        bindingId: "ab_9",
        bindingName: "other",
        status: "failed",
        emailId: null,
        note: null,
        createdAt: NOW - HOUR,
        doneAt: NOW,
      },
    ],
    spend: null,
    ledgers: [ledger()],
    ledgerMonthStart: Date.UTC(2026, 7, 1),
    ...over,
  };
}

const SUMMARY: AgentSummary = {
  accountId: "acct_allen",
  principalId: "p_allen",
  principal: "allen@bullmoose.cc",
  displayName: "Allen",
  bindingCount: 1,
  enabledBindingCount: 1,
};

describe("selection ids", () => {
  it("round-trips accountId/bindingId", () => {
    const id = agentRowId("acct_allen", "ab_1");
    expect(parseAgentRowId(id)).toEqual({ accountId: "acct_allen", bindingId: "ab_1" });
  });
  it("rejects the malformed rather than inventing a half-parse", () => {
    expect(parseAgentRowId("noslash")).toBeUndefined();
    expect(parseAgentRowId("/ab_1")).toBeUndefined();
    expect(parseAgentRowId("acct_x/")).toBeUndefined();
  });
});

describe("agentListRows", () => {
  it("flattens one row per BINDING, with address, pipeline and pending count", () => {
    const rows = agentListRows([SUMMARY], { acct_allen: dossier() });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "acct_allen/ab_1",
      name: "allen",
      address: "allen@bullmoose.cc",
      pipeline: "extract",
      enabled: true,
      pendingCount: 3,
    });
  });
  it("contributes nothing for an account whose dossier has not loaded", () => {
    expect(agentListRows([SUMMARY], {})).toEqual([]);
  });
  it("defaults an unstated pipeline to reply (the server's own default)", () => {
    const d = dossier({ bindings: [binding({ config: { pipeline: null, replyMode: null } })], ledgers: [] });
    expect(agentListRows([SUMMARY], { acct_allen: d })[0]?.pipeline).toBe("reply");
    expect(agentListRows([SUMMARY], { acct_allen: d })[0]?.pendingCount).toBe(0);
  });
});

describe("filterAgentRows", () => {
  const rows = agentListRows([SUMMARY], { acct_allen: dossier() });
  it("matches name, address and pipeline, case-insensitively", () => {
    expect(filterAgentRows(rows, "ALLEN")).toHaveLength(1);
    expect(filterAgentRows(rows, "bullmoose.cc")).toHaveLength(1);
    expect(filterAgentRows(rows, "extract")).toHaveLength(1);
    expect(filterAgentRows(rows, "nope")).toHaveLength(0);
  });
  it("empty query returns everything", () => {
    expect(filterAgentRows(rows, "  ")).toHaveLength(1);
  });
});

describe("agentCollections", () => {
  it("leads with All agents (counted) and keeps the console entry point", () => {
    const groups = agentCollections(agentListRows([SUMMARY], { acct_allen: dossier() }));
    expect(groups[0]?.items[0]).toMatchObject({ id: "all", label: "All agents", count: 1 });
    expect(groups[1]?.items.map((i) => i.id)).toContain("console");
  });
});

describe("microsLabel", () => {
  it("renders dollars at a cent and above, µ$ below, $0.00 at zero", () => {
    expect(microsLabel(2_000_000)).toBe("$2.00");
    expect(microsLabel(10_000)).toBe("$0.01");
    expect(microsLabel(9_999)).toContain("µ$");
    expect(microsLabel(0)).toBe("$0.00");
  });
});

describe("economicsView — the gate's arithmetic", () => {
  it("under budget: spent, remaining, pct of the ceiling", () => {
    const v = economicsView(binding(), ledger());
    expect(v.state).toBe("under");
    expect(v.capLabel).toBe("$2.00 / month");
    expect(v.spentLabel).toBe("$1.13 spent this month");
    expect(v.remainingLabel).toBe("$0.87 remaining");
    expect(v.pctUsed).toBeCloseTo(56.5, 1);
    expect(v.barWidthClass).toBe("w-7/12");
  });
  it("no cap configured: no bar percentage and no invented remaining", () => {
    const v = economicsView(
      binding({ economics: { budgetMicros: null, defaultModel: null, modelMenu: [], exploreRate: null } }),
      ledger(),
    );
    expect(v.state).toBe("no-cap");
    expect(v.capLabel).toBeNull();
    expect(v.remainingLabel).toBeNull();
    expect(v.pctUsed).toBeNull();
  });
  it("near the ceiling warns; at or past it, exhausted — the free-only narrowing", () => {
    expect(economicsView(binding(), ledger({ monthSpendMicros: 1_700_000 })).state).toBe("near");
    const over = economicsView(binding(), ledger({ monthSpendMicros: 2_000_000 }));
    expect(over.state).toBe("exhausted");
    expect(over.remainingLabel).toContain("month roll");
    expect(over.pctUsed).toBe(100);
  });
  it("approved overage raises the EFFECTIVE ceiling (s11 T9), and is named", () => {
    const v = economicsView(binding(), ledger({ monthSpendMicros: 2_000_000, monthOverageMicros: 500_000 }));
    expect(v.overageLabel).toBe("+$0.50 approved overage");
    // At the base cap but under cap + overage: still working, in the warn band.
    expect(v.remainingLabel).toBe("$0.50 remaining");
    expect(v.state).toBe("near");
    expect(v.pctUsed).toBeCloseTo(80, 1);
  });
  it("a missing ledger row means all-zero spend, not unknown", () => {
    const v = economicsView(binding(), undefined);
    expect(v.spentLabel).toBe("$0.00 spent this month");
    expect(v.state).toBe("under");
  });
});

describe("spendBarWidthClass — discrete steps, never inline style", () => {
  it("clamps and snaps to twelfths", () => {
    expect(spendBarWidthClass(0)).toBe("w-0");
    expect(spendBarWidthClass(-5)).toBe("w-0");
    expect(spendBarWidthClass(50)).toBe("w-6/12");
    expect(spendBarWidthClass(100)).toBe("w-full");
    expect(spendBarWidthClass(400)).toBe("w-full");
  });
  it("a nonzero spend never rounds down to invisible", () => {
    expect(spendBarWidthClass(0.4)).toBe("w-1/12");
  });
  it("tones are classes too", () => {
    expect(spendBarToneClass("under")).toBe("bg-brand-600");
    expect(spendBarToneClass("near")).toBe("bg-amber-500");
    expect(spendBarToneClass("exhausted")).toBe("bg-red-600");
    expect(spendBarToneClass("no-cap")).toBe("bg-brand-600");
  });
});

describe("modelMenuView", () => {
  it("renders each alias's fallback chain and the frontier rate", () => {
    const v = modelMenuView(binding());
    expect(v.defaultModel).toBe("cheap");
    expect(v.entries[0]).toEqual({ alias: "cheap", chain: "workers-ai/llama-3.3-70b → openrouter/gemini-flash" });
    expect(v.exploreLabel).toBe("frontier: explores 10% of runs across the menu");
  });
  it("frontier off (absent or 0) renders no explore line", () => {
    const none = binding({ economics: { budgetMicros: null, defaultModel: null, modelMenu: [], exploreRate: 0 } });
    expect(modelMenuView(none).exploreLabel).toBeNull();
    expect(modelMenuView(binding({ economics: undefined })).exploreLabel).toBeNull();
  });
});

describe("ledgerView", () => {
  it("carries the four counts and the oldest-pending age", () => {
    const v = ledgerView(ledger(), NOW);
    expect(v).toMatchObject({ pending: 3, running: 1, done: 40, failed: 2 });
    expect(v.oldestPendingLabel).toBe("oldest pending waited 3h 0m");
  });
  it("an empty queue has no invented age; a missing row is all-zero", () => {
    expect(ledgerView(ledger({ oldestPendingAt: null }), NOW).oldestPendingLabel).toBeNull();
    expect(ledgerView(undefined, NOW)).toMatchObject({ pending: 0, running: 0, done: 0, failed: 0 });
  });
});

describe("invocationRows — costLabel's rule, verbatim", () => {
  const rows = invocationRows(dossier().invocations, "ab_1", NOW);
  it("filters to the binding and keeps newest-first order", () => {
    expect(rows.map((r) => r.id)).toEqual(["inv_1", "inv_2", "inv_3"]);
  });
  it("null cost is 'cost not recorded', 0 is 'free', and a priced run names its model", () => {
    expect(rows[0]?.costText).toBe("4,200 µ$ · workers-ai/llama-3.3-70b");
    expect(rows[1]?.costText).toBe("cost not recorded");
    expect(rows[2]?.costText).toBe("free");
  });
  it("stamps a relative age", () => {
    expect(rows[0]?.whenLabel).toBe("1h 0m ago");
  });
});

describe("buildDossierView", () => {
  it("assembles identity, economics, ledger and recent rows for one binding", () => {
    const v = buildDossierView(dossier(), "ab_1", NOW);
    expect(v?.binding.name).toBe("allen");
    expect(v?.address).toBe("allen@bullmoose.cc");
    expect(v?.economics.capLabel).toBe("$2.00 / month");
    expect(v?.ledger.pending).toBe(3);
    expect(v?.recent).toHaveLength(3);
  });
  it("is undefined for a binding not on this dossier", () => {
    expect(buildDossierView(dossier(), "ab_missing", NOW)).toBeUndefined();
  });
});
