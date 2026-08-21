// The disk half of the message cache: IndexedDB, and nothing else.
//
// Every decision — what may be cached, what a change invalidates, whose cache
// this is — lives in `lib/mail/cachePolicy.ts` and is tested without a
// browser. This file only moves bytes, and every entry point degrades to "no
// cache" rather than throwing: private browsing, a storage quota, a locked-
// down profile and SSR all fail here, and none of them should break mail.
//
// localStorage was not an option and neither was a service worker. A Cache API
// store cannot key on POST at all (JMAP is one POST endpoint), and a service
// worker that outlives sign-out serving someone else's inbox is the exact
// failure this file's epoch check exists to prevent.

import type { Email } from "../mail/types";
import { cacheEpochMatches, selectExpired, type CachedEmail } from "../mail/cachePolicy";

const DB_NAME = "bullmoose";
const DB_VERSION = 1;
const EMAILS = "emails";

/** Written by `storeSession` on every sign-in; read here to decide whether the
 *  mail on disk belongs to whoever is signed in now. */
export const EPOCH_KEY = "bullmoose.cacheEpoch";

function currentEpoch(): string | null {
  try {
    return globalThis.localStorage?.getItem(EPOCH_KEY) ?? null;
  } catch {
    return null;
  }
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let db: IDBOpenDBRequest;
    try {
      if (!globalThis.indexedDB) return resolve(null);
      db = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Firefox in private mode throws from open() rather than erroring.
      return resolve(null);
    }
    db.onupgradeneeded = () => {
      const store = db.result;
      if (!store.objectStoreNames.contains(EMAILS)) store.createObjectStore(EMAILS, { keyPath: "email.id" });
    };
    db.onsuccess = () => resolve(db.result);
    db.onerror = () => resolve(null);
    // A blocked upgrade would hang the promise and with it the first paint.
    db.onblocked = () => resolve(null);
  });
}

/** Read cached messages by id. Entries from a previous sign-in are not
 *  returned — and the whole store is dropped when one is seen. */
export async function readEmails(ids: readonly string[]): Promise<Map<string, CachedEmail>> {
  const found = new Map<string, CachedEmail>();
  const epoch = currentEpoch();
  if (!epoch || ids.length === 0) return found;
  const db = await open();
  if (!db) return found;
  try {
    const tx = db.transaction(EMAILS, "readonly");
    const store = tx.objectStore(EMAILS);
    const rows = await Promise.all(ids.map((id) => request<CachedEmail | undefined>(store.get(id))));
    let foreign = false;
    for (const row of rows) {
      if (!row) continue;
      if (!cacheEpochMatches(row.epoch, epoch)) {
        foreign = true;
        continue;
      }
      found.set(row.email.id, row);
    }
    // Someone else's mail is on this disk. Do not merely skip it.
    if (foreign) void clearEmails();
  } catch {
    /* a failed read is a cache miss, never an error the reader sees */
  } finally {
    db.close();
  }
  return found;
}

/** Store messages under the current sign-in. A write failure is silent: the
 *  cache is an optimisation, and mail must work without it. */
export async function writeEmails(emails: readonly Email[], now = Date.now()): Promise<void> {
  const epoch = currentEpoch();
  if (!epoch || emails.length === 0) return;
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(EMAILS, "readwrite");
    const store = tx.objectStore(EMAILS);
    for (const email of emails) {
      // KEEP the original timestamp. The flag sync rewrites entries, so
      // stamping `now` on every write would restart the expiry clock on
      // anything Email/changes touched — a busy mailbox would keep mail on
      // disk indefinitely behind a cap that looked like a week.
      const prior = await request<CachedEmail | undefined>(store.get(email.id)).catch(() => undefined);
      const cachedAt = prior && cacheEpochMatches(prior.epoch, epoch) ? prior.cachedAt : now;
      store.put({ email, epoch, cachedAt } satisfies CachedEmail);
    }
    await done(tx);
  } catch {
    /* quota, or a store that vanished under us */
  } finally {
    db.close();
  }
  // Opportunistic, and deliberately not awaited by the caller's path: eviction
  // is housekeeping, and a reader waiting on it would be paying for storage
  // hygiene with latency.
  void sweepExpired(now);
}

/**
 * Drop everything past `MAX_CACHE_AGE_MS`.
 *
 * Runs off the back of writes rather than a timer — a timer would need a
 * lifecycle, would fire in backgrounded tabs, and would still miss the case
 * that matters (a browser opened once a fortnight, where the sweep should
 * happen on the way in). Reading always goes through the epoch gate, so an
 * expired entry is never SERVED between sweeps; it is only occupying space.
 */
export async function sweepExpired(now = Date.now()): Promise<number> {
  const epoch = currentEpoch();
  if (!epoch) return 0;
  const db = await open();
  if (!db) return 0;
  try {
    const tx = db.transaction(EMAILS, "readwrite");
    const store = tx.objectStore(EMAILS);
    const all = await request<CachedEmail[]>(store.getAll());
    const entries = new Map(all.map((row) => [row.email.id, row]));
    const dead = selectExpired(entries, now);
    for (const id of dead) store.delete(id);
    await done(tx);
    return dead.length;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

/** Forget specific messages — what `Email/changes` reports as destroyed. */
export async function dropEmails(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(EMAILS, "readwrite");
    const store = tx.objectStore(EMAILS);
    for (const id of ids) store.delete(id);
    await done(tx);
  } catch {
    /* nothing to do about it */
  } finally {
    db.close();
  }
}

/**
 * Wipe every message.
 *
 * ⚠️ Called from `signOut()`, and again from `readEmails` the moment an entry
 * from another sign-in is seen. Two paths because sign-out is only the
 * deliberate exit: tokens are also revoked and expire, and those bounce
 * through /login without anyone calling signOut.
 */
export async function clearEmails(): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(EMAILS, "readwrite");
    tx.objectStore(EMAILS).clear();
    await done(tx);
  } catch {
    /* best effort */
  } finally {
    db.close();
  }
}

/** Every cached id — what `planCacheSync` compares a changes response against. */
export async function cachedIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const db = await open();
  if (!db) return ids;
  try {
    const tx = db.transaction(EMAILS, "readonly");
    const keys = await request<IDBValidKey[]>(tx.objectStore(EMAILS).getAllKeys());
    for (const key of keys) if (typeof key === "string") ids.add(key);
  } catch {
    /* an unreadable store is an empty one */
  } finally {
    db.close();
  }
  return ids;
}

function request<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
