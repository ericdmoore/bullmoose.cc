/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import AgentConsole from "./AgentConsole";
import AgentDossierPanel from "./AgentDossierPanel";
import CollectionColumn from "./CollectionColumn";
import { Avatar, Badge, Column, ListContainer, ListRow, SurfaceFrame } from "./ui";
import {
  ALL_AGENTS_COLLECTION,
  CONSOLE_COLLECTION,
  agentCollections,
  agentListRows,
  buildDossierView,
  filterAgentRows,
  parseAgentRowId,
} from "../lib/agents/dossier";
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
  const [reads, setReads] = useState<AgentConsoleClient | undefined>(injectedReads);
  const [mode, setMode] = useState<ConsoleMode>("demo");
  const [fatal, setFatal] = useState<string | undefined>(undefined);

  const [collection, setCollection] = useState<CollectionId>(ALL_AGENTS_COLLECTION);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [dossiers, setDossiers] = useState<Record<string, AgentDossier>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());

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

  // Selection self-repair: the requested row if visible, else the first.
  const active = visible.find((r) => r.id === selectedId) ?? visible[0];
  const detail = useMemo(() => {
    if (!active) return undefined;
    const parsed = parseAgentRowId(active.id);
    const dossier = parsed && dossiers[parsed.accountId];
    return parsed && dossier ? buildDossierView(dossier, parsed.bindingId, now) : undefined;
  }, [active, dossiers, now]);

  // ── shells (div, not main — AppTw owns the landmark) ─────────────────────
  if (fatal) {
    return (
      <div class="shell shell-error">
        <h1>Agents</h1>
        <p role="alert">Could not reach the server: {fatal}</p>
      </div>
    );
  }
  if (!session) {
    return (
      <div class="shell">
        <p class="muted">Connecting…</p>
      </div>
    );
  }
  // The plain-client floor (arch.md §8.6): capability absent → an explanation.
  if (gate.state !== "open") {
    return (
      <div class="shell">
        <h1>Agents</h1>
        <p class="muted">{gate.reason}</p>
        <p class="muted">
          <a href="/mail">← back to mail</a>
        </p>
      </div>
    );
  }

  return (
    <div class="flex h-full min-h-0 w-full flex-col">
      {mode === "demo" ? (
        <p class="banner">Sample data. This is a demo deployment — no real agents, budgets or invocations.</p>
      ) : null}
      <SurfaceFrame>
        <CollectionColumn
          title="Agents"
          storageKey="bm.cc.agents"
          groups={collections}
          selectedId={collection}
          onSelect={(id) => setCollection(id === CONSOLE_COLLECTION ? CONSOLE_COLLECTION : ALL_AGENTS_COLLECTION)}
        />

        {collection === CONSOLE_COLLECTION ? (
          /* The s03.E console, whole — its own bootstrap, views and vault
             flows, exactly as it ran when it WAS this page. */
          <div class="min-h-0 min-w-0 grow overflow-y-auto">
            <AgentConsole />
          </div>
        ) : (
          <>
            {/* COLUMN 3 — the agents. */}
            <Column
              aria-label="Agents"
              class="w-80 shrink-0 border-r border-gray-200 dark:border-white/10"
              header={
                <h2 class="px-4 pt-4 pb-1 text-xs font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
                  All agents <span class="ml-1 font-normal text-gray-400">{visible.length}</span>
                </h2>
              }
            >
              <div class="px-2 pb-4">
                {listError ? (
                  <p class="px-2 py-1 text-sm text-red-700 dark:text-red-300" role="alert">
                    {listError}
                  </p>
                ) : null}
                {Object.entries(failures).map(([who, why]) => (
                  <p key={who} class="px-2 py-1 text-xs text-red-700 dark:text-red-300" role="alert">
                    {who}: {why}
                  </p>
                ))}
                {loading ? <p class="px-2 py-1 text-sm text-gray-500">Loading agents…</p> : null}
                {!loading && rows.length === 0 && !listError ? (
                  <p class="px-2 py-1 text-sm text-gray-500 dark:text-gray-400">
                    No agent bindings on the accounts you own. Provisioning an agent is an operator flow —{" "}
                    <code class="font-mono text-xs">bullmoose admin agent</code>.
                  </p>
                ) : null}
                {!loading && rows.length > 0 && visible.length === 0 ? (
                  <p class="px-2 py-1 text-sm text-gray-500 dark:text-gray-400">Nothing matches “{query}”.</p>
                ) : null}
                <ListContainer>
                  {visible.map((r) => (
                    <ListRow key={r.id} active={r.id === active?.id} onSelect={() => setSelectedId(r.id)}>
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
                    </ListRow>
                  ))}
                </ListContainer>
              </div>
            </Column>

            {/* COLUMN 4 — the dossier. */}
            <Column aria-label="Agent dossier" class="min-w-0 grow">
              <div class="px-6 pt-4">
                {detail ? (
                  <AgentDossierPanel view={detail} />
                ) : !loading ? (
                  <p class="text-sm text-gray-500 dark:text-gray-400">Select an agent to read its dossier.</p>
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
