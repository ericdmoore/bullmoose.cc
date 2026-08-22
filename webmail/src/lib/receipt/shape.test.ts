import { describe, expect, it } from "vitest";
import type { Annotation } from "../annotations/types";
import type { ActionProposal } from "../approvals/types";
import type { AgentDossier, ConsoleBinding, ConsoleInvocation } from "../console/types";
import { MANUAL_SCHEDULE_ABSENCE, buildReceipt, declineMetric, invocationMix, mixRows, producedView } from "./shape";
import { CONSOLE_INVOCATION_CAP, receiptWindow } from "./types";

const NOW = Date.parse("2026-08-21T12:00:00Z");
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ACCOUNT = "acct-eric";
const WINDOW = receiptWindow("7d", NOW);

// ── fixtures ───────────────────────────────────────────────────────────────

function binding(over: Partial<ConsoleBinding> = {}): ConsoleBinding {
  return {
    bindingId: "ab_extract",
    name: "extractor",
    triggerOn: "delivered",
    slaSeconds: null,
    enabled: true,
    config: { pipeline: "extract", replyMode: null },
    economics: { budgetMicros: 2_000_000, defaultModel: "extract", modelMenu: [], exploreRate: null },
    ...over,
  };
}

function invocation(over: Partial<ConsoleInvocation> = {}): ConsoleInvocation {
  return {
    invocationId: `inv-${Math.random().toString(36).slice(2)}`,
    bindingId: "ab_extract",
    bindingName: "extractor",
    status: "done",
    emailId: "e1",
    note: "extracted 2",
    createdAt: NOW - HOUR,
    doneAt: NOW - HOUR + 900,
    costMicros: 1_000,
    model: "workers-ai/llama",
    ...over,
  };
}

function dossier(over: Partial<AgentDossier> = {}): AgentDossier {
  return {
    accountId: ACCOUNT,
    principalId: "p_eric",
    principal: "eric@bullmoose.test",
    tokenScopes: ["read"],
    bindings: [binding()],
    credentials: [],
    bureauGrants: [],
    grantsHeld: [],
    grantsGiven: [],
    invocations: [invocation()],
    spend: null,
    ledgers: [
      {
        bindingId: "ab_extract",
        pending: 3,
        running: 1,
        done: 412,
        failed: 2,
        oldestPendingAt: NOW - 2 * HOUR,
        monthSpendMicros: 500_000,
        monthOverageMicros: 0,
      },
    ],
    ledgerMonthStart: Date.parse("2026-08-01T00:00:00Z"),
    ...over,
  };
}

function annotation(over: Partial<Annotation> = {}): Annotation {
  return {
    id: `an-${Math.random().toString(36).slice(2)}`,
    accountId: ACCOUNT,
    authorKind: "agent",
    author: "extractor",
    anchor: { realm: "Email", objectId: "e1" },
    class: "event",
    body: "Tournament Saturday, arrive 7:30am",
    confidence: 0.8,
    status: "open",
    rationale: null,
    sourceRef: "e1",
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    ...over,
  };
}

function proposal(over: Partial<ActionProposal> = {}): ActionProposal {
  return {
    id: `ap-${Math.random().toString(36).slice(2)}`,
    accountId: ACCOUNT,
    agent: "extractor",
    kind: "verb-schedule",
    tier: 1,
    subject: { realm: "Email", objectId: "e1" },
    payload: {},
    editedPayload: null,
    rationale: "the message names a start time",
    evidence: [],
    status: "pending",
    decision: null,
    createdAt: new Date(NOW - HOUR).toISOString(),
    decidedAt: null,
    holdUntil: null,
    expiresAt: null,
    dueAt: null,
    question: null,
    amendments: [],
    invocationStatus: "done",
    claimedAt: null,
    costMicros: 1_000,
    tokensIn: null,
    tokensOut: null,
    costModel: "workers-ai/llama",
    ...over,
  };
}

// ── the mix ────────────────────────────────────────────────────────────────

describe("invocationMix", () => {
  it("counts the rungs and records the span the sample actually covers", () => {
    const mix = invocationMix(
      [
        invocation({ createdAt: NOW - 3 * HOUR, note: "no extraction cues — skipped, no model call" }),
        invocation({ createdAt: NOW - 2 * HOUR, note: "scouted: nothing — no paid call" }),
        invocation({ createdAt: NOW - HOUR, note: "extracted 2, offered 1" }),
        invocation({ createdAt: NOW - 30 * 60_000, status: "failed", note: "provider returned 429" }),
        invocation({ createdAt: NOW - 60_000, status: "pending", note: null }),
      ],
      false,
    );
    expect(mix.counts).toEqual({ skipped: 1, screened: 1, ran: 1, failed: 1, inflight: 1 });
    expect(mix.sampled).toBe(5);
    expect(mix.from).toBe(NOW - 3 * HOUR);
    expect(mix.to).toBe(NOW - 60_000);
  });

  it("has no span when it sampled nothing — null, not the window's own edges", () => {
    const mix = invocationMix([], false);
    expect(mix.from).toBeNull();
    expect(mix.to).toBeNull();
    expect(mix.sampled).toBe(0);
  });

  it("carries the truncation flag it was handed, not one it inferred per binding", () => {
    expect(invocationMix([invocation()], true).truncated).toBe(true);
  });
});

describe("mixRows", () => {
  it("renders in ladder order — cheapest rung first — and omits empty rungs", () => {
    const mix = invocationMix(
      [
        invocation({ status: "failed", note: null }),
        invocation({ note: "no model call" }),
        invocation({ note: "extracted 1" }),
      ],
      false,
    );
    expect(mixRows(mix).map((r) => r.rung)).toEqual(["skipped", "ran", "failed"]);
  });
});

// ── produced ───────────────────────────────────────────────────────────────

describe("producedView", () => {
  it("tallies annotations by class and proposals by kind, biggest first", () => {
    const v = producedView(
      [annotation({ class: "event" }), annotation({ class: "event" }), annotation({ class: "contact" })],
      [proposal({ kind: "verb-schedule" }), proposal({ kind: "create-contact" })],
    );
    expect(v.annotations).toEqual([
      { label: "event", count: 2 },
      { label: "contact", count: 1 },
    ]);
    expect(v.annotationTotal).toBe(3);
    expect(v.proposals.map((p) => p.label)).toEqual(["create-contact", "verb-schedule"]);
    expect(v.proposalTotal).toBe(2);
  });

  it("counts dismissals separately — 'Not a real one' is the labelled negative", () => {
    const v = producedView([annotation({ status: "dismissed" }), annotation({ status: "open" })], []);
    expect(v.dismissed).toBe(1);
    expect(v.annotationTotal).toBe(2);
  });
});

// ── the computable metric ──────────────────────────────────────────────────

describe("declineMetric — the UI-defect number", () => {
  const declined = (reason: string) =>
    proposal({ status: "rejected", decision: { by: "eric@bullmoose.test", reason } });

  it("is a share of DECIDED proposals, not of all of them", () => {
    const m = declineMetric([
      declined("unintendedInvocation"),
      declined("wrongContent"),
      proposal({ status: "approved", decision: { by: "eric@bullmoose.test" } }),
      proposal({ status: "pending" }),
    ]);
    expect(m.decided).toBe(3);
    expect(m.unintended).toBe(1);
    expect(m.rate).toBeCloseTo(33.33, 1);
  });

  it("does not count an EXPIRY as a decision — nobody decided that", () => {
    // The sweep leaves `decision` null, so an expired row must not dilute a
    // rate that is meant to measure human clicks.
    const m = declineMetric([proposal({ status: "expired" }), declined("unintendedInvocation")]);
    expect(m.decided).toBe(1);
    expect(m.rate).toBe(100);
  });

  it("is NULL on an empty denominator — 0% would be a false all-clear", () => {
    expect(declineMetric([]).rate).toBeNull();
    expect(declineMetric([proposal({ status: "pending" })]).rate).toBeNull();
  });
});

// ── assembly ───────────────────────────────────────────────────────────────

describe("buildReceipt", () => {
  it("joins runs by bindingId and produced work by binding NAME", () => {
    const r = buildReceipt({
      dossiers: [dossier()],
      proposals: [proposal()],
      annotations: [annotation()],
      window: WINDOW,
    });
    expect(r.bindings).toHaveLength(1);
    const b = r.bindings[0]!;
    expect(b.id).toBe(`${ACCOUNT}/ab_extract`);
    expect(b.mix.sampled).toBe(1);
    expect(b.produced.annotationTotal).toBe(1);
    expect(b.produced.proposalTotal).toBe(1);
    expect(r.unattributed.annotationTotal).toBe(0);
  });

  it("keeps the binding's cap and its month spend — the numbers that gate paid work", () => {
    const b = buildReceipt({ dossiers: [dossier()], proposals: [], annotations: [], window: WINDOW }).bindings[0]!;
    expect(b.economics.capLabel).toBe("$2.00 / month");
    expect(b.economics.spentLabel).toBe("$0.50 spent this month");
    expect(b.ledger).toEqual({ pending: 3, running: 1, done: 412, failed: 2 });
  });

  it("drops rows older than the window on both clocks — number and ISO string", () => {
    const r = buildReceipt({
      dossiers: [
        dossier({
          invocations: [invocation({ createdAt: NOW - HOUR }), invocation({ createdAt: NOW - 30 * DAY })],
        }),
      ],
      proposals: [proposal({ createdAt: new Date(NOW - 30 * DAY).toISOString() })],
      annotations: [annotation({ createdAt: NOW - 30 * DAY })],
      window: WINDOW,
    });
    expect(r.bindings[0]!.mix.sampled).toBe(1);
    expect(r.bindings[0]!.produced.annotationTotal).toBe(0);
    expect(r.bindings[0]!.produced.proposalTotal).toBe(0);
  });

  it("keeps a proposal whose timestamp will not parse rather than shrinking the page", () => {
    const r = buildReceipt({
      dossiers: [dossier()],
      proposals: [proposal({ createdAt: "not a date" })],
      annotations: [],
      window: WINDOW,
    });
    expect(r.bindings[0]!.produced.proposalTotal).toBe(1);
  });

  it("collects work whose author matches no binding instead of dropping it", () => {
    // A renamed binding, a deleted agent, a human-filed claim. Silently
    // discarding these would make the ledger disagree with the database.
    const r = buildReceipt({
      dossiers: [dossier()],
      proposals: [proposal({ agent: "some-retired-name" })],
      annotations: [annotation({ authorKind: "human", author: "eric@bullmoose.test" })],
      window: WINDOW,
    });
    expect(r.bindings[0]!.produced.proposalTotal).toBe(0);
    expect(r.unattributed.proposalTotal).toBe(1);
    expect(r.unattributed.annotationTotal).toBe(1);
  });

  it("never pins produced work on the wrong account, even for a same-named binding", () => {
    const other = dossier({ accountId: "acct-emily", principal: "emily@bullmoose.test" });
    const r = buildReceipt({
      dossiers: [dossier(), other],
      proposals: [proposal({ accountId: "acct-emily" })],
      annotations: [],
      window: WINDOW,
    });
    const eric = r.bindings.find((b) => b.accountId === ACCOUNT)!;
    const emily = r.bindings.find((b) => b.accountId === "acct-emily")!;
    expect(eric.produced.proposalTotal).toBe(0);
    expect(emily.produced.proposalTotal).toBe(1);
  });

  it("flags truncation when the console served its cap", () => {
    const many = Array.from({ length: CONSOLE_INVOCATION_CAP }, (_, i) => invocation({ createdAt: NOW - i * 60_000 }));
    const r = buildReceipt({
      dossiers: [dossier({ invocations: many })],
      proposals: [],
      annotations: [],
      window: WINDOW,
    });
    expect(r.bindings[0]!.mix.truncated).toBe(true);
  });

  it("marks produced counts INCOMPLETE when the account's read failed", () => {
    // Zero-because-we-could-not-ask must never render as zero-because-nothing-
    // happened. This flag is the only thing standing between those two.
    const r = buildReceipt({
      dossiers: [dossier()],
      proposals: [],
      annotations: [],
      window: WINDOW,
      producedFailures: { [ACCOUNT]: "proposals: forbidden" },
    });
    expect(r.bindings[0]!.producedComplete).toBe(false);
  });

  it("sums cost across bindings with NULL kept out of the total", () => {
    const r = buildReceipt({
      dossiers: [
        dossier({
          invocations: [
            invocation({ costMicros: 1_000 }),
            invocation({ costMicros: null }),
            invocation({ costMicros: 0 }),
          ],
        }),
      ],
      proposals: [],
      annotations: [],
      window: WINDOW,
    });
    expect(r.totalCost).toEqual({ micros: 1_000, recorded: 2, unrecorded: 1, free: 1 });
  });

  it("always carries the manual-scheduling absence — the metric it may not invent", () => {
    const r = buildReceipt({ dossiers: [dossier()], proposals: [], annotations: [], window: WINDOW });
    expect(r.absent).toContain(MANUAL_SCHEDULE_ABSENCE);
    expect(MANUAL_SCHEDULE_ABSENCE.missing).toContain("Nothing records a manual schedule");
  });

  it("orders bindings by account address then name, matching the agents realm", () => {
    const r = buildReceipt({
      dossiers: [
        dossier({ accountId: "acct-z", principal: "zoe@bullmoose.test" }),
        dossier({ bindings: [binding({ bindingId: "ab_b", name: "bouncer" }), binding()] }),
      ],
      proposals: [],
      annotations: [],
      window: WINDOW,
    });
    expect(r.bindings.map((b) => b.name)).toEqual(["bouncer", "extractor", "extractor"]);
  });
});
