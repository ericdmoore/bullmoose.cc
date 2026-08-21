/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import { resolveClient } from "../lib/app/client";
import { correctDueAt, decide, loadQueues, type Verdict } from "../lib/approvals/api";
import { isNearExpiry, orderQueue, rowClocks, waitedLabel } from "../lib/approvals/clocks";
import { applyEdit, type EditorForm } from "../lib/approvals/edit";
import {
  accountLabel,
  approvalsAccounts,
  approvalsGate,
  costLabel,
  summarizeProposal,
  tierLabel,
  type ApprovalsAccount,
} from "../lib/approvals/rows";
import type { ActionProposal } from "../lib/approvals/types";
import CollectionBar from "./CollectionBar";
import CollectionColumn, { useCollapsed } from "./CollectionColumn";
import CollectionSheet, { CollectionSheetButton } from "./CollectionSheet";
import type { CollectionGroup } from "../lib/shell/collections";
import { hrefWithParam, publishCollections, publishedHref, urlParam } from "../lib/shell/publish";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Session } from "../lib/jmap/types";
import {
  Alert,
  Badge,
  Column,
  EmptyState,
  PageNotice,
  Skeleton,
  SkeletonRegion,
  StackedList,
  StackedRow,
  StatusDot,
  SurfaceFrame,
} from "./ui";
import { ChevronRightIcon } from "./icons";
import { cx, type BadgeTone } from "../lib/ui/classes";
import { syncDetailUrl } from "../lib/ui/navigation";
import { HeldRow, HistoryRow, InfoRequestedRow, PendingRow, type Panel } from "./ApprovalsDetail";

// The approval queue (s07 T4) — the cross-agent review surface, and the
// section the nav leads with because deciding is what you arrive to do.
//
// Deliberately THIN, the split every island here follows (SettingsPanel.tsx:33,
// CalendarView.tsx): vitest runs in plain Node with no jsdom, so every rule
// lives in `lib/approvals/*` as a tested pure function — the two-clock
// arithmetic and the queue order in `clocks.ts`, the retained-diff edit
// contract in `edit.ts`, tier/verb/gate wording in `rows.ts`, the JMAP calls
// in `api.ts`. This file is state plumbing and markup; if a decision appears
// in it, it is in the wrong file.

interface Props {
  /** Injected in tests; the screen resolves its own otherwise. */
  client?: JmapClient;
  /** Fixes the clocks for a deterministic render; live ticking otherwise. */
  now?: number;
}

export default function ApprovalsQueue({ client: injectedClient, now: fixedNow }: Props) {
  const [client, setClient] = useState<JmapClient | undefined>(injectedClient);
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [isDemo, setIsDemo] = useState(false);
  const [fatal, setFatal] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const [proposals, setProposals] = useState<ActionProposal[]>([]);
  /** Per-account state strings — the `ifInState` guard on every decision. One
   *  per account, because the queue spans several and a state from account A
   *  would fail (or worse, pass) against account B (s10 T7). */
  const [states, setStates] = useState<Record<string, string>>({});
  /** accountId → why its queue is missing. Shown, never swallowed. */
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [panel, setPanel] = useState<Panel | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  // Both clocks tick off ONE `now`, once a second — often enough that
  // "waited for grows, expires in shrinks" is something you can watch.
  const [now, setNow] = useState<number>(() => fixedNow ?? Date.now());
  useEffect(() => {
    if (fixedNow !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [fixedNow]);

  // ── bootstrap ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let jmap = injectedClient;
        if (!jmap) {
          const resolved = resolveClient();
          // Same rule as every other section: no session → the door, never a
          // convincing sample queue a stranger could mistake for theirs
          // (lib/app/client.ts).
          if (resolved.mode === "unauthenticated") {
            location.assign("/login");
            return;
          }
          if (resolved.mode === "demo") {
            // Demo-only and loaded on demand, so the fixtures and the fake
            // `/set` never reach a live bundle (the demoCalendar.ts pattern).
            const { demoApprovalsOptions, installApprovalsDemo } = await import("../lib/approvals/demoApprovals");
            installApprovalsDemo(resolved.demo.client, demoApprovalsOptions(location.search));
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

  const gate = approvalsGate(session);
  // EVERY account the human can reach, not just the session's default (s10
  // T7): an agent is its own principal, so its proposals live on its own
  // account and reach it only through the supervisory grant provisioning
  // mints. `accountKey` keeps the effect from re-firing on an equal array.
  const accounts = useMemo(() => (session ? approvalsAccounts(session) : []), [session]);
  const accountKey = accounts.map((a) => a.accountId).join(",");

  // ── the queue ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!client || accounts.length === 0 || gate.state !== "open") return;
    let cancelled = false;
    setLoading(true);
    void loadQueues(
      client,
      accounts.map((a) => a.accountId),
    )
      .then((res) => {
        if (cancelled) return;
        setProposals(res.proposals);
        setStates(res.states);
        setFailures(res.failures);
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
  }, [client, accountKey, gate.state]);

  const ordered = useMemo(() => orderQueue(proposals), [proposals]);
  const pending = ordered.filter((p) => p.status === "pending");
  const infoRequested = ordered.filter((p) => p.status === "info-requested");
  const held = ordered.filter((p) => p.status === "held");

  // Master-detail (triple panel, s07 T10 / Eric 2026-08-15): the rail is the
  // shell, this island owns the middle "headers" column and the right detail.
  // `ordered` already sorts pending-first with the near-due at the top, so the
  // first item is the one most wanting a decision — the right default focus.
  //
  // s25 T3 — `/approvals?p=<id>` (the HeaderGroup rows' REAL links) lands
  // here: read once, in the initializer, and the self-repair below keeps it
  // only while the proposal is actually in the active list.
  const [selectedId, setSelectedId] = useState<string | undefined>(() => urlParam("p"));

  // s24 T4 — the Collection column: the LIVE lifecycle (Decided is dropped —
  // history bloats a decision queue; the retrospective is Activity's realm,
  // s23) plus the first saved view. The header column shows ONE collection's
  // rows, chosen here — or by `?c=` (s25 T4: the realm tray's leaf-nodes
  // link straight to a lifecycle state), validated against the known ids so
  // a mistyped link degrades to the default rather than an empty screen.
  const [collection, setCollection] = useState(() => {
    const c = urlParam("c");
    return c !== undefined && ["pending", "info", "held", "due-soon"].includes(c) ? c : "pending";
  });
  const { collapsed: queuesCollapsed, toggle: toggleQueues } = useCollapsed("bm.cc.approvals");
  const dueSoon = useMemo(() => pending.filter((p) => isNearExpiry(rowClocks(p, now))), [pending, now]);
  const collections: CollectionGroup[] = useMemo(
    () => [
      {
        id: "lifecycle",
        label: "Queue",
        items: [
          { id: "pending", label: "Waiting on you", count: pending.length },
          { id: "info", label: "Waiting on the agent", count: infoRequested.length },
          { id: "held", label: "Hold tray", count: held.length },
        ],
      },
      {
        id: "views",
        label: "Views",
        items: [{ id: "due-soon", label: "Due soon", count: dueSoon.length }],
      },
    ],
    [pending.length, infoRequested.length, held.length, dueSoon.length],
  );
  const activeList =
    collection === "info"
      ? infoRequested
      : collection === "held"
        ? held
        : collection === "due-soon"
          ? dueSoon
          : pending;
  const collectionLabel =
    collection === "info"
      ? "Waiting on the agent"
      : collection === "held"
        ? "Hold tray"
        : collection === "due-soon"
          ? "Due soon"
          : "Waiting on you";

  // s25 T2 — the collection sheet: below lg the CollectionColumn is hidden
  // and the list title above summons the SAME tree as a bottom sheet (a
  // picker, not a screen — zero stack depth).
  const [sheetOpen, setSheetOpen] = useState(false);

  const selected = activeList.find((p) => p.id === selectedId) ?? activeList[0];
  // Keep a valid selection as the queue changes under us (a decided row leaves,
  // a new proposal arrives, the human switches collections) without yanking
  // focus off something the human is mid-decision on. Not while loading:
  // before the queue arrives the list is empty for a moment, and repairing
  // against that emptiness would wipe a deep-linked `?p=` (s25 T3) on mount.
  useEffect(() => {
    if (loading) return;
    if (activeList.length === 0) {
      if (selectedId !== undefined) setSelectedId(undefined);
      return;
    }
    if (!activeList.some((p) => p.id === selectedId)) setSelectedId(activeList[0]!.id);
  }, [activeList, selectedId, loading]);

  // s25 T4 — publish the LIVE lifecycle states for the chrome's realm tray
  // (lib/shell/publish.ts): the three queues with their counts, each `?c=`
  // link landing on the initializer above. Republished as counts move, so
  // "Approvals ▸ Waiting on you 3" in the tray is the queue's own number.
  useEffect(() => {
    if (loading || gate.state !== "open") return;
    publishCollections("approvals", [
      { id: "pending", label: "Waiting on you", count: pending.length, href: publishedHref("/approvals", "pending") },
      {
        id: "info",
        label: "Waiting on the agent",
        count: infoRequested.length,
        href: publishedHref("/approvals", "info"),
      },
      { id: "held", label: "Hold tray", count: held.length, href: publishedHref("/approvals", "held") },
    ]);
  }, [loading, gate.state, pending.length, infoRequested.length, held.length]);

  async function reload(): Promise<void> {
    if (!client || accounts.length === 0) return;
    const res = await loadQueues(
      client,
      accounts.map((a) => a.accountId),
    );
    setProposals(res.proposals);
    setStates(res.states);
    setFailures(res.failures);
  }

  async function act(id: string, verdict: Verdict): Promise<void> {
    if (!client || busyId) return;
    const p = proposals.find((row) => row.id === id);
    if (!p) return;
    setBusyId(id);
    setRowErrors((prev) => ({ ...prev, [id]: "" }));
    // The proposal's OWN account — never the session default. A decision sent
    // to the wrong account is a `notFound` at best (s10 T7).
    const outcome = await decide(client, p.accountId, id, verdict, {
      ...(states[p.accountId] ? { ifInState: states[p.accountId] as string } : {}),
    });
    if (!outcome.ok) {
      // The server's sentence, verbatim — the tier-3 capability refusal in
      // particular should read as the wall it is, not as a generic failure.
      setRowErrors((prev) => ({ ...prev, [id]: outcome.message }));
      // A stateMismatch means the queue moved under us; re-read either way so
      // the next attempt runs against the real state.
      await reload().catch(() => undefined);
      setBusyId(undefined);
      return;
    }
    setPanel(undefined);
    await reload().catch((err) => setFatal(message(err)));
    setBusyId(undefined);
  }

  // The due-date CORRECTION (s11 T1) — deliberately not a verdict, so it does
  // not go through act(): the row stays pending, only the third clock moves.
  async function correctDue(id: string, dueAt: string | null): Promise<void> {
    if (!client || busyId) return;
    const p = proposals.find((row) => row.id === id);
    if (!p) return;
    setBusyId(id);
    setRowErrors((prev) => ({ ...prev, [id]: "" }));
    const outcome = await correctDueAt(client, p.accountId, id, dueAt, {
      ...(states[p.accountId] ? { ifInState: states[p.accountId] as string } : {}),
    });
    if (!outcome.ok) {
      setRowErrors((prev) => ({ ...prev, [id]: outcome.message }));
      await reload().catch(() => undefined);
      setBusyId(undefined);
      return;
    }
    setPanel(undefined);
    await reload().catch((err) => setFatal(message(err)));
    setBusyId(undefined);
  }

  function submitEdit(p: ActionProposal, form: EditorForm): void {
    const { editedPayload, problem } = applyEdit(p.payload, form);
    if (problem) {
      setRowErrors((prev) => ({ ...prev, [p.id]: problem }));
      return;
    }
    // No changes → a clean approve: `editedPayload` is deliberately absent so
    // the row does not masquerade as "approved after edit" (edit.ts).
    void act(p.id, { status: "approved", ...(editedPayload ? { editedPayload } : {}) });
  }

  // ── shells ──────────────────────────────────────────────────────────────
  // These are `div`, not `main`: AppTw.astro already renders the page's one
  // `<main>` around the slot, so an island that renders its own nests a
  // landmark inside a landmark — invalid HTML, and two "main" regions for a
  // screen reader to choose between. The island owns the CONTENT; the layout
  // owns the frame. (Every other island still does this — see the note in
  // AppTw.astro.)
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
  // The plain-client floor (arch.md §8.6): capability absent → an explanation,
  // not an error and not a dead region.
  if (gate.state !== "open") {
    return (
      <PageNotice title="Approvals are not available">
        <p>{gate.reason}</p>
        <p class="mt-2">
          <a href="/mail" class="font-medium text-brand-600 hover:text-brand-500">
            Back to mail
          </a>
        </p>
      </PageNotice>
    );
  }

  return (
    <div class="flex h-full min-h-0 w-full flex-col">
      {isDemo ? (
        <Alert tone="info" class="m-4 shrink-0">
          Sample data. Decisions here are kept in this browser tab and reach no server.
        </Alert>
      ) : null}

      {accounts.length > 1 ? (
        <p class="shrink-0 px-4 pb-2 text-xs text-gray-500 dark:text-gray-400">
          Across {accounts.length} accounts: {accounts.map((a) => a.name).join(", ")}.
        </p>
      ) : null}

      {Object.entries(failures).map(([id, why]) => (
        <Alert key={id} tone="error" class="mx-4 mb-2 shrink-0">
          {accountLabel(accounts, id)}: {why}
        </Alert>
      ))}

      <SurfaceFrame>
        <CollectionColumn
          title="Approvals"
          storageKey="bm.cc.approvals"
          collapseMode="bar"
          collapsed={queuesCollapsed}
          onCollapsedChange={toggleQueues}
          groups={collections}
          selectedId={collection}
          onSelect={setCollection}
          narrow="hidden"
        />

        <Column
          aria-label="Proposals"
          class="w-full shrink-0 border-gray-200 max-lg:border-b lg:w-80 lg:border-r dark:border-white/10"
          header={
            <>
              {queuesCollapsed ? (
                <CollectionBar
                  title="Approvals"
                  storageKey="bm.cc.approvals"
                  groups={collections}
                  selectedId={collection}
                  onSelect={setCollection}
                  onExpand={() => toggleQueues(false)}
                  class="max-lg:hidden"
                />
              ) : null}
              <div class={cx("px-2 pt-3 pb-1", queuesCollapsed && "lg:hidden")}>
                <CollectionSheetButton label={collectionLabel} open={sheetOpen} onOpen={() => setSheetOpen(true)} />
              </div>
            </>
          }
        >
          {loading ? (
            <SkeletonRegion label="the queue" class="px-4 py-3">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} variant="row" />
              ))}
            </SkeletonRegion>
          ) : null}
          {!loading && activeList.length === 0 ? (
            <EmptyState title="Nothing here right now">
              {collection === "pending" ? "Nothing is waiting on you." : "This view is empty."}
            </EmptyState>
          ) : null}
          <HeaderGroup
            label={collectionLabel}
            tone={collection === "pending" || collection === "due-soon" ? "primary" : undefined}
            items={activeList}
            now={now}
            accounts={accounts}
            selectedId={selected?.id}
            hrefFor={(id) => hrefWithParam("/approvals", "p", id)}
            onSelect={setSelectedId}
          />
        </Column>

        <Column aria-label="Detail" class="min-w-0 grow">
          {selected ? (
            selected.status === "pending" ? (
              <PendingRow
                key={selected.id}
                p={selected}
                account={accounts.find((a) => a.accountId === selected.accountId)}
                showAccount={accounts.length > 1}
                now={now}
                busy={busyId === selected.id}
                error={rowErrors[selected.id]}
                panel={panel && panel.id === selected.id ? panel : undefined}
                setPanel={setPanel}
                onApprove={() => void act(selected.id, { status: "approved" })}
                onDecline={(reason, note) =>
                  void act(selected.id, { status: "rejected", reason, ...(note ? { note } : {}) })
                }
                onNeedsInfo={(question) => void act(selected.id, { status: "info-requested", question })}
                onSubmitEdit={(form) => submitEdit(selected, form)}
                onCorrectDue={(dueAt) => void correctDue(selected.id, dueAt)}
              />
            ) : selected.status === "info-requested" ? (
              <InfoRequestedRow
                p={selected}
                label={accounts.length > 1 ? accountLabel(accounts, selected.accountId) : ""}
              />
            ) : selected.status === "held" ? (
              <HeldRow
                p={selected}
                now={now}
                label={accounts.length > 1 ? accountLabel(accounts, selected.accountId) : ""}
              />
            ) : (
              <HistoryRow
                p={selected}
                now={now}
                label={accounts.length > 1 ? accountLabel(accounts, selected.accountId) : ""}
              />
            )
          ) : !loading ? (
            <EmptyState title="Nothing is waiting on you">
              Pick a collection, or wait — new proposals land here.
            </EmptyState>
          ) : null}
        </Column>
      </SurfaceFrame>

      <CollectionSheet
        title="Approvals"
        storageKey="bm.cc.approvals"
        groups={collections}
        selectedId={collection}
        onSelect={setCollection}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
      />
    </div>
  );
}

/**
 * One group in the header column (s07 T10). Compact, selectable rows — sender/
 * summary, a tier chip, and how long it has waited — under a small heading so
 * "waiting on you" reads apart from "decided". Renders nothing when empty, so
 * the column shows only the states that actually have items.
 *
 * The rows are REAL `<a href>`s built by `hrefFor`, so every proposal is
 * deep-linkable and cmd-clickable.
 *
 * s25 T3 stopped there, and that made an ordinary click a FULL PAGE RELOAD —
 * the whole app torn down and rebuilt to move a selection in the pane beside
 * the list. `onSelect` is the other half: the plain click stays in the page
 * and every modified click still belongs to the browser
 * (`lib/ui/navigation` explains why each modifier matters). `syncDetailUrl`
 * keeps the address bar on the proposal being read, via `replaceState` — so
 * tokenInUrl.test.ts's one-call invariant is untouched.
 */
function HeaderGroup(props: {
  label: string;
  items: ActionProposal[];
  now: number;
  accounts: ApprovalsAccount[];
  selectedId: string | undefined;
  /** The row's detail URL — `/approvals?p=<id>`, current query preserved. */
  hrefFor: (id: string) => string;
  /** Open in-page. Passed ALONGSIDE `hrefFor`, never instead of it. */
  onSelect: (id: string) => void;
  tone?: "primary";
  muted?: boolean;
}) {
  const { label, items, now, accounts, selectedId, hrefFor, onSelect, tone, muted } = props;
  if (items.length === 0) return null;
  return (
    <div>
      <h2
        class={
          "px-4 pb-1 text-xs font-semibold tracking-wide uppercase max-lg:hidden " +
          (muted ? "text-gray-400" : "text-gray-500 dark:text-gray-400")
        }
      >
        {label} <span class="ml-1 font-normal text-gray-400">{items.length}</span>
      </h2>
      <StackedList>
        {items.map((p) => {
          const active = p.id === selectedId;
          const waited = waitedLabel(p, rowClocks(p, now));
          const urgent = isNearExpiry(rowClocks(p, now));
          return (
            <StackedRow
              key={p.id}
              href={hrefFor(p.id)}
              onSelect={() => {
                onSelect(p.id);
                syncDetailUrl(hrefFor(p.id));
              }}
              active={active}
            >
              <StatusDot tone={urgent ? "error" : tone === "primary" ? "warn" : "neutral"} />
              <div class="min-w-0 flex-auto">
                <p
                  class={
                    "line-clamp-2 text-sm/6 font-semibold " +
                    (muted ? "text-gray-500" : "text-gray-900 dark:text-white")
                  }
                >
                  {summarizeProposal(p)}
                </p>
                <div class="mt-1 flex flex-wrap items-center gap-x-2 text-xs/5 text-gray-500 dark:text-gray-400">
                  {accounts.length > 1 ? <span class="truncate">{accountLabel(accounts, p.accountId)}</span> : null}
                  {waited ? <span class="truncate">{waited}</span> : null}
                  {p.costMicros ? <span>{costLabel({ costMicros: p.costMicros, costModel: null })}</span> : null}
                </div>
              </div>
              <Badge tone={tierTone(p.tier)}>{tierLabel(p.tier)}</Badge>
              <ChevronRightIcon class="size-5 flex-none text-gray-400" />
            </StackedRow>
          );
        })}
      </StackedList>
    </div>
  );
}

function tierTone(tier: number): BadgeTone {
  if (tier >= 3) return "error";
  if (tier === 2) return "warn";
  return "accent";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
