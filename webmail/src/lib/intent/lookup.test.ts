import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { lookupRecipient } from "./lookup";
import { resolveRecipient } from "./resolve";

// s20 T3 — the two reads behind "who is Sergio?", and the promise attached to
// them: NEITHER source is required. A token without the contacts scope, a
// server without `ContactCard/*`, an empty address book — each degrades to the
// other leg and SAYS which one it lost, because "I could not read your address
// book" and "you have no Sergio" are different sentences.

const ACCOUNT = "acct-fake";

const CARD = {
  id: "cc_1",
  name: { full: "Sergio Ramos" },
  emails: { work: { address: "sergio@boards.example" }, home: { address: "sergio@home.example" } },
};

const MESSAGE = {
  id: "e_1",
  from: [{ name: "Sergio Ramos", email: "sergio@boards.example" }],
  to: [{ name: "Eric", email: "eric@bullmoose.cc" }],
  cc: [],
  receivedAt: "2026-08-14T10:00:00.000Z",
};

function client(over: Record<string, unknown> = {}) {
  return new FakeJmapClient({
    handlers: {
      "ContactCard/query": () => ({ accountId: ACCOUNT, ids: ["cc_1"], position: 0, queryState: "1" }),
      "ContactCard/get": () => ({ accountId: ACCOUNT, state: "1", list: [CARD], notFound: [] }),
      "Email/query": () => ({ accountId: ACCOUNT, ids: ["e_1"], position: 0, queryState: "1" }),
      "Email/get": () => ({ accountId: ACCOUNT, state: "1", list: [MESSAGE], notFound: [] }),
      ...over,
    },
  });
}

describe("lookupRecipient", () => {
  it("reads both sources in one pass and keeps every address on the card", async () => {
    const found = await lookupRecipient(client(), ACCOUNT, "Sergio");
    expect(found.cards).toEqual([
      { email: "sergio@boards.example", name: "Sergio Ramos" },
      { email: "sergio@home.example", name: "Sergio Ramos" },
    ]);
    expect(found.history).toEqual([
      { email: "sergio@boards.example", name: "Sergio Ramos", emailId: "e_1", at: Date.parse(MESSAGE.receivedAt) },
      { email: "eric@bullmoose.cc", name: "Eric", emailId: "e_1", at: Date.parse(MESSAGE.receivedAt) },
    ]);
    expect(found.degraded).toEqual([]);
  });

  it("sends the query as a text filter, newest first, with no bodies", async () => {
    const c = client();
    await lookupRecipient(c, ACCOUNT, "Sergio");
    const calls = c.sentBatches.flat();
    const emailQuery = calls.find((call) => call[0] === "Email/query")![1] as Record<string, unknown>;
    expect(emailQuery.filter).toEqual({ text: "Sergio" });
    expect(emailQuery.sort).toEqual([{ property: "receivedAt", isAscending: false }]);
    const emailGet = calls.find((call) => call[0] === "Email/get")![1] as { properties: string[] };
    expect(emailGet.properties).not.toContain("bodyValues");
  });

  // The demo backend has no `ContactCard/*` at all, and a token can lack the
  // contacts scope. Both land here.
  it("degrades to mail alone when the address book cannot be read, and says so", async () => {
    const c = client({ "ContactCard/query": () => ["error", { type: "forbidden", description: "no contacts scope" }] });
    const found = await lookupRecipient(c, ACCOUNT, "Sergio");
    expect(found.cards).toEqual([]);
    expect(found.history.length).toBeGreaterThan(0);
    expect(found.degraded).toEqual(["Your address book could not be read, so this is from your mail alone."]);
  });

  it("degrades to the address book alone when mail cannot be searched, and says so", async () => {
    const c = client({ "Email/query": () => ["error", { type: "unknownMethod" }] });
    const found = await lookupRecipient(c, ACCOUNT, "Sergio");
    expect(found.history).toEqual([]);
    expect(found.cards.length).toBeGreaterThan(0);
    expect(found.degraded).toEqual([
      "Your mail history could not be searched, so this is from your address book alone.",
    ]);
  });

  it("survives losing both — the composer stays usable, you just type the address", async () => {
    const c = client({
      "ContactCard/query": () => ["error", { type: "forbidden" }],
      "Email/query": () => ["error", { type: "forbidden" }],
    });
    const found = await lookupRecipient(c, ACCOUNT, "Sergio");
    expect(found.degraded).toHaveLength(2);
    expect(resolveRecipient("Sergio", found.cards, found.history).status).toBe("unknown");
  });

  it("does not go to the server for an empty name", async () => {
    const c = client();
    expect(await lookupRecipient(c, ACCOUNT, "   ")).toEqual({ cards: [], history: [], degraded: [] });
    expect(c.sentBatches).toHaveLength(0);
  });

  it("feeds a resolution that names both sources", async () => {
    const found = await lookupRecipient(client(), ACCOUNT, "Sergio");
    const res = resolveRecipient("Sergio", found.cards, found.history, {
      now: Date.parse(MESSAGE.receivedAt) + 86_400_000,
      exclude: ["eric@bullmoose.cc"],
    });
    expect(res.status).toBe("resolved");
    expect(res.chosen).toMatchObject({
      email: "sergio@boards.example",
      via: "address-book+history",
      anchorEmailId: "e_1",
    });
  });
});
