import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { loadCards } from "./cards";
import { installContactsDemo } from "./demo";
import {
  GROUP_KIND,
  GROUP_SYNC_CAVEAT,
  addMemberPatch,
  groupCreateSpec,
  groupsContainingFilter,
  isGroup,
  isMember,
  loadGroupMembers,
  loadGroupsContaining,
  memberUids,
  membersFilter,
  removeMemberPatch,
} from "./groups";
import type { ContactCard } from "./types";
import { updateCard } from "./write";

const withDemo = () => {
  const client = new FakeJmapClient();
  const backend = installContactsDemo(client);
  const elk = () => backend.cards.find((c) => c.id === "cc-elk")!;
  return { client, backend, elk };
};

describe("what a group IS on this server", () => {
  it("is a card with kind:group, not an address book", () => {
    const { elk } = withDemo();
    expect(isGroup(elk())).toBe(true);
    expect(isGroup({ kind: "individual" })).toBe(false);
    expect(isGroup({})).toBe(false);
    expect(GROUP_KIND).toBe("group");
  });

  it("keys members by UID, never by JMAP id", () => {
    // The distinction that is easy to get wrong: `ContactCard/get` addresses
    // cards by `id` (`cc_…`), membership speaks `uid` (`urn:uuid:…`), and
    // `hasMember` matches the KEY of `$.members` (mailstore:1791-1794).
    const { elk } = withDemo();
    const uids = memberUids(elk());
    expect(uids).toContain("urn:uuid:grace");
    expect(uids.every((u) => u.startsWith("urn:uuid:"))).toBe(true);
    expect(uids.some((u) => u.startsWith("cc-"))).toBe(false);
    expect(isMember(elk(), "urn:uuid:grace")).toBe(true);
    expect(isMember(elk(), "cc-grace")).toBe(false);
  });

  it("ignores a false value, because only `true` is membership", () => {
    expect(memberUids({ members: { a: true, b: false } })).toEqual(["a"]);
    expect(memberUids({})).toEqual([]);
  });
});

describe("membership patches", () => {
  it("writes the whole map for the FIRST member, because the path has no parent", () => {
    // `applyCardPatch` throws `patch path "members/x" does not exist` when the
    // parent object is absent (contacts.ts:988-996).
    const patch = addMemberPatch({}, "urn:uuid:new");
    expect(patch).toEqual({ members: { "urn:uuid:new": true }, kind: "group" });
  });

  it("does not re-declare kind on a card that is already a group", () => {
    expect(addMemberPatch({ kind: "group" }, "urn:uuid:new")).toEqual({
      members: { "urn:uuid:new": true },
    });
  });

  it("uses a single path for later members, so it cannot clobber a concurrent add", () => {
    const { elk } = withDemo();
    expect(addMemberPatch(elk(), "urn:uuid:ada")).toEqual({ "members/urn:uuid:ada": true });
  });

  it("escapes a uid that contains pointer-reserved characters", () => {
    const group = { members: { a: true, b: true } };
    expect(addMemberPatch(group, "http://x.test/c/1")).toEqual({
      "members/http:~1~1x.test~1c~11": true,
    });
    expect(removeMemberPatch(group, "http://x.test/c/1")).toEqual({
      "members/http:~1~1x.test~1c~11": null,
    });
  });

  it("removes one member with a path patch", () => {
    const { elk } = withDemo();
    expect(removeMemberPatch(elk(), "urn:uuid:grace")).toEqual({
      "members/urn:uuid:grace": null,
    });
  });

  it("drops the whole property when the LAST member goes", () => {
    // `{}` is not a shape RFC 9553 defines; `kind: "group"` is what keeps an
    // emptied group a group.
    expect(removeMemberPatch({ members: { only: true } }, "only")).toEqual({ members: null });
  });

  it("builds a new group with kind and members set together", () => {
    expect(groupCreateSpec("  Elk  ", ["urn:uuid:a"], "ab-work")).toEqual({
      kind: "group",
      name: { full: "Elk" },
      members: { "urn:uuid:a": true },
      addressBookIds: { "ab-work": true },
    });
    expect(groupCreateSpec("Empty")).toEqual({ kind: "group", name: { full: "Empty" } });
  });
});

describe("resolving membership against the server", () => {
  it("looks members up by uid, because /get cannot", () => {
    expect(membersFilter([])).toBeNull();
    expect(membersFilter(["a"])).toEqual({ uid: "a" });
    expect(membersFilter(["a", "b"])).toEqual({
      operator: "OR",
      conditions: [{ uid: "a" }, { uid: "b" }],
    });
  });

  it("returns members in the group's own order and reports dangling uids", async () => {
    // Destroying a card does not clean up the groups naming it
    // (contacts.ts:499-511), so a dangling member is a reachable state and
    // hiding it would hide the only thing the user can act on.
    const { client, elk } = withDemo();
    const { members, missing } = await loadGroupMembers(client, "acct-fake", elk());
    expect(members.map((m) => m.uid)).toEqual(["urn:uuid:grace", "urn:uuid:katherine"]);
    expect(missing).toEqual(["urn:uuid:departed"]);
  });

  it("does not call the server for an empty group", async () => {
    const { client } = withDemo();
    const result = await loadGroupMembers(client, "acct-fake", {});
    expect(result).toEqual({ members: [], missing: [] });
    expect(client.sentBatches).toHaveLength(0);
  });

  it("asks the server which groups contain a card, rather than scanning them here", async () => {
    const { client } = withDemo();
    expect(groupsContainingFilter("urn:uuid:grace")).toEqual({ hasMember: "urn:uuid:grace" });
    const groups = await loadGroupsContaining(client, "acct-fake", "urn:uuid:grace");
    expect(groups.map((g) => g.id)).toEqual(["cc-elk"]);
    expect(await loadGroupsContaining(client, "acct-fake", "urn:uuid:ada")).toEqual([]);
  });

  it("round-trips an added member through the real patch path", async () => {
    const { client, elk } = withDemo();
    const result = await updateCard(client, "acct-fake", "cc-elk", addMemberPatch(elk(), "urn:uuid:ada"));
    expect(result.error).toBeUndefined();
    expect(memberUids(elk())).toContain("urn:uuid:ada");

    const groups = await loadGroupsContaining(client, "acct-fake", "urn:uuid:ada");
    expect(groups.map((g) => g.id)).toEqual(["cc-elk"]);
  });

  it("round-trips a removed member, and the group survives losing its last one", async () => {
    const { client, backend } = withDemo();
    const lone: ContactCard = {
      id: "cc-lone",
      uid: "urn:uuid:lone",
      kind: "group",
      name: { full: "Lone" },
      members: { "urn:uuid:ada": true },
      addressBookIds: { "ab-work": true },
    };
    backend.cards.push(lone);
    await updateCard(client, "acct-fake", "cc-lone", removeMemberPatch(lone, "urn:uuid:ada"));
    const after = backend.cards.find((c) => c.id === "cc-lone")!;
    expect(after.members).toBeUndefined();
    expect(isGroup(after)).toBe(true);
  });

  it("finds groups as cards of kind group, since that is all they are", async () => {
    const { client } = withDemo();
    const page = await loadCards(client, "acct-fake", { filter: { kind: "group" } });
    expect(page.cards.map((c) => c.id)).toEqual(["cc-elk"]);
  });
});

describe("the CardDAV gap is stated, not hidden", () => {
  it("names both directions and points at the converter", () => {
    // contacts-core parses KIND (index.ts:447) but has NO member case, so
    // member lines fall into the verbatim vCardProps tail (index.ts:466); and
    // serializeVcard emits neither KIND nor MEMBER (index.ts:704 is the only
    // kind-ish output). Verified by grep, both directions.
    expect(GROUP_SYNC_CAVEAT).toContain("contacts-core");
    expect(GROUP_SYNC_CAVEAT).toMatch(/MEMBER/);
    expect(GROUP_SYNC_CAVEAT).toMatch(/Apple Contacts/);
    expect(GROUP_SYNC_CAVEAT).toMatch(/Cards themselves round-trip/);
  });
});
