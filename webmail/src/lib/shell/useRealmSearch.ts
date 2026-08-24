import { useEffect, useState } from "preact/hooks";
import { urlParam } from "./publish";

/**
 * The contextual bar's surface half, in one line (#225).
 *
 * s24 T5's rule was stated as UNIFORM — *"filter the ACTIVE realm's
 * collection"* — and shipped for five realms of eleven. The other six render
 * no bar, which is defensible per realm (a filter that filters nothing is
 * worse than none) and still leaves the plan's headline claim untrue.
 *
 * Every one of the five consumers wrote the same eight lines: read `?q=` at
 * mount for the deep link, subscribe to `bm:search`, trim, store. This is
 * those eight lines, once — so a realm joins the bar by calling a hook and
 * using the string, and no realm can get the deep-link half subtly wrong
 * while getting the event half right.
 */
export function useRealmSearch(): string {
  const [query, setQuery] = useState("");
  useEffect(() => {
    const q = urlParam("q");
    if (q) setQuery(q);
    const onSearch = (ev: Event) => setQuery(String((ev as CustomEvent<{ q?: string }>).detail?.q ?? "").trim());
    globalThis.addEventListener("bm:search", onSearch);
    return () => globalThis.removeEventListener("bm:search", onSearch);
  }, []);
  return query;
}

/**
 * The house match: case-insensitive substring over the fields a realm names
 * as its own. Whole-word matching is Mail's (it has an FTS index behind it);
 * a client-side list filter that demanded whole words would refuse "invo"
 * for "invoice", which is the opposite of what a filter box promises.
 */
export function matchesQuery(query: string, ...fields: Array<string | null | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(q));
}
