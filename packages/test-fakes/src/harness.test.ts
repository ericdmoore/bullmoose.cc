import { describe, expect, it } from "vitest";
import { Mailstore, type CalendarEventRow } from "@bullmoose/mailstore";
import { commitChanges } from "@bullmoose/account-do";
import { fakeD1, fakeEnv } from "./index";

// The harness's own regression net (sVOL 002).
//
// Every assertion here is one the five local fakes it replaces could not make.
// They routed queries to fixtures by SQL substring, so `run()` pushed to an
// array `all()` never read: a write followed by a read was not modelled at all,
// and `.batch()` — which nine Mailstore write methods go through — was either
// absent (TypeError) or a loop that returned fixtures and wrote nothing.
//
// If this file goes red, the fake is wrong. Do not loosen it.

const ACCOUNT = "a_eric";
const CAL = "cal_default";

const eventRow = (over: Partial<CalendarEventRow> = {}): CalendarEventRow => ({
  id: "ce_1",
  calendarId: CAL,
  uid: "urn:uuid:standup",
  event: { "@type": "Event", title: "Standup", uid: "urn:uuid:standup" },
  title: "Standup",
  startAt: 1768467600000,
  endAt: 1768471200000,
  isRecurring: false,
  davName: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const seedCalendar = (db: ReturnType<typeof fakeD1>) =>
  db.seed("calendars", [
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

describe("fakeD1 — the live schema, not a fixture table", () => {
  it("loads both plane schemas that wrangler applies", () => {
    const db = fakeD1();
    const tables = db.query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name);
    // Control plane AND data plane, in one database — which is what the jmap
    // worker's single DB binding looks like from the method layer.
    expect(tables).toContain("principals"); // control-plane.sql
    expect(tables).toContain("calendar_events"); // data-plane.sql
    expect(tables).toContain("emails_fts"); // the FTS5 virtual table
    db.close(); // safe with cached statements outstanding
  });

  it("refuses to bind undefined, exactly as D1 does", async () => {
    // The tempting coercion is undefined -> NULL. D1 throws D1_TYPE_ERROR, so
    // coercing would let a test write a clean row where production fails —
    // and undefined is the value most likely to arrive by accident, from a
    // fixture object missing an optional key. null must still pass.
    const db = fakeD1();
    db.seedAccount({ accountId: "a_x" });
    await expect(
      db
        .prepare(`INSERT INTO identities (id, account_id, email, name) VALUES (?, ?, ?, ?)`)
        .bind("i_1", "a_x", undefined, "x")
        .run(),
    ).rejects.toThrow(/cannot bind undefined/);

    await expect(
      db
        .prepare(`INSERT INTO calendars
                    (id, account_id, name, description, color, sort_order,
                     is_default, is_subscribed, ctag, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, 0, 0, 1, 0, 1, 1)`)
        .bind("cal_1", "a_x", "Cal", null, null)
        .run(),
    ).resolves.toBeTruthy();
  });

  it("does not claim a SELECT wrote a row", async () => {
    // node:sqlite's run() reports a STALE sqlite3_changes value for a read, so
    // a fake that always took the run() path would answer `changes: 1` for a
    // pure SELECT and drop its rows. D1's run() returns both rows and meta.
    const db = fakeD1();
    db.seedAccount({ accountId: "a_x" });

    const read = await db.prepare(`SELECT id FROM accounts WHERE id = ?`).bind("a_x").run();
    expect(read.meta.changes).toBe(0);
    expect(read.meta.changed_db).toBe(false);
    expect(read.results).toEqual([{ id: "a_x" }]);

    const write = await db
      .prepare(`INSERT INTO grant_audit (grant_id, principal, account_id, method, at)
                VALUES (?, ?, ?, ?, ?)`)
      .bind("g1", "e@x", "a_x", "mail:read", 1)
      .run();
    expect(write.meta.changes).toBe(1);
    expect(write.meta.changed_db).toBe(true);
  });

  it("refuses a query the real schema could not answer", async () => {
    // The old fakes answered an unmatched query from a catch-all fixture, so a
    // test could pass while the code under test read a table that never
    // existed. Here that is an error, which is the entire bargain.
    const db = fakeD1();
    await expect(db.prepare(`SELECT * FROM mailboxen`).all()).rejects.toThrow(/could not prepare/);
  });
});

describe("fakeD1 — .batch() round-trips (impossible with the fakes this replaces)", () => {
  it("writes through Mailstore.insertCalendarEvents and reads back through getCalendarEvents", async () => {
    const w = fakeEnv();
    seedCalendar(w.db);
    const store = new Mailstore(w.env.DB, w.env.BLOBS);

    await store.insertCalendarEvents(ACCOUNT, [
      eventRow(),
      eventRow({ id: "ce_2", uid: "urn:uuid:retro", title: "Retro", startAt: 1768554000000 }),
    ]);

    const read = await store.getCalendarEvents(ACCOUNT, ["ce_1", "ce_2"]);
    expect(read.map((e) => e.id).sort()).toEqual(["ce_1", "ce_2"]);
    const standup = read.find((e) => e.id === "ce_1")!;
    expect(standup.uid).toBe("urn:uuid:standup");
    expect(standup.title).toBe("Standup");
    expect(standup.startAt).toBe(1768467600000);
    expect(standup.isRecurring).toBe(false);
    // event_json survives the round trip losslessly, JSON and all.
    expect(standup.event).toEqual({ "@type": "Event", title: "Standup", uid: "urn:uuid:standup" });
  });

  it("scopes reads by account — a write to one account is invisible to another", async () => {
    // The substring routers could not tell two accounts apart: the fixture was
    // keyed on the SQL, not on the bound arguments.
    const w = fakeEnv();
    seedCalendar(w.db);
    const store = new Mailstore(w.env.DB, w.env.BLOBS);
    await store.insertCalendarEvents(ACCOUNT, [eventRow()]);

    expect(await store.getCalendarEvents("a_someone_else")).toEqual([]);
    expect(await store.getCalendarEvents(ACCOUNT)).toHaveLength(1);
  });

  it("is ATOMIC: a batch whose second statement violates a constraint leaves no rows", async () => {
    // D1's batch runs in an implicit transaction. A fake that executed
    // sequentially without one would let a test pass on code that leaves a
    // half-written row in production — the lie that matters most.
    const w = fakeEnv();
    seedCalendar(w.db);
    const store = new Mailstore(w.env.DB, w.env.BLOBS);
    await store.insertCalendarEvents(ACCOUNT, [eventRow({ id: "ce_existing", uid: "dup" })]);

    await expect(
      store.insertCalendarEvents(ACCOUNT, [
        eventRow({ id: "ce_first", uid: "urn:uuid:fine" }),
        // calendar_events has UNIQUE (account_id, uid) — this one cannot land.
        eventRow({ id: "ce_second", uid: "dup" }),
      ]),
    ).rejects.toThrow();

    expect(w.db.count("calendar_events", "id = ?", "ce_first")).toBe(0);
    expect(w.db.count("calendar_events", "id = ?", "ce_second")).toBe(0);
    expect(w.db.count("calendar_events")).toBe(1); // only the pre-existing row
  });

  it("surfaces the REAL error when SQLite already unwound the transaction", async () => {
    // ON CONFLICT ROLLBACK auto-unwinds, so the fake's own ROLLBACK then fails
    // with "no transaction is active". Letting that escape would replace the
    // constraint violation with a confusing one and send a reader hunting the
    // wrong bug.
    const db = fakeD1({ schema: [], setup: `CREATE TABLE t (a TEXT UNIQUE ON CONFLICT ROLLBACK)` });
    await expect(
      db.batch([
        db.prepare(`INSERT INTO t (a) VALUES (?)`).bind("x"),
        db.prepare(`INSERT INTO t (a) VALUES (?)`).bind("x"),
      ]),
    ).rejects.toThrow(/UNIQUE/i);
    expect(db.count("t")).toBe(0);
  });

  it("still records batch statements in `writes`, for SQL-text assertions", async () => {
    const w = fakeEnv();
    seedCalendar(w.db);
    await new Mailstore(w.env.DB, w.env.BLOBS).insertCalendarEvents(ACCOUNT, [eventRow()]);

    const inserts = w.db.writes.filter((x) => x.sql.includes("INSERT INTO calendar_events"));
    expect(inserts).toHaveLength(1);
    // Positional bind args stay assertable — calendars.test.ts reads
    // start_at / end_at straight out of this.
    expect(inserts[0]!.args[0]).toBe("ce_1");
    expect(inserts[0]!.args[1]).toBe(ACCOUNT);
  });
});

describe("fakeAccountDo — the real AccountDO, so /changes is real", () => {
  it("reports a commit through the collection's changelog", async () => {
    const w = fakeEnv();
    const before = await w.accountDo.state(ACCOUNT);

    await commitChanges(w.env.ACCOUNT_DO, ACCOUNT, [{ collection: "CalendarEvent", created: ["ce_1"] }]);

    const delta = await w.accountDo.changes(ACCOUNT, "CalendarEvent", before);
    expect(delta.created).toEqual(["ce_1"]);
    expect(delta.updated).toEqual([]);
    expect(delta.newState).not.toBe(before);
  });

  it("filters by collection — a Calendar commit is not a CalendarEvent change", async () => {
    const w = fakeEnv();
    await commitChanges(w.env.ACCOUNT_DO, ACCOUNT, [{ collection: "Calendar", updated: ["cal_1"] }]);

    expect((await w.accountDo.changes(ACCOUNT, "CalendarEvent")).updated).toEqual([]);
    expect((await w.accountDo.changes(ACCOUNT, "Calendar")).updated).toEqual(["cal_1"]);
  });

  it("collapses created→destroyed within the window, like the deployed DO", async () => {
    // Nothing here re-implements the changelog: this is the shipped class over
    // in-memory storage, so a canned {newState:"s2"} stub cannot substitute.
    const w = fakeEnv();
    await commitChanges(w.env.ACCOUNT_DO, ACCOUNT, [{ collection: "ContactCard", created: ["cc_1"] }]);
    await commitChanges(w.env.ACCOUNT_DO, ACCOUNT, [{ collection: "ContactCard", destroyed: ["cc_1"] }]);

    const delta = await w.accountDo.changes(ACCOUNT, "ContactCard");
    expect(delta.created).toEqual([]);
    expect(delta.destroyed).toEqual([]);
  });

  it("keeps state per account", async () => {
    const w = fakeEnv();
    await commitChanges(w.env.ACCOUNT_DO, ACCOUNT, [{ collection: "Email", created: ["e_1"] }]);

    expect((await w.accountDo.changes(ACCOUNT, "Email")).created).toEqual(["e_1"]);
    expect((await w.accountDo.changes("a_other", "Email")).created).toEqual([]);
    expect(w.accountDo.commits).toHaveLength(1);
  });
});

describe("fakeR2 — BLOBS is a real bucket now, not `{}`", () => {
  it("round-trips a message blob through Mailstore.putBlob / getBlob", async () => {
    const w = fakeEnv();
    const store = new Mailstore(w.env.DB, w.env.BLOBS);
    const raw = new TextEncoder().encode("Subject: hi\r\n\r\nbody\r\n");

    const blobId = await store.putBlob("t_bm", ACCOUNT, raw.buffer as ArrayBuffer);
    expect(blobId).toMatch(/^b_[0-9a-f]{64}$/); // content-addressed, real SHA-256

    const got = await store.getBlob("t_bm", ACCOUNT, blobId);
    expect(await got!.text()).toBe("Subject: hi\r\n\r\nbody\r\n");
    expect(await store.getBlob("t_bm", ACCOUNT, "b_missing")).toBeNull();
  });
});

describe("fakeKV — one expiry model, not two", () => {
  it("honours absolute expiration and relative ttl at read time", async () => {
    const w = fakeEnv();
    const now = Math.floor(Date.now() / 1000);
    await w.env.ROUTES.put("a", "1", { expiration: now - 1 });
    await w.env.ROUTES.put("b", "2", { expirationTtl: 300 });
    await w.env.ROUTES.put("c", "3");

    expect(await w.env.ROUTES.get("a")).toBeNull();
    expect(await w.env.ROUTES.get("b")).toBe("2");
    expect(await w.env.ROUTES.get("c")).toBe("3");
  });
});
