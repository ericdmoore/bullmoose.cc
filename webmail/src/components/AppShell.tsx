/** @jsxImportSource preact */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { hasAgentCapability } from "../lib/jmap/capabilities";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Session } from "../lib/jmap/types";
import { resolveClient, type ClientMode } from "../lib/app/client";
import {
  buildForwardDraft,
  buildReplyDraft,
  loadIdentities,
  newDraft,
  saveDraft,
  saveAndSend,
  type DraftSpec,
} from "../lib/mail/compose";
import { KEY_HELP, resolveKey, type KeyContext } from "../lib/mail/keymap";
import { findByRole, loadMailboxes, moveTargets } from "../lib/mail/mailboxes";
import {
  SEARCH_SCOPE_NOTE,
  buildEmailFilter,
  describeSearchScope,
  isEmptySpec,
  parseSearchInput,
  type SearchSpec,
} from "../lib/mail/search";
import { ThreadListStore, type ThreadRow } from "../lib/mail/threadList";
import { defaultExpanded, loadThread, type ThreadDetail } from "../lib/mail/threadView";
import {
  applyTriage,
  archivePatch,
  flaggedPatch,
  movePatch,
  seenPatch,
  trashPatch,
  type EmailPatch,
} from "../lib/mail/triage";
import type { Email, Identity, Mailbox } from "../lib/mail/types";
import Composer from "./Composer";
import MailboxSidebar from "./MailboxSidebar";
import MessageView from "./MessageView";
import ThreadListView from "./ThreadListView";

type View = "list" | "thread" | "compose";

interface Props {
  /** Injected in tests; the app resolves its own otherwise (invariant §6.1). */
  client?: JmapClient;
}

export default function AppShell({ client: injected }: Props) {
  const [client, setClient] = useState<JmapClient | undefined>(injected);
  const [mode, setMode] = useState<ClientMode>("live");
  const [modeReason, setModeReason] = useState<string | undefined>(undefined);
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [accountId, setAccountId] = useState<string>("");
  const [fatal, setFatal] = useState<string | undefined>(undefined);

  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [identityId, setIdentityId] = useState<string>("");
  const [mailbox, setMailbox] = useState<Mailbox | undefined>(undefined);

  const storeRef = useRef<ThreadListStore | undefined>(undefined);
  const [rows, setRows] = useState<ThreadRow[]>([]);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const [view, setView] = useState<View>("list");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [detail, setDetail] = useState<ThreadDetail | undefined>(undefined);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [imagesAllowed, setImagesAllowed] = useState<Set<string>>(new Set());
  const [showQuotes, setShowQuotes] = useState(false);

  const [draft, setDraft] = useState<DraftSpec | undefined>(undefined);
  const [draftId, setDraftId] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [composeError, setComposeError] = useState<string | undefined>(undefined);

  const [searchInput, setSearchInput] = useState("");
  const [searchSpec, setSearchSpec] = useState<SearchSpec>({});
  const [toast, setToast] = useState<string | undefined>(undefined);
  const [helpOpen, setHelpOpen] = useState(false);
  const chord = useRef<string | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // ── bootstrap ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let active = injected;
        if (!active) {
          const resolved = resolveClient();
          // No session → the door. This used to fall through to demo data,
          // which on a public origin means a stranger reading fake mail and
          // believing it (client.ts). The type has no client on this branch,
          // so there is nothing to render even by accident.
          if (resolved.mode === "unauthenticated") {
            location.assign("/login");
            return;
          }
          active = resolved.client;
          if (!cancelled) {
            setMode(resolved.mode);
            setModeReason(resolved.reason);
          }
        }
        const live = await active.session();
        const account = await active.primaryAccountId();
        const [boxes, ids] = await Promise.all([
          loadMailboxes(active, account),
          loadIdentities(active, account).catch(() => [] as Identity[]),
        ]);
        if (cancelled) return;
        setClient(active);
        setSession(live);
        setAccountId(account);
        setMailboxes(boxes);
        setIdentities(ids);
        setIdentityId(ids[0]?.id ?? "");
        setMailbox(findByRole(boxes, "inbox") ?? boxes[0]);
      } catch (err) {
        if (!cancelled) setFatal(String(err instanceof Error ? err.message : err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [injected]);

  const syncStore = useCallback((store: ThreadListStore) => {
    setRows([...store.getRows()]);
    setTotal(store.getTotal());
  }, []);

  // ── list, driven by mailbox + search ────────────────────────────────────
  useEffect(() => {
    if (!client || !accountId || !mailbox) return;
    const spec: SearchSpec = { ...searchSpec, inMailbox: mailbox.id };
    const store = new ThreadListStore(client, accountId, { filter: buildEmailFilter(spec) });
    storeRef.current = store;
    const off = store.onChange(() => syncStore(store));
    setLoading(true);
    setCursor(0);
    setSelected(new Set());
    void store
      .reload()
      .then(() => syncStore(store))
      .catch((err: unknown) => setToast(String(err instanceof Error ? err.message : err)))
      .finally(() => setLoading(false));
    return () => {
      off();
      if (storeRef.current === store) storeRef.current = undefined;
    };
  }, [client, accountId, mailbox?.id, searchSpec, syncStore]);

  // ── push sync: StateChange → re-query (never queryChanges) ──────────────
  useEffect(() => {
    if (!client || !accountId) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void client
      .watch(() => {
        void storeRef.current?.refresh().catch(() => undefined);
        void loadMailboxes(client, accountId)
          .then((boxes) => setMailboxes(boxes))
          .catch(() => undefined);
      })
      .then((off) => {
        if (cancelled) off();
        else stop = off;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [client, accountId]);

  const agentSeam = session ? hasAgentCapability(session) : false;

  // ── actions ─────────────────────────────────────────────────────────────

  const roleId = useCallback(
    (role: Parameters<typeof findByRole>[1]) => findByRole(mailboxes, role)?.id,
    [mailboxes],
  );

  const targetRows = useCallback((): ThreadRow[] => {
    if (selected.size > 0) return rows.filter((r) => selected.has(r.threadId));
    const row = rows[cursor];
    return row ? [row] : [];
  }, [rows, cursor, selected]);

  const runTriage = useCallback(
    async (build: (email: Email) => EmailPatch, opts: { remove?: boolean } = {}) => {
      const store = storeRef.current;
      if (!client || !store) return;
      const affected = targetRows();
      if (affected.length === 0) return;

      const patches: Record<string, EmailPatch> = {};
      const emailsById = new Map(store.getEmails().map((e) => [e.id, e]));
      for (const row of affected) {
        for (const id of row.emailIds) {
          const email = emailsById.get(id);
          if (!email) continue;
          const patch = build(email);
          if (Object.keys(patch).length > 0) patches[id] = patch;
        }
      }
      if (Object.keys(patches).length === 0) return;

      const ids = Object.keys(patches);
      // Optimistic: repaint now, reconcile on the response.
      if (opts.remove) store.removeLocal(ids);
      else for (const id of ids) store.patchLocal(id, localEffect(patches[id] as EmailPatch));
      syncStore(store);

      const result = await applyTriage(client, accountId, patches);
      if (result.refusal) {
        setToast(result.refusal.message);
        await store.refresh();
        syncStore(store);
        return;
      }
      if (result.notUpdated.length > 0) {
        setToast(`${result.notUpdated.length} message(s) could not be updated.`);
        await store.refresh();
      }
      setSelected(new Set());
      syncStore(store);
      void loadMailboxes(client, accountId)
        .then(setMailboxes)
        .catch(() => undefined);
    },
    [client, accountId, targetRows, syncStore],
  );

  const openThread = useCallback(
    async (row: ThreadRow) => {
      if (!client) return;
      setView("thread");
      setDetail(undefined);
      try {
        const loaded = await loadThread(client, accountId, row.threadId);
        setDetail(loaded);
        setExpanded(defaultExpanded(loaded.emails));
        setShowQuotes(false);
        // Opening marks read — the one triage action that fires without a key.
        const unread = loaded.emails.filter((e) => e.keywords.$seen !== true);
        if (unread.length > 0) {
          const patches = Object.fromEntries(unread.map((e) => [e.id, seenPatch(true)]));
          const store = storeRef.current;
          for (const e of unread) store?.patchLocal(e.id, { keywords: { $seen: true } });
          if (store) syncStore(store);
          const result = await applyTriage(client, accountId, patches);
          if (result.refusal) setToast(result.refusal.message);
          else
            void loadMailboxes(client, accountId)
              .then(setMailboxes)
              .catch(() => undefined);
        }
      } catch (err) {
        setToast(String(err instanceof Error ? err.message : err));
        setView("list");
      }
    },
    [client, accountId, syncStore],
  );

  const startCompose = useCallback((spec: DraftSpec) => {
    setDraft(spec);
    setDraftId(undefined);
    setComposeError(undefined);
    setView("compose");
  }, []);

  const currentIdentity = useMemo(
    () => identities.find((i) => i.id === identityId) ?? identities[0],
    [identities, identityId],
  );

  const doSend = useCallback(async () => {
    if (!client || !draft || !currentIdentity) return;
    const draftsId = roleId("drafts");
    const sentId = roleId("sent");
    if (!draftsId || !sentId) {
      setComposeError("This account has no Drafts or Sent mailbox to file the message in.");
      return;
    }
    setSending(true);
    setComposeError(undefined);
    try {
      await saveAndSend(client, accountId, {
        spec: draft,
        identityId: currentIdentity.id,
        draftsMailboxId: draftsId,
        sentMailboxId: sentId,
        ...(draftId ? { replaces: draftId } : {}),
      });
      setView("list");
      setDraft(undefined);
      setDraftId(undefined);
      setToast("Message sent.");
      await storeRef.current?.refresh();
      if (storeRef.current) syncStore(storeRef.current);
    } catch (err) {
      setComposeError(String(err instanceof Error ? err.message : err));
    } finally {
      setSending(false);
    }
  }, [client, draft, currentIdentity, accountId, draftId, roleId, syncStore]);

  const doSaveDraft = useCallback(async () => {
    if (!client || !draft) return;
    const draftsId = roleId("drafts");
    if (!draftsId) {
      setComposeError("This account has no Drafts mailbox.");
      return;
    }
    try {
      const saved = await saveDraft(client, accountId, draftsId, draft, {
        ...(draftId ? { replaces: draftId } : {}),
      });
      setDraftId(saved.id);
      setToast("Draft saved.");
    } catch (err) {
      setComposeError(String(err instanceof Error ? err.message : err));
    }
  }, [client, draft, accountId, draftId, roleId]);

  const doMove = useCallback(() => {
    const options = moveTargets(mailboxes, mailbox?.id);
    if (options.length === 0) return;
    const names = options.map((m, i) => `${i + 1}. ${m.name}`).join("\n");
    const answer = globalThis.prompt?.(`Move to which folder?\n${names}`, "1");
    const index = Number(answer) - 1;
    const destination = options[index];
    if (!destination) return;
    void runTriage((email) => movePatch(email, destination.id), { remove: true });
  }, [mailboxes, mailbox?.id, runTriage]);

  // ── keyboard ────────────────────────────────────────────────────────────
  const context: KeyContext =
    view === "compose" ? "compose" : view === "thread" ? "thread" : "list";

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      const resolution = resolveKey(
        {
          key: ev.key,
          ctrlKey: ev.ctrlKey,
          metaKey: ev.metaKey,
          shiftKey: ev.shiftKey,
          altKey: ev.altKey,
          target: ev.target as { tagName?: string; isContentEditable?: boolean } | null,
        },
        context,
        chord.current,
      );
      chord.current = resolution.pending;
      if (!resolution.handled) return;
      ev.preventDefault();
      const action = resolution.action;
      if (!action) return;

      switch (action) {
        case "next":
          if (view === "list") setCursor((c) => Math.min(c + 1, Math.max(0, rows.length - 1)));
          break;
        case "prev":
          if (view === "list") setCursor((c) => Math.max(0, c - 1));
          break;
        case "openSelected": {
          const row = rows[cursor];
          if (row) void openThread(row);
          break;
        }
        case "back":
          setView("list");
          setDetail(undefined);
          break;
        case "archive": {
          const inbox = roleId("inbox");
          const archive = roleId("archive");
          if (inbox && archive) {
            void runTriage((email) => archivePatch(email, inbox, archive), { remove: true });
            if (view === "thread") setView("list");
          } else setToast("This account has no Archive mailbox.");
          break;
        }
        case "trash": {
          const trash = roleId("trash");
          if (trash) {
            void runTriage((email) => trashPatch(email, trash), { remove: true });
            if (view === "thread") setView("list");
          } else setToast("This account has no Trash mailbox.");
          break;
        }
        case "toggleFlag": {
          const row = targetRows()[0];
          const next = !(row?.flagged ?? false);
          void runTriage(() => flaggedPatch(next));
          break;
        }
        case "toggleRead": {
          const row = targetRows()[0];
          const next = row?.unread ?? true;
          void runTriage(() => seenPatch(next));
          break;
        }
        case "move":
          doMove();
          break;
        case "toggleSelect": {
          const row = rows[cursor];
          if (row) {
            setSelected((prev) => {
              const next = new Set(prev);
              if (next.has(row.threadId)) next.delete(row.threadId);
              else next.add(row.threadId);
              return next;
            });
          }
          break;
        }
        case "selectAll":
          setSelected(new Set(rows.map((r) => r.threadId)));
          break;
        case "clearSelection":
          setSelected(new Set());
          break;
        case "compose":
          if (currentIdentity) startCompose(newDraft({ identity: currentIdentity }));
          break;
        case "reply":
        case "replyAll": {
          const email = detail?.emails.at(-1);
          if (email && currentIdentity) {
            startCompose(
              buildReplyDraft(email, {
                identity: currentIdentity,
                replyAll: action === "replyAll",
              }),
            );
          }
          break;
        }
        case "forward": {
          const email = detail?.emails.at(-1);
          if (email && currentIdentity)
            startCompose(buildForwardDraft(email, { identity: currentIdentity }));
          break;
        }
        case "search":
          searchRef.current?.focus();
          break;
        case "refresh":
          void storeRef.current?.refresh().then(() => {
            if (storeRef.current) syncStore(storeRef.current);
          });
          break;
        case "toggleQuote":
          setShowQuotes((v) => !v);
          break;
        case "showImages":
          if (detail) setImagesAllowed(new Set(detail.emails.map((e) => e.id)));
          break;
        case "send":
          void doSend();
          break;
        case "discard":
          setView("list");
          setDraft(undefined);
          break;
        case "help":
          setHelpOpen((v) => !v);
          break;
        case "goInbox":
        case "goArchive":
        case "goSent":
        case "goDrafts":
        case "goTrash": {
          const role = action.slice(2).toLowerCase() as Parameters<typeof findByRole>[1];
          const target = findByRole(mailboxes, role);
          if (target) {
            setMailbox(target);
            setView("list");
          }
          break;
        }
      }
    };

    globalThis.addEventListener?.("keydown", onKey);
    return () => globalThis.removeEventListener?.("keydown", onKey);
  }, [
    context,
    view,
    rows,
    cursor,
    detail,
    mailboxes,
    currentIdentity,
    openThread,
    runTriage,
    roleId,
    targetRows,
    doMove,
    doSend,
    startCompose,
    syncStore,
  ]);

  // ── render ──────────────────────────────────────────────────────────────

  if (fatal) {
    return (
      <main class="shell shell-error">
        <h1>bullmoose webmail</h1>
        <p>Could not reach the server: {fatal}</p>
        {/* This used to tell the user to append `?token=…`, i.e. to type a
            live credential into the address bar — which is the leak s07 T1
            exists to close (lib/app/tokenInUrl.test.ts). The door does the
            same job without the URL ever seeing it. */}
        <p class="muted">
          <a href="/login">Sign in again</a>, or append <code>?demo=1</code> to browse sample data.
        </p>
      </main>
    );
  }

  if (!client || !session) {
    return (
      <main class="shell">
        <p class="muted">Connecting…</p>
      </main>
    );
  }

  const spec: SearchSpec = { ...searchSpec, inMailbox: mailbox?.id };

  return (
    <div class="app">
      <header class="topbar">
        {/* Brand and identity moved up into the shared chrome (layouts/App.astro)
            when the app grew a section nav — two "bullmoose" wordmarks and two
            copies of the signed-in address stacked on one screen. What is left
            here is the mail section's own bar: search, and the agent seam. */}
        <form
          class="search"
          onSubmit={(ev) => {
            ev.preventDefault();
            const byName = new Map(mailboxes.map((m) => [m.name.toLowerCase(), m.id]));
            setSearchSpec(parseSearchInput(searchInput, byName));
          }}
        >
          <input
            ref={searchRef}
            type="search"
            value={searchInput}
            placeholder="Search mail — from:  to:  subject:  is:unread  has:attachment"
            aria-describedby="search-scope"
            onInput={(ev) => setSearchInput((ev.currentTarget as HTMLInputElement).value)}
          />
          {!isEmptySpec(searchSpec) ? (
            <button
              type="button"
              class="link-button"
              onClick={() => {
                setSearchInput("");
                setSearchSpec({});
              }}
            >
              Clear
            </button>
          ) : null}
        </form>
        {/*
          The console's entry point (s03.E), behind the same capability gate as
          every other agent surface. With `urn:bullmoose:params:jmap:agent`
          absent this renders NOTHING — no disabled button, no link to a page
          that would only explain itself. The plain-client floor (arch.md §8.6)
          is that the mail client is complete without it.

          It survives the section nav rather than being replaced by it, and the
          reason is exactly that gate: the nav is STATIC markup (App.astro), so
          it cannot know whether this session carries the agent capability —
          only the browser, after `session()`, knows that. A capability-less
          account therefore sees "Agents" in the nav; this seam is the one that
          still tells the truth, and the duplication is the cost of not
          hydrating the whole nav to hide one word.
        */}
        {agentSeam ? (
          <a class="console-link" href="/agents">
            Agents
          </a>
        ) : null}
      </header>

      {/* Search honesty: what the server actually matches (see search.ts). */}
      <p id="search-scope" class="search-scope">
        {SEARCH_SCOPE_NOTE}
      </p>

      {mode === "demo" ? (
        <p class="banner">
          Demo data — nothing here is real mail{modeReason ? ` (${modeReason})` : ""}.
        </p>
      ) : null}

      <div class="body">
        <MailboxSidebar
          mailboxes={mailboxes}
          selectedId={mailbox?.id}
          onSelect={(m) => {
            setMailbox(m);
            setView("list");
          }}
          onCompose={() => {
            if (currentIdentity) startCompose(newDraft({ identity: currentIdentity }));
          }}
        />

        <main class="content">
          {!isEmptySpec(searchSpec) ? <p class="scope-line">{describeSearchScope(spec)}</p> : null}

          {view === "compose" && draft ? (
            <Composer
              draft={draft}
              identities={identities}
              identityId={currentIdentity?.id ?? ""}
              sending={sending}
              error={composeError}
              onChange={setDraft}
              onIdentity={setIdentityId}
              onSend={() => void doSend()}
              onSaveDraft={() => void doSaveDraft()}
              onDiscard={() => {
                setView("list");
                setDraft(undefined);
              }}
            />
          ) : view === "thread" && detail ? (
            <MessageView
              detail={detail}
              expanded={expanded}
              imagesAllowed={imagesAllowed}
              showQuotes={showQuotes}
              onToggleExpand={(id) =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onAllowImages={(id) => setImagesAllowed((prev) => new Set(prev).add(id))}
              onToggleQuotes={() => setShowQuotes((v) => !v)}
              onReply={(email, all) => {
                if (currentIdentity) {
                  startCompose(
                    buildReplyDraft(email, { identity: currentIdentity, replyAll: all }),
                  );
                }
              }}
              onForward={(email) => {
                if (currentIdentity)
                  startCompose(buildForwardDraft(email, { identity: currentIdentity }));
              }}
              onBack={() => {
                setView("list");
                setDetail(undefined);
              }}
            />
          ) : view === "thread" ? (
            <p class="muted">Opening…</p>
          ) : (
            <ThreadListView
              rows={rows}
              total={total}
              cursor={cursor}
              selected={selected}
              loading={loading}
              onOpen={(row) => void openThread(row)}
              onCursor={setCursor}
              onToggleSelect={(row) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(row.threadId)) next.delete(row.threadId);
                  else next.add(row.threadId);
                  return next;
                })
              }
              onLoadMore={() => {
                const store = storeRef.current;
                if (!store || loading) return;
                setLoading(true);
                void store
                  .loadMore()
                  .then(() => syncStore(store))
                  .finally(() => setLoading(false));
              }}
            />
          )}
        </main>

        {/*
          The capability gate (arch.md §5, invariant §6.4). With
          `urn:bullmoose:params:jmap:agent` absent this renders NOTHING — no
          error, no empty panel, no dead region. s03.D fills it in; T2 is the
          plain-client floor and must stay usable without it.
        */}
        {agentSeam ? <aside class="agent-seam" aria-label="Agent" /> : null}
      </div>

      {toast ? (
        <div class="toast" role="status" onClick={() => setToast(undefined)}>
          {toast}
        </div>
      ) : null}

      {helpOpen ? (
        <div
          class="help-overlay"
          role="dialog"
          aria-label="Keyboard shortcuts"
          onClick={() => setHelpOpen(false)}
        >
          <div class="help-card">
            <h2>Keyboard</h2>
            <dl>
              {KEY_HELP.filter((row) => row.context.includes(context)).map((row) => (
                <div key={row.keys}>
                  <dt>{row.keys}</dt>
                  <dd>{row.description}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The local half of a patch, for the optimistic repaint. */
function localEffect(patch: EmailPatch): {
  keywords?: Record<string, boolean>;
  mailboxIds?: Record<string, boolean>;
} {
  const keywords: Record<string, boolean> = {};
  const mailboxIds: Record<string, boolean> = {};
  for (const [path, value] of Object.entries(patch)) {
    const [head, sub] = path.split("/");
    if (!sub) continue;
    if (head === "keywords") keywords[sub] = value === true;
    else if (head === "mailboxIds") mailboxIds[sub] = value === true;
  }
  return {
    ...(Object.keys(keywords).length > 0 ? { keywords } : {}),
    ...(Object.keys(mailboxIds).length > 0 ? { mailboxIds } : {}),
  };
}
