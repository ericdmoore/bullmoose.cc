/** @jsxImportSource preact */
import { Avatar, Badge, Button, ListContainer, ListRow } from "./ui";
import type { BadgeTone } from "../lib/ui/classes";
import { spendBarToneClass, type DossierView, type InvocationRow } from "../lib/agents/dossier";
import type { BindingByokView } from "../lib/byok/status";

/**
 * The kill-switch control's wiring (s26 T2). The panel stays STATELESS: the
 * island owns the optimistic flip, the busy flag and the refusal message, and
 * hands them down. When no toggle is wired (no writable client) the panel
 * falls back to naming the operator verb — the T1 behaviour, kept honest.
 */
export interface BindingToggle {
  busy: boolean;
  error?: string;
  onToggle: (next: boolean) => void;
}

/**
 * The BYOK control's wiring (s26 T4). Same bargain as the toggle: the panel
 * stays STATELESS and the island owns the call, the busy flag and the refusal.
 *
 * Only DETACH lives here, and that is the s26 discriminator applied rather than
 * a scope cut. Ask the rule — *"if this agent were deleted, would the value
 * still mean anything?"* — of each half: the KEY is sealed against the
 * PRINCIPAL, survives every agent on the account and is not even
 * account-scoped, so adding, rotating and revoking it belong in Settings →
 * Agents; **which** binding spends it is a line in that binding's `config_json`
 * that dies with it, so it belongs here, with detach as its verb.
 */
export interface BindingCredential {
  view: BindingByokView;
  busy: boolean;
  error?: string;
  onDetach: () => void;
}

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

/** BYOK status → the chip tone. Every failure is `error` on purpose: a binding
 *  whose credential does not resolve REFUSES every model call, which is a
 *  broken agent, not a warning. */
const BYOK_TONE: Record<BindingByokView["copy"]["tone"], BadgeTone> = {
  success: "success",
  warn: "warn",
  error: "error",
  neutral: "neutral",
};

export default function AgentDossierPanel({
  view,
  toggle,
  credential,
}: {
  view: DossierView;
  toggle?: BindingToggle;
  credential?: BindingCredential;
}) {
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

      {/* ── the kill switch (008), live since s26 T2 ─────────────────── */}
      {/* One session-reachable door: `AgentBinding/set` (lib/agents/api.ts),
          gated on `send` — the capability wall's scope, which a supervisory
          grant never carries. Disable is a PAUSE: queued work is HELD, not
          cancelled, and resumes on enable (the provision verb's own rule). */}
      <section aria-label="Kill switch">
        {!binding.enabled ? (
          <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-400/10 dark:text-red-200">
            The kill switch is thrown: nothing invokes this agent and queued work is held, resuming on enable.
            {!toggle ? (
              <>
                {" "}
                Re-enabling from here is not wired — the operator verb is{" "}
                <code class="font-mono text-xs">bullmoose admin agent enable {binding.bindingId}</code>.
              </>
            ) : null}
          </p>
        ) : null}
        {toggle ? (
          <div class={binding.enabled ? "" : "mt-2"}>
            <Button
              variant={binding.enabled ? "danger" : "primary"}
              disabled={toggle.busy}
              onClick={() => toggle.onToggle(!binding.enabled)}
            >
              {toggle.busy ? "Saving…" : binding.enabled ? "Disable agent" : "Enable agent"}
            </Button>
            {binding.enabled ? (
              <p class="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                Disabling stops new work at enqueue; anything already queued is held, not cancelled.
              </p>
            ) : null}
            {toggle.error ? (
              <p class="mt-1.5 text-sm text-red-700 dark:text-red-300" role="alert">
                {toggle.error}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

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

      {/* ── whose key pays, and whose guardrails apply (s26 T4) ──────── */}
      {/* Sits directly under the model menu because it answers the question
          that menu raises: these calls go somewhere and something authorizes
          them. The status is never decorative — a refusing binding makes NO
          model calls at all, and the copy says so rather than letting a reader
          assume a quiet fallback happened. */}
      {credential && credential.view.byokCapable ? (
        <section aria-label="Provider credential">
          <SectionHeading>Provider key</SectionHeading>
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone={BYOK_TONE[credential.view.copy.tone]}>{credential.view.copy.label}</Badge>
            {credential.view.ref ? (
              <span class="font-mono text-xs text-gray-700 dark:text-gray-300">{credential.view.ref.credRef}</span>
            ) : null}
            {credential.view.host ? (
              <span class="text-xs text-gray-500 dark:text-gray-400">spendable only at {credential.view.host}</span>
            ) : null}
          </div>
          <p
            class={
              "mt-1 text-sm " +
              (credential.view.copy.tone === "error"
                ? "font-medium text-red-700 dark:text-red-300"
                : "text-gray-700 dark:text-gray-300")
            }
          >
            {credential.view.copy.detail}
          </p>
          {credential.view.sealedLabel ? (
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {credential.view.sealedLabel}
              {credential.view.rotatedLabel ? ` · ${credential.view.rotatedLabel}` : ""} · the key itself is never shown
            </p>
          ) : null}
          {credential.view.canDetach ? (
            <div class="mt-2">
              <Button variant="secondary" disabled={credential.busy} onClick={() => credential.onDetach()}>
                {credential.busy ? "Saving…" : "Use the platform key instead"}
              </Button>
              {/* Detach is not delete, and the button must not imply it is. */}
              <p class="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                Detaches your key from THIS agent only. Your key stays sealed and stays available to your other agents;
                to stop it being used anywhere, revoke it in Settings → Agents.
              </p>
            </div>
          ) : null}
          {credential.error ? (
            <p class="mt-1.5 text-sm text-red-700 dark:text-red-300" role="alert">
              {credential.error}
            </p>
          ) : null}
        </section>
      ) : null}

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
