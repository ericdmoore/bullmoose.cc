// What may be cached, what a change makes stale, and whose cache it is.
//
// PURE. No IndexedDB, no client, no clock beyond what is passed in — the
// storage lives in `lib/app/emailStore.ts` and holds none of these decisions.
// Same split every island follows: the logic is testable without a browser,
// and the part that needs a browser has no logic to get wrong.
//
// ## Why a mail cache can be this simple
//
// RFC 8621 §4.1: an Email is IMMUTABLE except for `keywords` and `mailboxIds`.
// Not "rarely changes" — cannot change. The body, headers, subject, sender,
// date and attachments are fixed the moment the message exists. So a cached
// body is correct forever and is never revalidated; only the two mutable
// properties need syncing, and they are small.
//
// That is the whole design. The cache stores messages; `Email/changes` keeps
// the flags honest (RFC 8620 §5.2 — implemented server-side, unlike
// `Email/queryChanges`, which is a deliberate stub because D1 keeps no query
// index, so LISTS re-query while OBJECTS delta).

import type { Email } from "./types";

/** The ONLY properties of an Email that can change after it exists. Anything
 *  absent from here is safe to trust from cache indefinitely. */
export const MUTABLE_PROPERTIES = ["id", "keywords", "mailboxIds"] as const;

/** An Email as stored: the object, plus which sign-in it belongs to. */
export interface CachedEmail {
  email: Email;
  /** Sign-in this was written under — see `cacheEpochMatches`. */
  epoch: string;
  cachedAt: number;
}

/**
 * Split requested ids into what we hold and what must be fetched. The miss
 * list is what goes on the wire; an empty one means no request at all.
 */
export function partitionIds(
  ids: readonly string[],
  cached: ReadonlyMap<string, CachedEmail>,
): { hits: Email[]; misses: string[] } {
  const hits: Email[] = [];
  const misses: string[] = [];
  for (const id of ids) {
    const entry = cached.get(id);
    if (entry) hits.push(entry.email);
    else misses.push(id);
  }
  return { hits, misses };
}

/**
 * Fold a fresh read of the mutable properties onto a cached message.
 *
 * Deliberately narrow: it copies `keywords` and `mailboxIds` and NOTHING else.
 * The prefetch path fetches with a small `maxBodyValueBytes`, so a wider merge
 * would let a truncated body overwrite a full one already in hand — the cache
 * would get quietly worse the more it was used.
 */
export function mergeMutable(cached: Email, fresh: Partial<Email>): Email {
  return {
    ...cached,
    ...(fresh.keywords ? { keywords: fresh.keywords } : {}),
    ...(fresh.mailboxIds ? { mailboxIds: fresh.mailboxIds } : {}),
  };
}

/** What `Email/changes` says happened since a stored state. */
export interface ChangesResult {
  created: readonly string[];
  updated: readonly string[];
  destroyed: readonly string[];
  newState: string;
}

/**
 * Turn a changes response into cache work.
 *
 * `updated` is the interesting one: because everything but the flags is
 * immutable, an update can ONLY be a keywords/mailboxIds change, so we refresh
 * those two properties rather than re-reading whole messages. A `created` id
 * we have never seen is deliberately NOT fetched — the list query brings it in
 * when it is actually wanted, and pulling every new arrival in the background
 * is a download nobody asked for, on a connection we may not own.
 */
export function planCacheSync(
  changes: ChangesResult,
  cachedIds: ReadonlySet<string>,
): { refreshFlags: string[]; drop: string[] } {
  return {
    refreshFlags: changes.updated.filter((id) => cachedIds.has(id)),
    drop: changes.destroyed.filter((id) => cachedIds.has(id)),
  };
}

/**
 * Does this cache belong to the session that is signed in now?
 *
 * ⚠️ THE SECURITY GATE. `signOut()` clears the cache, but that is only the
 * deliberate exit. A token can also be revoked, expire, or be replaced by a
 * different person signing in on the same browser — and each of those bounces
 * through /login without anyone calling `signOut`. Twelve islands make that
 * bounce independently, and asking all twelve to remember to wipe mail off the
 * disk is a rule that will be broken by the thirteenth.
 *
 * So the cache carries the epoch it was written under, `storeSession` mints a
 * new one on every sign-in, and a mismatch means the mail on disk belongs to a
 * session that is over. Checking identity at OPEN covers every way in, instead
 * of every way out.
 */
export function cacheEpochMatches(cachedEpoch: string | null, currentEpoch: string | null): boolean {
  // No session at all: nothing may be read, whatever is on disk.
  if (!currentEpoch) return false;
  return cachedEpoch === currentEpoch;
}
