import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { loadCard } from "./cards";
import { installContactsDemo } from "./demo";
import { cardCreateSpec, blankForm, blankEntry, readCardForm, cardUpdatePatch } from "./form";
import type { ContactCard } from "./types";
import {
  createBook,
  createCard,
  describeContactRefusal,
  describeSetError,
  destroyBook,
  destroyCard,
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
    const form = { ...blankForm(), full: "New Person", emails: [{ ...blankEntry(), value: "new@x.test" }] };
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
    const stale = await updateCard(
      client,
      "acct-fake",
      "cc-ada",
      { name: { full: "B" } },
      { ifInState: "0" },
    );
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
    expect((await updateCard(client, "acct-fake", "cc-ada", { notes: null })).error?.type).toBe(
      "notFound",
    );
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
    expect(
      describeContactRefusal({ type: "weird", description: "the disk is on fire" }, "card").message,
    ).toBe("the disk is on fire");
    expect(describeContactRefusal({ type: "weird" }, "card").message).toContain("weird");
  });

  it("explains a vanished card in the vocabulary of the screen", () => {
    const card: ContactCard = { id: "cc-x" };
    expect(describeSetError({ type: "notFound" }, card)).toMatch(/no longer there/);
  });
});
