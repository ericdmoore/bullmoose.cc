/** @jsxImportSource preact */
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { resolveClient, type ClientMode } from "../lib/app/client";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Session } from "../lib/jmap/types";
import { runSearch, type SearchResponse } from "../lib/search/fanout";
import { orderRealms, planSearch, type RealmCoverage, type SearchPlan } from "../lib/search/plan";
import { deriveScopeNote } from "../lib/search/scope";

// `/search` (s07 T6) — cross-realm search, honest about what it can reach.
//
// This file renders and decides nothing; the split is the one every other
// section keeps (`ContactsApp.tsx:66-70`): vitest runs in plain Node with no
// jsdom, so a rule living in a `.tsx` island is a rule with no test. Which
// realms to query, how coverage is declared, and what the scope note says all
// live in `lib/search/*` as pure functions with tests.
//
// Two deliberate shapes, both argued in the lib modules:
//
//  • **Search is SUBMITTED, not typed-into.** Two of the three realms answer
//    from a full scan (`lib/search/plan.ts`); search-as-you-type over a scan
//    is a UI that promises an index it does not have — the same call
//    `/contacts` made (`ContactsApp.tsx:75-78`).
//  • **The scope note renders before the first keystroke** (an empty-query
//    plan still declares coverage), and every unsearched realm gets a GROUP
//    with its reason, never an absent one — "files" missing from the page
//    would read as "no matches in files", which is false.

interface Props {
  /** Injected in tests; the screen resolves its own otherwise (invariant §6.1). */
  client?: JmapClient;
}

export default function SearchApp({ client: injected }: Props) {
  const [client, setClient] = useState<JmapClient | undefined>(injected);
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [mode, setMode] = useState<ClientMode>("live");
  const [modeReason, setModeReason] = useState<string | undefined>(undefined);
  const [fatal, setFatal] = useState<string | undefined>(undefined);

  const [input, setInput] = useState("");
  const [plan, setPlan] = useState<SearchPlan | undefined>(undefined);
  const [response, setResponse] = useState<SearchResponse | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // ── bootstrap ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let jmap = injected;
        if (!jmap) {
          const resolved = resolveClient();
          // Same door as every other section: no session → `/login`, never a
          // convincing sample index a stranger could mistake for their data.
          if (resolved.mode === "unauthenticated") {
            location.assign("/login");
            return;
          }
          if (resolved.mode === "demo") {
            // Demo-only, loaded on demand so the contacts + calendar fixtures
            // never reach a live bundle (`lib/search/demoSearch.ts`).
            const { installSearchDemo } = await import("../lib/search/demoSearch");
            installSearchDemo(resolved.demo.client);
          }
          if (!cancelled) {
            setMode(resolved.mode);
            setModeReason(resolved.mode === "demo" ? resolved.reason : undefined);
          }
          jmap = resolved.client;
        }
        const live = await jmap.session();
        if (cancelled) return;
        setClient(jmap);
        setSession(live);
        // Coverage exists before any query does — the scope note must not
        // wait for a search to say what a search would reach.
        setPlan(planSearch(live, ""));
      } catch (err) {
        if (!cancelled) setFatal(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [injected]);

  const run = useCallback(
    async (raw: string) => {
      if (!client || !session) return;
      const next = planSearch(session, raw);
      setPlan(next);
      if (next.query === "") {
        setResponse(undefined);
        return;
      }
      setBusy(true);
      try {
        setResponse(await runSearch(client, next));
      } catch (err) {
        setFatal(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [client, session],
  );

  // `?q=` makes a search deep-linkable (`/search?q=elk&demo=1`); run it once
  // the session is up. Read-only on purpose: writing the query BACK to the bar
  // would take a `history.replaceState`, and the whole app makes exactly one
  // history call, in `lib/app/client.ts` — `tokenInUrl.test.ts:81-87` scans
  // every island to keep it that way. Unlike `?token=` there is nothing secret
  // here to strip, but a second history writer is a precedent that test exists
  // to refuse.
  useEffect(() => {
    if (!client || !session) return;
    const q = new URLSearchParams(location.search).get("q") ?? "";
    if (q.trim() !== "") {
      setInput(q);
      void run(q);
    }
  }, [client, session, run]);

  const note = useMemo(() => (plan ? deriveScopeNote(plan) : undefined), [plan]);
  const groups = useMemo(() => (plan ? orderRealms(plan.coverage) : []), [plan]);

  if (fatal) {
    return (
      <div class="app">
        <div class="panel panel-alert">
          <h2>Search is unavailable</h2>
          <p>{fatal}</p>
        </div>
      </div>
    );
  }

  return (
    <div class="app">
      <header class="topbar">
        <form
          class="search"
          onSubmit={(ev) => {
            ev.preventDefault();
            void run(input);
          }}
        >
          <input
            type="search"
            value={input}
            placeholder="Search everything you own — mail, contacts, calendar"
            aria-describedby="search-scope"
            onInput={(ev) => setInput((ev.currentTarget as HTMLInputElement).value)}
          />
          <button type="submit" disabled={busy || !client}>
            Search
          </button>
        </form>
      </header>

      {/* The deliverable (s07 T6): coverage, declared — derived from the plan
          in `lib/search/scope.ts`, never restated here. */}
      {note ? (
        <p id="search-scope" class="search-scope">
          {/* `.scope-item`, not the shared `.scope-line` — that class is a
              full-width results row (webmail.css:282) and these are lines
              inside one note block. Styled in search.astro. */}
          <span class="scope-item">{note.searchedLine}</span>
          {note.notSearchedLines.map((line, i) => (
            <span key={line} class="scope-item">
              {i === 0 ? `not searched: ${line}` : line}
            </span>
          ))}
        </p>
      ) : null}

      {mode === "demo" ? (
        <p class="banner">Demo data — nothing here is real{modeReason ? ` (${modeReason})` : ""}.</p>
      ) : null}

      <div class="search-results">
        {busy ? <p class="muted">Searching…</p> : null}
        {!busy && !response ? (
          <p class="muted search-hint">
            Results appear per realm — the note above says what each realm can and cannot answer.
          </p>
        ) : null}
        {!busy && response
          ? groups.map((cov) => <RealmGroup key={cov.realm} coverage={cov} response={response} />)
          : null}
      </div>
    </div>
  );
}

function RealmGroup({ coverage, response }: { coverage: RealmCoverage; response: SearchResponse }) {
  // An unsearched realm still gets a group with its reason — `files` saying
  // "no search path yet" is the point; an empty gap would read as "no matches".
  if (!coverage.searched) {
    return (
      <section class="realm-group realm-off">
        <h2>
          {coverage.title} <span class="pill">not searched</span>
        </h2>
        <p class="muted">{coverage.reason ?? "not searched"}</p>
      </section>
    );
  }

  const outcome = response.outcomes.find((o) => o.realm === coverage.realm);
  const hits = outcome?.hits ?? [];
  return (
    <section class="realm-group">
      <h2>
        {coverage.title} <span class="pill">{coverage.tier}</span>
        {outcome && outcome.total > hits.length ? (
          <span class="muted realm-total">
            showing {hits.length} of {outcome.total}
          </span>
        ) : null}
      </h2>
      {outcome?.error ? (
        <p class="banner-warn realm-error">
          This realm's search failed — results below are missing, not empty: {outcome.error}
        </p>
      ) : null}
      {hits.length === 0 && !outcome?.error ? (
        <p class="muted">No matches in {coverage.title.toLowerCase()}.</p>
      ) : (
        <ul class="hit-list">
          {hits.map((h) => (
            <li key={h.id} class="hit-row">
              <span class="hit-title">{h.title}</span>
              {h.snippet ? <span class="hit-snippet">{h.snippet}</span> : null}
              {h.when ? <span class="hit-when muted">{h.when.slice(0, 10)}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
