// Prefetch on intent (s35 phase 4) — fetch what the reader is about to open,
// without fetching what they merely scrolled past.
//
// PURE. No client, no IndexedDB, no timers: the decisions live here and are
// testable without a browser, the wiring lives in the island. Same split as
// `cachePolicy.ts`, and for the same reason — the interesting failures here
// are judgment calls about someone else's data plan, not plumbing.
//
// ## Two signals, deliberately different in cost and confidence
//
//   SPECULATIVE + CHEAP — after the list stops moving, fetch the visible rows
//   with a small `maxBodyValueBytes`. Wide net, bounded cost: speculating on a
//   2MB newsletter costs 4KB, because the server honours the cap and reports
//   `isTruncated` (services/jmap email.ts). Wrong guesses are affordable.
//
//   CONFIDENT + LATE — `pointerdown` fires ~100ms before `click`, and covers a
//   mouse and a thumb in one handler. That is real time we otherwise waste,
//   at the highest-confidence moment there is, so it fetches the FULL body.
//
// The cheap net keeps the common case warm; the late signal catches what the
// net missed. Neither is a replacement for the other.
//
// ## Why speculating is safe at all
//
// `Email/get` does not mutate. Opening marks read through a SEPARATE
// `Email/set` in `openThread`, so a prefetch cannot mark someone's mail read —
// which is the usual way this feature goes wrong and the reason it is usually
// switched off by the people who need it most.
//
// And a truncated prefetch cannot corrupt the cache: `mergeMutable` copies
// `keywords` and `mailboxIds` and nothing else, so 4KB can never overwrite a
// full body already in hand (cachePolicy.test.ts pins it).

/** How long the list must be still before we believe the reader stopped. */
export const SETTLE_MS = 250;

/** The cheap net's body budget. Enough for a first screenful, small enough
 *  that a wrong guess is not worth noticing on a metered connection. */
export const PREFETCH_BODY_BYTES = 4096;

/** Ceiling on the speculative net. "Everything visible" during a flick is
 *  thirty rows; this is what the reader could plausibly be choosing between. */
export const PREFETCH_MAX = 5;

/** What the browser will tell us about the connection, where it bothers to. */
export interface NetworkHints {
  /** `navigator.connection.saveData` — an explicit request to spend less. */
  saveData?: boolean;
  /** `effectiveType`: "slow-2g" | "2g" | "3g" | "4g". */
  effectiveType?: string;
  /** `document.visibilityState` — a backgrounded tab is not being read. */
  visible?: boolean;
}

const TOO_SLOW = new Set(["slow-2g", "2g"]);

/**
 * May we spend someone's bandwidth on a guess?
 *
 * ⚠️ There is deliberately NO SETTING for this. The device already says what
 * it wants — `saveData` is the reader asking, out loud, through an interface
 * they already know — and asking again in our own preferences pane would be a
 * star by another name (the anti-star principle: the agent notices, the human
 * does not file). A toggle labelled "prefetch on cellular" is a question
 * nobody should have to answer twice.
 *
 * Absent hints mean an ordinary connection: a browser that reports nothing is
 * usually a desktop one, and refusing to prefetch on silence would switch the
 * feature off for most people to protect a few.
 */
export function mayPrefetch(hints: NetworkHints): boolean {
  if (hints.visible === false) return false;
  if (hints.saveData === true) return false;
  if (hints.effectiveType !== undefined && TOO_SLOW.has(hints.effectiveType)) return false;
  return true;
}

/**
 * Which of the rows now on screen are worth asking for.
 *
 * Already-cached ids are dropped, so the net decays toward nothing as the
 * reader works through a mailbox — the second pass over a list costs no
 * requests at all. Order is preserved: the top of the viewport is what someone
 * is most likely to open next.
 */
export function selectPrefetch(
  visibleIds: readonly string[],
  cached: ReadonlySet<string>,
  max: number = PREFETCH_MAX,
): string[] {
  const out: string[] = [];
  for (const id of visibleIds) {
    if (cached.has(id)) continue;
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/** Read the hints off a browser that may not offer any of them. */
export function readNetworkHints(
  nav: unknown = globalThis.navigator,
  doc: unknown = globalThis.document,
): NetworkHints {
  const conn = (nav as { connection?: { saveData?: boolean; effectiveType?: string } } | undefined)?.connection;
  const vis = (doc as { visibilityState?: string } | undefined)?.visibilityState;
  return {
    ...(typeof conn?.saveData === "boolean" ? { saveData: conn.saveData } : {}),
    ...(typeof conn?.effectiveType === "string" ? { effectiveType: conn.effectiveType } : {}),
    ...(vis !== undefined ? { visible: vis === "visible" } : {}),
  };
}
