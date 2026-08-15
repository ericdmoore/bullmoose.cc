import type { MethodDomain } from "../auth";

/**
 * The explorer's type table and its `_links` derivation (s20).
 *
 * PURE — no env, no ctx, no I/O. Everything here is a rendering of a JMAP
 * payload that already exists, which is the whole argument for the explorer
 * over a second API: there is no schema to keep in sync, because there is no
 * schema. A `_links` entry is an id the object already carries, spelled as a
 * URL.
 *
 * ## The rule this file must not break
 *
 * `_links` is DERIVED FROM IDS IN THE PAYLOAD, never invented. Every builder
 * below reads a property of the object it was handed and emits nothing when
 * that property is absent or null. The test that keeps it honest is
 * `explore.test.ts`'s "every emitted link resolves": each href is fetched and
 * must return an object whose `id` is the one the link claimed. A fabricated
 * id 404s there rather than passing silently.
 *
 * ## What deliberately has no link
 *
 * `blobId` (on Email and on FileNode). A blob is not a JMAP object: there is
 * no `Blob/get` to call, and the byte stream lives behind
 * `app.bullmoose.cc/api/download/*` — the API origin, where the explore cookie
 * is refused BY DESIGN (see `cookieAuthAllowed`). A link there would be a link
 * a signed-in explorer cannot follow, which is worse than no link: "every link
 * resolves" is the property that makes this surface trustworthy. The id itself
 * stays in the payload, because JMAP put it there.
 */

/** One `_links` entry. Either an object link (`id`) or a collection (`list`). */
export interface ExploreLink {
  href: string;
  type: string;
  /** Object link: fetching `href` returns the object with this id. */
  id?: string;
  /** Collection link: fetching `href` returns a list of this type. */
  list?: true;
}

export type ExploreLinks = Record<string, ExploreLink | ExploreLink[]>;

/** Builds hrefs for one (base, account) pair; supplied by the HTTP layer. */
export interface LinkBuilder {
  object(type: string, id: string): ExploreLink;
  collection(type: string, filter: Record<string, string>): ExploreLink;
}

export interface TypeSpec {
  readonly type: string;
  /**
   * The grant domain the JMAP method gates on. Only matters for
   * grant-reached accounts (an AddressBook-scoped grant unlocks `contacts`
   * methods only) — but it is what `_meta` reports, so it is recorded here
   * rather than restated in prose.
   */
  readonly domain: MethodDomain;
  /**
   * The scope(s) `requireAccount` charges for these reads. Every projected
   * method charges exactly `read`: this surface calls no write method, so
   * there is no verb here that a read-only credential could not satisfy.
   */
  readonly scopes: readonly string[];
  /** The JMAP method that returns objects by id. */
  readonly get: string;
  /** The JMAP method that pages ids, when the collection has one. */
  readonly query?: string;
  /**
   * `false` means JMAP offers no way to enumerate this type at all, so the
   * explorer refuses rather than inventing one. Today that is `Thread`.
   */
  readonly listable: boolean;
  /**
   * URL query parameters accepted on the list endpoint. Each maps 1:1 onto a
   * JMAP FilterCondition property OF THE SAME NAME — the explorer renames
   * nothing, so a filter that works here works verbatim over `/api/jmap`.
   */
  readonly filters: readonly string[];
  /** Shown in `_meta` when a request cannot be served the obvious way. */
  readonly note?: string;
}

/**
 * The projected types.
 *
 * Deliberately small and honest. What is NOT here, and why:
 *
 *  - `Identity`, `EmailSubmission`, `VacationResponse` — outbound-side
 *    objects. Reading them is harmless, but they carry no ids that link
 *    anywhere, so they would be flat JSON with an empty `_links`: nothing the
 *    explorer adds over `/api/jmap`.
 *  - `AgentInvocation`, `ActionProposal` — the agent plane already has a
 *    purpose-built read surface at `app.bullmoose.cc/console/*` (s03.E) that
 *    knows how to summarise it. A second, dumber projection would compete.
 *  - `Blob` — not a JMAP object; see the file header.
 */
export const TYPES: Readonly<Record<string, TypeSpec>> = {
  Email: {
    type: "Email",
    domain: "mail",
    scopes: ["read"],
    get: "Email/get",
    query: "Email/query",
    listable: true,
    filters: ["inMailbox", "text", "from", "to", "subject", "hasKeyword", "notKeyword"],
  },
  Mailbox: {
    type: "Mailbox",
    domain: "mail",
    scopes: ["read"],
    get: "Mailbox/get",
    query: "Mailbox/query",
    listable: true,
    filters: ["parentId", "role", "name"],
  },
  Thread: {
    type: "Thread",
    domain: "mail",
    scopes: ["read"],
    get: "Thread/get",
    listable: false,
    filters: [],
    // RFC 8621 defines no Thread/query, and this server has no thread-level
    // state to enumerate (see methods/thread.ts). Inventing a list would mean
    // reading the store behind the methods' backs — precisely the thing s19
    // forbids. Reach a Thread from an Email's `_links.thread` instead.
    note: "JMAP has no Thread/query; reach a Thread from an Email's _links.thread",
  },
  ContactCard: {
    type: "ContactCard",
    domain: "contacts",
    scopes: ["read"],
    get: "ContactCard/get",
    query: "ContactCard/query",
    listable: true,
    filters: ["inAddressBook", "text", "name", "email", "uid", "kind"],
  },
  AddressBook: {
    type: "AddressBook",
    domain: "contacts",
    scopes: ["read"],
    get: "AddressBook/get",
    listable: true,
    filters: [],
    note: "no AddressBook/query in JMAP; the whole set is returned unpaged",
  },
  Calendar: {
    type: "Calendar",
    domain: "calendar",
    scopes: ["read"],
    get: "Calendar/get",
    listable: true,
    filters: [],
    note: "no Calendar/query in JMAP; the whole set is returned unpaged",
  },
  CalendarEvent: {
    type: "CalendarEvent",
    domain: "calendar",
    scopes: ["read"],
    get: "CalendarEvent/get",
    query: "CalendarEvent/query",
    listable: true,
    filters: ["inCalendar", "after", "before", "text", "title", "uid"],
  },
  FileNode: {
    type: "FileNode",
    domain: "files",
    scopes: ["read"],
    get: "FileNode/get",
    query: "FileNode/query",
    listable: true,
    filters: ["parentId", "ancestorId", "nodeType", "role", "name"],
  },
};

export const TYPE_NAMES: readonly string[] = Object.keys(TYPES);

// ---- payload readers ---------------------------------------------------
//
// Each returns only what the object actually carries. `undefined`/`null`/wrong
// type all read as "absent", so a missing property produces a missing link
// rather than a link to nothing.

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The keys of a JMAP `Id[Boolean]` map that are set to `true`. */
function trueKeys(v: unknown): string[] {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return [];
  return Object.entries(v as Record<string, unknown>)
    .filter(([, on]) => on === true)
    .map(([id]) => id);
}

/**
 * `attachments[].fileNodeId` — the one cross-realm id an Email carries
 * (methods/email.ts stamps it under the `filenode` capability). Always
 * present as a property, `null` when the attachment never became a file.
 */
function attachmentFileNodeIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const att of v) {
    if (att === null || typeof att !== "object") continue;
    const id = str((att as Record<string, unknown>).fileNodeId);
    if (id !== null && !out.includes(id)) out.push(id);
  }
  return out;
}

type LinkFn = (obj: Record<string, unknown>, b: LinkBuilder) => ExploreLinks;

const BUILDERS: Readonly<Record<string, LinkFn>> = {
  Email(obj, b): ExploreLinks {
    const out: ExploreLinks = {};
    const threadId = str(obj.threadId);
    if (threadId) out.thread = b.object("Thread", threadId);
    const mailboxes = trueKeys(obj.mailboxIds).map((id) => b.object("Mailbox", id));
    if (mailboxes.length > 0) out.mailboxes = mailboxes;
    const files = attachmentFileNodeIds(obj.attachments).map((id) => b.object("FileNode", id));
    if (files.length > 0) out.files = files;
    return out;
  },

  Mailbox(obj, b): ExploreLinks {
    const out: ExploreLinks = {};
    const parentId = str(obj.parentId);
    if (parentId) out.parent = b.object("Mailbox", parentId);
    const self = str(obj.id);
    if (self) out.emails = b.collection("Email", { inMailbox: self });
    return out;
  },

  Thread(obj, b): ExploreLinks {
    const ids = Array.isArray(obj.emailIds) ? obj.emailIds : [];
    const emails = ids.flatMap((id) => {
      const s = str(id);
      return s ? [b.object("Email", s)] : [];
    });
    return emails.length > 0 ? { emails } : {};
  },

  ContactCard(obj, b): ExploreLinks {
    const books = trueKeys(obj.addressBookIds).map((id) => b.object("AddressBook", id));
    return books.length > 0 ? { addressBooks: books } : {};
  },

  AddressBook(obj, b): ExploreLinks {
    const self = str(obj.id);
    return self ? { cards: b.collection("ContactCard", { inAddressBook: self }) } : {};
  },

  Calendar(obj, b): ExploreLinks {
    const self = str(obj.id);
    return self ? { events: b.collection("CalendarEvent", { inCalendar: self }) } : {};
  },

  CalendarEvent(obj, b): ExploreLinks {
    const cals = trueKeys(obj.calendarIds).map((id) => b.object("Calendar", id));
    return cals.length > 0 ? { calendars: cals } : {};
  },

  FileNode(obj, b): ExploreLinks {
    const out: ExploreLinks = {};
    const parentId = str(obj.parentId);
    if (parentId) out.parent = b.object("FileNode", parentId);
    const self = str(obj.id);
    // Only a directory can hold children; emitting `children` on a file would
    // be a link that always resolves to an empty list, which is noise.
    if (self && obj.nodeType === "directory") {
      out.children = b.collection("FileNode", { parentId: self });
    }
    return out;
  },
};

/** The `_links` for one projected object. `{}` when it carries no ids. */
export function linksFor(
  type: string,
  obj: Record<string, unknown>,
  b: LinkBuilder,
): ExploreLinks {
  const fn = BUILDERS[type];
  return fn ? fn(obj, b) : {};
}

/** Every href an object's `_links` emits, flattened — for tests and audits. */
export function flattenLinks(links: ExploreLinks): ExploreLink[] {
  return Object.values(links).flatMap((v) => (Array.isArray(v) ? v : [v]));
}
