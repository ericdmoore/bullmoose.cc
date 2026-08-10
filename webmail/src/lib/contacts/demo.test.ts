import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { JmapRequestError } from "../jmap/JmapClient";
import { contactsAccounts } from "./books";
import { contactsDemoClient, installContactsDemo } from "./demo";

// The demo backend earns its keep only if it is as UNKIND as the server. These
// assert the mirrored warts rather than the happy path, which the other test
// files already drive.

describe("the demo mirrors the server's refusals", () => {
  it("throws cannotCalculateChanges, exactly as ContactCard/queryChanges does", async () => {
    const client = new FakeJmapClient();
    installContactsDemo(client);
    await expect(
      client.requestOne("ContactCard/queryChanges", { accountId: "acct-fake", sinceState: "0" }),
    ).rejects.toBeInstanceOf(JmapRequestError);
  });

  it("advertises canCalculateChanges: false, so a client re-queries", async () => {
    const client = new FakeJmapClient();
    installContactsDemo(client);
    const result = await client.requestOne("ContactCard/query", { accountId: "acct-fake" });
    expect(result.canCalculateChanges).toBe(false);
  });

  it("refuses a card in two address books (maxAddressBooksPerCard is 1)", async () => {
    const client = new FakeJmapClient();
    installContactsDemo(client);
    const result = (await client.requestOne("ContactCard/set", {
      accountId: "acct-fake",
      create: { c0: { name: { full: "X" }, addressBookIds: { "ab-personal": true, "ab-work": true } } },
    })) as { notCreated: Record<string, { properties?: string[] }> };
    expect(result.notCreated.c0?.properties).toEqual(["addressBookIds"]);
  });

  it("refuses to change a uid, because the server calls it immutable", async () => {
    const client = new FakeJmapClient();
    installContactsDemo(client);
    const result = (await client.requestOne("ContactCard/set", {
      accountId: "acct-fake",
      update: { "cc-ada": { uid: "urn:uuid:someone-else" } },
    })) as { notUpdated: Record<string, { description?: string }> };
    expect(result.notUpdated["cc-ada"]?.description).toContain("uid is immutable");
  });

  it("refuses a member path whose parent does not exist", async () => {
    // The reason `addMemberPatch` writes a whole object for the first member.
    const client = new FakeJmapClient();
    installContactsDemo(client);
    const result = (await client.requestOne("ContactCard/set", {
      accountId: "acct-fake",
      update: { "cc-ada": { "members/urn:uuid:x": true } },
    })) as { notUpdated: Record<string, { description?: string }> };
    expect(result.notUpdated["cc-ada"]?.description).toContain("does not exist");
  });
});

describe("the ?shared=1 demo knob", () => {
  it("installs onto the shared demo client by default", () => {
    const base = new FakeJmapClient();
    expect(contactsDemoClient(base, "?demo=1")).toBe(base);
  });

  it("builds a grant-shaped session when asked, so the refusal path is drivable", async () => {
    // Same intent as `?agentcap=0` (../app/client.ts:66-71): a refusal path
    // that is only unit-tested is one nobody has ever seen.
    const client = contactsDemoClient(new FakeJmapClient(), "?demo=1&shared=1");
    const session = await client.session();
    const [account] = contactsAccounts(session);
    expect(account).toMatchObject({ isPersonal: false, isPrimary: false });

    const books = (await client.requestOne("AddressBook/get", {
      accountId: "acct-fake",
      ids: null,
    })) as { list: Array<{ id: string }> };
    expect(books.list.map((b) => b.id)).toEqual(["ab-work"]);

    const refused = await client.request([["AddressBook/set", { accountId: "acct-fake" }, "c0"]]);
    expect(refused[0]?.[0]).toBe("error");
  });
});
