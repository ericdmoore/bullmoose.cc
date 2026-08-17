import { beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { handleMcp } from "./mcp";
import { callJmap } from "./jmapBridge";

// sVOL 013 — Calendar + Contacts CRUD over MCP, driven end to end through
// `handleMcp`: bearer → verifyBearer → per-tool authorizeAccount → the JMAP
// method → D1 + the real AccountDO.
//
// The assertions that matter are NOT "the row is there". `_context.md` §3:
// `Mailstore` maintains no invariants, so a tool that wrote via raw SQL — or
// even via the store directly — would land the row, read back fine on a direct
// `/get`, and be invisible to every incremental consumer. The three that catch
// that are:
//
//   * the write shows up in `CalendarEvent/changes` / `ContactCard/changes`
//     (the AccountDO changelog commit),
//   * the collection's `ctag` goes up (CalDAV's re-poll trigger),
//   * a REJECTED write commits nothing and bumps nothing.
//
// A `/get` passing proves none of it. See "the raw-SQL shortcut" tests at the
// bottom of this file for the proof that these assertions bite.
//
// Fakes are @bullmoose/test-fakes (sVOL 002): real node:sqlite over the live
// schema, atomic .batch(), and the REAL AccountDO class behind ACCOUNT_DO.

const V = "2026-07-28";
const TENANT = "t_bm";
const ACCOUNT = "a_eric";
const CAL = "cal_default";
const BOOK = "ab_default";

let minted: { id: string; token: string; secretHash: string };
beforeAll(async () => {
  minted = await mintToken();
});

interface Fixture {
  principalId?: string;
  loginEmail?: string;
  /** The bearer's scopes. Default is everything this unit's tools need. */
  scopes?: string[];
  /** Accounts the principal owns. */
  owns?: string[];
  /** Accounts that exist but belong to someone else. */
  others?: string[];
  /** Cross-account grants. */
  grants?: Array<{ id: string; grantee: string; target: string; scopes: string[] }>;
}

/** A world with one calendar and one address book already in place. */
function world(fx: Fixture = {}): FakeWorker {
  const principalId = fx.principalId ?? "p_eric";
  const w = fakeEnv();

  for (const id of fx.owns ?? [ACCOUNT]) {
    w.db.seedAccount({
      accountId: id,
      tenantId: TENANT,
      principalId,
      loginEmail: fx.loginEmail ?? "eric@bullmoose.cc",
      displayName: "Eric",
    });
  }
  for (const id of fx.others ?? []) {
    w.db.seedAccount({
      accountId: id,
      tenantId: TENANT,
      principalId: `p_owner_${id}`,
      loginEmail: `owner-${id}@bullmoose.cc`,
      displayName: "Someone",
    });
  }
  w.db.seed("tokens", [
    {
      id: minted.id,
      principal_id: principalId,
      kind: "bearer",
      secret_hash: minted.secretHash,
      name: "test",
      scopes: JSON.stringify(fx.scopes ?? ["read", "calendar", "contacts"]),
      created_at: 1,
      expires_at: null,
      last_used_at: Date.now(),
    },
  ]);
  w.db.seed(
    "grants",
    (fx.grants ?? []).map((g) => ({
      id: g.id,
      tenant_id: TENANT,
      grantee_account_id: g.grantee,
      target_account_id: g.target,
      scopes: JSON.stringify(g.scopes),
      collection: null,
      collection_id: null,
      created_by: "admin",
      created_at: 1,
      expires_at: null,
    })),
  );
  // The account whose calendar/book these tests write to is ACCOUNT whether it
  // is owned or grant-reached, so seed its collections unconditionally.
  w.db.seed("calendars", [
    {
      id: CAL,
      account_id: ACCOUNT,
      name: "Calendar",
      description: null,
      color: null,
      sort_order: 0,
      is_default: 1,
      is_subscribed: 1,
      ctag: 1,
      created_at: 1,
      updated_at: 1,
    },
  ]);
  w.db.seed("address_books", [
    {
      id: BOOK,
      account_id: ACCOUNT,
      name: "Contacts",
      description: null,
      sort_order: 0,
      is_default: 1,
      is_subscribed: 1,
      ctag: 1,
      created_at: 1,
      updated_at: 1,
    },
  ]);
  return w;
}

interface RpcReply {
  status: number;
  body: {
    result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
    error?: { code: number; message: string };
  };
  /** The tool's JSON payload, for a successful call. */
  data: Record<string, unknown>;
  /** The tool's message, for `isError: true`. */
  text: string;
}

async function callTool(
  w: FakeWorker,
  name: string,
  args: Record<string, unknown>,
): Promise<RpcReply> {
  const req = new Request("https://agent/mcp/analytics", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${minted.token}`,
      "MCP-Protocol-Version": V,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": V,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  // No cast: the harness supplies every binding services/agent's Env requires.
  const res = await handleMcp(req, w.env);
  const body = (await res.json()) as RpcReply["body"];
  const text = body.result?.content[0]?.text ?? "";
  let data: Record<string, unknown> = {};
  if (body.result && !body.result.isError) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = {};
    }
  }
  return { status: res.status, body, data, text };
}

/** The principal the bridge sees, for driving `Foo/changes` directly. */
const principalFor = (accounts: string[], scopes = ["read"]) => ({
  username: "eric@bullmoose.cc",
  scopes,
  accounts: accounts.map((accountId) => ({ accountId, tenantId: TENANT, name: "Eric" })),
});

/**
 * The literal done-when #2 assertion: not "did the DO record a commit" but
 * "does the registered `Foo/changes` method report it to a client".
 */
function changesSince(w: FakeWorker, collection: "CalendarEvent" | "ContactCard", since: string) {
  return callJmap<{ created: string[]; updated: string[]; destroyed: string[] }>(
    w.env,
    principalFor([ACCOUNT]),
    `${collection}/changes`,
    { accountId: ACCOUNT, sinceState: since },
  );
}

const ctag = (w: FakeWorker, table: "calendars" | "address_books", id: string) =>
  w.db.query<{ ctag: number }>(`SELECT ctag FROM ${table} WHERE id = ?`, id)[0]!.ctag;

const THANKSGIVING = {
  frequency: "yearly",
  byMonth: ["11"],
  byDay: [{ day: "th", nthOfPeriod: 4 }],
};

// ---- calendar CRUD ---------------------------------------------------------

describe("calendar CRUD over MCP", () => {
  it("creates an event and returns its id and the new state string", async () => {
    const w = world();
    const r = await callTool(w, "calendar_create_event", {
      accountId: ACCOUNT,
      title: "Dentist",
      start: "2026-09-14T09:00:00",
      timeZone: "America/New_York",
      duration: "PT1H",
    });
    expect(r.status).toBe(200);
    expect(r.body.result!.isError).toBeUndefined();
    expect(String(r.data.id)).toMatch(/^ev_/);
    // The bread-crumb: return the new state so an agent can pass ifInState on
    // a follow-up and get optimistic concurrency for free.
    expect(typeof r.data.newState).toBe("string");

    const [row] = w.db.query<{ title: string; calendar_id: string }>(
      `SELECT title, calendar_id FROM calendar_events WHERE account_id = ?`,
      ACCOUNT,
    );
    expect(row!.title).toBe("Dentist");
    expect(row!.calendar_id).toBe(CAL);
  });

  it("reports the write through CalendarEvent/changes", async () => {
    // done-when #2, first half. This is the assertion that fails if the tool
    // writes the row and skips commitChanges — a direct /get would not.
    const w = world();
    const before = await w.accountDo.state(ACCOUNT);
    const r = await callTool(w, "calendar_create_event", {
      accountId: ACCOUNT,
      title: "Dentist",
      start: "2026-09-14T09:00:00",
    });

    const delta = await changesSince(w, "CalendarEvent", before);
    expect(delta.created).toEqual([r.data.id]);
    expect(delta.updated).toEqual([]);
    expect(delta.destroyed).toEqual([]);
  });

  it("bumps the calendar's ctag, or CalDAV clients never re-poll", async () => {
    // done-when #2, second half.
    const w = world();
    expect(ctag(w, "calendars", CAL)).toBe(1);
    await callTool(w, "calendar_create_event", {
      accountId: ACCOUNT,
      title: "Dentist",
      start: "2026-09-14T09:00:00",
    });
    expect(ctag(w, "calendars", CAL)).toBe(2);
  });

  it("commits under CalendarEvent only — a spurious collection resyncs every client", async () => {
    const w = world();
    await callTool(w, "calendar_create_event", {
      accountId: ACCOUNT,
      title: "Dentist",
      start: "2026-09-14T09:00:00",
    });
    expect(w.accountDo.commits).toHaveLength(1);
    expect(w.accountDo.commits[0]!.entries.map((e) => e.collection)).toEqual(["CalendarEvent"]);
    expect((await w.accountDo.changes(ACCOUNT, "ContactCard")).created).toEqual([]);
  });

  it("updates an event, and the update reaches the changelog too", async () => {
    const w = world();
    const created = await callTool(w, "calendar_create_event", {
      accountId: ACCOUNT,
      title: "Dentist",
      start: "2026-09-14T09:00:00",
    });
    const id = created.data.id as string;
    const mid = await w.accountDo.state(ACCOUNT);

    const r = await callTool(w, "calendar_update_event", {
      accountId: ACCOUNT,
      eventId: id,
      title: "Dentist (rescheduled)",
      start: "2026-09-15T11:00:00",
    });
    expect(r.body.result!.isError).toBeUndefined();
    expect(r.data).toMatchObject({ id, updated: true });

    const delta = await changesSince(w, "CalendarEvent", mid);
    expect(delta.updated).toEqual([id]);
    expect(ctag(w, "calendars", CAL)).toBe(3);
    expect(
      w.db.query<{ title: string }>(`SELECT title FROM calendar_events WHERE id = ?`, id)[0]!.title,
    ).toBe("Dentist (rescheduled)");
  });

  it("deletes an event, and the delete reaches the changelog too", async () => {
    const w = world();
    const created = await callTool(w, "calendar_create_event", {
      accountId: ACCOUNT,
      title: "Dentist",
      start: "2026-09-14T09:00:00",
    });
    const id = created.data.id as string;
    const mid = await w.accountDo.state(ACCOUNT);

    const r = await callTool(w, "calendar_delete_event", { accountId: ACCOUNT, eventId: id });
    expect(r.data).toMatchObject({ id, destroyed: true });

    const delta = await changesSince(w, "CalendarEvent", mid);
    expect(delta.destroyed).toEqual([id]);
    expect(w.db.query(`SELECT id FROM calendar_events WHERE account_id = ?`, ACCOUNT)).toEqual([]);
  });

  it("refuses a delete of an id that is not there, and says so", async () => {
    const w = world();
    const r = await callTool(w, "calendar_delete_event", {
      accountId: ACCOUNT,
      eventId: "ev_nope",
    });
    expect(r.body.result!.isError).toBe(true);
    expect(r.text).toContain("notFound");
    expect(w.accountDo.commits).toEqual([]);
  });

  it("lists calendars", async () => {
    const w = world();
    const r = await callTool(w, "calendar_list", { accountId: ACCOUNT });
    const list = r.data.list as Array<{ id: string; name: string; isDefault: boolean }>;
    expect(list.map((c) => c.id)).toEqual([CAL]);
    expect(list[0]!.isDefault).toBe(true);
  });

  it("queries events and expands occurrences inside a window", async () => {
    const w = world();
    await callTool(w, "calendar_create_event", {
      accountId: ACCOUNT,
      title: "Standup",
      start: "2026-01-15T09:00:00",
      timeZone: "Etc/UTC",
      duration: "PT1H",
      recurrenceRules: [{ frequency: "monthly", byMonthDay: [15], until: "2026-05-15T09:00:00" }],
    });
    await callTool(w, "calendar_create_event", {
      accountId: ACCOUNT,
      title: "Dentist",
      start: "2026-09-14T09:00:00",
      timeZone: "Etc/UTC",
    });

    const all = await callTool(w, "calendar_query_events", { accountId: ACCOUNT });
    expect((all.data.events as unknown[]).length).toBe(2);
    expect(all.data.occurrences).toBeUndefined();

    const windowed = await callTool(w, "calendar_query_events", {
      accountId: ACCOUNT,
      after: "2026-01-01T00:00:00Z",
      before: "2026-06-01T00:00:00Z",
    });
    // One stored event, five expanded occurrences (Jan..May) — the reason the
    // window path exists at all.
    expect((windowed.data.events as unknown[]).length).toBe(1);
    expect((windowed.data.occurrences as unknown[]).length).toBe(5);
  });

  it("rejects a filter the method does not support instead of ignoring it", async () => {
    const w = world();
    const r = await callTool(w, "calendar_query_events", { accountId: ACCOUNT, text: "x" });
    // `text` IS supported; this asserts the whitelist lets the good ones past.
    expect(r.body.result!.isError).toBeUndefined();
  });
});

// ---- recurrence guard (sVOL 003) ------------------------------------------

describe("the recurrence guard surfaces as an actionable tool error", () => {
  it("refuses a rule the expander cannot expand, and says what to do", async () => {
    // FREQ=YEARLY;BYMONTH=11;BYDAY=4TH — Thanksgiving, a shape Apple Calendar
    // emits. 003 put the guard at the eventSpan write boundary; without a hint
    // the model reads "invalidProperties" and retries the identical payload.
    const w = world();
    const r = await callTool(w, "calendar_create_event", {
      accountId: ACCOUNT,
      title: "Thanksgiving",
      start: "2026-11-26T17:00:00",
      timeZone: "America/New_York",
      duration: "PT4H",
      recurrenceRules: [THANKSGIVING],
    });

    expect(r.status).toBe(200); // a tool error, not a transport error
    expect(r.body.result!.isError).toBe(true);
    expect(r.body.error).toBeUndefined();
    expect(r.text).toContain("nothing was written");
    expect(r.text).toContain("unsupported recurrence rule");
    expect(r.text).toContain("recurrenceRules");
    expect(r.text).toContain("Retrying the same rule will fail the same way");
    // and the structured SetError is there for a program to branch on
    expect(JSON.parse(r.text.slice(r.text.indexOf("{")))).toMatchObject({
      setError: { type: "invalidProperties", properties: ["recurrenceRules"] },
    });
  });

  it("commits nothing and bumps nothing when the rule is refused", async () => {
    const w = world();
    const before = await w.accountDo.state(ACCOUNT);
    await callTool(w, "calendar_create_event", {
      accountId: ACCOUNT,
      title: "Thanksgiving",
      start: "2026-11-26T17:00:00",
      recurrenceRules: [THANKSGIVING],
    });

    expect(w.db.query(`SELECT id FROM calendar_events WHERE account_id = ?`, ACCOUNT)).toEqual([]);
    expect(w.accountDo.commits).toEqual([]);
    expect((await changesSince(w, "CalendarEvent", before)).created).toEqual([]);
    expect(ctag(w, "calendars", CAL)).toBe(1);
  });

  it("still accepts a rule it can expand exactly", async () => {
    const w = world();
    const r = await callTool(w, "calendar_create_event", {
      accountId: ACCOUNT,
      title: "Standup",
      start: "2026-01-15T09:00:00",
      timeZone: "Etc/UTC",
      duration: "PT1H",
      recurrenceRules: [{ frequency: "monthly", byMonthDay: [15], until: "2026-05-15T09:00:00" }],
    });
    expect(r.body.result!.isError).toBeUndefined();
    expect(String(r.data.id)).toMatch(/^ev_/);
  });
});

// ---- contacts CRUD ---------------------------------------------------------

describe("contacts CRUD over MCP", () => {
  it("creates a card, reports it through ContactCard/changes and bumps the book ctag", async () => {
    const w = world();
    const before = await w.accountDo.state(ACCOUNT);
    const r = await callTool(w, "contacts_create_card", {
      accountId: ACCOUNT,
      name: "Ada Lovelace",
      organization: "Analytical Engines",
      emails: ["ada@example.com"],
      phones: ["+1-555-0100"],
    });
    expect(r.body.result!.isError).toBeUndefined();
    const id = r.data.id as string;
    expect(id).toMatch(/^cc_/);

    const delta = await changesSince(w, "ContactCard", before);
    expect(delta.created).toEqual([id]);
    expect(ctag(w, "address_books", BOOK)).toBe(2);

    // The extracted display-name column is what every contacts client lists.
    expect(
      w.db.query<{ name_full: string }>(`SELECT name_full FROM contact_cards WHERE id = ?`, id)[0]!
        .name_full,
    ).toBe("Ada Lovelace");
  });

  it("builds a JSContact card the vCard face can serialize", async () => {
    // done-when #5 is "see it in Contacts.app over CardDAV", which needs the
    // card to use the property shapes contacts-core reads. Assert the shape
    // rather than the app.
    const w = world();
    const r = await callTool(w, "contacts_create_card", {
      accountId: ACCOUNT,
      name: "Ada Lovelace",
      nickname: "Ada",
      organization: "Analytical Engines",
      jobTitle: "Programmer",
      emails: ["ada@example.com", "ada@work.example"],
      phones: ["+1-555-0100"],
      note: "met at the fair",
    });
    const card = JSON.parse(
      w.db.query<{ card_json: string }>(
        `SELECT card_json FROM contact_cards WHERE id = ?`,
        r.data.id,
      )[0]!.card_json,
    ) as Record<string, any>;

    expect(card["@type"]).toBe("Card");
    expect(card.name.full).toBe("Ada Lovelace");
    expect(Object.values(card.emails).map((e: any) => e.address)).toEqual([
      "ada@example.com",
      "ada@work.example",
    ]);
    expect(Object.values(card.phones).map((p: any) => p.number)).toEqual(["+1-555-0100"]);
    expect(Object.values(card.organizations).map((o: any) => o.name)).toEqual([
      "Analytical Engines",
    ]);
    expect(Object.values(card.titles).map((t: any) => t.name)).toEqual(["Programmer"]);
    expect(Object.values(card.nicknames).map((n: any) => n.name)).toEqual(["Ada"]);
    expect(Object.values(card.notes).map((n: any) => n.note)).toEqual(["met at the fair"]);
    expect(card.addressBookIds).toEqual({ [BOOK]: true });
  });

  it("refuses a card with nothing to list it under", async () => {
    const w = world();
    const r = await callTool(w, "contacts_create_card", { accountId: ACCOUNT, note: "who?" });
    expect(r.body.result!.isError).toBe(true);
    expect(r.text).toContain("at least one of name, organization or emails");
    expect(w.accountDo.commits).toEqual([]);
  });

  it("searches, updates and deletes a card end to end", async () => {
    const w = world();
    const created = await callTool(w, "contacts_create_card", {
      accountId: ACCOUNT,
      name: "Ada Lovelace",
      emails: ["ada@example.com"],
    });
    const id = created.data.id as string;

    const found = await callTool(w, "contacts_search", { accountId: ACCOUNT, text: "Lovelace" });
    expect((found.data.cards as Array<{ id: string }>).map((c) => c.id)).toEqual([id]);

    const mid = await w.accountDo.state(ACCOUNT);
    const updated = await callTool(w, "contacts_update_card", {
      accountId: ACCOUNT,
      cardId: id,
      organization: "Analytical Engines",
    });
    expect(updated.data).toMatchObject({ id, updated: true });
    expect((await changesSince(w, "ContactCard", mid)).updated).toEqual([id]);

    const afterUpdate = await w.accountDo.state(ACCOUNT);
    const gone = await callTool(w, "contacts_delete_card", { accountId: ACCOUNT, cardId: id });
    expect(gone.data).toMatchObject({ id, destroyed: true });
    expect((await changesSince(w, "ContactCard", afterUpdate)).destroyed).toEqual([id]);
    expect(w.db.query(`SELECT id FROM contact_cards WHERE account_id = ?`, ACCOUNT)).toEqual([]);
    // create + update + delete = three ctag bumps on top of the seeded 1.
    expect(ctag(w, "address_books", BOOK)).toBe(4);
  });

  it("lists address books", async () => {
    const w = world();
    const r = await callTool(w, "contacts_list_books", { accountId: ACCOUNT });
    expect((r.data.list as Array<{ id: string }>).map((b) => b.id)).toEqual([BOOK]);
  });
});

// ---- the gate --------------------------------------------------------------

describe("the per-tool scope gate", () => {
  it("refuses a create to a token holding only read, with -32004", async () => {
    // done-when #3. The write tools declare ("calendar","calendar"); `read`
    // does not satisfy it, and post-common/001 nothing but `calendar` does.
    const w = world({ scopes: ["read"] });
    const r = await callTool(w, "calendar_create_event", {
      accountId: ACCOUNT,
      title: "Dentist",
      start: "2026-09-14T09:00:00",
    });
    expect(r.status).toBe(403);
    expect(r.body.error!.code).toBe(-32004);
    expect(r.body.result).toBeUndefined();
    expect(w.db.query(`SELECT id FROM calendar_events WHERE account_id = ?`, ACCOUNT)).toEqual([]);
    expect(w.accountDo.commits).toEqual([]);
  });

  it("still lets that read-only token read", async () => {
    const w = world({ scopes: ["read"] });
    const r = await callTool(w, "calendar_list", { accountId: ACCOUNT });
    expect(r.status).toBe(200);
    expect(r.body.result!.isError).toBeUndefined();
  });

  it("refuses a contacts tool to a calendar-only token", async () => {
    // The behavioural cross-domain case mcpTools.test.ts said would "arrive
    // with sVOL 013". Calendar and contacts are independent realm scopes —
    // neither covers the other, and `mail` covers neither.
    const w = world({ scopes: ["calendar"] });
    const r = await callTool(w, "contacts_create_card", {
      accountId: ACCOUNT,
      name: "Ada Lovelace",
    });
    expect(r.status).toBe(403);
    expect(r.body.error!.code).toBe(-32004);
  });

  it("refuses a mail-scoped token a calendar write", async () => {
    const w = world({ scopes: ["mail"] });
    const r = await callTool(w, "calendar_create_event", {
      accountId: ACCOUNT,
      title: "Dentist",
      start: "2026-09-14T09:00:00",
    });
    expect(r.status).toBe(403);
    expect(r.body.error!.code).toBe(-32004);
  });

  it("cannot reach another principal's account", async () => {
    // done-when #4, first half: no token, however scoped, reaches an account
    // it neither owns nor holds a grant on.
    const w = world({ owns: ["a_allen"], others: [ACCOUNT] });
    const r = await callTool(w, "calendar_create_event", {
      accountId: ACCOUNT,
      title: "Dentist",
      start: "2026-09-14T09:00:00",
    });
    expect(r.status).toBe(403);
    expect(r.body.error!.code).toBe(-32004);
    expect(w.db.query(`SELECT id FROM calendar_events WHERE account_id = ?`, ACCOUNT)).toEqual([]);
  });

  it("allows and audits a grant-reached write", async () => {
    // done-when #4, second half.
    const w = world({
      principalId: "p_allen",
      loginEmail: "allen@bullmoose.cc",
      owns: ["a_allen"],
      others: [ACCOUNT],
      grants: [{ id: "g1", grantee: "a_allen", target: ACCOUNT, scopes: ["read", "calendar"] }],
    });
    const r = await callTool(w, "calendar_create_event", {
      accountId: ACCOUNT,
      calendarId: CAL,
      title: "Dentist",
      start: "2026-09-14T09:00:00",
    });
    expect(r.status).toBe(200);
    expect(r.body.result!.isError).toBeUndefined();

    const audit = w.db.query<{ grant_id: string; account_id: string; method: string }>(
      `SELECT grant_id, account_id, method FROM grant_audit`,
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((a) => a.grant_id === "g1" && a.account_id === ACCOUNT)).toBe(true);
    // The MCP gate records the surface it was reached through; the method
    // layer records the method. Both are true and neither is redundant.
    expect(audit.map((a) => a.method)).toContain("mcp:calendar_create_event");
    expect(audit.map((a) => a.method)).toContain("calendar:calendar");
  });

  it("writes no grant_audit row for an owned write", async () => {
    const w = world();
    await callTool(w, "calendar_create_event", {
      accountId: ACCOUNT,
      title: "Dentist",
      start: "2026-09-14T09:00:00",
    });
    expect(w.db.query(`SELECT grant_id FROM grant_audit`)).toEqual([]);
  });
});

// ---- what a raw-SQL shortcut would look like -------------------------------

describe("the assertions above actually bite", () => {
  it("a store-level write lands the row, reads back on /get, and is invisible", async () => {
    // Not a test of product code — a demonstration that "the row is there" and
    // "a /get returns it" are satisfied by exactly the shortcut this unit
    // exists to forbid, so those assertions prove nothing on their own. The
    // three assertions the calendar tests actually make (changes / ctag /
    // nothing-on-reject) are the ones that fail here.
    const w = world();
    const before = await w.accountDo.state(ACCOUNT);
    await w.env.DB.prepare(
      `INSERT INTO calendar_events
         (id, account_id, calendar_id, uid, event_json, title, start_at, end_at,
          is_recurring, dav_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 1, 1)`,
    )
      .bind(
        "ev_smuggled",
        ACCOUNT,
        CAL,
        "urn:uuid:smuggled",
        JSON.stringify({ "@type": "Event", uid: "urn:uuid:smuggled", title: "Smuggled" }),
        "Smuggled",
        1,
        2,
      )
      .run();

    // A direct read is perfectly happy.
    const got = await callJmap<{ list: Array<{ id: string }> }>(
      w.env,
      principalFor([ACCOUNT]),
      "CalendarEvent/get",
      { accountId: ACCOUNT, ids: ["ev_smuggled"] },
    );
    expect(got.list.map((e) => e.id)).toEqual(["ev_smuggled"]);

    // And every incremental consumer is blind to it.
    expect((await changesSince(w, "CalendarEvent", before)).created).toEqual([]);
    expect(ctag(w, "calendars", CAL)).toBe(1);
  });
});
