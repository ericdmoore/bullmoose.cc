import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { loadCard } from "./cards";
import { installContactsDemo } from "./demo";
import { cardCreateSpec, blankForm, blankEntry, readCardForm, cardUpdatePatch } from "./form";
import type { ContactCard } from "./types";
import {
  chunk,
  createBook,
  createCard,
  describeContactRefusal,
  describeSetError,
  destroyBook,
  destroyCard,
  destroyCards,
  moveCards,
  renameBook,
  saveCardEdit,
  updateCard,
} from "./write";

const withDemo = (opts = {}) => {
  const client = new FakeJmapClient();
  const backend = installContactsDemo(client, opts);
  return { client, backend };
};

describe("card writes", () => {
  it("creates a card and hands back its server-minted id", async () => {
    const { client, backend } = withDemo();
    const form = {
      ...blankForm(),
      full: "New Person",
      emails: [{ ...blankEntry(), value: "new@x.test" }],
    };
    const result = await createCard(client, "acct-fake", cardCreateSpec(form, "ab-personal"));
    expect(result.error).toBeUndefined();
    expect(result.id).toBeTruthy();
    expect(result.newState).toBe("1");
    expect(backend.cards.find((c) => c.id === result.id)?.uid).toMatch(/^urn:uuid:/);
  });

  it("reports the server's refusal of one object rather than throwing", async () => {
    const { client } = withDemo();
    const result = await createCard(client, "acct-fake", { id: "cc-mine", name: { full: "X" } });
    expect(result.id).toBeUndefined();
    expect(result.error?.type).toBe("invalidProperties");
    expect(describeSetError(result.error!, null)).toContain("id is server-set");
  });

  it("updates through the patch the form produced", async () => {
    const { client, backend } = withDemo();
    const card = backend.cards.find((c) => c.id === "cc-grace")!;
    const form = readCardForm(card);
    form.emails[0]!.value = "grace@navy.test";
    await updateCard(client, "acct-fake", card.id, cardUpdatePatch(card, form));
    expect((await loadCard(client, "acct-fake", "cc-grace"))?.emails?.email1).toMatchObject({
      address: "grace@navy.test",
      pref: 1,
    });
  });

  it("destroys a card", async () => {
    const { client, backend } = withDemo();
    const result = await destroyCard(client, "acct-fake", "cc-ada");
    expect(result.error).toBeUndefined();
    expect(backend.cards.some((c) => c.id === "cc-ada")).toBe(false);
  });

  it("passes ifInState through, so a stale view cannot clobber a concurrent change", async () => {
    const { client } = withDemo();
    await updateCard(client, "acct-fake", "cc-ada", { name: { full: "A" } }, { ifInState: "0" });
    expect(client.sentBatches.at(-1)?.[0]?.[1]).toMatchObject({ ifInState: "0" });
  });

  it("refuses the whole call on a state mismatch, and says so in a sentence", async () => {
    const { client } = withDemo();
    await updateCard(client, "acct-fake", "cc-ada", { name: { full: "A" } });
    const stale = await updateCard(client, "acct-fake", "cc-ada", { name: { full: "B" } }, { ifInState: "0" });
    expect(stale.refusal?.type).toBe("stateMismatch");
    expect(stale.refusal?.message).toMatch(/Reload/);
  });
});

describe("saveCardEdit: read, verify, write", () => {
  it("writes with the state from the read it just did", async () => {
    const { client, backend } = withDemo();
    const card = backend.cards.find((c) => c.id === "cc-grace")!;
    const result = await saveCardEdit(client, "acct-fake", { ...card }, { notes: null });
    expect(result.refusal).toBeUndefined();
    expect(result.conflict).toBeUndefined();
    const write = client.sentBatches.at(-1)?.[0]?.[1] as { ifInState?: string };
    expect(write.ifInState).toBe("0");
  });

  it("refuses to overwrite a property that moved underneath it", async () => {
    const { client, backend } = withDemo();
    const base = structuredClone(backend.cards.find((c) => c.id === "cc-grace")!);
    // Somebody else edits the same property (Apple Contacts over CardDAV, the
    // CLI, another tab) between the read and the save.
    backend.cards.find((c) => c.id === "cc-grace")!.emails = {
      email1: { address: "grace@elsewhere.test" },
    };
    const result = await saveCardEdit(client, "acct-fake", base, {
      emails: { email1: { address: "grace@mine.test" } },
    });
    expect(result.conflict?.properties).toEqual(["emails"]);
    expect(result.conflict?.current.emails?.email1).toMatchObject({
      address: "grace@elsewhere.test",
    });
  });

  it("lets an unrelated change through — the account state is not the card", async () => {
    // `ifInState` is compared against ONE account-wide state (common.ts:144-148),
    // so a message arriving bumps it. Re-reading before the write is what keeps
    // that from failing an edit that lost nothing.
    const { client, backend } = withDemo();
    const base = structuredClone(backend.cards.find((c) => c.id === "cc-grace")!);
    await destroyCard(client, "acct-fake", "cc-ada"); // bumps the account state
    const result = await saveCardEdit(client, "acct-fake", base, { notes: null });
    expect(result.conflict).toBeUndefined();
    expect(result.refusal).toBeUndefined();
    expect(backend.cards.find((c) => c.id === "cc-grace")?.notes).toBeUndefined();
  });

  it("reports a card destroyed underneath the edit as gone, not as a conflict", async () => {
    const { client, backend } = withDemo();
    const base = structuredClone(backend.cards.find((c) => c.id === "cc-grace")!);
    await destroyCard(client, "acct-fake", "cc-grace");
    const result = await saveCardEdit(client, "acct-fake", base, { notes: null });
    expect(result.error?.type).toBe("notFound");
  });

  it("compares a nested member patch on its root property", async () => {
    const { client, backend } = withDemo();
    const elk = structuredClone(backend.cards.find((c) => c.id === "cc-elk")!);
    const result = await saveCardEdit(client, "acct-fake", elk, { "members/urn:uuid:ada": true });
    expect(result.refusal).toBeUndefined();
    expect(backend.cards.find((c) => c.id === "cc-elk")?.members).toHaveProperty("urn:uuid:ada");
  });

  it("does nothing at all for an empty patch", async () => {
    const { client, backend } = withDemo();
    const card = backend.cards[0]!;
    expect(await saveCardEdit(client, "acct-fake", card, {})).toEqual({});
    expect(client.sentBatches).toHaveLength(0);
  });
});

describe("address books are owner-only", () => {
  it("creates, renames and destroys for the owner", async () => {
    const { client, backend } = withDemo();
    const made = await createBook(client, "acct-fake", "  Rolodex  ");
    expect(made.id).toBeTruthy();
    expect(backend.books.find((b) => b.id === made.id)?.name).toBe("Rolodex");

    await renameBook(client, "acct-fake", made.id!, "Address Book");
    expect(backend.books.find((b) => b.id === made.id)?.name).toBe("Address Book");

    const gone = await destroyBook(client, "acct-fake", made.id!);
    expect(gone.error).toBeUndefined();
    expect(backend.books.some((b) => b.id === made.id)).toBe(false);
  });

  it("refuses to delete a book that still holds cards, until told twice", async () => {
    const { client, backend } = withDemo();
    const refused = await destroyBook(client, "acct-fake", "ab-work");
    expect(refused.error?.type).toBe("addressBookHasContents");
    expect(describeSetError(refused.error!, backend.books[1]!)).toContain("deletes them too");

    const forced = await destroyBook(client, "acct-fake", "ab-work", true);
    expect(forced.error).toBeUndefined();
    // One book per card, so the cards go with it (contacts.ts:190-192).
    expect(backend.cards.some((c) => c.addressBookIds?.["ab-work"])).toBe(false);
  });

  it("refuses the whole method for a grant-reached session, with an actionable sentence", async () => {
    // contacts.ts:117-122 throws before it reads an argument, so this is a
    // method-level error and not a per-object one.
    const { client } = withDemo({ allowedBookIds: ["ab-work"], mayManageBooks: false });
    const result = await createBook(client, "acct-fake", "Mine");
    expect(result.refusal?.type).toBe("forbidden");
    expect(result.refusal?.message).toContain("Only the account owner");
    expect(result.refusal?.message).toContain("cards inside the books shared with you");
  });
});

describe("a restricted session cannot reach outside its grant", () => {
  it("cannot see, edit or destroy a card in a book it was not granted", async () => {
    const { client } = withDemo({ allowedBookIds: ["ab-work"], mayManageBooks: false });
    // Ada lives in ab-personal. Out of grant reads as ABSENT, not forbidden —
    // the server refuses to leak that the card exists (contacts.ts:459-460).
    expect(await loadCard(client, "acct-fake", "cc-ada")).toBeUndefined();
    expect((await updateCard(client, "acct-fake", "cc-ada", { notes: null })).error?.type).toBe("notFound");
    expect((await destroyCard(client, "acct-fake", "cc-ada")).error?.type).toBe("notFound");
  });

  it("still edits cards inside the book it WAS granted", async () => {
    const { client, backend } = withDemo({ allowedBookIds: ["ab-work"], mayManageBooks: false });
    const result = await updateCard(client, "acct-fake", "cc-grace", { notes: null });
    expect(result.error).toBeUndefined();
    expect(backend.cards.find((c) => c.id === "cc-grace")?.notes).toBeUndefined();
  });
});

describe("refusals are sentences, not JMAP types", () => {
  it("explains a forbidden card write as a missing contacts permission", () => {
    expect(describeContactRefusal({ type: "forbidden" }, "card").message).toContain("contacts");
  });

  it("falls back to the server's own description for anything unrecognised", () => {
    expect(describeContactRefusal({ type: "weird", description: "the disk is on fire" }, "card").message).toBe(
      "the disk is on fire",
    );
    expect(describeContactRefusal({ type: "weird" }, "card").message).toContain("weird");
  });

  it("explains a vanished card in the vocabulary of the screen", () => {
    const card: ContactCard = { id: "cc-x" };
    expect(describeSetError({ type: "notFound" }, card)).toMatch(/no longer there/);
  });
});

// ── s34: bulk ──────────────────────────────────────────────────────────────
//
// The whole point of these helpers is the REQUEST COUNT: `ContactCard/set`
// takes a set, so 3,557 destroys is a handful of calls and not 3,557 of them.
// `client.sentBatches` is what makes that testable, so most of what follows
// counts calls rather than inspecting results.

describe("chunk", () => {
  it("splits into runs of at most `size`, keeping order and losing nothing", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
    expect(chunk([], 5)).toEqual([]);
  });

  it("clamps a nonsense size rather than looping forever", () => {
    // `maxObjectsInSet` comes off the wire; 0 or -1 would be an infinite loop
    // in the caller, which is a browser tab that never comes back.
    expect(chunk([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
    expect(chunk([1, 2, 3], -4)).toEqual([[1], [2], [3]]);
    expect(chunk([1, 2, 3], 2.7)).toEqual([[1, 2], [3]]);
  });
});

describe("destroyCards — one call per chunk, never one per card", () => {
  it("destroys many in a SINGLE ContactCard/set", async () => {
    const { client, backend } = withDemo();
    const ids = backend.cards.map((c) => c.id);
    expect(ids.length).toBeGreaterThan(1);
    const before = client.sentBatches.length;

    const outcome = await destroyCards(client, "acct-fake", ids);

    expect(client.sentBatches.length - before).toBe(1);
    expect(outcome.done.sort()).toEqual([...ids].sort());
    expect(outcome.failed).toEqual([]);
    expect(backend.cards).toHaveLength(0);
  });

  it("chunks to `maxObjectsInSet` — 400 ids at 500 is one call, at 2 is 200", async () => {
    const { client, backend } = withDemo();
    const ids = backend.cards.map((c) => c.id);
    const before = client.sentBatches.length;

    await destroyCards(client, "acct-fake", ids, { chunkSize: 1 });

    expect(client.sentBatches.length - before).toBe(ids.length);
    // …and every call carried exactly one id.
    for (const batch of client.sentBatches.slice(before)) {
      expect((batch[0]![1] as { destroy: string[] }).destroy).toHaveLength(1);
    }
  });

  it("de-duplicates, so a repeated id is not reported as its own failure", async () => {
    const { client } = withDemo();
    const outcome = await destroyCards(client, "acct-fake", ["cc-ada", "cc-ada"]);
    expect(outcome.done).toEqual(["cc-ada"]);
    expect(outcome.failed).toEqual([]);
  });

  it("surfaces per-id failures from notDestroyed, in the vocabulary of the screen", async () => {
    const { client, backend } = withDemo();
    const outcome = await destroyCards(client, "acct-fake", ["cc-ada", "cc-not-real"]);
    expect(outcome.done).toEqual(["cc-ada"]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.id).toBe("cc-not-real");
    expect(outcome.failed[0]!.message).toMatch(/no longer there/);
    // The one that COULD go, went. A partial failure is not a rollback.
    expect(backend.cards.some((c) => c.id === "cc-ada")).toBe(false);
  });

  it("done + failed always accounts for every id passed in", async () => {
    const { client } = withDemo();
    const ids = ["cc-ada", "cc-grace", "cc-nope-1", "cc-nope-2"];
    const outcome = await destroyCards(client, "acct-fake", ids, { chunkSize: 2 });
    expect(outcome.done.length + outcome.failed.length).toBe(ids.length);
  });

  it("a REFUSED call stops the run and reports the untried ids as failed", async () => {
    // A method-level `forbidden` (a token without the contacts scope, say) is
    // about the CALL, not about any card in it — so every chunk after the
    // first would be refused for the same reason. They are reported as failed
    // rather than sent, and the caller still gets one list that adds up.
    const { client } = withDemo();
    client.setHandler("ContactCard/set", () => ["error", { type: "forbidden" }]);
    const before = client.sentBatches.length;

    const outcome = await destroyCards(client, "acct-fake", ["a", "b", "c", "d"], { chunkSize: 2 });

    expect(client.sentBatches.length - before).toBe(1); // stopped after the first
    expect(outcome.done).toEqual([]);
    expect(outcome.failed.map((f) => f.id)).toEqual(["a", "b", "c", "d"]);
    expect(outcome.failed[3]!.message).toContain("not allowed to change contacts");
  });
});

describe("moveCards — the address book is JMAP membership, patched in bulk", () => {
  it("moves many with ONE update call, and the cards land in the new book", async () => {
    const { client, backend } = withDemo();
    const ids = ["cc-ada", "cc-grace"];
    const before = client.sentBatches.length;

    const outcome = await moveCards(client, "acct-fake", ids, "ab-work");

    expect(client.sentBatches.length - before).toBe(1);
    expect(outcome.done.sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(backend.cards.find((c) => c.id === id)?.addressBookIds).toEqual({ "ab-work": true });
    }
  });

  it("sends the same one-property patch for every id — nothing else is touched", async () => {
    const { client, backend } = withDemo();
    const before = { ...backend.cards.find((c) => c.id === "cc-ada") };
    await moveCards(client, "acct-fake", ["cc-ada"], "ab-work");
    const update = (client.sentBatches.at(-1)![0]![1] as { update: Record<string, unknown> }).update;
    expect(update).toEqual({ "cc-ada": { addressBookIds: { "ab-work": true } } });
    const after = backend.cards.find((c) => c.id === "cc-ada");
    expect(after?.name).toEqual(before.name);
    expect(after?.emails).toEqual(before.emails);
  });

  it("reports per-id refusals from notUpdated without losing the ones that worked", async () => {
    const { client } = withDemo();
    const outcome = await moveCards(client, "acct-fake", ["cc-ada", "cc-ghost"], "ab-work");
    expect(outcome.done).toEqual(["cc-ada"]);
    expect(outcome.failed.map((f) => f.id)).toEqual(["cc-ghost"]);
  });
});

describe("bulk writes send no ifInState", () => {
  it("does not guard a batched destroy on the account-wide state", async () => {
    // The header explains why: contacts share ONE account state with mail, so
    // an `ifInState` on a 500-object call would refuse the whole chunk for a
    // reason with nothing to do with any card in it.
    const { client, backend } = withDemo();
    await destroyCards(client, "acct-fake", [backend.cards[0]!.id]);
    expect(client.sentBatches.at(-1)?.[0]?.[1]).not.toHaveProperty("ifInState");
  });
});
