// The Finder session model (s20 T5) — a directed find over your OWN mail
// history is a SESSION: one initial query plus an ordered chain of
// refinements, each of which narrows the previous result set. The chain is
// native structure, never browser history — the whole app makes exactly one
// history call (`../app/client.ts`, held by `tokenInUrl.test.ts`), and
// "back out one chip" is removing an element from an array, not `history.back()`.
//
// Pure on purpose: the island renders chips and calls these; what a
// refinement IS, how two of the same kind interact, and how a session
// compiles to the server's filter all live here where vitest can hold them.
//
// The compilation target is `../mail/search.ts`'s `SearchSpec` — the SAME
// spec `/mail`'s search box builds, through the same `buildEmailFilter`, so
// the Finder and the mail surface cannot disagree about what `from:` means.

import type { SearchSpec } from "../mail/search";

/**
 * One refinement chip. Kinds mirror the facets the mail filter really
 * implements (`EmailFilterCondition`) — a chip that the server cannot narrow
 * by would be a lie rendered as UI.
 *
 *   from / to    substring over the address list (the server's own semantics)
 *   mailbox      `inMailbox` — the name rides along for the chip label only
 *   window       a receivedAt range: `after` inclusive, `before` exclusive,
 *                both ISO instants. Carries its own display label ("Aug 2026")
 *   attachment   `hasAttachment: true`
 */
export type FinderRefinement =
  | { kind: "from"; value: string }
  | { kind: "to"; value: string }
  | { kind: "mailbox"; id: string; name: string }
  | { kind: "window"; label: string; after: string; before: string }
  | { kind: "attachment" };

export interface FinderSession {
  id: string;
  /** The initial free-text query. May be empty once refinements exist. */
  query: string;
  /** The refinement chain, oldest first — the order the chips render in. */
  refinements: FinderRefinement[];
  /** ISO — when the session began. */
  startedAt: string;
  /** ISO — when the session last ran against the server. */
  lastRunAt?: string;
  /** Matches at the last run (the server's total, not the page size). */
  resultCount?: number;
}

/** Injectable clock so tests get stable ids and timestamps. */
export type Clock = () => number;

export function newSession(query: string, now: Clock = Date.now): FinderSession {
  const at = now();
  return {
    // Time-prefixed so ids sort by recency even if two land in one tick.
    id: `f-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    query: query.trim(),
    refinements: [],
    startedAt: new Date(at).toISOString(),
  };
}

/**
 * Add a refinement. AT MOST ONE PER KIND: refining "Aug 2026" while "Jul
 * 2026" is applied means "move the window", not "the empty intersection of
 * two months" — so a same-kind chip is REPLACED, and the replacement moves to
 * the end of the chain (it is the newest step of the find). `from` and `to`
 * are distinct kinds and can coexist.
 */
export function refine(session: FinderSession, refinement: FinderRefinement): FinderSession {
  return {
    ...session,
    refinements: [...session.refinements.filter((r) => r.kind !== refinement.kind), refinement],
  };
}

/** Back out ONE chip — the one at `index`. Chips are individually removable;
 *  a chain is a set of narrowings, not a stack you may only pop. */
export function removeRefinement(session: FinderSession, index: number): FinderSession {
  return { ...session, refinements: session.refinements.filter((_, i) => i !== index) };
}

/** Back out the LAST chip — the "undo one step" affordance. */
export function retract(session: FinderSession): FinderSession {
  return { ...session, refinements: session.refinements.slice(0, -1) };
}

/** A session that would query nothing — no text and no chips. Running it
 *  would mean "everything you have ever received", which is browsing, not
 *  finding; the caller shows the empty state instead. */
export function isBlank(session: FinderSession): boolean {
  return session.query.trim() === "" && session.refinements.length === 0;
}

/**
 * Compile the session to the mail search spec. Every kind maps to a
 * condition the server implements (`buildEmailFilter` consumes this) —
 * nothing is filtered client-side, so the total the server reports is the
 * total the session claims.
 */
export function toSearchSpec(session: FinderSession): SearchSpec {
  const spec: SearchSpec = {};
  const query = session.query.trim();
  if (query !== "") spec.text = query;
  for (const r of session.refinements) {
    switch (r.kind) {
      case "from":
        spec.from = r.value;
        break;
      case "to":
        spec.to = r.value;
        break;
      case "mailbox":
        spec.inMailbox = r.id;
        break;
      case "window":
        spec.after = r.after;
        spec.before = r.before;
        break;
      case "attachment":
        spec.hasAttachment = true;
        break;
    }
  }
  return spec;
}

/** The chip's visible text. Short — chips sit in a row above the results. */
export function chipLabel(r: FinderRefinement): string {
  switch (r.kind) {
    case "from":
      return `from: ${r.value}`;
    case "to":
      return `to: ${r.value}`;
    case "mailbox":
      return `in: ${r.name}`;
    case "window":
      return r.label;
    case "attachment":
      return "has attachment";
  }
}

/** The session's one-line name — the Sessions list row in the collection
 *  column. The query leads; the chain is summarised, not restated. */
export function describeSession(session: FinderSession): string {
  const base = session.query.trim() === "" ? "(no text)" : session.query.trim();
  const n = session.refinements.length;
  return n === 0 ? base : `${base} +${n} filter${n === 1 ? "" : "s"}`;
}
