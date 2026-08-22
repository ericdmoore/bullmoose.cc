/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import { resolveClient } from "../lib/app/client";
import { resolveConsole } from "../lib/app/console";
import { spendBarToneClass } from "../lib/agents/dossier";
import { consoleGate } from "../lib/console/gate";
import type { AgentConsoleClient } from "../lib/console/ConsoleClient";
import { formatDuration } from "../lib/approvals/clocks";
import { loadReceipt, type ReceiptData } from "../lib/receipt/api";
import { moneyCaveat, moneyLabel } from "../lib/receipt/money";
import { rungLabel, skipShare } from "../lib/receipt/outcomes";
import { TRUNCATION_NOTE, buildReceipt, mixRows } from "../lib/receipt/shape";
import {
  DEFAULT_WINDOW,
  RECEIPT_WINDOWS,
  receiptWindow,
  type BindingReceipt,
  type ClassCount,
  type MoneyTotal,
  type ReceiptWindowId,
  type UnavailableMetric,
} from "../lib/receipt/types";
import { Alert, Badge, Button, EmptyState, PageNotice } from "./ui";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Session } from "../lib/jmap/types";

// The extraction receipt (s36) — "what has the agent been doing, and what did
// it cost?", for a human, without `wrangler d1 execute`.
//
// s36's readme repeats *"measure, do not estimate"* until it is the plan's
// spine, and `invocationCost` has stamped real per-invocation cost against a
// binding's budget since s07 T5 — but nothing ever read it back. Judging
// whether the extractor is any good meant opening a SQL client. This page is
// what makes tomorrow's judgement possible, and it is deliberately RETROSPECTIVE
// and read-only: no verbs, no filing, nothing to approve. Decisions live in
// /approvals; what happened lives here.
//
// Deliberately THIN, the split every island here follows: vitest runs in plain
// Node with no jsdom, so every rule lives in `lib/receipt/*` as tested pure
// functions — the two reads in `api.ts`, the ladder classification in
// `outcomes.ts`, the NULL-vs-0 money discipline in `money.ts`, the rollup in
// `shape.ts`. This file is state plumbing and markup; if a number is computed
// in it, it is in the wrong file.
//
// ⚠️ THE ONE RULE THIS PAGE MUST NOT BREAK. Every figure here is either
// measured or named as absent. A missing cost renders "cost not recorded", never
// $0.00; a metric with no data renders as a named absence with what is missing,
// never as 0%; a sampled outcome mix says it is a sample. A receipt that
// invents a flattering number is worse than no receipt, because someone will
// quote it in a design decision six weeks from now.

interface Props {
  /** Injected in tests; the screen resolves its own otherwise. */
  client?: JmapClient;
  reads?: AgentConsoleClient;
  /** Fixes the window and the "ago" labels for a deterministic render. */
  now?: number;
}

export default function ReceiptView({ client: injectedClient, reads: injectedReads, now: fixedNow }: Props) {
  const [client, setClient] = useState<JmapClient | undefined>(injectedClient);
  const [reads, setReads] = useState<AgentConsoleClient | undefined>(injectedReads);
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [fatal, setFatal] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ReceiptData | undefined>(undefined);
  const [windowId, setWindowId] = useState<ReceiptWindowId>(DEFAULT_WINDOW);

  // A retrospective does not need a ticking clock (the /activity rule): one
  // `now`, taken at mount, so the window does not slide under the reader.
  const [now] = useState<number>(() => fixedNow ?? Date.now());

  // ── bootstrap ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let jmap = injectedClient;
        if (!jmap) {
          const resolved = resolveClient();
          // The same rule as every other section: no session → the door, never
          // a convincing sample ledger a stranger could mistake for theirs.
          if (resolved.mode === "unauthenticated") {
            location.assign("/login");
            return;
          }
          if (resolved.mode === "demo") {
            // Demo-only and loaded on demand, so the approvals fixtures never
            // reach a live bundle. Composed, not cloned — `demoActivity.ts`'s
            // pattern: the proposals this page counts are the SAME rows
            // /approvals?demo=1 shows.
            //
            // ⚠️ In DEMO the two doors do not share account ids: the console
            // fixture's agents are `acct_allen`/`acct_analyst` and the approvals
            // fixture's rows are `acct-fake`, because the two were built by
            // different slices. So sample proposals land under "not
            // attributable to a binding" rather than on a card. That is the
            // join behaving correctly on mismatched fixtures, and it is left
            // visible rather than papered over with a remap that would only
            // ever be true in the demo.
            const { installApprovalsDemo } = await import("../lib/approvals/demoApprovals");
            installApprovalsDemo(resolved.demo.client, { now });
          }
          jmap = resolved.client;
        }
        const live = await jmap.session();
        if (cancelled) return;
        setSession(live);
        setClient(jmap);
        if (!injectedReads) setReads(resolveConsole().reads);
      } catch (err) {
        if (!cancelled) setFatal(message(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [injectedClient, injectedReads, now]);

  const gate = consoleGate(session);

  // ── the reads ───────────────────────────────────────────────────────────
  // Window changes do NOT re-fetch: neither door takes a time filter (see
  // `lib/receipt/api.ts`), so the window is applied to rows already in hand.
  // Re-querying would spend two round trips to receive the same bytes.
  useEffect(() => {
    if (!client || !reads || gate.state !== "open") return;
    let cancelled = false;
    setLoading(true);
    void loadReceipt(client, reads)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setFatal(message(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, reads, gate.state]);

  const receipt = useMemo(
    () =>
      data
        ? buildReceipt({
            dossiers: data.dossiers,
            proposals: data.proposals,
            annotations: data.annotations,
            window: receiptWindow(windowId, now),
            producedFailures: data.producedFailures,
          })
        : undefined,
    [data, windowId, now],
  );

  // ── shells ──────────────────────────────────────────────────────────────
  // `div`, not `main`: AppTw.astro owns the page's one <main>.
  if (fatal) {
    return (
      <PageNotice title="Could not read the ledger" error>
        <p role="alert">{fatal}</p>
      </PageNotice>
    );
  }
  if (!session) return <PageNotice>Connecting…</PageNotice>;
  if (gate.state !== "open") {
    return (
      <PageNotice title="There is no agent ledger here">
        <p>{gate.reason}</p>
        <p class="mt-2">
          <a href="/mail" class="font-medium text-brand-600 hover:text-brand-500">
            Back to mail
          </a>
        </p>
      </PageNotice>
    );
  }

  return (
    <div class="mx-auto flex w-full max-w-4xl flex-col gap-y-8 px-4 py-6 sm:px-6 lg:px-8">
      <header class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 class="text-base font-semibold text-gray-900 dark:text-white">What the agents did, and what it cost</h2>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Measured, never estimated. A cost that was not recorded says so — it is never shown as $0.00, because
            “nothing was stamped” and “this run was genuinely free” are different facts.
          </p>
        </div>
        <div class="flex gap-x-2" role="group" aria-label="Window">
          {RECEIPT_WINDOWS.map((w) => (
            <Button
              key={w.id}
              variant={w.id === windowId ? "primary" : "secondary"}
              size="sm"
              onClick={() => setWindowId(w.id)}
            >
              {w.label}
            </Button>
          ))}
        </div>
      </header>

      {Object.entries(data?.dossierFailures ?? {}).map(([id, why]) => (
        <Alert key={id} tone="error">
          {id}: {why}
        </Alert>
      ))}

      {loading ? <p class="text-sm text-gray-500 dark:text-gray-400">Reading the ledger…</p> : null}

      {!loading && receipt && receipt.bindings.length === 0 ? (
        <EmptyState title="No agent binding to account for">
          Nothing on this session has an agent binding, so there is no work and no spend to report.
        </EmptyState>
      ) : null}

      {!loading && receipt && receipt.bindings.length > 0 ? (
        <>
          <TotalRow total={receipt.totalCost} label={receipt.window.label} />
          {receipt.bindings.map((b) => (
            <BindingCard key={b.id} b={b} now={now} />
          ))}
          <Metrics receipt={receipt} />
          {receipt.unattributed.annotationTotal > 0 || receipt.unattributed.proposalTotal > 0 ? (
            <section aria-label="Unattributed">
              <SectionHeading>Not attributable to a binding</SectionHeading>
              <p class="mb-2 text-sm text-gray-500 dark:text-gray-400">
                Work whose author matches no binding on any dossier — a renamed binding, a retired agent, or a claim a
                human filed. Shown rather than dropped: a ledger that silently discards rows is not a ledger.
              </p>
              <Tally label="Annotations" rows={receipt.unattributed.annotations} />
              <Tally label="Proposals" rows={receipt.unattributed.proposals} />
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ── pieces ─────────────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: string }) {
  return (
    <h3 class="pb-2 text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">{children}</h3>
  );
}

/** The one figure a reader comes for, with the fine print attached to it. */
function TotalRow({ total, label }: { total: MoneyTotal; label: string }) {
  const caveat = moneyCaveat(total);
  return (
    <section aria-label="Total spend" class="rounded-lg border border-gray-200 px-4 py-3 dark:border-white/10">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4">
        <span class="text-2xl font-semibold text-gray-900 dark:text-white">{moneyLabel(total)}</span>
        <span class="text-sm text-gray-500 dark:text-gray-400">across every binding, {label}</span>
      </div>
      {caveat ? <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">{caveat}</p> : null}
    </section>
  );
}

function Tally({ label, rows }: { label: string; rows: ClassCount[] }) {
  if (rows.length === 0) return null;
  return (
    <p class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <span class="text-gray-500 dark:text-gray-400">{label}:</span>
      {rows.map((r) => (
        <Badge key={r.label}>
          {r.label} · {r.count}
        </Badge>
      ))}
    </p>
  );
}

function BindingCard({ b, now }: { b: BindingReceipt; now: number }) {
  const rows = mixRows(b.mix);
  const share = skipShare(b.mix.counts);
  const caveat = moneyCaveat(b.windowCost);
  return (
    <section
      aria-label={`Receipt for ${b.name}`}
      class="flex flex-col gap-y-5 rounded-lg border border-gray-200 px-4 py-4 dark:border-white/10"
    >
      <header class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 class="text-sm font-semibold text-gray-900 dark:text-white">{b.name}</h3>
        <Badge tone="accent">{b.pipeline}</Badge>
        {!b.enabled ? <Badge tone="error">disabled</Badge> : null}
        <span class="text-xs text-gray-500 dark:text-gray-400">{b.principal}</span>
      </header>

      {/* ── the ladder ────────────────────────────────────────────────── */}
      {/* The mix between these rungs IS s36's economics argument. A receipt
          that showed only "ran / failed" would hide the entire reason the
          design is affordable enough to run on every delivered message. */}
      <section aria-label="Invocations">
        <SectionHeading>Invocations</SectionHeading>
        {b.mix.sampled === 0 ? (
          <p class="text-sm text-gray-500 dark:text-gray-400">
            No invocation in this window is visible to the reachable read.
          </p>
        ) : (
          <>
            <p class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
              {rows.map((r) => (
                <Badge key={r.rung} tone={r.rung === "failed" ? "error" : r.rung === "ran" ? "accent" : "neutral"}>
                  {r.count} {rungLabel(r.rung)}
                </Badge>
              ))}
            </p>
            {share !== null ? (
              <p class="mt-1.5 text-sm text-gray-700 dark:text-gray-300">
                {Math.round(share)}% of finished runs cost no paid model call — the pre-filter and the free scout.
              </p>
            ) : null}
            {b.mix.from !== null && b.mix.to !== null ? (
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {b.mix.sampled} runs seen, spanning {formatDuration(b.mix.to - b.mix.from)}, newest{" "}
                {formatDuration(now - b.mix.to)} ago.
              </p>
            ) : null}
          </>
        )}
        {b.mix.truncated ? (
          <Alert tone="warn" class="mt-2">
            {TRUNCATION_NOTE}
          </Alert>
        ) : null}
        <p class="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          Queue, all time: {b.ledger.done} done · {b.ledger.failed} failed · {b.ledger.pending} pending ·{" "}
          {b.ledger.running} running.
        </p>
      </section>

      {/* ── what it produced ──────────────────────────────────────────── */}
      <section aria-label="Produced">
        <SectionHeading>Produced</SectionHeading>
        {!b.producedComplete ? (
          // The distinction that keeps the page honest: an unreadable account
          // is not an idle agent, and a zero here would claim it was.
          <Alert tone="error">
            This account's proposals and annotations could not be read, so nothing below is a measurement of what this
            binding produced. It is an absence of data, not an absence of work.
          </Alert>
        ) : b.produced.annotationTotal === 0 && b.produced.proposalTotal === 0 ? (
          <p class="text-sm text-gray-500 dark:text-gray-400">Nothing in this window.</p>
        ) : (
          <div class="flex flex-col gap-y-1">
            <Tally label="Annotations" rows={b.produced.annotations} />
            <Tally label="Proposals" rows={b.produced.proposals} />
            {b.produced.dismissed > 0 ? (
              <p class="text-xs text-gray-500 dark:text-gray-400">
                {b.produced.dismissed} dismissed — “Not a real one”, the labelled negative the extractor trains on.
              </p>
            ) : null}
          </div>
        )}
      </section>

      {/* ── money ─────────────────────────────────────────────────────── */}
      <section aria-label="Cost">
        <SectionHeading>Cost</SectionHeading>
        <p class="text-sm text-gray-700 dark:text-gray-300">
          <span class="font-medium text-gray-900 dark:text-white">{moneyLabel(b.windowCost)}</span> over the runs seen
          above.
        </p>
        {caveat ? <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{caveat}</p> : null}

        {b.economics.capLabel === null ? (
          <p class="mt-2 text-sm text-gray-700 dark:text-gray-300">
            {b.economics.spentLabel} · no monthly cap is set, so spend is not budget-gated.
          </p>
        ) : (
          <div class="mt-2 flex flex-col gap-y-1.5">
            <div class="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
              <span class="font-medium text-gray-900 dark:text-white">{b.economics.capLabel}</span>
              <span class="text-gray-500 dark:text-gray-400">{b.economics.spentLabel}</span>
            </div>
            <div
              role="progressbar"
              aria-label="Share of this month's budget spent"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(b.economics.pctUsed ?? 0)}
              class="h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-white/10"
            >
              <div class={`h-2 rounded-full ${spendBarToneClass(b.economics.state)} ${b.economics.barWidthClass}`} />
            </div>
            <p
              class={
                "text-sm " +
                (b.economics.state === "exhausted"
                  ? "font-medium text-red-700 dark:text-red-300"
                  : "text-gray-700 dark:text-gray-300")
              }
            >
              {b.economics.remainingLabel}
              {b.economics.overageLabel ? ` · ${b.economics.overageLabel}` : ""}
            </p>
          </div>
        )}
      </section>
    </section>
  );
}

/**
 * s36 names two metrics as the ones that matter. Exactly one is computable
 * today, and the other is rendered as itself rather than as a zero — see
 * `MANUAL_SCHEDULE_ABSENCE`.
 */
function Metrics({ receipt }: { receipt: ReturnType<typeof buildReceipt> }) {
  const d = receipt.declines;
  return (
    <section aria-label="Metrics" class="flex flex-col gap-y-4">
      <SectionHeading>The two numbers s36 asks for</SectionHeading>

      <div class="rounded-lg border border-gray-200 px-4 py-3 dark:border-white/10">
        <h4 class="text-sm font-semibold text-gray-900 dark:text-white">Unintended-invocation declines</h4>
        <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
          A decline that teaches the agent nothing — it says the human mis-clicked. A rising rate is a UI defect report,
          not feedback on the extractor.
        </p>
        {d.rate === null ? (
          // Not 0%: "nobody decided anything" and "nobody mis-clicked" are
          // different facts, and 0% on an empty window is a false all-clear.
          <p class="mt-2 text-sm text-gray-700 dark:text-gray-300">
            No proposal was decided in this window, so there is no rate to report.
          </p>
        ) : (
          <p class="mt-2 text-sm text-gray-700 dark:text-gray-300">
            <span class="text-lg font-semibold text-gray-900 dark:text-white">{Math.round(d.rate)}%</span> —{" "}
            {d.unintended} of {d.decided} decisions.
          </p>
        )}
      </div>

      {receipt.absent.map((m) => (
        <Absence key={m.name} m={m} />
      ))}
    </section>
  );
}

function Absence({ m }: { m: UnavailableMetric }) {
  return (
    <div class="rounded-lg border border-dashed border-gray-300 px-4 py-3 dark:border-white/15">
      <div class="flex flex-wrap items-center gap-x-2">
        <h4 class="text-sm font-semibold text-gray-900 dark:text-white">{m.name}</h4>
        <Badge tone="warn">not measurable yet</Badge>
      </div>
      <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{m.question}</p>
      <p class="mt-2 text-sm text-gray-700 dark:text-gray-300">{m.missing}</p>
      <p class="mt-1 text-sm text-gray-700 dark:text-gray-300">{m.wouldNeed}</p>
    </div>
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
