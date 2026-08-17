// The scope note — the deliverable of s07 T6, not a footnote to it.
//
// The pattern is `../mail/search.ts:60-65` (`SEARCH_SCOPE_NOTE`, rendered by
// `AppShell.tsx:577-579`) and `../calendar/scope.ts`; the lesson behind all of
// them is `.feedback common/004`: a search box whose scope claim is quietly
// false teaches people their data is not there. On a page that claims to
// search EVERYTHING, the claim is bigger and so is the lie, so the note is
// derived from the plan's coverage declaration rather than written as prose —
// when the searchability table (`plan.ts` `REALMS`) or the gap list changes,
// this sentence changes with it and cannot drift.
//
// What it renders, verbatim, for a full-capability session today:
//
//   searched: mail bodies (indexed) · contacts, calendar (scanned)
//   not searched: attachment contents — requires the extraction index
//                 files — no search path yet
//
// The `(indexed)` / `(scanned)` tags are refinement 4's tier boundary made
// visible: mail rides the free FTS5 index; contacts and calendar are full
// `LIKE` scans that get slower as the account grows; attachment text is the
// premium extraction index that does not exist yet. `scope.test.ts` holds the
// exact strings.

import type { CoverageGap, RealmCoverage } from "./plan";

export interface ScopeNote {
  /** "searched: …" — realms grouped by tier, indexed first. */
  searchedLine: string;
  /**
   * What this query did NOT reach: named gaps (attachment contents), realms
   * with no search path (files), and realms this session was refused or only
   * reaches through a grant. The UI prefixes the first line "not searched: ".
   */
  notSearchedLines: string[];
}

/** Shared-accounts line (decision 4), appended only when the session HAS any. */
export const SHARED_NOT_SEARCHED = "other people's shared accounts — only your own are searched";

export function deriveScopeNote(plan: {
  coverage: RealmCoverage[];
  gaps: CoverageGap[];
  sharedAccountsExcluded: number;
}): ScopeNote {
  // "mail bodies (indexed) · contacts, calendar (scanned)" — labels grouped
  // by tier, tiers in index-quality order, and a tier only appears when a
  // searched realm sits in it.
  const groups: string[] = [];
  for (const tier of ["indexed", "scanned"] as const) {
    const labels = plan.coverage.filter((c) => c.searched && c.tier === tier).map((c) => c.label);
    if (labels.length > 0) groups.push(`${labels.join(", ")} (${tier})`);
  }
  const searchedLine =
    groups.length > 0
      ? `searched: ${groups.join(" · ")}`
      : "searched: nothing — this session reaches no searchable realm";

  const notSearchedLines: string[] = [
    // Named gaps lead: they are the tier boundary (what an upgrade would add),
    // not an accident of this session's grants.
    ...plan.gaps.map((g) => `${g.label} — ${g.reason}`),
    ...plan.coverage.filter((c) => !c.searched).map((c) => `${c.label} — ${c.reason ?? "not searched"}`),
    ...(plan.sharedAccountsExcluded > 0 ? [SHARED_NOT_SEARCHED] : []),
  ];

  return { searchedLine, notSearchedLines };
}
