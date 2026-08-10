// An in-memory contacts server, wired onto the existing `FakeJmapClient`.
//
// Same two jobs as `../jmap/demo.ts` — tests, and a browsable `astro dev` — and
// the same discipline: **mirror the server's semantics, warts included.** A
// fake that is kinder than the real thing hides exactly the bugs it should
// catch. The ones deliberately reproduced here:
//
//   • `ContactCard/queryChanges` always throws `cannotCalculateChanges`, and
//     `query` reports `canCalculateChanges: false` (contacts.ts:558-561).
//   • the filter is a substring scan over the SAME six property groups the
//     server reaches — name, nickname, organization, email, phone, note — and
//     nothing else (`buildContactFilter`, mailstore:1811-1841).
//   • `limit` is clamped to 1..256 (mailstore:1737).
//   • `id` is server-set and `uid` is immutable (contacts.ts:351, 466-468).
//   • exactly one address book per card (`singleBookId`, contacts.ts:917-938).
//   • `ifInState` compares against ONE ACCOUNT-WIDE state, not a per-collection
//     one (contacts.ts:126, common.ts:144-148).
//   • `AddressBook/set` refuses grant-reached callers outright (contacts.ts:118-122),
//     and `allowedBookIds` hides books a grant does not name (principal.ts:345-354).
//
// It is installed with `setHandler` rather than added to `../jmap/demo.ts`
// because that module is shared with every other section; a contacts-shaped
// hole in it would collide with the calendar's. `createDemoBackend()` already
// hands back its `FakeJmapClient`, and `setHandler` is public
// (`../jmap/FakeJmapClient.ts:109-112`), so this composes.

import { FakeJmapClient, defaultSession, type MethodHandler } from "../jmap/FakeJmapClient";
import type { Session } from "../jmap/types";
import { displayName } from "./cards";
import type { AddressBook, AddressBookRights, ContactCard, SetError } from "./types";

const ACCOUNT = "acct-fake";

const OWNER_RIGHTS: AddressBookRights = {
  mayRead: true,
  mayWrite: true,
  mayShare: true,
  mayDelete: true,
};

/** What a sharee gets: read + write inside the book, never over the book. */
const SHAREE_RIGHTS: AddressBookRights = {
  mayRead: true,
  mayWrite: true,
  mayShare: false,
  mayDelete: false,
};

export interface ContactsDemoOptions {
  books?: AddressBook[];
  cards?: ContactCard[];
  /**
   * Simulate `allowedBookIds` (principal.ts:345-354): only these books exist
   * as far as this session is concerned. Everything else reads as absent
   * rather than as forbidden, which is what the server does — an out-of-grant
   * card must not leak its existence (contacts.ts:459-460).
   */
  allowedBookIds?: string[];
  /** false → `AddressBook/set` refuses, exactly as it does for a grant. */
  mayManageBooks?: boolean;
}

export interface ContactsDemoBackend {
  books: AddressBook[];
  cards: ContactCard[];
  state(): string;
}

// ── fixtures ──────────────────────────────────────────────────────────────

export function demoAddressBooks(): AddressBook[] {
  return [
    {
      id: "ab-personal",
      name: "Personal",
      description: null,
      sortOrder: 0,
      isDefault: true,
      isSubscribed: true,
      shareWith: null,
      myRights: OWNER_RIGHTS,
    },
    {
      id: "ab-work",
      name: "Work",
      description: "People from the day job",
      sortOrder: 1,
      isDefault: false,
      isSubscribed: true,
      shareWith: null,
      myRights: OWNER_RIGHTS,
    },
  ];
}

/**
 * Cards chosen to be structurally awkward on purpose, because a fixture that
 * is only `{ name, email }` proves nothing about a JSContact form:
 *
 *   • Ada has an `anniversaries` entry, a `media` photo and a `vCardProps`
 *     tail — none of which the form renders, all of which must survive an
 *     edit. That is the round-trip claim, made checkable.
 *   • Grace's email entry carries `pref` and a `label`, so the "keep the
 *     entry's unknown fields and its KEY" rule has something to lose.
 *   • Katherine has two organizations, so the singleton organization field
 *     has a second entry it must not eat.
 *   • "Project Elk" is a GROUP: `kind: "group"` plus `members` keyed by the
 *     members' **uids**, which is the thing that is easy to get wrong.
 */
export function demoContactCards(): ContactCard[] {
  return [
    {
      id: "cc-ada",
      uid: "urn:uuid:ada",
      "@type": "Card",
      version: "1.0",
      kind: "individual",
      created: "2026-01-04T09:00:00Z",
      updated: "2026-05-02T11:30:00Z",
      name: {
        full: "Ada Lovelace",
        components: [
          { kind: "given", value: "Ada" },
          { kind: "surname", value: "Lovelace" },
          { kind: "credential", value: "FRS" },
        ],
      },
      emails: { email1: { address: "ada@example.test", contexts: { private: true } } },
      phones: { phone1: { number: "+44 20 7946 0001", features: { mobile: true } } },
      addresses: {
        addr1: {
          components: [
            { kind: "name", value: "12 St James's Square" },
            { kind: "locality", value: "London" },
            { kind: "postcode", value: "SW1Y 4LE" },
            { kind: "country", value: "United Kingdom" },
          ],
          contexts: { private: true },
        },
      },
      notes: { note1: { note: "Wrote the first algorithm." } },
      anniversaries: { anniv1: { kind: "birth", date: { year: 1815, month: 12, day: 10 } } },
      media: { photo1: { kind: "photo", uri: "https://example.test/ada.jpg" } },
      vCardProps: [["x-abshowas", {}, "unknown", "PERSON"]],
      addressBookIds: { "ab-personal": true },
    },
    {
      id: "cc-grace",
      uid: "urn:uuid:grace",
      "@type": "Card",
      version: "1.0",
      created: "2026-02-11T14:00:00Z",
      updated: "2026-06-19T08:05:00Z",
      name: {
        full: "Grace Hopper",
        components: [
          { kind: "given", value: "Grace" },
          { kind: "surname", value: "Hopper" },
        ],
      },
      organizations: { org1: { name: "Project Elk" } },
      emails: {
        email1: { address: "grace@example.test", contexts: { work: true }, pref: 1, label: "desk" },
      },
      phones: { phone1: { number: "+1 202 555 0147", features: { voice: true } } },
      notes: { note1: { note: "Prefers a phone call to a thread." } },
      addressBookIds: { "ab-work": true },
    },
    {
      id: "cc-katherine",
      uid: "urn:uuid:katherine",
      "@type": "Card",
      version: "1.0",
      created: "2026-03-01T10:00:00Z",
      updated: "2026-03-01T10:00:00Z",
      name: {
        full: "Katherine Johnson",
        components: [
          { kind: "given", value: "Katherine" },
          { kind: "surname", value: "Johnson" },
        ],
      },
      organizations: {
        org1: { name: "Flight Research Division" },
        org2: { name: "West Area Computers" },
      },
      emails: { email1: { address: "katherine@example.test", contexts: { work: true } } },
      addressBookIds: { "ab-work": true },
    },
    {
      id: "cc-supplier",
      uid: "urn:uuid:supplier",
      "@type": "Card",
      version: "1.0",
      kind: "org",
      created: "2026-04-20T16:00:00Z",
      updated: "2026-04-20T16:00:00Z",
      name: { full: "Babbage Instruments" },
      organizations: { org1: { name: "Babbage Instruments" } },
      emails: { email1: { address: "orders@babbage.test", contexts: { work: true } } },
      addressBookIds: { "ab-work": true },
    },
    {
      id: "cc-elk",
      uid: "urn:uuid:elk",
      "@type": "Card",
      version: "1.0",
      kind: "group",
      created: "2026-05-05T12:00:00Z",
      updated: "2026-06-01T12:00:00Z",
      name: { full: "Project Elk" },
      // Keyed by the members' UIDs, never their JMAP ids (RFC 9553 §2.1.5).
      // The third one is deliberately dangling: destroying a card does not
      // clean up groups that name it (contacts.ts:499-511).
      members: {
        "urn:uuid:grace": true,
        "urn:uuid:katherine": true,
        "urn:uuid:departed": true,
      },
      addressBookIds: { "ab-work": true },
    },
  ];
}

/**
 * A session where the only reachable account is someone ELSE'S, reached
 * through a grant. This is the shape `session.ts:22-42` builds for a
 * book-scoped grant: `isPersonal: false`, contacts capability only — and note
 * that `primaryAccounts` still points at the owner's account, which is `""`
 * for a principal that owns none (`session.ts:61`). Driving that path is the
 * whole point: `primaryAccountId()` throws on it (JmapClient.ts:176-181).
 */
export function sharedAccountSession(): Session {
  const base = defaultSession();
  const contactsOnly = { "urn:ietf:params:jmap:contacts": { maxAddressBooksPerCard: 1 } };
  return {
    ...base,
    accounts: {
      [ACCOUNT]: {
        name: "shared@bullmoose.test",
        isPersonal: false,
        isReadOnly: false,
        accountCapabilities: contactsOnly,
      },
    },
    primaryAccounts: { ...base.primaryAccounts, "urn:ietf:params:jmap:contacts": "" },
  };
}

// ── the backend ───────────────────────────────────────────────────────────

export function installContactsDemo(
  client: FakeJmapClient,
  opts: ContactsDemoOptions = {},
): ContactsDemoBackend {
  const allBooks = opts.books ?? demoAddressBooks();
  const cards = opts.cards ?? demoContactCards();
  const allowed = opts.allowedBookIds ? new Set(opts.allowedBookIds) : null;
  const mayManageBooks = opts.mayManageBooks !== false;

  // The grant view: a restricted session sees only the named books, with
  // sharee rights on them.
  const visibleBooks = (): AddressBook[] =>
    allBooks
      .filter((b) => !allowed || allowed.has(b.id))
      .map((b) => (allowed ? { ...b, myRights: SHAREE_RIGHTS, shareWith: null } : b));
  const canSee = (bookId: string | undefined): boolean =>
    bookId !== undefined && (!allowed || allowed.has(bookId));
  const visibleCards = (): ContactCard[] => cards.filter((c) => canSee(bookIdOf(c)));

  let stateCounter = 0;
  const state = (): string => String(stateCounter);
  const bump = (): string => String(++stateCounter);

  const guardState = (args: Record<string, unknown>): boolean =>
    typeof args.ifInState === "string" && args.ifInState !== state();

  const handlers: Record<string, MethodHandler> = {
    "AddressBook/get": (args) => {
      const ids = args.ids as string[] | null | undefined;
      const rows = visibleBooks().filter((b) => !ids || ids.includes(b.id));
      return {
        accountId: ACCOUNT,
        state: state(),
        list: rows,
        notFound: (ids ?? []).filter((id) => !rows.some((b) => b.id === id)),
      };
    },

    "AddressBook/set": (args) => {
      // The whole method, refused — not per object. A sharee manages cards,
      // never books (contacts.ts:117-122).
      if (!mayManageBooks) {
        return ["error", { type: "forbidden", description: "only the account owner manages address books" }];
      }
      if (guardState(args)) return ["error", { type: "stateMismatch" }];

      const oldState = state();
      const created: Record<string, unknown> = {};
      const notCreated: Record<string, SetError> = {};
      const updated: Record<string, null> = {};
      const notUpdated: Record<string, SetError> = {};
      const destroyed: string[] = [];
      const notDestroyed: Record<string, SetError> = {};

      for (const [cid, spec] of Object.entries(
        (args.create as Record<string, Record<string, unknown>>) ?? {},
      )) {
        const name = spec.name;
        if (typeof name !== "string" || name.length === 0) {
          notCreated[cid] = { type: "invalidProperties", properties: ["name"] };
          continue;
        }
        const book: AddressBook = {
          id: `ab-${allBooks.length + 1}-${name.toLowerCase().replace(/\W+/g, "-")}`,
          name,
          description: (spec.description as string | null) ?? null,
          sortOrder: (spec.sortOrder as number) ?? 0,
          isDefault: !allBooks.some((b) => b.isDefault),
          isSubscribed: true,
          shareWith: null,
          myRights: OWNER_RIGHTS,
        };
        allBooks.push(book);
        created[cid] = { id: book.id, isDefault: book.isDefault, myRights: OWNER_RIGHTS };
      }

      for (const [id, patch] of Object.entries(
        (args.update as Record<string, Record<string, unknown>>) ?? {},
      )) {
        const book = allBooks.find((b) => b.id === id);
        if (!book) {
          notUpdated[id] = { type: "notFound" };
          continue;
        }
        if (typeof patch.name === "string") book.name = patch.name;
        if (patch.description !== undefined) book.description = patch.description as string | null;
        if (typeof patch.sortOrder === "number") book.sortOrder = patch.sortOrder;
        updated[id] = null;
      }

      for (const id of (args.destroy as string[] | undefined) ?? []) {
        const index = allBooks.findIndex((b) => b.id === id);
        if (index < 0) {
          notDestroyed[id] = { type: "notFound" };
          continue;
        }
        const contents = cards.filter((c) => bookIdOf(c) === id);
        if (contents.length > 0 && args.onDestroyRemoveContents !== true) {
          notDestroyed[id] = { type: "addressBookHasContents" };
          continue;
        }
        // One book per card, so removing the book destroys them
        // (contacts.ts:190-192).
        for (const card of contents) cards.splice(cards.indexOf(card), 1);
        allBooks.splice(index, 1);
        destroyed.push(id);
      }

      const touched =
        Object.keys(created).length + Object.keys(updated).length + destroyed.length > 0;
      return {
        accountId: ACCOUNT,
        oldState,
        newState: touched ? bump() : oldState,
        created,
        notCreated,
        updated,
        notUpdated,
        destroyed,
        notDestroyed,
      };
    },

    "ContactCard/get": (args) => {
      const ids = args.ids as string[] | null | undefined;
      const properties = args.properties as string[] | undefined;
      const rows = visibleCards().filter((c) => !ids || ids.includes(c.id));
      return {
        accountId: ACCOUNT,
        state: state(),
        list: rows.map((c) => project(c, properties)),
        notFound: (ids ?? []).filter((id) => !rows.some((c) => c.id === id)),
      };
    },

    "ContactCard/query": (args) => {
      const filter = (args.filter as DemoFilter | null) ?? null;
      const matched = visibleCards().filter((c) => matches(c, filter));
      matched.sort(sorter(args.sort as Array<{ property: string; isAscending: boolean }> | undefined));
      const position = Math.max(0, typeof args.position === "number" ? args.position : 0);
      const limit = Math.min(Math.max(1, typeof args.limit === "number" ? args.limit : 100), 256);
      return {
        accountId: ACCOUNT,
        queryState: state(),
        canCalculateChanges: false,
        position,
        ids: matched.slice(position, position + limit).map((c) => c.id),
        ...(args.calculateTotal === true ? { total: matched.length } : {}),
      };
    },

    // Registered only to answer per spec; it always throws (contacts.ts:559-561).
    "ContactCard/queryChanges": () => ["error", { type: "cannotCalculateChanges" }],

    "ContactCard/set": (args) => {
      if (guardState(args)) return ["error", { type: "stateMismatch" }];

      const oldState = state();
      const created: Record<string, unknown> = {};
      const notCreated: Record<string, SetError> = {};
      const updated: Record<string, null> = {};
      const notUpdated: Record<string, SetError> = {};
      const destroyed: string[] = [];
      const notDestroyed: Record<string, SetError> = {};
      let seq = cards.length;

      for (const [cid, spec] of Object.entries(
        (args.create as Record<string, Record<string, unknown>>) ?? {},
      )) {
        if (spec.id !== undefined) {
          notCreated[cid] = { type: "invalidProperties", description: "id is server-set", properties: ["id"] };
          continue;
        }
        const { addressBookIds, ...rest } = spec;
        let bookId: string | undefined;
        if (addressBookIds === undefined) {
          const writable = visibleBooks().filter((b) => b.myRights.mayWrite);
          bookId = allowed
            ? writable.length === 1
              ? writable[0]?.id
              : undefined
            : (writable.find((b) => b.isDefault) ?? writable[0])?.id;
          if (!bookId) {
            notCreated[cid] = {
              type: "invalidProperties",
              description: "addressBookIds is required",
              properties: ["addressBookIds"],
            };
            continue;
          }
        } else {
          const truthy = Object.entries((addressBookIds as Record<string, unknown>) ?? {})
            .filter(([, v]) => v === true)
            .map(([k]) => k);
          if (truthy.length !== 1) {
            notCreated[cid] = {
              type: "invalidProperties",
              description: "this server supports exactly one address book per card",
              properties: ["addressBookIds"],
            };
            continue;
          }
          bookId = truthy[0];
        }
        if (!canSee(bookId) || !visibleBooks().find((b) => b.id === bookId)?.myRights.mayWrite) {
          notCreated[cid] = { type: "forbidden", description: "no write grant on this address book" };
          continue;
        }
        const now = new Date().toISOString();
        const card: ContactCard = {
          ...(rest as ContactCard),
          id: `cc-demo-${++seq}`,
          "@type": "Card",
          version: "1.0",
          uid: typeof rest.uid === "string" ? rest.uid : `urn:uuid:demo-${seq}`,
          created: now,
          updated: now,
          addressBookIds: { [bookId as string]: true },
        };
        if (cards.some((c) => c.uid === card.uid)) {
          notCreated[cid] = {
            type: "invalidProperties",
            description: `uid already in use: ${card.uid}`,
            properties: ["uid"],
          };
          continue;
        }
        cards.push(card);
        created[cid] = { id: card.id, uid: card.uid, created: card.created, updated: card.updated };
      }

      for (const [id, patch] of Object.entries(
        (args.update as Record<string, Record<string, unknown>>) ?? {},
      )) {
        const card = cards.find((c) => c.id === id && canSee(bookIdOf(c)));
        if (!card) {
          notUpdated[id] = { type: "notFound" };
          continue;
        }
        const problem = applyPatch(card, patch);
        if (problem) {
          notUpdated[id] = { type: "invalidProperties", description: problem };
          continue;
        }
        card.updated = new Date().toISOString();
        updated[id] = null;
      }

      for (const id of (args.destroy as string[] | undefined) ?? []) {
        const index = cards.findIndex((c) => c.id === id && canSee(bookIdOf(c)));
        if (index < 0) notDestroyed[id] = { type: "notFound" };
        else {
          cards.splice(index, 1);
          destroyed.push(id);
        }
      }

      const touched =
        Object.keys(created).length + Object.keys(updated).length + destroyed.length > 0;
      return {
        accountId: ACCOUNT,
        oldState,
        newState: touched ? bump() : oldState,
        created,
        notCreated,
        updated,
        notUpdated,
        destroyed,
        notDestroyed,
      };
    },
  };

  for (const [name, handler] of Object.entries(handlers)) client.setHandler(name, handler);
  return { books: allBooks, cards, state };
}

/**
 * The client the contacts page runs against in demo mode, plus the one demo
 * knob this section adds: `?shared=1`.
 *
 * That knob exists for the same reason `?agentcap=0` does in `../app/client.ts:66-71`
 * — a refusal path that is only unit-tested is a refusal path nobody has ever
 * SEEN. Restricted contact access has three visible consequences (fewer books,
 * no book management, cards outside the grant reading as absent) and all three
 * are otherwise unreachable in a browser.
 *
 * The shared case needs its own session, not just its own handlers, because
 * `isPersonal` and the empty contacts `primaryAccounts` entry are session
 * facts (`services/jmap/src/session.ts:22-42,61`).
 */
export function contactsDemoClient(demoClient: FakeJmapClient, search: string): FakeJmapClient {
  if (new URLSearchParams(search).get("shared") !== "1") {
    installContactsDemo(demoClient);
    return demoClient;
  }
  const shared = new FakeJmapClient({ session: sharedAccountSession() });
  installContactsDemo(shared, { allowedBookIds: ["ab-work"], mayManageBooks: false });
  return shared;
}

// ── server-behaviour mirrors ──────────────────────────────────────────────

function bookIdOf(card: ContactCard): string | undefined {
  return Object.entries(card.addressBookIds ?? {}).find(([, v]) => v === true)?.[0];
}

function project(card: ContactCard, properties: string[] | undefined): ContactCard {
  if (!properties) return card;
  const out: Record<string, unknown> = { id: card.id };
  for (const p of properties) if (p in card) out[p] = card[p];
  return out as ContactCard;
}

interface DemoFilterCondition {
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
}
type DemoFilter = DemoFilterCondition | { operator: "AND" | "OR" | "NOT"; conditions: DemoFilter[] };

/** Mirrors `buildContactFilter` (mailstore:1762-1843). */
function matches(card: ContactCard, filter: DemoFilter | null): boolean {
  if (!filter) return true;
  if ("operator" in filter) {
    const parts = filter.conditions.map((c) => matches(card, c));
    if (filter.operator === "AND") return parts.every(Boolean);
    if (filter.operator === "OR") return parts.some(Boolean);
    return !parts.some(Boolean);
  }

  const c = filter;
  const like = (haystack: string | undefined, needle: string): boolean =>
    typeof haystack === "string" && haystack.toLowerCase().includes(needle.toLowerCase());
  const anyOf = (map: unknown, fields: string[], needle: string): boolean =>
    values(map).some((entry) => fields.some((f) => like(entry[f] as string | undefined, needle)));
  const nameHit = (needle: string): boolean =>
    like(card.name?.full, needle) ||
    (card.name?.components ?? []).some((comp) => like(comp.value, needle));

  if (c.inAddressBook !== undefined && bookIdOf(card) !== c.inAddressBook) return false;
  if (c.uid !== undefined && card.uid !== c.uid) return false;
  // JSContact defaults `kind` to individual when absent (mailstore:1786-1789).
  if (c.kind !== undefined && (card.kind ?? "individual") !== c.kind) return false;
  if (c.hasMember !== undefined && card.members?.[c.hasMember] !== true) return false;
  if (c.name !== undefined && !nameHit(c.name)) return false;
  if (c.nickname !== undefined && !anyOf(card.nicknames, ["name"], c.nickname)) return false;
  if (c.organization !== undefined && !anyOf(card.organizations, ["name"], c.organization)) {
    return false;
  }
  if (c.email !== undefined && !anyOf(card.emails, ["address", "label"], c.email)) return false;
  if (c.phone !== undefined && !anyOf(card.phones, ["number", "label"], c.phone)) return false;
  if (c.note !== undefined && !anyOf(card.notes, ["note"], c.note)) return false;
  if (c.text !== undefined) {
    const hit =
      nameHit(c.text) ||
      anyOf(card.nicknames, ["name"], c.text) ||
      anyOf(card.organizations, ["name"], c.text) ||
      anyOf(card.emails, ["address", "label"], c.text) ||
      anyOf(card.phones, ["number", "label"], c.text) ||
      anyOf(card.notes, ["note"], c.text);
    if (!hit) return false;
  }
  return true;
}

function sorter(sort: Array<{ property: string; isAscending: boolean }> | undefined) {
  const specs = sort ?? [{ property: "name", isAscending: true }];
  return (a: ContactCard, b: ContactCard): number => {
    for (const s of specs) {
      const dir = s.isAscending ? 1 : -1;
      let cmp = 0;
      if (s.property === "name") cmp = displayName(a).localeCompare(displayName(b));
      else if (s.property === "created") cmp = Date.parse(a.created ?? "") - Date.parse(b.created ?? "");
      else if (s.property === "updated") cmp = Date.parse(a.updated ?? "") - Date.parse(b.updated ?? "");
      if (cmp !== 0) return cmp * dir;
    }
    return a.id.localeCompare(b.id);
  };
}

/**
 * Mirrors `applyCardPatch` (contacts.ts:975-1004): each key is an RFC 6901
 * pointer minus the leading slash, `null` removes, and a path whose parent is
 * absent is an error rather than an implicit create. Returns a problem string
 * or null.
 */
function applyPatch(card: ContactCard, patch: Record<string, unknown>): string | null {
  const next = structuredClone(card) as Record<string, unknown>;
  for (const [path, value] of Object.entries(patch)) {
    const tokens = path.split("/").map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (tokens.some((t) => t.length === 0)) return `bad patch path "${path}"`;
    let parent = next;
    for (const token of tokens.slice(0, -1)) {
      const child = parent[token];
      if (child === null || typeof child !== "object" || Array.isArray(child)) {
        return `patch path "${path}" does not exist`;
      }
      parent = child as Record<string, unknown>;
    }
    const leaf = tokens[tokens.length - 1] as string;
    if (value === null) delete parent[leaf];
    else parent[leaf] = value;
  }
  if (next.id !== card.id) return "id is immutable";
  if (next.uid !== card.uid) return "uid is immutable";
  for (const key of Object.keys(card)) delete (card as Record<string, unknown>)[key];
  Object.assign(card, next);
  return null;
}

function values(map: unknown): Array<Record<string, unknown>> {
  if (map === null || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.values(map as Record<string, unknown>).filter(
    (v): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v),
  );
}
