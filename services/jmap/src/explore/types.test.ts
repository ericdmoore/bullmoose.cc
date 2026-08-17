import { describe, expect, it } from "vitest";
import { TYPES, TYPE_NAMES, flattenLinks, linksFor, type LinkBuilder } from "./types";

/**
 * The `_links` derivation, in isolation from HTTP.
 *
 * `explore.test.ts` proves every emitted link RESOLVES; this file proves the
 * complementary half — that a link is emitted only when the payload carries the
 * id it is built from. The two together are what "derived, never invented"
 * means: one says the links go somewhere real, the other says they came from
 * somewhere real.
 */

const b: LinkBuilder = {
  object: (type, id) => ({ href: `/${type}/${id}`, type, id }),
  collection: (type, filter) => ({
    href: `/${type}?${new URLSearchParams(filter).toString()}`,
    type,
    list: true,
  }),
};

describe("the type table", () => {
  it("names only /get and /query methods — no write verb is reachable", () => {
    for (const name of TYPE_NAMES) {
      const spec = TYPES[name]!;
      expect(spec.get.endsWith("/get"), spec.get).toBe(true);
      if (spec.query) expect(spec.query.endsWith("/query"), spec.query).toBe(true);
      expect(spec.scopes).toEqual(["read"]);
    }
  });

  it("a non-listable type declares a note saying where to go instead", () => {
    for (const name of TYPE_NAMES) {
      const spec = TYPES[name]!;
      if (!spec.listable) expect(spec.note, name).toBeTruthy();
    }
  });
});

describe("links come from the payload, or not at all", () => {
  it("an Email with every id present links to all three", () => {
    const links = linksFor(
      "Email",
      {
        id: "e_1",
        threadId: "th_1",
        mailboxIds: { mb_1: true, mb_2: true, mb_3: false },
        blobId: "blob_1",
        attachments: [{ fileNodeId: "fn_1" }, { fileNodeId: null }, { fileNodeId: "fn_1" }],
      },
      b,
    );
    expect((links.thread as { id: string }).id).toBe("th_1");
    // `mailboxIds` is an Id[Boolean] map: only the `true` entries are members.
    expect((links.mailboxes as Array<{ id: string }>).map((l) => l.id)).toEqual(["mb_1", "mb_2"]);
    // De-duplicated: two attachments of the same file are one link.
    expect((links.files as Array<{ id: string }>).map((l) => l.id)).toEqual(["fn_1"]);
    // The blob is in the payload and must NOT be a link — there is no Blob/get.
    expect(flattenLinks(links).some((l) => l.href.includes("blob_1"))).toBe(false);
  });

  it("an Email with nothing but an id emits nothing", () => {
    expect(linksFor("Email", { id: "e_1" }, b)).toEqual({});
  });

  it("a null or absent parent emits no parent link", () => {
    expect(linksFor("Mailbox", { id: "mb_1", parentId: null }, b)).not.toHaveProperty("parent");
    expect(linksFor("FileNode", { id: "fn_1", nodeType: "file" }, b)).toEqual({});
  });

  it("only a directory advertises children", () => {
    expect(linksFor("FileNode", { id: "d", nodeType: "directory" }, b)).toHaveProperty("children");
    expect(linksFor("FileNode", { id: "f", nodeType: "file" }, b)).not.toHaveProperty("children");
  });

  it("a collection link is built from the object's OWN id", () => {
    const links = linksFor("AddressBook", { id: "ab_1" }, b);
    expect(links.cards).toEqual({
      href: "/ContactCard?inAddressBook=ab_1",
      type: "ContactCard",
      list: true,
    });
  });

  it("a garbled payload produces no links rather than broken ones", () => {
    for (const junk of [
      {},
      { id: 1 },
      { threadId: 42 },
      { mailboxIds: [] },
      { attachments: "x" },
    ]) {
      expect(flattenLinks(linksFor("Email", junk as Record<string, unknown>, b))).toEqual([]);
    }
    expect(linksFor("Thread", { id: "t", emailIds: [null, 3, ""] }, b)).toEqual({});
  });

  it("an unknown type has no builder, and gets no links", () => {
    expect(linksFor("Widget", { id: "w", threadId: "th_1" }, b)).toEqual({});
  });
});
