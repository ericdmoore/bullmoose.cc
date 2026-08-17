import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import {
  BookWriteRefused,
  Mailstore,
  reconcileBookMembership,
  type AddressBookRow,
  type BookWritePolicy,
  type ContactCardRow,
  type ContactWriter,
  type JSContactCard,
} from "./index";

/**
 * s10 T1/T2 — the contact-write chokepoint and its membership chain.
 *
 * A governed address book IS an agent's outbound send authority, so the
 * assertions that matter are refusals: an agent writing a propose/governed
 * book must be stopped IN THE STORE (never per-protocol), and every write
 * that changes a non-open book's effective membership must land a chain row
 * in the SAME batch as the card. The fold-reconciliation invariant closes the
 * loop: replaying the chain reproduces the book, and a write that bypassed
 * the chokepoint (direct SQL below) is exactly what trips it.
 */

const ACCOUNT = "t_bm__a_gov";

const HUMAN: ContactWriter = { principal: "eric@bullmoose.cc", kind: "human" };
const AGENT: ContactWriter = {
  principal: "photos@bullmoose.cc",
  kind: "agent",
  binding: "photos",
  invocation: "inv_1",
};
const AUTHORIZED: ContactWriter = { ...AGENT, authorization: { proposalId: "prop_7" } };

const book = (id: string, writePolicy: BookWritePolicy): AddressBookRow => ({
  id,
  name: id,
  description: null,
  sortOrder: 0,
  isDefault: false,
  isSubscribed: true,
  ctag: 0,
  createdAt: 1,
  updatedAt: 1,
  writePolicy,
});

const card = (id: string, bookId: string, emails: string[], extra: Partial<JSContactCard> = {}): ContactCardRow => ({
  id,
  addressBookId: bookId,
  uid: `u_${id}`,
  card: {
    uid: `u_${id}`,
    emails: Object.fromEntries(emails.map((address, i) => [`e${i}`, { address }])),
    ...extra,
  },
  nameFull: id,
  davName: null,
  createdAt: 1,
  updatedAt: 1,
});

const group = (id: string, bookId: string, memberUids: string[]): ContactCardRow =>
  card(id, bookId, [], {
    kind: "group",
    members: Object.fromEntries(memberUids.map((u) => [u, true])),
  });

async function world() {
  const w = fakeEnv();
  const store = new Mailstore(w.db, w.env.BLOBS);
  await store.insertAddressBook(ACCOUNT, book("ab_open", "open"));
  await store.insertAddressBook(ACCOUNT, book("ab_propose", "propose"));
  await store.insertAddressBook(ACCOUNT, book("ab_gov", "governed"));
  return { w, store };
}

const logOf = (w: ReturnType<typeof fakeEnv>, bookId: string) =>
  w.db.query<{ event: string; address: string; actor: string; via_proposal_id: string | null }>(
    `SELECT event, address, actor, via_proposal_id FROM book_membership_log
     WHERE account_id = ? AND book_id = ? ORDER BY id`,
    ACCOUNT,
    bookId,
  );

describe("the chokepoint — one policy gate for every write path", () => {
  it("an open book takes agent writes with no ceremony (today's behavior)", async () => {
    const { w, store } = await world();
    await store.insertContactCard(ACCOUNT, card("c1", "ab_open", ["bob@good.com"]), AGENT);
    expect(w.db.count("contact_cards", "id = 'c1'")).toBe(1);
    // No chain either: 'open' books are working books, not control surfaces.
    expect(logOf(w, "ab_open")).toEqual([]);
  });

  it("a 'propose' book refuses an agent with a typed error naming the proposal path", async () => {
    const { w, store } = await world();
    const err = await store
      .insertContactCard(ACCOUNT, card("c1", "ab_propose", ["bob@good.com"]), AGENT)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BookWriteRefused);
    expect((err as BookWriteRefused).policy).toBe("propose");
    expect((err as BookWriteRefused).message).toMatch(/proposal/i);
    expect(w.db.count("contact_cards")).toBe(0);
  });

  it("a 'propose' book takes a human write directly (devPlan decision 4)", async () => {
    const { w, store } = await world();
    await store.insertContactCard(ACCOUNT, card("c1", "ab_propose", ["bob@good.com"]), HUMAN);
    expect(w.db.count("contact_cards", "id = 'c1'")).toBe(1);
  });

  it("a governed book refuses agent create, update AND destroy without authorization", async () => {
    const { store } = await world();
    await store.insertContactCard(ACCOUNT, card("c1", "ab_gov", ["bob@good.com"]), HUMAN);

    await expect(
      store.insertContactCard(ACCOUNT, card("c2", "ab_gov", ["eve@evil.com"]), AGENT),
    ).rejects.toBeInstanceOf(BookWriteRefused);
    await expect(
      store.updateContactCard(ACCOUNT, card("c1", "ab_gov", ["eve@evil.com"]), AGENT),
    ).rejects.toBeInstanceOf(BookWriteRefused);
    await expect(store.destroyContactCard(ACCOUNT, "c1", AGENT)).rejects.toBeInstanceOf(BookWriteRefused);
    // Moving a card OUT of the governed book is a write to it too (narrowing).
    await expect(
      store.updateContactCard(ACCOUNT, card("c1", "ab_open", ["bob@good.com"]), AGENT),
    ).rejects.toBeInstanceOf(BookWriteRefused);
  });

  it("a governed book accepts an agent write carrying a proposal id, and records it", async () => {
    const { w, store } = await world();
    await store.insertContactCard(ACCOUNT, card("c1", "ab_gov", ["bob@good.com"]), AUTHORIZED);
    expect(w.db.count("contact_cards", "id = 'c1'")).toBe(1);
    expect(logOf(w, "ab_gov")).toEqual([
      {
        event: "added",
        address: "bob@good.com",
        actor: "photos@bullmoose.cc",
        via_proposal_id: "prop_7",
      },
    ]);
  });

  it("an empty proposal id is NOT authorization", async () => {
    const { store } = await world();
    await expect(
      store.insertContactCard(ACCOUNT, card("c1", "ab_gov", ["x@y.com"]), {
        ...AGENT,
        authorization: { proposalId: "" },
      }),
    ).rejects.toBeInstanceOf(BookWriteRefused);
  });

  it("the viral-reference rule: a member card in an OPEN book, referenced by a governed group, is governed", async () => {
    const { store } = await world();
    await store.insertContactCard(ACCOUNT, card("m1", "ab_open", ["bob@good.com"]), HUMAN);
    await store.insertContactCard(ACCOUNT, group("g1", "ab_gov", ["u_m1"]), HUMAN);
    // Editing m1 would widen ab_gov without touching it — refused for agents.
    await expect(
      store.updateContactCard(ACCOUNT, card("m1", "ab_open", ["eve@evil.com"]), AGENT),
    ).rejects.toBeInstanceOf(BookWriteRefused);
    // The same edit by a human writes through.
    await store.updateContactCard(ACCOUNT, card("m1", "ab_open", ["eve@evil.com"]), HUMAN);
  });

  it("nested groups are refused into a governed book, and allowed in an open one", async () => {
    const { store } = await world();
    await store.insertContactCard(ACCOUNT, group("inner", "ab_open", []), HUMAN);
    await expect(store.insertContactCard(ACCOUNT, group("outer", "ab_gov", ["u_inner"]), HUMAN)).rejects.toMatchObject({
      reason: "nested-group",
    });
    await store.insertContactCard(ACCOUNT, group("outer", "ab_open", ["u_inner"]), HUMAN);
  });
});

describe("the membership chain — card + chain commit together or neither", () => {
  it("insert, delta update, book move and destroy each append the right rows", async () => {
    const { w, store } = await world();
    await store.insertContactCard(ACCOUNT, card("c1", "ab_gov", ["ann@x.com", "bob@x.com"]), HUMAN);
    // Delta update: bob leaves, cat arrives; ann is untouched (no row).
    await store.updateContactCard(ACCOUNT, card("c1", "ab_gov", ["ann@x.com", "cat@x.com"]), HUMAN);
    expect(logOf(w, "ab_gov")).toEqual([
      { event: "added", address: "ann@x.com", actor: "eric@bullmoose.cc", via_proposal_id: null },
      { event: "added", address: "bob@x.com", actor: "eric@bullmoose.cc", via_proposal_id: null },
      { event: "added", address: "cat@x.com", actor: "eric@bullmoose.cc", via_proposal_id: null },
      { event: "removed", address: "bob@x.com", actor: "eric@bullmoose.cc", via_proposal_id: null },
    ]);

    // Move out of the governed book: removed rows for its whole contribution.
    await store.updateContactCard(ACCOUNT, card("c1", "ab_open", ["ann@x.com", "cat@x.com"]), HUMAN);
    const afterMove = logOf(w, "ab_gov").slice(4);
    expect(afterMove).toEqual([
      { event: "removed", address: "ann@x.com", actor: "eric@bullmoose.cc", via_proposal_id: null },
      { event: "removed", address: "cat@x.com", actor: "eric@bullmoose.cc", via_proposal_id: null },
    ]);

    // Move back in, then destroy: deletion is an event, not a hole.
    await store.updateContactCard(ACCOUNT, card("c1", "ab_gov", ["ann@x.com"]), HUMAN);
    await store.destroyContactCard(ACCOUNT, "c1", HUMAN);
    const tail = logOf(w, "ab_gov").slice(6);
    expect(tail).toEqual([
      { event: "added", address: "ann@x.com", actor: "eric@bullmoose.cc", via_proposal_id: null },
      { event: "removed", address: "ann@x.com", actor: "eric@bullmoose.cc", via_proposal_id: null },
    ]);
  });

  it("addresses are logged normalized (case-folded), never raw", async () => {
    const { w, store } = await world();
    await store.insertContactCard(ACCOUNT, card("c1", "ab_gov", ["Bob@GOOD.com"]), HUMAN);
    expect(logOf(w, "ab_gov").map((r) => r.address)).toEqual(["bob@good.com"]);
  });

  it("group writes log their one-level expansion; member edits log against the referencing book", async () => {
    const { w, store } = await world();
    await store.insertContactCard(ACCOUNT, card("m1", "ab_open", ["bob@x.com"]), HUMAN);
    await store.insertContactCard(ACCOUNT, group("g1", "ab_gov", ["u_m1"]), HUMAN);
    expect(logOf(w, "ab_gov")).toEqual([
      { event: "added", address: "bob@x.com", actor: "eric@bullmoose.cc", via_proposal_id: null },
    ]);
    // The member's address change shifts the governed book's membership.
    await store.updateContactCard(ACCOUNT, card("m1", "ab_open", ["new@x.com"]), HUMAN);
    expect(logOf(w, "ab_gov").slice(1)).toEqual([
      { event: "added", address: "new@x.com", actor: "eric@bullmoose.cc", via_proposal_id: null },
      { event: "removed", address: "bob@x.com", actor: "eric@bullmoose.cc", via_proposal_id: null },
    ]);
  });

  it("ATOMICITY: a failing card write takes its chain rows down with it", async () => {
    const { w, store } = await world();
    await store.insertContactCard(ACCOUNT, card("c1", "ab_gov", ["ann@x.com"]), HUMAN);
    // Same PRIMARY KEY → the batch throws; the chain row prepared alongside
    // the card INSERT must roll back with it, or the chain lies.
    await expect(
      store.insertContactCard(ACCOUNT, { ...card("c1", "ab_gov", ["eve@evil.com"]), uid: "u_other" }, HUMAN),
    ).rejects.toThrow();
    expect(logOf(w, "ab_gov")).toHaveLength(1);
    expect(w.db.count("book_membership_log", "address = 'eve@evil.com'")).toBe(0);
  });
});

describe("the fold-reconciliation invariant", () => {
  it("add / remove / add-back folds back to the book exactly", async () => {
    const { store } = await world();
    await store.insertContactCard(ACCOUNT, card("c1", "ab_gov", ["bob@x.com"]), HUMAN);
    await store.destroyContactCard(ACCOUNT, "c1", HUMAN);
    await store.insertContactCard(ACCOUNT, card("c2", "ab_gov", ["bob@x.com"]), HUMAN);

    const log = await store.bookMembershipLog(ACCOUNT, "ab_gov");
    expect(log.map((r) => r.event)).toEqual(["added", "removed", "added"]);
    const members = await store.bookMembership(ACCOUNT, "ab_gov");
    const rec = reconcileBookMembership(log, members);
    expect(rec).toEqual({ consistent: true, missing: [], extra: [] });
  });

  it("groups fold too: expansion rows balance against the live expansion", async () => {
    const { store } = await world();
    await store.insertContactCard(ACCOUNT, card("m1", "ab_gov", ["bob@x.com"]), HUMAN);
    await store.insertContactCard(ACCOUNT, group("g1", "ab_gov", ["u_m1"]), HUMAN);
    await store.updateContactCard(ACCOUNT, card("m1", "ab_gov", ["new@x.com"]), HUMAN);

    const rec = reconcileBookMembership(
      await store.bookMembershipLog(ACCOUNT, "ab_gov"),
      await store.bookMembership(ACCOUNT, "ab_gov"),
    );
    expect(rec.consistent).toBe(true);
  });

  it("TAMPER: a card written past the chokepoint (raw SQL) trips the reconcile", async () => {
    const { w, store } = await world();
    await store.insertContactCard(ACCOUNT, card("c1", "ab_gov", ["bob@x.com"]), HUMAN);

    // The bypass: a row landed straight in D1 — no chokepoint, no chain.
    w.db.seed("contact_cards", [
      {
        id: "cc_smuggled",
        account_id: ACCOUNT,
        address_book_id: "ab_gov",
        uid: "u_smuggled",
        card_json: JSON.stringify({
          uid: "u_smuggled",
          emails: { e: { address: "eve@evil.com" } },
        }),
        created_at: 1,
        updated_at: 1,
      },
    ]);

    const rec = reconcileBookMembership(
      await store.bookMembershipLog(ACCOUNT, "ab_gov"),
      await store.bookMembership(ACCOUNT, "ab_gov"),
    );
    expect(rec.consistent).toBe(false);
    expect(rec.extra).toEqual(["eve@evil.com"]); // in the book, never in the chain
    expect(rec.missing).toEqual([]);
  });

  it("an unlogged REMOVAL is divergence too (missing), not silence", async () => {
    const { w, store } = await world();
    await store.insertContactCard(ACCOUNT, card("c1", "ab_gov", ["bob@x.com"]), HUMAN);
    w.db.sqlite.prepare(`DELETE FROM contact_cards WHERE id = 'c1'`).run();
    const rec = reconcileBookMembership(
      await store.bookMembershipLog(ACCOUNT, "ab_gov"),
      await store.bookMembership(ACCOUNT, "ab_gov"),
    );
    expect(rec).toEqual({ consistent: false, missing: ["bob@x.com"], extra: [] });
  });
});
