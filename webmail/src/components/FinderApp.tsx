/** @jsxImportSource preact */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { resolveClient, type ClientMode } from "../lib/app/client";
import { buildFinderCollections, parseCollectionId } from "../lib/finder/collections";
import { deriveDateGroups, windowRefinement } from "../lib/finder/dateGroups";
import { FINDER_SCOPE_NOTE, runFind, type FinderHit, type FinderResult } from "../lib/finder/run";
import {
  chipLabel,
  isBlank,
  newSession,
  refine,
  removeRefinement,
  type FinderRefinement,
  type FinderSession,
} from "../lib/finder/session";
import {
  loadSaved,
  loadSessions,
  persistSaved,
  persistSessions,
  recordRun,
  removeSaved,
  upsertSaved,
  upsertSession,
  type SavedQuery,
} from "../lib/finder/store";
import { groupByThread, type ThreadGroup } from "../lib/finder/threads";
import type { JmapClient } from "../lib/jmap/JmapClient";
import { browsableMailboxes, loadMailboxes } from "../lib/mail/mailboxes";
import type { Mailbox } from "../lib/mail/types";
import CollectionColumn from "./CollectionColumn";
import { Button } from "./ui";

// `/search` is the FINDER (s20 T5) — directed find over your OWN mail
// history, in the standard quad: rail → collection → list → detail. A find is
// a SESSION (initial query + a refinement chain, `lib/finder/session.ts`);
// the chips above the results are that chain, each removable — narrowing and
// backing out are array edits on native structure, never history API calls
// (`lib/app/tokenInUrl.test.ts` scans this file to keep it that way).
//
// This file renders and decides nothing (the split every section keeps):
// what a refinement is, how a session compiles to the server filter, how
// results group by thread and date, and what localStorage holds all live in
// `lib/finder/*` as pure tested functions.
//
// The v1 honesty lines, argued in `lib/finder/run.ts`:
//  • mail only — the loop's facets (sender, thread, receivedAt window) are
//    mail semantics; the cross-realm fan-out modules stay in `lib/search/`
//    for the future MCP `search` tool.
//  • one page of results, no pager — the answer to "too many" is a chip.
//  • a saved query's count is stamped with when it was measured.
//
// FUTURE(s20-t5b): agent-directed refinement plugs in here — the agent
// proposes the next chip (via the MCP tool layer over these same lib/finder
// modules) instead of the human picking one from the RefineBar.

interface Props {
  /** Injected in tests; the screen resolves its own otherwise (invariant §6.1). */
  client?: JmapClient;
}

export default function FinderApp({ client: injected }: Props) {
  const [client, setClient] = useState<JmapClient | undefined>(injected);
  const [accountId, setAccountId] = useState<string>("");
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [mode, setMode] = useState<ClientMode>("live");
  const [modeReason, setModeReason] = useState<string | undefined>(undefined);
  const [fatal, setFatal] = useState<string | undefined>(undefined);
  const [toast, setToast] = useState<string | undefined>(undefined);

  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [sessions, setSessions] = useState<FinderSession[]>([]);
  const [current, setCurrent] = useState<FinderSession | undefined>(undefined);
  /** The saved query the CURRENT session is an unmodified run of. Dropped on
   *  any refinement — running a modified find must not update the saved
   *  query's "last run" stamp, which describes the saved query, not you. */
  const [activeSaved, setActiveSaved] = useState<string | undefined>(undefined);
  const [collectionId, setCollectionId] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<FinderResult | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [selectedHitId, setSelectedHitId] = useState<string | undefined>(undefined);

  // ── bootstrap ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let jmap = injected;
        if (!jmap) {
          const resolved = resolveClient();
          // Same door as every other section: no session → `/login`.
          if (resolved.mode === "unauthenticated") {
            location.assign("/login");
            return;
          }
          // Demo needs no side-module here: the Finder queries mail only, and
          // `createDemoBackend` already registers Email/query + Mailbox/get.
          if (!cancelled) {
            setMode(resolved.mode);
            setModeReason(resolved.mode === "demo" ? resolved.reason : undefined);
          }
          jmap = resolved.client;
        }
        await jmap.session();
        const account = await jmap.primaryAccountId();
        const boxes = await loadMailboxes(jmap, account);
        if (cancelled) return;
        setClient(jmap);
        setAccountId(account);
        setMailboxes(browsableMailboxes(boxes));
        setSaved(loadSaved());
        setSessions(loadSessions());
      } catch (err) {
        if (!cancelled) setFatal(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [injected]);

  // ── the one run path ────────────────────────────────────────────────────
  const runSession = useCallback(
    async (sess: FinderSession, opts?: { fromSaved?: string }) => {
      setCurrent(sess);
      setSelectedHitId(undefined);
      if (!client || !accountId) return;
      if (isBlank(sess)) {
        setResult(undefined);
        return;
      }
      setBusy(true);
      try {
        const found = await runFind(client, accountId, sess);
        const at = new Date().toISOString();
        const ran: FinderSession = { ...sess, lastRunAt: at, resultCount: found.total };
        setCurrent(ran);
        setResult(found);
        setSessions((prev) => {
          const next = upsertSession(prev, ran);
          persistSessions(next);
          return next;
        });
        if (opts?.fromSaved !== undefined) {
          const id = opts.fromSaved;
          setSaved((prev) => {
            const next = recordRun(prev, id, found.total, at);
            persistSaved(next);
            return next;
          });
        }
      } catch (err) {
        setToast(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [client, accountId],
  );

  const startQuery = useCallback(
    (q: string) => {
      const sess = newSession(q);
      setActiveSaved(undefined);
      setCollectionId(`session:${sess.id}`);
      void runSession(sess);
    },
    [runSession],
  );

  // `?q=` makes a find deep-linkable (`/search?q=elk&demo=1`); run it once the
  // session is up. Read-only on purpose: writing the query BACK to the URL
  // would take a `history.replaceState`, and the whole app makes exactly one
  // history call, in `lib/app/client.ts` — `tokenInUrl.test.ts` scans every
  // island to keep it that way.
  const qParsed = useRef(false);
  useEffect(() => {
    if (!client || !accountId) return;
    if (!qParsed.current) {
      qParsed.current = true;
      const q = new URLSearchParams(location.search).get("q") ?? "";
      if (q.trim() !== "") startQuery(q);
    }
    // s24 T5 — the chrome bar submits here as a `bm:search` event (never a
    // navigation). In THIS realm the bar means: start a NEW find session.
    const onSearch = (ev: Event) => {
      const next = String((ev as CustomEvent<{ q?: string }>).detail?.q ?? "").trim();
      if (next) startQuery(next);
    };
    globalThis.addEventListener("bm:search", onSearch);
    return () => globalThis.removeEventListener("bm:search", onSearch);
  }, [client, accountId, startQuery]);

  // ── refinement actions (chips are array edits, never history) ───────────
  const addChip = useCallback(
    (r: FinderRefinement) => {
      if (!current) return;
      setActiveSaved(undefined);
      setCollectionId(`session:${current.id}`);
      void runSession(refine(current, r));
    },
    [current, runSession],
  );

  const removeChip = useCallback(
    (index: number) => {
      if (!current) return;
      setActiveSaved(undefined);
      setCollectionId(`session:${current.id}`);
      void runSession(removeRefinement(current, index));
    },
    [current, runSession],
  );

  // ── collection column ───────────────────────────────────────────────────
  const dateGroups = useMemo(() => deriveDateGroups((result?.hits ?? []).map((h) => h.receivedAt)), [result]);
  const collections = useMemo(
    () =>
      buildFinderCollections({
        saved,
        sessions,
        ...(current ? { currentId: current.id } : {}),
        dateGroups,
      }),
    [saved, sessions, current, dateGroups],
  );

  const onCollection = (id: string) => {
    const target = parseCollectionId(id);
    if (!target) return;
    setCollectionId(id);
    if (target.type === "saved") {
      const entry = saved.find((s) => s.id === target.id);
      if (!entry) return;
      setActiveSaved(entry.id);
      const sess: FinderSession = { ...newSession(entry.query), refinements: [...entry.refinements] };
      void runSession(sess, { fromSaved: entry.id });
    } else if (target.type === "session") {
      const sess = sessions.find((s) => s.id === target.id);
      if (!sess) return;
      setActiveSaved(undefined);
      void runSession(sess);
    } else {
      // A date leaf refines the CURRENT session to that window.
      if (!current) return;
      setActiveSaved(undefined);
      const window = windowRefinement(target.year, target.type === "month" ? target.month : undefined);
      void runSession(refine(current, window));
    }
  };

  const onNew = () => {
    setActiveSaved(undefined);
    setCurrent(undefined);
    setResult(undefined);
    setSelectedHitId(undefined);
    setCollectionId(undefined);
  };

  const onSaveQuery = () => {
    if (!current || isBlank(current)) return;
    const name = prompt("Name this find")?.trim();
    if (!name) return;
    const entry: SavedQuery = {
      id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      query: current.query,
      refinements: [...current.refinements],
      savedAt: new Date().toISOString(),
      ...(current.lastRunAt !== undefined ? { lastRunAt: current.lastRunAt } : {}),
      ...(current.resultCount !== undefined ? { lastCount: current.resultCount } : {}),
    };
    setSaved((prev) => {
      const next = upsertSaved(prev, entry);
      persistSaved(next);
      return next;
    });
    setActiveSaved(entry.id);
    setCollectionId(`saved:${entry.id}`);
  };

  const onForgetSaved = () => {
    if (activeSaved === undefined) return;
    const entry = saved.find((s) => s.id === activeSaved);
    if (entry && !confirm(`Forget the saved query “${entry.name}”? The mail it finds is untouched.`)) return;
    setSaved((prev) => {
      const next = removeSaved(prev, activeSaved);
      persistSaved(next);
      return next;
    });
    setActiveSaved(undefined);
    if (current) setCollectionId(`session:${current.id}`);
  };

  // ── derived render state ────────────────────────────────────────────────
  const threads = useMemo(() => groupByThread(result?.hits ?? []), [result]);
  const selectedHit = useMemo(() => (result?.hits ?? []).find((h) => h.id === selectedHitId), [result, selectedHitId]);

  if (fatal) {
    return (
      <div class="app">
        <div class="panel panel-alert">
          <h2>Finder is unavailable</h2>
          <p>{fatal}</p>
        </div>
      </div>
    );
  }

  if (!client) {
    return (
      <div class="app finder">
        <p class="muted finder-status">Connecting…</p>
      </div>
    );
  }

  return (
    <div class="app finder">
      {/* Coverage, declared before the first keystroke — what the Finder can
          and cannot reach (`lib/finder/run.ts`). */}
      <p id="finder-scope" class="search-scope">
        {FINDER_SCOPE_NOTE}
      </p>

      {mode === "demo" ? (
        <p class="banner">Demo data — nothing here is real{modeReason ? ` (${modeReason})` : ""}.</p>
      ) : null}

      <div class="body">
        <CollectionColumn
          title="Finder"
          storageKey="bm.cc.finder"
          groups={collections}
          {...(collectionId !== undefined ? { selectedId: collectionId } : {})}
          onSelect={onCollection}
          newLabel="New find"
          onNew={onNew}
          defaultExpanded={[`date:${new Date().getUTCFullYear()}`]}
          actions={
            activeSaved !== undefined ? (
              <Button variant="ghost" size="sm" onClick={onForgetSaved}>
                Forget saved query
              </Button>
            ) : undefined
          }
        />

        <section class="content finder-content" aria-label="Find results">
          {current ? (
            <>
              <FinderChips session={current} onRemove={removeChip} />
              <RefineBar mailboxes={mailboxes} onAdd={addChip} canSave={!isBlank(current)} onSave={onSaveQuery} />
            </>
          ) : null}

          {busy ? <p class="muted finder-status">Finding…</p> : null}

          {!busy && current && result ? (
            <p class="scope-line finder-count">
              {result.total} match{result.total === 1 ? "" : "es"}
              {result.total > result.hits.length
                ? ` — showing the newest ${result.hits.length}; add a refinement to narrow the rest into view`
                : ""}
              .
            </p>
          ) : null}

          {!current ? (
            <div class="finder-empty">
              <p class="muted">Start a find — type in the search bar above, or reopen a session from the left.</p>
              <p class="muted finder-hint">
                A find is a conversation with your own mail history: one query, then refinements — sender, mailbox, a
                month, has-attachment — each narrowing the last, each removable.
              </p>
            </div>
          ) : null}

          {current && !busy ? (
            <div class="finder-panes">
              <div class="finder-list" aria-label="Results by thread">
                <ThreadGroups groups={threads} selectedId={selectedHitId} onSelect={setSelectedHitId} />
                {result && result.hits.length === 0 ? (
                  <p class="muted finder-empty-list">Nothing matched this find. Back a chip out, or start a new one.</p>
                ) : null}
              </div>
              <section class="finder-detail" aria-label="Message excerpt">
                {selectedHit ? <HitDetail hit={selectedHit} /> : <p class="muted">Select a message.</p>}
              </section>
            </div>
          ) : null}
        </section>
      </div>

      {toast ? (
        <div class="toast" role="status" onClick={() => setToast(undefined)}>
          {toast}
        </div>
      ) : null}
    </div>
  );
}

// ── leaf components (exported for render tests — plain markup over the pure
//    lib/finder model, no state of consequence) ─────────────────────────────

/** The session line: the query, then the refinement chain as removable chips. */
export function FinderChips({ session, onRemove }: { session: FinderSession; onRemove: (index: number) => void }) {
  return (
    <div class="finder-chips" role="group" aria-label="This find's refinements">
      <span class="finder-query" title="The session's initial query">
        {session.query === "" ? "(no text)" : `“${session.query}”`}
      </span>
      {session.refinements.map((r, i) => (
        <span key={`${r.kind}-${i}`} class="finder-chip">
          {chipLabel(r)}
          <button type="button" class="finder-chip-x" aria-label={`Remove ${chipLabel(r)}`} onClick={() => onRemove(i)}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

/** The refinement controls — the human picks the next chip. This row is the
 *  seam the agent-mediated version replaces (see the FUTURE note atop). */
export function RefineBar({
  mailboxes,
  onAdd,
  canSave,
  onSave,
}: {
  mailboxes: Mailbox[];
  onAdd: (r: FinderRefinement) => void;
  canSave: boolean;
  onSave: () => void;
}) {
  const [value, setValue] = useState("");
  const add = (kind: "from" | "to") => {
    const v = value.trim();
    if (v === "") return;
    onAdd({ kind, value: v });
    setValue("");
  };
  // No <form>: a form with no action still submits to the current URL as GET
  // (tokenInUrl.test.ts refuses the shape), and these are buttons, not a
  // submission.
  return (
    <div class="finder-refine" role="group" aria-label="Add a refinement">
      <span class="muted finder-refine-label">Narrow by</span>
      <input
        type="text"
        class="finder-refine-input"
        placeholder="address or name"
        aria-label="Address or name to narrow by"
        value={value}
        onInput={(ev) => setValue((ev.currentTarget as HTMLInputElement).value)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") add("from");
        }}
      />
      <button type="button" class="finder-refine-btn" disabled={value.trim() === ""} onClick={() => add("from")}>
        From
      </button>
      <button type="button" class="finder-refine-btn" disabled={value.trim() === ""} onClick={() => add("to")}>
        To
      </button>
      <select
        class="finder-refine-select"
        aria-label="Narrow to a mailbox"
        value=""
        onChange={(ev) => {
          const id = (ev.currentTarget as HTMLSelectElement).value;
          const box = mailboxes.find((m) => m.id === id);
          if (box) onAdd({ kind: "mailbox", id: box.id, name: box.name });
          (ev.currentTarget as HTMLSelectElement).value = "";
        }}
      >
        <option value="">mailbox…</option>
        {mailboxes.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <button type="button" class="finder-refine-btn" onClick={() => onAdd({ kind: "attachment" })}>
        Has attachment
      </button>
      <span class="finder-refine-spacer" />
      <button type="button" class="finder-refine-btn finder-save" disabled={!canSave} onClick={onSave}>
        Save this find
      </button>
    </div>
  );
}

/** Result rows, grouped by thread — a find lands you in a conversation. */
export function ThreadGroups({
  groups,
  selectedId,
  onSelect,
}: {
  groups: ThreadGroup[];
  selectedId?: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      {groups.map((g) => (
        <section key={g.threadId} class="finder-thread">
          <h2 class="finder-thread-head">
            <span class="finder-thread-subject">{g.subject}</span>
            {g.hits.length > 1 ? <span class="pill">{g.hits.length} messages</span> : null}
            <span class="muted finder-thread-when">{g.latest.slice(0, 10)}</span>
          </h2>
          <ul class="finder-hits">
            {g.hits.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  class={`finder-hit${h.id === selectedId ? " is-selected" : ""}`}
                  aria-current={h.id === selectedId ? "true" : undefined}
                  onClick={() => onSelect(h.id)}
                >
                  <span class="finder-hit-sender">{h.sender}</span>
                  <span class="finder-hit-preview muted">{h.preview}</span>
                  <span class="finder-hit-when muted">{h.receivedAt.slice(0, 10)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** The detail pane: the stored excerpt, honestly labelled, and the one exit —
 *  a plain literal-path anchor into Mail (the sweep allows plain anchors;
 *  no navigation API is touched). */
export function HitDetail({ hit }: { hit: FinderHit }) {
  return (
    <article class="finder-hit-detail">
      <h2 class="finder-detail-subject">{hit.subject}</h2>
      <p class="finder-detail-meta">
        <span class="finder-detail-sender">{hit.sender}</span>
        {hit.senderEmail !== "" && hit.senderEmail !== hit.sender ? (
          <span class="muted"> &lt;{hit.senderEmail}&gt;</span>
        ) : null}
        <span class="muted"> · {hit.receivedAt.slice(0, 10)}</span>
        {hit.hasAttachment ? <span class="pill">attachment</span> : null}
      </p>
      {hit.preview !== "" ? (
        <p class="finder-detail-excerpt">{hit.preview}</p>
      ) : (
        <p class="muted">No preview is stored for this message.</p>
      )}
      <p class="muted finder-detail-note">
        This is the stored excerpt, not the full message.{" "}
        <a class="link-button" href={`/mail?thread=${encodeURIComponent(hit.threadId)}`}>
          Open in Mail
        </a>
      </p>
    </article>
  );
}
