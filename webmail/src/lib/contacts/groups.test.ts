import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { loadCards } from "./cards";
import { installContactsDemo } from "./demo";
import {
  GROUP_KIND,
  GROUP_SYNC_CAVEAT,
  NOT_LOADED_REFUSAL,
  NO_UID_REFUSAL,
  addMemberPatch,
  addMembersPatch,
  describeGroupAdd,
  groupCreateSpec,
  groupsContainingFilter,
  isGroup,
  isMember,
  loadGroupMembers,
  loadGroupsContaining,
  memberUids,
  membersFilter,
  planGroupAdd,
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

// ── s34: bulk membership ───────────────────────────────────────────────────
//
// The cheap half of the bulk bar. Adding N contacts to a group writes ONE
// card, because membership lives on the group — so what needs testing is not
// batching (there is none to do) but the TRANSLATION: the list speaks `id`,
// membership speaks `uid`, and that is where a contact can quietly go missing
// between "I ticked it" and "it is in the group".

describe("addMembersPatch — many members, one patch", () => {
  it("writes the whole map for a group that has none, declaring kind with it", () => {
    expect(addMembersPatch({}, ["urn:uuid:a", "urn:uuid:b"])).toEqual({
      members: { "urn:uuid:a": true, "urn:uuid:b": true },
      kind: "group",
    });
  });

  it("uses PATH patches once the group has members, so a concurrent add survives", () => {
    const { elk } = withDemo();
    expect(addMembersPatch(elk(), ["urn:uuid:ada", "urn:uuid:zoe"])).toEqual({
      "members/urn:uuid:ada": true,
      "members/urn:uuid:zoe": true,
    });
  });

  it("escapes pointer-reserved characters in every uid, not just the first", () => {
    expect(addMembersPatch({ members: { seed: true } }, ["http://x.test/c/1", "a/b"])).toEqual({
      "members/http:~1~1x.test~1c~11": true,
      "members/a~1b": true,
    });
  });

  it("drops uids already in the group — the caller reports those as members, not additions", () => {
    const { elk } = withDemo();
    expect(addMembersPatch(elk(), ["urn:uuid:grace", "urn:uuid:ada"])).toEqual({
      "members/urn:uuid:ada": true,
    });
  });

  it("an all-redundant add is an EMPTY patch, which saveCardEdit treats as nothing to do", () => {
    const { elk } = withDemo();
    expect(addMembersPatch(elk(), ["urn:uuid:grace"])).toEqual({});
    expect(addMembersPatch({}, [])).toEqual({});
  });

  it("de-duplicates within one call", () => {
    expect(addMembersPatch({ members: { seed: true } }, ["urn:uuid:a", "urn:uuid:a"])).toEqual({
      "members/urn:uuid:a": true,
    });
  });

  it("the single-member helper is the same function, so the two cannot drift", () => {
    const { elk } = withDemo();
    expect(addMemberPatch(elk(), "urn:uuid:ada")).toEqual(addMembersPatch(elk(), ["urn:uuid:ada"]));
  });
});

describe("planGroupAdd — every selected id lands in exactly one bucket", () => {
  const cards: ContactCard[] = [
    { id: "cc-ada", uid: "urn:uuid:ada", name: { full: "Ada" } },
    { id: "cc-grace", uid: "urn:uuid:grace", name: { full: "Grace" } },
    { id: "cc-nouid", name: { full: "Imported Person" } },
    { id: "cc-blank", uid: "", name: { full: "Blank Uid" } },
  ];
  const group = { members: { "urn:uuid:grace": true } };

  it("splits into add / already / refused, accounting for every id", () => {
    const ids = ["cc-ada", "cc-grace", "cc-nouid", "cc-gone"];
    const plan = planGroupAdd(cards, ids, group);
    expect(plan.add).toEqual([{ id: "cc-ada", uid: "urn:uuid:ada" }]);
    expect(plan.already).toEqual(["cc-grace"]);
    expect(plan.refused.map((r) => r.id)).toEqual(["cc-nouid", "cc-gone"]);
    expect(plan.add.length + plan.already.length + plan.refused.length).toBe(ids.length);
  });

  it("REFUSES a card with no uid rather than silently skipping it", () => {
    // uid is server-set and immutable (contacts.ts:466-468), so there is no
    // uid to mint here — but telling someone their contact joined a group
    // when it did not is the failure this whole design exists to prevent.
    const plan = planGroupAdd(cards, ["cc-nouid", "cc-blank"], group);
    expect(plan.add).toEqual([]);
    expect(plan.refused).toEqual([
      { id: "cc-nouid", message: NO_UID_REFUSAL },
      { id: "cc-blank", message: NO_UID_REFUSAL },
    ]);
  });

  it("refuses an id that is no longer loaded — reachable after a partial-failure re-query", () => {
    expect(planGroupAdd(cards, ["cc-vanished"], group).refused).toEqual([
      { id: "cc-vanished", message: NOT_LOADED_REFUSAL },
    ]);
  });

  it("de-duplicates, so a repeated id is not double-counted", () => {
    const plan = planGroupAdd(cards, ["cc-ada", "cc-ada"], group);
    expect(plan.add).toHaveLength(1);
  });

  it("an EMPTY group has nobody already in it", () => {
    const plan = planGroupAdd(cards, ["cc-ada", "cc-grace"], {});
    expect(plan.add).toHaveLength(2);
    expect(plan.already).toEqual([]);
  });
});

describe("describeGroupAdd — the outcome names the group and the leftovers", () => {
  const named = (id: string) => ({ "cc-ada": "Ada Lovelace", "cc-nouid": "Imported Person" })[id] ?? id;

  it("names the destination, so two adds to two groups cannot read identically", () => {
    expect(describeGroupAdd("Family", { done: ["a", "b"], failed: [], already: [] })).toBe(
      "Added 2 contacts to “Family”.",
    );
    expect(describeGroupAdd("Work", { done: ["a"], failed: [], already: [] })).toBe("Added 1 contact to “Work”.");
  });

  it("reports both sides and names what was refused, with the reason", () => {
    const said = describeGroupAdd(
      "Family",
      { done: ["cc-ada"], failed: [{ id: "cc-nouid", message: NO_UID_REFUSAL }], already: [] },
      named,
    );
    expect(said).toContain("Added 1 of 2 contacts to “Family”.");
    expect(said).toContain("1 could not be added");
    expect(said).toContain(`Imported Person (${NO_UID_REFUSAL})`);
  });

  it("says out loud how many were already members, rather than rounding them into the count", () => {
    const said = describeGroupAdd("Family", { done: ["a", "b", "c"], failed: [], already: ["b", "c"] });
    expect(said).toContain("Added 3 contacts to “Family”.");
    expect(said).toContain("2 were already a member.");
    expect(describeGroupAdd("Family", { done: ["a"], failed: [], already: ["a"] })).toContain("One was already");
  });

  it("a total failure says nothing was added, and to where", () => {
    const said = describeGroupAdd("Family", {
      done: [],
      failed: [{ id: "cc-x", message: "the server refused" }],
      already: [],
    });
    expect(said).toContain("No contacts were added to “Family”.");
    expect(said).not.toMatch(/^Added/);
  });
});

describe("a bulk add really is ONE write", () => {
  it("adds many members with a single ContactCard/set update of the group card", async () => {
    const { client, backend, elk } = withDemo();
    const before = client.sentBatches.length;

    await updateCard(client, "acct-fake", "cc-elk", addMembersPatch(elk(), ["urn:uuid:ada", "urn:uuid:new"]));

    // One call — and, more to the point, the MEMBER cards were never written.
    expect(client.sentBatches.length - before).toBe(1);
    const after = backend.cards.find((c) => c.id === "cc-elk")!;
    expect(memberUids(after)).toContain("urn:uuid:ada");
    expect(memberUids(after)).toContain("urn:uuid:new");
    // …and the member that was already there survived the path patches.
    expect(memberUids(after)).toContain("urn:uuid:grace");
  });

  it("creates a group WITH its members in one call, so a memberless moment never exists", () => {
    const spec = groupCreateSpec("Carriers", ["urn:uuid:a", "urn:uuid:b"], "ab-personal");
    expect(spec).toMatchObject({
      kind: "group",
      members: { "urn:uuid:a": true, "urn:uuid:b": true },
      addressBookIds: { "ab-personal": true },
    });
  });
});
