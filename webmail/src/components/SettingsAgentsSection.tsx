/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import { applyBindingEnabled, setBindingEnabled } from "../lib/agents/api";
import { agentListRows, agentRowId, type AgentListRow } from "../lib/agents/dossier";
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

  return (
    <AgentsPolicyView
      {...(gateReason !== undefined ? { gateReason } : {})}
      loading={loading}
      {...(loadError !== undefined ? { loadError } : {})}
      roster={roster}
      {...(busyRow !== undefined ? { busyRow } : {})}
      errors={errors}
      onToggle={(row, next) => void flip(row, next)}
    />
  );
}
