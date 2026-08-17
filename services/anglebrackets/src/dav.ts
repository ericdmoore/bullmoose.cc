import { accountStub, commitChanges } from "@bullmoose/account-do";
import {
  accountAccess,
  allowedBookIds,
  isAgentPrincipal,
  matchingGrants,
  principalHasScope,
  type AccountAccess,
  type MethodDomain,
  type Principal,
} from "@bullmoose/auth-core/principal";
import { parseVcf, serializeVcard, type Card } from "@bullmoose/contacts-core";
import { eventSpan, parseICal, serializeICal, expandOccurrences } from "@bullmoose/calendar-core";
import {
  BookWriteRefused,
  Mailstore,
  type AddressBookRow,
  type CalendarRow,
  type ContactWriter,
  type JSCalendarEventBlob,
  type JSContactCard,
} from "@bullmoose/mailstore";
import type { Env } from "./index.js";

/**
 * The CardDAV surface. URL layout:
 *   /dav/                                   PROPFIND → current-user-principal
 *   /dav/principals/{accountId}/            PROPFIND → addressbook-home-set
 *                                           (one home per accessible account —
 *                                            shared accounts appear via grants)
 *   /dav/addressbooks/{accountId}/          PROPFIND depth 1 → visible books
 *   /dav/addressbooks/{acct}/{book}/        PROPFIND (ctag/sync-token),
 *                                           PROPPATCH (rename/describe),
 *                                           REPORT sync-collection /
 *                                           addressbook-multiget / -query
 *   /dav/addressbooks/{acct}/{book}/{res}   GET / PUT / DELETE (ETags)
 *
 * Resource names: cards created over JMAP answer to "{id}.vcf"; a client
 * PUT keeps its chosen name via contact_cards.dav_name. Deletions leave
 * dav_tombstones so a later sync-collection can 404 the right href.
 */

const D = "DAV:";
const C = "urn:ietf:params:xml:ns:carddav";
const CAL = "urn:ietf:params:xml:ns:caldav";
const CS = "http://calendarserver.org/ns/";
const SYNC_PREFIX = "bm:sync:";
const TOMBSTONE_TTL_MS = 30 * 24 * 3600_000;

/** The `<D:status>` lines this surface emits inside a multistatus. */
const OK_200 = "HTTP/1.1 200 OK";
const NOT_FOUND_404 = "HTTP/1.1 404 Not Found";
const FORBIDDEN_403 = "HTTP/1.1 403 Forbidden";
const CONFLICT_409 = "HTTP/1.1 409 Conflict";

/**
 * The two advertisement strings, in one place because they are read as a
 * contract: a client decides whether to OFFER "New Calendar" from the
 * `Allow` header rather than by probing. `extended-mkcol` (RFC 5689 §5)
 * is what tells a CardDAV client it may MKCOL an addressbook resourcetype
 * (RFC 6352 §5.2) instead of needing a bespoke verb.
 */
export const DAV_COMPLIANCE = "1, 3, addressbook, calendar-access, extended-mkcol";
export const DAV_ALLOW =
  "OPTIONS, GET, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCOL, MKCALENDAR";

/**
 * Client-chosen collection ids. Both specs create the collection AT the
 * Request-URI — Apple Calendar invents a UUID path segment and then PUTs
 * into it — so the DAV layer, unlike JMAP, must accept an id from the
 * caller. Collections have no `dav_name` column (unlike contact_cards /
 * calendar_events), and adding one would be a migration in a repo with no
 * migration framework, so the id IS the URI. Charset is deliberately
 * narrow: it lands in a PRIMARY KEY and in every href we emit.
 * Leading char is alphanumeric so "." and ".." can never be ids.
 */
const COLLECTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function handleDav(
  request: Request,
  url: URL,
  env: Env,
  principal: Principal,
): Promise<Response> {
  const segments = url.pathname
    .replace(/^\/dav\/?/, "")
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);

  try {
    // /dav/ — service root: principal discovery.
    if (segments.length === 0) {
      if (request.method !== "PROPFIND") return notAllowed();
      const own = principal.accounts.find((a) => !a.granted) ?? principal.accounts[0];
      if (!own) return new Response("no accounts", { status: 403 });
      return propfindResponse(await request.text(), [
        {
          href: "/dav/",
          props: {
            resourcetype: `<D:collection/>`,
            "current-user-principal": href(principalPath(own.accountId)),
            displayname: xmlEscape(principal.username),
          },
        },
      ]);
    }

    if (segments[0] === "principals" && segments.length === 2) {
      if (request.method !== "PROPFIND") return notAllowed();
      const access = requireAccess(principal, segments[1]!, "contacts");
      const own = principal.accounts.find((a) => !a.granted);
      const homes = principal.accounts.map((a) => href(homePath(a.accountId))).join("");
      // Calendar homes: whole-account access only (no calendar-collection
      // grants yet), so book-scoped sharees don't get one for the target.
      const calHomes = principal.accounts
        .filter((a) => !a.granted || matchingGrants(a, "read", "calendar").length > 0)
        .map((a) => href(calHomePath(a.accountId)))
        .join("");
      return propfindResponse(await request.text(), [
        {
          href: principalPath(access.accountId),
          props: {
            resourcetype: `<D:principal/>`,
            displayname: xmlEscape(access.name),
            "current-user-principal": href(principalPath((own ?? access).accountId)),
            "principal-URL": href(principalPath(access.accountId)),
            "addressbook-home-set": homes,
            ...(calHomes ? { "calendar-home-set": calHomes } : {}),
          },
        },
      ]);
    }

    if (segments[0] === "addressbooks" && segments.length >= 2) {
      const access = requireAccess(principal, segments[1]!, "contacts");
      const store = new Mailstore(env.DB, env.BLOBS);

      // `return await` so a rejected DavError is caught below.
      if (segments.length === 2) return await handleHome(request, env, store, principal, access);
      const bookId = segments[2]!;
      if (segments.length === 3) {
        const body = await request.text();
        // Structural verbs branch HERE, ahead of handleBook — which resolves
        // the collection first (requireBook) and would 404 the very path
        // MKCOL is being asked to create. DELETE rides along so it gets its
        // own audit string and its own owner-only gate.
        if (request.method === "MKCOL") {
          return await createBook(env, store, principal, access, bookId, body);
        }
        if (request.method === "DELETE") {
          return await destroyBook(env, store, principal, access, bookId);
        }
        // PROPPATCH branches here too — handleBook's requireBook resolves
        // through the read-grant filter, and a rename is an owner-only
        // structural write with its own gate and its own audit string.
        if (request.method === "PROPPATCH") {
          return await propPatchCollection(
            env,
            store,
            principal,
            access,
            "addressbook",
            bookId,
            body,
          );
        }
        return await handleBook(request, env, store, principal, access, bookId, body);
      }
      if (segments.length === 4) {
        return await handleResource(request, env, store, principal, access, bookId, segments[3]!);
      }
    }

    if (segments[0] === "calendars" && segments.length >= 2) {
      const access = requireAccess(principal, segments[1]!, "calendar");
      const store = new Mailstore(env.DB, env.BLOBS);

      if (segments.length === 2) return await handleCalHome(request, env, store, principal, access);
      const calId = segments[2]!;
      if (segments.length === 3) {
        const body = await request.text();
        // Same inversion as the addressbook branch above.
        if (request.method === "MKCALENDAR") {
          return await createCalendar(env, store, principal, access, calId, body);
        }
        if (request.method === "DELETE") {
          return await destroyCalendar(env, store, principal, access, calId);
        }
        if (request.method === "PROPPATCH") {
          return await propPatchCollection(env, store, principal, access, "calendar", calId, body);
        }
        return await handleCalendar(request, env, store, principal, access, calId, body);
      }
      if (segments.length === 4) {
        return await handleEventResource(
          request,
          env,
          store,
          principal,
          access,
          calId,
          segments[3]!,
        );
      }
    }

    return new Response("not found", { status: 404 });
  } catch (err) {
    if (err instanceof DavError) return err.response();
    // The Mailstore chokepoint's typed refusal (s10 T1): a governed book is
    // governed over CardDAV too, and the refusal is a 403, not a 500.
    if (err instanceof BookWriteRefused) return new Response(err.message, { status: 403 });
    console.error("dav error:", err);
    return new Response(`internal error: ${String(err)}`, { status: 500 });
  }
}

// ---- access ---------------------------------------------------------------

class DavError extends Error {
  constructor(
    public status: number,
    message: string,
    public xmlBody?: string,
  ) {
    super(message);
  }
  response(): Response {
    return new Response(this.xmlBody ?? this.message, {
      status: this.status,
      headers: this.xmlBody ? { "content-type": "application/xml; charset=utf-8" } : {},
    });
  }
}

function requireAccess(
  principal: Principal,
  accountId: string,
  domain: MethodDomain,
): AccountAccess {
  const access = accountAccess(principal, accountId);
  if (!access) throw new DavError(404, "unknown account");
  if (!principalHasScope(principal, "read")) throw new DavError(403, "token lacks read");
  if (access.granted && matchingGrants(access, "read", domain).length === 0) {
    throw new DavError(403, "no grant covers this account");
  }
  return access;
}

async function requireWrite(
  env: Env,
  principal: Principal,
  access: AccountAccess,
  bookId: string,
): Promise<void> {
  if (!principalHasScope(principal, "contacts")) {
    throw new DavError(403, "token lacks the contacts scope");
  }
  const writable = allowedBookIds(access, "contacts");
  if (writable && !writable.has(bookId)) throw new DavError(403, "book is read-only for you");
  await audit(env, principal, access, "dav:write");
}

/**
 * The chokepoint writer for a DAV card write (s10 T1). An agent-marked token
 * (the "agent" scope) speaking CardDAV is still an agent — the write-policy
 * gate lives in the store, so this surface only has to say WHO is writing.
 */
function davWriter(principal: Principal): ContactWriter {
  return {
    principal: principal.username,
    kind: isAgentPrincipal(principal) ? "agent" : "human",
  };
}

/** grant_audit for granted principals (parity with the JMAP path). */
async function audit(
  env: Env,
  principal: Principal,
  access: AccountAccess,
  method: string,
): Promise<void> {
  const grant = access.granted?.[0];
  if (!grant) return;
  await env.DB.prepare(
    `INSERT INTO grant_audit (grant_id, principal, account_id, method, at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(grant.grantId, principal.username, access.accountId, method, Date.now())
    .run();
}

async function visibleBooks(store: Mailstore, access: AccountAccess): Promise<AddressBookRow[]> {
  const books = await store.getAddressBooks(access.accountId);
  const readable = allowedBookIds(access, "read");
  return readable ? books.filter((b) => readable.has(b.id)) : books;
}

async function requireBook(
  store: Mailstore,
  access: AccountAccess,
  bookId: string,
): Promise<AddressBookRow> {
  const book = (await visibleBooks(store, access)).find((b) => b.id === bookId);
  if (!book) throw new DavError(404, "no such address book");
  return book;
}

// ---- collections ------------------------------------------------------

async function handleHome(
  request: Request,
  env: Env,
  store: Mailstore,
  principal: Principal,
  access: AccountAccess,
): Promise<Response> {
  if (request.method !== "PROPFIND") return notAllowed();
  await audit(env, principal, access, "dav:read");
  const body = await request.text();
  const depth = request.headers.get("Depth") ?? "0";

  const resources: PropfindResource[] = [
    {
      href: homePath(access.accountId),
      props: {
        resourcetype: `<D:collection/>`,
        displayname: xmlEscape(`${access.name} contacts`),
        "current-user-principal": href(principalPath(access.accountId)),
      },
    },
  ];
  if (depth !== "0") {
    const writable = allowedBookIds(access, "contacts");
    for (const book of await visibleBooks(store, access)) {
      resources.push(bookResource(env, access, book, writable === null || writable.has(book.id)));
    }
    // Resolve sync tokens for the pushed book resources.
    const state = await doState(env, access.accountId);
    for (const r of resources.slice(1)) r.props["sync-token"] = syncToken(state);
  }
  return propfindResponse(body, resources);
}

function bookResource(
  _env: Env,
  access: AccountAccess,
  book: AddressBookRow,
  writable: boolean,
): PropfindResource {
  return {
    href: bookPath(access.accountId, book.id),
    props: {
      resourcetype: `<D:collection/><C:addressbook/>`,
      displayname: xmlEscape(book.name),
      ...(book.description ? { "addressbook-description": xmlEscape(book.description) } : {}),
      getctag: xmlEscape(String(book.ctag)),
      "supported-address-data": `<C:address-data-type content-type="text/vcard" version="3.0"/>`,
      "current-user-privilege-set": writable
        ? `<D:privilege><D:read/></D:privilege><D:privilege><D:write/></D:privilege>`
        : `<D:privilege><D:read/></D:privilege>`,
    },
  };
}

async function handleBook(
  request: Request,
  env: Env,
  store: Mailstore,
  principal: Principal,
  access: AccountAccess,
  bookId: string,
  body: string,
): Promise<Response> {
  const book = await requireBook(store, access, bookId);
  await audit(env, principal, access, `dav:${request.method.toLowerCase()}`);

  if (request.method === "PROPFIND") {
    const depth = request.headers.get("Depth") ?? "0";
    const writable = allowedBookIds(access, "contacts");
    const bookRes = bookResource(env, access, book, writable === null || writable.has(book.id));
    bookRes.props["sync-token"] = syncToken(await doState(env, access.accountId));
    const resources: PropfindResource[] = [bookRes];
    if (depth !== "0") {
      for (const ref of await store.cardRefsInBook(access.accountId, book.id)) {
        resources.push({
          href: cardPath(access.accountId, book.id, ref.davName ?? ref.id),
          props: {
            resourcetype: ``,
            getetag: xmlEscape(etagOf(ref.id, ref.updatedAt)),
            getcontenttype: `text/vcard; charset=utf-8`,
          },
        });
      }
    }
    return propfindResponse(body, resources);
  }

  if (request.method === "REPORT") {
    const root = reportRoot(body);
    if (root === "sync-collection") return syncCollection(env, store, access, book, body);
    if (root === "addressbook-multiget") return multiget(store, access, book, body);
    if (root === "addressbook-query") return abQuery(store, access, book, body);
    return new Response(`unsupported report: ${root}`, { status: 403 });
  }

  return notAllowed();
}

// ---- collection create / destroy (CardDAV) -----------------------------

/**
 * Structural writes are OWNER-ONLY, mirroring `AddressBook/set`'s
 * "v1: sharees edit contents (per mayWrite), never the books themselves"
 * (services/jmap/src/methods/contacts.ts). Book-scoped grants have no way
 * to express "may create a sibling", so a sharee reaching this is refused
 * before anything is read.
 */
async function requireBookOwner(
  env: Env,
  principal: Principal,
  access: AccountAccess,
  auditMethod: string,
): Promise<void> {
  if (!principalHasScope(principal, "contacts")) {
    throw new DavError(403, "token lacks the contacts scope");
  }
  if (access.granted) {
    throw new DavError(403, "only the account owner manages address books");
  }
  await audit(env, principal, access, auditMethod);
}

/**
 * Extended MKCOL (RFC 5689) with an `addressbook` resourcetype — how
 * RFC 6352 §5.2 creates an address book. There is no MKADDRESSBOOK verb.
 */
async function createBook(
  env: Env,
  store: Mailstore,
  principal: Principal,
  access: AccountAccess,
  bookId: string,
  body: string,
): Promise<Response> {
  await requireBookOwner(env, principal, access, "dav:mkcol");
  // No RFC 6352 precondition covers "that URI is not an acceptable name"
  // (CalDAV has calendar-collection-location-ok; CardDAV has no twin), so
  // this is a plain 403 rather than an invented element.
  if (!COLLECTION_ID_RE.test(bookId)) {
    throw new DavError(403, `illegal collection name: ${bookId}`);
  }

  const props = parseMkcolProps(body);
  // An empty body is legal and means "defaults". This home holds address
  // books and nothing else, so an unqualified MKCOL is read as one; a body
  // that asks for some OTHER resourcetype is refused rather than quietly
  // creating the wrong kind of thing.
  if (props.resourcetype !== null && !/addressbook/i.test(props.resourcetype)) {
    throw precondition(403, "D:valid-resourcetype", "only addressbook collections live here");
  }

  const books = await store.getAddressBooks(access.accountId);
  // RFC 4918 §9.3.1: MKCOL only executes on an unmapped URL.
  if (books.some((b) => b.id === bookId)) return notAllowed();

  // Name rule mirrors validateNewBook (contacts.ts), which measures OCTETS,
  // not chars — a DAV-created book must be a book JMAP would have accepted.
  const name = props.displayname ?? bookId;
  if (new TextEncoder().encode(name).length > 255) {
    throw new DavError(403, "displayname must be 1..255 octets");
  }

  const now = Date.now();
  await store.insertAddressBook(access.accountId, {
    id: bookId,
    name,
    description: props.description,
    sortOrder: 0,
    // NEVER steal the default: `address_books_default` is a partial UNIQUE
    // index, so a second is_default=1 row is a constraint violation, not a
    // preference. Matches `validateNewBook(spec, !hasDefault)`.
    isDefault: !books.some((b) => b.isDefault),
    isSubscribed: true,
    ctag: 0,
    createdAt: now,
    updatedAt: now,
    // Governing books are marked by provisioning, never created over DAV.
    writePolicy: "open",
  });
  const { newState } = await commitChanges(env.ACCOUNT_DO, access.accountId, [
    { collection: "AddressBook", created: [bookId] },
  ]);
  return mkcolResponse("D:mkcol-response", newState, props.dropped);
}

async function destroyBook(
  env: Env,
  store: Mailstore,
  principal: Principal,
  access: AccountAccess,
  bookId: string,
): Promise<Response> {
  await requireBookOwner(env, principal, access, "dav:rmcol");
  const book = (await store.getAddressBooks(access.accountId)).find((b) => b.id === bookId);
  if (!book) return new Response("not found", { status: 404 });
  // AddressBook/set promotes the oldest survivor when the default goes.
  // Doing that under a DAV client is a silent reshuffle it never asked
  // for, so refuse instead — the client can rename or empty the book.
  if (book.isDefault) {
    throw new DavError(403, "the default address book cannot be deleted");
  }

  // DAV DELETE on a collection is unconditional depth-infinity: it takes
  // the contents with it (JMAP's onDestroyRemoveContents, always on).
  const cardIds = await store.cardIdsInBook(access.accountId, bookId);
  await store.destroyContactCards(access.accountId, cardIds, davWriter(principal));
  await store.deleteAddressBook(access.accountId, bookId);
  // A destroyed book takes its sharing with it (parity with
  // AddressBook/set) — note this means a CardDAV DELETE can unshare.
  await env.DB.prepare(
    `DELETE FROM grants WHERE target_account_id = ? AND collection = 'AddressBook'
       AND collection_id = ?`,
  )
    .bind(access.accountId, bookId)
    .run();
  // The tombstones just written point at a collection that no longer
  // exists; age out the expired ones so a late sync-collection is coherent.
  await store.pruneTombstones(access.accountId, TOMBSTONE_TTL_MS);

  await commitChanges(env.ACCOUNT_DO, access.accountId, [
    { collection: "AddressBook", destroyed: [bookId] },
    { collection: "ContactCard", destroyed: cardIds },
  ]);
  return new Response(null, { status: 204 });
}

// ---- REPORTs ----------------------------------------------------------

async function syncCollection(
  env: Env,
  store: Mailstore,
  access: AccountAccess,
  book: AddressBookRow,
  body: string,
): Promise<Response> {
  await store.pruneTombstones(access.accountId, TOMBSTONE_TTL_MS);
  const tokenRaw = textOf(body, "sync-token").trim();
  const parts: string[] = [];

  if (tokenRaw === "") {
    // Initial sync: every card in the book.
    for (const ref of await store.cardRefsInBook(access.accountId, book.id)) {
      parts.push(
        response(cardPath(access.accountId, book.id, ref.davName ?? ref.id), {
          getetag: xmlEscape(etagOf(ref.id, ref.updatedAt)),
        }),
      );
    }
    const state = await doState(env, access.accountId);
    return multistatus(parts, syncToken(state));
  }

  if (!tokenRaw.startsWith(SYNC_PREFIX) || !/^\d+$/.test(tokenRaw.slice(SYNC_PREFIX.length))) {
    throw invalidSyncToken();
  }
  let since = tokenRaw.slice(SYNC_PREFIX.length);

  const created = new Set<string>();
  const updated = new Set<string>();
  const destroyed = new Set<string>();
  for (;;) {
    const res = await accountStub(env.ACCOUNT_DO, access.accountId).fetch(
      `https://do/changes?collection=ContactCard&since=${since}&maxChanges=1024`,
    );
    if (res.status === 409) throw invalidSyncToken();
    if (!res.ok) throw new DavError(500, `changelog ${res.status}`);
    const delta = (await res.json()) as {
      newState: string;
      hasMoreChanges: boolean;
      created: string[];
      updated: string[];
      destroyed: string[];
    };
    for (const id of delta.created) created.add(id);
    for (const id of delta.updated) updated.add(id);
    for (const id of delta.destroyed) {
      if (created.delete(id)) continue;
      updated.delete(id);
      destroyed.add(id);
    }
    since = delta.newState;
    if (!delta.hasMoreChanges) break;
  }

  // Filter live changes to THIS book; destroys resolve via tombstones.
  const liveIds = [...created, ...updated];
  if (liveIds.length > 0) {
    const refs = await store.getContactCardRefs(access.accountId, liveIds);
    for (const ref of refs) {
      if (ref.addressBookId !== book.id) continue;
      parts.push(
        response(cardPath(access.accountId, book.id, ref.davName ?? ref.id), {
          getetag: xmlEscape(etagOf(ref.id, ref.updatedAt)),
        }),
      );
    }
  }
  if (destroyed.size > 0) {
    const stones = await store.tombstoneNames(access.accountId, [...destroyed]);
    for (const [id, stone] of stones) {
      if (stone.collectionId !== book.id) continue;
      parts.push(
        `<D:response><D:href>${xmlEscape(
          cardPath(access.accountId, book.id, stone.resourceName),
        )}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`,
      );
      destroyed.delete(id);
    }
    // Destroys with no tombstone (pre-Phase-2 deletions): emit by id so
    // clients that synced canonical names still converge.
    for (const id of destroyed) {
      parts.push(
        `<D:response><D:href>${xmlEscape(
          cardPath(access.accountId, book.id, id),
        )}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`,
      );
    }
  }

  return multistatus(parts, `${SYNC_PREFIX}${since}`);
}

function invalidSyncToken(): DavError {
  // RFC 6578 §3.2: the client must fall back to an initial sync.
  return new DavError(
    409,
    "invalid sync token",
    `<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>`,
  );
}

async function multiget(
  store: Mailstore,
  access: AccountAccess,
  book: AddressBookRow,
  body: string,
): Promise<Response> {
  const parts: string[] = [];
  for (const rawHref of hrefsOf(body)) {
    const name = decodeURIComponent(rawHref.split("/").filter(Boolean).pop() ?? "");
    const row = await store.getCardByDavName(access.accountId, book.id, stripVcf(name));
    if (!row) {
      parts.push(
        `<D:response><D:href>${xmlEscape(rawHref)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`,
      );
      continue;
    }
    const card = await store.inflateCardPhotos(access.tenantId, access.accountId, row.card);
    parts.push(
      response(cardPath(access.accountId, book.id, row.davName ?? row.id), {
        getetag: xmlEscape(etagOf(row.id, row.updatedAt)),
        "address-data": xmlEscape(serializeVcard(card as Card)),
      }),
    );
  }
  return multistatus(parts);
}

/** v1 addressbook-query: the whole book (filters are a Phase-2.1 nicety —
 * Apple syncs via sync-collection + multiget, not query). address-data
 * only when requested: inflating every photo from R2 for an etag-only
 * query would burn the CPU budget for nothing. */
async function abQuery(
  store: Mailstore,
  access: AccountAccess,
  book: AddressBookRow,
  body: string,
): Promise<Response> {
  const wantData = /address-data/i.test(body);
  const rows = (await store.getContactCards(access.accountId)).filter(
    (r) => r.addressBookId === book.id,
  );
  const parts: string[] = [];
  for (const row of rows) {
    const card = wantData
      ? await store.inflateCardPhotos(access.tenantId, access.accountId, row.card)
      : row.card;
    parts.push(
      response(cardPath(access.accountId, book.id, row.davName ?? row.id), {
        getetag: xmlEscape(etagOf(row.id, row.updatedAt)),
        ...(wantData ? { "address-data": xmlEscape(serializeVcard(card as Card)) } : {}),
      }),
    );
  }
  return multistatus(parts);
}

// ---- card resources ----------------------------------------------------

async function handleResource(
  request: Request,
  env: Env,
  store: Mailstore,
  principal: Principal,
  access: AccountAccess,
  bookId: string,
  rawName: string,
): Promise<Response> {
  const book = await requireBook(store, access, bookId);
  const name = stripVcf(rawName);

  if (request.method === "GET" || request.method === "HEAD") {
    await audit(env, principal, access, "dav:read");
    const row = await store.getCardByDavName(access.accountId, book.id, name);
    if (!row) return new Response("not found", { status: 404 });
    const card = await store.inflateCardPhotos(access.tenantId, access.accountId, row.card);
    const vcf = serializeVcard(card as Card);
    return new Response(request.method === "HEAD" ? null : vcf, {
      headers: {
        "content-type": "text/vcard; charset=utf-8",
        etag: etagOf(row.id, row.updatedAt),
      },
    });
  }

  if (request.method === "PUT") {
    await requireWrite(env, principal, access, book.id);
    const bodyText = await request.text();
    const { cards } = parseVcf(bodyText);
    const card = cards[0];
    if (!card) return new Response("no vCard in body", { status: 400 });

    const existing = await store.getCardByDavName(access.accountId, book.id, name);
    const ifMatch = request.headers.get("If-Match");
    const ifNoneMatch = request.headers.get("If-None-Match");
    if (ifNoneMatch === "*" && existing) return new Response("exists", { status: 412 });
    if (ifMatch) {
      if (!existing || !etagMatches(ifMatch, etagOf(existing.id, existing.updatedAt))) {
        return new Response("etag mismatch", { status: 412 });
      }
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const uid = String(card.uid);

    if (existing) {
      if (uid !== existing.uid) {
        throw uidConflict("a resource's UID cannot change on update");
      }
      const stored = card as JSContactCard;
      stored["@type"] = "Card";
      if (stored.version === undefined) stored.version = "1.0";
      if (typeof stored.created !== "string") stored.created = existing.card.created ?? nowIso;
      stored.updated = nowIso;
      stored.addressBookIds = { [book.id]: true };
      await store.offloadCardPhotos(access.tenantId, access.accountId, stored);
      await store.updateContactCard(
        access.accountId,
        {
          id: existing.id,
          addressBookId: book.id,
          uid: existing.uid,
          card: stored,
          nameFull: deriveNameFull(stored),
          davName: name,
          createdAt: existing.createdAt,
          updatedAt: now,
        },
        davWriter(principal),
      );
      await store.bumpAddressBookCtags(access.accountId, [book.id]);
      await commitChanges(env.ACCOUNT_DO, access.accountId, [
        { collection: "ContactCard", updated: [existing.id] },
      ]);
      return new Response(null, { status: 204, headers: { etag: etagOf(existing.id, now) } });
    }

    // Create: uid must be free account-wide (RFC 9610 uniqueness).
    const uidTaken = await store.contactCardIdsByUids(access.accountId, [uid]);
    if (uidTaken.size > 0) {
      throw uidConflict(`uid already in use: ${uid}`);
    }
    const stored = card as JSContactCard;
    stored["@type"] = "Card";
    if (stored.version === undefined) stored.version = "1.0";
    if (typeof stored.created !== "string") stored.created = nowIso;
    stored.updated = nowIso;
    stored.addressBookIds = { [book.id]: true };
    await store.offloadCardPhotos(access.tenantId, access.accountId, stored);
    const id = `cc_${crypto.randomUUID()}`;
    await store.insertContactCards(
      access.accountId,
      [
        {
          id,
          addressBookId: book.id,
          uid,
          card: stored,
          nameFull: deriveNameFull(stored),
          davName: name,
          createdAt: Date.parse(stored.created) || now,
          updatedAt: now,
        },
      ],
      davWriter(principal),
    );
    await store.bumpAddressBookCtags(access.accountId, [book.id]);
    await commitChanges(env.ACCOUNT_DO, access.accountId, [
      { collection: "ContactCard", created: [id] },
    ]);
    return new Response(null, { status: 201, headers: { etag: etagOf(id, now) } });
  }

  if (request.method === "DELETE") {
    await requireWrite(env, principal, access, book.id);
    const row = await store.getCardByDavName(access.accountId, book.id, name);
    if (!row) return new Response("not found", { status: 404 });
    const ifMatch = request.headers.get("If-Match");
    if (ifMatch && !etagMatches(ifMatch, etagOf(row.id, row.updatedAt))) {
      return new Response("etag mismatch", { status: 412 });
    }
    await store.destroyContactCard(access.accountId, row.id, davWriter(principal));
    await store.bumpAddressBookCtags(access.accountId, [book.id]);
    await commitChanges(env.ACCOUNT_DO, access.accountId, [
      { collection: "ContactCard", destroyed: [row.id] },
    ]);
    return new Response(null, { status: 204 });
  }

  return notAllowed();
}

// ---- CalDAV: calendars ---------------------------------------------------

async function visibleCalendars(store: Mailstore, access: AccountAccess): Promise<CalendarRow[]> {
  // No calendar-collection grants yet: requireAccess(domain "calendar")
  // already gated whole-account access, so everything is visible.
  return store.getCalendars(access.accountId);
}

async function requireCalendar(
  store: Mailstore,
  access: AccountAccess,
  calId: string,
): Promise<CalendarRow> {
  const cal = (await visibleCalendars(store, access)).find((c) => c.id === calId);
  if (!cal) throw new DavError(404, "no such calendar");
  return cal;
}

async function requireCalWrite(
  env: Env,
  principal: Principal,
  access: AccountAccess,
): Promise<void> {
  if (!principalHasScope(principal, "calendar")) {
    throw new DavError(403, "token lacks the calendar scope");
  }
  if (access.granted && matchingGrants(access, "calendar", "calendar").length === 0) {
    throw new DavError(403, "no calendar write grant on this account");
  }
  await audit(env, principal, access, "dav:cal-write");
}

function calendarResource(access: AccountAccess, cal: CalendarRow): PropfindResource {
  return {
    href: calPath(access.accountId, cal.id),
    props: {
      resourcetype: `<D:collection/><CAL:calendar/>`,
      displayname: xmlEscape(cal.name),
      ...(cal.description ? { "calendar-description": xmlEscape(cal.description) } : {}),
      ...(cal.color ? { "calendar-color": xmlEscape(cal.color) } : {}),
      getctag: xmlEscape(String(cal.ctag)),
      "supported-calendar-component-set": `<CAL:comp name="VEVENT"/>`,
      "current-user-privilege-set": `<D:privilege><D:read/></D:privilege><D:privilege><D:write/></D:privilege>`,
    },
  };
}

async function handleCalHome(
  request: Request,
  env: Env,
  store: Mailstore,
  principal: Principal,
  access: AccountAccess,
): Promise<Response> {
  if (request.method !== "PROPFIND") return notAllowed();
  await audit(env, principal, access, "dav:cal-read");
  const body = await request.text();
  const depth = request.headers.get("Depth") ?? "0";

  const resources: PropfindResource[] = [
    {
      href: calHomePath(access.accountId),
      props: {
        resourcetype: `<D:collection/>`,
        displayname: xmlEscape(`${access.name} calendars`),
        "current-user-principal": href(principalPath(access.accountId)),
      },
    },
  ];
  if (depth !== "0") {
    const state = await doState(env, access.accountId);
    for (const cal of await visibleCalendars(store, access)) {
      const r = calendarResource(access, cal);
      r.props["sync-token"] = syncToken(state);
      resources.push(r);
    }
  }
  return propfindResponse(body, resources);
}

async function handleCalendar(
  request: Request,
  env: Env,
  store: Mailstore,
  principal: Principal,
  access: AccountAccess,
  calId: string,
  body: string,
): Promise<Response> {
  const cal = await requireCalendar(store, access, calId);
  await audit(env, principal, access, `dav:cal-${request.method.toLowerCase()}`);

  if (request.method === "PROPFIND") {
    const depth = request.headers.get("Depth") ?? "0";
    const calRes = calendarResource(access, cal);
    calRes.props["sync-token"] = syncToken(await doState(env, access.accountId));
    const resources: PropfindResource[] = [calRes];
    if (depth !== "0") {
      for (const ref of await store.eventRefsInCalendar(access.accountId, cal.id)) {
        resources.push({
          href: eventPath(access.accountId, cal.id, ref.davName ?? ref.id),
          props: {
            resourcetype: ``,
            getetag: xmlEscape(etagOf(ref.id, ref.updatedAt)),
            getcontenttype: `text/calendar; charset=utf-8; component=VEVENT`,
          },
        });
      }
    }
    return propfindResponse(body, resources);
  }

  if (request.method === "REPORT") {
    const root = reportRoot(body);
    if (root === "sync-collection") return calSyncCollection(env, store, access, cal, body);
    if (root === "calendar-multiget") return calMultiget(store, access, cal, body);
    if (root === "calendar-query") return calQuery(store, access, cal, body);
    return new Response(`unsupported report: ${root}`, { status: 403 });
  }

  return notAllowed();
}

// ---- collection create / destroy (CalDAV) ------------------------------

/** Owner-only, twin of requireBookOwner — `Calendar/set` refuses sharees. */
async function requireCalOwner(
  env: Env,
  principal: Principal,
  access: AccountAccess,
  auditMethod: string,
): Promise<void> {
  if (!principalHasScope(principal, "calendar")) {
    throw new DavError(403, "token lacks the calendar scope");
  }
  if (access.granted) {
    throw new DavError(403, "only the account owner manages calendars");
  }
  await audit(env, principal, access, auditMethod);
}

/** MKCALENDAR — RFC 4791 §5.3.1. */
async function createCalendar(
  env: Env,
  store: Mailstore,
  principal: Principal,
  access: AccountAccess,
  calId: string,
  body: string,
): Promise<Response> {
  await requireCalOwner(env, principal, access, "dav:mkcalendar");
  if (!COLLECTION_ID_RE.test(calId)) {
    throw precondition(
      403,
      "CAL:calendar-collection-location-ok",
      `illegal collection name: ${calId}`,
    );
  }

  const props = parseMkcolProps(body);
  // We serve VEVENT only (calendarResource's supported-calendar-component-set).
  // A client asking for VTODO/VJOURNAL gets refused here rather than a
  // calendar that will reject its own writes.
  const unsupported = props.components.filter((c) => c.toUpperCase() !== "VEVENT");
  if (unsupported.length > 0) {
    throw precondition(
      403,
      "CAL:supported-calendar-component",
      `unsupported components: ${unsupported.join(", ")}`,
    );
  }

  const cals = await store.getCalendars(access.accountId);
  // RFC 4791 §5.3.1: 405 when the Request-URI is already mapped.
  if (cals.some((c) => c.id === calId)) return notAllowed();

  // validateNewCalendar measures CHARS (contacts measures octets); mirror
  // each realm's own rule so DAV and JMAP accept the same names.
  const name = props.displayname ?? calId;
  if (name.length > 255) {
    throw new DavError(403, "displayname must be 1..255 chars");
  }

  const now = Date.now();
  await store.insertCalendar(access.accountId, {
    id: calId,
    name,
    description: props.description,
    color: props.color,
    sortOrder: 0,
    // See createBook: `calendars_default` is a partial UNIQUE index.
    isDefault: !cals.some((c) => c.isDefault),
    isSubscribed: true,
    // A brand-new collection starts at 0: the client has never seen it.
    ctag: 0,
    createdAt: now,
    updatedAt: now,
  });
  const { newState } = await commitChanges(env.ACCOUNT_DO, access.accountId, [
    { collection: "Calendar", created: [calId] },
  ]);
  return mkcolResponse("CAL:mkcalendar-response", newState, props.dropped);
}

async function destroyCalendar(
  env: Env,
  store: Mailstore,
  principal: Principal,
  access: AccountAccess,
  calId: string,
): Promise<Response> {
  await requireCalOwner(env, principal, access, "dav:cal-rmcol");
  const cal = (await store.getCalendars(access.accountId)).find((c) => c.id === calId);
  if (!cal) return new Response("not found", { status: 404 });
  if (cal.isDefault) {
    throw new DavError(403, "the default calendar cannot be deleted");
  }

  const eventIds = await store.eventIdsInCalendar(access.accountId, calId);
  await store.destroyCalendarEvents(access.accountId, eventIds);
  await store.deleteCalendar(access.accountId, calId);
  await store.pruneTombstones(access.accountId, TOMBSTONE_TTL_MS);
  // Calendar/set has no grants cleanup here and neither do we: grants can
  // only be scoped to an AddressBook today (services/provision).
  await commitChanges(env.ACCOUNT_DO, access.accountId, [
    { collection: "Calendar", destroyed: [calId] },
    { collection: "CalendarEvent", destroyed: eventIds },
  ]);
  return new Response(null, { status: 204 });
}

// ---- collection PROPPATCH (both realms) --------------------------------

/**
 * `PROPPATCH` on a calendar or address book — RFC 4918 §9.2. This is how
 * Apple Calendar renames or recolours a collection; without it those edits
 * silently no-op, which is worse than a 405 because the client believes it
 * succeeded.
 *
 * Scoped to the three properties clients actually send, each of which has a
 * column to land in. Everything else is refused **per property**, inside the
 * 207 — including properties we understand but cannot store, because a bare
 * 200 that quietly drops one is the defect this handler exists to fix.
 *
 * ⚠️ **Deliberate deviation from RFC 4918 §9.2's all-or-nothing rule.** A
 * strict reading says one failed instruction must fail the rest with 424.
 * But Apple ships `calendar-order` (and friends) in the *same*
 * `<propertyupdate>` as `displayname`, so atomicity would mean no rename
 * ever lands — the whole defect, reintroduced with a spec citation. We apply
 * what we can and report the rest, which is what the client's UI expects and
 * what mainstream CalDAV servers do in practice.
 *
 * Role/default collections are NOT special-cased: sVOL `004` settled that
 * rename is allowed on role mailboxes because "role is the contract, name is
 * a label", and the same reasoning holds here. Note the contrast with
 * collection DELETE, which does refuse the default — deleting removes the
 * contract-bearer, renaming does not.
 */
async function propPatchCollection(
  env: Env,
  store: Mailstore,
  principal: Principal,
  access: AccountAccess,
  kind: "calendar" | "addressbook",
  collectionId: string,
  body: string,
): Promise<Response> {
  const isCal = kind === "calendar";
  // Structural writes are owner-only, same gate as MKCOL/MKCALENDAR/DELETE:
  // `AddressBook/set` lets a sharee edit contents, never the book itself.
  if (isCal) await requireCalOwner(env, principal, access, "dav:cal-proppatch");
  else await requireBookOwner(env, principal, access, "dav:proppatch");

  // Unlike the create verbs, PROPPATCH acts on a collection that must
  // already exist — but it is still routed ahead of handleBook /
  // handleCalendar so this handler owns the whole flow.
  const exists = isCal
    ? (await store.getCalendars(access.accountId)).some((c) => c.id === collectionId)
    : (await store.getAddressBooks(access.accountId)).some((b) => b.id === collectionId);
  if (!exists) return new Response("not found", { status: 404 });

  const ops = parsePropPatch(body);
  if (ops.length === 0) {
    throw new DavError(400, "PROPPATCH requires at least one property instruction");
  }

  type Verdict = { op: PropPatchOp; status: string; column?: "name" | "description" | "color" };
  // Keyed by property, in first-seen order: a property may be instructed
  // twice in one body ("set displayname, then remove it") and MUST still be
  // named exactly once in the reply, carrying the LAST outcome.
  const verdicts = new Map<string, Verdict>();
  const decide = (op: PropPatchOp, status: string, column?: Verdict["column"]) =>
    verdicts.set(`${op.ns ?? ""} ${op.name}`, { op, status, column });

  // The property name carrying `description` differs by realm, and the
  // wrong realm's name is a property this collection genuinely lacks.
  const descriptionProp = isCal ? "calendar-description" : "addressbook-description";
  const values = new Map<string, string | null>();

  for (const op of ops) {
    // A <remove>, or a set with an empty body, means "no value". Names
    // cannot be removed (the column is NOT NULL and JMAP requires 1..255);
    // description and colour are nullable, so removal is just NULL.
    const value = op.action === "remove" ? null : text(op.raw);

    if (op.name === "displayname") {
      if (value === null) {
        decide(op, FORBIDDEN_403); // a collection must keep a name
        continue;
      }
      // Mirror each realm's own JMAP validator so DAV and JMAP accept the
      // same names: calendars measure CHARS, address books measure OCTETS.
      const tooLong = isCal ? value.length > 255 : new TextEncoder().encode(value).length > 255;
      if (tooLong) {
        decide(op, CONFLICT_409);
        continue;
      }
      values.set("name", value);
      decide(op, OK_200, "name");
      continue;
    }

    if (op.name === descriptionProp) {
      values.set("description", value);
      decide(op, OK_200, "description");
      continue;
    }

    // address_books has no colour column (data-plane.sql); calendars does.
    // Any string is accepted, matching validateCalendarPatch — Apple sends
    // #RRGGBBAA and a tighter pattern would reject the real client.
    if (op.name === "calendar-color" && isCal) {
      values.set("color", value);
      decide(op, OK_200, "color");
      continue;
    }

    decide(op, FORBIDDEN_403);
  }

  // Only the columns whose FINAL verdict is 200 are written — a property
  // that was set and then removed in the same body must not land.
  const patch: { name?: string; description?: string | null; color?: string | null } = {};
  const ok = [...verdicts.values()].filter((v) => v.status === OK_200);
  for (const v of ok) {
    if (v.column === "name") patch.name = values.get("name") as string;
    if (v.column === "description") patch.description = values.get("description") ?? null;
    if (v.column === "color") patch.color = values.get("color") ?? null;
  }

  if (ok.length > 0) {
    // The choreography every DAV write in this file replicates, because
    // anglebrackets binds only ACCOUNT_DO and cannot reach the JMAP method
    // layer: mutate → bump the ctag → commit. Skipping the commit lands the
    // row and leaves it invisible to /changes forever.
    if (isCal) {
      await store.updateCalendar(access.accountId, collectionId, patch);
      await store.bumpCalendarCtags(access.accountId, [collectionId]);
      await commitChanges(env.ACCOUNT_DO, access.accountId, [
        { collection: "Calendar", updated: [collectionId] },
      ]);
    } else {
      await store.updateAddressBook(access.accountId, collectionId, {
        name: patch.name,
        description: patch.description,
      });
      await store.bumpAddressBookCtags(access.accountId, [collectionId]);
      await commitChanges(env.ACCOUNT_DO, access.accountId, [
        { collection: "AddressBook", updated: [collectionId] },
      ]);
    }
  }

  const render = (status: string) =>
    [...verdicts.values()]
      .filter((v) => v.status === status)
      .map((v) => renderEmptyProp(v.op))
      .join("");
  const href = isCal
    ? calPath(access.accountId, collectionId)
    : bookPath(access.accountId, collectionId);
  return multistatus([
    responseXml(href, [
      { props: render(OK_200), status: OK_200 },
      {
        props: render(CONFLICT_409),
        status: CONFLICT_409,
        description: "value rejected by this server",
      },
      {
        props: render(FORBIDDEN_403),
        status: FORBIDDEN_403,
        description: "not a property this collection stores",
      },
    ]),
  ]);
}

async function calSyncCollection(
  env: Env,
  store: Mailstore,
  access: AccountAccess,
  cal: CalendarRow,
  body: string,
): Promise<Response> {
  await store.pruneTombstones(access.accountId, TOMBSTONE_TTL_MS);
  const tokenRaw = textOf(body, "sync-token").trim();
  const parts: string[] = [];

  if (tokenRaw === "") {
    for (const ref of await store.eventRefsInCalendar(access.accountId, cal.id)) {
      parts.push(
        response(eventPath(access.accountId, cal.id, ref.davName ?? ref.id), {
          getetag: xmlEscape(etagOf(ref.id, ref.updatedAt)),
        }),
      );
    }
    return multistatus(parts, syncToken(await doState(env, access.accountId)));
  }

  if (!tokenRaw.startsWith(SYNC_PREFIX) || !/^\d+$/.test(tokenRaw.slice(SYNC_PREFIX.length))) {
    throw invalidSyncToken();
  }
  let since = tokenRaw.slice(SYNC_PREFIX.length);
  const created = new Set<string>();
  const updated = new Set<string>();
  const destroyed = new Set<string>();
  for (;;) {
    const res = await accountStub(env.ACCOUNT_DO, access.accountId).fetch(
      `https://do/changes?collection=CalendarEvent&since=${since}&maxChanges=1024`,
    );
    if (res.status === 409) throw invalidSyncToken();
    if (!res.ok) throw new DavError(500, `changelog ${res.status}`);
    const delta = (await res.json()) as {
      newState: string;
      hasMoreChanges: boolean;
      created: string[];
      updated: string[];
      destroyed: string[];
    };
    for (const id of delta.created) created.add(id);
    for (const id of delta.updated) updated.add(id);
    for (const id of delta.destroyed) {
      if (created.delete(id)) continue;
      updated.delete(id);
      destroyed.add(id);
    }
    since = delta.newState;
    if (!delta.hasMoreChanges) break;
  }

  const liveIds = [...created, ...updated];
  if (liveIds.length > 0) {
    for (const ref of await store.getCalendarEventRefs(access.accountId, liveIds)) {
      if (ref.calendarId !== cal.id) continue;
      parts.push(
        response(eventPath(access.accountId, cal.id, ref.davName ?? ref.id), {
          getetag: xmlEscape(etagOf(ref.id, ref.updatedAt)),
        }),
      );
    }
  }
  if (destroyed.size > 0) {
    const stones = await store.tombstoneNames(access.accountId, [...destroyed]);
    for (const [id, stone] of stones) {
      if (stone.collectionId !== cal.id) continue;
      parts.push(
        `<D:response><D:href>${xmlEscape(
          eventPath(access.accountId, cal.id, stone.resourceName),
        )}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`,
      );
      destroyed.delete(id);
    }
    for (const id of destroyed) {
      parts.push(
        `<D:response><D:href>${xmlEscape(
          eventPath(access.accountId, cal.id, id),
        )}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`,
      );
    }
  }
  return multistatus(parts, `${SYNC_PREFIX}${since}`);
}

async function calMultiget(
  store: Mailstore,
  access: AccountAccess,
  cal: CalendarRow,
  body: string,
): Promise<Response> {
  const parts: string[] = [];
  for (const rawHref of hrefsOf(body)) {
    const name = decodeURIComponent(rawHref.split("/").filter(Boolean).pop() ?? "");
    const row = await store.getEventByDavName(access.accountId, cal.id, stripIcs(name));
    if (!row) {
      parts.push(
        `<D:response><D:href>${xmlEscape(rawHref)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`,
      );
      continue;
    }
    parts.push(
      response(eventPath(access.accountId, cal.id, row.davName ?? row.id), {
        getetag: xmlEscape(etagOf(row.id, row.updatedAt)),
        "calendar-data": xmlEscape(serializeICal(row.event)),
      }),
    );
  }
  return multistatus(parts);
}

/** calendar-query: time-range filter honored via the occurrence expander;
 * other filters return the whole calendar (Apple syncs via
 * sync-collection + multiget — query is a fallback path). */
async function calQuery(
  store: Mailstore,
  access: AccountAccess,
  cal: CalendarRow,
  body: string,
): Promise<Response> {
  const tr = body.match(/<(?:[A-Za-z0-9_-]+:)?time-range([^>]*)\/?>/);
  let after: number | undefined;
  let before: number | undefined;
  if (tr) {
    const startAttr = tr[1]!.match(/start="([^"]+)"/)?.[1];
    const endAttr = tr[1]!.match(/end="([^"]+)"/)?.[1];
    const parse = (v?: string) => {
      if (!v) return undefined;
      const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : undefined;
    };
    after = parse(startAttr);
    before = parse(endAttr);
  }

  const wantData = /calendar-data/i.test(body);
  const rows = (await store.getCalendarEvents(access.accountId)).filter(
    (r) => r.calendarId === cal.id,
  );
  const parts: string[] = [];
  for (const row of rows) {
    if (after !== undefined || before !== undefined) {
      // Indexed outer span first (cheap, can only over-include)…
      if (before !== undefined && (row.startAt === null || row.startAt >= before)) continue;
      if (after !== undefined && row.endAt !== null && row.endAt <= after) continue;
      // …then the real occurrence check for recurring events.
      if (row.isRecurring) {
        const hit = expandOccurrences(row.event, { after, before, maxOccurrences: 1 });
        if (hit.length === 0) continue;
      }
    }
    parts.push(
      response(eventPath(access.accountId, cal.id, row.davName ?? row.id), {
        getetag: xmlEscape(etagOf(row.id, row.updatedAt)),
        ...(wantData ? { "calendar-data": xmlEscape(serializeICal(row.event)) } : {}),
      }),
    );
  }
  return multistatus(parts);
}

async function handleEventResource(
  request: Request,
  env: Env,
  store: Mailstore,
  principal: Principal,
  access: AccountAccess,
  calId: string,
  rawName: string,
): Promise<Response> {
  const cal = await requireCalendar(store, access, calId);
  const name = stripIcs(rawName);

  if (request.method === "GET" || request.method === "HEAD") {
    await audit(env, principal, access, "dav:cal-read");
    const row = await store.getEventByDavName(access.accountId, cal.id, name);
    if (!row) return new Response("not found", { status: 404 });
    const ics = serializeICal(row.event);
    return new Response(request.method === "HEAD" ? null : ics, {
      headers: {
        "content-type": "text/calendar; charset=utf-8; component=VEVENT",
        etag: etagOf(row.id, row.updatedAt),
      },
    });
  }

  if (request.method === "PUT") {
    await requireCalWrite(env, principal, access);
    const { event, warnings } = parseICal(await request.text());
    if (!event) return new Response(`no VEVENT in body (${warnings.join("; ")})`, { status: 400 });
    // parseICal drops RRULEs the expander cannot honour (calendar-core
    // SUPPORTED_PARTS) and the VEVENT is still stored, minus the rule. Say
    // so rather than 4xx-ing: failing the PUT would stall the client's whole
    // sync over one event. A header keeps it out of the silence the original
    // defect lived in without breaking Apple Calendar.
    const warned: Record<string, string> =
      warnings.length > 0 ? { "bullmoose-ical-warnings": warnings.join("; ") } : {};

    const existing = await store.getEventByDavName(access.accountId, cal.id, name);
    const ifMatch = request.headers.get("If-Match");
    const ifNoneMatch = request.headers.get("If-None-Match");
    if (ifNoneMatch === "*" && existing) return new Response("exists", { status: 412 });
    if (ifMatch) {
      if (!existing || !etagMatches(ifMatch, etagOf(existing.id, existing.updatedAt))) {
        return new Response("etag mismatch", { status: 412 });
      }
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const uid = String(event.uid);
    const blob = event as JSCalendarEventBlob;
    blob["@type"] = "Event";
    if (typeof blob.created !== "string") blob.created = existing?.event.created ?? nowIso;
    blob.updated = nowIso;
    blob.calendarIds = { [cal.id]: true };
    let span;
    try {
      span = eventSpan(blob);
    } catch (err) {
      return new Response(`recurrence expansion failed: ${String(err)}`, { status: 400 });
    }
    const title = typeof blob.title === "string" ? blob.title : null;

    if (existing) {
      if (uid !== existing.uid) throw calUidConflict("a resource's UID cannot change on update");
      await store.updateCalendarEvent(access.accountId, {
        id: existing.id,
        calendarId: cal.id,
        uid: existing.uid,
        event: blob,
        title,
        startAt: span.startMs,
        endAt: span.endMs,
        isRecurring: span.isRecurring,
        davName: name,
        createdAt: existing.createdAt,
        updatedAt: now,
      });
      await store.bumpCalendarCtags(access.accountId, [cal.id]);
      await commitChanges(env.ACCOUNT_DO, access.accountId, [
        { collection: "CalendarEvent", updated: [existing.id] },
      ]);
      return new Response(null, {
        status: 204,
        headers: { etag: etagOf(existing.id, now), ...warned },
      });
    }

    const uidTaken = await store.calendarEventIdsByUids(access.accountId, [uid]);
    if (uidTaken.size > 0) throw calUidConflict(`uid already in use: ${uid}`);
    const id = `ev_${crypto.randomUUID()}`;
    await store.insertCalendarEvents(access.accountId, [
      {
        id,
        calendarId: cal.id,
        uid,
        event: blob,
        title,
        startAt: span.startMs,
        endAt: span.endMs,
        isRecurring: span.isRecurring,
        davName: name,
        createdAt: Date.parse(String(blob.created)) || now,
        updatedAt: now,
      },
    ]);
    await store.bumpCalendarCtags(access.accountId, [cal.id]);
    await commitChanges(env.ACCOUNT_DO, access.accountId, [
      { collection: "CalendarEvent", created: [id] },
    ]);
    return new Response(null, { status: 201, headers: { etag: etagOf(id, now), ...warned } });
  }

  if (request.method === "DELETE") {
    await requireCalWrite(env, principal, access);
    const row = await store.getEventByDavName(access.accountId, cal.id, name);
    if (!row) return new Response("not found", { status: 404 });
    const ifMatch = request.headers.get("If-Match");
    if (ifMatch && !etagMatches(ifMatch, etagOf(row.id, row.updatedAt))) {
      return new Response("etag mismatch", { status: 412 });
    }
    await store.destroyCalendarEvents(access.accountId, [row.id]);
    await store.bumpCalendarCtags(access.accountId, [cal.id]);
    await commitChanges(env.ACCOUNT_DO, access.accountId, [
      { collection: "CalendarEvent", destroyed: [row.id] },
    ]);
    return new Response(null, { status: 204 });
  }

  return notAllowed();
}

function calUidConflict(detail: string): DavError {
  return new DavError(
    409,
    detail,
    `<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:" xmlns:CAL="${CAL}"><CAL:no-uid-conflict/><D:responsedescription>${xmlEscape(detail)}</D:responsedescription></D:error>`,
  );
}

const calHomePath = (acct: string) => `/dav/calendars/${encodeURIComponent(acct)}/`;
const calPath = (acct: string, cal: string) =>
  `/dav/calendars/${encodeURIComponent(acct)}/${encodeURIComponent(cal)}/`;
const eventPath = (acct: string, cal: string, name: string) =>
  `${calPath(acct, cal)}${encodeURIComponent(name)}.ics`;
const stripIcs = (name: string) => name.replace(/\.ics$/i, "");

function uidConflict(detail: string): DavError {
  return new DavError(
    409,
    detail,
    `<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:" xmlns:C="${C}"><C:no-uid-conflict/><D:responsedescription>${xmlEscape(detail)}</D:responsedescription></D:error>`,
  );
}

/** Display/sort name (mirrors the JMAP method's derivation). */
function deriveNameFull(card: JSContactCard): string | null {
  if (typeof card.name?.full === "string" && card.name.full.length > 0) return card.name.full;
  const components = card.name?.components;
  if (Array.isArray(components)) {
    const joined = components
      .filter((c) => c?.kind !== "separator" && typeof c?.value === "string")
      .map((c) => c.value)
      .join(" ")
      .trim();
    if (joined) return joined;
  }
  const orgs = card.organizations as Record<string, { name?: unknown }> | undefined;
  if (orgs && typeof orgs === "object") {
    for (const org of Object.values(orgs)) {
      if (typeof org?.name === "string" && org.name) return org.name;
    }
  }
  const emails = card.emails as Record<string, { address?: unknown }> | undefined;
  if (emails && typeof emails === "object") {
    for (const e of Object.values(emails)) {
      if (typeof e?.address === "string" && e.address) return e.address;
    }
  }
  return null;
}

// ---- paths / etags / DO ------------------------------------------------

const principalPath = (acct: string) => `/dav/principals/${encodeURIComponent(acct)}/`;
const homePath = (acct: string) => `/dav/addressbooks/${encodeURIComponent(acct)}/`;
const bookPath = (acct: string, book: string) =>
  `/dav/addressbooks/${encodeURIComponent(acct)}/${encodeURIComponent(book)}/`;
const cardPath = (acct: string, book: string, name: string) =>
  `${bookPath(acct, book)}${encodeURIComponent(name)}.vcf`;

const stripVcf = (name: string) => name.replace(/\.vcf$/i, "");

const etagOf = (id: string, updatedAt: number) => `"${id}-${updatedAt}"`;

function etagMatches(header: string, etag: string): boolean {
  return header
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === etag || t === "*");
}

const syncToken = (state: string) => `${SYNC_PREFIX}${state}`;

async function doState(env: Env, accountId: string): Promise<string> {
  const res = await accountStub(env.ACCOUNT_DO, accountId).fetch("https://do/state");
  const { state } = (await res.json()) as { state: string };
  return state;
}

// ---- XML ---------------------------------------------------------------

interface PropfindResource {
  href: string;
  props: Record<string, string>;
}

/** Local names of props inside the request's <prop> block ([] = allprop). */
function requestedProps(body: string): string[] {
  const m = body.match(/<(?:[A-Za-z0-9_-]+:)?prop[\s>]([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?prop>/);
  if (!m) return [];
  const names: string[] = [];
  const re = /<(?:[A-Za-z0-9_-]+:)?([A-Za-z0-9_-]+)[^>]*\/?>/g;
  let match;
  while ((match = re.exec(m[1]!)) !== null) {
    if (!match[0]!.startsWith("</")) names.push(match[1]!);
  }
  return names;
}

/** Which namespace prefix each known property serializes under. */
const PROP_NS: Record<string, string> = {
  "addressbook-home-set": "C",
  "supported-address-data": "C",
  "addressbook-description": "C",
  "address-data": "C",
  "calendar-home-set": "CAL",
  "supported-calendar-component-set": "CAL",
  "calendar-description": "CAL",
  "calendar-data": "CAL",
  "calendar-color": "ICAL",
  getctag: "CS",
};

function renderProp(name: string, inner: string): string {
  const ns = PROP_NS[name] ?? "D";
  return inner === "" ? `<${ns}:${name}/>` : `<${ns}:${name}>${inner}</${ns}:${name}>`;
}

/**
 * One `<D:propstat>`: a bag of already-rendered `<D:prop>` children and the
 * status that applies to all of them.
 */
interface Propstat {
  /** Rendered prop elements. Empty groups are dropped unless `always`. */
  props: string;
  status: string;
  description?: string;
  /**
   * Emit even with an empty prop bag. PROPFIND needs it — "found, and none
   * of what you asked for" is still a 200 propstat — while PROPPATCH must
   * never claim 200 for zero properties.
   */
  always?: boolean;
}

/**
 * The single `<D:response>` shape, shared by PROPFIND, the REPORTs and
 * PROPPATCH. PROPPATCH is why this is factored out: RFC 4918 §9.2 gives it
 * the *same* body as PROPFIND but a different status per group, and a second
 * hand-rolled builder would be free to disagree with this one.
 */
function responseXml(hrefPath: string, groups: Propstat[]): string {
  return (
    `<D:response><D:href>${xmlEscape(hrefPath)}</D:href>` +
    groups
      .filter((g) => g.props !== "" || g.always === true)
      .map(
        (g) =>
          `<D:propstat><D:prop>${g.props}</D:prop><D:status>${g.status}</D:status>` +
          (g.description
            ? `<D:responsedescription>${xmlEscape(g.description)}</D:responsedescription>`
            : "") +
          `</D:propstat>`,
      )
      .join("") +
    `</D:response>`
  );
}

function response(hrefPath: string, props: Record<string, string>): string {
  const rendered = Object.entries(props)
    .map(([k, v]) => renderProp(k, v))
    .join("");
  return responseXml(hrefPath, [{ props: rendered, status: OK_200, always: true }]);
}

function propfindResponse(body: string, resources: PropfindResource[]): Response {
  const wanted = requestedProps(body);
  const parts = resources.map((r) => {
    const known = wanted.length === 0 ? Object.keys(r.props) : wanted.filter((w) => w in r.props);
    const missing = wanted.filter((w) => !(w in r.props));
    const ok = known.map((k) => renderProp(k, r.props[k]!)).join("");
    const notFound = missing.map((k) => renderProp(k, "")).join("");
    return responseXml(r.href, [
      // PROPFIND always says 200, even with nothing in it: a resource with
      // no requested props is "found, and here is nothing".
      { props: ok, status: OK_200, always: true },
      { props: notFound, status: NOT_FOUND_404 },
    ]);
  });
  return multistatus(parts);
}

function multistatus(parts: string[], syncTokenValue?: string): Response {
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:multistatus xmlns:D="${D}" xmlns:C="${C}" xmlns:CAL="${CAL}" xmlns:CS="${CS}"` +
    ` xmlns:ICAL="http://apple.com/ns/ical/">` +
    parts.join("") +
    (syncTokenValue ? `<D:sync-token>${xmlEscape(syncTokenValue)}</D:sync-token>` : "") +
    `</D:multistatus>`;
  return new Response(xml, {
    status: 207,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      DAV: DAV_COMPLIANCE,
    },
  });
}

// ---- MKCOL / MKCALENDAR bodies -----------------------------------------

interface MkcolProps {
  displayname: string | null;
  description: string | null;
  color: string | null;
  /** Raw inner XML of <resourcetype>; null when the body did not set one. */
  resourcetype: string | null;
  /** Component names from supported-calendar-component-set ([] = unset). */
  components: string[];
  /** Props we understood, accepted, and did NOT store. */
  dropped: string[];
}

/**
 * The `<D:set><D:prop>` block both verbs may carry. Only properties the
 * tables can hold are mapped; anything understood-but-unstorable is
 * reported back in `dropped` rather than silently discarded — losing a
 * client's default timezone with a bare 201 is a data-loss surprise.
 */
function parseMkcolProps(body: string): MkcolProps {
  const dropped: string[] = [];
  // calendar-timezone has no column, and neither table stores it.
  if (innerOf(body, "calendar-timezone") !== null) dropped.push("calendar-timezone");

  const components: string[] = [];
  const compRe = /<(?:[A-Za-z0-9_-]+:)?comp\s[^>]*name="([^"]+)"/g;
  const compBlock = innerOf(body, "supported-calendar-component-set") ?? "";
  let m;
  while ((m = compRe.exec(compBlock)) !== null) components.push(m[1]!);

  // address_books has no colour column (data-plane.sql); calendars does.
  const color = text(innerOf(body, "calendar-color"));
  const description =
    text(innerOf(body, "calendar-description")) ?? text(innerOf(body, "addressbook-description"));

  return {
    displayname: text(innerOf(body, "displayname")),
    description,
    color,
    resourcetype: innerOf(body, "resourcetype"),
    components,
    dropped,
  };
}

// ---- PROPPATCH bodies ---------------------------------------------------

/** One instruction from a `<D:propertyupdate>`, in document order. */
interface PropPatchOp {
  action: "set" | "remove";
  /** Local name. Matched namespace-blind, like the rest of this file. */
  name: string;
  /** Resolved namespace URI, used only to echo the name back accurately. */
  ns: string | null;
  /** Raw inner XML for a `set`; null for a `remove` or an empty element. */
  raw: string | null;
}

/**
 * Every `xmlns` binding in the document, flattened to prefix → URI ("" is
 * the default namespace). DAV bodies are one element deep in practice and
 * never rebind a prefix, so a flat map is enough — and it is only used to
 * label properties we are about to refuse, never to decide anything.
 */
function namespaceBindings(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /xmlns(?::([A-Za-z0-9_-]+))?\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(body)) !== null) out[m[1] ?? ""] = m[2]!;
  return out;
}

/**
 * `<D:propertyupdate>` → an ordered instruction list (RFC 4918 §9.2). Both
 * `<D:set>` and `<D:remove>` may appear, more than once, and order matters:
 * a client that sets then removes the same property means the removal.
 */
function parsePropPatch(body: string): PropPatchOp[] {
  const ns = namespaceBindings(body);
  const ops: PropPatchOp[] = [];
  const blockRe =
    /<(?:[A-Za-z0-9_-]+:)?(set|remove)(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?\1\s*>/g;
  let block;
  while ((block = blockRe.exec(body)) !== null) {
    const action = block[1] as "set" | "remove";
    const propBlock = innerOf(block[2]!, "prop");
    if (propBlock === null) continue;
    const childRe =
      /<([A-Za-z0-9_-]+:)?([A-Za-z0-9_-]+)((?:\s[^>]*?)?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?\2\s*>)/g;
    let child;
    while ((child = childRe.exec(propBlock)) !== null) {
      const prefix = child[1] ? child[1].slice(0, -1) : "";
      // A prefix bound on the element itself wins over the document map.
      const local = new RegExp(`xmlns${prefix ? `:${prefix}` : ""}\\s*=\\s*"([^"]*)"`).exec(
        child[3] ?? "",
      );
      ops.push({
        action,
        name: child[2]!,
        ns: local?.[1] ?? ns[prefix] ?? null,
        raw: child[4] ?? null,
      });
    }
  }
  return ops;
}

/** URI → the prefix `multistatus()` declares, so echoes stay readable. */
const NS_PREFIX: Record<string, string> = {
  [D]: "D",
  [C]: "C",
  [CAL]: "CAL",
  [CS]: "CS",
  "http://apple.com/ns/ical/": "ICAL",
};

/**
 * An empty prop element for a PROPPATCH propstat — RFC 4918 §9.2.1 forbids
 * echoing values. A property we do not know still has to come back under
 * the namespace the client sent it in, or the client cannot tell which of
 * its properties was refused.
 */
function renderEmptyProp(op: PropPatchOp): string {
  const known = op.ns === null ? undefined : NS_PREFIX[op.ns];
  if (known) return `<${known}:${op.name}/>`;
  if (op.ns !== null) return `<${op.name} xmlns="${xmlEscape(op.ns)}"/>`;
  return renderProp(op.name, "");
}

/** Raw inner XML of the first `localName` element, or null when absent. */
function innerOf(body: string, localName: string): string | null {
  const re = new RegExp(
    `<(?:[A-Za-z0-9_-]+:)?${localName}[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${localName}>`,
  );
  const m = body.match(re);
  return m ? m[1]! : null;
}

const text = (raw: string | null): string | null =>
  raw === null ? null : xmlUnescape(raw).trim() || null;

/** A DavError carrying a spec precondition element, not bare prose. */
function precondition(status: number, element: string, detail: string): DavError {
  return new DavError(
    status,
    detail,
    `<?xml version="1.0" encoding="utf-8"?>` +
      `<D:error xmlns:D="${D}" xmlns:C="${C}" xmlns:CAL="${CAL}">` +
      `<${element}/><D:responsedescription>${xmlEscape(detail)}</D:responsedescription>` +
      `</D:error>`,
  );
}

/**
 * 201 for a created collection, carrying the new ctag and the account
 * sync-token so the client does not have to turn around and PROPFIND.
 * Both `CAL:mkcalendar-response` (RFC 4791 §5.3.1.2) and `D:mkcol-response`
 * (RFC 5689 §5.2) permit exactly this shape.
 */
function mkcolResponse(root: string, state: string, dropped: string[]): Response {
  const failed = dropped.map((p) => renderProp(p, "")).join("");
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<${root} xmlns:D="${D}" xmlns:C="${C}" xmlns:CAL="${CAL}" xmlns:CS="${CS}"` +
    ` xmlns:ICAL="http://apple.com/ns/ical/">` +
    `<D:propstat><D:prop>` +
    `<CS:getctag>0</CS:getctag><D:sync-token>${xmlEscape(syncToken(state))}</D:sync-token>` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>` +
    (failed
      ? `<D:propstat><D:prop>${failed}</D:prop>` +
        `<D:status>HTTP/1.1 403 Forbidden</D:status>` +
        `<D:responsedescription>not stored by this server</D:responsedescription></D:propstat>`
      : "") +
    `</${root}>`;
  return new Response(xml, {
    status: 201,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      DAV: DAV_COMPLIANCE,
      // Mirrors the PUT path's bullmoose-ical-warnings: the collection WAS
      // created, and here is what we did not keep.
      ...(dropped.length > 0 ? { "bullmoose-dav-warnings": `dropped: ${dropped.join(", ")}` } : {}),
    },
  });
}

function reportRoot(body: string): string {
  const stripped = body.replace(/<\?xml[\s\S]*?\?>/, "").replace(/<!--[\s\S]*?-->/g, "");
  const m = stripped.match(/<(?:[A-Za-z0-9_-]+:)?([A-Za-z0-9_-]+)[\s/>]/);
  return m?.[1] ?? "";
}

function hrefsOf(body: string): string[] {
  const out: string[] = [];
  const re = /<(?:[A-Za-z0-9_-]+:)?href[^>]*>([^<]+)<\/(?:[A-Za-z0-9_-]+:)?href>/g;
  let m;
  while ((m = re.exec(body)) !== null) out.push(xmlUnescape(m[1]!.trim()));
  return out;
}

function textOf(body: string, localName: string): string {
  const re = new RegExp(
    `<(?:[A-Za-z0-9_-]+:)?${localName}[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${localName}>`,
  );
  const m = body.match(re);
  return m ? xmlUnescape(m[1]!) : "";
}

const href = (path: string) => `<D:href>${xmlEscape(path)}</D:href>`;

function xmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function xmlUnescape(s: string): string {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function notAllowed(): Response {
  return new Response("method not allowed", {
    status: 405,
    headers: { Allow: DAV_ALLOW },
  });
}
