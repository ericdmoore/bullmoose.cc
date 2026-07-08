import { accountStub, commitChanges } from "@bullmoose/account-do";
import {
  accountAccess,
  allowedBookIds,
  matchingGrants,
  principalHasScope,
  type AccountAccess,
  type MethodDomain,
  type Principal,
} from "@bullmoose/auth-core/principal";
import { parseVcf, serializeVcard, type Card } from "@bullmoose/contacts-core";
import { eventSpan, parseICal, serializeICal, expandOccurrences } from "@bullmoose/calendar-core";
import {
  Mailstore,
  type AddressBookRow,
  type CalendarRow,
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
      const homes = principal.accounts
        .map((a) => href(homePath(a.accountId)))
        .join("");
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
      const store = new Mailstore(env.DB, undefined as unknown as R2Bucket);

      // `return await` so a rejected DavError is caught below.
      if (segments.length === 2) return await handleHome(request, env, store, principal, access);
      const bookId = segments[2]!;
      if (segments.length === 3) {
        return await handleBook(request, env, store, principal, access, bookId, await request.text());
      }
      if (segments.length === 4) {
        return await handleResource(request, env, store, principal, access, bookId, segments[3]!);
      }
    }

    if (segments[0] === "calendars" && segments.length >= 2) {
      const access = requireAccess(principal, segments[1]!, "calendar");
      const store = new Mailstore(env.DB, undefined as unknown as R2Bucket);

      if (segments.length === 2) return await handleCalHome(request, env, store, principal, access);
      const calId = segments[2]!;
      if (segments.length === 3) {
        return await handleCalendar(request, env, store, principal, access, calId, await request.text());
      }
      if (segments.length === 4) {
        return await handleEventResource(request, env, store, principal, access, calId, segments[3]!);
      }
    }

    return new Response("not found", { status: 404 });
  } catch (err) {
    if (err instanceof DavError) return err.response();
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

async function visibleBooks(
  store: Mailstore,
  access: AccountAccess,
): Promise<AddressBookRow[]> {
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
      ...(book.description
        ? { "addressbook-description": xmlEscape(book.description) }
        : {}),
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
    if (root === "addressbook-query") return abQuery(store, access, book);
    return new Response(`unsupported report: ${root}`, { status: 403 });
  }

  return notAllowed();
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
    parts.push(
      response(cardPath(access.accountId, book.id, row.davName ?? row.id), {
        getetag: xmlEscape(etagOf(row.id, row.updatedAt)),
        "address-data": xmlEscape(serializeVcard(row.card as Card)),
      }),
    );
  }
  return multistatus(parts);
}

/** v1 addressbook-query: the whole book (filters are a Phase-2.1 nicety —
 * Apple syncs via sync-collection + multiget, not query). */
async function abQuery(
  store: Mailstore,
  access: AccountAccess,
  book: AddressBookRow,
): Promise<Response> {
  const rows = await store.getContactCards(access.accountId);
  const parts = rows
    .filter((r) => r.addressBookId === book.id)
    .map((row) =>
      response(cardPath(access.accountId, book.id, row.davName ?? row.id), {
        getetag: xmlEscape(etagOf(row.id, row.updatedAt)),
        "address-data": xmlEscape(serializeVcard(row.card as Card)),
      }),
    );
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
    const vcf = serializeVcard(row.card as Card);
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
      await store.updateContactCard(access.accountId, {
        id: existing.id,
        addressBookId: book.id,
        uid: existing.uid,
        card: stored,
        nameFull: deriveNameFull(stored),
        davName: name,
        createdAt: existing.createdAt,
        updatedAt: now,
      });
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
    const id = `cc_${crypto.randomUUID()}`;
    await store.insertContactCards(access.accountId, [
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
    ]);
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
    await store.destroyContactCard(access.accountId, row.id);
    await store.bumpAddressBookCtags(access.accountId, [book.id]);
    await commitChanges(env.ACCOUNT_DO, access.accountId, [
      { collection: "ContactCard", destroyed: [row.id] },
    ]);
    return new Response(null, { status: 204 });
  }

  return notAllowed();
}

// ---- CalDAV: calendars ---------------------------------------------------

async function visibleCalendars(
  store: Mailstore,
  access: AccountAccess,
): Promise<CalendarRow[]> {
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
      return new Response(null, { status: 204, headers: { etag: etagOf(existing.id, now) } });
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
    return new Response(null, { status: 201, headers: { etag: etagOf(id, now) } });
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

function response(hrefPath: string, props: Record<string, string>): string {
  const rendered = Object.entries(props)
    .map(([k, v]) => renderProp(k, v))
    .join("");
  return (
    `<D:response><D:href>${xmlEscape(hrefPath)}</D:href>` +
    `<D:propstat><D:prop>${rendered}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>` +
    `</D:response>`
  );
}

function propfindResponse(body: string, resources: PropfindResource[]): Response {
  const wanted = requestedProps(body);
  const parts = resources.map((r) => {
    const known = wanted.length === 0 ? Object.keys(r.props) : wanted.filter((w) => w in r.props);
    const missing = wanted.filter((w) => !(w in r.props));
    const ok = known.map((k) => renderProp(k, r.props[k]!)).join("");
    const notFound = missing.map((k) => renderProp(k, "")).join("");
    return (
      `<D:response><D:href>${xmlEscape(r.href)}</D:href>` +
      `<D:propstat><D:prop>${ok}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>` +
      (notFound
        ? `<D:propstat><D:prop>${notFound}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>`
        : "") +
      `</D:response>`
    );
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
      DAV: "1, 3, addressbook, calendar-access",
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
    headers: { Allow: "OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT" },
  });
}
