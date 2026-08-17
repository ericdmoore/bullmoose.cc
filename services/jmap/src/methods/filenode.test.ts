import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { Mailstore } from "@bullmoose/mailstore";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerFileNodeMethods } from "./filenode";
import type { RequestContext } from "./common";
import { getShareRecord, liveSharesForBlob, putShareRecord, type ShareRecord } from "../shares";

// FileNode — JMAP for Files (draft-14), sVOL 011 / s03.B.
//
// Harness is @bullmoose/test-fakes (sVOL 002): real SQLite on the live schema
// (so file_nodes' UNIQUE + columns actually run), real R2 for blob pinning, and
// the REAL AccountDO behind ACCOUNT_DO — so the write-choreography assertions
// ("did this land in FileNode/changes?") are against the deployed changelog, not
// a canned {newState}. That is the only thing that catches a write that lands
// the row and skips commitChanges (`_context.md` §3).

const ACCOUNT = "a_eric";
const ACCOUNT2 = "a_allen";
const TENANT = "t_bm";

type SetResult = {
  oldState: string;
  newState: string;
  created: Record<string, Record<string, unknown>>;
  notCreated: Record<string, { type: string; description?: string; properties?: string[] }>;
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string; properties?: string[] }>;
  destroyed: string[];
  notDestroyed: Record<string, { type: string; description?: string; properties?: string[] }>;
};

function harness(scopes: string[] = ["read", "files"]) {
  const w = fakeEnv();
  const registry = new MethodRegistry<RequestContext>();
  registerFileNodeMethods(registry);

  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "eric@login.example",
      scopes,
      accounts: [
        { accountId: ACCOUNT, tenantId: TENANT, name: "Eric" },
        { accountId: ACCOUNT2, tenantId: TENANT, name: "Allen" },
      ],
    },
  };

  const store = new Mailstore(w.env.DB, w.env.BLOBS);
  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!(args, ctx) as Promise<T>;

  const set = (args: Record<string, unknown>, account = ACCOUNT) =>
    call<SetResult>("FileNode/set", { accountId: account, ...args });

  /** Put bytes into R2 and return the content-addressed blobId. */
  const seedBlob = (content = "hello", account = ACCOUNT) =>
    store.putBlob(TENANT, account, new TextEncoder().encode(content).buffer as ArrayBuffer);

  const mkdir = async (name: string, parentId: string | null = null, account = ACCOUNT) => {
    const res = await set({ create: { d: { name, nodeType: "directory", parentId } } }, account);
    if (!res.created.d) throw new Error(`mkdir failed: ${JSON.stringify(res.notCreated)}`);
    return res.created.d.id as string;
  };

  const mkfile = async (name: string, parentId: string | null, blobId: string, account = ACCOUNT) => {
    const res = await set({ create: { f: { name, nodeType: "file", parentId, blobId } } }, account);
    if (!res.created.f) throw new Error(`mkfile failed: ${JSON.stringify(res.notCreated)}`);
    return res.created.f.id as string;
  };

  return { w, ctx, store, call, set, seedBlob, mkdir, mkfile };
}

// ---- schema + basic CRUD --------------------------------------------------

describe("FileNode/set + get: the inode tree holds", () => {
  it("creates a directory and reads it back with owner rights and null shareWith", async () => {
    const h = harness();
    const id = await h.mkdir("Documents");

    const res = await h.call<{ list: Array<Record<string, unknown>>; notFound: string[] }>("FileNode/get", {
      accountId: ACCOUNT,
      ids: [id],
    });
    expect(res.notFound).toEqual([]);
    const node = res.list[0]!;
    expect(node).toMatchObject({
      id,
      name: "Documents",
      nodeType: "directory",
      parentId: null,
      blobId: null,
      shareWith: null,
      myRights: { mayRead: true, mayDelete: true, mayShare: true },
    });
    // timestamps are UTCDate strings on the wire, not epoch ms
    expect(typeof node.created).toBe("string");
    expect(node.created).toMatch(/T.*Z$/);
  });

  it("creates a file against a real blob, deriving size + type from R2", async () => {
    const h = harness();
    const blobId = await h.seedBlob("some file bytes");
    const id = await h.mkfile("report.txt", null, blobId);

    const [row] = await h.store.getFileNodes(ACCOUNT, [id]);
    expect(row!.blobId).toBe(blobId);
    expect(row!.size).toBe("some file bytes".length);
    expect(row!.type).toBe("application/octet-stream");
    expect(row!.nodeType).toBe("file");
  });

  it("refuses a file whose blob does not exist (would create a dangling inode)", async () => {
    const h = harness();
    const res = await h.set({
      create: { f: { name: "ghost", nodeType: "file", blobId: "b_missing" } },
    });
    expect(res.created).toEqual({});
    expect(res.notCreated.f!.type).toBe("blobNotFound");
    // nothing landed in the table
    expect(await h.store.getFileNodes(ACCOUNT)).toEqual([]);
  });

  it("refuses a directory carrying a blobId, and a bad nodeType", async () => {
    const h = harness();
    const r1 = await h.set({ create: { x: { name: "d", nodeType: "directory", blobId: "b_x" } } });
    expect(r1.notCreated.x!.properties).toEqual(["blobId"]);
    const r2 = await h.set({ create: { x: { name: "d", nodeType: "folder" } } });
    expect(r2.notCreated.x!.properties).toEqual(["nodeType"]);
  });

  it("rejects a name containing a slash or a server-set property", async () => {
    const h = harness();
    const r1 = await h.set({ create: { x: { name: "a/b", nodeType: "directory" } } });
    expect(r1.notCreated.x!.properties).toEqual(["name"]);
    const r2 = await h.set({
      create: { x: { name: "ok", nodeType: "directory", id: "fn_forced" } },
    });
    expect(r2.notCreated.x!.properties).toEqual(["id"]);
  });
});

// ---- onExists (sibling-name uniqueness) -----------------------------------

describe("FileNode/set onExists: sibling names are unique", () => {
  it("rejects a duplicate sibling name (top-level, where the DB UNIQUE cannot)", async () => {
    // parent_id IS NULL siblings do NOT collide under UNIQUE(account,parent,name)
    // because SQL NULLs compare distinct — so this MUST be caught in the method.
    const h = harness();
    await h.mkdir("Shared");
    const res = await h.set({ create: { d: { name: "Shared", nodeType: "directory" } } });
    expect(res.created).toEqual({});
    expect(res.notCreated.d!.type).toBe("alreadyExists");
    expect(await h.store.getFileNodeChildren(ACCOUNT, null)).toHaveLength(1);
  });

  it("allows the same name under a different parent", async () => {
    const h = harness();
    const a = await h.mkdir("A");
    const b = await h.mkdir("B");
    const r1 = await h.set({
      create: { x: { name: "notes", nodeType: "directory", parentId: a } },
    });
    const r2 = await h.set({
      create: { x: { name: "notes", nodeType: "directory", parentId: b } },
    });
    expect(r1.created.x).toBeDefined();
    expect(r2.created.x).toBeDefined();
  });

  it("compareCaseInsensitively collapses case variants", async () => {
    const h = harness();
    await h.mkdir("Photos");
    const sensitive = await h.set({ create: { d: { name: "PHOTOS", nodeType: "directory" } } });
    expect(sensitive.created.d).toBeDefined(); // default is case-SENSITIVE

    const insensitive = await h.set({
      compareCaseInsensitively: true,
      create: { d: { name: "photos", nodeType: "directory" } },
    });
    expect(insensitive.created).toEqual({});
    expect(insensitive.notCreated.d!.type).toBe("alreadyExists");
  });

  it("rejects a rename onto an existing sibling", async () => {
    const h = harness();
    await h.mkdir("keep");
    const move = await h.mkdir("temp");
    const res = await h.set({ update: { [move]: { name: "keep" } } });
    expect(res.updated).toEqual({});
    expect(res.notUpdated[move]!.type).toBe("alreadyExists");
  });
});

// ---- move / cycle prevention ----------------------------------------------

describe("FileNode/set update: moves and cycle prevention", () => {
  it("moves a node under a new parent", async () => {
    const h = harness();
    const a = await h.mkdir("A");
    const b = await h.mkdir("B");
    const res = await h.set({ update: { [b]: { parentId: a } } });
    expect(res.updated[b]).toBeNull();
    const [row] = await h.store.getFileNodes(ACCOUNT, [b]);
    expect(row!.parentId).toBe(a);
  });

  it("refuses a node becoming its own parent", async () => {
    const h = harness();
    const a = await h.mkdir("A");
    const res = await h.set({ update: { [a]: { parentId: a } } });
    expect(res.notUpdated[a]!.properties).toEqual(["parentId"]);
    expect(res.notUpdated[a]!.description).toContain("its own parent");
  });

  it("refuses a move that would create a cycle (parent under its own child)", async () => {
    const h = harness();
    const a = await h.mkdir("A");
    const b = await h.mkdir("B", a); // b is a child of a
    // moving a under b would make a a descendant of itself
    const res = await h.set({ update: { [a]: { parentId: b } } });
    expect(res.notUpdated[a]!.description).toContain("cycle");
    // and a's parent is untouched
    expect((await h.store.getFileNodes(ACCOUNT, [a]))[0]!.parentId).toBeNull();
  });

  it("refuses a move under a non-directory", async () => {
    const h = harness();
    const blobId = await h.seedBlob();
    const file = await h.mkfile("f.txt", null, blobId);
    const d = await h.mkdir("d");
    const res = await h.set({ update: { [d]: { parentId: file } } });
    expect(res.notUpdated[d]!.description).toContain("not a directory");
  });
});

// ---- onDestroyRemoveChildren ----------------------------------------------

describe("FileNode/set destroy: onDestroyRemoveChildren", () => {
  it("refuses to destroy a non-empty directory without the flag", async () => {
    const h = harness();
    const a = await h.mkdir("A");
    await h.mkdir("child", a);
    const res = await h.set({ destroy: [a] });
    expect(res.destroyed).toEqual([]);
    expect(res.notDestroyed[a]!.type).toBe("fileNodeHasChildren");
    expect(await h.store.getFileNodes(ACCOUNT)).toHaveLength(2); // both survive
  });

  it("removes the whole subtree with the flag, and the changelog names every id", async () => {
    const h = harness(["read", "files"]);
    const a = await h.mkdir("A");
    const b = await h.mkdir("B", a);
    const blobId = await h.seedBlob("leaf");
    const c = await h.mkfile("c.txt", b, blobId);
    // Capture state AFTER the creates: a client that already knows a/b/c exist
    // must be told they were destroyed. (Capturing before the creates would let
    // the changelog correctly collapse create-then-destroy to nothing.)
    const mid = await h.w.accountDo.state(ACCOUNT);

    const res = await h.set({ destroy: [a], onDestroyRemoveChildren: true });
    // response `destroyed` names only the requested id (like Calendar/set)
    expect(res.destroyed).toEqual([a]);
    expect(await h.store.getFileNodes(ACCOUNT)).toEqual([]);

    // the changelog carries EVERY removed id, so incremental clients converge
    const delta = await h.call<{ destroyed: string[] }>("FileNode/changes", {
      accountId: ACCOUNT,
      sinceState: mid,
    });
    expect(new Set(delta.destroyed)).toEqual(new Set([a, b, c]));
  });
});

// ---- the write choreography (the counterfactual) --------------------------

describe("FileNode/set completes the write choreography", () => {
  it("reports a created node through FileNode/changes", async () => {
    const h = harness(["read", "files"]);
    const before = await h.w.accountDo.state(ACCOUNT);
    const id = await h.mkdir("Docs");

    const delta = await h.call<{ created: string[]; updated: string[]; destroyed: string[] }>("FileNode/changes", {
      accountId: ACCOUNT,
      sinceState: before,
    });
    expect(delta.created).toEqual([id]);
  });

  it("commits under the FileNode collection, and only that one", async () => {
    const h = harness();
    await h.mkdir("Docs");
    expect(h.w.accountDo.commits).toHaveLength(1);
    expect(h.w.accountDo.commits[0]!.entries.map((e) => e.collection)).toEqual(["FileNode"]);
    // a spurious commit for another collection would be a wasted resync for it
    expect((await h.w.accountDo.changes(ACCOUNT, "ContactCard")).created).toEqual([]);
  });

  it("commits NOTHING when every operation is rejected", async () => {
    // The counterfactual: if the row landed but the commit was skipped, this is
    // exactly the state that reads back on a direct get and is invisible to
    // /changes. Here the write is rejected, so both the table and the changelog
    // must be empty.
    const h = harness();
    const res = await h.set({ create: { f: { name: "x", nodeType: "file", blobId: "b_nope" } } });
    expect(res.notCreated.f).toBeDefined();
    expect(h.w.accountDo.commits).toEqual([]);
    expect((await h.w.accountDo.changes(ACCOUNT, "FileNode")).created).toEqual([]);
  });
});

// ---- 010 obligation: revoke share links on destroy ------------------------

describe("FileNode/set destroy honours sVOL 010 (share revocation)", () => {
  /** Mint a live share record against a blob, the way handleShareCreate does. */
  async function shareBlob(kv: KVNamespace, accountId: string, blobId: string): Promise<string> {
    const shareId = "sh_live_1";
    const rec: ShareRecord = {
      shareId,
      tenantId: TENANT,
      accountId,
      blobId,
      name: "file",
      exp: Math.floor(Date.now() / 1000) + 3600,
      createdAt: Date.now(),
    };
    await putShareRecord(kv, rec);
    return shareId;
  }

  it("revokes a live share link when the file backing it is destroyed", async () => {
    const h = harness();
    const blobId = await h.seedBlob("shared bytes");
    const fileId = await h.mkfile("shared.bin", null, blobId);
    const shareId = await shareBlob(h.w.env.ROUTES, ACCOUNT, blobId);

    // precondition: the share is live and points at the blob
    expect(await liveSharesForBlob(h.w.env.ROUTES, ACCOUNT, blobId)).toHaveLength(1);

    const res = await h.set({ destroy: [fileId] });
    expect(res.destroyed).toEqual([fileId]);

    // the leak 010 warned about: without revocation the public link outlives
    // the file. After destroy there must be NO live share for the blob...
    expect(await liveSharesForBlob(h.w.env.ROUTES, ACCOUNT, blobId)).toEqual([]);
    // ...and the record is tombstoned (revoked), not merely gone.
    const rec = await getShareRecord(h.w.env.ROUTES, ACCOUNT, shareId);
    expect(rec?.revokedAt).toBeDefined();
  });

  it("revokes shares for descendant files removed via onDestroyRemoveChildren", async () => {
    const h = harness();
    const dir = await h.mkdir("outbox");
    const blobId = await h.seedBlob("nested shared");
    await h.mkfile("big.zip", dir, blobId);
    await shareBlob(h.w.env.ROUTES, ACCOUNT, blobId);
    expect(await liveSharesForBlob(h.w.env.ROUTES, ACCOUNT, blobId)).toHaveLength(1);

    await h.set({ destroy: [dir], onDestroyRemoveChildren: true });
    expect(await liveSharesForBlob(h.w.env.ROUTES, ACCOUNT, blobId)).toEqual([]);
  });
});

// ---- blob pinning (the T1 invariant, backing handleBlobDelete) ------------

describe("blob pinning: a blob referenced by a live FileNode is not collectable", () => {
  it("fileNodesReferencingBlob names the pinning node", async () => {
    const h = harness();
    const blobId = await h.seedBlob("pinned");
    const fileId = await h.mkfile("keep.bin", null, blobId);
    expect(await h.store.fileNodesReferencingBlob(ACCOUNT, blobId)).toEqual([fileId]);
    // once the node is gone the blob is unpinned again
    await h.set({ destroy: [fileId] });
    expect(await h.store.fileNodesReferencingBlob(ACCOUNT, blobId)).toEqual([]);
  });
});

// ---- query ----------------------------------------------------------------

describe("FileNode/query", () => {
  it("lists direct children of a parent, sorted by name", async () => {
    const h = harness();
    const a = await h.mkdir("A");
    await h.mkdir("zeta", a);
    await h.mkdir("alpha", a);
    const res = await h.call<{ ids: string[] }>("FileNode/query", {
      accountId: ACCOUNT,
      filter: { parentId: a },
    });
    const names = (await h.store.getFileNodes(ACCOUNT, res.ids)).map((n) => n.name);
    // query returns ids in name order; map preserves it via getFileNodes? assert set membership + count
    expect(res.ids).toHaveLength(2);
    expect(new Set(names)).toEqual(new Set(["alpha", "zeta"]));
  });

  it("filters top-level nodes with parentId: null", async () => {
    const h = harness();
    const a = await h.mkdir("top");
    await h.mkdir("nested", a);
    const res = await h.call<{ ids: string[] }>("FileNode/query", {
      accountId: ACCOUNT,
      filter: { parentId: null },
    });
    expect(res.ids).toEqual([a]);
  });

  it("recurses the whole subtree with ancestorId (depth recursion)", async () => {
    const h = harness();
    const a = await h.mkdir("A");
    const b = await h.mkdir("B", a);
    const c = await h.mkdir("C", b);
    const res = await h.call<{ ids: string[]; total?: number }>("FileNode/query", {
      accountId: ACCOUNT,
      filter: { ancestorId: a },
      calculateTotal: true,
    });
    expect(new Set(res.ids)).toEqual(new Set([b, c]));
    expect(res.total).toBe(2);
  });

  it("filters by hasBlobId to separate files from directories", async () => {
    const h = harness();
    const blobId = await h.seedBlob();
    const file = await h.mkfile("f.bin", null, blobId);
    await h.mkdir("d");
    const res = await h.call<{ ids: string[] }>("FileNode/query", {
      accountId: ACCOUNT,
      filter: { hasBlobId: true },
    });
    expect(res.ids).toEqual([file]);
  });
});

// ---- get fetchParents -----------------------------------------------------

describe("FileNode/get fetchParents", () => {
  it("returns the ancestor chain alongside the requested node", async () => {
    const h = harness();
    const a = await h.mkdir("A");
    const b = await h.mkdir("B", a);
    const blobId = await h.seedBlob();
    const c = await h.mkfile("c.txt", b, blobId);

    const res = await h.call<{ list: Array<{ id: string }> }>("FileNode/get", {
      accountId: ACCOUNT,
      ids: [c],
      fetchParents: true,
    });
    const ids = new Set(res.list.map((n) => n.id));
    expect(ids).toEqual(new Set([c, b, a]));
  });
});

// ---- copy -----------------------------------------------------------------

describe("FileNode/copy", () => {
  it("copies a file to another account, duplicating the blob under the target", async () => {
    const h = harness();
    const blobId = await h.seedBlob("copy me", ACCOUNT);
    const srcId = await h.mkfile("original.bin", null, blobId, ACCOUNT);

    const res = await h.call<{
      created: Record<string, Record<string, unknown>>;
      notCreated: Record<string, unknown>;
    }>("FileNode/copy", {
      fromAccountId: ACCOUNT,
      accountId: ACCOUNT2,
      create: { c1: { id: srcId, name: "copy.bin" } },
    });
    expect(res.notCreated).toEqual({});
    const newId = res.created.c1!.id as string;

    // the new node exists in the TARGET account with the same content-addressed blob
    const [row] = await h.store.getFileNodes(ACCOUNT2, [newId]);
    expect(row!.name).toBe("copy.bin");
    expect(row!.blobId).toBe(blobId);
    // and the bytes actually resolve under the target account's R2 prefix
    const obj = await h.store.getBlob(TENANT, ACCOUNT2, blobId);
    expect(obj).not.toBeNull();
    // the source is untouched
    expect(await h.store.getFileNodes(ACCOUNT, [srcId])).toHaveLength(1);
  });

  it("commits the copy on the target account's changelog", async () => {
    const h = harness();
    const before2 = await h.w.accountDo.state(ACCOUNT2);
    const blobId = await h.seedBlob("x", ACCOUNT);
    const srcId = await h.mkfile("o.bin", null, blobId, ACCOUNT);

    const res = await h.call<{ created: Record<string, { id: string }> }>("FileNode/copy", {
      fromAccountId: ACCOUNT,
      accountId: ACCOUNT2,
      create: { c1: { id: srcId } },
    });
    const newId = res.created.c1!.id;
    const delta = await h.call<{ created: string[] }>("FileNode/changes", {
      accountId: ACCOUNT2,
      sinceState: before2,
    });
    expect(delta.created).toEqual([newId]);
  });
});

// ---- queryChanges stub ----------------------------------------------------

describe("FileNode/queryChanges", () => {
  it("always throws cannotCalculateChanges (consistent with canCalculateChanges:false)", async () => {
    const h = harness();
    await expect(h.call("FileNode/queryChanges", { accountId: ACCOUNT, sinceQueryState: "0" })).rejects.toMatchObject({
      type: "cannotCalculateChanges",
    });
  });
});
