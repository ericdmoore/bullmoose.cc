// The fan-out: run a `SearchPlan` against the injected `JmapClient` and come
// back with one envelope — per-realm hits AND the coverage declaration the
// plan made, carried together so no consumer can show results without the
// scope they came with (refinement 4: coverage is declared in the response,
// never implied by which endpoint answered).
//
// No second JMAP client (invariant §6.1): everything goes through the injected
// client's `queryThenGet`, and the calendar leg IS `searchEvents`
// (`../calendar/api.ts:159`) rather than a re-implementation — the page and
// `/calendar` must not disagree about what an event search does. A future MCP
// `search` tool runs this same module with its own client; that is the seam.
//
// Realms fail ALONE. One realm's refusal (missing method, revoked scope,
// server error) becomes that realm's `error` string while the others still
// answer — a contacts outage must not blank mail hits, and an error that
// silently vanished a realm would read as "no matches", which is false.
//
// Hits are NOT merged into one ranked list. Relevance is only comparable
// within a realm (mail is ranked by an FTS index, contacts and calendar by
// nothing at all — `plan.ts`), so a unified ranking would be an invented
// number. Realms render as groups in `orderRealms` tier order; within a realm
// the server's own sort stands: mail newest first, contacts by name, events by
// start descending.

import { searchEvents } from "../calendar/api";
import type { CalendarEvent } from "../calendar/types";
import { displayName, firstEmail, firstOrganization, firstPhone } from "../contacts/cards";
import type { ContactCard } from "../contacts/types";
import type { JmapClient } from "../jmap/JmapClient";
import type { Email } from "../mail/types";
import type { CoverageGap, RealmCoverage, SearchableRealm, SearchPlan } from "./plan";

/**
 * Per-realm page size. Small on purpose: two of the three realms answer from
 * a full scan (`plan.ts`), and a deep pager over a scan is a UI promising an
 * index that does not exist — the same reasoning as `CARD_PAGE_SIZE`
 * (`../contacts/cards.ts:162`). `total` says what was matched beyond it.
 */
export const PER_REALM_LIMIT = 25;

/** One row, whatever the realm — the realm tag keeps provenance visible. */
export interface SearchHit {
  realm: SearchableRealm;
  id: string;
  title: string;
  snippet: string;
  /** ISO-ish timestamp where the realm has one (mail receivedAt, event start). */
  when?: string;
}

export interface RealmOutcome {
  realm: SearchableRealm;
  hits: SearchHit[];
  /** The server's `calculateTotal` — hits beyond `PER_REALM_LIMIT` exist. */
  total: number;
  /** This realm's query failed; the outcome stands for the failure, not for
   *  "no matches". */
  error?: string;
}

/** The response envelope — results and their own coverage, inseparable. */
export interface SearchResponse {
  query: string;
  outcomes: RealmOutcome[];
  coverage: RealmCoverage[];
  gaps: CoverageGap[];
  sharedAccountsExcluded: number;
}

export async function runSearch(client: JmapClient, plan: SearchPlan): Promise<SearchResponse> {
  // Group the planned queries by realm (a realm may span several owned
  // accounts) and run the realms concurrently — the whole point of a fan-out.
  const byRealm = new Map<SearchableRealm, string[]>();
  for (const q of plan.queries) {
    byRealm.set(q.realm, [...(byRealm.get(q.realm) ?? []), q.accountId]);
  }

  const outcomes = await Promise.all(
    [...byRealm.entries()].map(([realm, accountIds]) =>
      realmOutcome(client, realm, accountIds, plan.query),
    ),
  );

  return {
    query: plan.query,
    outcomes,
    coverage: plan.coverage,
    gaps: plan.gaps,
    sharedAccountsExcluded: plan.sharedAccountsExcluded,
  };
}

async function realmOutcome(
  client: JmapClient,
  realm: SearchableRealm,
  accountIds: string[],
  text: string,
): Promise<RealmOutcome> {
  const hits: SearchHit[] = [];
  let total = 0;
  try {
    // Accounts in planner order (primary first); their hits concatenate in
    // that order rather than interleaving — provenance over false precision.
    for (const accountId of accountIds) {
      const page =
        realm === "mail"
          ? await mailPage(client, accountId, text)
          : realm === "contacts"
            ? await contactsPage(client, accountId, text)
            : await calendarPage(client, accountId, text);
      hits.push(...page.hits);
      total += page.total;
    }
    return { realm, hits, total };
  } catch (err) {
    // Partial results from an earlier account are kept — they happened.
    return { realm, hits, total, error: err instanceof Error ? err.message : String(err) };
  }
}

interface RealmPage {
  hits: SearchHit[];
  total: number;
}

// ── the three legs ────────────────────────────────────────────────────────

/** `Email/query {text}` — the FTS5 leg (`../mail/search.ts`). */
async function mailPage(client: JmapClient, accountId: string, text: string): Promise<RealmPage> {
  const { query, get } = await client.queryThenGet(
    accountId,
    "Email/query",
    {
      filter: { text },
      sort: [{ property: "receivedAt", isAscending: false }],
      limit: PER_REALM_LIMIT,
      calculateTotal: true,
    },
    "Email/get",
    // The row needs no bodies: `preview` is the server-computed snippet.
    ["id", "subject", "from", "receivedAt", "preview"],
  );
  const list = (get as { list?: Email[] }).list ?? [];
  return { hits: list.map(emailHit), total: totalOf(query, list.length) };
}

/** `ContactCard/query {text}` — a full-scan leg (`../contacts/cards.ts`). */
async function contactsPage(
  client: JmapClient,
  accountId: string,
  text: string,
): Promise<RealmPage> {
  const { query, get } = await client.queryThenGet(
    accountId,
    "ContactCard/query",
    { filter: { text }, limit: PER_REALM_LIMIT, calculateTotal: true },
    "ContactCard/get",
  );
  const list = (get as { list?: ContactCard[] }).list ?? [];
  return { hits: list.map(cardHit), total: totalOf(query, list.length) };
}

/** `CalendarEvent/query {text}` — the other full-scan leg, via the SAME
 *  `searchEvents` the calendar screen uses. */
async function calendarPage(
  client: JmapClient,
  accountId: string,
  text: string,
): Promise<RealmPage> {
  const { events, total } = await searchEvents(client, accountId, text, PER_REALM_LIMIT);
  return { hits: events.map(eventHit), total };
}

// ── hit shaping (exported for tests — the merge is these plus concat) ─────

export function emailHit(email: Email): SearchHit {
  const from = email.from?.[0];
  const sender = from ? from.name || from.email : "";
  return {
    realm: "mail",
    id: email.id,
    title: email.subject || "(no subject)",
    snippet: [sender, clip(email.preview ?? "")].filter((s) => s !== "").join(" — "),
    when: email.receivedAt,
  };
}

export function cardHit(card: ContactCard): SearchHit {
  return {
    realm: "contacts",
    id: card.id,
    title: displayName(card),
    snippet: [firstEmail(card), firstOrganization(card) ?? firstPhone(card)]
      .filter((s): s is string => s !== undefined)
      .join(" · "),
  };
}

export function eventHit(event: CalendarEvent): SearchHit {
  return {
    realm: "calendar",
    id: event.id,
    title: event.title || "(untitled event)",
    snippet: clip(event.description ?? ""),
    // A LOCAL wall clock in the event's own zone (`../calendar/types.ts:72`),
    // not an instant — fine for a result row's date, wrong for arithmetic.
    ...(event.start ? { when: event.start } : {}),
  };
}

function totalOf(query: Record<string, unknown>, fallback: number): number {
  const total = (query as { total?: number }).total;
  return typeof total === "number" ? total : fallback;
}

function clip(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
