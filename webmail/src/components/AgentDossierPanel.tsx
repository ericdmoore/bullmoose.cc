/** @jsxImportSource preact */
import { Avatar, Badge, ListContainer, ListRow } from "./ui";
import type { BadgeTone } from "../lib/ui/classes";
import { spendBarToneClass, type DossierView, type InvocationRow } from "../lib/agents/dossier";

// s26 T1 — the dossier detail panel: one agent binding's page, STATELESS.
// Everything shown is a value `lib/agents/dossier.ts` already derived and
// tested; this file is markup over the T0 primitives, render-tested via
// preact-render-to-string (the ui.test.tsx pattern).
//
// The spend meter encodes STATE (under / near / exhausted — the claim gate's
// own bands), so it wears the status tones and never color alone: the labels
// beside it say the same thing in words, and the bar itself is a discrete
// class-swap (CSP: no inline style, ever).

const STATUS_TONE: Record<InvocationRow["status"], BadgeTone> = {
  pending: "warn",
  running: "accent",
  done: "success",
  failed: "error",
};

/** A small uppercase section heading — the CollectionColumn group treatment. */
function SectionHeading({ children }: { children: string }) {
  return (
    <h3 class="pb-2 text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">{children}</h3>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: BadgeTone }) {
  return (
    <div class="rounded-lg border border-gray-200 px-3 py-2 dark:border-white/10">
      <dt class="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
      <dd
        class={
          "text-lg font-semibold tabular-nums " +
          (tone === "error" && value > 0 ? "text-red-600 dark:text-red-400" : "text-gray-900 dark:text-white")
        }
      >
        {value}
      </dd>
    </div>
  );
}

export default function AgentDossierPanel({ view }: { view: DossierView }) {
  const { binding, address, economics, models, ledger, recent } = view;
  return (
    <article aria-label={`Dossier for ${binding.name}`} class="flex flex-col gap-y-6 pb-8">
      {/* ── identity ─────────────────────────────────────────────────── */}
      <header class="flex items-start gap-x-3">
        <Avatar name={binding.name} size="lg" />
        <div class="min-w-0 grow">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 class="text-lg font-semibold text-gray-900 dark:text-white">{binding.name}</h2>
            <Badge tone={binding.enabled ? "success" : "error"}>{binding.enabled ? "enabled" : "disabled"}</Badge>
            <Badge tone="accent">{binding.config.pipeline ?? "reply"}</Badge>
            {binding.config.replyMode ? <Badge>replies: {binding.config.replyMode}</Badge> : null}
          </div>
          <p class="truncate text-sm text-gray-500 dark:text-gray-400">{address}</p>
          <p class="text-xs text-gray-500 dark:text-gray-400">
            trigger: {binding.triggerOn}
            {binding.slaSeconds !== null ? ` · SLA ${binding.slaSeconds}s` : ""}
            {binding.config.senderAllowlist?.active
              ? ` · sender allowlist (${binding.config.senderAllowlist.count ?? 0})`
              : ""}
          </p>
          {binding.config.configUnparseable ? (
            <p class="mt-1 text-xs text-amber-700 dark:text-amber-300">
              This binding's stored config does not parse — the fields below show its defaults, not its intent.
            </p>
          ) : null}
        </div>
      </header>

      {/* Enable/disable is a real verb (the 008 kill switch) with no
          session-reachable door yet — the console surface is read-only by
          contract. Say where the verb lives instead of hiding the state. */}
      {!binding.enabled ? (
        <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-400/10 dark:text-red-200">
          The kill switch is thrown: nothing invokes this agent and queued work sits. Re-enabling is an operator verb —{" "}
          <code class="font-mono text-xs">bullmoose admin agent enable {binding.bindingId}</code>.
        </p>
      ) : null}

      {/* ── economics ────────────────────────────────────────────────── */}
      <section aria-label="Economics">
        <SectionHeading>Budget · this month</SectionHeading>
        {economics.capLabel === null ? (
          <p class="text-sm text-gray-700 dark:text-gray-300">
            {economics.spentLabel} · no monthly cap is set, so spend is not budget-gated.
          </p>
        ) : (
          <div class="flex flex-col gap-y-1.5">
            <div class="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
              <span class="font-medium text-gray-900 dark:text-white">{economics.capLabel}</span>
              <span class="text-gray-500 dark:text-gray-400">{economics.spentLabel}</span>
            </div>
            <div
              role="progressbar"
              aria-label="Share of this month's budget spent"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(economics.pctUsed ?? 0)}
              class="h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-white/10"
            >
              <div class={`h-2 rounded-full ${spendBarToneClass(economics.state)} ${economics.barWidthClass}`} />
            </div>
            <p
              class={
                "text-sm " +
                (economics.state === "exhausted"
                  ? "font-medium text-red-700 dark:text-red-300"
                  : "text-gray-700 dark:text-gray-300")
              }
            >
              {economics.remainingLabel}
              {economics.overageLabel ? ` · ${economics.overageLabel}` : ""}
            </p>
          </div>
        )}
      </section>

      {/* ── the model menu ───────────────────────────────────────────── */}
      <section aria-label="Model menu">
        <SectionHeading>Model menu</SectionHeading>
        {models.entries.length === 0 ? (
          <p class="text-sm text-gray-500 dark:text-gray-400">
            No aliases configured — the pipeline's default applies.
          </p>
        ) : (
          <dl class="flex flex-col gap-y-1">
            {models.entries.map((e) => (
              <div key={e.alias} class="flex flex-wrap items-baseline gap-x-2 text-sm">
                <dt class="font-medium text-gray-900 dark:text-white">
                  {e.alias}
                  {models.defaultModel === e.alias ? <Badge class="ml-1.5">default</Badge> : null}
                </dt>
                <dd class="text-gray-500 dark:text-gray-400">{e.chain}</dd>
              </div>
            ))}
          </dl>
        )}
        {models.exploreLabel ? (
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">{models.exploreLabel}</p>
        ) : null}
      </section>

      {/* ── the work ledger ──────────────────────────────────────────── */}
      <section aria-label="Work ledger">
        <SectionHeading>Work ledger</SectionHeading>
        <dl class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="pending" value={ledger.pending} />
          <Stat label="running" value={ledger.running} />
          <Stat label="done" value={ledger.done} />
          <Stat label="failed" value={ledger.failed} tone="error" />
        </dl>
        {ledger.oldestPendingLabel ? (
          <p class="mt-1.5 text-sm text-gray-700 dark:text-gray-300">{ledger.oldestPendingLabel}</p>
        ) : null}
      </section>

      {/* ── recent invocations ───────────────────────────────────────── */}
      <section aria-label="Recent invocations">
        <SectionHeading>Recent invocations</SectionHeading>
        {recent.length === 0 ? (
          <p class="text-sm text-gray-500 dark:text-gray-400">Nothing recorded yet for this agent.</p>
        ) : (
          <ListContainer>
            {recent.map((r) => (
              <ListRow key={r.id}>
                <span class="flex min-w-0 grow flex-col gap-y-0.5">
                  <span class="flex flex-wrap items-center gap-x-2 text-sm">
                    <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                    <span class="text-gray-500 dark:text-gray-400">{r.whenLabel}</span>
                    {/* µUSD discipline rides through costLabel verbatim:
                        null → "cost not recorded", 0 → "free". */}
                    <span class="text-gray-700 dark:text-gray-300">{r.costText}</span>
                  </span>
                  {r.note ? <span class="truncate text-xs text-gray-500 dark:text-gray-400">{r.note}</span> : null}
                </span>
              </ListRow>
            ))}
          </ListContainer>
        )}
      </section>
    </article>
  );
}
