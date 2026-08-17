/** @jsxImportSource preact */
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { resolveConsole, type ConsoleMode } from "../lib/app/console";
import type { AgentConsoleClient, AgentSummary } from "../lib/console/ConsoleClient";
import { ConsoleUnavailable } from "../lib/console/ConsoleClient";
import { ACCESS_LOG_CAVEAT_LABELS } from "../lib/console/caveats";
import { CredentialVault, cliCommandFor, entryPlan, rotateCommandFor, type MintSpec } from "../lib/console/credentials";
import { consoleGate } from "../lib/console/gate";
import type { ConsoleOrigins } from "../lib/console/origins";
import { OriginRefusal } from "../lib/console/origins";
import {
  buildAgentView,
  type AgentView,
  type CanAnswer,
  type CredentialStatus,
  type GrantStatus,
} from "../lib/console/perAgent";
import { buildResourceView, type ResourceView } from "../lib/console/perResource";
import type { ConsoleResource, CredentialKind } from "../lib/console/types";
import { hasAgentCapability } from "../lib/jmap/capabilities";
import type { JmapClient } from "../lib/jmap/JmapClient";
import { resolveClient } from "../lib/app/client";
import type { Session } from "../lib/jmap/types";

// The agent/credential console (s03.E).
//
// Two views, because they are two questions in two directions (readme.md):
//   per-agent    — "Can Allen even do that?"        authorization, before the fact
//   per-resource — "Who could have messed up X?"    forensic, after the fact
//
// This file renders and decides nothing. Every rule lives in `lib/console/*` as
// a pure function with tests, which is the split s03.C settled on: vitest runs
// in plain Node with no jsdom, so a `.tsx` island holding rules would be a rule
// with no test. If you find yourself computing something here, it belongs there.

type Tab = "agent" | "resource";

interface Props {
  /** Injected in tests/stories; the screen resolves its own otherwise. */
  reads?: AgentConsoleClient;
  vault?: CredentialVault;
  client?: JmapClient;
}

export default function AgentConsole({ reads: injectedReads, vault: injectedVault, client: injectedClient }: Props) {
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [reads, setReads] = useState<AgentConsoleClient | undefined>(injectedReads);
  const [vault, setVault] = useState<CredentialVault | undefined>(injectedVault);
  const [origins, setOrigins] = useState<ConsoleOrigins>({ vault: "", site: "" });
  const [mode, setMode] = useState<ConsoleMode>("demo");
  const [modeReason, setModeReason] = useState<string | undefined>(undefined);
  const [fatal, setFatal] = useState<string | undefined>(undefined);

  const [tab, setTab] = useState<Tab>("agent");
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentId, setAgentId] = useState<string>("");
  const [agentView, setAgentView] = useState<AgentView | undefined>(undefined);
  const [agentError, setAgentError] = useState<string | undefined>(undefined);

  const [resources, setResources] = useState<ConsoleResource[]>([]);
  const [resourceKeyId, setResourceKeyId] = useState<string>("");
  const [atInput, setAtInput] = useState<string>("");
  const [resourceView, setResourceView] = useState<ResourceView | undefined>(undefined);
  const [resourceError, setResourceError] = useState<string | undefined>(undefined);

  const [toast, setToast] = useState<string | undefined>(undefined);

  // ── bootstrap ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let jmap = injectedClient;
        if (!jmap) {
          const resolved = resolveClient();
          // Same rule as the mail shell: no session → the door, never a
          // sample deployment a stranger could mistake for this one
          // (lib/app/client.ts).
          if (resolved.mode === "unauthenticated") {
            location.assign("/login");
            return;
          }
          jmap = resolved.client;
        }
        const live = await jmap.session();
        if (cancelled) return;
        setSession(live);
        if (!injectedReads) {
          const resolved = resolveConsole();
          setReads(resolved.reads);
          setVault(resolved.vault);
          setOrigins(resolved.origins);
          setMode(resolved.mode);
          setModeReason(resolved.reason);
        }
      } catch (err) {
        if (!cancelled) setFatal(message(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [injectedClient, injectedReads]);

  const gate = consoleGate(session);

  useEffect(() => {
    if (!reads || gate.state !== "open") return;
    let cancelled = false;
    void reads
      .listAgents()
      .then((list) => {
        if (cancelled) return;
        setAgents(list);
        setAgentId((prev) => prev || (list[0]?.accountId ?? ""));
      })
      .catch((err: unknown) => {
        if (!cancelled) setAgentError(message(err));
      });
    return () => {
      cancelled = true;
    };
  }, [reads, gate.state]);

  useEffect(() => {
    if (!reads || !agentId) return;
    let cancelled = false;
    setAgentError(undefined);
    void reads
      .agentDossier(agentId)
      .then((d) => !cancelled && setAgentView(buildAgentView(d)))
      .catch((err: unknown) => !cancelled && setAgentError(message(err)));
    void reads
      .listResources(agentId)
      .then((rs) => {
        if (cancelled) return;
        setResources(rs);
        setResourceKeyId((prev) => prev || (rs[0] ? key(rs[0]) : ""));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [reads, agentId]);

  const resource = useMemo(() => resources.find((r) => key(r) === resourceKeyId), [resources, resourceKeyId]);

  const loadResource = useCallback(() => {
    if (!reads || !resource) return;
    const at = parseInstant(atInput);
    setResourceError(undefined);
    void reads
      .resourceDossier(resource, { at, since: at - 90 * 86_400_000 })
      .then((d) => setResourceView(buildResourceView(d, { at, since: at - 90 * 86_400_000 })))
      .catch((err: unknown) => setResourceError(message(err)));
  }, [reads, resource, atInput]);

  useEffect(loadResource, [loadResource]);

  // ── credential lifecycle (T2) ───────────────────────────────────────────

  const doRevoke = useCallback(
    async (name: string) => {
      if (!vault) {
        setToast("Credential changes need a live session — this is a sample deployment.");
        return;
      }
      if (!globalThis.confirm?.(`Revoke the credential reference "${name}"?`)) return;
      try {
        const gone = await vault.revoke(name);
        setToast(gone ? `Revoked ${name}.` : `${name} was already gone.`);
        if (reads && agentId) setAgentView(buildAgentView(await reads.agentDossier(agentId)));
      } catch (err) {
        setToast(message(err));
      }
    },
    [vault, reads, agentId],
  );

  const doOAuth = useCallback(
    async (name: string, meta: Record<string, unknown>) => {
      if (!vault) {
        setToast("OAuth needs a live session — this is a sample deployment.");
        return;
      }
      try {
        const start = await vault.beginOAuth({
          name,
          kind: "oauth-refresh",
          authorizeUrl: String(meta.authorize_url ?? ""),
          tokenUrl: String(meta.token_url ?? ""),
          clientId: String(meta.client_id ?? ""),
          scopes: Array.isArray(meta.scopes) ? (meta.scopes as string[]) : [],
        });
        globalThis.location?.assign(start.authorizeUrl);
      } catch (err) {
        setToast(err instanceof OriginRefusal ? `${err.message} (nothing was sent)` : message(err));
      }
    },
    [vault],
  );

  // ── render ──────────────────────────────────────────────────────────────

  if (fatal) {
    return (
      <main class="shell shell-error">
        <h1>Agent console</h1>
        <p>Could not reach the server: {fatal}</p>
      </main>
    );
  }
  if (!session) {
    return (
      <main class="shell">
        <p class="muted">Connecting…</p>
      </main>
    );
  }

  // The plain-client floor (arch.md §8.6): with the capability absent this is
  // an explanation, not an error and not a dead region.
  if (gate.state !== "open") {
    return (
      <main class="shell">
        <h1>Agent console</h1>
        <p class="muted">{gate.reason}</p>
        <p class="muted">
          <a href="/">← back to mail</a>
        </p>
      </main>
    );
  }

  return (
    <div class="console">
      <header class="topbar">
        <span class="brand">bullmoose</span>
        <nav class="console-tabs" aria-label="Console views">
          <button
            type="button"
            class={tab === "agent" ? "tab tab-on" : "tab"}
            aria-pressed={tab === "agent"}
            onClick={() => setTab("agent")}
          >
            Per agent — <em>can this agent do that?</em>
          </button>
          <button
            type="button"
            class={tab === "resource" ? "tab tab-on" : "tab"}
            aria-pressed={tab === "resource"}
            onClick={() => setTab("resource")}
          >
            Per resource — <em>who could have?</em>
          </button>
        </nav>
        <a class="session" href="/mail">
          ← mail
        </a>
      </header>

      {mode === "demo" ? (
        <p class="banner">
          Sample deployment — no real agents or credentials
          {modeReason ? ` (${modeReason})` : ""}. Credential changes are disabled.
        </p>
      ) : null}
      {mode === "live" && !origins.vault ? (
        <p class="banner banner-warn">
          No vault origin is configured, so credential changes are refused rather than routed through this site. Append{" "}
          <code>?vault=https://agent.example</code>, or use the CLI.
        </p>
      ) : null}

      <div class="console-body">
        {tab === "agent" ? (
          <>
            <AgentPicker agents={agents} value={agentId} onChange={setAgentId} />
            {agentError ? <Unavailable detail={agentError} /> : null}
            {agentView ? (
              <PerAgent
                view={agentView}
                canMutate={mode === "live"}
                onRevoke={(n) => void doRevoke(n)}
                onOAuth={(n, m) => void doOAuth(n, m)}
              />
            ) : agentError ? null : (
              <p class="muted">Loading…</p>
            )}
          </>
        ) : (
          <>
            <ResourcePicker
              resources={resources}
              value={resourceKeyId}
              onChange={setResourceKeyId}
              at={atInput}
              onAt={setAtInput}
              onReload={loadResource}
            />
            {resourceError ? <Unavailable detail={resourceError} /> : null}
            {resourceView ? <PerResource view={resourceView} /> : resourceError ? null : <p class="muted">Loading…</p>}
          </>
        )}
      </div>

      {toast ? (
        <div class="toast" role="status" onClick={() => setToast(undefined)}>
          {toast}
        </div>
      ) : null}
    </div>
  );
}

// ── shared bits ─────────────────────────────────────────────────────────────

function Unavailable({ detail }: { detail: string }) {
  return (
    <section class="panel panel-warn">
      <h2>This data is not available</h2>
      <p>{detail}</p>
      <p class="muted">
        The console reads authorization state, and JMAP has no noun for it. Grants, Bureau grants, bindings and the
        delegated-access log answer through sVOL 015's introspection queries, which are reachable today only over the
        worker-to-worker MCP endpoint. This screen requests a browser-reachable projection of those same queries; until
        one is served it says so rather than inventing contents.
      </p>
    </section>
  );
}

const key = (r: ConsoleResource): string => `${r.collection}:${r.collectionId}`;

function parseInstant(input: string): number {
  if (!input) return Date.now();
  const n = Date.parse(input);
  return Number.isFinite(n) ? n : Date.now();
}

function message(err: unknown): string {
  if (err instanceof ConsoleUnavailable) return err.message;
  return String(err instanceof Error ? err.message : err);
}

const iso = (ms: number | null): string =>
  ms === null ? "—" : new Date(ms).toISOString().replace("T", " ").slice(0, 16);

function AgentPicker({
  agents,
  value,
  onChange,
}: {
  agents: AgentSummary[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div class="picker">
      <label>
        Agent{" "}
        <select value={value} onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value)}>
          {agents.map((a) => (
            <option key={a.accountId} value={a.accountId}>
              {a.displayName ?? a.principal} — {a.enabledBindingCount}/{a.bindingCount} bindings enabled
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

// ── T1 ──────────────────────────────────────────────────────────────────────

function PerAgent({
  view,
  canMutate,
  onRevoke,
  onOAuth,
}: {
  view: AgentView;
  canMutate: boolean;
  onRevoke: (name: string) => void;
  onOAuth: (name: string, meta: Record<string, unknown>) => void;
}) {
  return (
    <>
      {view.combinations.length > 0 ? (
        <section class="panel panel-alert">
          <h2>Dangerous combinations</h2>
          <p class="muted">
            Each ingredient below is routine on its own screen. The finding only exists at the join, which is why a
            per-ingredient list misses it.
          </p>
          {view.combinations.map((c) => (
            <article key={c.id} class={`combo combo-${c.severity}`}>
              <h3>
                <span class="sev">{c.severity}</span> {c.title}
              </h3>
              <ul>
                {c.ingredients.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
              <p>{c.consequence}</p>
            </article>
          ))}
        </section>
      ) : null}

      <section class="panel">
        <h2>Can it?</h2>
        <div class="headline">
          {view.headline.map((h) => (
            <Can key={h.permission} answer={h} />
          ))}
        </div>
        <p class="muted">
          Effective permissions, expanded through the same rule the server's gate applies — never the stored scope
          strings. This agent's token stores {chips(view.dossier.tokenScopes)} and thereby allows{" "}
          {chips(view.tokenAllows)}
          {view.tokenHidden.length > 0 ? (
            <> — including {chips(view.tokenHidden)}, which nothing in the stored list names.</>
          ) : null}
        </p>
      </section>

      <section class="panel">
        <h2>Bindings</h2>
        {view.bindings.map((b) => (
          <article key={b.binding.bindingId} class="row">
            <h3>
              {b.binding.name}{" "}
              <span class={b.binding.enabled ? "pill pill-on" : "pill"}>
                {b.binding.enabled ? "enabled" : "disabled"}
              </span>
              <span class="pill">{b.binding.triggerOn}</span>
              {b.binding.config.replyMode ? (
                <span class={b.binding.config.replyMode === "send" ? "pill pill-hot" : "pill"}>
                  replyMode {b.binding.config.replyMode}
                </span>
              ) : null}
              {b.binding.config.senderAllowlist ? (
                <span class="pill">
                  {b.binding.config.senderAllowlist.active
                    ? `allowlist: ${b.binding.config.senderAllowlist.count} senders`
                    : "no sender allowlist"}
                </span>
              ) : null}
            </h3>
            {b.credentialRefs.length > 0 ? (
              <p class="muted">
                MCP credential references:{" "}
                {b.credentialRefs.map((r, i) => (
                  <span key={r}>
                    {i > 0 ? ", " : ""}
                    <code>{r}</code>
                  </span>
                ))}{" "}
                — names only. No value is returned to this page, and no vault route could return one.
              </p>
            ) : null}
            <Warnings items={b.warnings} />
          </article>
        ))}
        <p class="muted">{view.notes[0]}</p>
        <p class="muted">{view.notes[1]}</p>
      </section>

      <section class="panel">
        <h2>Credential references</h2>
        <p class="muted">
          References, never values (bureau.md invariant 1). There is no reveal button and there is nothing to reveal:
          the master key is not bound to the worker this page talks to.
        </p>
        {view.credentials.map((c) => (
          <Credential key={c.credential.name} status={c} canMutate={canMutate} onRevoke={onRevoke} onOAuth={onOAuth} />
        ))}
        <AttachCredential canMutate={canMutate} />
      </section>

      <section class="panel">
        <h2>Grants held</h2>
        {view.grantsHeld.length === 0 ? (
          <p class="muted">None — this agent reaches only its own account.</p>
        ) : (
          view.grantsHeld.map((g) => <Grant key={g.grant.grantId} status={g} />)
        )}
        <p class="muted">{view.notes[2]}</p>
      </section>

      <section class="panel">
        <h2>Recent actions</h2>
        <table class="grid">
          <thead>
            <tr>
              <th>when</th>
              <th>binding</th>
              <th>status</th>
              <th>the runtime's own note</th>
            </tr>
          </thead>
          <tbody>
            {view.recent.map((i) => (
              <tr key={i.invocationId}>
                <td>{iso(i.createdAt)}</td>
                <td>{i.bindingName}</td>
                <td>{i.status}</td>
                <td>{i.note ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {view.spendLine ? <p class="muted">Spend: {view.spendLine}</p> : null}
      </section>
    </>
  );
}

function Can({ answer }: { answer: CanAnswer }) {
  return (
    <article class={answer.can ? "can can-yes" : "can can-no"}>
      <h3>
        {answer.can ? "YES" : "no"} — <code>{answer.permission}</code>
        {answer.impliedOnly ? <span class="pill pill-hot">implied, not named</span> : null}
      </h3>
      <p class="meaning">{answer.meaning}</p>
      <p>{answer.because}</p>
    </article>
  );
}

function Grant({ status }: { status: GrantStatus }) {
  const g = status.grant;
  return (
    <article class="row">
      <h3>
        <code>{g.grantId}</code>
        <span class={`pill pill-${status.state}`}>{status.state}</span>
        <span class="pill">{g.collection === null ? "whole account" : `${g.collection} ${g.collectionId ?? ""}`}</span>
        <span class="pill">{g.expiresAt === null ? "no expiry" : `expires ${iso(g.expiresAt)}`}</span>
        {g.revokedAt !== null ? <span class="pill pill-revoked">revoked {iso(g.revokedAt)}</span> : null}
      </h3>
      <p>
        stored: {chips(g.scopes)} → <strong>allows: {chips(status.allows)}</strong>
      </p>
      {status.hidden.length > 0 ? (
        <p class="muted">
          Conferred without being named: {chips(status.hidden)}. A chip list of the stored scopes would have shown these
          as absent.
        </p>
      ) : null}
      <Warnings items={status.warnings} />
    </article>
  );
}

function Credential({
  status,
  canMutate,
  onRevoke,
  onOAuth,
}: {
  status: CredentialStatus;
  canMutate: boolean;
  onRevoke: (name: string) => void;
  onOAuth: (name: string, meta: Record<string, unknown>) => void;
}) {
  const c = status.credential;
  const [rotating, setRotating] = useState(false);
  return (
    <article class="row">
      <h3>
        <code>{c.name}</code>
        <span class="pill">{c.kind}</span>
        <span class={status.selfEnforcedOnly ? "pill pill-hot" : "pill pill-on"}>enforcement {c.enforcement}</span>
        <span class="pill">{c.allow ?? "no destination — fails closed"}</span>
        {status.verbs.map((v) => (
          <span key={v} class="pill pill-verb">
            may {v}
          </span>
        ))}
      </h3>
      {status.grants.some((g) => g.state !== "live") ? (
        <p class="muted">
          Also recorded:{" "}
          {status.grants
            .filter((g) => g.state !== "live")
            .map((g) => `${g.grant.verb} (${g.state})`)
            .join(", ")}
          . Revoking a Bureau grant leaves the credential and its sibling grants untouched.
        </p>
      ) : null}
      <ul class="notes">
        {status.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <div class="actions">
        {c.kind === "oauth-refresh" ? (
          <button type="button" disabled={!canMutate} onClick={() => onOAuth(c.name, c.meta)}>
            Re-authorize with the provider
          </button>
        ) : (
          <button type="button" onClick={() => setRotating((v) => !v)}>
            {rotating ? "Hide" : "Rotate…"}
          </button>
        )}
        <button type="button" class="danger" disabled={!canMutate} onClick={() => onRevoke(c.name)}>
          Revoke reference
        </button>
      </div>
      {rotating ? (
        <div class="cli-bounce">
          <p>
            Rotating a raw key means typing one, and a browser form is the worst place for a secret to pass through —
            clipboard, autofill, extensions, history. Run this instead; it posts the same value to the same vault
            endpoint from a hidden prompt:
          </p>
          <pre>{rotateCommandFor(c.name)}</pre>
        </div>
      ) : null}
    </article>
  );
}

function AttachCredential({ canMutate }: { canMutate: boolean }) {
  const [kind, setKind] = useState<CredentialKind>("api-key");
  const [name, setName] = useState("");
  const [allow, setAllow] = useState("");
  const spec: MintSpec = { name: name || "<name>", kind, ...(allow ? { allow } : {}) };
  const plan = entryPlan(kind, spec);
  return (
    <details class="attach">
      <summary>Attach a credential reference</summary>
      <div class="attach-body">
        <label>
          name <input value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <label>
          kind{" "}
          <select
            value={kind}
            onChange={(e) => setKind((e.currentTarget as HTMLSelectElement).value as CredentialKind)}
          >
            <option value="api-key">api-key</option>
            <option value="oauth-refresh">oauth-refresh</option>
            <option value="aws-sigv4">aws-sigv4</option>
            <option value="hmac-key">hmac-key</option>
          </select>
        </label>
        <label>
          allow (destination binding — the primary control){" "}
          <input
            value={allow}
            placeholder="https://api.stripe.com or *.amazonaws.com"
            onInput={(e) => setAllow((e.currentTarget as HTMLInputElement).value)}
          />
        </label>

        {/*
          There is no secret field on this form, and adding one would be the bug.
          `entryPlan` decides the route; a raw key bounces to the CLI deliberately.
        */}
        <p>{plan.reason}</p>
        {plan.route === "cli" ? (
          <div class="cli-bounce">
            <pre>{plan.command ?? cliCommandFor(spec)}</pre>
          </div>
        ) : (
          <p class="muted">
            {canMutate
              ? "Choose an existing OAuth credential above and press “Re-authorize”, or create one with the CLI first so its client_id and token_url are recorded."
              : "OAuth initiation needs a live session."}
          </p>
        )}
      </div>
    </details>
  );
}

// ── T3 ──────────────────────────────────────────────────────────────────────

function ResourcePicker({
  resources,
  value,
  onChange,
  at,
  onAt,
  onReload,
}: {
  resources: ConsoleResource[];
  value: string;
  onChange: (k: string) => void;
  at: string;
  onAt: (v: string) => void;
  onReload: () => void;
}) {
  return (
    <div class="picker">
      <label>
        Resource{" "}
        <select value={value} onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value)}>
          {resources.map((r) => (
            <option key={key(r)} value={key(r)}>
              {r.name} ({r.collection})
            </option>
          ))}
        </select>
      </label>
      <label>
        as of{" "}
        <input type="datetime-local" value={at} onInput={(e) => onAt((e.currentTarget as HTMLInputElement).value)} />
      </label>
      <button type="button" onClick={onReload}>
        Reconstruct
      </button>
      <span class="muted">Blank = now. Past instants reconstruct the authorization set as it stood then.</span>
    </div>
  );
}

function PerResource({ view }: { view: ResourceView }) {
  return (
    <>
      <section class="panel panel-alert">
        <h2>The gap</h2>
        <p class="gap">{view.gapSummary}</p>
        <p class="muted">
          "Who could have" and "who did" are two queries against two sources, and the gap between them is the finding —
          not the two tables. A wide <em>could</em> with a narrow <em>did</em> means over-permissioning; a <em>did</em>{" "}
          with no matching <em>could</em> means something is broken.
        </p>
        {view.findings.map((f, i) => (
          <article key={`${f.kind}-${i}`} class={`finding finding-${f.kind}`}>
            <h3>
              <span class="sev">{f.kind.replace("-", " ")}</span> {f.headline}
            </h3>
            <p>{f.detail}</p>
          </article>
        ))}
      </section>

      <div class="side-by-side">
        <section class="panel">
          <h2>Who could — as of {iso(view.at)}</h2>
          <p class="muted">{view.pointInTimeNote}</p>
          {view.could.length === 0 ? (
            <p class="muted">Nobody held a grant covering this resource at that instant.</p>
          ) : (
            view.could.map((c) => (
              <article key={c.grant.grantId} class="row">
                <h3>
                  {c.party?.address ?? c.party?.accountId ?? c.grant.grantId}
                  <span class="pill">{c.reach}</span>
                  {c.stillLive ? (
                    <span class="pill pill-on">still live</span>
                  ) : (
                    <span class="pill pill-revoked">no longer live</span>
                  )}
                </h3>
                <p>
                  stored: {chips(c.grant.scopes)} → <strong>allows: {chips(c.allows)}</strong>
                </p>
                <p class="muted">
                  granted {iso(c.grant.createdAt)}
                  {c.grant.revokedAt !== null ? `, revoked ${iso(c.grant.revokedAt)}` : ""}
                  {c.grant.expiresAt !== null ? `, expires ${iso(c.grant.expiresAt)}` : ", no expiry"}
                </p>
              </article>
            ))
          )}
        </section>

        <section class="panel">
          <h2>Who did</h2>
          {view.emptyMeans ? (
            <p class="empty-means">{view.emptyMeans}</p>
          ) : (
            <table class="grid">
              <thead>
                <tr>
                  <th>when</th>
                  <th>who</th>
                  <th>what</th>
                  <th>source</th>
                </tr>
              </thead>
              <tbody>
                {view.did.map((d, i) => (
                  <tr key={i} class={d.actor === null ? "uncaptured" : undefined}>
                    <td>{iso(d.at)}</td>
                    <td>
                      {d.actor ?? <em class="uncaptured-cell">not captured</em>}
                      {d.binding ? <> · binding {d.binding}</> : null}
                    </td>
                    <td>{d.what}</td>
                    <td>{d.source === "grant-audit" ? "delegated-access log" : "writer stamp"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/*
            Not a footnote. `grant_audit` looks like an access log and is not
            one; a screen that renders it as "what happened" misleads everyone
            who reads it. sVOL 015 returns these with every answer for the same
            reason, and `perResource.ts` puts them on the view model so a
            renderer cannot produce this panel without them.
          */}
          <div class="caveats">
            <h3>What this cannot tell you</h3>
            <ol>
              {view.accessLogCaveats.map((c, i) => (
                <li key={c}>
                  <strong>{ACCESS_LOG_CAVEAT_LABELS[i]}</strong> — {c}
                </li>
              ))}
            </ol>
            <h3>…and the writer column has its own gap</h3>
            <ul>
              {view.provenanceCaveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </>
  );
}

function Warnings({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul class="warnings">
      {items.map((w) => (
        <li key={w}>{w}</li>
      ))}
    </ul>
  );
}

function chips(scopes: readonly string[]) {
  if (scopes.length === 0) return <em>nothing</em>;
  return (
    <>
      {scopes.map((s) => (
        <code key={s} class="chip">
          {s}
        </code>
      ))}
    </>
  );
}

export { hasAgentCapability };
