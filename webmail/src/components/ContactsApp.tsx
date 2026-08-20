/** @jsxImportSource preact */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { resolveClient, type ClientMode } from "../lib/app/client";
import CollectionBar from "./CollectionBar";
import CollectionColumn, { useCollapsed } from "./CollectionColumn";
import { Button } from "./ui";
import type { CollectionGroup } from "../lib/shell/collections";
import { hrefWithParam, publishCollections, publishedHref, urlParam } from "../lib/shell/publish";
import {
  bookIdOf,
  bookScopeNote,
  contactsAccounts,
  defaultTargetBook,
  loadAddressBooks,
  mayWriteCard,
  writableBooks,
  type ContactsAccount,
} from "../lib/contacts/books";
import {
  CARD_PAGE_SIZE,
  CONTACT_SEARCH_COST_NOTE,
  CONTACT_SEARCH_SCOPE_NOTE,
  buildContactFilter,
  describeContactScope,
  displayName,
  firstEmail,
  firstOrganization,
  firstPhone,
  loadCard,
  loadCards,
  type ContactSearchSpec,
} from "../lib/contacts/cards";
import { contactsDemoClient } from "../lib/contacts/demo";
import {
  blankAddress,
  blankEntry,
  blankForm,
  cardCreateSpec,
  cardUpdatePatch,
  formProblems,
  readCardForm,
  type CardContext,
  type CardForm,
} from "../lib/contacts/form";
import {
  GROUP_SYNC_CAVEAT,
  addMemberPatch,
  addMembersPatch,
  describeGroupAdd,
  groupCreateSpec,
  isGroup,
  loadGroupMembers,
  loadGroupsContaining,
  memberUids,
  planGroupAdd,
  removeMemberPatch,
} from "../lib/contacts/groups";
import {
  DELETE_VERB,
  confirmDeleteCards,
  describeBatchOutcome,
  describeSelection,
  selectionTitle,
  headerCheck,
  retainSelected,
  toggleAll,
  toggleSelected,
  type HeaderCheck,
} from "../lib/contacts/selection";
import type { AddressBook, ContactCard } from "../lib/contacts/types";
import {
  createBook,
  createCard,
  destroyBook,
  destroyCard,
  destroyCards,
  describeSetError,
  renameBook,
  saveCardEdit,
  type BatchFailure,
  type CardWriteResult,
} from "../lib/contacts/write";
import { maxObjectsInSet } from "../lib/jmap/capabilities";
import { REALM_PICK_EVENT, publishRealmChrome, readRealmPick } from "../lib/shell/realmChrome";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Session } from "../lib/jmap/types";

// The contacts section (s07 T3, sVOL 022).
//
// This file renders and decides nothing. Every rule lives in `lib/contacts/*`
// as a pure function with tests — the split s03.C settled on and `AgentConsole.tsx:36-40`
// restates: vitest runs in plain Node with no jsdom, so a rule living in a
// `.tsx` island is a rule with no test. If you find yourself computing
// something here, it belongs there.
//
// Three things this screen does deliberately, all argued in the lib modules:
//
//  • **Search is SUBMITTED, not typed-into.** `ContactCard/query` is an
//    unindexed full scan (`lib/contacts/cards.ts` header), and search-as-you-
//    type over a full scan is a UI that promises an index it does not have.
//  • **Rights decide what is offered.** `myRights` per book and `isPersonal`
//    per account, never an assumption that this session owns what it can see.
//  • **Groups are cards.** There is no group sidebar pretending to be a
//    folder tree; a group is a row in the same list with a member panel.
//
// s34 adds a fourth, from a real 3,557-card address book:
//
//  • **Bulk is the point, and bulk is dangerous.** Selection state lives here
//    but every rule about it is `lib/contacts/selection.ts` (what "select
//    all" may mean over a paged list, what a delete prompt must say, why an
//    outcome is never "done"). Deleting N cards is one `ContactCard/set` per
//    chunk (`lib/contacts/write.ts`); adding N cards to a group is one
//    `/set update` of ONE object, because membership lives on the group's
//    card and speaks uid rather than id (`lib/contacts/groups.ts`).

type View = "detail" | "edit" | "new";

interface Props {
  /** Injected in tests; the screen resolves its own otherwise (invariant §6.1). */
  client?: JmapClient;
}

export default function ContactsApp({ client: injected }: Props) {
  const [client, setClient] = useState<JmapClient | undefined>(injected);
  const [mode, setMode] = useState<ClientMode>("live");
  const [modeReason, setModeReason] = useState<string | undefined>(undefined);
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [fatal, setFatal] = useState<string | undefined>(undefined);

  const [accounts, setAccounts] = useState<ContactsAccount[]>([]);
  const [accountId, setAccountId] = useState<string>("");
  const [books, setBooks] = useState<AddressBook[]>([]);
  // s25 T3/T4 — `?c=<bookId>` preselects the address book (the realm tray's
  // leaf-node links land here); the books effect below self-repairs to "All"
  // if the id turns out not to exist. Read once, in the initializer — the
  // island mounts after navigation, so location is settled (ShellNav's
  // `initialQ` pattern).
  const [bookId, setBookId] = useState<string>(() => urlParam("c") ?? "");
  const { collapsed: booksCollapsed, toggle: toggleBooks } = useCollapsed("bm.cc.contacts");

  const [cards, setCards] = useState<ContactCard[]>([]);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const pagerRef = useRef<HTMLButtonElement | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [spec, setSpec] = useState<ContactSearchSpec>({});

  // s25 T3 — `/contacts?card=<id>` is the row's REAL link (native back, deep-
  // linkable people); reading it here at mount is the other half. In-page
  // paths (a group's member list, post-save focus) still call setSelectedId —
  // the URL is the click path, the state is everything else's.
  const [selectedId, setSelectedId] = useState<string | undefined>(() => urlParam("card"));
  // s34 — the BULK selection, which is a different thing from `selectedId`:
  // that is "the card I am reading", this is "the cards I am about to act
  // on". Two names, because conflating them is how a bulk delete acquires an
  // extra victim.
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [card, setCard] = useState<ContactCard | undefined>(undefined);
  const [members, setMembers] = useState<ContactCard[]>([]);
  const [missingMembers, setMissingMembers] = useState<string[]>([]);
  const [memberOf, setMemberOf] = useState<ContactCard[]>([]);
  const [allGroups, setAllGroups] = useState<ContactCard[]>([]);

  const [view, setView] = useState<View>("detail");
  const [form, setForm] = useState<CardForm>(blankForm());
  const [formBook, setFormBook] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [toast, setToast] = useState<string | undefined>(undefined);
  const [booksOpen, setBooksOpen] = useState(false);
  /**
   * Bumped after every write and on every push notification. It is STATE and
   * not a ref on purpose: a ref would not re-run the effects that depend on
   * it, which is a bug that looks like a caching problem.
   */
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const account = accounts.find((a) => a.id === accountId);
  const canManageBooks = account?.isPersonal === true;
  const targetBooks = useMemo(() => writableBooks(books), [books]);
  // How many objects one `ContactCard/set` may carry. Read from the LIVE
  // session rather than assumed: over-batching is refused as a whole call,
  // which would turn a 3,000-card delete into zero deletes.
  const setLimit = useMemo(() => (session ? maxObjectsInSet(session) : undefined), [session]);

  // ── bootstrap ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let active = injected;
        if (!active) {
          const resolved = resolveClient();
          // No session → the door, never a convincing address book of people
          // who do not exist (../lib/app/client.ts:50-62).
          if (resolved.mode === "unauthenticated") {
            location.assign("/login");
            return;
          }
          active =
            resolved.mode === "demo" ? contactsDemoClient(resolved.demo.client, location.search) : resolved.client;
          if (!cancelled) {
            setMode(resolved.mode);
            setModeReason(resolved.reason);
          }
        }
        const live = await active.session();
        if (cancelled) return;
        // NOT `primaryAccountId()`: for a contacts-only grantee the primary is
        // "" and that call throws (books.ts header).
        const reachable = contactsAccounts(live);
        setClient(active);
        setSession(live);
        setAccounts(reachable);
        setAccountId(reachable[0]?.id ?? "");
      } catch (err) {
        if (!cancelled) setFatal(message(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [injected]);

  // ── books ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!client || !accountId) return;
    let cancelled = false;
    void loadAddressBooks(client, accountId)
      .then((list) => {
        if (cancelled) return;
        setBooks(list);
        setBookId((current) => (list.some((b) => b.id === current) ? current : ""));
      })
      .catch((err: unknown) => !cancelled && setToast(message(err)));
    return () => {
      cancelled = true;
    };
  }, [client, accountId, reloadKey]);

  // s25 T4 — publish the address books for the chrome's realm tray
  // (lib/shell/publish.ts): each book as a leaf whose `?c=` link preselects
  // it via the initializer above. No counts — AddressBook carries none, and
  // inventing one would cost a full scan per book (cards.ts).
  useEffect(() => {
    if (books.length === 0) return;
    publishCollections(
      "contacts",
      books.map((b) => ({ id: b.id, label: b.name, href: publishedHref("/contacts", b.id) })),
    );
  }, [books]);

  // s34 — the account picker, hung in the SHARED top bar beside the identity
  // chip instead of in this section's own header row (Eric's annotation,
  // 2026-08-20). The mechanism and the reasons are `lib/shell/realmChrome.ts`;
  // from here it is one publish. Still only when there is a genuine choice:
  // `isRenderableControl` drops a one-option control, and this publishes
  // `undefined` for it, so the two ends agree.
  useEffect(() => {
    if (accounts.length < 2) {
      publishRealmChrome(undefined);
      return;
    }
    publishRealmChrome({
      realm: "contacts",
      label: "Account",
      // "(shared)" carries over verbatim from the old <select>: which account
      // is not yours is the one thing this control must never blur.
      options: accounts.map((a) => ({ id: a.id, label: a.isPersonal ? a.name : `${a.name} (shared)` })),
      selectedId: accountId,
    });
    return () => publishRealmChrome(undefined);
  }, [accounts, accountId]);

  // …and the pick coming back. `switchAccount` is the same reset the old
  // in-page <select> did, plus the bulk selection: card ids do not span
  // accounts, so keeping them would arm a delete against another account's
  // rows.
  const switchAccount = useCallback((id: string) => {
    setAccountId(id);
    setSelectedId(undefined);
    setBookId("");
    setChecked(new Set());
  }, []);

  useEffect(() => {
    const onPick = (ev: Event) => {
      const id = readRealmPick(ev, "contacts");
      if (id !== undefined) switchAccount(id);
    };
    globalThis.addEventListener(REALM_PICK_EVENT, onPick);
    return () => globalThis.removeEventListener(REALM_PICK_EVENT, onPick);
  }, [switchAccount]);

  // ── the bulk selection's lifetime ───────────────────────────────────────
  //
  // A card id means "this card" — but a SELECTION means "these rows, in this
  // list, under this filter", and that second meaning expires the moment the
  // list is re-queried. Carrying ids across an address-book switch or a new
  // search leaves a Delete button armed against rows that are no longer on
  // screen, which is precisely the accident that has no undo. So: same
  // dependencies as `runQuery`, cleared outright rather than pruned.
  useEffect(() => {
    setChecked(new Set());
  }, [accountId, bookId, spec]);

  // ── every group in the account, for the join control ────────────────────
  // Cheap and bounded (`kind: "group"` narrows the same scan), and it has to
  // span address books: a person in one book may belong to a group in another.
  useEffect(() => {
    if (!client || !accountId) return;
    let cancelled = false;
    void loadCards(client, accountId, { filter: { kind: "group" }, limit: 100 })
      .then((page) => !cancelled && setAllGroups(page.cards))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, accountId, reloadKey]);

  // ── the list ────────────────────────────────────────────────────────────
  const runQuery = useCallback(
    async (from: number) => {
      if (!client || !accountId) return;
      setLoading(true);
      try {
        const page = await loadCards(client, accountId, {
          filter: buildContactFilter({ ...spec, ...(bookId ? { inBook: bookId } : {}) }),
          position: from,
          limit: CARD_PAGE_SIZE,
          // Once per query, not per page: the count is a second full scan
          // (cards.ts `LoadCardsOptions`).
          calculateTotal: from === 0,
        });
        setCards((prev) => (from === 0 ? page.cards : [...prev, ...page.cards]));
        if (from === 0) setTotal(page.total);
        setExhausted(page.cards.length < CARD_PAGE_SIZE);
      } catch (err) {
        setToast(message(err));
      } finally {
        setLoading(false);
      }
    },
    [client, accountId, bookId, spec],
  );

  useEffect(() => {
    void runQuery(0);
  }, [runQuery, reloadKey]);

  // Infinite scroll, as an observer over the pager button rather than a scroll
  // handler: the browser tells us when the control is actually visible, so there
  // is no listener firing on every frame and no arithmetic about heights.
  //
  // `rootMargin` fetches one screen early, so the next page is usually already
  // there by the time the names run out — the point of infinite scroll is that
  // the seam never shows.
  //
  // Guards: `loading` stops a second fetch while one is in flight (the observer
  // fires again the moment the button re-enters view), and `exhausted` unmounts
  // the button entirely, which disconnects this observer with it.
  useEffect(() => {
    const pager = pagerRef.current;
    if (!pager || exhausted || loading) return;
    if (typeof IntersectionObserver === "undefined") return; // no observer: the button still works
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void runQuery(cards.length);
      },
      { root: pager.closest(".card-list"), rootMargin: "400px" },
    );
    io.observe(pager);
    return () => io.disconnect();
  }, [runQuery, cards.length, exhausted, loading]);

  // ── the selected card ───────────────────────────────────────────────────
  useEffect(() => {
    if (!client || !accountId || !selectedId) {
      setCard(undefined);
      setMembers([]);
      setMissingMembers([]);
      setMemberOf([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const full = await loadCard(client, accountId, selectedId);
        if (cancelled) return;
        setCard(full);
        if (!full) return;
        const [group, containing] = await Promise.all([
          isGroup(full) ? loadGroupMembers(client, accountId, full) : { members: [], missing: [] },
          full.uid ? loadGroupsContaining(client, accountId, full.uid) : [],
        ]);
        if (cancelled) return;
        setMembers(group.members);
        setMissingMembers(group.missing);
        setMemberOf(containing);
      } catch (err) {
        if (!cancelled) setToast(message(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, accountId, selectedId, reloadKey]);

  // ── push sync: StateChange → re-query (never queryChanges) ──────────────
  useEffect(() => {
    if (!client || !accountId) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void client
      .watch(() => refresh(), { accountId })
      .then((off) => (cancelled ? off() : (stop = off)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [client, accountId, refresh]);

  // ── actions ─────────────────────────────────────────────────────────────

  const report = useCallback(
    (result: CardWriteResult, subject: AddressBook | ContactCard | null, ok: string): boolean => {
      if (result.refusal) {
        setToast(result.refusal.message);
        return false;
      }
      if (result.error) {
        setToast(describeSetError(result.error, subject));
        return false;
      }
      setToast(ok);
      return true;
    },
    [],
  );

  const startNew = useCallback(() => {
    setForm(blankForm());
    setFormBook(defaultTargetBook(books)?.id ?? "");
    setProblems([]);
    setSelectedId(undefined);
    setView("new");
  }, [books]);

  const startEdit = useCallback(() => {
    if (!card) return;
    setForm(readCardForm(card));
    setFormBook(bookIdOf(card.addressBookIds) ?? "");
    setProblems([]);
    setView("edit");
  }, [card]);

  const save = useCallback(async () => {
    if (!client || !accountId) return;
    const found = formProblems(form);
    setProblems(found);
    if (found.length > 0) return;
    setBusy(true);
    try {
      if (view === "new") {
        const result = await createCard(client, accountId, cardCreateSpec(form, formBook || undefined));
        if (report(result, null, "Contact created.") && result.id) {
          setSelectedId(result.id);
          setView("detail");
          refresh();
        }
        return;
      }
      if (!card) return;
      const patch = cardUpdatePatch(card, form);
      // The book is not part of the form's diff — it is JMAP membership, not
      // JSContact — so it rides along only when the user actually moved it.
      const currentBook = bookIdOf(card.addressBookIds);
      if (formBook && formBook !== currentBook) patch.addressBookIds = { [formBook]: true };
      if (Object.keys(patch).length === 0) {
        setView("detail");
        setToast("Nothing changed.");
        return;
      }
      const result = await saveCardEdit(client, accountId, card, patch);
      if (result.conflict) {
        setCard(result.conflict.current);
        setToast(
          `Someone else changed ${result.conflict.properties.join(", ")} while you were editing. ` +
            `Your version was not saved — the card below is the current one.`,
        );
        setView("detail");
        return;
      }
      if (report(result, card, "Saved.")) {
        setView("detail");
        refresh();
      }
    } catch (err) {
      setToast(message(err));
    } finally {
      setBusy(false);
    }
  }, [client, accountId, view, form, formBook, card, report, refresh]);

  const remove = useCallback(async () => {
    if (!client || !accountId || !card) return;
    setBusy(true);
    try {
      if (report(await destroyCard(client, accountId, card.id), card, "Contact deleted.")) {
        setSelectedId(undefined);
        refresh();
      }
    } finally {
      setBusy(false);
    }
  }, [client, accountId, card, report, refresh]);

  // ── bulk ────────────────────────────────────────────────────────────────
  //
  // Two verbs, and they are NOT the same shape of write — which is the whole
  // reason the bar reads `[Delete] [Add to group ▾]` and not one generic
  // "apply":
  //
  //   Delete — N cards destroyed. `ContactCard/set destroy` per chunk of
  //     `maxObjectsInSet`, final, confirmed with the exact count.
  //   Add to group — ONE card updated. Membership lives on the GROUP's card
  //     as a map of member UIDs (`groups.ts`), so 412 contacts joining a
  //     group is a single `/set update` of a single object and the 412 cards
  //     are never written at all. It is also additive and reversible, which
  //     is why it needs no confirmation where Delete does.
  //
  // What they DO share is the tail — `finishBulk` — because the dangerous
  // parts are the parts that are the same each time: say what happened in a
  // sentence that adds up, keep the failures selected so a retry needs no
  // re-picking, and re-query. A third bulk action is a plan, a write, and one
  // control in the bar; it is not another copy of this.

  /** id → a name a person recognises, for the outcome sentence. */
  const nameOfCard = useCallback(
    (id: string) => {
      const found = cards.find((c) => c.id === id);
      return found ? displayName(found) : id;
    },
    [cards],
  );

  const finishBulk = useCallback(
    (outcome: { done: readonly string[]; failed: readonly BatchFailure[] }, sentence: string) => {
      setToast(sentence);
      // Clear on success; on a PARTIAL failure keep exactly the ids that
      // failed, so a retry needs no re-picking and the bar keeps saying how
      // many are still outstanding.
      setChecked(
        outcome.failed.length === 0
          ? new Set()
          : retainSelected(
              checked,
              outcome.failed.map((f) => f.id),
            ),
      );
      refresh();
    },
    [checked, refresh],
  );

  const bulkDelete = useCallback(async () => {
    if (!client || !accountId) return;
    const ids = [...checked];
    if (ids.length === 0) return;
    // The confirmation states the EXACT count, and it is the only gate: there
    // is no trash for a contact, so "are you sure" has to carry the number
    // that distinguishes four rows from four thousand (selection.ts).
    if (!confirm(confirmDeleteCards(ids.length))) return;
    setBusy(true);
    try {
      const outcome = await destroyCards(client, accountId, ids, setLimit === undefined ? {} : { chunkSize: setLimit });
      // The open card may have been one of them.
      if (selectedId !== undefined && outcome.done.includes(selectedId)) setSelectedId(undefined);
      finishBulk(outcome, describeBatchOutcome(DELETE_VERB, outcome, nameOfCard));
    } catch (err) {
      setToast(message(err));
    } finally {
      setBusy(false);
    }
  }, [client, accountId, checked, selectedId, setLimit, finishBulk, nameOfCard]);

  /**
   * Add the selection to an existing group.
   *
   * `planGroupAdd` does the id → uid translation first and puts every selected
   * id in exactly one bucket — add, already-a-member, or refused-with-a-reason
   * — so nothing can go quietly missing between "I ticked it" and "it is in
   * the group". A card with no uid is the case that matters: uid is server-set
   * and immutable, so it cannot be minted here, and skipping it silently would
   * tell someone their contact is in a group when it is not.
   *
   * The write goes through `saveCardEdit` rather than a bare `updateCard`
   * because the empty-group patch shape rewrites the whole `members` object
   * (see `addMembersPatch`) and could otherwise clobber somebody else's first
   * add. A conflict means NOTHING was written, so the whole plan is reported
   * as failed rather than half-claimed.
   */
  const addSelectionToGroup = useCallback(
    async (group: ContactCard) => {
      if (!client || !accountId) return;
      const ids = [...checked];
      if (ids.length === 0) return;
      const plan = planGroupAdd(cards, ids, group);
      const name = displayName(group);
      setBusy(true);
      try {
        // Nothing new to write: everything selected is already a member, or
        // refused. Still reported — a no-op the user cannot see is a bug.
        if (plan.add.length === 0) {
          const outcome = { done: plan.already, failed: plan.refused };
          finishBulk(outcome, describeGroupAdd(name, { ...outcome, already: plan.already }, nameOfCard));
          return;
        }

        const result = await saveCardEdit(
          client,
          accountId,
          group,
          addMembersPatch(
            group,
            plan.add.map((a) => a.uid),
          ),
        );
        const failure = result.conflict
          ? `“${name}” changed while this selection was open, so nothing was added. Reload and try again.`
          : (result.refusal?.message ?? (result.error ? describeSetError(result.error, group) : undefined));

        const outcome =
          failure === undefined
            ? { done: [...plan.add.map((a) => a.id), ...plan.already], failed: plan.refused }
            : {
                done: plan.already,
                failed: [...plan.refused, ...plan.add.map((a) => ({ id: a.id, message: failure }))],
              };
        finishBulk(outcome, describeGroupAdd(name, { ...outcome, already: plan.already }, nameOfCard));
      } catch (err) {
        setToast(message(err));
      } finally {
        setBusy(false);
      }
    },
    [client, accountId, checked, cards, finishBulk, nameOfCard],
  );

  /**
   * "+ Create Group" — name it, make it, and put the selection in it, in one
   * `ContactCard/set create`. `groupCreateSpec` already takes the member uids,
   * so this is genuinely one call rather than create-then-add: a group that
   * exists for a moment with none of the members you asked for is a state
   * nobody needs to see.
   */
  const createGroupFromSelection = useCallback(async () => {
    if (!client || !accountId) return;
    const ids = [...checked];
    if (ids.length === 0) return;
    const name = prompt("Name for the new group")?.trim();
    if (!name) return;
    // A brand-new group has no members, so nothing can already be in it.
    const plan = planGroupAdd(cards, ids, {});
    setBusy(true);
    try {
      const result = await createCard(
        client,
        accountId,
        groupCreateSpec(
          name,
          plan.add.map((a) => a.uid),
          defaultTargetBook(books)?.id,
        ),
      );
      const failure = result.refusal?.message ?? (result.error ? describeSetError(result.error, null) : undefined);
      const outcome =
        failure === undefined
          ? { done: plan.add.map((a) => a.id), failed: plan.refused }
          : {
              done: [] as string[],
              failed: [...plan.refused, ...plan.add.map((a) => ({ id: a.id, message: failure }))],
            };
      // Open what was just made, so the group is visible rather than asserted.
      if (failure === undefined && result.id) setSelectedId(result.id);
      finishBulk(outcome, describeGroupAdd(name, { ...outcome, already: [] }, nameOfCard));
    } catch (err) {
      setToast(message(err));
    } finally {
      setBusy(false);
    }
  }, [client, accountId, checked, cards, books, finishBulk, nameOfCard]);

  const newGroup = useCallback(async () => {
    if (!client || !accountId) return;
    const name = prompt("Name for the new group")?.trim();
    if (!name) return;
    setBusy(true);
    try {
      const result = await createCard(client, accountId, groupCreateSpec(name, [], defaultTargetBook(books)?.id));
      if (report(result, null, `Group “${name}” created.`) && result.id) {
        setSelectedId(result.id);
        refresh();
      }
    } finally {
      setBusy(false);
    }
  }, [client, accountId, books, report, refresh]);

  /** Add or remove the SELECTED card from a group, by the card's uid. */
  const setMembership = useCallback(
    async (group: ContactCard, subject: ContactCard, join: boolean) => {
      if (!client || !accountId || !subject.uid) return;
      setBusy(true);
      try {
        const patch = join ? addMemberPatch(group, subject.uid) : removeMemberPatch(group, subject.uid);
        const result = await saveCardEdit(client, accountId, group, patch);
        if (result.conflict) {
          setToast("That group changed while you were looking at it — reloaded.");
        } else {
          report(result, group, join ? "Added to the group." : "Removed from the group.");
        }
        refresh();
      } finally {
        setBusy(false);
      }
    },
    [client, accountId, report, refresh],
  );

  const bookAction = useCallback(
    async (run: () => Promise<CardWriteResult>, subject: AddressBook | null, ok: string) => {
      setBusy(true);
      try {
        if (report(await run(), subject, ok)) refresh();
      } finally {
        setBusy(false);
      }
    },
    [report, refresh],
  );

  // ── render ──────────────────────────────────────────────────────────────

  if (fatal) {
    return (
      <main class="shell shell-error">
        <h1>Contacts are not reachable</h1>
        <p class="muted">{fatal}</p>
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

  if (accounts.length === 0) {
    return (
      <main class="shell">
        <h1>No contacts here</h1>
        {/* Not "you have no contacts" — this session reaches no account that
            advertises the contacts capability at all, which is a different
            thing and a different fix (session.ts:22-42). */}
        <p class="empty-means">
          This session reaches no account with contacts. A token scoped to mail only, or a grant that shares a mailbox
          but no address book, both land here — the contacts are not missing, they are out of reach.
        </p>
      </main>
    );
  }

  const scopeNote = account ? bookScopeNote(account, books) : undefined;
  const selectedBook = books.find((b) => b.id === bookId);
  const canWriteHere = targetBooks.length > 0;
  // "Select all" can only ever mean the rows that are LOADED — the list is
  // paged and the query is a full scan, so there is no honest way to select
  // 3,557 matches from a screen showing 50 (selection.ts).
  const visibleIds = useMemo(() => cards.map((c) => c.id), [cards]);
  const listCheck = headerCheck(visibleIds, checked);
  // The groups the bar may offer. Membership writes the GROUP's card, so the
  // rights that matter are its book's, not the selected contacts' — the same
  // rule the detail pane's join control follows (`books.ts mayWriteCard`).
  const joinableGroups = useMemo(() => allGroups.filter((g) => mayWriteCard(books, g)), [allGroups, books]);

  // s24 T2 — the CollectionColumn's feed: "All" + each address book, with the
  // rights/default annotation as the row's note (read-only wins — it changes
  // what you can DO; "default" is trivia by comparison).
  const bookGroups: CollectionGroup[] = useMemo(
    () => [
      {
        id: "books",
        label: "Address books",
        items: [
          { id: "", label: "All address books" },
          ...books.map((b) => ({
            id: b.id,
            label: b.name,
            note: !b.myRights.mayWrite ? "read-only" : b.isDefault ? "default" : undefined,
          })),
        ],
      },
    ],
    [books],
  );
  // s24 T5 — the contextual bar deep-links: /contacts?q=… (a plain GET from
  // the chrome). Submitted, never live — exactly the doctrine this file
  // already followed; the submission just happens in the chrome now.
  useEffect(() => {
    const q = new URLSearchParams(location.search).get("q")?.trim();
    if (q) setSpec({ text: q });
    const onSearch = (ev: Event) => {
      const next = String((ev as CustomEvent<{ q?: string }>).detail?.q ?? "").trim();
      setSpec(next ? { text: next } : {});
      setSelectedId(undefined);
    };
    globalThis.addEventListener("bm:search", onSearch);
    return () => globalThis.removeEventListener("bm:search", onSearch);
  }, []);

  const editingCard = view === "edit" || view === "new";

  return (
    <div class="app contacts">
      {/* s24 T5 — the search bar moved UP into the shared chrome (ShellNav);
          /contacts?q=… deep-links the same submitted search.
          s34 — and so did the ACCOUNT PICKER: it is published to ShellNav's
          header (see the realm-chrome effect above), which is what removed
          this section's own `<header class="topbar">` entirely. There was
          nothing else in it. */}

      {/* Search honesty, in the shape AppShell.tsx:599-602 established: what
          the server matches, next to the box, from the module that owns it. */}
      <p id="contact-scope" class="search-scope">
        {CONTACT_SEARCH_SCOPE_NOTE} {CONTACT_SEARCH_COST_NOTE}
      </p>

      {mode === "demo" ? (
        <p class="banner">Demo data — nobody here is real{modeReason ? ` (${modeReason})` : ""}.</p>
      ) : null}

      {scopeNote ? <p class="banner banner-warn">{scopeNote}</p> : null}

      <div class="body">
        <CollectionColumn
          title="Contacts"
          storageKey="bm.cc.contacts"
          collapseMode="bar"
          collapsed={booksCollapsed}
          onCollapsedChange={toggleBooks}
          groups={bookGroups}
          selectedId={bookId}
          onSelect={(id) => {
            setBookId(id);
            setSelectedId(undefined);
          }}
          newLabel="New contact"
          onNew={startNew}
          newDisabled={!canWriteHere}
          actions={
            <>
              <Button variant="ghost" size="sm" disabled={!canWriteHere} onClick={() => void newGroup()}>
                New group
              </Button>
              {!canWriteHere ? (
                <p class="muted contacts-hint">
                  No address book here is writable for this session, so nothing can be added.
                </p>
              ) : null}
            </>
          }
          footer={
            canManageBooks ? (
              <details class="attach" open={booksOpen} onToggle={() => setBooksOpen((v) => !v)}>
                <summary>Manage address books</summary>
                <div class="attach-body">
                  <button
                    disabled={busy}
                    onClick={() => {
                      const name = prompt("Name for the new address book")?.trim();
                      if (name && client) {
                        void bookAction(
                          () => createBook(client, accountId, name),
                          null,
                          `Address book “${name}” created.`,
                        );
                      }
                    }}
                  >
                    New address book
                  </button>
                  {selectedBook ? (
                    <>
                      <button
                        disabled={busy}
                        onClick={() => {
                          const name = prompt("Rename to", selectedBook.name)?.trim();
                          if (name && client) {
                            void bookAction(
                              () => renameBook(client, accountId, selectedBook.id, name),
                              selectedBook,
                              "Address book renamed.",
                            );
                          }
                        }}
                      >
                        Rename “{selectedBook.name}”
                      </button>
                      <button
                        class="danger"
                        disabled={busy || !selectedBook.myRights.mayDelete}
                        onClick={() => {
                          // The server refuses a non-empty book unless told twice
                          // (`addressBookHasContents`), which IS the confirmation
                          // step — so ask once, then obey the answer.
                          const withContents = confirm(
                            `Delete “${selectedBook.name}”?\n\n` +
                              "A contact lives in exactly one address book, so any contacts inside " +
                              "it are deleted too. Cancel to keep everything.",
                          );
                          if (withContents && client) {
                            void bookAction(
                              () => destroyBook(client, accountId, selectedBook.id, true),
                              selectedBook,
                              "Address book deleted.",
                            ).then(() => setBookId(""));
                          }
                        }}
                      >
                        Delete “{selectedBook.name}”
                      </button>
                    </>
                  ) : null}
                </div>
              </details>
            ) : undefined
          }
        />

        <main class="content">
          <p class="scope-line">
            {spec.text ? (
              <>
                <a class="link-button" href="/contacts">
                  Clear search
                </a>{" "}
              </>
            ) : null}
            {describeContactScope(spec, selectedBook?.name)}
            {typeof total === "number" ? ` ${total} match${total === 1 ? "" : "es"}.` : ""}
          </p>

          <div class="contacts-panes">
            <div class="card-col">
              {booksCollapsed ? (
                <CollectionBar
                  title="Contacts"
                  storageKey="bm.cc.contacts"
                  groups={bookGroups}
                  selectedId={bookId}
                  onSelect={(id) => {
                    setBookId(id);
                    setSelectedId(undefined);
                  }}
                  onExpand={() => toggleBooks(false)}
                  newLabel="New contact"
                  onNew={startNew}
                  newDisabled={!canWriteHere}
                />
              ) : null}
              <ListToolbar
                check={listCheck}
                loaded={cards.length}
                onToggleAll={() => setChecked((prev) => toggleAll(visibleIds, prev))}
              />

              {checked.size > 0 ? (
                <BulkBar
                  count={checked.size}
                  loaded={cards.length}
                  total={total}
                  busy={busy}
                  groups={joinableGroups}
                  canCreateGroup={canWriteHere}
                  onClear={() => setChecked(new Set())}
                  onDelete={() => void bulkDelete()}
                  onAddToGroup={(group) => void addSelectionToGroup(group)}
                  onCreateGroup={() => void createGroupFromSelection()}
                />
              ) : null}

              <ul class="card-list">
                {cards.map((c) => (
                  <li class={`card-item${checked.has(c.id) ? " is-checked" : ""}`} key={c.id}>
                    {/* The checkbox is a SIBLING of the anchor, never inside
                      it — interactive content may not nest in an <a>, and the
                      tap-vs-navigate hazard is the same one #200 solved for
                      swipe (`ThreadListView.tsx`: the select control sits
                      beside the row body either way). Ticking a row must not
                      navigate; opening a row must not tick it. */}
                    <input
                      type="checkbox"
                      class="card-check"
                      checked={checked.has(c.id)}
                      aria-label={`Select ${displayName(c)}`}
                      onChange={() => setChecked((prev) => toggleSelected(prev, c.id))}
                    />
                    {/* s25 T3 — a real link (`?q=`/`?demo=`/`?c=` survive via
                      hrefWithParam): the browser back button leaves the card
                      the native way, and every person is deep-linkable. The
                      `?card=` initializer above is where this lands. */}
                    <a
                      class={`card-row${c.id === selectedId ? " is-selected" : ""}`}
                      href={hrefWithParam("/contacts", "card", c.id)}
                      aria-current={c.id === selectedId ? "true" : undefined}
                    >
                      <span class="card-name">
                        {displayName(c)}
                        {isGroup(c) ? <span class="pill pill-on">group</span> : null}
                      </span>
                      <span class="card-sub muted">
                        {isGroup(c)
                          ? `${memberUids(c).length} member${memberUids(c).length === 1 ? "" : "s"}`
                          : (firstEmail(c) ?? firstPhone(c) ?? firstOrganization(c) ?? "")}
                      </span>
                    </a>
                  </li>
                ))}
                {cards.length === 0 && !loading ? (
                  <li class="empty-means">
                    {spec.text
                      ? `Nothing matched “${spec.text}” in the fields this search reaches.`
                      : "This address book has no contacts yet."}
                  </li>
                ) : null}
                {/* The pager lives INSIDE the scrolling list, as its last row: the
                  list is the scroll container, so a control outside it can never
                  be reached by scrolling to the bottom of the names. It is still a
                  real button — the observer below clicks it when it scrolls into
                  view, but keyboard and screen-reader users reach it the same way
                  they always could. Infinite scroll that is ONLY an observer
                  strands anyone who does not scroll with a mouse. */}
                {!exhausted ? (
                  <li class="card-pager">
                    <button
                      ref={pagerRef}
                      class="link-button"
                      disabled={loading}
                      onClick={() => void runQuery(cards.length)}
                    >
                      {loading ? "Loading…" : "Load more"}
                    </button>
                  </li>
                ) : null}
              </ul>
            </div>

            <section class="card-detail">
              {editingCard ? (
                <ContactForm
                  form={form}
                  books={targetBooks}
                  bookId={formBook}
                  problems={problems}
                  busy={busy}
                  isNew={view === "new"}
                  onChange={setForm}
                  onBook={setFormBook}
                  onSave={() => void save()}
                  onCancel={() => setView("detail")}
                />
              ) : card ? (
                <CardDetail
                  card={card}
                  books={books}
                  members={members}
                  missingMembers={missingMembers}
                  memberOf={memberOf}
                  joinable={allGroups.filter((g) => g.id !== card.id && !memberOf.some((m) => m.id === g.id))}
                  busy={busy}
                  onEdit={startEdit}
                  onDelete={() => void remove()}
                  onJoinGroup={(group) => void setMembership(group, card, true)}
                  onLeaveGroup={(group) => void setMembership(group, card, false)}
                  onOpen={(id) => {
                    setSelectedId(id);
                    setView("detail");
                  }}
                />
              ) : (
                <p class="muted">Select a contact.</p>
              )}
            </section>
          </div>
        </main>
      </div>

      {toast ? (
        <div class="toast" role="status" onClick={() => setToast(undefined)}>
          {toast}
        </div>
      ) : null}
    </div>
  );
}

// ── the list's own chrome ──────────────────────────────────────────────────

/**
 * The list header: select-all, and how many rows it is talking about.
 *
 * The indeterminate state is a DOM PROPERTY, not an attribute — there is no
 * `indeterminate=""` to render — so it is set through a ref callback. That
 * makes it invisible to server rendering, which is exactly why the three-way
 * state itself is `headerCheck()` in `lib/contacts/selection.ts` with its own
 * tests: the rule is testable even though this line of DOM is not.
 *
 * `aria-checked` deliberately absent: ARIA prohibits it on a native
 * checkbox, and the browser exposes `mixed` from the property on its own.
 */
function ListToolbar({ check, loaded, onToggleAll }: { check: HeaderCheck; loaded: number; onToggleAll: () => void }) {
  return (
    <div class="card-toolbar">
      <label class="card-select-all">
        <input
          type="checkbox"
          checked={check === "all"}
          disabled={loaded === 0}
          ref={(el) => {
            if (el) el.indeterminate = check === "some";
          }}
          onChange={onToggleAll}
        />
        <span class="muted">
          {check === "all" ? "Deselect all" : "Select all"}
          {loaded > 0 ? ` ${loaded.toLocaleString()} loaded` : ""}
        </span>
      </label>
    </div>
  );
}

/**
 * The bulk action bar — present only while something is selected.
 *
 * Eric's sketch: `[Delete] [Add to group ▾]`. Two controls, and the ▾ is a
 * popover rather than a `<select>` on purpose — arrowing a closed `<select>`
 * fires `change` per option in some browsers, and "+ Create Group" popping a
 * `prompt()` from an arrow key is not a control, it is an ambush. The popover
 * is the pattern `CollectionBar` already established here: click-outside,
 * Escape, and a real `role="menu"`.
 *
 * ## The label is the act: ADD, never move
 *
 * Group membership is many-to-many — a contact can be in five groups, and
 * leaving one is a separate act — so this control adds and only adds. It
 * never removes a contact from anything, which is why "Add to group" is the
 * whole of what it claims.
 *
 * A true move (remove from here, add to there) is a DIFFERENT, separately
 * named action, not a mode this one slips into. An "Add to group" that
 * sometimes silently removed would be worse than either verb alone, and this
 * list has no "from" anyway: it is scoped by address book, never by group
 * (`ContactSearchSpec.hasMember` exists and nothing sets it).
 *
 * ## The seam
 *
 * Eric's note says he is working on other bulk actions, so the shape is
 * additive: an action is (a) a plan that accounts for every selected id, (b)
 * one write, and (c) one control here. Anything DESTRUCTIVE goes through a
 * counted confirmation first; anything additive and reversible does not.
 *
 * Delete stays enabled even where a book is read-only: rights are per book and
 * a selection can span several, so the honest answer is to send it and report
 * per-id refusals rather than to grey out a button for a reason true of only
 * some of the rows.
 */
function BulkBar(props: {
  count: number;
  loaded: number;
  /** Match total when the query knows it — `title` only, never the label. */
  total?: number;
  busy: boolean;
  groups: ContactCard[];
  canCreateGroup: boolean;
  onClear: () => void;
  onDelete: () => void;
  onAddToGroup: (group: ContactCard) => void;
  onCreateGroup: () => void;
}) {
  return (
    <div class="bulk-bar" role="group" aria-label="Bulk actions">
      <span class="bulk-count" title={selectionTitle(props.count, props.loaded, props.total)}>
        {describeSelection(props.count, props.loaded)}
      </span>

      <button type="button" class="link-button" onClick={props.onClear}>
        Clear
      </button>

      <span class="bulk-spacer" />

      <button type="button" class="danger" disabled={props.busy} onClick={props.onDelete}>
        Delete
      </button>

      <GroupMenu
        groups={props.groups}
        busy={props.busy}
        canCreate={props.canCreateGroup}
        onAdd={props.onAddToGroup}
        onCreate={props.onCreateGroup}
      />
    </div>
  );
}

/**
 * The `[Add to group ▾]` menu: every group this session may write, then the
 * create door. Dismissed by click-outside or Escape — the `CollectionBar`
 * contract, because a popover that only closes on Escape strands anyone on a
 * phone, which has no Escape.
 *
 * A group with no writable book never appears: membership writes the GROUP's
 * card, so offering one would be offering a write the server then refuses.
 * An empty list says so rather than rendering an empty box — and "+ Create
 * Group" is still there, which is the actual next step from "no groups yet".
 */
function GroupMenu(props: {
  groups: ContactCard[];
  busy: boolean;
  canCreate: boolean;
  onAdd: (group: ContactCard) => void;
  onCreate: () => void;
  /** Test/SSR seam: the menu starts open. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div class="bulk-menu" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={props.busy}
        onClick={() => setOpen((v) => !v)}
      >
        Add to group <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div class="bulk-menu-popover" role="menu" aria-label="Add to group">
          {props.groups.length === 0 ? <p class="muted">No groups here yet.</p> : null}
          {props.groups.map((g) => (
            <button
              type="button"
              role="menuitem"
              key={g.id}
              onClick={() => {
                setOpen(false);
                props.onAdd(g);
              }}
            >
              <span class="bulk-menu-name">{displayName(g)}</span>
              <span class="muted">{memberUids(g).length}</span>
            </button>
          ))}
          {props.canCreate ? (
            <button
              type="button"
              role="menuitem"
              class="bulk-menu-create"
              onClick={() => {
                setOpen(false);
                props.onCreate();
              }}
            >
              + Create Group
            </button>
          ) : (
            <p class="muted">No address book here is writable, so no group can be created.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── the detail pane ────────────────────────────────────────────────────────

function CardDetail(props: {
  card: ContactCard;
  books: AddressBook[];
  members: ContactCard[];
  missingMembers: string[];
  memberOf: ContactCard[];
  /** Groups this card is NOT in — the ones the join control may offer. */
  joinable: ContactCard[];
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onJoinGroup: (group: ContactCard) => void;
  onLeaveGroup: (group: ContactCard) => void;
  onOpen: (id: string) => void;
}) {
  const { card, books, members, missingMembers, memberOf } = props;
  const book = books.find((b) => b.id === bookIdOf(card.addressBookIds));
  const mayWrite = mayWriteCard(books, card);
  const group = isGroup(card);
  // Membership writes the GROUP's card, so the rights that matter are the
  // group's book's — not this card's (books.ts `mayWriteCard`).
  const joinable = props.joinable.filter((g) => mayWriteCard(books, g));

  return (
    <article class="panel">
      <h2>
        {displayName(card)}
        {group ? <span class="pill pill-on">group</span> : null}
        {book ? <span class="pill">{book.name}</span> : null}
      </h2>

      {group ? (
        <section class="row">
          <h3>Members</h3>
          {members.length === 0 && missingMembers.length === 0 ? (
            <p class="muted">Nobody yet. Open a contact and add it from there.</p>
          ) : (
            <ul class="card-list">
              {members.map((m) => (
                <li>
                  <button class="card-row" onClick={() => props.onOpen(m.id)}>
                    <span class="card-name">{displayName(m)}</span>
                    <span class="card-sub muted">{firstEmail(m) ?? ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {missingMembers.length > 0 ? (
            // Reachable and worth surfacing: destroying a card leaves the
            // groups that name it untouched (groups.ts `loadGroupMembers`).
            <p class="muted">
              {missingMembers.length === 1
                ? "1 member no longer exists"
                : `${missingMembers.length} members no longer exist`}{" "}
              — the contact was deleted but the group still names it: <code>{missingMembers.join(", ")}</code>
            </p>
          ) : null}
          <p class="caveats">{GROUP_SYNC_CAVEAT}</p>
        </section>
      ) : (
        <>
          <Detail label="Organization" value={firstOrganization(card)} />
          <EntryList label="Email" card={card} map="emails" field="address" />
          <EntryList label="Phone" card={card} map="phones" field="number" />
          <AddressList card={card} />
          <EntryList label="Note" card={card} map="notes" field="note" />
        </>
      )}

      {group ? null : (
        <section class="row">
          <h3>In groups</h3>
          {memberOf.length === 0 ? <p class="muted">Not in any group.</p> : null}
          {memberOf.map((g) => (
            <span class="chip">
              <button class="link-button" onClick={() => props.onOpen(g.id)}>
                {displayName(g)}
              </button>
              {mayWriteCard(books, g) ? (
                <button
                  class="link-button"
                  disabled={props.busy}
                  title={`Remove ${displayName(card)} from ${displayName(g)}`}
                  onClick={() => props.onLeaveGroup(g)}
                >
                  ×
                </button>
              ) : null}
            </span>
          ))}
          {joinable.length > 0 && card.uid ? (
            <form
              class="join-group"
              onSubmit={(ev) => {
                ev.preventDefault();
                const id = (ev.currentTarget.elements.namedItem("group") as HTMLSelectElement).value;
                const target = joinable.find((g) => g.id === id);
                if (target) props.onJoinGroup(target);
              }}
            >
              <select name="group">
                {joinable.map((g) => (
                  <option value={g.id}>{displayName(g)}</option>
                ))}
              </select>
              <button type="submit" disabled={props.busy}>
                Add to group
              </button>
            </form>
          ) : null}
          {!card.uid ? (
            // Membership is keyed by uid (groups.ts); a card without one
            // cannot be named by a group at all.
            <p class="muted">This card has no uid, so no group can name it.</p>
          ) : null}
        </section>
      )}

      <div class="actions">
        <button disabled={!mayWrite || props.busy} onClick={props.onEdit}>
          Edit
        </button>
        <button class="danger" disabled={!mayWrite || props.busy} onClick={props.onDelete}>
          Delete
        </button>
      </div>
      {!mayWrite ? (
        <p class="muted">
          This address book is read-only for you, so editing is not offered
          {book ? "" : " — and its address book is not one this session can see"}.
        </p>
      ) : null}

      {/* s34 — the uid is an IDENTIFIER, not information. Full-length,
          `urn:bullmoose:vcf:95a430b…` was the longest line in the pane and
          the least readable thing on it. It stays, because CardDAV debugging
          runs on it (and because "some debugging depends on it" is a fact
          about this system, not a hypothetical) — but clamped to a stub, with
          the whole value on `title` and, since text-overflow is a rendering
          effect only, still selectable and copyable in full. */}
      <p class="caveats">
        Last updated {card.updated ? new Date(card.updated).toLocaleString() : "at an unknown time"}
        {card.uid ? (
          <>
            {" · "}
            <code class="card-urn" title={card.uid}>
              {card.uid}
            </code>
          </>
        ) : null}
      </p>
    </article>
  );
}

function Detail({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <p class="detail-line">
      <span class="muted">{label}</span> {value}
    </p>
  );
}

/** Render one keyed JSContact map without pretending it is a single value. */
function EntryList(props: { label: string; card: ContactCard; map: string; field: string }) {
  const raw = props.card[props.map];
  const entries =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? Object.entries(raw as Record<string, Record<string, unknown>>)
      : [];
  const rows = entries.filter(([, e]) => typeof e?.[props.field] === "string");
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map(([key, entry]) => (
        <p class="detail-line" key={key}>
          <span class="muted">
            {props.label}
            {contextLabel(entry)}
          </span>{" "}
          {String(entry[props.field])}
        </p>
      ))}
    </>
  );
}

function AddressList({ card }: { card: ContactCard }) {
  const raw = card.addresses;
  if (!raw || typeof raw !== "object") return null;
  return (
    <>
      {Object.entries(raw).map(([key, entry]) => {
        const parts = (Array.isArray(entry.components) ? entry.components : [])
          .filter((c: { value?: unknown }) => typeof c?.value === "string")
          .map((c: { value?: unknown }) => String(c.value));
        if (parts.length === 0) return null;
        return (
          <p class="detail-line" key={key}>
            <span class="muted">Address{contextLabel(entry)}</span> {parts.join(", ")}
          </p>
        );
      })}
    </>
  );
}

function contextLabel(entry: Record<string, unknown>): string {
  const contexts = entry.contexts;
  if (contexts === null || typeof contexts !== "object") return "";
  const keys = Object.entries(contexts as Record<string, unknown>)
    .filter(([, v]) => v === true)
    .map(([k]) => (k === "private" ? "home" : k));
  return keys.length > 0 ? ` (${keys.join(", ")})` : "";
}

// ── the editor ─────────────────────────────────────────────────────────────

function ContactForm(props: {
  form: CardForm;
  books: AddressBook[];
  bookId: string;
  problems: string[];
  busy: boolean;
  isNew: boolean;
  onChange: (form: CardForm) => void;
  onBook: (id: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { form, onChange } = props;
  const set = (patch: Partial<CardForm>): void => onChange({ ...form, ...patch });

  const rowSetter =
    (kind: "emails" | "phones") =>
    (index: number, patch: Partial<CardForm["emails"][number]>): void => {
      const rows = form[kind].map((row, i) => (i === index ? { ...row, ...patch } : row));
      set({ [kind]: rows } as Partial<CardForm>);
    };

  return (
    <form
      class="panel contact-form"
      onSubmit={(ev) => {
        ev.preventDefault();
        props.onSave();
      }}
    >
      <h2>{props.isNew ? "New contact" : "Edit contact"}</h2>

      {props.problems.length > 0 ? (
        <ul class="warnings">
          {props.problems.map((p) => (
            <li>{p}</li>
          ))}
        </ul>
      ) : null}

      <label>
        Display name
        <input value={form.full} onInput={(ev) => set({ full: value(ev) })} />
      </label>
      <div class="contact-form-pair">
        <label>
          First name
          <input value={form.given} onInput={(ev) => set({ given: value(ev) })} />
        </label>
        <label>
          Last name
          <input value={form.surname} onInput={(ev) => set({ surname: value(ev) })} />
        </label>
      </div>
      <label>
        Organization
        <input value={form.organization} onInput={(ev) => set({ organization: value(ev) })} />
      </label>

      <EntryRows
        label="Email"
        rows={form.emails}
        onRow={rowSetter("emails")}
        onAdd={() => set({ emails: [...form.emails, blankEntry()] })}
      />
      <EntryRows
        label="Phone"
        rows={form.phones}
        onRow={rowSetter("phones")}
        onAdd={() => set({ phones: [...form.phones, blankEntry()] })}
      />

      {form.addresses.map((address, index) => (
        <fieldset class="contact-form-address">
          <legend>Address</legend>
          {(
            [
              ["street", "Street"],
              ["locality", "City"],
              ["region", "Region"],
              ["postcode", "Postcode"],
              ["country", "Country"],
            ] as const
          ).map(([field, label]) => (
            <label>
              {label}
              <input
                value={address[field]}
                onInput={(ev) =>
                  set({
                    addresses: form.addresses.map((a, i) => (i === index ? { ...a, [field]: value(ev) } : a)),
                  })
                }
              />
            </label>
          ))}
        </fieldset>
      ))}
      <button type="button" class="link-button" onClick={() => set({ addresses: [...form.addresses, blankAddress()] })}>
        Add address
      </button>

      <label>
        Note
        <textarea value={form.note} onInput={(ev) => set({ note: value(ev) })} />
      </label>

      {props.books.length > 1 ? (
        <label>
          Address book
          <select value={props.bookId} onChange={(ev) => props.onBook((ev.currentTarget as HTMLSelectElement).value)}>
            {props.books.map((b) => (
              <option value={b.id}>{b.name}</option>
            ))}
          </select>
        </label>
      ) : null}

      {/* The honest note about what this editor will NOT touch. Everything
          else on the card survives untouched by construction (form.ts). */}
      <p class="caveats">
        Photos, birthdays and anything synced from another client that this form does not show are kept exactly as they
        are — an edit here only writes the fields above.
      </p>

      <div class="actions">
        <button type="submit" disabled={props.busy}>
          {props.busy ? "Saving…" : "Save"}
        </button>
        <button type="button" class="link-button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function EntryRows(props: {
  label: string;
  rows: CardForm["emails"];
  onRow: (index: number, patch: Partial<CardForm["emails"][number]>) => void;
  onAdd: () => void;
}) {
  return (
    <>
      {props.rows.map((row, index) => (
        <div class="contact-form-pair">
          <label>
            {props.label}
            <input value={row.value} onInput={(ev) => props.onRow(index, { value: value(ev) })} />
          </label>
          <label>
            Type
            <select
              value={row.context}
              onChange={(ev) =>
                props.onRow(index, {
                  context: (ev.currentTarget as HTMLSelectElement).value as CardContext,
                })
              }
            >
              <option value="">unspecified</option>
              <option value="private">home</option>
              <option value="work">work</option>
            </select>
          </label>
        </div>
      ))}
      <button type="button" class="link-button" onClick={props.onAdd}>
        Add {props.label.toLowerCase()}
      </button>
    </>
  );
}

function value(ev: Event): string {
  return (ev.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;
}

function message(err: unknown): string {
  return String(err instanceof Error ? err.message : err);
}
