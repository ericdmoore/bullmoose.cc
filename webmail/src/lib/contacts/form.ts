// JSContact ⇄ edit form, and the patch that goes back.
//
// This is the module the whole section stands on, and the failure it exists to
// prevent is specific: **a form that flattens a JSContact Card cannot
// round-trip it.** The server stores `card_json` losslessly
// (`packages/mailstore/src/index.ts:166-183`) and hands the blob straight back
// (`services/jmap/src/methods/contacts.ts:609-615`), so every property this
// form does not render is still on the card — anniversaries, media, keywords,
// links, titles, `vCardProps` (the verbatim tail CardDAV uses to survive
// properties the converter does not map, `packages/contacts-core/src/index.ts:414-466`).
// Read a card into six text inputs, write the six inputs back as a whole card,
// and every one of those is silently deleted by a user who only fixed a typo.
//
// Two rules keep that from happening, and both are asserted in form.test.ts:
//
//  1. **The patch names only what changed.** `cardUpdatePatch` diffs the form
//     against the card it was read from and emits ONLY the differing top-level
//     properties (RFC 8620 §5.3 PatchObject; the server applies it with
//     `applyCardPatch`, contacts.ts:975-1004). A property the form never
//     mentions cannot be touched, whatever the form contains.
//  2. **Entry keys and unknown fields survive.** `emails`/`phones`/`addresses`
//     are objects keyed by an opaque id, and the key is load-bearing: CardDAV
//     round-trips Apple's `itemN.X-ABLABEL` label grouping through the entries
//     (contacts-core:287-294). So an edit rebuilds each entry as
//     `{ ...originalEntry, address: newValue }` under its ORIGINAL key, rather
//     than minting a fresh map.
//
// What the form deliberately does NOT edit: photos (a blob-upload path of its
// own, sVOL 022 bread-crumbs), anniversaries, and anything arriving in
// `vCardProps`. Not rendering them is honest; rewriting them blind is not.

import type { CardComponent, CardEntry, CardName, CardPatch, ContactCard } from "./types";

/** JSContact's two `contexts` keys, as `contacts-core` maps HOME/WORK. */
export type CardContext = "" | "work" | "private";

/**
 * One editable row of a keyed map. `key` is the entry's id in the JSContact
 * object — empty only for a row the user just added — and `rest` carries every
 * field of the source entry the form does not own (`pref`, `features`,
 * `label`, and anything a later RFC adds).
 */
export interface CardFormEntry {
  key: string;
  value: string;
  context: CardContext;
  rest: CardEntry;
}

/**
 * An address. Note that this is itself structured: JSContact 1.0 dropped
 * vCard's positional ADR in favour of `components: [{ kind, value }]`
 * (contacts-core:388-400 maps the seven ADR positions onto kinds), so "street"
 * here is the `name` component, not a free-text line.
 */
export interface CardFormAddress {
  key: string;
  street: string;
  locality: string;
  region: string;
  postcode: string;
  country: string;
  context: CardContext;
  /** Components the form does not own (`apartment`, `postOfficeBox`, …). */
  otherComponents: CardComponent[];
  rest: CardEntry;
}

export interface CardForm {
  /** `name.full` — the display name, and what the server sorts on. */
  full: string;
  given: string;
  surname: string;
  organization: string;
  note: string;
  emails: CardFormEntry[];
  phones: CardFormEntry[];
  addresses: CardFormAddress[];
}

/** The name components this form owns. Everything else is preserved as-is. */
const OWNED_NAME_KINDS = new Set(["given", "surname"]);

/** The address components this form owns, in vCard ADR order. */
const OWNED_ADDRESS_KINDS = ["name", "locality", "region", "postcode", "country"] as const;

export function blankForm(): CardForm {
  return {
    full: "",
    given: "",
    surname: "",
    organization: "",
    note: "",
    emails: [],
    phones: [],
    addresses: [],
  };
}

export function blankEntry(): CardFormEntry {
  return { key: "", value: "", context: "", rest: {} };
}

export function blankAddress(): CardFormAddress {
  return {
    key: "",
    street: "",
    locality: "",
    region: "",
    postcode: "",
    country: "",
    context: "",
    otherComponents: [],
    rest: {},
  };
}

/** Read a stored card into the form. Everything unowned rides along in `rest`. */
export function readCardForm(card: ContactCard): CardForm {
  return {
    full: typeof card.name?.full === "string" ? card.name.full : "",
    given: componentValue(card.name, "given"),
    surname: componentValue(card.name, "surname"),
    organization: firstScalar(card.organizations, "name"),
    note: firstScalar(card.notes, "note"),
    emails: readEntries(card.emails, "address"),
    phones: readEntries(card.phones, "number"),
    addresses: readAddresses(card.addresses),
  };
}

function readEntries(map: unknown, field: string): CardFormEntry[] {
  return mapEntries(map).map(([key, entry]) => ({
    key,
    value: typeof entry[field] === "string" ? (entry[field] as string) : "",
    context: readContext(entry),
    rest: withoutKeys(entry, [field, "contexts"]),
  }));
}

function readAddresses(map: unknown): CardFormAddress[] {
  return mapEntries(map).map(([key, entry]) => {
    const components = Array.isArray(entry.components)
      ? (entry.components as CardComponent[]).filter((c) => c !== null && typeof c === "object")
      : [];
    const owned = (kind: string): string => {
      const hit = components.find((c) => c.kind === kind && typeof c.value === "string");
      return (hit?.value as string | undefined) ?? "";
    };
    return {
      key,
      street: owned("name"),
      locality: owned("locality"),
      region: owned("region"),
      postcode: owned("postcode"),
      country: owned("country"),
      context: readContext(entry),
      otherComponents: components.filter(
        (c) => !(OWNED_ADDRESS_KINDS as readonly string[]).includes(String(c.kind)),
      ),
      rest: withoutKeys(entry, ["components", "contexts"]),
    };
  });
}

function readContext(entry: CardEntry): CardContext {
  const contexts = entry.contexts;
  if (contexts === null || typeof contexts !== "object") return "";
  const keys = Object.entries(contexts as Record<string, unknown>)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  if (keys.includes("work")) return "work";
  if (keys.includes("private")) return "private";
  return "";
}

// ── writing back ──────────────────────────────────────────────────────────

/**
 * The card properties this form owns. `cardUpdatePatch` will only ever emit
 * keys from this list, which is what makes "the form cannot delete what it
 * does not render" a property of the code rather than of the author's care.
 */
export const OWNED_PROPERTIES = [
  "name",
  "organizations",
  "notes",
  "emails",
  "phones",
  "addresses",
] as const;

/**
 * Build the owned properties from the form, starting from `base` (the card
 * being edited, or `{}` for a new one) so keys and unknown fields survive.
 * `undefined` means "this property should not exist".
 */
function buildOwned(form: CardForm, base: ContactCard): Record<string, unknown> {
  return {
    name: buildName(form, base.name),
    organizations: buildSingleton(base.organizations, "name", form.organization.trim(), "org"),
    notes: buildSingleton(base.notes, "note", form.note.trim(), "note"),
    emails: buildEntries(form.emails, "address", "email"),
    phones: buildEntries(form.phones, "number", "phone"),
    addresses: buildAddresses(form.addresses),
  };
}

function buildName(form: CardForm, base: CardName | undefined): CardName | undefined {
  const full = form.full.trim();
  const given = form.given.trim();
  const surname = form.surname.trim();

  // Preserve components the form does not own (title, credential, given2,
  // separator) in their original positions; an Apple card with a `credential`
  // component must not lose it because someone corrected a surname.
  const kept = (base?.components ?? []).filter((c) => !OWNED_NAME_KINDS.has(String(c.kind)));
  const owned: CardComponent[] = [];
  for (const [kind, value] of [
    ["given", given],
    ["surname", surname],
  ] as const) {
    if (!value) continue;
    const previous = (base?.components ?? []).find((c) => c.kind === kind);
    owned.push({ ...previous, kind, value });
  }
  const components = [...owned, ...kept];

  if (!full && components.length === 0) return undefined;
  const rest = withoutKeys((base ?? {}) as CardEntry, ["full", "components"]);
  return {
    ...rest,
    ...(full ? { full } : {}),
    ...(components.length > 0 ? { components } : {}),
  };
}

/**
 * Rebuild a map the form exposes as a SINGLE field (organization, note).
 *
 * The first entry is edited in place under its own key; any further entries
 * are preserved untouched, because a card synced from elsewhere can legally
 * carry three organizations and the form only shows one. Clearing the field
 * removes just that first entry, never the others.
 */
function buildSingleton(
  base: unknown,
  field: string,
  value: string,
  prefix: string,
): Record<string, CardEntry> | undefined {
  const entries = mapEntries(base);
  const [first, ...others] = entries;
  const out: Record<string, CardEntry> = {};

  if (value) {
    const key = first?.[0] ?? mintKey(prefix, entries.map(([k]) => k));
    out[key] = { ...(first?.[1] ?? {}), [field]: value };
  }
  for (const [key, entry] of others) out[key] = entry;
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildEntries(
  rows: CardFormEntry[],
  field: string,
  prefix: string,
): Record<string, CardEntry> | undefined {
  const out: Record<string, CardEntry> = {};
  const used = rows.map((r) => r.key).filter((k) => k !== "");
  for (const row of rows) {
    const value = row.value.trim();
    if (!value) continue; // an emptied row is a removal
    const key = row.key || mintKey(prefix, [...used, ...Object.keys(out)]);
    out[key] = {
      ...row.rest,
      [field]: value,
      ...contextsOf(row.context),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildAddresses(rows: CardFormAddress[]): Record<string, CardEntry> | undefined {
  const out: Record<string, CardEntry> = {};
  const used = rows.map((r) => r.key).filter((k) => k !== "");
  for (const row of rows) {
    const owned: CardComponent[] = [];
    const push = (kind: string, value: string): void => {
      if (value.trim()) owned.push({ kind, value: value.trim() });
    };
    push("name", row.street);
    push("locality", row.locality);
    push("region", row.region);
    push("postcode", row.postcode);
    push("country", row.country);

    const components = [...owned, ...row.otherComponents];
    if (components.length === 0) continue; // an emptied address is a removal
    const key = row.key || mintKey("addr", [...used, ...Object.keys(out)]);
    out[key] = { ...row.rest, components, ...contextsOf(row.context) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function contextsOf(context: CardContext): Record<string, unknown> {
  return context ? { contexts: { [context]: true } } : {};
}

/**
 * The `ContactCard/set create` spec for a new card.
 *
 * Nothing here sets `uid`, `created`, `updated`, `@type` or `version`: the
 * server mints and stamps all five (contacts.ts:376-392), and a client-supplied
 * `uid` only creates a way to collide with an existing card
 * (`invalidProperties: uid already in use`).
 */
export function cardCreateSpec(form: CardForm, bookId?: string): Record<string, unknown> {
  const owned = buildOwned(form, {} as ContactCard);
  const spec: Record<string, unknown> = {};
  for (const key of OWNED_PROPERTIES) {
    const value = owned[key];
    if (value !== undefined) spec[key] = value;
  }
  // Omitted entirely when there is no explicit target: the server resolves
  // the default book for an owner, and the single shared book for a restricted
  // writer (contacts.ts:356-367).
  if (bookId) spec.addressBookIds = { [bookId]: true };
  return spec;
}

/**
 * The `ContactCard/set update` patch: the differing owned properties, and
 * nothing else. `null` removes a property (RFC 8620 §5.3, applied at
 * contacts.ts:1000).
 *
 * `id` and `uid` are never emitted — both are immutable server-side
 * (contacts.ts:463-468) and a patch containing them fails the whole object.
 */
export function cardUpdatePatch(card: ContactCard, form: CardForm): CardPatch {
  const owned = buildOwned(form, card);
  const patch: CardPatch = {};
  for (const key of OWNED_PROPERTIES) {
    const next = owned[key];
    const previous = card[key];
    if (next === undefined) {
      // Only ask for a removal if there is something to remove; patching a
      // path that does not exist is a no-op here but noise on the wire.
      if (previous !== undefined) patch[key] = null;
      continue;
    }
    if (!deepEqual(next, previous)) patch[key] = next;
  }
  return patch;
}

/** Moving a card between books is a `addressBookIds` replace, not a merge. */
export function moveCardPatch(bookId: string): CardPatch {
  return { addressBookIds: { [bookId]: true } };
}

/**
 * What is wrong with this form, in sentences. The server itself validates
 * almost nothing about card CONTENT — it will happily store a card with no
 * name at all — so this is a usability guard, not a security one: a nameless,
 * emailless card renders as "(unnamed)" forever and is findable by nothing.
 */
export function formProblems(form: CardForm): string[] {
  const problems: string[] = [];
  const hasIdentity =
    form.full.trim() ||
    form.given.trim() ||
    form.surname.trim() ||
    form.organization.trim() ||
    form.emails.some((e) => e.value.trim());
  if (!hasIdentity) {
    problems.push("Give the contact at least a name, an organization or an email address.");
  }
  for (const email of form.emails) {
    const value = email.value.trim();
    // Deliberately permissive: JSContact does not require a routable address,
    // and a stricter check here would refuse addresses the mail server accepts.
    if (value && !value.includes("@")) {
      problems.push(`“${value}” is not an email address.`);
    }
  }
  return problems;
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Escape one token for an RFC 6901 JSON pointer path, which is what a JMAP
 * PatchObject key is. The server splits on `/` and then unescapes `~1`/`~0`
 * (contacts.ts:981-983), so a value containing a slash — a uid like
 * `http://example.test/card/7`, which vCard permits — corrupts the path
 * unless it is escaped first. Used by `groups.ts` for member uids.
 */
export function pointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** `[key, entry]` pairs of a keyed JSContact map, in stored order. */
function mapEntries(map: unknown): Array<[string, CardEntry]> {
  if (map === null || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.entries(map as Record<string, unknown>).filter(
    (pair): pair is [string, CardEntry] =>
      pair[1] !== null && typeof pair[1] === "object" && !Array.isArray(pair[1]),
  );
}

function componentValue(name: CardName | undefined, kind: string): string {
  const hit = (name?.components ?? []).find((c) => c?.kind === kind);
  return typeof hit?.value === "string" ? hit.value : "";
}

function firstScalar(map: unknown, field: string): string {
  const first = mapEntries(map)[0];
  const value = first?.[1][field];
  return typeof value === "string" ? value : "";
}

function withoutKeys(entry: CardEntry, keys: string[]): CardEntry {
  const out: CardEntry = {};
  for (const [k, v] of Object.entries(entry)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/** A key that does not collide with one already in the card. */
function mintKey(prefix: string, taken: string[]): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const candidate = `${prefix}${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Order-insensitive structural equality. Key order is not meaningful in JSON,
 * and `JSON.stringify` comparison would report a change every time a rebuilt
 * entry happened to serialize its keys differently — sending an unnecessary
 * write, which is the thing `ifInState` then makes fail for no reason.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}
