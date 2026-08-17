import { describe, expect, it } from "vitest";
import { demoContactCards } from "./demo";
import {
  blankAddress,
  blankEntry,
  blankForm,
  cardCreateSpec,
  cardUpdatePatch,
  deepEqual,
  formProblems,
  moveCardPatch,
  OWNED_PROPERTIES,
  pointerToken,
  readCardForm,
} from "./form";
import type { ContactCard } from "./types";

const ada = (): ContactCard => demoContactCards().find((c) => c.id === "cc-ada")!;
const grace = (): ContactCard => demoContactCards().find((c) => c.id === "cc-grace")!;
const katherine = (): ContactCard => demoContactCards().find((c) => c.id === "cc-katherine")!;

describe("reading a JSContact card into a form", () => {
  it("reads the structured name, not a flat string", () => {
    const form = readCardForm(ada());
    expect(form.full).toBe("Ada Lovelace");
    expect(form.given).toBe("Ada");
    expect(form.surname).toBe("Lovelace");
  });

  it("reads keyed maps as rows that remember their key", () => {
    const form = readCardForm(grace());
    expect(form.emails).toHaveLength(1);
    expect(form.emails[0]).toMatchObject({
      key: "email1",
      value: "grace@example.test",
      context: "work",
    });
    // `pref` and `label` are not the form's business, so they ride in `rest`.
    expect(form.emails[0]?.rest).toEqual({ pref: 1, label: "desk" });
  });

  it("reads an address as components, not as a street line", () => {
    const form = readCardForm(ada());
    expect(form.addresses[0]).toMatchObject({
      key: "addr1",
      street: "12 St James's Square",
      locality: "London",
      postcode: "SW1Y 4LE",
      country: "United Kingdom",
      context: "private",
    });
  });

  it("shows only the first organization, and remembers there are others", () => {
    const form = readCardForm(katherine());
    expect(form.organization).toBe("Flight Research Division");
  });

  it("survives a card with none of the properties it renders", () => {
    const form = readCardForm({ id: "cc-empty" });
    expect(form).toEqual(blankForm());
  });
});

describe("the patch names only what changed", () => {
  it("emits nothing at all for an untouched form", () => {
    const card = ada();
    expect(cardUpdatePatch(card, readCardForm(card))).toEqual({});
  });

  it("emits only `emails` when only an email changed", () => {
    const card = grace();
    const form = readCardForm(card);
    form.emails[0]!.value = "grace@navy.test";
    const patch = cardUpdatePatch(card, form);
    expect(Object.keys(patch)).toEqual(["emails"]);
  });

  it("never mentions a property the form does not render", () => {
    // The round-trip claim, made checkable: Ada carries anniversaries, media
    // and a vCardProps tail, and NONE of them may appear in a patch built by
    // an editor that cannot show them (see form.ts's header).
    const card = ada();
    const form = readCardForm(card);
    form.full = "Ada, Countess of Lovelace";
    form.emails[0]!.value = "ada@analytical.test";
    const patch = cardUpdatePatch(card, form);

    for (const key of Object.keys(patch)) {
      expect(OWNED_PROPERTIES as readonly string[]).toContain(key);
    }
    for (const untouchable of [
      "anniversaries",
      "media",
      "vCardProps",
      "uid",
      "id",
      "kind",
      "created",
    ]) {
      expect(patch).not.toHaveProperty(untouchable);
    }
  });

  it("keeps an entry's key and its unknown fields when its value changes", () => {
    const card = grace();
    const form = readCardForm(card);
    form.emails[0]!.value = "grace@navy.test";
    const patch = cardUpdatePatch(card, form) as {
      emails: Record<string, Record<string, unknown>>;
    };
    // Same key — CardDAV round-trips Apple's itemN label grouping through it.
    expect(Object.keys(patch.emails)).toEqual(["email1"]);
    expect(patch.emails.email1).toEqual({
      pref: 1,
      label: "desk",
      address: "grace@navy.test",
      contexts: { work: true },
    });
  });

  it("keeps name components it does not own", () => {
    const card = ada();
    const form = readCardForm(card);
    form.surname = "Byron King";
    const patch = cardUpdatePatch(card, form) as { name: { components: Array<{ kind: string }> } };
    expect(patch.name.components.map((c) => c.kind)).toContain("credential");
  });

  it("removes a property with null when its last row is emptied", () => {
    const card = grace();
    const form = readCardForm(card);
    form.emails[0]!.value = "";
    expect(cardUpdatePatch(card, form)).toMatchObject({ emails: null });
  });

  it("removes one row of several without touching the rest", () => {
    const card: ContactCard = {
      id: "cc-two",
      emails: { a: { address: "one@example.test" }, b: { address: "two@example.test" } },
    };
    const form = readCardForm(card);
    form.emails = form.emails.filter((e) => e.key !== "a");
    const patch = cardUpdatePatch(card, form) as { emails: Record<string, unknown> };
    expect(Object.keys(patch.emails)).toEqual(["b"]);
  });

  it("does not eat a second organization when the first is edited", () => {
    const card = katherine();
    const form = readCardForm(card);
    form.organization = "Space Task Group";
    const patch = cardUpdatePatch(card, form) as {
      organizations: Record<string, { name: string }>;
    };
    expect(patch.organizations.org1?.name).toBe("Space Task Group");
    expect(patch.organizations.org2?.name).toBe("West Area Computers");
  });

  it("gives a new row a key that does not collide with an existing one", () => {
    const card = grace();
    const form = readCardForm(card);
    form.emails.push({ ...blankEntry(), value: "grace@home.test" });
    const patch = cardUpdatePatch(card, form) as { emails: Record<string, unknown> };
    const keys = Object.keys(patch.emails);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toContain("email1");
  });

  it("preserves address components the form has no field for", () => {
    const card: ContactCard = {
      id: "cc-apt",
      addresses: {
        addr1: {
          components: [
            { kind: "name", value: "1 Main St" },
            { kind: "apartment", value: "4B" },
          ],
        },
      },
    };
    const form = readCardForm(card);
    expect(form.addresses[0]?.street).toBe("1 Main St");
    form.addresses[0]!.locality = "Springfield";
    const patch = cardUpdatePatch(card, form) as {
      addresses: Record<string, { components: Array<{ kind: string; value: string }> }>;
    };
    expect(patch.addresses.addr1?.components).toContainEqual({ kind: "apartment", value: "4B" });
    expect(patch.addresses.addr1?.components).toContainEqual({
      kind: "locality",
      value: "Springfield",
    });
  });

  it("drops an address whose every field was cleared", () => {
    const card = ada();
    const form = readCardForm(card);
    form.addresses[0] = { ...blankAddress(), key: "addr1" };
    expect(cardUpdatePatch(card, form)).toMatchObject({ addresses: null });
  });
});

describe("creating a card", () => {
  it("leaves every server-set property to the server", () => {
    const form = {
      ...blankForm(),
      full: "New Person",
      emails: [{ ...blankEntry(), value: "new@example.test" }],
    };
    const spec = cardCreateSpec(form, "ab-personal");
    for (const serverSet of ["id", "uid", "created", "updated", "@type", "version"]) {
      expect(spec).not.toHaveProperty(serverSet);
    }
    expect(spec.addressBookIds).toEqual({ "ab-personal": true });
    expect(spec.name).toEqual({ full: "New Person" });
  });

  it("omits addressBookIds entirely when no book was chosen", () => {
    // The server then resolves the default book, or the single shared book for
    // a restricted writer (contacts.ts:356-367). Sending `{}` would fail.
    expect(cardCreateSpec({ ...blankForm(), full: "X" })).not.toHaveProperty("addressBookIds");
  });

  it("builds name components from given/surname", () => {
    const spec = cardCreateSpec({ ...blankForm(), given: "Ada", surname: "Lovelace" });
    expect(spec.name).toEqual({
      components: [
        { kind: "given", value: "Ada" },
        { kind: "surname", value: "Lovelace" },
      ],
    });
  });
});

describe("pointer escaping", () => {
  it("escapes the two characters a JSON pointer reserves", () => {
    // A uid may be a URI, and an unescaped `/` would address the wrong path
    // once the server splits on it (contacts.ts:981-983).
    expect(pointerToken("http://example.test/card/7")).toBe("http:~1~1example.test~1card~17");
    expect(pointerToken("a~b")).toBe("a~0b");
    expect(pointerToken("urn:uuid:plain")).toBe("urn:uuid:plain");
  });
});

describe("form validation", () => {
  it("refuses a card with no way to identify or find it", () => {
    expect(formProblems(blankForm())).toHaveLength(1);
  });

  it("accepts a card with only an organization", () => {
    expect(formProblems({ ...blankForm(), organization: "Babbage Instruments" })).toEqual([]);
  });

  it("flags an email address that is not one", () => {
    const form = {
      ...blankForm(),
      full: "X",
      emails: [{ ...blankEntry(), value: "not-an-address" }],
    };
    expect(formProblems(form).join(" ")).toContain("not-an-address");
  });
});

describe("moveCardPatch", () => {
  it("replaces the membership rather than adding to it", () => {
    // maxAddressBooksPerCard is 1, so a move is a replace and `singleBookId`
    // rejects anything else (contacts.ts:917-938).
    expect(moveCardPatch("ab-work")).toEqual({ addressBookIds: { "ab-work": true } });
  });
});

describe("deepEqual", () => {
  it("ignores key order, so a rebuilt entry is not a false change", () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: [1, { c: 3 }] }, { a: [1, { c: 3 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});
