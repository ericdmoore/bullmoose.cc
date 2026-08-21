/** @jsxImportSource preact */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { resolveClient, type ClientMode } from "../lib/app/client";
import { runListLoad } from "../lib/app/listLoad";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Session } from "../lib/jmap/types";
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
  buildEmailFilter,
  describeSearchScope,
  isEmptySpec,
  parseSearchInput,
  type SearchSpec,
} from "../lib/mail/search";
import { cachedIds, dropEmails, readEmails, writeEmails } from "../lib/app/emailStore";
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
import { restorePatches } from "../lib/mail/undo";
import type { Email, Identity, Mailbox } from "../lib/mail/types";
import Composer from "./Composer";
import CollectionBar from "./CollectionBar";
import CollectionColumn, { useCollapsed } from "./CollectionColumn";
import { buildMailboxTree, flattenTree } from "../lib/mail/mailboxes";
import type { CollectionGroup } from "../lib/shell/collections";
import { hrefWithParams, publishCollections, publishedHref, urlParam } from "../lib/shell/publish";
import {
  ArchiveBoxIcon,
  FolderIcon,
  InboxIcon,
  NoSymbolIcon,
  PaperAirplaneIcon,
  PencilSquareIcon,
  TrashIcon,
  type IconProps,
} from "./icons";
import MessageView from "./MessageView";
import ThreadListView, { type SwipeAction } from "./ThreadListView";
import { Alert, EmptyState, PageNotice, Skeleton, SkeletonRegion, SurfaceFrame } from "./ui";
import { cx } from "../lib/ui/classes";

type View = "list" | "thread" | "compose";

interface Props {
  /** Injected in tests; the app resolves its own otherwise (invariant §6.1). */
  client?: JmapClient;
}

/** Mailbox role → its Heroicon (s24 T3b — real SVG, not font dingbats). */
const ROLE_ICON: Record<string, (p: IconProps) => preact.JSX.Element> = {
  inbox: InboxIcon,
  drafts: PencilSquareIcon,
  sent: PaperAirplaneIcon,
  archive: ArchiveBoxIcon,
  junk: NoSymbolIcon,
  trash: TrashIcon,
};

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
  // The clicked row, held for the length of the fetch so the header can be
  // real while the body is still a shape.
  const [pendingRow, setPendingRow] = useState<ThreadRow | undefined>(undefined);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [imagesAllowed, setImagesAllowed] = useState<Set<string>>(new Set());
  const [showQuotes, setShowQuotes] = useState(false);

  const [draft, setDraft] = useState<DraftSpec | undefined>(undefined);
  const [draftId, setDraftId] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [composeError, setComposeError] = useState<string | undefined>(undefined);

  const [searchSpec, setSearchSpec] = useState<SearchSpec>({});
  const [toast, setToast] = useState<string | undefined>(undefined);
  // s25 T6 — the recourse a gesture owes you. One action deep, deliberately:
  // the toast that reports a swipe carries the way to reverse it, and the next
  // toast replaces both. Anything older is recovered where it actually is —
  // in Archive or Trash, because both verbs are MOVES (triage.ts).
  const [undoAction, setUndoAction] = useState<{ label: string; run: () => void } | undefined>(undefined);
  const [helpOpen, setHelpOpen] = useState(false);
  const chord = useRef<string | undefined>(undefined);
  const { collapsed: foldersCollapsed, toggle: toggleFolders } = useCollapsed("bm.cc.mail");

  /** Say something, optionally with the way back. Every toast goes through
   *  here so a stale Undo can never outlive the message it belonged to. */
  const notify = useCallback((message: string, undo?: { label: string; run: () => void }) => {
    setToast(message);
    setUndoAction(undo);
  }, []);
  const dismissToast = useCallback(() => {
    setToast(undefined);
    setUndoAction(undefined);
  }, []);

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
        // s25 T3/T4 — `?c=<mailboxId>` preselects the collection (the realm
        // tray's leaf-node links land here); absent or unknown, the inbox
        // default stands.
        const preselect = urlParam("c");
        setMailbox(
          (preselect !== undefined ? boxes.find((b) => b.id === preselect) : undefined) ??
            findByRole(boxes, "inbox") ??
            boxes[0],
        );
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

  // s24 T5 — the contextual bar: submissions arrive as a `bm:search` event
  // from the chrome island (never a navigation — the s07 T1 invariant), and a
  // deep-linked /mail?q=… is parsed once after mailboxes load, because `in:`
  // folder terms resolve against mailbox names. Clearing links back to /mail.
  useEffect(() => {
    const onSearch = (ev: Event) => {
      const q = String((ev as CustomEvent<{ q?: string }>).detail?.q ?? "");
      const byName = new Map(mailboxes.map((m) => [m.name.toLowerCase(), m.id]));
      setSearchSpec(q.trim() ? parseSearchInput(q, byName) : {});
      setView("list");
    };
    globalThis.addEventListener("bm:search", onSearch);
    return () => globalThis.removeEventListener("bm:search", onSearch);
  }, [mailboxes]);
  const qParsed = useRef(false);
  useEffect(() => {
    if (qParsed.current || mailboxes.length === 0) return;
    qParsed.current = true;
    const q = new URLSearchParams(location.search).get("q");
    if (!q) return;
    const byName = new Map(mailboxes.map((m) => [m.name.toLowerCase(), m.id]));
    setSearchSpec(parseSearchInput(q, byName));
  }, [mailboxes]);

  // s25 T4 — publish the top-level mailbox tree for the chrome's realm tray
  // (lib/shell/publish.ts): label, live unread count, and a `?c=` link that
  // preselects the mailbox via the block above. Re-published whenever the
  // mailboxes move, so the tray's counts follow triage.
  useEffect(() => {
    if (mailboxes.length === 0) return;
    publishCollections(
      "mail",
      buildMailboxTree(mailboxes).map((n) => ({
        id: n.id,
        label: n.name,
        ...(n.unreadEmails > 0 ? { count: n.unreadEmails } : {}),
        href: publishedHref("/mail", n.id),
      })),
    );
  }, [mailboxes]);

  // ── list, driven by mailbox + search ────────────────────────────────────
  //
  // Each run supersedes the last, and the load it supersedes is a promise
  // already in flight — so every write back into state goes through
  // `runListLoad`, which delivers only while `storeRef.current` still points at
  // the store that started it (lib/app/listLoad.ts). `storeRef` is the ONE
  // record of which load owns the list: assigned on entry, dropped by the
  // cleanup below, and read by the paging call in `onLoadMore` too.
  useEffect(() => {
    if (!client || !accountId || !mailbox) return;
    const spec: SearchSpec = { ...searchSpec, inMailbox: mailbox.id };
    const store = new ThreadListStore(client, accountId, { filter: buildEmailFilter(spec) });
    storeRef.current = store;
    const off = store.onChange(() => syncStore(store));
    setLoading(true);
    setCursor(0);
    setSelected(new Set());
    runListLoad(
      () => store.reload(),
      () => storeRef.current === store,
      {
        onResult: () => syncStore(store),
        onError: (message) => notify(message),
        onSettled: () => setLoading(false),
      },
    );
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

  // ── actions ─────────────────────────────────────────────────────────────

  const roleId = useCallback((role: Parameters<typeof findByRole>[1]) => findByRole(mailboxes, role)?.id, [mailboxes]);

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
        notify(result.refusal.message);
        await store.refresh();
        syncStore(store);
        return;
      }
      if (result.notUpdated.length > 0) {
        notify(`${result.notUpdated.length} message(s) could not be updated.`);
        await store.refresh();
      }
      setSelected(new Set());
      syncStore(store);
      void loadMailboxes(client, accountId)
        .then(setMailboxes)
        .catch(() => undefined);
    },
    [client, accountId, targetRows, syncStore, notify],
  );

  // ── s25 T6: swipe triage ────────────────────────────────────────────────

  /**
   * Which verbs a swipe may reveal HERE. Derived from the account's mailboxes,
   * not hardcoded: an account with no Archive gets one button rather than a
   * button that would collect a `forbidden` refusal on tap. The verbs are the
   * two the keyboard already has (`e` and `#`) — T6 adds a position, not a
   * vocabulary.
   */
  const swipeActions = useMemo<SwipeAction[]>(() => {
    const actions: SwipeAction[] = [];
    if (roleId("inbox") && roleId("archive")) actions.push({ id: "archive", label: "Archive", tone: "neutral" });
    if (roleId("trash")) actions.push({ id: "trash", label: "Trash", tone: "danger" });
    return actions;
  }, [roleId]);

  /**
   * Fire one revealed verb, on ONE row, with a way back.
   *
   * Separate from `runTriage` for two reasons that both matter. It acts on the
   * row you swiped rather than on `targetRows()` — a checkbox selection made
   * ten rows ago must not ride along with a gesture aimed at this one. And it
   * remembers each message's filing BEFORE the patch, which is what makes the
   * toast's Undo an exact inverse (`lib/mail/undo.ts`) rather than a guess.
   */
  const runSwipe = useCallback(
    async (row: ThreadRow, action: SwipeAction["id"]) => {
      const store = storeRef.current;
      if (!client || !store) return;
      const inbox = roleId("inbox");
      const archive = roleId("archive");
      const trash = roleId("trash");

      const emailsById = new Map(store.getEmails().map((e) => [e.id, e]));
      const patches: Record<string, EmailPatch> = {};
      const before: Record<string, Record<string, boolean>> = {};
      for (const id of row.emailIds) {
        const email = emailsById.get(id);
        if (!email) continue;
        const patch =
          action === "archive"
            ? inbox && archive
              ? archivePatch(email, inbox, archive)
              : {}
            : trash
              ? trashPatch(email, trash)
              : {};
        if (Object.keys(patch).length === 0) continue;
        patches[id] = patch;
        before[id] = { ...(email.mailboxIds ?? {}) };
      }
      if (Object.keys(patches).length === 0) {
        notify(action === "archive" ? "This account has no Archive mailbox." : "This account has no Trash mailbox.");
        return;
      }

      // Optimistic: the row leaves now, the server catches up.
      store.removeLocal(Object.keys(patches));
      syncStore(store);

      const result = await applyTriage(client, accountId, patches);
      if (result.refusal) {
        notify(result.refusal.message);
        await store.refresh();
        syncStore(store);
        return;
      }
      void loadMailboxes(client, accountId)
        .then(setMailboxes)
        .catch(() => undefined);

      const inverse = restorePatches(before, patches);
      notify(action === "archive" ? "Archived." : "Moved to Trash.", {
        label: "Undo",
        run: () => {
          void (async () => {
            const undone = await applyTriage(client, accountId, inverse);
            if (undone.refusal) {
              notify(undone.refusal.message);
              return;
            }
            // Put it back on screen from the server's answer, not from a
            // local guess: the message may have moved again underneath us.
            const current = storeRef.current;
            if (current) {
              await current.refresh();
              syncStore(current);
            }
            void loadMailboxes(client, accountId)
              .then(setMailboxes)
              .catch(() => undefined);
          })();
        },
      });
    },
    [client, accountId, roleId, syncStore, notify],
  );

  // By THREAD ID, not row: `/mail?thread=<id>` still opens a thread on mount
  // (the deep link, and cmd-click / copy-link). Primary clicks and j/k + Enter
  // both fetch in-page so mailbox selection (Archive, …) survives. No history
  // call — tokenInUrl.test.ts.
  const openThread = useCallback(
    // `row` is the row that was clicked. The list ALREADY holds this thread's
    // subject and message count (LIST_PROPERTIES), so there is no reason to
    // shimmer them while the bodies travel — we can only be slow about the
    // part we genuinely do not have. Absent on a cold `?thread=` deep link,
    // where we really do know nothing yet, and the header falls back to bars.
    async (threadId: string, row?: ThreadRow) => {
      if (!client) return;
      setView("thread");
      setDetail(undefined);
      setPendingRow(row);

      // CACHE FIRST. An Email is immutable but for its flags (RFC 8621 §4.1),
      // so a body we have read before needs no revalidation — it cannot have
      // changed. The ids come from the row, which is why this costs no request
      // to discover what to look for.
      //
      // The network call still runs, unawaited: it refreshes flags and picks
      // up any message the row did not know about. So the reader sees the
      // thread at once and the truth arrives behind it.
      let painted = false;
      if (row?.emailIds?.length) {
        try {
          const cached = await readEmails(row.emailIds);
          const fromCache = threadFromCache(threadId, row.emailIds, cached);
          if (fromCache) {
            setDetail(fromCache);
            setExpanded(defaultExpanded(fromCache.emails));
            setShowQuotes(false);
            setPendingRow(undefined);
            painted = true;
          }
        } catch {
          /* a cache miss is not an error — fall through to the network */
        }
      }

      try {
        const loaded = await loadThread(client, accountId, threadId);
        setDetail(loaded);
        setPendingRow(undefined);
        void writeEmails(loaded.emails);
        // Only when the cache did not already paint: re-deriving these would
        // collapse a message the reader had just opened, or re-hide quotes
        // they had just expanded, the instant the network caught up.
        if (!painted) {
          setExpanded(defaultExpanded(loaded.emails));
          setShowQuotes(false);
        }
        // Opening marks read — the one triage action that fires without a key.
        const unread = loaded.emails.filter((e) => e.keywords.$seen !== true);
        if (unread.length > 0) {
          const patches = Object.fromEntries(unread.map((e) => [e.id, seenPatch(true)]));
          const store = storeRef.current;
          for (const e of unread) store?.patchLocal(e.id, { keywords: { $seen: true } });
          if (store) syncStore(store);
          const result = await applyTriage(client, accountId, patches);
          if (result.refusal) notify(result.refusal.message);
          else
            void loadMailboxes(client, accountId)
              .then(setMailboxes)
              .catch(() => undefined);
        }
      } catch (err) {
        setPendingRow(undefined);
        // If the cache already painted, the reader is looking at a real
        // thread; a failed background refresh is a stale-flags problem, not a
        // reason to yank them back to the list.
        if (!painted) {
          notify(String(err instanceof Error ? err.message : err));
          setView("list");
        }
      }
    },
    [client, accountId, syncStore],
  );

  // Reconcile the cached flags with the server once the client is up. Bodies
  // are never revalidated (they cannot change); this is the other half — the
  // read/unread and mailbox state that can, and that a cached message would
  // otherwise show as it was when it was stored.
  useEffect(() => {
    if (!client || !accountId) return;
    void syncCachedFlags(client, accountId, { cachedIds, readEmails, writeEmails, dropEmails }).catch(() => undefined);
  }, [client, accountId]);

  // s25 T3 — the detail URL, read ONCE at mount: `/mail?thread=<id>` opens
  // that thread on first paint (deep link, new tab, shared URL). Read-only:
  // nothing ever WRITES the param after mount (that would take a history
  // call, and this app makes exactly one, in client.ts — tokenInUrl.test.ts).
  // In-page clicks fetch the message without navigating, so mailbox selection
  // (Archive, …) is not reset to inbox by a remount. The URL can drift from
  // the open thread; cmd-click / copy-link still use the row's href.
  const threadParsed = useRef(false);
  useEffect(() => {
    if (threadParsed.current || !client || !accountId) return;
    threadParsed.current = true;
    const id = urlParam("thread");
    if (id !== undefined) void openThread(id);
  }, [client, accountId, openThread]);

  // Keep the list cursor on the open thread so the selection-column highlight
  // matches the ItemDetail pane (desktop list + message).
  useEffect(() => {
    if (!detail) return;
    const i = rows.findIndex((r) => r.threadId === detail.threadId);
    if (i >= 0) setCursor((c) => (c === i ? c : i));
  }, [detail, rows]);

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

  // s24 T3 — the CollectionColumn's feed: the mailbox tree flattened in visual
  // order, role glyphs as row glyphs, unread as the count badge, nesting as
  // depth (a discrete padding class — this retires MailboxSidebar's inline
  // paddingLeft, the one CSP-boundary violation).

  const mailboxGroups: CollectionGroup[] = useMemo(
    () => [
      {
        id: "mailboxes",
        items: flattenTree(buildMailboxTree(mailboxes)).map((n) => ({
          id: n.id,
          label: n.name,
          icon: (n.role ? ROLE_ICON[n.role] : undefined) ?? FolderIcon,
          depth: n.depth,
          count: n.unreadEmails > 0 ? n.unreadEmails : undefined,
        })),
      },
    ],
    [mailboxes],
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
      notify("Message sent.");
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
      notify("Draft saved.");
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
  const context: KeyContext = view === "compose" ? "compose" : view === "thread" ? "thread" : "list";

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
        case "next": {
          const next = Math.min(cursor + 1, Math.max(0, rows.length - 1));
          setCursor(next);
          if (view === "thread") {
            const row = rows[next];
            if (row && row.threadId !== detail?.threadId) void openThread(row.threadId, row);
          }
          break;
        }
        case "prev": {
          const next = Math.max(0, cursor - 1);
          setCursor(next);
          if (view === "thread") {
            const row = rows[next];
            if (row && row.threadId !== detail?.threadId) void openThread(row.threadId, row);
          }
          break;
        }
        case "openSelected": {
          const row = rows[cursor];
          if (row) void openThread(row.threadId, row);
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
          } else notify("This account has no Archive mailbox.");
          break;
        }
        case "trash": {
          const trash = roleId("trash");
          if (trash) {
            void runTriage((email) => trashPatch(email, trash), { remove: true });
            if (view === "thread") setView("list");
          } else notify("This account has no Trash mailbox.");
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
          if (email && currentIdentity) startCompose(buildForwardDraft(email, { identity: currentIdentity }));
          break;
        }
        case "search":
          // The bar lives in the chrome island now (s24 T5) — reach it by id.
          document.querySelector<HTMLInputElement>("#bm-global-search")?.focus();
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
      <PageNotice title="Could not reach the server" error>
        <p>Could not reach the server: {fatal}</p>
        <p class="mt-2">
          <a href="/login" class="font-medium text-brand-600 hover:text-brand-500">
            Sign in again
          </a>
          , or append <code>?demo=1</code> to browse sample data.
        </p>
      </PageNotice>
    );
  }

  if (!client || !session) {
    return <PageNotice>Connecting…</PageNotice>;
  }

  const spec: SearchSpec = { ...searchSpec, inMailbox: mailbox?.id };

  return (
    <div class="flex h-full min-h-0 w-full flex-col">
      {mode === "demo" ? (
        <Alert tone="info" class="m-4 shrink-0">
          Demo data — nothing here is real mail{modeReason ? ` (${modeReason})` : ""}.
        </Alert>
      ) : null}

      <SurfaceFrame>
        <CollectionColumn
          title="Mail"
          storageKey="bm.cc.mail"
          collapseMode="bar"
          collapsed={foldersCollapsed}
          onCollapsedChange={toggleFolders}
          groups={mailboxGroups}
          selectedId={mailbox?.id}
          onSelect={(id) => {
            const m = mailboxes.find((x) => x.id === id);
            if (m) {
              setMailbox(m);
              setView("list");
            }
          }}
          newLabel="New message"
          onNew={() => {
            if (currentIdentity) startCompose(newDraft({ identity: currentIdentity }));
          }}
          newDisabled={!currentIdentity}
        />

        <section class="flex min-h-0 min-w-0 grow flex-col self-stretch lg:flex-row" aria-label="Mail">
          {view !== "compose" ? (
            <div
              class={cx(
                "flex min-h-0 min-w-0 flex-col self-stretch",
                "w-full lg:w-96 lg:shrink-0 lg:border-r lg:border-gray-200 dark:lg:border-white/10",
                view === "thread" && "max-lg:hidden",
              )}
            >
              {foldersCollapsed ? (
                <CollectionBar
                  title="Mail"
                  storageKey="bm.cc.mail"
                  groups={mailboxGroups}
                  selectedId={mailbox?.id}
                  onSelect={(id) => {
                    const m = mailboxes.find((x) => x.id === id);
                    if (m) {
                      setMailbox(m);
                      setView("list");
                    }
                  }}
                  onExpand={() => toggleFolders(false)}
                  newLabel="New message"
                  onNew={() => {
                    if (currentIdentity) startCompose(newDraft({ identity: currentIdentity }));
                  }}
                  newDisabled={!currentIdentity}
                />
              ) : null}
              {!isEmptySpec(searchSpec) ? (
                <p class="border-b border-gray-100 px-4 py-2 text-xs text-gray-500 dark:border-white/10 dark:text-gray-400">
                  {describeSearchScope(spec)}{" "}
                  <a class="font-medium text-brand-600 hover:text-brand-500" href="/mail">
                    Clear
                  </a>
                </p>
              ) : null}

              <ThreadListView
                rows={rows}
                total={total}
                cursor={cursor}
                selected={selected}
                loading={loading}
                // Real href for cmd-click / copy-link / new tab (`?q=`/`?demo=`
                // survive; `?c=` carries the selected mailbox so a genuine hop
                // does not dump you back in Inbox). Primary click is in-page:
                // onOpen fetches the thread into ItemDetail without remounting.
                hrefFor={(row) => hrefWithParams("/mail", { thread: row.threadId, c: mailbox?.id })}
                // s25 T6 — swipe triage, mail only. The gesture REVEALS these;
                // a tap on one commits, and the toast that follows carries the
                // Undo. See the contract at the top of ThreadListView.
                swipeActions={swipeActions}
                onSwipeAction={(row, action) => void runSwipe(row, action)}
                onOpen={(row) => void openThread(row.threadId, row)}
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
                  // Same guard as the reload above, and for a sharper reason:
                  // paging starts long after the effect body returned, so a
                  // mailbox switch mid-page would otherwise append page 2 of the
                  // list you LEFT onto the list you are looking at. This path also
                  // had no `catch` at all — a failed page died as an unhandled
                  // rejection with nothing on screen to say so.
                  runListLoad(
                    () => store.loadMore(),
                    () => storeRef.current === store,
                    {
                      onResult: () => syncStore(store),
                      onError: (message) => notify(message),
                      onSettled: () => setLoading(false),
                    },
                  );
                }}
              />
            </div>
          ) : null}

          {view === "compose" && draft ? (
            <Composer
              draft={draft}
              identities={identities}
              client={client}
              accountId={accountId}
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
            <div class="flex min-h-0 min-w-0 grow flex-col">
              <MessageView
                detail={detail}
                client={client}
                accountId={accountId}
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
                    startCompose(buildReplyDraft(email, { identity: currentIdentity, replyAll: all }));
                  }
                }}
                onForward={(email) => {
                  if (currentIdentity) startCompose(buildForwardDraft(email, { identity: currentIdentity }));
                }}
                onBack={() => {
                  setView("list");
                  setDetail(undefined);
                }}
              />
            </div>
          ) : view === "thread" ? (
            // The pane used to be one line of text here, so opening a message
            // collapsed the whole column and then jumped when the thread
            // landed. The skeleton stands in the SHAPE of what is coming — a
            // subject, its meta line, a sender and a body — so the layout is
            // already correct when the content replaces it.
            <div class="thread-view thread-skeleton">
              {/* The header is REAL. Everything in it — the subject, the
                  message count — came from the row that was clicked, and we
                  had it before the click. Shimmering text we already hold is
                  theatre; only the body is genuinely in flight.

                  Back is here too, and deliberately: on a narrow screen the
                  message has replaced the list, so without it a slow fetch is
                  a trap with no way out. */}
              <header class="thread-header">
                <button
                  type="button"
                  class="back-button"
                  onClick={() => {
                    setView("list");
                    setDetail(undefined);
                    setPendingRow(undefined);
                  }}
                >
                  ← Back
                </button>
                {pendingRow ? (
                  <>
                    <h1>{pendingRow.subject}</h1>
                    <p class="thread-meta">
                      {pendingRow.loadedCount} message{pendingRow.loadedCount === 1 ? "" : "s"}
                    </p>
                  </>
                ) : (
                  // A cold `?thread=` deep link: no row was clicked, so we
                  // really do know nothing about it yet.
                  <>
                    <Skeleton variant="title" />
                    <Skeleton variant="meta" />
                  </>
                )}
              </header>
              <SkeletonRegion label="the message">
                <Skeleton variant="body" />
              </SkeletonRegion>
            </div>
          ) : (
            <div class="hidden min-h-0 min-w-0 grow items-start justify-center lg:flex">
              <EmptyState title="Select a conversation">Choose a message from the list to read it here.</EmptyState>
            </div>
          )}
        </section>
      </SurfaceFrame>

      {toast ? (
        // s25 T6 — the toast grew a verb. `role="status"` still announces the
        // sentence; the Undo beside it is a real button, so the recourse a
        // swipe promised is reachable by keyboard and screen reader and not
        // only by the thumb that caused it. Clicking anywhere dismisses, as
        // before — the Undo's own click bubbles here, which is what we want.
        <div class="toast" role="status" onClick={dismissToast}>
          <span>{toast}</span>
          {undoAction ? (
            <button type="button" class="toast-undo" onClick={() => undoAction.run()}>
              {undoAction.label}
            </button>
          ) : null}
        </div>
      ) : null}

      {helpOpen ? (
        <div class="help-overlay" role="dialog" aria-label="Keyboard shortcuts" onClick={() => setHelpOpen(false)}>
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
