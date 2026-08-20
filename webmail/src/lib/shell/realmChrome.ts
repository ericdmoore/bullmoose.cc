// Realm chrome — one small control a surface may hang in the shared top bar,
// beside the identity chip.
//
// ── The problem ───────────────────────────────────────────────────────────
//
// Contacts is the first realm whose "which account am I looking at" control
// is NOT a collection. It cannot go in the CollectionColumn (that column is
// address books) and it cannot stay in the surface's own header, because a
// second full-width bar under the real chrome is exactly the layout Eric
// annotated: the picker sat a row below the identity chip that it belongs
// beside. It has to land in `ShellNav`'s header — a different island,
// rendered by the page layout, on the other side of a hydration boundary.
//
// ── Why an event contract rather than a portal ────────────────────────────
//
// The obvious alternative is a named slot: ShellNav renders an empty element
// and the surface `createPortal`s into it. Three things ruled it out.
//
//  1. **Portals are invisible to this repo's tests.** Every component test
//     here is `preact-render-to-string` in plain Node (vitest.config.ts is
//     explicit that there is no jsdom). A portal has no server rendering — it
//     renders to nothing — so the account picker would be the one piece of
//     chrome that could not be render-tested at all. The rule this codebase
//     already states (`ContactsApp.tsx`: "a rule living in a `.tsx` island is
//     a rule with no test") points the same way.
//  2. **It would cost `preact/compat`.** `createPortal` is not in Preact core;
//     pulling the React compat layer into the bundle to move one `<select>`
//     is a large answer to a small question.
//  3. **The idiom already exists, in both directions.** `bm:search` is the
//     chrome talking to the active surface; `publish.ts` is every surface
//     leaving a note the chrome reads. This is the two composed: the surface
//     publishes a control, the chrome renders it, the chrome hands the pick
//     back. No new concept, and both halves are plain data.
//
// ── Why this is NOT publish.ts ────────────────────────────────────────────
//
// `publishCollections` writes to localStorage on purpose: the realm tray must
// render Mail's mailboxes from the Approvals page. A realm-chrome control is
// the opposite — it is only ever meaningful on the page whose island owns the
// state behind it, and persisting it would mean the header could show a
// Contacts account picker on /mail that nothing is listening to. So this
// keeps its record in memory, and it dies with the page.
//
// ── The mount race, and the latch ─────────────────────────────────────────
//
// Two `client:only` islands hydrate in an order nobody controls. If the
// surface publishes first, a later-mounting ShellNav would miss the event; if
// ShellNav mounts first, the event is all it needs. Both are covered: the
// module keeps the latest control in a module-level latch (the two islands
// share one instance of this module — it is one page, one ESM graph), and the
// chrome reads the latch on mount AND subscribes to the event.

/** One option in a realm-chrome picker. */
export interface RealmChromeOption {
  id: string;
  label: string;
}

/** The control a surface asks the chrome to render for it. */
export interface RealmChromeControl {
  /** The SectionId whose surface owns this. The chrome renders it only while
   *  standing in that realm, so a stale latch cannot leak across a hop. */
  realm: string;
  /** The control's accessible name — "Account". */
  label: string;
  options: RealmChromeOption[];
  selectedId: string;
}

/** Surface → chrome: "here is my control" (detail `{ realm }`). */
export const REALM_CHROME_EVENT = "bm:realm-chrome";

/** Chrome → surface: "the person picked this" (detail `{ realm, id }`). */
export const REALM_PICK_EVENT = "bm:realm-pick";

/** The latch. See the mount-race note above — not a cache, a rendezvous. */
let latest: RealmChromeControl | undefined;

/**
 * Offer a control to the chrome, or withdraw it with `undefined`.
 *
 * Fails soft the way `publishCollections` does: a surface may never break
 * over a nicety it is offering the chrome. Callers should withdraw on
 * unmount, and when the control stops being meaningful — Contacts publishes
 * nothing at all when the session reaches only one account, because a picker
 * with one option is a label pretending to be a choice.
 */
export function publishRealmChrome(control: RealmChromeControl | undefined): void {
  latest = control === undefined ? undefined : { ...control, options: [...control.options] };
  try {
    globalThis.dispatchEvent?.(new CustomEvent(REALM_CHROME_EVENT, { detail: { realm: control?.realm } }));
  } catch {
    /* no CustomEvent here — the latch above still answers the next mount */
  }
}

/** What is currently offered, if anything. The chrome's mount-time read. */
export function currentRealmChrome(): RealmChromeControl | undefined {
  return latest;
}

/** Chrome → surface. A plain event: no navigation, no history, no form. */
export function pickRealmChrome(realm: string, id: string): void {
  try {
    globalThis.dispatchEvent?.(new CustomEvent(REALM_PICK_EVENT, { detail: { realm, id } }));
  } catch {
    /* the surface simply keeps the account it had */
  }
}

/**
 * Should the chrome render this control right now?
 *
 * Two gates, both about not showing a control that means nothing: the realm
 * has to be the one being looked at, and there has to be something to pick
 * between. A one-option picker is the same lie as a disabled dropdown.
 */
export function isRenderableControl(
  control: RealmChromeControl | undefined,
  section: string | undefined,
): control is RealmChromeControl {
  if (control === undefined) return false;
  if (section !== undefined && control.realm !== section) return false;
  return control.options.length > 1;
}

/** Read a `bm:realm-pick` detail, or undefined if it is not one for `realm`.
 *  The surface's half of the contract, kept here so both ends share it. */
export function readRealmPick(event: Event, realm: string): string | undefined {
  const detail = (event as CustomEvent<{ realm?: unknown; id?: unknown }>).detail;
  if (detail === null || typeof detail !== "object") return undefined;
  if (detail.realm !== realm) return undefined;
  return typeof detail.id === "string" && detail.id.length > 0 ? detail.id : undefined;
}
