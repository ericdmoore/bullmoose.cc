// The Finder's two localStorage stores (s20 T5): saved queries
// (`bm.finder.saved`) and recent sessions (`bm.finder.sessions`). Browser
// state, deliberately — there is no server noun for a find yet, and inventing
// one before the loop has proven itself would be storage-first thinking. When
// the s20-t5b agent-mediated version needs finds an agent can see, THAT is
// the moment a noun is earned; this module is shaped so only the persistence
// seam changes.
//
// List operations are pure (list in, list out) and the storage seam is an
// injected `Pick<Storage, …>` defaulting to `globalThis.localStorage` — the
// same guarded-optional pattern `../app/client.ts` uses, so plain-Node vitest
// tests inject a Map and never need jsdom.
//
// Honesty rule carried in the data: a saved query stores `lastCount` AND
// `lastRunAt` together. The collection column must label the count with when
// it was measured ("12 on Aug 12"), never render a bare number that implies
// a live answer nobody computed.

import type { FinderRefinement, FinderSession } from "./session";

export const SAVED_KEY = "bm.finder.saved";
export const SESSIONS_KEY = "bm.finder.sessions";
/** Recent sessions kept, newest first. Twenty is a shelf, not an archive. */
export const SESSION_CAP = 20;

export interface SavedQuery {
  id: string;
  /** The user's name for it — "invoices from Sergio". */
  name: string;
  query: string;
  refinements: FinderRefinement[];
  /** ISO — when it was saved. */
  savedAt: string;
  /** ISO — when it last actually ran. Absent = saved but never run since. */
  lastRunAt?: string;
  /** The server total AT lastRunAt. Meaningless without it — render both. */
  lastCount?: number;
}

/** The storage seam — what this module needs of `localStorage`. */
export type KV = Pick<Storage, "getItem" | "setItem">;

const defaultKV = (): KV | undefined => globalThis.localStorage;

// ── pure list operations ──────────────────────────────────────────────────

/** Newest first, capped, one entry per id — re-running a session moves it to
 *  the top rather than duplicating it. */
export function upsertSession(list: readonly FinderSession[], session: FinderSession): FinderSession[] {
  return [session, ...list.filter((s) => s.id !== session.id)].slice(0, SESSION_CAP);
}

/** Newest first, one entry per id. Saved queries have no cap — the user
 *  named each one on purpose, and silently dropping a named thing is worse
 *  than a long list. */
export function upsertSaved(list: readonly SavedQuery[], entry: SavedQuery): SavedQuery[] {
  return [entry, ...list.filter((s) => s.id !== entry.id)];
}

export function removeSaved(list: readonly SavedQuery[], id: string): SavedQuery[] {
  return list.filter((s) => s.id !== id);
}

/** Record a run of saved query `id`: count and timestamp move TOGETHER —
 *  the pair is what makes the badge honest. Order is preserved (a run is not
 *  a re-save). */
export function recordRun(list: readonly SavedQuery[], id: string, count: number, at: string): SavedQuery[] {
  return list.map((s) => (s.id === id ? { ...s, lastCount: count, lastRunAt: at } : s));
}

// ── persistence ───────────────────────────────────────────────────────────

export function loadSessions(kv: KV | undefined = defaultKV()): FinderSession[] {
  return parseList(kv, SESSIONS_KEY, isSession).slice(0, SESSION_CAP);
}

export function persistSessions(list: readonly FinderSession[], kv: KV | undefined = defaultKV()): void {
  write(kv, SESSIONS_KEY, list.slice(0, SESSION_CAP));
}

export function loadSaved(kv: KV | undefined = defaultKV()): SavedQuery[] {
  return parseList(kv, SAVED_KEY, isSaved);
}

export function persistSaved(list: readonly SavedQuery[], kv: KV | undefined = defaultKV()): void {
  write(kv, SAVED_KEY, list);
}

// ── parsing (a preference store is untrusted input like any other) ────────

function parseList<T>(kv: KV | undefined, key: string, valid: (row: unknown) => row is T): T[] {
  try {
    const raw = kv?.getItem(key);
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Malformed rows are dropped individually — one corrupt entry must not
    // discard the nineteen good ones beside it.
    return parsed.filter(valid);
  } catch {
    return [];
  }
}

function write(kv: KV | undefined, key: string, value: unknown): void {
  try {
    kv?.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or privacy mode — persistence is a nicety, the session in memory
       still works */
  }
}

const REFINEMENT_KINDS = new Set(["from", "to", "mailbox", "window", "attachment"]);

function isRefinementList(value: unknown): value is FinderRefinement[] {
  return (
    Array.isArray(value) &&
    value.every(
      (r) => typeof r === "object" && r !== null && REFINEMENT_KINDS.has((r as { kind?: unknown }).kind as string),
    )
  );
}

function isSession(row: unknown): row is FinderSession {
  if (typeof row !== "object" || row === null) return false;
  const s = row as Partial<FinderSession>;
  return (
    typeof s.id === "string" &&
    typeof s.query === "string" &&
    typeof s.startedAt === "string" &&
    isRefinementList(s.refinements)
  );
}

function isSaved(row: unknown): row is SavedQuery {
  if (typeof row !== "object" || row === null) return false;
  const s = row as Partial<SavedQuery>;
  return (
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    typeof s.query === "string" &&
    typeof s.savedAt === "string" &&
    isRefinementList(s.refinements)
  );
}
