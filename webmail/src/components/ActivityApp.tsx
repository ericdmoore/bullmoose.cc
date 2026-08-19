/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import { resolveClient } from "../lib/app/client";
import { loadActivity } from "../lib/activity/api";
import {
  ACTIVITY_SUB,
  FAN_IN_NOTE,
  WATCHES_UNAVAILABLE_NOTE,
  activityCollections,
  activityGate,
  filterFeed,
  orderFeed,
} from "../lib/activity/feed";
import type { ActivityItem } from "../lib/activity/types";
import { accountLabel, approvalsAccounts } from "../lib/approvals/rows";
import { urlParam } from "../lib/shell/publish";
import { DecidedDetail, FeedRow, WatchDetail } from "./ActivityRows";
import CollectionColumn from "./CollectionColumn";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Session } from "../lib/jmap/types";

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
  // once the feed arrives. The rows themselves keep their in-page selection.
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

  const selected = activeList.find((i) => i.id === selectedId) ?? activeList[0];
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
      <div class="shell shell-error">
        <h1>Activity</h1>
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
        <h1>Activity</h1>
        <p class="muted">{gate.reason}</p>
        <p class="muted">
          <a href="/mail">← back to mail</a>
        </p>
      </div>
    );
  }

  return (
    <div class="act">
      {isDemo ? (
        <p class="banner">Sample data. This record is generated in this browser tab and reaches no server.</p>
      ) : null}

      <header class="act-head">
        <h1>Activity</h1>
        <p class="muted act-sub">{ACTIVITY_SUB}</p>
        {accounts.length > 1 ? (
          <p class="muted act-fine">
            Across {accounts.length} accounts: {accounts.map((a) => a.name).join(", ")}. {FAN_IN_NOTE}
          </p>
        ) : null}
        {watchesUnavailable ? <p class="muted act-fine">{WATCHES_UNAVAILABLE_NOTE}</p> : null}
      </header>

      {/* One account failing must not take the record down, and must not
          vanish either — a partial history that presents as complete is the
          exact failure this section exists to end. */}
      {Object.entries(failures).map(([id, why]) => (
        <p key={id} class="act-error" role="alert">
          {accountLabel(accounts, id)}: {why}
        </p>
      ))}

      {loading ? <p class="muted act-pad">Reading the record…</p> : null}

      {!loading && ordered.length === 0 ? (
        <p class="muted act-pad">
          Nothing on the record yet — no proposal has been decided and no watch has fired. When something is, it lands
          here.
        </p>
      ) : null}

      {ordered.length > 0 ? (
        <div class="act-panes grid grid-cols-1 lg:grid-cols-[auto_24rem_1fr]">
          {/* COLUMN 2 — the collections (v1: All / Decided / Watches fired;
              by-agent and by-date pickers are v2). No [New] button: nothing
              is ever created here — the record is generated, not filed. */}
          <CollectionColumn
            title="Activity"
            storageKey="bm.cc.activity"
            groups={groups}
            selectedId={collection}
            onSelect={setCollection}
          />

          {/* COLUMN 3 — the feed, newest first. */}
          <nav aria-label="Activity" class="act-pane">
            <ul role="list" class="space-y-0.5">
              {activeList.map((item) => (
                <FeedRow
                  key={item.id}
                  item={item}
                  now={now}
                  active={item.id === selected?.id}
                  label={accounts.length > 1 ? accountLabel(accounts, item.accountId) : ""}
                  onSelect={() => setSelectedId(item.id)}
                />
              ))}
            </ul>
            {activeList.length === 0 ? <p class="muted act-pad">Nothing in this view.</p> : null}
          </nav>

          {/* COLUMN 4 — the selected record, read-only. */}
          <section aria-label="Detail" class="act-pane min-w-0">
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
          </section>
        </div>
      ) : null}
    </div>
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
