/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import { resolveClient } from "../lib/app/client";
import { approvalsAccountId } from "../lib/approvals/accounts";
import { createNote, destroyNote, loadNotes, updateNote } from "../lib/notes/api";
import {
  NOTES_SUB,
  NOT_ANNOTATIONS_NOTE,
  NO_FEDERATION_NOTE,
  SEARCH_SCOPE_NOTE,
  filterNotes,
  isDirty,
  isWritable,
  noteSnippet,
  noteTitle,
  notesCollections,
  notesGate,
  orderNotes,
} from "../lib/notes/notes";
import type { Note } from "../lib/notes/types";
import { hrefWithParam, urlParam } from "../lib/shell/publish";
import { listRowClasses } from "../lib/ui/classes";
import { isUnmodifiedPrimaryClick, syncDetailUrl } from "../lib/ui/navigation";
import CollectionColumn from "./CollectionColumn";
import { publishGroups } from "../lib/shell/publishGroups";
import { ListContainer } from "./ui";
import Button from "./ui/Button";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Session } from "../lib/jmap/types";

/**
 * The Notes realm (s18 N1) — "a private document that federates," minus the
 * federating, which is not built and says so on its own face.
 *
 * ⚠️ THE DISTINCTION THIS SCREEN EXISTS TO KEEP: a **Note is a document you
 * author**; an **Annotation is a claim about your mail that you adjudicate**
 * and renders in the MARGIN of the message it is about (`AnnotationMargin`,
 * s18 A3). s18 resolved them as two entities (Eric, 2026-08-17) and the two
 * halves must not drift back together — so this screen never lists an
 * annotation, never grows a confirm/dismiss verb, and states the difference in
 * words (`NOT_ANNOTATIONS_NOTE`) where a person will actually read it.
 *
 * Deliberately THIN, the split every island here follows: vitest runs in plain
 * Node with no jsdom, so the rules live in `lib/notes/*` as tested pure
 * functions — the fetch and the three writes in `api.ts`, the gate/ordering/
 * grouping/copy in `notes.ts`, the row model in `types.ts`. This file is state
 * plumbing and composition.
 *
 * CSP: no inline style, no form that can navigate, no history call. The editor
 * is a plain textarea with a Save button — a `<form>` would submit to the
 * current URL as GET and serialize the note's text into the address bar, which
 * is both the tokenInUrl invariant and, for a private document, considerably
 * worse than a lost keystroke.
 */

interface Props {
  /** Injected in tests; the screen resolves its own otherwise. */
  client?: JmapClient;
}

interface Draft {
  title: string;
  body: string;
}

const EMPTY: Draft = { title: "", body: "" };

export default function NotesApp({ client: injectedClient }: Props) {
  const [client, setClient] = useState<JmapClient | undefined>(injectedClient);
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [isDemo, setIsDemo] = useState(false);
  const [fatal, setFatal] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const [notes, setNotes] = useState<Note[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [collection, setCollection] = useState("all");
  // `/notes?n=<id>` deep-links one note — read once at mount, the MPA
  // detail-URL pattern every surface follows.
  const [selectedId, setSelectedId] = useState<string | undefined>(() => urlParam("n"));
  /** Non-null while composing a NEW note; the detail panel shows it instead
   *  of a selection. Separate state so an unsaved new note is never confused
   *  with an edit of an existing one. */
  const [composing, setComposing] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // ── bootstrap ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let jmap = injectedClient;
        if (!jmap) {
          const resolved = resolveClient();
          // Same rule as every other section: no session → the door. A notes
          // screen full of convincing sample prose is worse than most: it
          // reads as someone's private writing.
          if (resolved.mode === "unauthenticated") {
            location.assign("/login");
            return;
          }
          if (resolved.mode === "demo") {
            const { installNotesDemo } = await import("../lib/notes/demoNotes");
            installNotesDemo(resolved.demo.client);
            if (!cancelled) setIsDemo(true);
          }
          jmap = resolved.client;
        }
        const live = await jmap.session();
        if (cancelled) return;
        setSession(live);
        setClient(jmap);
      } catch (err) {
        if (!cancelled) setFatal(message(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [injectedClient]);

  const gate = notesGate(session);
  // ONE account: a note is a document you authored in your own account, and
  // nothing shares one across accounts (s18 N3 is unbuilt), so the fan-out the
  // approvals queue and the annotations glances do would query accounts that
  // cannot hold an answer.
  const accountId = useMemo(() => (session ? approvalsAccountId(session) : ""), [session]);

  // ── the list ────────────────────────────────────────────────────────────
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    if (!client || !accountId || gate.state !== "open") return;
    let cancelled = false;
    setLoading(true);
    void loadNotes(client, accountId)
      .then((res) => {
        if (cancelled) return;
        setNotes(res.notes);
        setFailure(res.failure);
        setLoading(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setFatal(message(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, accountId, gate.state, reloads]);

  // The contextual filter (s24 T5): the chrome's bar dispatches `bm:search`,
  // and `?q=` deep-links it. Filtering happens in the browser over the loaded
  // list — the server's own `filter.text` is the same predicate, so the two
  // agree; this just avoids a round trip per keystroke.
  useEffect(() => {
    const q = urlParam("q");
    if (q) setQuery(q);
    const onSearch = (ev: Event) => setQuery(String((ev as CustomEvent<{ q?: string }>).detail?.q ?? "").trim());
    globalThis.addEventListener("bm:search", onSearch);
    return () => globalThis.removeEventListener("bm:search", onSearch);
  }, []);

  const ordered = useMemo(() => orderNotes(notes), [notes]);
  const visible = useMemo(() => filterNotes(ordered, query), [ordered, query]);
  const groups = useMemo(() => notesCollections(ordered), [ordered]);

  // s25 T4 (#226): the tray renders leaf-nodes only for realms that
  // publish. One line, off the SAME array the column renders, so the
  // two can never disagree about what this realm's collections are.
  useEffect(() => publishGroups("notes", "/notes", groups), [groups]);
  const selected = composing ? undefined : visible.find((n) => n.id === selectedId);

  // Keep a valid selection as the list changes under us — the same self-repair
  // the other master-details do. Not while loading, and never while composing:
  // repairing then would throw away an unsaved new note.
  useEffect(() => {
    if (loading || composing) return;
    if (visible.length === 0) {
      if (selectedId !== undefined) setSelectedId(undefined);
      return;
    }
    if (!visible.some((n) => n.id === selectedId)) setSelectedId(visible[0]!.id);
  }, [visible, selectedId, loading, composing]);

  // The editor follows the selection. An edit in progress on ANOTHER note is
  // dropped by design: there is no autosave, and pretending otherwise (a
  // "restored draft" that never reached the server) is the kind of quiet lie
  // this codebase keeps out of its surfaces.
  useEffect(() => {
    if (composing) return;
    setDraft(selected ? { title: selected.title, body: selected.body } : EMPTY);
    setWriteError(null);
    setConfirmDelete(null);
  }, [selected?.id, composing]);

  const editing = composing ?? draft;
  const dirty = isDirty(editing, composing ? undefined : selected);
  const canSave = !!client && !busy && !forbidden && isWritable(editing) && dirty;

  async function save(): Promise<void> {
    if (!client || !accountId) return;
    setBusy(true);
    setWriteError(null);
    const res = composing
      ? await createNote(client, accountId, composing)
      : selected
        ? await updateNote(client, accountId, selected.id, { title: draft.title, body: draft.body })
        : { ok: false as const, message: "nothing to save", forbidden: false };
    setBusy(false);
    if (!res.ok) {
      setWriteError(res.message);
      if (res.forbidden) setForbidden(true);
      return;
    }
    setComposing(null);
    setSelectedId(res.id);
    setReloads((n) => n + 1);
  }

  async function remove(id: string): Promise<void> {
    if (!client || !accountId) return;
    setBusy(true);
    setWriteError(null);
    const res = await destroyNote(client, accountId, id);
    setBusy(false);
    setConfirmDelete(null);
    if (!res.ok) {
      setWriteError(res.message);
      if (res.forbidden) setForbidden(true);
      return;
    }
    setSelectedId(undefined);
    setReloads((n) => n + 1);
  }

  // ── shells ──────────────────────────────────────────────────────────────
  // `div`, not `main`: AppTw.astro owns the page's one <main>.
  if (fatal) {
    return (
      <div class="shell shell-error">
        <h1>Notes</h1>
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
  if (gate.state !== "open") {
    return (
      <div class="shell">
        <h1>Notes</h1>
        <p class="muted">{gate.reason}</p>
        <p class="muted">
          <a href="/mail">← back to mail</a>
        </p>
      </div>
    );
  }

  return (
    <div class="notes">
      {isDemo ? (
        <p class="banner">Sample data. These notes are generated in this browser tab and reach no server.</p>
      ) : null}

      <header class="notes-head">
        <h1>Notes</h1>
        <p class="muted notes-sub">{NOTES_SUB}</p>
        {/* The two sentences this realm must not lose: what a note is NOT,
            and what it cannot yet do. */}
        <p class="muted notes-fine">{NOT_ANNOTATIONS_NOTE}</p>
        <p class="muted notes-fine">{NO_FEDERATION_NOTE}</p>
      </header>

      {failure ? (
        <p class="notes-error" role="alert">
          {failure}
        </p>
      ) : null}
      {loading ? <p class="muted notes-pad">Reading your notes…</p> : null}

      <div class="notes-panes grid grid-cols-1 lg:grid-cols-[auto_22rem_1fr]">
        {/* COLUMN 2 — the collections. v1 has exactly ONE real collection —
            there are no folders, tags or shares to subset by — so the
            selection is inert by construction rather than by omission; the
            second row is disabled and states the federation limit where a
            person would look for it. */}
        <CollectionColumn
          title="Notes"
          storageKey="bm.cc.notes"
          groups={groups}
          selectedId={collection}
          onSelect={setCollection}
          newLabel="New note"
          newDisabled={forbidden}
          onNew={() => {
            setComposing({ ...EMPTY });
            setSelectedId(undefined);
            setWriteError(null);
          }}
        />

        {/* COLUMN 3 — the notes, most recently edited first. */}
        <nav aria-label="Notes" class="notes-pane">
          {query ? <p class="muted notes-fine">{SEARCH_SCOPE_NOTE}</p> : null}
          {/* The rows are REAL links to `/notes?n=<id>` — the param the
              initializer above already read, which until now nothing on the
              screen could produce. A note is a document, and a document with
              no address cannot be cmd-clicked into its own tab or quoted in a
              message; the plain click still stays in the page.

              The anchor is hand-rolled rather than `<ListRow href … onSelect
              …>` because `ListRow` still treats the two as ALTERNATIVES —
              href renders a link with no handler, onSelect a button with no
              URL. `StackedRow` has already been taught to take both; teaching
              `ListRow` the same is the tidy-up this realm is waiting on, and
              it is a shared-primitive change, not a Notes one. Classes come
              from `listRowClasses` either way, so the row is the same row. */}
          <ListContainer>
            {visible.map((n) => {
              const active = !composing && n.id === selected?.id;
              return (
                <li key={n.id}>
                  <a
                    href={noteHref(n.id)}
                    class={listRowClasses({ active })}
                    aria-current={active ? "true" : undefined}
                    onClick={(ev) => {
                      // Modified clicks belong to the browser — see navigation.ts.
                      if (!isUnmodifiedPrimaryClick(ev)) return;
                      ev.preventDefault();
                      selectNote(n.id);
                    }}
                  >
                    <span class="flex min-w-0 grow flex-col text-left">
                      <span class="truncate">{noteTitle(n)}</span>
                      <span class="truncate text-xs font-normal text-gray-400 dark:text-gray-500">
                        {noteSnippet(n)}
                      </span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ListContainer>
          {!loading && visible.length === 0 ? (
            <p class="muted notes-pad">
              {query
                ? "No note matches that."
                : "No notes yet. “New note” writes one — it stays in your account and goes nowhere else."}
            </p>
          ) : null}
        </nav>

        {/* COLUMN 4 — the note itself, editable in place (readme §1: inline
            editing is one of the two things mail lacks that a note needs). */}
        <section aria-label="Note" class="notes-pane min-w-0">
          {composing || selected ? (
            <div class="notes-editor">
              <label class="notes-label" for="note-title">
                Title
              </label>
              <input
                id="note-title"
                class="notes-title"
                type="text"
                value={editing.title}
                disabled={forbidden}
                onInput={(e) => setField("title", (e.target as HTMLInputElement).value)}
              />

              <label class="notes-label" for="note-body">
                Note
              </label>
              <textarea
                id="note-body"
                class="notes-body"
                rows={18}
                value={editing.body}
                disabled={forbidden}
                onInput={(e) => setField("body", (e.target as HTMLTextAreaElement).value)}
              />

              <div class="notes-actions">
                <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
                  {busy ? "Saving…" : composing ? "Create note" : "Save"}
                </Button>
                {composing ? (
                  <Button onClick={() => setComposing(null)}>Discard</Button>
                ) : selected ? (
                  confirmDelete === selected.id ? (
                    <>
                      <Button variant="danger" disabled={busy} onClick={() => void remove(selected.id)}>
                        Delete permanently
                      </Button>
                      <Button onClick={() => setConfirmDelete(null)}>Keep</Button>
                    </>
                  ) : (
                    <Button disabled={busy || forbidden} onClick={() => setConfirmDelete(selected.id)}>
                      Delete
                    </Button>
                  )
                ) : null}
              </div>

              {writeError ? (
                <p class="notes-error" role="alert">
                  {writeError}
                </p>
              ) : null}

              {selected ? (
                // Revision and owner are the federation IDENTITY (s18 N3),
                // shown because they are true, not because anything travels.
                <p class="muted notes-fine">
                  Revision {selected.revision} · written by {selected.owner}
                  {selected.lastWriterBinding ? ` · last saved by the ${selected.lastWriterBinding} agent` : ""}
                </p>
              ) : null}
            </div>
          ) : !loading ? (
            <p class="muted notes-pad">Pick a note, or write a new one.</p>
          ) : null}
        </section>
      </div>
    </div>
  );

  function selectNote(id: string): void {
    setComposing(null);
    setSelectedId(id);
    // Keep the address bar on the note being read, so the link you would copy
    // is the one you are looking at. `replaceState`, never push — opening a
    // note is not a new page (lib/ui/navigation.ts).
    syncDetailUrl(noteHref(id));
  }

  /** The row's detail URL — `/notes?n=<id>`, `?q=`/`?demo=` preserved. */
  function noteHref(id: string): string {
    return hrefWithParam("/notes", "n", id);
  }

  function setField(key: keyof Draft, value: string): void {
    if (composing) setComposing({ ...composing, [key]: value });
    else setDraft((d) => ({ ...d, [key]: value }));
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
