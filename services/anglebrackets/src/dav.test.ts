import { describe, expect, it } from "vitest";
import { handleDav } from "./dav";
import worker from "./index";
import type { Env } from "./index";
import type { Principal } from "@bullmoose/auth-core/principal";

/**
 * sVOL 009 — DAV collection creation (MKCOL / MKCALENDAR) and collection
 * DELETE. `services/anglebrackets` had no tests at all before this file, so
 * the fakes below are deliberately self-contained: sVOL 002 is consolidating
 * the four existing fake-D1 copies in parallel and this must not become a
 * fifth thing it has to reconcile mid-flight.
 *
 * These drive the real dispatcher end-to-end — handleDav → requireAccess →
 * the scope/owner gate → Mailstore → the AccountDO commit — because the two
 * things most likely to be got wrong are not visible from a unit test of any
 * one function:
 *
 *   1. ROUTING ORDER. handleBook/handleCalendar resolve the collection
 *      BEFORE branching on method, so a create verb aimed at a NEW path 404s
 *      at requireBook/requireCalendar and never reaches the handler at all.
 *      Every "creates at the client's URI" test below is really a test that
 *      the branch sits ahead of that resolution.
 *   2. THE CHANGELOG. A collection written straight to D1 reads back fine on
 *      a PROPFIND and is invisible to Calendar/changes forever
 *      (_context.md §3). So the commit is asserted, not just the INSERT.
 */

// ---- fakes -------------------------------------------------------------

const ACCOUNT = "a_eric";
const TENANT = "t_bm";

type Row = Record<string, unknown>;

const calRow = (over: Row = {}): Row => ({
  id: "cal_seed",
  name: "Calendar",
  description: null,
  color: null,
  sort_order: 0,
  is_default: 1,
  is_subscribed: 1,
  ctag: 3,
  created_at: 1,
  updated_at: 1,
  ...over,
});

const bookRow = (over: Row = {}): Row => ({
  id: "ab_seed",
  name: "Contacts",
  description: null,
  sort_order: 0,
  is_default: 1,
  is_subscribed: 1,
  ctag: 3,
  created_at: 1,
  updated_at: 1,
  ...over,
});

/** A fake D1 that routes by table name and records every write. */
function fakeD1(seed: Partial<Record<string, Row[]>> = {}) {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const tables: Record<string, Row[]> = {
    calendars: seed.calendars ?? [],
    address_books: seed.address_books ?? [],
    calendar_events: seed.calendar_events ?? [],
    contact_cards: seed.contact_cards ?? [],
    dav_tombstones: [],
  };
  const rowsFor = (sql: string): Row[] => {
    for (const name of Object.keys(tables)) {
      if (sql.includes(`FROM ${name}`)) return tables[name]!;
    }
    return [];
  };

  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    return {
      sql,
      bound: () => bound,
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async first() {
        return rowsFor(sql)[0] ?? null;
      },
      async all() {
        return { results: rowsFor(sql) };
      },
      async run() {
        writes.push({ sql, args: bound });
        return { meta: { changes: 1 } };
      },
    };
  };

  const batch = async (stmts: Array<{ sql: string; bound: () => unknown[] }>) => {
    for (const s of stmts) writes.push({ sql: s.sql, args: s.bound() });
    return stmts.map((s) => ({ results: rowsFor(s.sql) }));
  };

  return { db: { prepare, batch }, writes };
}

/** Records what was committed to the changelog — the assertion that matters. */
function fakeAccountDo() {
  const commits: Array<{
    collection: string;
    created?: string[];
    updated?: string[];
    destroyed?: string[];
  }> = [];
  const stub = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/state")) {
        return new Response(JSON.stringify({ state: "41" }));
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { entries?: typeof commits };
      commits.push(...(body.entries ?? []));
      return new Response(JSON.stringify({ oldState: "41", newState: "42" }));
    },
  };
  return { ns: { idFromName: (n: string) => n, get: () => stub }, commits };
}

function harness(seed: Partial<Record<string, Row[]>> = {}) {
  const { db, writes } = fakeD1(seed);
  const { ns, commits } = fakeAccountDo();
  const env = { DB: db, BLOBS: {}, ACCOUNT_DO: ns } as unknown as Env;

  const call = (method: string, path: string, principal: Principal, body = "") => {
    const url = new URL(`https://dav.example${path}`);
    const request = new Request(url, {
      method,
      ...(body ? { body } : {}),
    });
    return handleDav(request, url, env, principal);
  };

  const written = (fragment: string) => writes.filter((w) => w.sql.includes(fragment));

  return { call, writes, written, commits };
}

const owner = (scopes: string[] = ["read", "contacts", "calendar"]): Principal => ({
  username: "eric@login.example",
  scopes,
  accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
});

const sharee = (): Principal => ({
  username: "assistant@login.example",
  scopes: ["read", "contacts", "calendar"],
  accounts: [
    {
      accountId: ACCOUNT,
      tenantId: TENANT,
      name: "Eric",
      granted: [
        {
          grantId: "g_1",
          scopes: ["read", "contacts", "calendar"],
          collection: null,
          collectionId: null,
        },
      ],
    },
  ],
});

// The path segment Apple Calendar invents for itself: a client-chosen UUID,
// not a server-minted `cal_…` id.
const CLIENT_UUID = "9F1C3A20-6C1E-4E1E-8A4F-2B0F0E3C7D11";
const calUrl = (id: string) => `/dav/calendars/${ACCOUNT}/${id}/`;
const bookUrl = (id: string) => `/dav/addressbooks/${ACCOUNT}/${id}/`;

const MKCALENDAR_BODY =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<B:mkcalendar xmlns:B="urn:ietf:params:xml:ns:caldav"><A:set xmlns:A="DAV:"><A:prop>` +
  `<A:displayname>Work</A:displayname>` +
  `<B:calendar-description>Work things</B:calendar-description>` +
  `<I:calendar-color xmlns:I="http://apple.com/ns/ical/">#FF2968</I:calendar-color>` +
  `<B:supported-calendar-component-set><B:comp name="VEVENT"/></B:supported-calendar-component-set>` +
  `</A:prop></A:set></B:mkcalendar>`;

const MKCOL_BODY =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:set><D:prop>` +
  `<D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>` +
  `<D:displayname>Vendors</D:displayname>` +
  `<C:addressbook-description>Suppliers</C:addressbook-description>` +
  `</D:prop></D:set></D:mkcol>`;

// ---- MKCALENDAR --------------------------------------------------------

describe("MKCALENDAR", () => {
  it("creates the calendar AT the client-chosen URI, not a server-minted id", async () => {
    const { call, written } = harness({ calendars: [calRow()] });
    const res = await call("MKCALENDAR", calUrl(CLIENT_UUID), owner(), MKCALENDAR_BODY);

    expect(res.status).toBe(201);
    const [insert] = written("INSERT INTO calendars");
    expect(insert).toBeDefined();
    // column order: id, account_id, name, description, color, sort_order,
    // is_default, is_subscribed, ctag, created_at, updated_at
    const [id, accountId, name, description, color, , isDefault, , ctag] = insert!.args;
    expect(id).toBe(CLIENT_UUID);
    expect(accountId).toBe(ACCOUNT);
    expect(name).toBe("Work");
    expect(description).toBe("Work things");
    expect(color).toBe("#FF2968");
    expect(ctag).toBe(0); // brand new: the client has never seen it
    expect(isDefault).toBe(0); // the seeded calendar is already default
  });

  it("routes ahead of requireCalendar — a NEW path does not 404", async () => {
    // The whole trap: handleCalendar resolves the collection first, so a
    // create branch placed at the bottom of it is unreachable.
    const { call } = harness({ calendars: [calRow()] });
    const res = await call("MKCALENDAR", calUrl(CLIENT_UUID), owner(), MKCALENDAR_BODY);
    expect(res.status).not.toBe(404);
  });

  it("commits Calendar/created so the collection reaches /changes", async () => {
    const { call, commits } = harness({ calendars: [calRow()] });
    await call("MKCALENDAR", calUrl(CLIENT_UUID), owner(), MKCALENDAR_BODY);
    expect(commits).toEqual([{ collection: "Calendar", created: [CLIENT_UUID] }]);
  });

  it("returns the new ctag and the account sync-token in the response body", async () => {
    const { call } = harness({ calendars: [calRow()] });
    const res = await call("MKCALENDAR", calUrl(CLIENT_UUID), owner(), MKCALENDAR_BODY);
    const xml = await res.text();
    expect(xml).toContain("mkcalendar-response");
    expect(xml).toContain("<CS:getctag>0</CS:getctag>");
    expect(xml).toContain("<D:sync-token>bm:sync:42</D:sync-token>");
  });

  it("becomes the default only when the account has none", async () => {
    const empty = harness({ calendars: [] });
    await empty.call("MKCALENDAR", calUrl(CLIENT_UUID), owner(), MKCALENDAR_BODY);
    expect(empty.written("INSERT INTO calendars")[0]!.args[6]).toBe(1);

    // …and never steals it, or the partial UNIQUE index `calendars_default`
    // turns a client's New Calendar into a 500.
    const seeded = harness({ calendars: [calRow()] });
    await seeded.call("MKCALENDAR", calUrl(CLIENT_UUID), owner(), MKCALENDAR_BODY);
    expect(seeded.written("INSERT INTO calendars")[0]!.args[6]).toBe(0);
  });

  it("405s on a path that already exists, and writes nothing", async () => {
    const { call, written } = harness({ calendars: [calRow({ id: "taken" })] });
    const res = await call("MKCALENDAR", calUrl("taken"), owner(), MKCALENDAR_BODY);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toContain("MKCALENDAR");
    expect(written("INSERT INTO calendars")).toEqual([]);
  });

  it.each([
    ["a space", "bad name"],
    ["a leading dot", ".hidden"],
    ["a slash-free traversal attempt", "..evil"],
    ["over 64 chars", "c".repeat(65)],
  ])("403s on %s and writes nothing", async (_label, id) => {
    const { call, written } = harness({ calendars: [calRow()] });
    const res = await call("MKCALENDAR", calUrl(id), owner(), MKCALENDAR_BODY);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("calendar-collection-location-ok");
    expect(written("INSERT INTO calendars")).toEqual([]);
  });

  it("403s when the client asks for a component set we cannot serve", async () => {
    const { call, written } = harness({ calendars: [calRow()] });
    const body = MKCALENDAR_BODY.replace(
      `<B:comp name="VEVENT"/>`,
      `<B:comp name="VEVENT"/><B:comp name="VTODO"/>`,
    );
    const res = await call("MKCALENDAR", calUrl(CLIENT_UUID), owner(), body);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("supported-calendar-component");
    expect(written("INSERT INTO calendars")).toEqual([]);
  });

  it("accepts an empty body and names the calendar after its URI", async () => {
    const { call, written } = harness({ calendars: [calRow()] });
    const res = await call("MKCALENDAR", calUrl(CLIENT_UUID), owner());
    expect(res.status).toBe(201);
    expect(written("INSERT INTO calendars")[0]!.args[2]).toBe(CLIENT_UUID);
  });

  it("says so when it drops calendar-timezone rather than silently losing it", async () => {
    const { call } = harness({ calendars: [calRow()] });
    const body = MKCALENDAR_BODY.replace(
      `<A:displayname>Work</A:displayname>`,
      `<A:displayname>Work</A:displayname><B:calendar-timezone>BEGIN:VCALENDAR</B:calendar-timezone>`,
    );
    const res = await call("MKCALENDAR", calUrl(CLIENT_UUID), owner(), body);
    expect(res.status).toBe(201);
    expect(res.headers.get("bullmoose-dav-warnings")).toContain("calendar-timezone");
    expect(await res.text()).toContain("403 Forbidden");
  });

  it("403s without the calendar scope", async () => {
    const { call, written } = harness({ calendars: [calRow()] });
    const res = await call("MKCALENDAR", calUrl(CLIENT_UUID), owner(["read"]), MKCALENDAR_BODY);
    expect(res.status).toBe(403);
    expect(written("INSERT INTO calendars")).toEqual([]);
  });

  it("403s for a sharee — only the owner manages collections", async () => {
    const { call, written } = harness({ calendars: [calRow()] });
    const res = await call("MKCALENDAR", calUrl(CLIENT_UUID), sharee(), MKCALENDAR_BODY);
    expect(res.status).toBe(403);
    expect(written("INSERT INTO calendars")).toEqual([]);
  });
});

// ---- MKCOL (extended, RFC 6352 §5.2 / RFC 5689) -------------------------

describe("MKCOL", () => {
  it("creates the address book at the client-chosen URI", async () => {
    const { call, written, commits } = harness({ address_books: [bookRow()] });
    const res = await call("MKCOL", bookUrl(CLIENT_UUID), owner(), MKCOL_BODY);

    expect(res.status).toBe(201);
    const [insert] = written("INSERT INTO address_books");
    // column order: id, account_id, name, description, sort_order,
    // is_default, is_subscribed, ctag, created_at, updated_at
    const [id, , name, description, , isDefault, , ctag] = insert!.args;
    expect(id).toBe(CLIENT_UUID);
    expect(name).toBe("Vendors");
    expect(description).toBe("Suppliers");
    expect(isDefault).toBe(0);
    expect(ctag).toBe(0);
    expect(commits).toEqual([{ collection: "AddressBook", created: [CLIENT_UUID] }]);
    expect(await res.text()).toContain("mkcol-response");
  });

  it("routes ahead of requireBook — a NEW path does not 404", async () => {
    const { call } = harness({ address_books: [bookRow()] });
    const res = await call("MKCOL", bookUrl(CLIENT_UUID), owner(), MKCOL_BODY);
    expect(res.status).not.toBe(404);
  });

  it("403s on a resourcetype that is not an address book", async () => {
    const { call, written } = harness({ address_books: [bookRow()] });
    const body = MKCOL_BODY.replace(`<C:addressbook/>`, `<CAL:calendar xmlns:CAL="x"/>`);
    const res = await call("MKCOL", bookUrl(CLIENT_UUID), owner(), body);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("valid-resourcetype");
    expect(written("INSERT INTO address_books")).toEqual([]);
  });

  it("405s on a path that already exists", async () => {
    const { call, written } = harness({ address_books: [bookRow({ id: "taken" })] });
    const res = await call("MKCOL", bookUrl("taken"), owner(), MKCOL_BODY);
    expect(res.status).toBe(405);
    expect(written("INSERT INTO address_books")).toEqual([]);
  });

  it("403s without the contacts scope, and for a sharee", async () => {
    const noScope = harness({ address_books: [bookRow()] });
    expect(
      (await noScope.call("MKCOL", bookUrl(CLIENT_UUID), owner(["read"]), MKCOL_BODY)).status,
    ).toBe(403);
    expect(noScope.written("INSERT INTO address_books")).toEqual([]);

    const shared = harness({ address_books: [bookRow()] });
    expect((await shared.call("MKCOL", bookUrl(CLIENT_UUID), sharee(), MKCOL_BODY)).status).toBe(
      403,
    );
    expect(shared.written("INSERT INTO address_books")).toEqual([]);
  });
});

// ---- collection DELETE --------------------------------------------------

describe("DELETE on a collection", () => {
  it("removes a calendar and everything in it, and commits both collections", async () => {
    const { call, written, commits } = harness({
      calendars: [calRow(), calRow({ id: "cal_work", is_default: 0 })],
      calendar_events: [{ id: "ev_1", calendar_id: "cal_work", dav_name: null }],
    });
    const res = await call("DELETE", calUrl("cal_work"), owner());

    expect(res.status).toBe(204);
    expect(written("DELETE FROM calendars")).toHaveLength(1);
    expect(written("DELETE FROM calendar_events")).toHaveLength(1);
    expect(commits).toEqual([
      { collection: "Calendar", destroyed: ["cal_work"] },
      { collection: "CalendarEvent", destroyed: ["ev_1"] },
    ]);
  });

  it("prunes tombstones so a later sync-collection stays coherent", async () => {
    const { call, written } = harness({
      calendars: [calRow(), calRow({ id: "cal_work", is_default: 0 })],
      calendar_events: [{ id: "ev_1", calendar_id: "cal_work", dav_name: null }],
    });
    await call("DELETE", calUrl("cal_work"), owner());
    expect(written("DELETE FROM dav_tombstones")).toHaveLength(1);
  });

  it("refuses to delete the default calendar rather than silently promoting one", async () => {
    const { call, written } = harness({ calendars: [calRow()] });
    const res = await call("DELETE", calUrl("cal_seed"), owner());
    expect(res.status).toBe(403);
    expect(written("DELETE FROM calendars")).toEqual([]);
  });

  it("removes an address book, its cards, and the grants scoped to it", async () => {
    const { call, written, commits } = harness({
      address_books: [bookRow(), bookRow({ id: "ab_work", is_default: 0 })],
      contact_cards: [{ id: "cc_1", address_book_id: "ab_work", dav_name: null }],
    });
    const res = await call("DELETE", bookUrl("ab_work"), owner());

    expect(res.status).toBe(204);
    expect(written("DELETE FROM address_books")).toHaveLength(1);
    expect(written("DELETE FROM contact_cards")).toHaveLength(1);
    // parity with AddressBook/set: a destroyed book takes its sharing along
    expect(written("DELETE FROM grants")).toHaveLength(1);
    expect(commits).toEqual([
      { collection: "AddressBook", destroyed: ["ab_work"] },
      { collection: "ContactCard", destroyed: ["cc_1"] },
    ]);
  });

  it("refuses to delete the default address book", async () => {
    const { call, written } = harness({ address_books: [bookRow()] });
    const res = await call("DELETE", bookUrl("ab_seed"), owner());
    expect(res.status).toBe(403);
    expect(written("DELETE FROM address_books")).toEqual([]);
  });

  it("404s on an unknown collection", async () => {
    const { call } = harness({ calendars: [calRow()] });
    expect((await call("DELETE", calUrl("nope"), owner())).status).toBe(404);
  });

  it("403s for a sharee", async () => {
    const { call, written } = harness({
      calendars: [calRow(), calRow({ id: "cal_work", is_default: 0 })],
    });
    expect((await call("DELETE", calUrl("cal_work"), sharee())).status).toBe(403);
    expect(written("DELETE FROM calendars")).toEqual([]);
  });
});

// ---- PROPPATCH ----------------------------------------------------------
//
// common/026 item 3. Apple Calendar renames and recolours a collection with
// PROPPATCH; before this it fell through to `notAllowed()`… except it did
// not even get that far, because the dispatcher had no branch, so the client
// saw a plain 405 for the whole request and — the sharper defect — a body
// that says nothing about WHICH property failed.
//
// The thing most easily got wrong here is the response SHAPE: 207 with one
// <propstat> per outcome and a status on each. A partial success is normal.
// So every test below asserts the PER-PROPERTY status, not just the 207.

/** Status line → the local names of the props inside that propstat. */
function propstats(xml: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const re = /<D:propstat><D:prop>([\s\S]*?)<\/D:prop><D:status>([^<]+)<\/D:status>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    out[m[2]!] = [...m[1]!.matchAll(/<(?:[A-Za-z0-9_-]+:)?([A-Za-z0-9_-]+)[^>]*\/>/g)].map(
      (x) => x[1]!,
    );
  }
  return out;
}

const OK = "HTTP/1.1 200 OK";
const FORBIDDEN = "HTTP/1.1 403 Forbidden";
const CONFLICT = "HTTP/1.1 409 Conflict";

const ICAL = "http://apple.com/ns/ical/";

/** The real Apple shape: prefixed DAV:, and its own ns bound per element. */
const propertyupdate = (inner: string, verb: "set" | "remove" = "set") =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<A:propertyupdate xmlns:A="DAV:">` +
  `<A:${verb}><A:prop>${inner}</A:prop></A:${verb}>` +
  `</A:propertyupdate>`;

const RENAME = propertyupdate(`<A:displayname>Renamed</A:displayname>`);

describe("PROPPATCH on a calendar", () => {
  it("renames it: 200 on displayname, the column written, ctag bumped, change committed", async () => {
    const { call, writes, written, commits } = harness({ calendars: [calRow({ id: "cal_work" })] });
    const res = await call("PROPPATCH", calUrl("cal_work"), owner(), RENAME);

    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(propstats(xml)).toEqual({ [OK]: ["displayname"] });
    expect(xml).toContain(`<D:href>/dav/calendars/${ACCOUNT}/cal_work/</D:href>`);

    // Mailstore mutation…
    const update = writes.find((w) => w.sql.startsWith("UPDATE calendars SET updated_at"))!;
    expect(update.sql).toContain("name = ?");
    expect(update.args).toContain("Renamed");
    // …ctag bump…
    expect(written("UPDATE calendars SET ctag = ctag + 1")).toHaveLength(1);
    // …and the commit, without which the rename never reaches /changes.
    expect(commits).toEqual([{ collection: "Calendar", updated: ["cal_work"] }]);
  });

  it("recolours it — the property Apple sends for a colour swatch", async () => {
    const { call, writes } = harness({ calendars: [calRow({ id: "cal_work" })] });
    const body = propertyupdate(
      `<B:calendar-color xmlns:B="${ICAL}" symbolic-color="custom">#FF2968FF</B:calendar-color>`,
    );
    const res = await call("PROPPATCH", calUrl("cal_work"), owner(), body);

    expect(propstats(await res.text())).toEqual({ [OK]: ["calendar-color"] });
    const update = writes.find((w) => w.sql.startsWith("UPDATE calendars SET updated_at"))!;
    expect(update.sql).toContain("color = ?");
    // Apple's #RRGGBBAA is stored verbatim — validateCalendarPatch takes any
    // string, and a stricter pattern here would refuse the real client.
    expect(update.args).toContain("#FF2968FF");
  });

  it("sets calendar-description", async () => {
    const { call, writes } = harness({ calendars: [calRow({ id: "cal_work" })] });
    const body = propertyupdate(
      `<B:calendar-description xmlns:B="urn:ietf:params:xml:ns:caldav">Sprints</B:calendar-description>`,
    );
    const res = await call("PROPPATCH", calUrl("cal_work"), owner(), body);

    expect(propstats(await res.text())).toEqual({ [OK]: ["calendar-description"] });
    const update = writes.find((w) => w.sql.startsWith("UPDATE calendars SET updated_at"))!;
    expect(update.sql).toContain("description = ?");
    expect(update.args).toContain("Sprints");
  });

  it("PARTIAL SUCCESS: the rename lands even though a sibling property is refused", async () => {
    // Apple ships calendar-order in the same <propertyupdate> as displayname.
    // RFC 4918's all-or-nothing reading would 424 the rename over it, which
    // is the original defect back again — so this asserts the deviation.
    const { call, writes, commits } = harness({ calendars: [calRow({ id: "cal_work" })] });
    const body = propertyupdate(
      `<A:displayname>Renamed</A:displayname>` +
        `<B:calendar-order xmlns:B="${ICAL}">2</B:calendar-order>`,
    );
    const res = await call("PROPPATCH", calUrl("cal_work"), owner(), body);

    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(propstats(xml)).toEqual({ [OK]: ["displayname"], [FORBIDDEN]: ["calendar-order"] });
    // The refusal is per-property, inside the 207 — not the whole request.
    expect(xml).toContain("403 Forbidden");
    expect(writes.some((w) => w.sql.startsWith("UPDATE calendars SET updated_at"))).toBe(true);
    expect(commits).toEqual([{ collection: "Calendar", updated: ["cal_work"] }]);
  });

  it("403s an unknown property per-property, and writes NOTHING", async () => {
    const { call, writes, commits } = harness({ calendars: [calRow({ id: "cal_work" })] });
    const body = propertyupdate(`<B:calendar-order xmlns:B="${ICAL}">2</B:calendar-order>`);
    const res = await call("PROPPATCH", calUrl("cal_work"), owner(), body);

    expect(res.status).toBe(207);
    const stats = propstats(await res.text());
    expect(stats).toEqual({ [FORBIDDEN]: ["calendar-order"] });
    // No property was applied, so no ctag churn and no phantom /changes
    // entry: a client polling the ctag must not be woken for nothing.
    expect(writes.filter((w) => w.sql.startsWith("UPDATE calendars"))).toEqual([]);
    expect(commits).toEqual([]);
  });

  it("echoes a foreign property under its OWN namespace so the client can tell which failed", async () => {
    const { call } = harness({ calendars: [calRow({ id: "cal_work" })] });
    const body = propertyupdate(`<Z:whatever xmlns:Z="http://example.test/ns/">x</Z:whatever>`);
    const xml = await (await call("PROPPATCH", calUrl("cal_work"), owner(), body)).text();
    expect(xml).toContain(`<whatever xmlns="http://example.test/ns/"/>`);
  });

  it("409s a displayname over 255 chars rather than truncating it", async () => {
    const { call, writes } = harness({ calendars: [calRow({ id: "cal_work" })] });
    const body = propertyupdate(`<A:displayname>${"n".repeat(256)}</A:displayname>`);
    const res = await call("PROPPATCH", calUrl("cal_work"), owner(), body);

    expect(res.status).toBe(207);
    expect(propstats(await res.text())).toEqual({ [CONFLICT]: ["displayname"] });
    expect(writes.filter((w) => w.sql.startsWith("UPDATE calendars"))).toEqual([]);
  });

  it("<remove> nulls a colour but may not remove the name", async () => {
    const { call, writes } = harness({ calendars: [calRow({ id: "cal_work" })] });
    const body = propertyupdate(`<B:calendar-color xmlns:B="${ICAL}"/>`, "remove");
    const res = await call("PROPPATCH", calUrl("cal_work"), owner(), body);
    expect(propstats(await res.text())).toEqual({ [OK]: ["calendar-color"] });
    const update = writes.find((w) => w.sql.startsWith("UPDATE calendars SET updated_at"))!;
    expect(update.sql).toContain("color = ?");
    expect(update.args).toContain(null);

    const named = harness({ calendars: [calRow({ id: "cal_work" })] });
    const res2 = await named.call(
      "PROPPATCH",
      calUrl("cal_work"),
      owner(),
      propertyupdate(`<A:displayname/>`, "remove"),
    );
    expect(propstats(await res2.text())).toEqual({ [FORBIDDEN]: ["displayname"] });
    expect(named.writes.filter((w) => w.sql.startsWith("UPDATE calendars"))).toEqual([]);
  });

  it("honours document order — set then remove the same property means remove", async () => {
    const { call, writes } = harness({ calendars: [calRow({ id: "cal_work" })] });
    const body =
      `<?xml version="1.0" encoding="UTF-8"?><A:propertyupdate xmlns:A="DAV:">` +
      `<A:set><A:prop><A:displayname>Renamed</A:displayname></A:prop></A:set>` +
      `<A:remove><A:prop><A:displayname/></A:prop></A:remove>` +
      `</A:propertyupdate>`;
    const res = await call("PROPPATCH", calUrl("cal_work"), owner(), body);

    // Named once, carrying the LAST outcome — never in two propstats.
    expect(propstats(await res.text())).toEqual({ [FORBIDDEN]: ["displayname"] });
    expect(writes.filter((w) => w.sql.startsWith("UPDATE calendars"))).toEqual([]);
  });

  it("renames the DEFAULT calendar — sVOL 004: role is the contract, name is a label", async () => {
    // Deliberately unlike collection DELETE, which refuses the default:
    // deleting removes the contract-bearer, renaming does not.
    const { call, writes, commits } = harness({ calendars: [calRow({ is_default: 1 })] });
    const res = await call("PROPPATCH", calUrl("cal_seed"), owner(), RENAME);

    expect(propstats(await res.text())).toEqual({ [OK]: ["displayname"] });
    expect(writes.some((w) => w.sql.startsWith("UPDATE calendars SET updated_at"))).toBe(true);
    expect(commits).toEqual([{ collection: "Calendar", updated: ["cal_seed"] }]);
  });

  it("404s an unknown collection", async () => {
    const { call, writes } = harness({ calendars: [calRow()] });
    const res = await call("PROPPATCH", calUrl("nope"), owner(), RENAME);
    expect(res.status).toBe(404);
    expect(writes.filter((w) => w.sql.startsWith("UPDATE calendars"))).toEqual([]);
  });

  it("403s the whole request without the calendar scope, and for a sharee", async () => {
    // Authorization is not a per-property matter: it fails the request.
    const noScope = harness({ calendars: [calRow({ id: "cal_work" })] });
    expect(
      (await noScope.call("PROPPATCH", calUrl("cal_work"), owner(["read"]), RENAME)).status,
    ).toBe(403);
    expect(noScope.writes.filter((w) => w.sql.startsWith("UPDATE calendars"))).toEqual([]);

    const shared = harness({ calendars: [calRow({ id: "cal_work" })] });
    expect((await shared.call("PROPPATCH", calUrl("cal_work"), sharee(), RENAME)).status).toBe(403);
    expect(shared.writes.filter((w) => w.sql.startsWith("UPDATE calendars"))).toEqual([]);
  });

  it("400s a body with no property instructions", async () => {
    const { call } = harness({ calendars: [calRow({ id: "cal_work" })] });
    const res = await call("PROPPATCH", calUrl("cal_work"), owner(), `<A:propertyupdate/>`);
    expect(res.status).toBe(400);
  });
});

describe("PROPPATCH on an address book", () => {
  it("renames it, bumps the ctag, and commits AddressBook/updated", async () => {
    const { call, writes, written, commits } = harness({
      address_books: [bookRow({ id: "ab_work" })],
    });
    const res = await call("PROPPATCH", bookUrl("ab_work"), owner(), RENAME);

    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(propstats(xml)).toEqual({ [OK]: ["displayname"] });
    expect(xml).toContain(`<D:href>/dav/addressbooks/${ACCOUNT}/ab_work/</D:href>`);

    const update = writes.find((w) => w.sql.startsWith("UPDATE address_books SET updated_at"))!;
    expect(update.sql).toContain("name = ?");
    expect(update.args).toContain("Renamed");
    expect(written("UPDATE address_books SET ctag = ctag + 1")).toHaveLength(1);
    expect(commits).toEqual([{ collection: "AddressBook", updated: ["ab_work"] }]);
  });

  it("takes addressbook-description but refuses the calendar realm's twins", async () => {
    const { call, writes } = harness({ address_books: [bookRow({ id: "ab_work" })] });
    const body = propertyupdate(
      `<C:addressbook-description xmlns:C="urn:ietf:params:xml:ns:carddav">Suppliers</C:addressbook-description>` +
        `<B:calendar-description xmlns:B="urn:ietf:params:xml:ns:caldav">no</B:calendar-description>` +
        // address_books has no colour column (data-plane.sql).
        `<I:calendar-color xmlns:I="${ICAL}">#FF2968</I:calendar-color>`,
    );
    const res = await call("PROPPATCH", bookUrl("ab_work"), owner(), body);

    expect(propstats(await res.text())).toEqual({
      [OK]: ["addressbook-description"],
      [FORBIDDEN]: ["calendar-description", "calendar-color"],
    });
    const update = writes.find((w) => w.sql.startsWith("UPDATE address_books SET updated_at"))!;
    expect(update.args).toContain("Suppliers");
  });

  it("measures the name in OCTETS, where a calendar measures CHARS", async () => {
    // Each realm's JMAP validator disagrees on purpose (validateNewBook vs
    // validateNewCalendar), and DAV must accept exactly what JMAP accepts.
    const name = "é".repeat(200); // 200 chars, 400 octets
    const body = propertyupdate(`<A:displayname>${name}</A:displayname>`);

    const book = harness({ address_books: [bookRow({ id: "ab_work" })] });
    expect(
      propstats(await (await book.call("PROPPATCH", bookUrl("ab_work"), owner(), body)).text()),
    ).toEqual({ [CONFLICT]: ["displayname"] });

    const cal = harness({ calendars: [calRow({ id: "cal_work" })] });
    expect(
      propstats(await (await cal.call("PROPPATCH", calUrl("cal_work"), owner(), body)).text()),
    ).toEqual({ [OK]: ["displayname"] });
  });

  it("403s for a sharee — only the owner renames a book", async () => {
    const { call, writes } = harness({ address_books: [bookRow({ id: "ab_work" })] });
    expect((await call("PROPPATCH", bookUrl("ab_work"), sharee(), RENAME)).status).toBe(403);
    expect(writes.filter((w) => w.sql.startsWith("UPDATE address_books"))).toEqual([]);
  });

  it("renames the DEFAULT address book", async () => {
    const { call, commits } = harness({ address_books: [bookRow()] });
    const res = await call("PROPPATCH", bookUrl("ab_seed"), owner(), RENAME);
    expect(propstats(await res.text())).toEqual({ [OK]: ["displayname"] });
    expect(commits).toEqual([{ collection: "AddressBook", updated: ["ab_seed"] }]);
  });
});

// ---- advertisement -----------------------------------------------------
//
// A client decides whether to OFFER "New Calendar" from these headers
// rather than by probing, so the verbs are not shipped until both say so.

describe("verb advertisement", () => {
  it("OPTIONS names MKCOL and MKCALENDAR, and claims extended-mkcol", async () => {
    const res = await worker.fetch(
      new Request("https://dav.example/dav/", { method: "OPTIONS" }),
      {} as Env,
    );
    expect(res.headers.get("Allow")).toContain("MKCOL");
    expect(res.headers.get("Allow")).toContain("MKCALENDAR");
    expect(res.headers.get("Allow")).toContain("PROPPATCH");
    expect(res.headers.get("DAV")).toContain("extended-mkcol");
  });

  it("the 405 Allow header agrees with the OPTIONS one", async () => {
    const { call } = harness({ calendars: [calRow()] });
    const res = await call("POST", calUrl("cal_seed"), owner());
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toContain("MKCALENDAR");
    expect(res.headers.get("Allow")).toContain("MKCOL");
  });
});
