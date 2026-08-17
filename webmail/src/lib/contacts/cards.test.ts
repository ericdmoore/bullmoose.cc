import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import {
  CARD_LIST_PROPERTIES,
  CONTACT_SEARCH_COST_NOTE,
  CONTACT_SEARCH_SCOPE_NOTE,
  CONTACT_TEXT_FIELDS,
  buildContactFilter,
  describeContactScope,
  displayName,
  firstEmail,
  firstOrganization,
  firstPhone,
  isEmptySearch,
  loadCard,
  loadCards,
} from "./cards";
import { installContactsDemo } from "./demo";
import type { ContactCard } from "./types";

const withDemo = () => {
  const client = new FakeJmapClient();
  const backend = installContactsDemo(client);
  return { client, backend };
};

describe("building the query filter", () => {
  it("is null for an empty spec, not an empty condition object", () => {
    expect(buildContactFilter({})).toBeNull();
    expect(isEmptySearch({})).toBe(true);
  });

  it("uses the single condition directly when there is only one", () => {
    expect(buildContactFilter({ text: "ada" })).toEqual({ text: "ada" });
    expect(buildContactFilter({ inBook: "ab-work" })).toEqual({ inAddressBook: "ab-work" });
  });

  it("ANDs several conditions", () => {
    expect(buildContactFilter({ text: "ada", inBook: "ab-work", kind: "group" })).toEqual({
      operator: "AND",
      conditions: [{ inAddressBook: "ab-work" }, { text: "ada" }, { kind: "group" }],
    });
  });

  it("trims free text, so a stray space is not a search term", () => {
    expect(buildContactFilter({ text: "  ada  " })).toEqual({ text: "ada" });
  });
});

describe("the scope note is the honest one", () => {
  it("names the six property groups the server really matches", () => {
    // `buildContactFilter`'s `text` case (mailstore:1830-1841) ORs exactly
    // these six and nothing else.
    expect(CONTACT_TEXT_FIELDS).toEqual([
      "name",
      "nickname",
      "organization",
      "email",
      "phone",
      "note",
    ]);
    for (const field of CONTACT_TEXT_FIELDS) {
      expect(CONTACT_SEARCH_SCOPE_NOTE.toLowerCase()).toContain(field);
    }
  });

  it("says what is NOT searched rather than leaving it to be discovered", () => {
    expect(CONTACT_SEARCH_SCOPE_NOTE).toMatch(/not searched/i);
  });

  it("states the scaling cost, because the query is a full scan", () => {
    // The `common/004` lesson applied to contacts: a search box that implies
    // an index it does not have teaches people the data is not there.
    expect(CONTACT_SEARCH_COST_NOTE).toMatch(/not indexed/i);
    expect(CONTACT_SEARCH_COST_NOTE).toMatch(/every card/i);
  });

  it("describes the query actually being run", () => {
    expect(describeContactScope({ text: "ada" })).toContain("“ada”");
    expect(describeContactScope({ kind: "group" })).toContain("groups only");
    expect(describeContactScope({}, "Work")).toBe("Showing every card in “Work”.");
    expect(describeContactScope({})).toBe("Showing every card.");
  });
});

describe("loading a page of cards", () => {
  it("is ONE round trip — query then get, joined by a back-reference", async () => {
    const { client } = withDemo();
    const page = await loadCards(client, "acct-fake");
    expect(page.cards.length).toBeGreaterThan(0);
    expect(client.sentBatches).toHaveLength(1);
    const [batch] = client.sentBatches;
    expect(batch?.map((call) => call[0])).toEqual(["ContactCard/query", "ContactCard/get"]);
    expect(batch?.[1]?.[1]).toHaveProperty("#ids");
  });

  it("returns cards in the QUERY's order, not the store's", async () => {
    const { client } = withDemo();
    const page = await loadCards(client, "acct-fake", { sort: "name", isAscending: false });
    const names = page.cards.map(displayName);
    expect(names).toEqual([...names].sort().reverse());
  });

  it("asks only for the properties a row renders", async () => {
    const { client } = withDemo();
    await loadCards(client, "acct-fake");
    expect(client.sentBatches[0]?.[1]?.[1]?.properties).toEqual([...CARD_LIST_PROPERTIES]);
  });

  it("clamps limit into the range the server accepts", async () => {
    const { client } = withDemo();
    await loadCards(client, "acct-fake", { limit: 9_999 });
    expect(client.sentBatches[0]?.[0]?.[1]?.limit).toBe(256);
  });

  it("asks for a total only when told to — it costs a second scan", async () => {
    const { client } = withDemo();
    await loadCards(client, "acct-fake");
    expect(client.sentBatches[0]?.[0]?.[1]).not.toHaveProperty("calculateTotal");

    const page = await loadCards(client, "acct-fake", { calculateTotal: true });
    expect(page.total).toBe(5);
  });

  it("carries the queryState forward so a write can be guarded by it", async () => {
    const { client } = withDemo();
    expect((await loadCards(client, "acct-fake")).queryState).toBe("0");
  });

  it("filters to one address book", async () => {
    const { client } = withDemo();
    const page = await loadCards(client, "acct-fake", {
      filter: buildContactFilter({ inBook: "ab-personal" }),
    });
    expect(page.cards.map((c) => c.id)).toEqual(["cc-ada"]);
  });

  it("searches the fields it claims to and misses the ones it does not", async () => {
    const { client } = withDemo();
    const byNote = await loadCards(client, "acct-fake", {
      filter: buildContactFilter({ text: "algorithm" }),
    });
    expect(byNote.cards.map((c) => c.id)).toEqual(["cc-ada"]);

    // Ada's street address is on the card and NOT reachable by `text` — the
    // exact gap CONTACT_SEARCH_SCOPE_NOTE names.
    const byStreet = await loadCards(client, "acct-fake", {
      filter: buildContactFilter({ text: "St James" }),
    });
    expect(byStreet.cards).toEqual([]);
  });

  it("reads one whole card for the detail pane", async () => {
    const { client } = withDemo();
    const card = await loadCard(client, "acct-fake", "cc-ada");
    expect(card?.anniversaries).toBeDefined();
    expect(await loadCard(client, "acct-fake", "cc-nope")).toBeUndefined();
  });
});

describe("display name mirrors the server's deriveNameFull", () => {
  const cases: Array<[string, ContactCard, string]> = [
    ["name.full wins", { id: "1", name: { full: "Ada Lovelace" } }, "Ada Lovelace"],
    [
      "then the joined components, skipping separators",
      {
        id: "2",
        name: {
          components: [
            { kind: "given", value: "Grace" },
            { kind: "separator", value: " " },
            { kind: "surname", value: "Hopper" },
          ],
        },
      },
      "Grace Hopper",
    ],
    ["then the organization", { id: "3", organizations: { o: { name: "Babbage" } } }, "Babbage"],
    ["then the first email", { id: "4", emails: { e: { address: "x@y.test" } } }, "x@y.test"],
    ["and never an empty string", { id: "5" }, "(unnamed)"],
  ];
  for (const [label, card, expected] of cases) {
    it(label, () => expect(displayName(card)).toBe(expected));
  }

  it("reads the first of each list for the row", () => {
    const card: ContactCard = {
      id: "6",
      emails: { a: { address: "one@x.test" }, b: { address: "two@x.test" } },
      phones: { a: { number: "+1" } },
      organizations: { a: { name: "Org" } },
    };
    expect(firstEmail(card)).toBe("one@x.test");
    expect(firstPhone(card)).toBe("+1");
    expect(firstOrganization(card)).toBe("Org");
    expect(firstEmail({ id: "7" })).toBeUndefined();
  });
});
