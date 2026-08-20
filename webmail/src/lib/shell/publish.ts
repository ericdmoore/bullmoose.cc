// The publish contract (s25 T4) — the one-way plumbing that lets the chrome's
// realm tray grow leaf-nodes without the chrome owning any realm's data.
//
// The tray is CHROME (ShellNav); collections live in the surface islands. So
// on load a surface PUBLISHES its collections — `{realm, items, at}` written
// to `bm.collections.<realm>` in localStorage, plus a `bm:collections`
// CustomEvent for live update — and the tray renders exactly what is
// published, nothing more. This is the `bm:search` spirit reversed: there the
// chrome talks to the active surface; here every surface leaves a note the
// chrome can read from ANY page.
//
// Staleness is honest by construction: `at` rides the record, `isStale` draws
// the 10-minute line, and the tray mutes a stale count and says "as of 9:12"
// rather than presenting last Tuesday's inbox as now. A realm that never
// published renders as a plain row — absence is not an error, it is a surface
// that has not been visited yet.
//
// Everything here is pure given its inputs (storage and clock injectable), so
// it tests in plain Node with the same stubs tokenInUrl.test.ts uses.

/** One leaf-node: a collection the tray can link straight into. */
export interface PublishedItem {
  id: string;
  label: string;
  /** Live count at publish time; absent and 0 both render nothing. */
  count?: number;
  /** Same-origin path the tray links to — always starts with a single "/".
   *  `readPublished` enforces that, so a poisoned localStorage cannot turn
   *  the tray into a `javascript:`/off-origin launcher. */
  href: string;
}

/** What a surface publishes: its realm's collections, and WHEN it said so. */
export interface PublishedCollections {
  realm: string;
  items: PublishedItem[];
  /** Epoch ms at publish — the tray's honesty about freshness. */
  at: number;
}

/** Dispatched (on globalThis, detail `{realm}`) after every publish, so an
 *  already-mounted tray repaints without a storage poll. */
export const COLLECTIONS_EVENT = "bm:collections";

/** Older than this and the tray mutes the counts: ten minutes, generous
 *  enough to survive a coffee, short enough that yesterday reads as stale. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

const storageKey = (realm: string): string => `bm.collections.${realm}`;

/**
 * Write the realm's collections where the tray can find them, and tell any
 * mounted tray. Both halves fail soft (private mode, no DOM): publishing is
 * a nicety the surface offers the chrome, never something a surface may
 * break over.
 */
export function publishCollections(realm: string, items: readonly PublishedItem[], at = Date.now()): void {
  const record: PublishedCollections = { realm, items: [...items], at };
  try {
    globalThis.localStorage?.setItem(storageKey(realm), JSON.stringify(record));
  } catch {
    /* private mode — the tray simply keeps its plain rows */
  }
  try {
    globalThis.dispatchEvent?.(new CustomEvent(COLLECTIONS_EVENT, { detail: { realm } }));
  } catch {
    /* no CustomEvent here — the write above still landed for the next mount */
  }
}

/**
 * What the realm last published, `at` included — or undefined for a realm
 * that never published, plus anything unreadable or mis-shaped (an older
 * contract, hand-edited storage). Items are individually validated and the
 * invalid ones DROPPED rather than failing the whole record: one bad row
 * should not blank a working tray.
 */
export function readPublished(realm: string): PublishedCollections | undefined {
  let raw: string | null;
  try {
    raw = globalThis.localStorage?.getItem(storageKey(realm)) ?? null;
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.realm !== realm) return undefined;
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return undefined;
  if (!Array.isArray(record.items)) return undefined;
  const items = record.items.filter(isSafeItem);
  return { realm, items, at: record.at };
}

/** A leaf the tray may render: real strings, and an href that is a same-origin
 *  PATH — starts with "/" but not "//" (protocol-relative escapes origin). */
function isSafeItem(candidate: unknown): candidate is PublishedItem {
  if (candidate === null || typeof candidate !== "object") return false;
  const item = candidate as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.label === "string" &&
    item.label.length > 0 &&
    typeof item.href === "string" &&
    item.href.startsWith("/") &&
    !item.href.startsWith("//") &&
    (item.count === undefined || (typeof item.count === "number" && Number.isFinite(item.count)))
  );
}

/** Ten minutes without a republish and the record is stale — mute it. */
export function isStale(published: Pick<PublishedCollections, "at">, now = Date.now()): boolean {
  return now - published.at > STALE_AFTER_MS;
}

/** "9:12" — the wall-clock stamp the tray shows beside a stale count. */
export function publishedAtLabel(at: number): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// ── URL plumbing the surfaces share (s25 T3) ────────────────────────────────
//
// Detail rows become REAL links — `/mail?thread=<id>` — so the browser back
// button just works. These build the hrefs; nothing here (or anywhere) calls
// history: MPA links are not history calls, which is how the ONE-history-call
// invariant of tokenInUrl.test.ts survives T3 untouched.

/**
 * A detail link built FROM the current query, so `?q=`/`?demo=` (and any
 * sibling selection like `?c=`) survive the hop. URLSearchParams end to end —
 * ids are encoded, never concatenated. `undefined` values drop the key
 * (a surface that has no mailbox yet must not mint `?c=undefined`).
 */
export function hrefWithParams(
  path: string,
  updates: Readonly<Record<string, string | undefined>>,
  search: string = globalThis.location?.search ?? "",
): string {
  const params = new URLSearchParams(search);
  for (const [name, value] of Object.entries(updates)) {
    if (value === undefined) params.delete(name);
    else params.set(name, value);
  }
  const q = params.toString();
  return q === "" ? path : `${path}?${q}`;
}

export function hrefWithParam(
  path: string,
  name: string,
  id: string,
  search: string = globalThis.location?.search ?? "",
): string {
  return hrefWithParams(path, { [name]: id }, search);
}

/**
 * A PUBLISHED collection link — `/mail?c=<id>`. Built fresh rather than from
 * the current query: a published href outlives the page that minted it, so
 * transient state (`?q=`, `?thread=`) must NOT ride along. Only `?demo=`
 * carries over — a demo session's tray should keep you in the demo instead
 * of bouncing every hop through the login door.
 */
export function publishedHref(
  path: string,
  collectionId: string,
  search: string = globalThis.location?.search ?? "",
): string {
  const params = new URLSearchParams();
  const demo = new URLSearchParams(search).get("demo");
  if (demo !== null) params.set("demo", demo);
  params.set("c", collectionId);
  return `${path}?${params.toString()}`;
}

/** One query param, read safely — the mount-time half of the T3 links. */
export function urlParam(name: string, search: string = globalThis.location?.search ?? ""): string | undefined {
  try {
    return new URLSearchParams(search).get(name) ?? undefined;
  } catch {
    return undefined;
  }
}
