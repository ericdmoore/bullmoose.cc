// The card list: `ContactCard/query` + `ContactCard/get`, and an honest
// account of what that search actually does.
//
// ⚠️ **Contacts search is a full table scan.** `queryContactCards`
// (`packages/mailstore/src/index.ts:1715-1760`) builds a `WHERE` of `LIKE`
// clauses over `json_each` extractions of every card's blob — no index, no
// FTS5, one row read per card in the account per keystroke-triggered query.
// This is the exact pattern `.feedback common/004` removed from mail, and the
// s07 devPlan says so in as many words (devPlan.md:437-441): mail is indexed,
// "contacts | full-scan LIKE — queryContactCards, the exact pattern just
// removed from mail".
//
// The consequence for THIS file is a design rule, not a disclaimer: do not
// build a UI whose shape promises something the query cannot deliver. So there
// is no search-as-you-type here (the search is submitted), the page size stays
// small, and `CONTACT_SEARCH_COST_NOTE` says out loud that the cost grows with
// the size of the address book. A 50K-card account is the case that bites, and
// it was flagged when common/004 landed.
//
// The honesty-note pattern is the one `AppShell.tsx:577-591` and
// `../mail/search.ts:60-65` already use: the sentence lives next to the box,
// it names what the server really matches, and this module is the single place
// to change when the server changes.

import type { JmapClient } from "../jmap/JmapClient";
import type { ContactCard } from "./types";

/** Mirrors `ContactFilterCondition` (`packages/mailstore/src/index.ts:311-327`). */
export interface ContactFilterCondition {
  inAddressBook?: string;
  uid?: string;
  kind?: string;
  hasMember?: string;
  text?: string;
  name?: string;
  nickname?: string;
  organization?: string;
  email?: string;
  phone?: string;
  note?: string;
  createdBefore?: string;
  createdAfter?: string;
  updatedBefore?: string;
  updatedAfter?: string;
}

export interface ContactFilterOperator {
  operator: "AND" | "OR" | "NOT";
  conditions: ContactFilter[];
}

export type ContactFilter = ContactFilterOperator | ContactFilterCondition;

/**
 * The only three sort properties the server accepts (contacts.ts:1070-1082):
 * `created`/`updated` are the RFC 9610 MUSTs and `name` is a vendor
 * convenience over the extracted `name_full` column. Anything else comes back
 * as `unsupportedSort`, so do not offer one.
 */
export type ContactSortProperty = "name" | "created" | "updated";

export interface ContactSearchSpec {
  /** Free text → the server's `text` condition. */
  text?: string;
  /** Restrict to one address book. */
  inBook?: string;
  /** `individual` | `group` | … — the `kind` condition (contacts.ts:1786-1789). */
  kind?: string;
  /** Cards belonging to this GROUP, by the group's uid. See `groups.ts`. */
  hasMember?: string;
}

/**
 * Exactly the JSON paths the server's `text` condition reaches
 * (`buildContactFilter`, mailstore:1830-1841). Notably ABSENT: addresses,
 * links, online services, titles and any custom `vCardProps` — a card found
 * only by its street address will not be found at all.
 */
export const CONTACT_TEXT_FIELDS = ["name", "nickname", "organization", "email", "phone", "note"] as const;

/** The sentence the search box shows. Short, and true. */
export const CONTACT_SEARCH_SCOPE_NOTE =
  "Searches names, nicknames, organizations, email addresses, phone numbers and notes — " +
  "matching anywhere inside a value. Street addresses, job titles and links are not searched.";

/**
 * The second sentence, and the one that is a scaling claim rather than a
 * coverage claim. Kept separate so a caller can render it once, quietly,
 * without repeating it under every result.
 */
export const CONTACT_SEARCH_COST_NOTE =
  "Contacts are not indexed: each search reads every card in the account, so it gets slower " +
  "as the address book grows. Mail's full-text index has no contacts equivalent yet (s07 T6).";

/**
 * Build the `ContactCard/query` filter. `null` for an empty spec — the
 * "everything" filter — rather than `{}`, which would be a condition object
 * the server evaluates for nothing.
 */
export function buildContactFilter(spec: ContactSearchSpec): ContactFilter | null {
  const conditions: ContactFilterCondition[] = [];
  if (spec.inBook) conditions.push({ inAddressBook: spec.inBook });
  if (nonEmpty(spec.text)) conditions.push({ text: spec.text.trim() });
  if (spec.kind) conditions.push({ kind: spec.kind });
  if (spec.hasMember) conditions.push({ hasMember: spec.hasMember });

  if (conditions.length === 0) return null;
  if (conditions.length === 1) return conditions[0] as ContactFilter;
  return { operator: "AND", conditions };
}

export function isEmptySearch(spec: ContactSearchSpec): boolean {
  return !nonEmpty(spec.text);
}

/** What the query in front of the user will really match, in a sentence. */
export function describeContactScope(spec: ContactSearchSpec, bookName?: string): string {
  const parts: string[] = [];
  if (nonEmpty(spec.text)) {
    parts.push(`“${spec.text.trim()}” anywhere in ${CONTACT_TEXT_FIELDS.join(", ")}`);
  }
  if (spec.kind === "group") parts.push("groups only");
  else if (spec.kind) parts.push(`kind “${spec.kind}”`);

  const where = bookName ? ` in “${bookName}”` : "";
  // A book on its own is not a filter the user typed — it is where they are
  // standing — so it must not turn "everything" into "matching".
  if (parts.length === 0) return `Showing every card${where}.`;
  return `Matching ${parts.join("; ")}${where}.`;
}

/**
 * The properties the LIST needs. Deliberately not the whole card: a card can
 * carry an inline photo, and `ContactCard/get` parses the blob per row
 * (contacts.ts:277-288), so asking for everything to render one line each is
 * how a page of 50 contacts becomes megabytes.
 *
 * ⚠️ This is NOT the skinny fast path. That one triggers only for
 * `id`/`uid`/`addressBookIds` alone (contacts.ts:267), and it exists for
 * sync-shaped scans; anything that shows a name pays the parse.
 */
export const CARD_LIST_PROPERTIES = [
  "id",
  "uid",
  "kind",
  "name",
  "emails",
  "phones",
  "organizations",
  "members",
  "addressBookIds",
] as const;

/** The server clamps `limit` to 1..256 (mailstore:1737). Ask inside that. */
export const CARD_PAGE_SIZE = 50;

export interface CardPage {
  cards: ContactCard[];
  /** Offset this page started at. */
  position: number;
  /** Present only when asked for — it costs a second full scan. */
  total?: number;
  /** The `queryState` the page was read at; feed it to `ifInState` on write. */
  queryState?: string;
}

export interface LoadCardsOptions {
  filter?: ContactFilter | null;
  sort?: ContactSortProperty;
  isAscending?: boolean;
  position?: number;
  limit?: number;
  /**
   * Ask the server to COUNT the matches. Off by default: `calculateTotal`
   * runs the same unindexed scan a second time (mailstore:1752-1758), so it is
   * a per-search cost, not a per-page one.
   */
  calculateTotal?: boolean;
}

/**
 * One page of cards in ONE round trip — `ContactCard/query` then
 * `ContactCard/get` of exactly the ids it returned, joined by an RFC 8620 §3.7
 * back-reference (`JmapClient.queryThenGet`, JmapClient.ts:242-274).
 *
 * `/get` answers in store order, not query order (the CLI hits the same thing,
 * `packages/cli/src/contacts.ts:328-330`), so the ids from the query are the
 * ordering and the get is only a lookup.
 */
export async function loadCards(client: JmapClient, accountId: string, opts: LoadCardsOptions = {}): Promise<CardPage> {
  const queryArgs: Record<string, unknown> = {
    filter: opts.filter ?? null,
    sort: [{ property: opts.sort ?? "name", isAscending: opts.isAscending !== false }],
    position: Math.max(0, opts.position ?? 0),
    limit: Math.min(Math.max(1, opts.limit ?? CARD_PAGE_SIZE), 256),
  };
  if (opts.calculateTotal) queryArgs.calculateTotal = true;

  const { query, get } = await client.queryThenGet(accountId, "ContactCard/query", queryArgs, "ContactCard/get", [
    ...CARD_LIST_PROPERTIES,
  ]);

  const ids = (query.ids as string[] | undefined) ?? [];
  const list = (get.list as ContactCard[] | undefined) ?? [];
  const byId = new Map(list.map((c) => [c.id, c]));
  const cards = ids.map((id) => byId.get(id)).filter((c): c is ContactCard => c !== undefined);

  return {
    cards,
    position: (query.position as number | undefined) ?? 0,
    ...(typeof query.total === "number" ? { total: query.total } : {}),
    ...(typeof query.queryState === "string" ? { queryState: query.queryState } : {}),
  };
}

/** The whole card, for the detail pane. One id, every property. */
export async function loadCard(client: JmapClient, accountId: string, id: string): Promise<ContactCard | undefined> {
  const result = await client.requestOne("ContactCard/get", { accountId, ids: [id] });
  return ((result.list as ContactCard[] | undefined) ?? [])[0];
}

/**
 * The display name, mirroring the server's `deriveNameFull`
 * (contacts.ts:1006-1031) so the browser sorts a list the same way the server
 * sorted the ids inside it: `name.full`, else the joined components, else the
 * first organization, else the first email address.
 *
 * ⚠️ A MIRROR, not the source of truth — the same trade-off `../mail/triage.ts:71-77`
 * documents for scopes. The server owns `name_full`; this only predicts it.
 */
export function displayName(card: ContactCard): string {
  const full = card.name?.full;
  if (typeof full === "string" && full.length > 0) return full;

  const joined = (card.name?.components ?? [])
    .filter((c) => c?.kind !== "separator" && typeof c?.value === "string")
    .map((c) => c.value)
    .join(" ")
    .trim();
  if (joined) return joined;

  for (const org of entryValues(card.organizations)) {
    if (typeof org.name === "string" && org.name) return org.name;
  }
  for (const email of entryValues(card.emails)) {
    if (typeof email.address === "string" && email.address) return email.address;
  }
  return "(unnamed)";
}

export function firstEmail(card: ContactCard): string | undefined {
  for (const email of entryValues(card.emails)) {
    if (typeof email.address === "string" && email.address) return email.address;
  }
  return undefined;
}

export function firstPhone(card: ContactCard): string | undefined {
  for (const phone of entryValues(card.phones)) {
    if (typeof phone.number === "string" && phone.number) return phone.number;
  }
  return undefined;
}

export function firstOrganization(card: ContactCard): string | undefined {
  for (const org of entryValues(card.organizations)) {
    if (typeof org.name === "string" && org.name) return org.name;
  }
  return undefined;
}

/** Values of a keyed JSContact map, skipping anything that is not an object. */
export function entryValues(map: unknown): Array<Record<string, unknown>> {
  if (map === null || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.values(map as Record<string, unknown>).filter(
    (v): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v),
  );
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}
