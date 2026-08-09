import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import {
  Mailstore,
  type WriteProvenance,
  type AddressBookRow,
  type CalendarRow,
  type CalendarEventRow,
  type ContactCardRow,
  type FileNodeRow,
  type MailboxRow,
  type NewEmail,
} from "./index";

/**
 * Cross-realm provenance (s03.A T1).
 *
 * The whole slice exists to close ONE gap: `grant_audit` only fires on delegated
 * (grant-reached) access, so an agent — or a human — writing their OWN account
 * leaves no trace of who did it. These tests assert the shared Mailstore write
 * path stamps the `last_writer_*` trio onto every mutable data-plane record, for
 * an owner write (principal only) AND an agent write (principal + binding +
 * invocation), across all seven realms.
 *
 * Real `node:sqlite` on the live schema (`@bullmoose/test-fakes`) — the columns
 * under test are the columns wrangler applies, so a drift between this and the
 * deployed shard cannot hide here.
 */

const ACCOUNT = "t_bm__a_prov";

/** A store bound to one writer, over a fresh live-schema DB. */
function storeWith(writer: WriteProvenance | null) {
  const { db, env } = fakeEnv();
  return { db, store: new Mailstore(db, env.BLOBS, writer) };
}

/** The provenance trio a row carries, read straight out of SQLite. */
function provenanceOf(
  db: ReturnType<typeof fakeEnv>["db"],
  table: string,
  id: string,
): { principal: string | null; binding: string | null; invocation: string | null } {
  const row = db.query<{
    last_writer_principal: string | null;
    last_writer_binding: string | null;
    last_writer_invocation: string | null;
  }>(
    `SELECT last_writer_principal, last_writer_binding, last_writer_invocation
     FROM ${table} WHERE account_id = ? AND id = ?`,
    ACCOUNT,
    id,
  )[0]!;
  return {
    principal: row.last_writer_principal,
    binding: row.last_writer_binding,
    invocation: row.last_writer_invocation,
  };
}

// ---- fixtures, one per realm --------------------------------------------

const mailbox = (id: string): MailboxRow => ({
  id,
  parentId: null,
  name: "Folder",
  role: null,
  sortOrder: 0,
});

const email = (id: string): NewEmail => ({
  id,
  blobId: "b_1",
  threadId: "th_1",
  messageId: null,
  inReplyTo: null,
  subject: "hi",
  from: [],
  to: [],
  cc: [],
  bcc: [],
  preview: "",
  size: 1,
  receivedAt: 1,
  hasAttachment: false,
  attachments: [],
  mailboxIds: [],
  keywords: [],
});

const addressBook = (id: string): AddressBookRow => ({
  id,
  name: "Contacts",
  description: null,
  sortOrder: 0,
  isDefault: false,
  isSubscribed: true,
  ctag: 0,
  createdAt: 1,
  updatedAt: 1,
});

const card = (id: string, uid = `u_${id}`): ContactCardRow => ({
  id,
  addressBookId: "ab_1",
  uid,
  card: { uid },
  nameFull: "Ada",
  davName: null,
  createdAt: 1,
  updatedAt: 1,
});

const calendar = (id: string): CalendarRow => ({
  id,
  name: "Calendar",
  description: null,
  color: null,
  sortOrder: 0,
  isDefault: false,
  isSubscribed: true,
  ctag: 0,
  createdAt: 1,
  updatedAt: 1,
});

const event = (id: string, uid = `ev_${id}`): CalendarEventRow => ({
  id,
  calendarId: "cal_1",
  uid,
  event: { uid },
  title: "Meet",
  startAt: 1,
  endAt: 2,
  isRecurring: false,
  davName: null,
  createdAt: 1,
  updatedAt: 1,
});

const fileNode = (id: string, name = `f_${id}`): FileNodeRow => ({
  id,
  parentId: null,
  name,
  nodeType: "directory",
  blobId: null,
  size: null,
  type: null,
  created: 1,
  modified: 1,
  accessed: 1,
  changed: 1,
  executable: false,
  isSubscribed: true,
  role: null,
});

/** The seven tables, keyed to the insert that creates each one's record. */
const INSERTS: Array<{
  table: string;
  insert: (s: Mailstore, id: string) => Promise<unknown>;
}> = [
  { table: "mailboxes", insert: (s, id) => s.insertMailbox(ACCOUNT, mailbox(id)) },
  { table: "emails", insert: (s, id) => s.insertEmail(ACCOUNT, email(id)) },
  { table: "address_books", insert: (s, id) => s.insertAddressBook(ACCOUNT, addressBook(id)) },
  { table: "contact_cards", insert: (s, id) => s.insertContactCard(ACCOUNT, card(id)) },
  { table: "calendars", insert: (s, id) => s.insertCalendar(ACCOUNT, calendar(id)) },
  { table: "calendar_events", insert: (s, id) => s.insertCalendarEvents(ACCOUNT, [event(id)]) },
  { table: "file_nodes", insert: (s, id) => s.insertFileNode(ACCOUNT, fileNode(id)) },
];

describe("provenance — every realm's insert stamps the writer", () => {
  it.each(INSERTS)(
    "an OWNER write to $table records the principal (the grant_audit gap)",
    async ({ table, insert }) => {
      // An owner acts under no grant, so grant_audit stays empty — this column
      // is the ONLY record of who wrote it. binding/invocation are null: no agent.
      const { db, store } = storeWith({ principal: "emily@bullmoose.cc" });
      await insert(store, "x1");
      expect(provenanceOf(db, table, "x1")).toEqual({
        principal: "emily@bullmoose.cc",
        binding: null,
        invocation: null,
      });
    },
  );

  it.each(INSERTS)(
    "an AGENT write to $table records binding AND invocation",
    async ({ table, insert }) => {
      const { db, store } = storeWith({
        principal: "emily@bullmoose.cc",
        binding: "editor",
        invocation: "inv_42",
      });
      await insert(store, "x2");
      expect(provenanceOf(db, table, "x2")).toEqual({
        principal: "emily@bullmoose.cc",
        binding: "editor",
        invocation: "inv_42",
      });
    },
  );

  it.each(INSERTS)(
    "a writerless store (system path) writes NULL provenance to $table, a valid row",
    async ({ table, insert }) => {
      const { db, store } = storeWith(null);
      await insert(store, "x3");
      expect(provenanceOf(db, table, "x3")).toEqual({
        principal: null,
        binding: null,
        invocation: null,
      });
    },
  );
});

describe("provenance — updates re-stamp the writer", () => {
  it("updateMailbox stamps the new writer", async () => {
    const { db, store } = storeWith({ principal: "emily@bullmoose.cc" });
    await store.insertMailbox(ACCOUNT, mailbox("mb_u"));
    const store2 = new Mailstore(db, fakeEnv().env.BLOBS, {
      principal: "allen@bullmoose.cc",
      binding: "mover",
      invocation: "inv_9",
    });
    await store2.updateMailbox(ACCOUNT, "mb_u", { name: "Renamed" });
    expect(provenanceOf(db, "mailboxes", "mb_u")).toEqual({
      principal: "allen@bullmoose.cc",
      binding: "mover",
      invocation: "inv_9",
    });
  });

  it("updateContactCard stamps the new writer", async () => {
    const { db, store } = storeWith({ principal: "emily@bullmoose.cc" });
    await store.insertContactCard(ACCOUNT, card("cc_u"));
    const agent = new Mailstore(db, fakeEnv().env.BLOBS, {
      principal: "emily@bullmoose.cc",
      binding: "scrubber",
      invocation: "inv_7",
    });
    await agent.updateContactCard(ACCOUNT, { ...card("cc_u"), nameFull: "Grace" });
    expect(provenanceOf(db, "contact_cards", "cc_u")).toEqual({
      principal: "emily@bullmoose.cc",
      binding: "scrubber",
      invocation: "inv_7",
    });
  });

  it("updateCalendarEvent stamps the new writer", async () => {
    const { db, store } = storeWith({ principal: "emily@bullmoose.cc" });
    await store.insertCalendarEvents(ACCOUNT, [event("ce_u")]);
    const agent = new Mailstore(db, fakeEnv().env.BLOBS, {
      principal: "emily@bullmoose.cc",
      binding: "planner",
      invocation: "inv_3",
    });
    await agent.updateCalendarEvent(ACCOUNT, { ...event("ce_u"), title: "Moved" });
    expect(provenanceOf(db, "calendar_events", "ce_u")).toEqual({
      principal: "emily@bullmoose.cc",
      binding: "planner",
      invocation: "inv_3",
    });
  });

  it("a flag/move (replaceEmailSets) stamps the email itself — triage is attributable", async () => {
    const { db, store } = storeWith({ principal: "emily@bullmoose.cc" });
    await store.insertEmail(ACCOUNT, email("em_u"));
    const agent = new Mailstore(db, fakeEnv().env.BLOBS, {
      principal: "emily@bullmoose.cc",
      binding: "triager",
      invocation: "inv_11",
    });
    await agent.replaceEmailSets(ACCOUNT, "em_u", { keywords: ["$seen"] });
    // The keyword landed AND the email row carries who did it — the point: a
    // move/flag mutates child tables, so without this the email would forget.
    expect(db.count("email_keywords", "account_id = ? AND email_id = ?", ACCOUNT, "em_u")).toBe(1);
    expect(provenanceOf(db, "emails", "em_u")).toEqual({
      principal: "emily@bullmoose.cc",
      binding: "triager",
      invocation: "inv_11",
    });
  });
});

describe("provenance — no write path bypasses the stamp", () => {
  it("every INSERT into a provenance table names last_writer_principal", () => {
    // Guards against a future insert method landing a row with no writer.
    // Behavioural tests above prove the CURRENT methods stamp; this proves the
    // source itself cannot grow an unattributed create without turning red.
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const tables = [
      "emails",
      "mailboxes",
      "address_books",
      "contact_cards",
      "calendars",
      "calendar_events",
      "file_nodes",
    ];
    for (const table of tables) {
      // Match the INSERT statement head through to its closing paren of columns.
      // `\s*` because the SQL wraps the column list onto its own line.
      const re = new RegExp(`INSERT INTO ${table}\\s*\\(([\\s\\S]*?)\\)`, "g");
      const matches = [...src.matchAll(re)];
      expect(matches.length, `no INSERT INTO ${table} found`).toBeGreaterThan(0);
      for (const m of matches) {
        expect(
          m[1]!.includes("PROVENANCE_COLUMNS") || m[1]!.includes("last_writer_principal"),
          `INSERT INTO ${table} omits provenance`,
        ).toBe(true);
      }
    }
  });
});
