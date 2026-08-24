/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import { resolveClient } from "../lib/app/client";
import { loadActivity } from "../lib/activity/api";
import {
  FAN_IN_NOTE,
  WATCHES_UNAVAILABLE_NOTE,
  activityCollections,
  activityGate,
  filterFeed,
  orderFeed,
} from "../lib/activity/feed";
import type { ActivityItem } from "../lib/activity/types";
import { accountLabel, approvalsAccounts } from "../lib/approvals/rows";
import { hrefWithParam, urlParam } from "../lib/shell/publish";
import { DecidedDetail, FeedRow, WatchDetail } from "./ActivityRows";
import CollectionColumn from "./CollectionColumn";
import { publishGroups } from "../lib/shell/publishGroups";
import { Alert, Column, EmptyState, PageNotice, StackedList, SurfaceFrame } from "./ui";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Session } from "../lib/jmap/types";
import { syncDetailUrl } from "../lib/ui/navigation";

// The Activity feed (s23 v1) — the retrospective twin of `/approvals`.
// Approvals asks *what needs me?*; this answers *what was decided without me,
// and on whose authority?* The Decided group deliberately LEFT the approvals
// queue in s24 T4 ("the active UI shows what is LIVE; history is a realm, not
// a section") — this island is where it went.
//
// Deliberately THIN, the split every island here follows: vitest runs in
// plain Node with no jsdom, so every rule lives in `lib/activity/*` as tested
// pure functions — the fetch in `api.ts`, ordering/grouping/wording in
// `feed.ts`, the item model in `types.ts` — and the stateless detail markup
// in `ActivityRows.tsx`, render-tested. This file is state plumbing and
// composition; if a decision appears in it, it is in the wrong file.
//
// Read-only BY DESIGN (the sprint doc's anti-star stance): no verbs, no
// "mark as reviewed", no filing. If a row needs attention it is a proposal in
// /approvals, not a chore in a log.

interface Props {
  /** Injected in tests; the screen resolves its own otherwise. */
  client?: JmapClient;
  /** Fixes the "ago" labels for a deterministic render. */
  now?: number;
}

export default function ActivityApp({ client: injectedClient, now: fixedNow }: Props) {
  const [client, setClient] = useState<JmapClient | undefined>(injectedClient);
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [isDemo, setIsDemo] = useState(false);
  const [fatal, setFatal] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const [items, setItems] = useState<ActivityItem[]>([]);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [watchesUnavailable, setWatchesUnavailable] = useState(false);
  const [collection, setCollection] = useState<string>("all");
  // s25 T3 — `/activity?a=<id>` deep-links a record: read once at mount (the
  // MPA detail-URL pattern every surface follows now), self-repaired below
  // once the feed arrives. The rows MINT that link as well now that they are
  // real anchors — until they were, the param could only ever be typed.
  const [selectedId, setSelectedId] = useState<string | undefined>(() => urlParam("a"));

  // A retrospective does not need a ticking clock: "3h ago" moving to "3h 1m
  // ago" helps nobody decide anything. One `now`, taken at mount.
  const [now] = useState<number>(() => fixedNow ?? Date.now());

  // ── bootstrap ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let jmap = injectedClient;
        if (!jmap) {
          const resolved = resolveClient();
          // Same rule as every other section: no session → the door, never a
          // convincing sample history a stranger could mistake for theirs.
          if (resolved.mode === "unauthenticated") {
            location.assign("/login");
            return;
          }
          if (resolved.mode === "demo") {
            // Demo-only and loaded on demand, so the fixtures and the fake
            // Watch handlers never reach a live bundle.
            const { installActivityDemo } = await import("../lib/activity/demoActivity");
            installActivityDemo(resolved.demo.client);
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

  const gate = activityGate(session);
  // The SAME account roster as the queue (s10 T7, `approvalsAccounts`): what
  // was decided in your name spans every account you can reach — yours, plus
  // each agent account a supervisory grant opens. Reused, not re-derived.
  const accounts = useMemo(() => (session ? approvalsAccounts(session) : []), [session]);
  const accountKey = accounts.map((a) => a.accountId).join(",");

  // ── the feed ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!client || accounts.length === 0 || gate.state !== "open") return;
    let cancelled = false;
    setLoading(true);
    void loadActivity(
      client,
      accounts.map((a) => a.accountId),
    )
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setFailures(res.failures);
        setWatchesUnavailable(res.watchesUnavailable);
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

  const ordered = useMemo(() => orderFeed(items), [items]);
  const activeList = useMemo(() => filterFeed(ordered, collection), [ordered, collection]);
  const groups = useMemo(() => activityCollections(ordered), [ordered]);

  // s25 T4 (#226): the tray renders leaf-nodes only for realms that
  // publish. One line, off the SAME array the column renders, so the
  // two can never disagree about what this realm's collections are.
  useEffect(() => publishGroups("activity", "/activity", groups), [groups]);

  const selected = activeList.find((i) => i.id === selectedId) ?? activeList[0];
  /** The row's detail URL — `/activity?a=<id>`, current query preserved. */
  const itemHref = (id: string): string => hrefWithParam("/activity", "a", id);
  // Keep a valid selection as the feed or the collection changes under us —
  // the same self-repair the approvals master-detail does. Not while
  // loading: repairing against the momentary empty feed would wipe a
  // deep-linked `?a=` (s25 T3) before the record it names arrives.
  useEffect(() => {
    if (loading) return;
    if (activeList.length === 0) {
      if (selectedId !== undefined) setSelectedId(undefined);
      return;
    }
    if (!activeList.some((i) => i.id === selectedId)) setSelectedId(activeList[0]!.id);
  }, [activeList, selectedId, loading]);

  // ── shells ──────────────────────────────────────────────────────────────
  // `div`, not `main`: AppTw.astro owns the page's one <main>.
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
      <PageNotice title="Activity is not available">
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
          Sample data. This record is generated in this browser tab and reaches no server.
        </Alert>
      ) : null}

      {accounts.length > 1 ? (
        <p class="shrink-0 px-4 pb-2 text-xs text-gray-500 dark:text-gray-400">
          Across {accounts.length} accounts: {accounts.map((a) => a.name).join(", ")}. {FAN_IN_NOTE}
        </p>
      ) : null}
      {watchesUnavailable ? (
        <Alert tone="warn" class="mx-4 mb-2 shrink-0">
          {WATCHES_UNAVAILABLE_NOTE}
        </Alert>
      ) : null}

      {Object.entries(failures).map(([id, why]) => (
        <Alert key={id} tone="error" class="mx-4 mb-2 shrink-0">
          {accountLabel(accounts, id)}: {why}
        </Alert>
      ))}

      <SurfaceFrame>
        <CollectionColumn
          title="Activity"
          storageKey="bm.cc.activity"
          groups={groups}
          selectedId={collection}
          onSelect={setCollection}
        />

        <Column
          aria-label="Activity"
          class="w-full shrink-0 border-gray-200 max-lg:border-b lg:w-96 lg:border-r dark:border-white/10"
        >
          {loading ? <p class="px-4 py-3 text-sm text-gray-500">Reading the record…</p> : null}
          {!loading && ordered.length === 0 ? (
            <EmptyState title="Nothing on the record yet">
              No proposal has been decided and no watch has fired. When something is, it lands here.
            </EmptyState>
          ) : null}
          {!loading && ordered.length > 0 && activeList.length === 0 ? (
            <EmptyState title="Nothing in this view">Try another collection.</EmptyState>
          ) : null}
          <StackedList>
            {activeList.map((item) => (
              <FeedRow
                key={item.id}
                item={item}
                now={now}
                active={item.id === selected?.id}
                label={accounts.length > 1 ? accountLabel(accounts, item.accountId) : ""}
                href={itemHref(item.id)}
                onSelect={() => {
                  setSelectedId(item.id);
                  // Keep the address bar on the record being read, so the link
                  // you would copy is the one you are looking at.
                  syncDetailUrl(itemHref(item.id));
                }}
              />
            ))}
          </StackedList>
        </Column>

        <Column aria-label="Detail" class="min-w-0 grow">
          {selected ? (
            selected.type === "decided" ? (
              <DecidedDetail
                key={selected.id}
                item={selected}
                now={now}
                label={accounts.length > 1 ? accountLabel(accounts, selected.accountId) : ""}
              />
            ) : (
              <WatchDetail key={selected.id} item={selected} now={now} />
            )
          ) : null}
        </Column>
      </SurfaceFrame>
    </div>
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
