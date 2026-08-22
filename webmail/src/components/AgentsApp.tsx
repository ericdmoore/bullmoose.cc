/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import AgentConsole from "./AgentConsole";
import AgentDossierPanel, { type BindingCredential, type BindingToggle } from "./AgentDossierPanel";
import CollectionBar from "./CollectionBar";
import CollectionColumn, { useCollapsed } from "./CollectionColumn";
import {
  Alert,
  Avatar,
  Badge,
  Column,
  EmptyState,
  ListContainer,
  PageNotice,
  Skeleton,
  SkeletonRegion,
  SurfaceFrame,
} from "./ui";
import { hrefWithParam, urlParam } from "../lib/shell/publish";
import { listRowClasses } from "../lib/ui/classes";
import { isUnmodifiedPrimaryClick, syncDetailUrl } from "../lib/ui/navigation";
import { applyBindingEnabled, setBindingEnabled } from "../lib/agents/api";
import {
  ALL_AGENTS_COLLECTION,
  CONSOLE_COLLECTION,
  agentCollections,
  agentListRows,
  agentRowId,
  buildDossierView,
  filterAgentRows,
  parseAgentRowId,
} from "../lib/agents/dossier";
import { detachFromBinding, readByokStatus } from "../lib/byok/api";
import { bindingByokView, type ByokStatus } from "../lib/byok/status";
import { resolveClient } from "../lib/app/client";
import { resolveConsole, type ConsoleMode } from "../lib/app/console";
import type { AgentConsoleClient, AgentSummary } from "../lib/console/ConsoleClient";
import { consoleGate } from "../lib/console/gate";
import type { AgentDossier } from "../lib/console/types";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Session } from "../lib/jmap/types";

// s26 T1 — the Agents realm (quad pattern, s24): rail → CollectionColumn →
// the agents → the dossier. One row per BINDING (an agent IS a binding), and
// the detail panel is `AgentDossierPanel` over `lib/agents/dossier.ts` — this
// island fetches and selects, and decides nothing else.
//
// Data door: the `/console/*` reads (same-origin, `services/jmap/src/
// console.ts`) — owner-only by that surface's Rule 1, so the realm lists the
// agent accounts this session OWNS. The s03.E access console keeps its entry
// point as the Governance collection ("Access console") rather than being
// orphaned by the realm adoption.

type CollectionId = typeof ALL_AGENTS_COLLECTION | typeof CONSOLE_COLLECTION;

interface Props {
  /** Injected in tests; the island resolves its own otherwise. */
  reads?: AgentConsoleClient;
  client?: JmapClient;
}

export default function AgentsApp({ reads: injectedReads, client: injectedClient }: Props) {
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [client, setClient] = useState<JmapClient | undefined>(injectedClient);
  const [reads, setReads] = useState<AgentConsoleClient | undefined>(injectedReads);
  const [mode, setMode] = useState<ConsoleMode>("demo");
  const [fatal, setFatal] = useState<string | undefined>(undefined);

  const [collection, setCollection] = useState<CollectionId>(ALL_AGENTS_COLLECTION);
  const { collapsed: collectionsCollapsed, toggle: toggleCollections } = useCollapsed("bm.cc.agents");
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [dossiers, setDossiers] = useState<Record<string, AgentDossier>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  // `/agents?ag=<accountId>/<bindingId>` deep-links one dossier — read once at
  // mount, the MPA detail-URL pattern every surface follows. `ag`, not `a`:
  // that one is Activity's, and the two realms are one nav click apart.
  const [selectedId, setSelectedId] = useState<string | undefined>(() => urlParam("ag"));
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());

  // ── the kill switch (s26 T2): optimistic flip + reconcile ────────────────
  // One row busy at a time (the control is on the selected dossier); refusals
  // are kept PER ROW so a wall message survives switching away and back.
  const [toggleBusyRow, setToggleBusyRow] = useState<string | undefined>(undefined);
  const [toggleErrors, setToggleErrors] = useState<Record<string, string>>({});

  // ── BYOK (s26 T4): whose key pays for this agent's model calls ───────────
  // Per ACCOUNT, because that is what the door is scoped to (and what the
  // credential is: sealed against the principal, not the binding). Read
  // best-effort: a server that predates this method, or a session the read
  // refuses, leaves the section absent rather than erroring the whole dossier —
  // the realm's other four sections are not BYOK's to break.
  const [byok, setByok] = useState<Record<string, ByokStatus>>({});
  const [byokBusyRow, setByokBusyRow] = useState<string | undefined>(undefined);
  const [byokErrors, setByokErrors] = useState<Record<string, string>>({});

  // ── bootstrap: session, then the console read client ─────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let jmap = injectedClient;
        if (!jmap) {
          const resolved = resolveClient();
          if (resolved.mode === "unauthenticated") {
            location.assign("/login");
            return;
          }
          jmap = resolved.client;
        }
        const live = await jmap.session();
        if (cancelled) return;
        setSession(live);
        setClient(jmap);
        if (!injectedReads) {
          const resolved = resolveConsole();
          setReads(resolved.reads);
          setMode(resolved.mode);
        } else {
          setMode("live");
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

  // ── the realm's data: the picker, then every reachable dossier ───────────
  useEffect(() => {
    if (!reads || gate.state !== "open") return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const list = await reads.listAgents();
        if (cancelled) return;
        setAgents(list);
        const settled = await Promise.allSettled(list.map((a) => reads.agentDossier(a.accountId)));
        if (cancelled) return;
        const byAccount: Record<string, AgentDossier> = {};
        const failed: Record<string, string> = {};
        settled.forEach((r, i) => {
          const account = list[i]!;
          if (r.status === "fulfilled") byAccount[account.accountId] = r.value;
          else failed[account.principal] = message(r.reason);
        });
        setDossiers(byAccount);
        setFailures(failed);
        setNow(Date.now());
      } catch (err) {
        if (!cancelled) setListError(message(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reads, gate.state]);

  // The BYOK status for every account the realm lists, once the roster is in.
  useEffect(() => {
    if (!client || agents.length === 0) return;
    let cancelled = false;
    void (async () => {
      const settled = await Promise.all(agents.map((a) => readByokStatus(client, a.accountId)));
      if (cancelled) return;
      const byAccount: Record<string, ByokStatus> = {};
      settled.forEach((res, i) => {
        if (res.ok) byAccount[agents[i]!.accountId] = res.value;
      });
      setByok(byAccount);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, agents]);

  // ── the contextual filter (s24 T5): bm:search + the ?q= deep link ────────
  useEffect(() => {
    const q = new URLSearchParams(globalThis.location?.search ?? "").get("q");
    if (q) setQuery(q);
    const onSearch = (ev: Event) => {
      setQuery(String((ev as CustomEvent<{ q?: string }>).detail?.q ?? "").trim());
    };
    globalThis.addEventListener("bm:search", onSearch);
    return () => globalThis.removeEventListener("bm:search", onSearch);
  }, []);

  const rows = useMemo(() => agentListRows(agents, dossiers), [agents, dossiers]);
  const visible = useMemo(() => filterAgentRows(rows, query), [rows, query]);
  const collections = useMemo(() => agentCollections(rows), [rows]);

  // Selection self-repair: the requested row if visible, else the first — so a
  // `?ag=` naming a binding this session cannot reach degrades to the first
  // agent rather than to an empty screen.
  const active = visible.find((r) => r.id === selectedId) ?? visible[0];
  /** The row's detail URL — `/agents?ag=<rowId>`, current query preserved.
   *  The id carries a `/` (accountId/bindingId); URLSearchParams encodes it. */
  const agentHref = (id: string): string => hrefWithParam("/agents", "ag", id);
  const detail = useMemo(() => {
    if (!active) return undefined;
    const parsed = parseAgentRowId(active.id);
    const dossier = parsed && dossiers[parsed.accountId];
    return parsed && dossier ? buildDossierView(dossier, parsed.bindingId, now) : undefined;
  }, [active, dossiers, now]);

  // ── the ONE write this realm makes (s26 T2) ──────────────────────────────
  // Flip locally first (the read model is a projection, and the /set response
  // is the reconcile — AgentBinding has no /changes), then let the server's
  // word stand: its `updated[id].enabled` on success, the prior state plus
  // the refusal sentence on failure. The wall's message is shown verbatim —
  // "requires the send capability" teaches more than a softened paraphrase.
  async function flipBinding(accountId: string, bindingId: string, next: boolean): Promise<void> {
    if (!client) return;
    const rowId = agentRowId(accountId, bindingId);
    setToggleBusyRow(rowId);
    setToggleErrors((prev) => {
      const { [rowId]: _cleared, ...rest } = prev;
      return rest;
    });
    setDossiers((prev) => applyBindingEnabled(prev, accountId, bindingId, next));
    const outcome = await setBindingEnabled(client, accountId, bindingId, next);
    if (outcome.ok) {
      setDossiers((prev) => applyBindingEnabled(prev, accountId, bindingId, outcome.enabled));
    } else {
      setDossiers((prev) => applyBindingEnabled(prev, accountId, bindingId, !next));
      setToggleErrors((prev) => ({ ...prev, [rowId]: outcome.message }));
    }
    setToggleBusyRow(undefined);
  }

  /**
   * The dossier's ONE BYOK write: detach this agent from the tenant's key.
   *
   * No optimistic flip, unlike the kill switch — and the difference is not
   * inconsistency. `enabled` is one boolean whose next value the client already
   * knows; a detach changes the binding's config AND the credential's
   * in-use/unused state AND every other agent's summary, and the honest way to
   * know the result is the server's recomputed status, which the response
   * carries for exactly this reason (there is no /changes for this collection).
   */
  async function detachCredential(accountId: string, bindingId: string, provider: string): Promise<void> {
    if (!client) return;
    const rowId = agentRowId(accountId, bindingId);
    setByokBusyRow(rowId);
    setByokErrors((prev) => {
      const { [rowId]: _cleared, ...rest } = prev;
      return rest;
    });
    const outcome = await detachFromBinding(client, accountId, bindingId, provider);
    if (outcome.ok) {
      setByok((prev) => ({
        ...prev,
        ...(prev[accountId]
          ? {
              [accountId]: {
                ...prev[accountId]!,
                refs: outcome.value.refs,
                credentials: outcome.value.credentials,
                platformKeyBindings: outcome.value.platformKeyBindings,
              },
            }
          : {}),
      }));
    } else {
      setByokErrors((prev) => ({ ...prev, [rowId]: outcome.message }));
    }
    setByokBusyRow(undefined);
  }

  const credential: BindingCredential | undefined = (() => {
    if (!active) return undefined;
    const parsed = parseAgentRowId(active.id);
    if (!parsed) return undefined;
    const status = byok[parsed.accountId];
    if (!status) return undefined;
    const view = bindingByokView(status, parsed.bindingId, now);
    return {
      view,
      busy: byokBusyRow === active.id,
      ...(byokErrors[active.id] !== undefined ? { error: byokErrors[active.id] as string } : {}),
      onDetach: () => {
        if (view.ref) void detachCredential(parsed.accountId, parsed.bindingId, view.ref.provider);
      },
    };
  })();

  const toggle: BindingToggle | undefined =
    client && active
      ? {
          busy: toggleBusyRow === active.id,
          ...(toggleErrors[active.id] !== undefined ? { error: toggleErrors[active.id] as string } : {}),
          onToggle: (next: boolean) => {
            const parsed = parseAgentRowId(active.id);
            if (parsed) void flipBinding(parsed.accountId, parsed.bindingId, next);
          },
        }
      : undefined;

  // ── shells (div, not main — AppTw owns the landmark) ─────────────────────
  if (fatal) {
    return (
      <PageNotice title="Could not reach the server" error>
        <p role="alert">{fatal}</p>
      </PageNotice>
    );
  }
  if (!session) {
    return <PageNotice>Connecting…</PageNotice>;
  }
  if (gate.state !== "open") {
    return (
      <PageNotice title="Agents are not available">
        <p>{gate.reason}</p>
        <p class="mt-2">
          <a href="/mail" class="font-medium text-brand-600 hover:text-brand-500">
            Back to mail
          </a>
        </p>
      </PageNotice>
    );
  }

  const pickCollection = (id: string) =>
    setCollection(id === CONSOLE_COLLECTION ? CONSOLE_COLLECTION : ALL_AGENTS_COLLECTION);
  const collectionBar = collectionsCollapsed ? (
    <CollectionBar
      title="Agents"
      storageKey="bm.cc.agents"
      groups={collections}
      selectedId={collection}
      onSelect={pickCollection}
      onExpand={() => toggleCollections(false)}
    />
  ) : null;

  return (
    <div class="flex h-full min-h-0 w-full flex-col">
      {mode === "demo" ? (
        <Alert tone="info" class="m-4 shrink-0">
          Sample data. This is a demo deployment — no real agents, budgets or invocations.
        </Alert>
      ) : null}
      <SurfaceFrame>
        <CollectionColumn
          title="Agents"
          storageKey="bm.cc.agents"
          collapseMode="bar"
          collapsed={collectionsCollapsed}
          onCollapsedChange={toggleCollections}
          groups={collections}
          selectedId={collection}
          onSelect={pickCollection}
        />

        {collection === CONSOLE_COLLECTION ? (
          /* The s03.E console, whole — its own bootstrap, views and vault
             flows, exactly as it ran when it WAS this page. Collapsed, the
             collection bar sits above it so Access console stays reachable
             without restoring the column. */
          <div class="flex min-h-0 min-w-0 grow flex-col">
            {collectionBar}
            <div class="min-h-0 min-w-0 grow overflow-y-auto">
              <AgentConsole />
            </div>
          </div>
        ) : (
          <>
            {/* COLUMN 3 — the agents. */}
            <Column
              aria-label="Agents"
              class="w-full shrink-0 border-gray-200 max-lg:border-b lg:w-80 lg:border-r dark:border-white/10"
              header={
                collectionBar ?? (
                  <h2 class="px-4 pt-4 pb-1 text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
                    All agents <span class="ml-1 font-normal text-gray-400">{visible.length}</span>
                  </h2>
                )
              }
            >
              <div class="px-2 pb-4">
                {listError ? (
                  <Alert tone="error" class="mx-2 mb-2">
                    {listError}
                  </Alert>
                ) : null}
                {Object.entries(failures).map(([who, why]) => (
                  <Alert key={who} tone="error" class="mx-2 mb-2">
                    {who}: {why}
                  </Alert>
                ))}
                {loading ? (
                  <SkeletonRegion label="your agents" class="px-2 py-1">
                    {Array.from({ length: 4 }, (_, i) => (
                      <Skeleton key={i} variant="row" />
                    ))}
                  </SkeletonRegion>
                ) : null}
                {!loading && rows.length === 0 && !listError ? (
                  <EmptyState title="No agent bindings">
                    No agent bindings on the accounts you own. Provisioning an agent is an operator flow —{" "}
                    <code class="font-mono text-xs">bullmoose admin agent</code>.
                  </EmptyState>
                ) : null}
                {!loading && rows.length > 0 && visible.length === 0 ? (
                  <EmptyState title="Nothing matches">Nothing matches “{query}”.</EmptyState>
                ) : null}
                {/* The rows are REAL links to `/agents?ag=<rowId>`, and the
                    plain click still selects in place. An agent is a principal
                    you talk about — "look at what allen is doing" is a
                    sentence that wants a URL in it, and cmd-clicking two
                    dossiers apart is how you compare their budgets.

                    Hand-rolled rather than `<ListRow href … onSelect …>`:
                    `ListRow` still treats those as ALTERNATIVES (href → a link
                    with no handler, onSelect → a button with no URL), the
                    split `StackedRow` has already been brought out of. Same
                    `listRowClasses`, so it is the same row. */}
                <ListContainer>
                  {visible.map((r) => (
                    <li key={r.id}>
                      <a
                        href={agentHref(r.id)}
                        class={listRowClasses({ active: r.id === active?.id })}
                        aria-current={r.id === active?.id ? "true" : undefined}
                        onClick={(ev) => {
                          // Modified clicks belong to the browser — navigation.ts.
                          if (!isUnmodifiedPrimaryClick(ev)) return;
                          ev.preventDefault();
                          setSelectedId(r.id);
                          syncDetailUrl(agentHref(r.id));
                        }}
                      >
                        <Avatar name={r.name} size="sm" />
                        <span class="flex min-w-0 grow flex-col">
                          <span class="flex items-center gap-x-1.5">
                            <span class="truncate font-medium">{r.name}</span>
                            {!r.enabled ? <Badge tone="error">off</Badge> : null}
                          </span>
                          <span class="truncate text-xs text-gray-500 dark:text-gray-400">
                            {r.address} · {r.pipeline}
                          </span>
                        </span>
                        {r.pendingCount > 0 ? <Badge tone="warn">{r.pendingCount}</Badge> : null}
                      </a>
                    </li>
                  ))}
                </ListContainer>
              </div>
            </Column>

            {/* COLUMN 4 — the dossier. */}
            <Column aria-label="Agent dossier" class="min-w-0 grow">
              <div class="px-6 pt-4">
                {detail ? (
                  <AgentDossierPanel view={detail} toggle={toggle} credential={credential} />
                ) : !loading ? (
                  <EmptyState title="Select an agent">Read its dossier here.</EmptyState>
                ) : null}
              </div>
            </Column>
          </>
        )}
      </SurfaceFrame>
    </div>
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
