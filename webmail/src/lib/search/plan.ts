// The cross-realm query planner (s07 T6): which realms this session can fan a
// query out to, and — the part that is the deliverable — a COVERAGE DECLARATION
// saying which realms are indexed, which are scanned, and which cannot be
// searched at all.
//
// ⚠️ Coverage is DECLARED in the plan and carried on the response envelope,
// never implied by which methods were called (s07 devPlan, refinement 4). The
// realms are not equally searchable, and shipping a search box that hides that
// would repeat the bug `.feedback common/004` fixed — a scope claim that was
// quietly false. Today's truth, per realm:
//
//   mail       `Email/query {text}` — FTS5-backed since common/004
//              (`packages/mailstore/src/index.ts`, `ftsMatchQuery`); indexed,
//              whole-word, bodies included (`../mail/search.ts:60-65`)
//   contacts   `ContactCard/query {text}` — full-scan `LIKE`
//              (`queryContactCards`, mailstore:1715-1760); does not scale
//   calendar   `CalendarEvent/query {text}` — full-scan `LIKE`
//              (`queryCalendarEvents`, mailstore:2273-2284); does not scale
//   files      no search path exists at all — no method, no index, nothing
//
// `REALMS` below is that table as data. When contacts and calendar get the
// FTS5 treatment mail got, or when the premium attachment-extraction index
// ships (refinement 4's tier), the DATA changes and every consumer's scope
// note follows — the API shape does not. That is the constraint that makes
// the free/premium tiering workable: the premium tier is an index, not a
// different API.
//
// This module is pure on purpose: the MCP surface today has three separate
// query tools (`email_query`, `contacts_search`, `calendar_query_events`,
// `services/agent/src/mcp.ts`), and the plan's endgame is one MCP `search`
// tool sharing this planner with the page. Nothing here touches a client or
// the DOM, so a Worker can import it as-is.
//
// Decision 4 (s07 devPlan): `/search` does NOT search other people's shared
// realms. Cross-account search is a permissions surface of its own, so the
// planner only ever emits queries against accounts this session OWNS
// (`isPersonal`) — grant-reached accounts are counted and declared as
// excluded rather than silently skipped.

import { CALENDARS_CAP, CONTACTS_CAP, MAIL_CAP, hasCapability } from "../jmap/capabilities";
import type { Session } from "../jmap/types";

export type RealmId = "mail" | "contacts" | "calendar" | "files";

/** The realms a query is actually sent to — `files` has nowhere to send one. */
export type SearchableRealm = Exclude<RealmId, "files">;

/**
 * The index tier behind a realm's `text` filter. This is the tier boundary
 * refinement 4 says the scope note must make visible: `indexed` is the free
 * FTS5 tier, `scanned` is a full-table `LIKE`, `none` is no search path.
 */
export type CoverageTier = "indexed" | "scanned" | "none";

interface RealmInfo {
  realm: RealmId;
  /** Section heading on the page ("Mail", …). */
  title: string;
  /** What of the realm the query reaches, as the scope note phrases it. */
  label: string;
  tier: CoverageTier;
  /** The capability that gates the realm; `files` gates on nothing because
   *  there is nothing to call even when the capability is present. */
  capability?: string;
}

/** Today's searchability table — the one place to edit when a tier changes. */
export const REALMS: readonly RealmInfo[] = [
  { realm: "mail", title: "Mail", label: "mail bodies", tier: "indexed", capability: MAIL_CAP },
  { realm: "contacts", title: "Contacts", label: "contacts", tier: "scanned", capability: CONTACTS_CAP },
  { realm: "calendar", title: "Calendar", label: "calendar", tier: "scanned", capability: CALENDARS_CAP },
  { realm: "files", title: "Files", label: "files", tier: "none" },
];

export function realmInfo(realm: RealmId): RealmInfo {
  // The table is total over RealmId, so the lookup cannot miss.
  return REALMS.find((r) => r.realm === realm) as RealmInfo;
}

/** One realm's entry in the response's coverage declaration. */
export interface RealmCoverage {
  realm: RealmId;
  title: string;
  label: string;
  tier: CoverageTier;
  /** Will this plan send a query there? */
  searched: boolean;
  /** Why not, when `searched` is false — rendered, not implied. */
  reason?: string;
}

/**
 * A named absence that is not a realm: content no tier reaches today. The one
 * standing entry is attachment text — refinement 4's premium extraction index,
 * which is future work this module NAMES rather than builds. When that index
 * ships, the gap moves into `REALMS`-style data and the note changes itself.
 */
export interface CoverageGap {
  label: string;
  reason: string;
}

export const ATTACHMENT_GAP: CoverageGap = {
  label: "attachment contents",
  reason: "requires the extraction index",
};

/** One `text` query to send: a searchable realm in an account this session owns. */
export interface PlannedQuery {
  realm: SearchableRealm;
  accountId: string;
}

export interface SearchPlan {
  /** Trimmed free text. Empty ⇒ `queries` is empty and nothing runs. */
  query: string;
  queries: PlannedQuery[];
  coverage: RealmCoverage[];
  gaps: CoverageGap[];
  /** Grant-reached accounts deliberately not searched (decision 4). */
  sharedAccountsExcluded: number;
}

/**
 * Plan a cross-realm search for this session.
 *
 * Per realm: query every OWNED account advertising the realm's capability
 * (primary first, so a multi-account session ranks its main mailbox's hits
 * first). A realm with no owned account is declared unsearched with the
 * honest reason — "no access" and "shared-only access" are different facts
 * and the coverage says which one holds.
 */
export function planSearch(session: Session, rawQuery: string): SearchPlan {
  const query = rawQuery.trim();
  const queries: PlannedQuery[] = [];
  const coverage: RealmCoverage[] = [];

  for (const info of REALMS) {
    if (info.tier === "none" || info.capability === undefined) {
      coverage.push(entry(info, false, "no search path yet"));
      continue;
    }
    const owned = ownedAccounts(session, info.capability);
    if (owned.length > 0) {
      for (const accountId of owned) {
        queries.push({ realm: info.realm as SearchableRealm, accountId });
      }
      coverage.push(entry(info, true));
    } else if (accountsWith(session, info.capability).length > 0) {
      coverage.push(entry(info, false, "reachable only through a grant — shared accounts are not searched"));
    } else {
      coverage.push(entry(info, false, "this session has no access"));
    }
  }

  return {
    query,
    queries: query === "" ? [] : queries,
    coverage,
    gaps: [ATTACHMENT_GAP],
    sharedAccountsExcluded: sharedAccounts(session).length,
  };
}

/**
 * Render order for realm groups: indexed first, then scanned, then the ones
 * that were not searched at all. The order IS the tiering made visible — the
 * realm that can answer well leads, and "files" trails with its reason rather
 * than disappearing (an absent group reads as "no matches", which is false).
 */
export function orderRealms(coverage: RealmCoverage[]): RealmCoverage[] {
  const rank = (c: RealmCoverage): number =>
    !c.searched ? 2 : c.tier === "indexed" ? 0 : 1;
  // Stable within a rank, so REALMS order breaks ties.
  return [...coverage].sort((a, b) => rank(a) - rank(b));
}

// ── session account selection (decision 4 lives here) ─────────────────────

function entry(info: RealmInfo, searched: boolean, reason?: string): RealmCoverage {
  return {
    realm: info.realm,
    title: info.title,
    label: info.label,
    tier: info.tier,
    searched,
    ...(reason !== undefined ? { reason } : {}),
  };
}

function accountsWith(session: Session, capability: string): string[] {
  return Object.entries(session.accounts)
    .filter(([, account]) =>
      hasCapability({ capabilities: account.accountCapabilities }, capability),
    )
    .map(([id]) => id);
}

/** Owned accounts advertising `capability`, the session's primary first. */
function ownedAccounts(session: Session, capability: string): string[] {
  const primaryId = session.primaryAccounts[capability] ?? "";
  return accountsWith(session, capability)
    .filter((id) => session.accounts[id]?.isPersonal === true)
    .sort((a, b) => Number(b === primaryId) - Number(a === primaryId));
}

/** Distinct grant-reached accounts that advertise any searchable realm. */
function sharedAccounts(session: Session): string[] {
  const caps = REALMS.map((r) => r.capability).filter((c): c is string => c !== undefined);
  return Object.entries(session.accounts)
    .filter(
      ([, account]) =>
        account.isPersonal !== true &&
        caps.some((cap) => hasCapability({ capabilities: account.accountCapabilities }, cap)),
    )
    .map(([id]) => id);
}
