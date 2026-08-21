// Keep cached messages honest without re-downloading them.
//
// The cache stores whole messages and never revalidates them, which is only
// safe because RFC 8621 §4.1 makes an Email immutable except for `keywords`
// and `mailboxIds`. This is the other half: `Email/changes` (RFC 8620 §5.2)
// reports which ids moved since a stored state, and we re-read ONLY those two
// properties for the ones we hold.
//
// ⚠️ `Email/queryChanges` is a deliberate server stub (`cannotCalculateChanges`
// — D1 keeps no query index), so LIST order still re-queries; see
// threadList.ts. Object changes are a different method and do work, which is
// what makes this possible at all.

import type { JmapClient } from "../jmap/JmapClient";
import { MUTABLE_PROPERTIES, mergeMutable, planCacheSync, type ChangesResult } from "./cachePolicy";
import type { Email } from "./types";

/** Where the last-seen Email state lives. Opaque cursor, not a credential —
 *  but cleared with the session anyway, since a cursor from a previous
 *  sign-in would ask the server for a delta the new one has no cache for. */
export const STATE_KEY = "bullmoose.emailState";

export function readEmailState(): string | null {
  try {
    return globalThis.localStorage?.getItem(STATE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeEmailState(state: string): void {
  try {
    globalThis.localStorage?.setItem(STATE_KEY, state);
  } catch {
    /* a browser that refuses storage simply re-syncs from scratch next time */
  }
}

export interface SyncPorts {
  cachedIds: () => Promise<Set<string>>;
  readEmails: (ids: readonly string[]) => Promise<Map<string, { email: Email }>>;
  writeEmails: (emails: readonly Email[]) => Promise<void>;
  dropEmails: (ids: readonly string[]) => Promise<void>;
}

/**
 * Bring the cache up to date with the server.
 *
 * Returns what it did, so a caller (and a test) can see the shape of the work
 * rather than inferring it from side effects.
 *
 * A `cannotCalculateChanges` error means the server can no longer describe the
 * delta from our state — the honest response is to drop the whole cache rather
 * than keep serving messages whose flags we can no longer trust. That is
 * RFC 8620 §5.2's own instruction, and it costs a re-fetch, not correctness.
 */
export async function syncCachedFlags(
  client: JmapClient,
  accountId: string,
  ports: SyncPorts,
): Promise<{ refreshed: number; dropped: number; reset: boolean }> {
  const sinceState = readEmailState();
  const held = await ports.cachedIds();
  // Nothing cached: record where the server is now, so the FIRST sync after
  // this one is a small delta rather than a full reconciliation.
  if (held.size === 0) {
    const state = await currentState(client, accountId);
    if (state) writeEmailState(state);
    return { refreshed: 0, dropped: 0, reset: false };
  }
  if (!sinceState) {
    const state = await currentState(client, accountId);
    if (state) writeEmailState(state);
    return { refreshed: 0, dropped: 0, reset: false };
  }

  let changes: ChangesResult;
  try {
    const [res] = await client.request([["Email/changes", { accountId, sinceState, maxChanges: 500 }, "c"]]);
    if (!res || res[0] === "error") {
      const type = (res?.[1] as { type?: string } | undefined)?.type;
      if (type === "cannotCalculateChanges") {
        await ports.dropEmails([...held]);
        return { refreshed: 0, dropped: held.size, reset: true };
      }
      return { refreshed: 0, dropped: 0, reset: false };
    }
    changes = res[1] as unknown as ChangesResult;
  } catch {
    // Offline, or the request failed. The cache stays as it is: stale flags
    // are a smaller problem than an empty mailbox.
    return { refreshed: 0, dropped: 0, reset: false };
  }

  const plan = planCacheSync(changes, held);
  if (plan.drop.length > 0) await ports.dropEmails(plan.drop);

  if (plan.refreshFlags.length > 0) {
    // ONE request for every changed message, and only the two properties that
    // can have changed — never the bodies, which cannot have.
    const [res] = await client.request([
      ["Email/get", { accountId, ids: plan.refreshFlags, properties: [...MUTABLE_PROPERTIES] }, "g"],
    ]);
    if (res && res[0] !== "error") {
      const fresh = ((res[1] as { list?: Array<Partial<Email>> }).list ?? []) as Array<Partial<Email>>;
      const cached = await ports.readEmails(plan.refreshFlags);
      const merged: Email[] = [];
      for (const f of fresh) {
        const hit = f.id ? cached.get(f.id) : undefined;
        if (hit) merged.push(mergeMutable(hit.email, f));
      }
      if (merged.length > 0) await ports.writeEmails(merged);
    }
  }

  if (changes.newState) writeEmailState(changes.newState);
  return { refreshed: plan.refreshFlags.length, dropped: plan.drop.length, reset: false };
}

/** The server's current Email state, without asking for any messages. */
async function currentState(client: JmapClient, accountId: string): Promise<string | null> {
  try {
    const [res] = await client.request([["Email/get", { accountId, ids: [] }, "s"]]);
    if (!res || res[0] === "error") return null;
    const state = (res[1] as { state?: unknown }).state;
    return typeof state === "string" ? state : null;
  } catch {
    return null;
  }
}
