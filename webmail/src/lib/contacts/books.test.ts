import { describe, expect, it } from "vitest";
import { FakeJmapClient, defaultSession } from "../jmap/FakeJmapClient";
import type { Session } from "../jmap/types";
import {
  bookIdOf,
  bookName,
  bookScopeNote,
  compareBooks,
  contactsAccounts,
  defaultContactsAccount,
  defaultTargetBook,
  loadAddressBooks,
  mayWriteCard,
  writableBooks,
} from "./books";
import { demoAddressBooks, installContactsDemo, sharedAccountSession } from "./demo";
import type { AddressBook } from "./types";

const book = (over: Partial<AddressBook>): AddressBook => ({
  id: "ab-x",
  name: "X",
  description: null,
  sortOrder: 0,
  isDefault: false,
  isSubscribed: true,
  shareWith: null,
  myRights: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true },
  ...over,
});

describe("which account's contacts", () => {
  it("finds every account that advertises the contacts capability", () => {
    const accounts = contactsAccounts(defaultSession());
    expect(accounts.map((a) => a.id)).toEqual(["acct-fake"]);
    expect(accounts[0]).toMatchObject({ isPersonal: true, isPrimary: true });
  });

  it("still finds a grant-reached account whose primaryAccounts entry is empty", () => {
    // The failure this guards: `session.ts:61` sets the contacts primary to
    // the OWNER's account, which is "" for a principal that owns none — so
    // `primaryAccountId()` throws and a contacts-only grantee would see an
    // exception instead of their shared books (JmapClient.ts:176-181).
    const session = sharedAccountSession();
    const accounts = contactsAccounts(session);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: "acct-fake", isPersonal: false, isPrimary: false });
    expect(defaultContactsAccount(session)?.id).toBe("acct-fake");
  });

  it("skips accounts with no contacts capability", () => {
    const base = defaultSession();
    const session: Session = {
      ...base,
      accounts: {
        "acct-mail-only": {
          name: "mail@bullmoose.test",
          isPersonal: true,
          isReadOnly: false,
          accountCapabilities: { "urn:ietf:params:jmap:mail": {} },
        },
      },
    };
    expect(contactsAccounts(session)).toEqual([]);
    expect(defaultContactsAccount(session)).toBeUndefined();
  });

  it("puts your own account before anyone else's", () => {
    const base = defaultSession();
    const contacts = { "urn:ietf:params:jmap:contacts": {} };
    const session: Session = {
      ...base,
      accounts: {
        "acct-shared": {
          name: "aaa@shared.test",
          isPersonal: false,
          isReadOnly: true,
          accountCapabilities: contacts,
        },
        "acct-mine": {
          name: "zzz@mine.test",
          isPersonal: true,
          isReadOnly: false,
          accountCapabilities: contacts,
        },
      },
      primaryAccounts: { ...base.primaryAccounts, "urn:ietf:params:jmap:contacts": "acct-mine" },
    };
    expect(contactsAccounts(session).map((a) => a.id)).toEqual(["acct-mine", "acct-shared"]);
  });
});

describe("loading address books", () => {
  it("asks for all of them in one call", async () => {
    const client = new FakeJmapClient();
    installContactsDemo(client);
    const books = await loadAddressBooks(client, "acct-fake");
    expect(books.map((b) => b.name)).toEqual(["Personal", "Work"]);
    expect(client.sentBatches).toHaveLength(1);
    expect(client.sentBatches[0]?.[0]?.[1]).toMatchObject({ ids: null });
  });

  it("returns only the books a restricted grant names", async () => {
    // `allowedBookIds` filters the list server-side (contacts.ts:76-77) —
    // there is no "and N more" for the client to discover.
    const client = new FakeJmapClient();
    installContactsDemo(client, { allowedBookIds: ["ab-work"], mayManageBooks: false });
    const books = await loadAddressBooks(client, "acct-fake");
    expect(books.map((b) => b.id)).toEqual(["ab-work"]);
    expect(books[0]?.myRights).toMatchObject({ mayWrite: true, mayShare: false, mayDelete: false });
  });

  it("reads a missing myRights as 'may do nothing', never as 'may do everything'", async () => {
    const client = new FakeJmapClient().setHandler("AddressBook/get", () => ({
      accountId: "acct-fake",
      state: "0",
      list: [{ id: "ab-odd", name: "Odd" }],
      notFound: [],
    }));
    const [odd] = await loadAddressBooks(client, "acct-fake");
    expect(odd?.myRights).toEqual({
      mayRead: true,
      mayWrite: false,
      mayShare: false,
      mayDelete: false,
    });
  });
});

describe("ordering and targets", () => {
  it("puts the default book first, then sortOrder, then name", () => {
    const books = [
      book({ id: "b", name: "Beta", sortOrder: 2 }),
      book({ id: "a", name: "Alpha", sortOrder: 2 }),
      book({ id: "d", name: "Zeta", isDefault: true, sortOrder: 9 }),
    ].sort(compareBooks);
    expect(books.map((b) => b.id)).toEqual(["d", "a", "b"]);
  });

  it("only offers writable books as a target", () => {
    const books = [
      book({
        id: "ro",
        myRights: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false },
      }),
      book({ id: "rw", isDefault: true }),
    ];
    expect(writableBooks(books).map((b) => b.id)).toEqual(["rw"]);
    expect(defaultTargetBook(books)?.id).toBe("rw");
    expect(defaultTargetBook([books[0]!])).toBeUndefined();
  });

  it("answers 'may I write this card' from the CARD's book, not the current one", () => {
    // The case this exists for: adding someone to a group writes the group's
    // card, which can sit in a book with different rights.
    const readOnly = book({
      id: "ab-ro",
      myRights: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false },
    });
    const books = [book({ id: "ab-rw" }), readOnly];
    expect(mayWriteCard(books, { addressBookIds: { "ab-rw": true } })).toBe(true);
    expect(mayWriteCard(books, { addressBookIds: { "ab-ro": true } })).toBe(false);
    // Outside the grant, or a stale list: either way, do not offer the write.
    expect(mayWriteCard(books, { addressBookIds: { "ab-elsewhere": true } })).toBe(false);
    expect(mayWriteCard(books, {})).toBe(false);
  });

  it("reads the single book a card belongs to", () => {
    expect(bookIdOf({ "ab-work": true })).toBe("ab-work");
    expect(bookIdOf({ "ab-work": false })).toBeUndefined();
    expect(bookIdOf(undefined)).toBeUndefined();
    expect(bookName(demoAddressBooks(), "ab-work")).toBe("Work");
  });
});

describe("the note a restricted view has to carry", () => {
  it("says nothing to an owner, because the list really is the account", () => {
    const account = { id: "a", name: "me", isPersonal: true, isReadOnly: false, isPrimary: true };
    expect(bookScopeNote(account, demoAddressBooks())).toBeUndefined();
  });

  it("refuses to claim completeness on a shared account", () => {
    const account = {
      id: "a",
      name: "shared@bullmoose.test",
      isPersonal: false,
      isReadOnly: false,
      isPrimary: false,
    };
    const note = bookScopeNote(account, [demoAddressBooks()[1]!]);
    expect(note).toContain("may not be all of them");
    expect(note).toContain("owner");
  });
});
