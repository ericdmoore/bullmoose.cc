// s26 T1 — the Agents realm's pure shaping. The dossier surface renders what
// ALREADY EXISTS about an agent binding — identity, economics, the work
// ledger — and this module is where every derivation lives, tested as
// functions, so `AgentsApp.tsx` stays markup (the ApprovalsQueue →
// lib/approvals split, applied again).
//
// Data door: the `/console/*` read routes (`lib/console/ConsoleClient.ts`) —
// owner-only by that surface's Rule 1, which is why the realm lists OWNED
// agent accounts. µUSD money discipline throughout: `costMicros === null`
// means "cost not recorded" and 0 means "free" (`costLabel` is the one
// renderer of that rule, reused here rather than restated).

import { formatDuration } from "../approvals/clocks";
import { costLabel } from "../approvals/rows";
import type { AgentSummary } from "../console/ConsoleClient";
import type { AgentDossier, ConsoleBinding, ConsoleBindingLedger, ConsoleInvocation } from "../console/types";
import type { CollectionGroup } from "../shell/collections";

// ── the list rows (one per BINDING — an agent IS a binding) ────────────────

export interface AgentListRow {
  /** `accountId/bindingId` — see `agentRowId`/`parseAgentRowId`. */
  id: string;
  accountId: string;
  bindingId: string;
  /** The binding's name — "allen", "emily". */
  name: string;
  /** The account's address (`login_email`) — where its mail lives. */
  address: string;
  pipeline: string;
  enabled: boolean;
  /** Waiting work, from the ledger; 0 when the queue is empty. */
  pendingCount: number;
}

/** Stable per-binding selection id. `/` is safe: account ids carry no slash
 *  (`acct_…`), and binding ids (`ab_…`) ride whole after the first one. */
export function agentRowId(accountId: string, bindingId: string): string {
  return `${accountId}/${bindingId}`;
}

export function parseAgentRowId(id: string): { accountId: string; bindingId: string } | undefined {
  const at = id.indexOf("/");
  if (at <= 0 || at === id.length - 1) return undefined;
  return { accountId: id.slice(0, at), bindingId: id.slice(at + 1) };
}

export function ledgerFor(dossier: AgentDossier | undefined, bindingId: string): ConsoleBindingLedger | undefined {
  return dossier?.ledgers?.find((l) => l.bindingId === bindingId);
}

/**
 * Flatten the picker's accounts into one row per binding. Accounts whose
 * dossier has not loaded (or failed) still contribute nothing rather than a
 * ghost row — the caller reports the failure beside the list.
 */
export function agentListRows(
  summaries: readonly AgentSummary[],
  dossiers: Readonly<Record<string, AgentDossier>>,
): AgentListRow[] {
  const rows: AgentListRow[] = [];
  for (const s of summaries) {
    const d = dossiers[s.accountId];
    if (!d) continue;
    for (const b of d.bindings) {
      rows.push({
        id: agentRowId(s.accountId, b.bindingId),
        accountId: s.accountId,
        bindingId: b.bindingId,
        name: b.name,
        address: d.principal,
        pipeline: b.config.pipeline ?? "reply",
        enabled: b.enabled,
        pendingCount: ledgerFor(d, b.bindingId)?.pending ?? 0,
      });
    }
  }
  return rows;
}

/** The realm's contextual filter (s24 T5): name / address / pipeline. */
export function filterAgentRows(rows: readonly AgentListRow[], query: string): AgentListRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter(
    (r) =>
      r.name.toLowerCase().includes(q) || r.address.toLowerCase().includes(q) || r.pipeline.toLowerCase().includes(q),
  );
}

/** The CollectionColumn id that hosts the s03.E console (kept entry point). */
export const CONSOLE_COLLECTION = "console";
export const ALL_AGENTS_COLLECTION = "all";

/**
 * The realm's collections, v1: "All agents" (the dossier surface), and the
 * s03.E access console under Governance — the entry point `/agents` carried
 * before this realm existed, kept rather than orphaned.
 */
export function agentCollections(rows: readonly AgentListRow[]): CollectionGroup[] {
  return [
    {
      id: "agents",
      items: [{ id: ALL_AGENTS_COLLECTION, label: "All agents", count: rows.length }],
    },
    {
      id: "governance",
      label: "Governance",
      items: [{ id: CONSOLE_COLLECTION, label: "Access console" }],
    },
  ];
}

// ── money ──────────────────────────────────────────────────────────────────

/**
 * An aggregate µUSD amount as money. Unlike `costLabel` this never says "not
 * recorded" — aggregates are the gate's COALESCE-to-0 arithmetic, where 0 is
 * a real number, not an absence.
 */
export function microsLabel(micros: number): string {
  const usd = micros / 1_000_000;
  return usd >= 0.01 || micros === 0 ? `$${usd.toFixed(2)}` : `${micros.toLocaleString()} µ$`;
}

// ── economics: spent vs remaining ──────────────────────────────────────────

/** Discrete bar widths — CSP forbids inline `style`, so the spend bar snaps
 *  to twelfths via class-swap, exactly like the rail's resize. */
const BAR_WIDTHS = [
  "w-0",
  "w-1/12",
  "w-2/12",
  "w-3/12",
  "w-4/12",
  "w-5/12",
  "w-6/12",
  "w-7/12",
  "w-8/12",
  "w-9/12",
  "w-10/12",
  "w-11/12",
  "w-full",
] as const;

/** pct (0–100, any float) → the nearest discrete width class, clamped. A
 *  nonzero spend never rounds down to invisible. */
export function spendBarWidthClass(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return BAR_WIDTHS[0];
  const step = Math.round((Math.min(pct, 100) / 100) * 12);
  return BAR_WIDTHS[Math.min(Math.max(step, 1), 12)] as string;
}

export type BudgetState = "no-cap" | "under" | "near" | "exhausted";

export interface EconomicsView {
  /** null = no monthly cap configured (spend is not budget-gated). */
  capLabel: string | null;
  spentLabel: string;
  /** null when there is no cap to subtract from. */
  remainingLabel: string | null;
  /** "+$0.50 approved overage" when the period carries one (s11 T9). */
  overageLabel: string | null;
  /** 0–100 of the EFFECTIVE ceiling (cap + overage); null when no cap. */
  pctUsed: number | null;
  barWidthClass: string;
  state: BudgetState;
}

/** ≥ this share of the ceiling used renders the bar in the warn tone. */
export const NEAR_BUDGET_PCT = 80;

/**
 * Spent-vs-remaining, in the claim gate's own arithmetic: the effective
 * ceiling is cap + approved overage (`budgetExhaustedSql`), and "exhausted"
 * here is exactly the condition under which the gate narrows the binding's
 * claimant set to free runtimes only.
 */
export function economicsView(binding: ConsoleBinding, ledger: ConsoleBindingLedger | undefined): EconomicsView {
  const spent = ledger?.monthSpendMicros ?? 0;
  const overage = ledger?.monthOverageMicros ?? 0;
  const cap = binding.economics?.budgetMicros ?? null;
  const spentLabel = `${microsLabel(spent)} spent this month`;
  if (cap === null) {
    return {
      capLabel: null,
      spentLabel,
      remainingLabel: null,
      overageLabel: overage > 0 ? `+${microsLabel(overage)} approved overage` : null,
      pctUsed: null,
      barWidthClass: spendBarWidthClass(0),
      state: "no-cap",
    };
  }
  const ceiling = cap + overage;
  const pct = ceiling > 0 ? (spent / ceiling) * 100 : 100;
  const exhausted = spent >= ceiling;
  return {
    capLabel: `${microsLabel(cap)} / month`,
    spentLabel,
    remainingLabel: exhausted
      ? "nothing remaining — paid work waits for the month roll"
      : `${microsLabel(ceiling - spent)} remaining`,
    overageLabel: overage > 0 ? `+${microsLabel(overage)} approved overage` : null,
    pctUsed: Math.min(Math.max(pct, 0), 100),
    barWidthClass: spendBarWidthClass(pct),
    state: exhausted ? "exhausted" : pct >= NEAR_BUDGET_PCT ? "near" : "under",
  };
}

/** The bar's fill tone per state — class-swap, tested as data. */
export function spendBarToneClass(state: BudgetState): string {
  switch (state) {
    case "exhausted":
      return "bg-red-600";
    case "near":
      return "bg-amber-500";
    default:
      return "bg-brand-600";
  }
}

// ── the model menu ─────────────────────────────────────────────────────────

export interface ModelMenuView {
  defaultModel: string | null;
  entries: Array<{ alias: string; chain: string }>;
  /** "explores 10% of runs across the menu" — null when frontier is off. */
  exploreLabel: string | null;
}

export function modelMenuView(binding: ConsoleBinding): ModelMenuView {
  const eco = binding.economics;
  const entries = (eco?.modelMenu ?? []).map((e) => ({
    alias: e.alias,
    chain: e.candidates.length > 0 ? e.candidates.join(" → ") : "no candidates configured",
  }));
  const rate = eco?.exploreRate ?? null;
  return {
    defaultModel: eco?.defaultModel ?? null,
    entries,
    exploreLabel:
      rate !== null && rate > 0 ? `frontier: explores ${Math.round(rate * 100)}% of runs across the menu` : null,
  };
}

// ── the work ledger ────────────────────────────────────────────────────────

export interface LedgerView {
  pending: number;
  running: number;
  done: number;
  failed: number;
  /** "oldest pending waited 3h 12m" — null when nothing is pending. */
  oldestPendingLabel: string | null;
}

export function ledgerView(ledger: ConsoleBindingLedger | undefined, now: number): LedgerView {
  const oldest = ledger?.oldestPendingAt ?? null;
  return {
    pending: ledger?.pending ?? 0,
    running: ledger?.running ?? 0,
    done: ledger?.done ?? 0,
    failed: ledger?.failed ?? 0,
    oldestPendingLabel: oldest === null ? null : `oldest pending waited ${formatDuration(now - oldest)}`,
  };
}

// ── recent invocations ─────────────────────────────────────────────────────

export interface InvocationRow {
  id: string;
  status: ConsoleInvocation["status"];
  /** "3h 12m ago", from created_at. */
  whenLabel: string;
  note: string | null;
  /** `costLabel`'s exact rule: null = "cost not recorded", 0 = "free". */
  costText: string;
  emailId: string | null;
}

export function invocationRows(
  invocations: readonly ConsoleInvocation[],
  bindingId: string,
  now: number,
): InvocationRow[] {
  return invocations
    .filter((i) => i.bindingId === bindingId)
    .map((i) => ({
      id: i.invocationId,
      status: i.status,
      whenLabel: `${formatDuration(now - i.createdAt)} ago`,
      note: i.note,
      costText: costLabel({ costMicros: i.costMicros ?? null, costModel: i.model ?? null }),
      emailId: i.emailId,
    }));
}

// ── the assembled dossier view ─────────────────────────────────────────────

export interface DossierView {
  binding: ConsoleBinding;
  address: string;
  economics: EconomicsView;
  models: ModelMenuView;
  ledger: LedgerView;
  recent: InvocationRow[];
}

/** Everything the detail panel renders for one binding, or undefined when the
 *  binding is not on this dossier (a stale selection self-repairs upstream). */
export function buildDossierView(dossier: AgentDossier, bindingId: string, now: number): DossierView | undefined {
  const binding = dossier.bindings.find((b) => b.bindingId === bindingId);
  if (!binding) return undefined;
  const ledger = ledgerFor(dossier, bindingId);
  return {
    binding,
    address: dossier.principal,
    economics: economicsView(binding, ledger),
    models: modelMenuView(binding),
    ledger: ledgerView(ledger, now),
    recent: invocationRows(dossier.invocations, bindingId, now),
  };
}
