import { describe, expect, it } from "vitest";
import { createDemoBackend } from "../jmap/demo";
import {
  buildMailboxTree,
  findByRole,
  flattenTree,
  inboxUnread,
  loadMailboxes,
  moveTargets,
  roleRank,
} from "./mailboxes";
import type { Mailbox } from "./types";

const ACCOUNT = "acct-fake";

function mailbox(partial: Partial<Mailbox> & Pick<Mailbox, "id" | "name">): Mailbox {
  return {
    parentId: null,
    role: null,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {},
    isSubscribed: true,
    ...partial,
  };
}

describe("loadMailboxes", () => {
  it("fetches every mailbox in one call", async () => {
    const { client } = createDemoBackend();
    const list = await loadMailboxes(client, ACCOUNT);
    expect(client.sentBatches).toHaveLength(1);
    expect(client.sentBatches[0]?.[0]?.[1]).toEqual({ accountId: ACCOUNT, ids: null });
    expect(list.map((m) => m.role)).toContain("inbox");
  });

  it("carries live unread counts", async () => {
    const { client } = createDemoBackend();
    const list = await loadMailboxes(client, ACCOUNT);
    const inbox = findByRole(list, "inbox");
    expect(inbox?.totalEmails).toBeGreaterThan(0);
    expect(inboxUnread(list)).toBe(inbox?.unreadEmails);
  });

  it("never renders NaN when a server omits a count", async () => {
    const { client } = createDemoBackend({
      mailboxes: [{ id: "mb", name: "Odd" } as unknown as Mailbox],
    });
    const [only] = await loadMailboxes(client, ACCOUNT);
    expect(only?.unreadEmails).toBe(0);
    expect(only?.myRights).toEqual({});
  });
});

describe("buildMailboxTree", () => {
  it("nests children under their parent and records depth", () => {
    const tree = buildMailboxTree([
      mailbox({ id: "a", name: "Parent" }),
      mailbox({ id: "b", name: "Child", parentId: "a" }),
      mailbox({ id: "c", name: "Grandchild", parentId: "b" }),
    ]);
    expect(tree).toHaveLength(1);
    expect(flattenTree(tree).map((n) => [n.id, n.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("sorts role mailboxes into mail-client order, ahead of user folders", () => {
    const tree = buildMailboxTree([
      mailbox({ id: "u", name: "Aardvark" }),
      mailbox({ id: "t", name: "Trash", role: "trash" }),
      mailbox({ id: "i", name: "Inbox", role: "inbox" }),
      mailbox({ id: "s", name: "Sent", role: "sent" }),
    ]);
    expect(tree.map((n) => n.id)).toEqual(["i", "s", "t", "u"]);
  });

  it("orders user folders by sortOrder then name", () => {
    const tree = buildMailboxTree([
      mailbox({ id: "b", name: "Beta", sortOrder: 5 }),
      mailbox({ id: "a", name: "Alpha", sortOrder: 5 }),
      mailbox({ id: "z", name: "Zulu", sortOrder: 1 }),
    ]);
    expect(tree.map((n) => n.id)).toEqual(["z", "a", "b"]);
  });

  it("promotes an ORPHAN to a root rather than losing the folder", () => {
    // A folder whose parent was not returned must still be reachable — the mail
    // in it is real, and a sidebar that hides it is the worst failure mode.
    const tree = buildMailboxTree([mailbox({ id: "x", name: "Stray", parentId: "missing" })]);
    expect(tree.map((n) => n.id)).toEqual(["x"]);
  });

  it("survives a parent cycle instead of recursing forever", () => {
    const tree = buildMailboxTree([
      mailbox({ id: "a", name: "A", parentId: "b" }),
      mailbox({ id: "b", name: "B", parentId: "a" }),
    ]);
    expect(flattenTree(tree)).toHaveLength(2);
  });

  it("survives a mailbox that is its own parent", () => {
    const tree = buildMailboxTree([mailbox({ id: "a", name: "A", parentId: "a" })]);
    expect(tree.map((n) => n.id)).toEqual(["a"]);
  });

  it("builds the demo account's sidebar with Inbox first", async () => {
    const { client } = createDemoBackend();
    const tree = buildMailboxTree(await loadMailboxes(client, ACCOUNT));
    expect(tree[0]?.role).toBe("inbox");
    expect(tree.at(-1)?.name).toBe("Project Elk");
  });
});

describe("the held mailbox is not a destination in OUR surfaces (s12)", () => {
  it("the sidebar does not list it — a decision replaces the pile", async () => {
    const { client } = createDemoBackend();
    const all = await loadMailboxes(client, ACCOUNT);
    // The server DOES return it: the `junk` role is the registered one, and a
    // standards-native client needs it to apply spam handling. What changes is
    // that we stop presenting it as somewhere to go and look.
    expect(all.map((m) => m.role)).toContain("junk");
    expect(findByRole(all, "junk")?.name).toBe("Quarantined");

    const tree = buildMailboxTree(all);
    expect(tree.map((n) => n.role)).not.toContain("junk");
    expect(flattenTree(tree).map((n) => n.name)).not.toContain("Quarantined");
  });

  it("nor as a move target — a folder you cannot open is a trapdoor", () => {
    const list = [
      mailbox({ id: "in", name: "Inbox", role: "inbox" }),
      mailbox({ id: "q", name: "Quarantined", role: "junk" }),
    ];
    expect(moveTargets(list).map((m) => m.id)).toEqual(["in"]);
  });

  it("a child of it is promoted, not swallowed", () => {
    // The orphan rule doing its job: hiding a folder must never hide mail
    // filed underneath it, which would be unreachable rather than merely
    // unlisted.
    const tree = buildMailboxTree([
      mailbox({ id: "q", name: "Quarantined", role: "junk" }),
      mailbox({ id: "kid", name: "Kept", parentId: "q" }),
    ]);
    expect(tree.map((n) => n.id)).toEqual(["kid"]);
  });
});

describe("roleRank", () => {
  it("ranks known roles ahead of user folders", () => {
    expect(roleRank("inbox")).toBeLessThan(roleRank("trash"));
    expect(roleRank("trash")).toBeLessThan(roleRank(null));
    expect(roleRank("not-a-role")).toBe(roleRank(null));
  });
});

describe("moveTargets", () => {
  it("excludes the mailbox the message is already in", () => {
    const list = [mailbox({ id: "a", name: "A" }), mailbox({ id: "b", name: "B" })];
    expect(moveTargets(list, "a").map((m) => m.id)).toEqual(["b"]);
  });

  it("excludes a mailbox that refuses new items", () => {
    const list = [
      mailbox({ id: "a", name: "A" }),
      mailbox({ id: "ro", name: "ReadOnly", myRights: { mayAddItems: false } }),
    ];
    expect(moveTargets(list).map((m) => m.id)).toEqual(["a"]);
  });
});
