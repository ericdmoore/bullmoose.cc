// Delivering a list load's outcome ONLY if that load is still the current one.
//
// The mail list is driven by an effect keyed on `[client, accountId,
// mailbox?.id, searchSpec]` (AppShell). Every time one of those changes the
// effect builds a NEW `ThreadListStore` and starts a NEW load — but the load it
// just superseded is a promise already in flight, and a promise cannot be
// un-started. Its `.then` still holds a reference to the OLD store.
//
// Left unguarded that is a lost race with three distinct symptoms, all of which
// look like "the list is wrong" rather than like a bug in sequencing:
//
//   ROWS FROM THE WRONG MAILBOX. Click Inbox, then Drafts before Inbox answers.
//   Inbox's response lands last and writes ITS rows into state, so Drafts is
//   selected in the rail while Inbox's mail is on screen. It is sticky: nothing
//   re-queries until the next push or mailbox click, so the list simply lies
//   until you touch it again.
//
//   A SPINNER CLEARED BY SOMEONE ELSE'S LOAD. `finally` belongs to the load that
//   opened it. When a superseded load clears `loading`, the CURRENT load — still
//   in flight — renders as "Nothing here." instead of "Loading…", which reads as
//   an empty mailbox rather than as a pending one.
//
//   AN ERROR ABOUT A SCREEN YOU LEFT. A failure from the mailbox you navigated
//   away from arrives as a toast over the mailbox you are now looking at, naming
//   a query nobody can see.
//
// The rule is one line — a result may only be delivered while it is still
// current — and it lives here, pure and injectable, rather than inline in the
// effect, because "still current" is exactly the kind of thing that reads as
// obviously fine in a component and is impossible to test there: the shell's
// tests render through `preact-render-to-string`, which never runs an effect.
//
// `isCurrent` is a PREDICATE, deliberately, not a cancel token. AppShell already
// keeps `storeRef.current` pointing at the live store — the effect assigns it on
// entry and its cleanup drops it — so `() => storeRef.current === store` is an
// exact statement of "this load still owns the list", and it answers correctly
// for BOTH callers: the effect's own reload, and the `onLoadMore` paging call
// that starts long after the effect body has returned and has no cleanup of its
// own to hang a cancel flag on.

/** What a list load reports back, in the order it happens. */
export interface ListLoadHandlers<T> {
  /** The load resolved and is still current. */
  onResult: (result: T) => void;
  /**
   * The load rejected and is still current. Pre-stringified: the caller shows
   * this to a human, and `unknown` is not something a toast can render.
   */
  onError: (message: string) => void;
  /**
   * The load finished — either way — and is still current. This is where the
   * spinner closes, so it must not fire for a load that has been superseded.
   */
  onSettled: () => void;
}

/**
 * Run one list load; deliver its outcome only while `isCurrent()` holds.
 *
 * `isCurrent` is consulted at DELIVERY time, never at call time: the whole point
 * is that the answer changes while the promise is in flight. It is asked once
 * per handler, so a predicate that flips between the result and the settle (it
 * cannot — nothing awaits in between — but were it to) can never leave a
 * spinner open on a list it already repainted.
 *
 * Returns nothing on purpose. There is no cancel to call: cancellation is
 * expressed entirely by the predicate going false, which is a state the caller
 * already maintains for other reasons. A second mechanism would be a second
 * thing to keep in sync.
 */
export function runListLoad<T>(load: () => Promise<T>, isCurrent: () => boolean, handlers: ListLoadHandlers<T>): void {
  // `.then(load)` rather than `load()`: a store method that throws SYNCHRONOUSLY
  // (before it ever returns a promise) has to land in the same `catch` as a
  // rejection, or it escapes the chain entirely and `finally` never runs —
  // which strands the spinner at "Loading…" forever. That is the exact shape of
  // the bug this module is named after, and it must not be reachable from here.
  void Promise.resolve()
    .then(load)
    .then((result) => {
      if (isCurrent()) handlers.onResult(result);
    })
    .catch((err: unknown) => {
      if (isCurrent()) handlers.onError(errorMessage(err));
    })
    .finally(() => {
      if (isCurrent()) handlers.onSettled();
    });
}

/**
 * What to put in front of a person when a load fails.
 *
 * A rejected promise can carry anything — this is the one place that decides,
 * so no call site has to re-derive it and none of them can disagree. An `Error`
 * gives up its message; everything else is stringified, because a toast reading
 * "[object Object]" is still better than a blank one that says a failure
 * happened but not what.
 */
export function errorMessage(err: unknown): string {
  return String(err instanceof Error ? err.message : err);
}
