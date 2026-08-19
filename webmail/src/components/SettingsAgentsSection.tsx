/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import { applyBindingEnabled, setBindingEnabled } from "../lib/agents/api";
import { agentListRows, agentRowId, type AgentListRow } from "../lib/agents/dossier";
import { readByokStatus, revokeKey, sealKey, type ByokOutcome } from "../lib/byok/api";
import {
  BYOK_EXPLAINER,
  BYOK_WRITE_ONLY_NOTE,
  tenantByokView,
  type ByokStatus,
  type TenantByokView,
} from "../lib/byok/status";
import { resolveClient } from "../lib/app/client";
import { resolveConsole } from "../lib/app/console";
import type { AgentConsoleClient, AgentSummary } from "../lib/console/ConsoleClient";
import { consoleGate } from "../lib/console/gate";
import type { AgentDossier } from "../lib/console/types";
import type { JmapClient } from "../lib/jmap/JmapClient";
import {
  DISCRIMINATOR_NO,
  DISCRIMINATOR_QUESTION,
  DISCRIMINATOR_YES,
  orderRoster,
  provisionDefaults,
  rosterSummary,
} from "../lib/settings/agentsPolicy";

// s26 T2 — Settings → Agents: the POLICY domain of the dossier/Settings split.
//
// What renders here passes the discriminator (agentsPolicy.ts): defaults for
// NEW agents (read-only in v1 — provision-time literals with no session write
// door, labeled as exactly that) and the roster of bindings with the ONE verb
// Settings shares with the dossier: the kill switch, through the same
// `AgentBinding/set` door (lib/agents/api.ts) with the same optimistic flip.
// Everything per-agent beyond enabled/disabled is deliberately a LINK to the
// Agents realm, not a second form — the split teaches itself, and the
// discriminator is printed on the page so it keeps teaching.
//
// Same thin-component bargain as SettingsPanel: every derivation lives in
// `lib/settings/agentsPolicy.ts` / `lib/agents/*` with unit tests; the island
// below only fetches and holds state, and `AgentsPolicyView` is stateless
// markup, render-tested via preact-render-to-string.

export interface AgentsPolicyViewProps {
  /** Present when the section cannot serve — the no-capability floor. */
  gateReason?: string;
  loading?: boolean;
  loadError?: string;
  roster: AgentListRow[];
  /** Row id (accountId/bindingId) currently writing, if any. */
  busyRow?: string;
  /** Row id → the server's refusal sentence, verbatim. */
  errors: Record<string, string>;
  onToggle: (row: AgentListRow, next: boolean) => void;
  /** s26 T4 — the tenant's provider keys, per account. Absent when the read
   *  did not land (an older server, or a session it refused). */
  byok?: ByokPanelProps;
}

/**
 * s26 T4 — the tenant's provider keys.
 *
 * WHY HERE and not on an agent's page: the discriminator. *"If this agent were
 * deleted, would the value still mean anything?"* The key would — it is sealed
 * against the PRINCIPAL, not the binding, it survives every agent on the
 * account, and it is spendable the instant a new agent names it. So adding,
 * rotating and revoking it are Settings verbs, exactly as s26's own table says
 * ("BYOK provider credentials (per tenant, via the Bureau)"). The counterpart
 * — WHICH agent spends it — dies with that agent and lives on the dossier.
 */
export interface ByokPanelProps {
  view: TenantByokView;
  /** The account the key is being sealed for — an address, so a household with
   *  several accounts can see which one it is about to change. */
  accountLabel: string;
  busy: boolean;
  /** The server's refusal sentence, verbatim. */
  error?: string;
  /** "Sealed. …" — the confirmation, which never contains the key. */
  notice?: string;
  /** The paste field's live value. Held by the island, cleared on success. */
  draft: string;
  onDraft: (next: string) => void;
  provider: string;
  onProvider: (next: string) => void;
  onSeal: () => void;
  onRevoke: (credRef: string) => void;
}

/** The tenant-key panel, stateless. */
export function ByokPanel({
  view,
  accountLabel,
  busy,
  error,
  notice,
  draft,
  onDraft,
  provider,
  onProvider,
  onSeal,
  onRevoke,
}: ByokPanelProps) {
  const rotating = view.keys.some((k) => k.provider === provider || k.credRef === provider);
  return (
    <>
      <h3 class="settings-label">Provider keys (bring your own)</h3>

      {/* The honest empty state, always rendered — it is the explanation of
          what the feature IS, not a placeholder for having none. */}
      {BYOK_EXPLAINER.map((line) => (
        <p key={line} class="settings-help">
          {line}
        </p>
      ))}

      {/* The account-wide truth, ABOVE the list: a refusal outranks a count,
          because "1 key configured" printed over three silently-refusing
          agents is the reassuring-and-wrong sentence this surface exists to
          never print. */}
      <p
        class={view.refusing.length > 0 ? "settings-problems" : "settings-help"}
        role={view.refusing.length > 0 ? "alert" : undefined}
      >
        {view.summary}
      </p>

      {view.keys.length > 0 ? (
        <ul class="settings-roster">
          {view.keys.map((k) => (
            <li key={k.credRef} class="settings-roster-row">
              <span class="settings-roster-meta">
                <span class="settings-roster-name">
                  {k.credRef}
                  <span class="settings-policy-tag">{k.state.label}</span>
                </span>
                <span class="settings-help">
                  {k.host ? `spendable only at ${k.host}` : "no destination — refused at use time"} · {k.sealedLabel}
                  {k.rotatedLabel ? ` · ${k.rotatedLabel}` : ""}
                </span>
                <span class="settings-help">{k.state.detail}</span>
                {k.usedBy.length > 0 ? (
                  <span class="settings-help">
                    used by{" "}
                    {k.usedBy.map((u, i) => (
                      <span key={u.bindingId}>
                        {i > 0 ? ", " : ""}
                        {u.bindingName}
                        {u.status !== "live" ? " (refusing)" : ""}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
              {view.mayWrite ? (
                <button type="button" class="settings-btn-quiet" disabled={busy} onClick={() => onRevoke(k.credRef)}>
                  {busy ? "Saving…" : "Revoke"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {/* Every agent that COULD carry a key and does not — the other half of
          the empty state, and the thing that makes "add a key" concrete. */}
      {view.onPlatformKey.length > 0 ? (
        <p class="settings-help">
          On the platform key: {view.onPlatformKey.map((b) => b.name).join(", ")}. Adding your key below attaches it to
          all of them; detach any one from its own page.
        </p>
      ) : null}

      {/* The refusal states, listed by agent — the same sentence the dossier
          shows, repeated here on purpose: whoever just sealed a key is looking
          at THIS page, and a status that only appeared elsewhere would put the
          silence back. */}
      {view.refusing.length > 0 ? (
        <ul class="settings-roster">
          {view.refusing.map((r) => (
            <li key={r.bindingId} class="settings-roster-row">
              <span class="settings-roster-meta">
                <span class="settings-roster-name">
                  {r.bindingName}
                  <span class="settings-roster-off"> · refusing every model call</span>
                </span>
                <span class="settings-help">
                  names <span class="settings-policy-tag">{r.credRef}</span> for {r.provider}, which does not resolve —
                  and it does NOT fall back to the platform key.
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {view.mayWrite ? (
        <>
          <label class="settings-label" for="byok-provider">
            {rotating ? "Replace your key" : "Add your key"} for {accountLabel}
          </label>
          <div class="settings-row">
            <div>
              <select
                id="byok-provider"
                class="settings-input"
                value={provider}
                onChange={(e) => onProvider((e.currentTarget as HTMLSelectElement).value)}
              >
                {view.sealableProviders.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div>
              {/* type=password so a shoulder, a screenshot or a screen share
                  does not carry it; autocomplete off so no password manager
                  offers to store a key it will then sync somewhere. The field
                  has no `name`, so a stray form submit could not serialize it
                  into a URL (LoginForm.tsx's guard 4, same reason). */}
              <input
                class="settings-input"
                type="password"
                autocomplete="off"
                spellcheck={false}
                placeholder="paste your provider key"
                aria-label="Provider key"
                value={draft}
                onInput={(e) => onDraft((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
          </div>
          <p class="settings-help">{BYOK_WRITE_ONLY_NOTE}</p>
          <div class="settings-actions">
            <button type="button" class="settings-submit" disabled={busy || draft.trim().length === 0} onClick={onSeal}>
              {busy ? "Sealing…" : rotating ? "Replace key" : "Seal key"}
            </button>
          </div>
        </>
      ) : (
        // The write gate, said plainly. NOT hidden: a person who cannot add a
        // key still needs to know why, and "hosted sign-in cannot grant it" is
        // a fact about the product, not an error to swallow.
        <p class="settings-muted">{view.writeRefusal ?? "This session cannot change provider keys."}</p>
      )}

      {error ? (
        <p class="settings-problems" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p class="settings-ok">{notice}</p> : null}
    </>
  );
}

/** The stateless markup — everything the section says, given the data. */
export function AgentsPolicyView({
  gateReason,
  loading,
  loadError,
  roster,
  busyRow,
  errors,
  onToggle,
  byok,
}: AgentsPolicyViewProps) {
  const defaults = provisionDefaults();
  const rows = orderRoster(roster);
  return (
    <section class="settings-section" aria-labelledby="s-agents">
      <h2 id="s-agents" class="settings-h">
        Agents
      </h2>

      {/* The discriminator, rendered as help text: the page explains its own
          boundary so "why is the model menu not here?" answers itself. */}
      <p class="settings-help">
        What lives here follows one rule — <em>{DISCRIMINATOR_QUESTION}</em> {DISCRIMINATOR_YES} {DISCRIMINATOR_NO}
      </p>

      {gateReason ? (
        <p class="settings-muted">{gateReason}</p>
      ) : (
        <>
          <h3 class="settings-label">Defaults for new agents</h3>
          {defaults.map((d) => (
            <div key={d.label} class="settings-policy-default">
              <p class="settings-policy-value">
                {d.label}: <strong>{d.value}</strong> <span class="settings-policy-tag">set at provision time</span>
              </p>
              <p class="settings-help">{d.note}</p>
            </div>
          ))}

          {byok ? <ByokPanel {...byok} /> : null}

          <h3 class="settings-label">Your agents</h3>
          {loadError ? (
            <p class="settings-problems" role="alert">
              {loadError}
            </p>
          ) : null}
          {loading ? (
            <p class="settings-muted">Loading agents…</p>
          ) : (
            <>
              <p class="settings-help">{rosterSummary(rows)}</p>
              {rows.length > 0 ? (
                <ul class="settings-roster">
                  {rows.map((r) => (
                    <li key={r.id} class="settings-roster-row">
                      <span class="settings-roster-meta">
                        <span class="settings-roster-name">
                          {r.name}
                          {!r.enabled ? <span class="settings-roster-off"> · disabled</span> : null}
                        </span>
                        <span class="settings-help">
                          {r.address} · {r.pipeline}
                        </span>
                        {errors[r.id] ? (
                          <span class="settings-roster-error" role="alert">
                            {errors[r.id]}
                          </span>
                        ) : null}
                      </span>
                      <button
                        type="button"
                        class={r.enabled ? "settings-btn-quiet" : "settings-submit"}
                        disabled={busyRow === r.id}
                        onClick={() => onToggle(r, !r.enabled)}
                      >
                        {busyRow === r.id ? "Saving…" : r.enabled ? "Disable" : "Enable"}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p class="settings-help">
                Everything else about an agent — its model menu, budget, spend, work ledger — is a verb on its own page:{" "}
                <a href="/agents">open the Agents realm</a>. Disabling holds queued work; nothing is cancelled.
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}

interface Props {
  /** Injected in tests; the island resolves its own otherwise. */
  client?: JmapClient;
  reads?: AgentConsoleClient;
}

/** The island: session gate → console roster → the one write. */
export default function SettingsAgentsSection({ client: injectedClient, reads: injectedReads }: Props) {
  const [client, setClient] = useState<JmapClient | undefined>(injectedClient);
  const [gateReason, setGateReason] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [summaries, setSummaries] = useState<AgentSummary[]>([]);
  const [dossiers, setDossiers] = useState<Record<string, AgentDossier>>({});
  const [busyRow, setBusyRow] = useState<string | undefined>(undefined);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // ── BYOK (s26 T4): the tenant's own provider key ─────────────────────────
  //
  // ⚠️ `draft` is the ONLY place the plaintext key lives in this app, it lives
  // there for one request, and it is cleared the moment the seal succeeds. It
  // is never put in a URL, a log, an error, or any other piece of state. The
  // field it is bound to is `type=password`, `autocomplete="off"` and has no
  // `name`. Rotation clears it too — a stale key sitting in a component after
  // a successful seal is a plaintext credential kept for no reason at all.
  const [byokStatuses, setByokStatuses] = useState<Record<string, ByokStatus>>({});
  const [byokAccount, setByokAccount] = useState<string | undefined>(undefined);
  const [byokBusy, setByokBusy] = useState(false);
  const [byokError, setByokError] = useState<string | undefined>(undefined);
  const [byokNotice, setByokNotice] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [provider, setProvider] = useState("openrouter");

  // ── bootstrap: session gate, then the console roster ─────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let jmap = injectedClient;
        if (!jmap) {
          const resolved = resolveClient();
          // No redirect from a SECTION: SettingsPanel above already owns the
          // door on this page. Render the gate text rather than bounce twice.
          if (resolved.mode === "unauthenticated") {
            setGateReason("Sign in to see your agents.");
            setLoading(false);
            return;
          }
          jmap = resolved.client;
        }
        const session = await jmap.session();
        if (cancelled) return;
        setClient(jmap);
        const gate = consoleGate(session);
        if (gate.state !== "open") {
          setGateReason(gate.reason);
          setLoading(false);
          return;
        }
        const reads = injectedReads ?? resolveConsole().reads;
        const list = await reads.listAgents();
        const settled = await Promise.allSettled(list.map((a) => reads.agentDossier(a.accountId)));
        if (cancelled) return;
        const byAccount: Record<string, AgentDossier> = {};
        settled.forEach((res, i) => {
          if (res.status === "fulfilled") byAccount[list[i]!.accountId] = res.value;
        });
        setSummaries(list);
        setDossiers(byAccount);
        const failed = settled.filter((res) => res.status === "rejected").length;
        if (failed > 0) setLoadError(`${failed} agent ${failed === 1 ? "account" : "accounts"} could not be read.`);

        // BYOK status, best-effort and non-fatal: an older server or a session
        // the read refuses leaves the panel absent rather than breaking the
        // rest of the section, which is not BYOK's to break.
        const byokRes = await Promise.all(list.map((a) => readByokStatus(jmap, a.accountId)));
        if (cancelled) return;
        const statuses: Record<string, ByokStatus> = {};
        byokRes.forEach((res, i) => {
          if (res.ok) statuses[list[i]!.accountId] = res.value;
        });
        setByokStatuses(statuses);
        // ONE account's keys at a time, and it is the first the roster names —
        // the household case (several accounts) gets an explicit label rather
        // than a merged list that would make "which key did I just replace?"
        // unanswerable.
        setByokAccount(list[0]?.accountId);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [injectedClient, injectedReads]);

  // ONE source for the rows: the same flatten the Agents realm uses, over the
  // same dossier records the optimistic flip rewrites — no second bookkeeping.
  const roster = useMemo(() => agentListRows(summaries, dossiers), [summaries, dossiers]);

  // The SAME door and idiom as the dossier control (AgentsApp.flipBinding):
  // optimistic flip, the server's word on success, revert + verbatim refusal
  // on failure.
  async function flip(row: AgentListRow, next: boolean): Promise<void> {
    if (!client) return;
    const rowId = agentRowId(row.accountId, row.bindingId);
    setBusyRow(rowId);
    setErrors((prev) => {
      const { [rowId]: _cleared, ...rest } = prev;
      return rest;
    });
    setDossiers((prev) => applyBindingEnabled(prev, row.accountId, row.bindingId, next));
    const outcome = await setBindingEnabled(client, row.accountId, row.bindingId, next);
    if (outcome.ok) {
      setDossiers((prev) => applyBindingEnabled(prev, row.accountId, row.bindingId, outcome.enabled));
    } else {
      setDossiers((prev) => applyBindingEnabled(prev, row.accountId, row.bindingId, !next));
      setErrors((prev) => ({ ...prev, [rowId]: outcome.message }));
    }
    setBusyRow(undefined);
  }

  // ── the two custody verbs (s26 T4) ───────────────────────────────────────
  //
  // Both re-read the status from the server's own response rather than
  // reasoning locally about what changed: sealing rewrites a credential, a
  // grant and every routing binding at once, and revoking touches the same
  // three, so "what is true now" is the server's answer and not a diff the
  // client can compute correctly.
  async function applyMutation<T>(
    run: () => Promise<ByokOutcome<T>>,
    describe: (value: T) => string,
    afterOk?: () => void,
  ): Promise<void> {
    if (!client || !byokAccount) return;
    setByokBusy(true);
    setByokError(undefined);
    setByokNotice(undefined);
    const outcome = await run();
    if (!outcome.ok) {
      setByokError(outcome.message);
      setByokBusy(false);
      return;
    }
    afterOk?.();
    setByokNotice(describe(outcome.value));
    const refreshed = await readByokStatus(client, byokAccount);
    if (refreshed.ok) setByokStatuses((prev) => ({ ...prev, [byokAccount]: refreshed.value }));
    setByokBusy(false);
  }

  async function seal(): Promise<void> {
    if (!client || !byokAccount) return;
    const account = byokAccount;
    await applyMutation(
      () => sealKey(client, account, { provider }, draft),
      (v) =>
        `${v.rotated ? "Replaced" : "Sealed"} “${v.credRef}”, spendable only at ${v.allow}. ` +
        (v.bindings.length > 0
          ? `${v.bindings.map((b) => b.name).join(", ")} now authenticate as you.`
          : (v.note ?? "")) +
        " The key itself is not readable from anywhere, including here.",
      // Cleared on success and ONLY on success: a refused seal keeps the field
      // so a typo in the provider does not cost the paste, and a successful one
      // must not leave a live plaintext credential sitting in component state
      // for no reason at all. Nothing here reads `draft` to build the notice —
      // that sentence is assembled from the server's handle, destination and
      // binding names.
      () => setDraft(""),
    );
  }

  async function revoke(credRef: string): Promise<void> {
    if (!client || !byokAccount) return;
    const account = byokAccount;
    await applyMutation(
      () => revokeKey(client, account, credRef),
      (v) =>
        `Revoked “${credRef}”. ${
          v.detached.length > 0
            ? `${v.detached.map((d) => d.name).join(", ")} now use the platform key.`
            : "No agent was using it."
        } The sealed value was not deleted, so re-adding the key restores the same permission — this is a stop, not an erase.`,
    );
  }

  const byokStatus = byokAccount ? byokStatuses[byokAccount] : undefined;
  const byok = byokStatus
    ? {
        view: tenantByokView(byokStatus),
        accountLabel: summaries.find((s) => s.accountId === byokAccount)?.principal ?? "this account",
        busy: byokBusy,
        ...(byokError !== undefined ? { error: byokError } : {}),
        ...(byokNotice !== undefined ? { notice: byokNotice } : {}),
        draft,
        onDraft: setDraft,
        provider,
        onProvider: setProvider,
        onSeal: () => void seal(),
        onRevoke: (credRef: string) => void revoke(credRef),
      }
    : undefined;

  return (
    <AgentsPolicyView
      {...(gateReason !== undefined ? { gateReason } : {})}
      loading={loading}
      {...(loadError !== undefined ? { loadError } : {})}
      roster={roster}
      {...(busyRow !== undefined ? { busyRow } : {})}
      errors={errors}
      onToggle={(row, next) => void flip(row, next)}
      {...(byok ? { byok } : {})}
    />
  );
}
