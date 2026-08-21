// Row navigation: how a list row opens its detail WITHOUT reloading the page.
//
// ## The false choice this exists to end
//
// `StackedRow` used to take `href` XOR `onSelect`, and every realm downstream
// had to pick one and lose the other:
//
//   href only    → deep-linkable, cmd-clickable … and a FULL PAGE RELOAD on
//                  every click (Contacts, Approvals)
//   onSelect only → instant in-page update … and no shareable URL, no
//                  cmd-click, no "open in new tab" (Files, Notes, Calendar,
//                  Goals, Agents, Activity)
//
// Mail alone had both, hand-rolled in `ThreadListView`: a real anchor, plus a
// click handler that intercepts the PLAIN left-click and lets every modified
// click fall through to the browser. That is the whole trick, and it belongs
// here rather than in one realm's list component.
//
// ## Why the anchor stays
//
// It is tempting to replace the link with a button once the click is handled
// in JS. Don't. The `href` is what makes the row cmd-clickable, middle-
// clickable, "copy link"-able, and readable to a screen reader as a link to
// somewhere — none of which a `<button>` can offer, and none of which JS can
// re-create faithfully.

/** The minimum of a MouseEvent this needs — so the check is testable without
 *  a DOM, and so a synthetic event from a test cannot drift from the real one. */
export interface PrimaryClickLike {
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/**
 * Is this the plain left-click that should stay in the page?
 *
 * Every modifier is a deliberate request for the BROWSER's behaviour and must
 * be honoured: cmd/ctrl opens a new tab, shift a new window, alt downloads,
 * and a non-zero button is a middle- or right-click. Calling `preventDefault`
 * on any of those would silently break a gesture the user meant.
 */
export function isUnmodifiedPrimaryClick(ev: PrimaryClickLike): boolean {
  return (ev.button ?? 0) === 0 && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey;
}

/**
 * Point the address bar at what is on screen, without touching history depth.
 *
 * `replaceState`, never `pushState` — and that is not a workaround for
 * `tokenInUrl.test.ts`, it is the honest shape. Opening a detail pane is not a
 * new PAGE; pushing would make the browser's Back button walk backwards
 * through every row the reader glanced at before it ever left the realm. The
 * in-app Back button is the modelled exit (it is always visible, by design).
 *
 * Guarded: a sandboxed frame or opaque origin refuses `replaceState`, and a
 * URL that will not parse must not take the app down with it.
 */
export function syncDetailUrl(href: string): boolean {
  try {
    const url = new URL(href, globalThis.location?.href ?? "https://app.bullmoose.cc");
    if (url.origin !== new URL(globalThis.location?.href ?? url.href).origin) return false;
    globalThis.history?.replaceState(globalThis.history.state ?? null, "", url.pathname + url.search);
    return true;
  } catch {
    return false;
  }
}
