import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { commitChanges, type ChangeEntry } from "@bullmoose/account-do";
import type { FileNodePatch, FileNodeRow, FileNodeType, Mailstore } from "@bullmoose/mailstore";
import { liveSharesForBlob, revokeShareRecord } from "../shares";
import {
  accountState,
  proxyChanges,
  requireAccount,
  setError,
  storeFor,
  type RequestContext,
  type SetError,
} from "./common";

/**
 * FileNode — JMAP for Files (draft-ietf-jmap-filenode-14), sVOL 011 / s03.B.
 *
 * The inode metadata layer over the EXISTING R2 blob path: the tree lives in
 * D1 (`file_nodes`), content bytes stay in R2, and there is no new storage
 * code. This module owns the WRITE CHOREOGRAPHY (`_context.md` §3) — Mailstore
 * is a thin data layer that maintains no invariants, so sibling-name
 * uniqueness (`onExists`, case-insensitive on request), cycle rejection,
 * `onDestroyRemoveChildren`, and the AccountDO `commitChanges(collection:
 * "FileNode")` all live here. Skip the commit and the row lands, reads back on
 * a direct `get`, and is invisible to `/changes`.
 *
 * Auth: "Files is not special." Reads gate on `("read","files")`, writes on
 * `("files","files")` — the same flat-scope convention as calendar/contacts
 * (`_context.md` §4; common/027). A `files`-only token can therefore WRITE but
 * not READ, exactly like the other realms; fixing that is common/027's open
 * cross-cutting decision, not this unit's.
 *
 * Sharing is deferred to the ACL/"teams" epic: `shareWith` is always `null`
 * and `myRights` is always owner rights (`arch.md` §4, invariant 4).
 *
 * ⚠️ 010 obligation: destroying a file node whose blob has live share links
 * REVOKES them (`revokeShareRecord`) — a `FileNode/set {destroy}` does not
 * travel the blob-delete route, so without this the share-link leak 010 warned
 * about survives (`_context.md` §2 footnote 12).
 */

const NODE_TYPES = new Set<FileNodeType>(["file", "directory", "symlink"]);

/** Owner rights — the only rights this slice mints (sharing deferred). */
const OWNER_RIGHTS = {
  mayRead: true,
  mayAddChildren: true,
  mayRename: true,
  mayDelete: true,
  mayModifyContent: true,
  mayShare: true,
} as const;

/** Server-set / immutable on a create spec. */
const CREATE_REJECTED = [
  "id",
  "myRights",
  "shareWith",
  "created",
  "modified",
  "accessed",
  "changed",
];
/** Patch paths that can never be set on update. */
const PATCH_REJECTED = new Set([
  "id",
  "nodeType",
  "created",
  "modified",
  "accessed",
  "changed",
  "myRights",
  "shareWith",
  "size",
]);

const MAX_NAME = 255;

export function registerFileNodeMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("FileNode/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read", "files");
    const store = storeFor(ctx);

    const ids = args.ids === null || args.ids === undefined ? undefined : (args.ids as string[]);
    const rows = await store.getFileNodes(access.accountId, ids);
    const found = new Set(rows.map((r) => r.id));

    let list = rows;
    // fetchParents (draft §FileNode/get): also return the ancestor chain of
    // each requested node, so a client can render a breadcrumb in one round trip.
    if (args.fetchParents === true) {
      const all = await store.getFileNodes(access.accountId);
      const byId = new Map(all.map((n) => [n.id, n]));
      const present = new Set(rows.map((r) => r.id));
      const extra: FileNodeRow[] = [];
      for (const r of rows) {
        let pid = r.parentId;
        const seen = new Set<string>(); // guard against a corrupt cycle
        while (pid && !seen.has(pid)) {
          seen.add(pid);
          const p = byId.get(pid);
          if (!p) break;
          if (!present.has(p.id)) {
            present.add(p.id);
            extra.push(p);
          }
          pid = p.parentId;
        }
      }
      list = [...rows, ...extra];
    }

    const properties = Array.isArray(args.properties) ? (args.properties as string[]) : null;
    return {
      accountId: access.accountId,
      state: await accountState(ctx, access.accountId),
      list: list.map((r) => pickProps(nodeToJmap(r), properties)),
      notFound: (ids ?? []).filter((id) => !found.has(id)),
    };
  });

  registry.register("FileNode/changes", async (args, ctx) => proxyChanges(ctx, args, "FileNode"));

  // Consistent with the other four collections: canCalculateChanges is false,
  // so queryChanges is an always-throw stub rather than a lie that returns an
  // empty delta (`_context.md` §1).
  registry.register("FileNode/queryChanges", async () => {
    throw new MethodError("cannotCalculateChanges");
  });

  registry.register("FileNode/query", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read", "files");
    const store = storeFor(ctx);

    const filter = validateFilter(args.filter);
    const sort = validateSort(args.sort);
    const position = typeof args.position === "number" ? args.position : 0;
    const limit = typeof args.limit === "number" ? args.limit : undefined;

    let ids: string[];
    let total: number | undefined;
    if (filter?.ancestorId !== undefined) {
      // Depth recursion (draft §FileNode/query): every transitive descendant of
      // an ancestor, filtered + sorted in memory. The other filters still apply.
      const all = await store.getFileNodes(access.accountId);
      const byParent = new Map<string | null, FileNodeRow[]>();
      for (const n of all) {
        const arr = byParent.get(n.parentId) ?? [];
        arr.push(n);
        byParent.set(n.parentId, arr);
      }
      const out: FileNodeRow[] = [];
      const queue = [...(byParent.get(filter.ancestorId) ?? [])];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const n = queue.shift()!;
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        if (matchesFilter(n, filter)) out.push(n);
        queue.push(...(byParent.get(n.id) ?? []));
      }
      sortNodes(out, sort);
      total = out.length;
      ids = out
        .slice(position, limit !== undefined ? position + limit : undefined)
        .map((n) => n.id);
    } else {
      const res = await store.queryFileNodes(access.accountId, {
        filter: filter
          ? {
              ...(filter.parentId !== undefined ? { parentId: filter.parentId } : {}),
              ...(filter.nodeType !== undefined ? { nodeType: filter.nodeType } : {}),
              ...(filter.role !== undefined ? { role: filter.role } : {}),
              ...(filter.name !== undefined ? { name: filter.name } : {}),
              ...(filter.hasBlobId !== undefined ? { hasBlobId: filter.hasBlobId } : {}),
            }
          : null,
        sort,
        position,
        ...(limit !== undefined ? { limit } : {}),
        calculateTotal: args.calculateTotal === true,
      });
      ids = res.ids;
      total = res.total;
    }

    return {
      accountId: access.accountId,
      queryState: await accountState(ctx, access.accountId),
      canCalculateChanges: false,
      position,
      ids,
      ...(args.calculateTotal === true ? { total: total ?? 0 } : {}),
    };
  });

  registry.register("FileNode/set", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "files", "files");
    const store = storeFor(ctx);

    const oldState = await accountState(ctx, access.accountId);
    if (typeof args.ifInState === "string" && args.ifInState !== oldState) {
      throw new MethodError("stateMismatch");
    }

    const compareCI = args.compareCaseInsensitively === true;
    const onDestroyRemoveChildren = args.onDestroyRemoveChildren === true;

    // The whole account tree, once — the shared substrate for onExists
    // (siblings), cycle checks (ancestor walk) and onDestroyRemoveChildren
    // (descendant walk). `byId` is kept in sync as we mutate.
    const byId = new Map((await store.getFileNodes(access.accountId)).map((n) => [n.id, n]));

    const created: Record<string, Record<string, unknown>> = {};
    const notCreated: Record<string, SetError> = {};
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, SetError> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, SetError> = {};
    const fnEntry: ChangeEntry = {
      collection: "FileNode",
      created: [],
      updated: [],
      destroyed: [],
    };

    const nameTaken = (parentId: string | null, name: string, excludeId?: string): boolean => {
      const norm = compareCI ? name.toLowerCase() : name;
      for (const n of byId.values()) {
        if (n.id === excludeId || n.parentId !== parentId) continue;
        if ((compareCI ? n.name.toLowerCase() : n.name) === norm) return true;
      }
      return false;
    };

    const revokeSharesFor = async (blobId: string | null): Promise<void> => {
      if (!blobId) return;
      const live = await liveSharesForBlob(ctx.env.ROUTES, access.accountId, blobId);
      for (const s of live) await revokeShareRecord(ctx.env.ROUTES, access.accountId, s.shareId);
    };

    // -- create --
    const createSpecs = (args.create as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [cid, spec] of Object.entries(createSpecs)) {
      try {
        const row = await buildNewNode(spec, store, access.tenantId, access.accountId, byId);
        if (nameTaken(row.parentId, row.name)) {
          throw new SetErrorSignal(
            "alreadyExists",
            `a node named "${row.name}" already exists here`,
            ["name"],
          );
        }
        await store.insertFileNode(access.accountId, row);
        byId.set(row.id, row);
        fnEntry.created.push(row.id);
        created[cid] = {
          id: row.id,
          blobId: row.blobId,
          size: row.size,
          type: row.type,
          created: iso(row.created),
          modified: iso(row.modified),
          accessed: iso(row.accessed),
          changed: iso(row.changed),
          myRights: OWNER_RIGHTS,
          shareWith: null,
        };
      } catch (err) {
        notCreated[cid] = toSetError(err);
      }
    }

    // -- update --
    const updateSpecs = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [id, patch] of Object.entries(updateSpecs)) {
      try {
        const cur = byId.get(id);
        if (!cur) throw new NotFound();
        const p = await validatePatch(patch, cur, store, access.tenantId, access.accountId, byId);

        const newParent = p.parentId !== undefined ? p.parentId : cur.parentId;
        const newName = p.name !== undefined ? p.name : cur.name;
        if (
          (p.name !== undefined || p.parentId !== undefined) &&
          nameTaken(newParent, newName, id)
        ) {
          throw new SetErrorSignal(
            "alreadyExists",
            `a node named "${newName}" already exists here`,
            ["name"],
          );
        }

        p.changed = Date.now();
        await store.updateFileNode(access.accountId, id, p);
        byId.set(id, applyPatch(cur, p));
        fnEntry.updated.push(id);
        updated[id] = null;
      } catch (err) {
        notUpdated[id] = toSetError(err);
      }
    }

    // -- destroy --
    for (const id of (args.destroy as string[] | undefined) ?? []) {
      try {
        const node = byId.get(id);
        if (!node) throw new NotFound();
        const descendants = collectDescendants(id, byId);
        if (descendants.length > 0 && !onDestroyRemoveChildren) {
          throw new SetErrorSignal(
            "fileNodeHasChildren",
            "directory is not empty; pass onDestroyRemoveChildren: true to remove it and its contents",
          );
        }
        const toRemove = [node, ...descendants];
        // 010 obligation: revoke any live share links for every removed file's
        // blob BEFORE the row is gone, or the public link outlives the file.
        for (const n of toRemove) if (n.nodeType === "file") await revokeSharesFor(n.blobId);
        await store.deleteFileNodes(
          access.accountId,
          toRemove.map((n) => n.id),
        );
        for (const n of toRemove) byId.delete(n.id);
        fnEntry.destroyed.push(...toRemove.map((n) => n.id));
        destroyed.push(id);
      } catch (err) {
        notDestroyed[id] = toSetError(err);
      }
    }

    const newState = await commitFileNodeEntry(ctx, access.accountId, fnEntry);
    return {
      accountId: access.accountId,
      oldState,
      newState,
      created,
      notCreated,
      updated,
      notUpdated,
      destroyed,
      notDestroyed,
    };
  });

  registry.register("FileNode/copy", async (args, ctx) => {
    const fromAccountId = args.fromAccountId;
    if (typeof fromAccountId !== "string") {
      throw new MethodError("invalidArguments", "fromAccountId is required");
    }
    // Source needs read; target needs the files write scope. requireAccount
    // reads args.accountId for the target.
    const fromAccess = await requireAccount(ctx, { accountId: fromAccountId }, "read", "files");
    const toAccess = await requireAccount(ctx, args, "files", "files");
    const store = storeFor(ctx);

    const oldState = await accountState(ctx, toAccess.accountId);
    if (typeof args.ifFromInState === "string") {
      const fromState = await accountState(ctx, fromAccess.accountId);
      if (args.ifFromInState !== fromState) throw new MethodError("stateMismatch");
    }
    if (typeof args.ifInState === "string" && args.ifInState !== oldState) {
      throw new MethodError("stateMismatch");
    }

    const created: Record<string, Record<string, unknown>> = {};
    const notCreated: Record<string, SetError> = {};
    const fnEntry: ChangeEntry = {
      collection: "FileNode",
      created: [],
      updated: [],
      destroyed: [],
    };

    const targetById = new Map(
      (await store.getFileNodes(toAccess.accountId)).map((n) => [n.id, n]),
    );
    const nameTaken = (parentId: string | null, name: string): boolean => {
      for (const n of targetById.values())
        if (n.parentId === parentId && n.name === name) return true;
      return false;
    };

    const sourceDestroyIds: string[] = [];
    const createSpecs = (args.create as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [cid, spec] of Object.entries(createSpecs)) {
      try {
        const srcId = spec.id;
        if (typeof srcId !== "string") {
          throw new SetErrorSignal("invalidProperties", "each copy needs the source node id", [
            "id",
          ]);
        }
        const [src] = await store.getFileNodes(fromAccess.accountId, [srcId]);
        if (!src) throw new SetErrorSignal("notFound", `no such source node: ${srcId}`);

        const name = typeof spec.name === "string" ? spec.name : src.name;
        const parentId =
          spec.parentId === null ? null : typeof spec.parentId === "string" ? spec.parentId : null;
        if (parentId !== null) {
          const np = targetById.get(parentId);
          if (!np)
            throw new SetErrorSignal("invalidProperties", "target parent does not exist", [
              "parentId",
            ]);
          if (np.nodeType !== "directory") {
            throw new SetErrorSignal("invalidProperties", "target parent is not a directory", [
              "parentId",
            ]);
          }
        }
        if (nameTaken(parentId, name)) {
          throw new SetErrorSignal("alreadyExists", `a node named "${name}" already exists here`, [
            "name",
          ]);
        }

        // For files, copy the bytes into the TARGET account's R2 prefix.
        // putBlob is content-addressed, so the blobId is preserved; the point
        // is that download resolves under the target account, not the source.
        let blobId = src.blobId;
        if (src.nodeType === "file" && src.blobId) {
          const obj = await store.getBlob(fromAccess.tenantId, fromAccess.accountId, src.blobId);
          if (!obj) throw new SetErrorSignal("blobNotFound", "source blob is missing");
          blobId = await store.putBlob(
            toAccess.tenantId,
            toAccess.accountId,
            await obj.arrayBuffer(),
          );
        }

        const now = Date.now();
        const row: FileNodeRow = {
          id: `fn_${crypto.randomUUID()}`,
          parentId,
          name,
          nodeType: src.nodeType,
          blobId,
          size: src.size,
          type: src.type,
          created: now,
          modified: now,
          accessed: now,
          changed: now,
          executable: src.executable,
          isSubscribed: src.isSubscribed,
          role: null, // roles are account-structural — a copy does not inherit one
        };
        await store.insertFileNode(toAccess.accountId, row);
        targetById.set(row.id, row);
        fnEntry.created.push(row.id);
        created[cid] = {
          id: row.id,
          blobId: row.blobId,
          created: iso(now),
          modified: iso(now),
          accessed: iso(now),
          changed: iso(now),
          myRights: OWNER_RIGHTS,
          shareWith: null,
        };
        if (args.onSuccessDestroyOriginal === true) sourceDestroyIds.push(srcId);
      } catch (err) {
        notCreated[cid] = toSetError(err);
      }
    }

    const newState = await commitFileNodeEntry(ctx, toAccess.accountId, fnEntry);

    // onSuccessDestroyOriginal: route the source destroys back through
    // FileNode/set so they honour the SAME revoke-aware path (010) and commit
    // on the source account's changelog. Reported to the client via /changes.
    if (sourceDestroyIds.length > 0) {
      const setHandler = registry.get("FileNode/set")!;
      await setHandler(
        {
          accountId: fromAccess.accountId,
          destroy: sourceDestroyIds,
          onDestroyRemoveChildren: true,
        },
        ctx,
      );
    }

    return {
      fromAccountId: fromAccess.accountId,
      accountId: toAccess.accountId,
      oldState,
      newState,
      created,
      notCreated,
    };
  });
}

// ---- helpers ---------------------------------------------------------------

class NotFound extends Error {}

class SetErrorSignal extends Error {
  constructor(
    public type: string,
    public description?: string,
    public properties?: string[],
  ) {
    super(description ?? type);
  }
}

function toSetError(err: unknown): SetError {
  if (err instanceof NotFound) return setError("notFound");
  if (err instanceof SetErrorSignal) {
    return {
      type: err.type,
      ...(err.description ? { description: err.description } : {}),
      ...(err.properties ? { properties: err.properties } : {}),
    };
  }
  if (err instanceof MethodError) return setError("invalidProperties", err.description ?? err.type);
  return setError("serverFail", String(err));
}

const iso = (ms: number): string => new Date(ms).toISOString();

function nodeToJmap(r: FileNodeRow): Record<string, unknown> {
  return {
    id: r.id,
    parentId: r.parentId,
    name: r.name,
    nodeType: r.nodeType,
    blobId: r.blobId,
    size: r.size,
    type: r.type,
    created: iso(r.created),
    modified: iso(r.modified),
    accessed: iso(r.accessed),
    changed: iso(r.changed),
    executable: r.executable,
    isSubscribed: r.isSubscribed,
    myRights: OWNER_RIGHTS,
    shareWith: null,
    role: r.role,
  };
}

function pickProps(
  full: Record<string, unknown>,
  properties: string[] | null,
): Record<string, unknown> {
  if (!properties) return full;
  const picked: Record<string, unknown> = { id: full.id };
  for (const p of properties) if (p in full) picked[p] = full[p];
  return picked;
}

/**
 * Validate a create spec into a row. Verifies the blob exists for files (which
 * PINS it) and derives size/type from R2 when the client omits them.
 */
async function buildNewNode(
  spec: Record<string, unknown>,
  store: Mailstore,
  tenantId: string,
  accountId: string,
  byId: Map<string, FileNodeRow>,
): Promise<FileNodeRow> {
  for (const k of CREATE_REJECTED) {
    if (spec[k] !== undefined) {
      throw new SetErrorSignal("invalidProperties", `${k} is server-set`, [k]);
    }
  }

  const name = spec.name;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAX_NAME ||
    name.includes("/")
  ) {
    throw new SetErrorSignal(
      "invalidProperties",
      `name must be a 1..${MAX_NAME}-char string without "/"`,
      ["name"],
    );
  }

  const nodeType = spec.nodeType;
  if (typeof nodeType !== "string" || !NODE_TYPES.has(nodeType as FileNodeType)) {
    throw new SetErrorSignal(
      "invalidProperties",
      'nodeType must be "file", "directory" or "symlink"',
      ["nodeType"],
    );
  }

  let parentId: string | null = null;
  if (spec.parentId !== undefined && spec.parentId !== null) {
    if (typeof spec.parentId !== "string") {
      throw new SetErrorSignal("invalidProperties", "parentId must be an id or null", ["parentId"]);
    }
    const parent = byId.get(spec.parentId);
    if (!parent)
      throw new SetErrorSignal("invalidProperties", "parent does not exist", ["parentId"]);
    if (parent.nodeType !== "directory") {
      throw new SetErrorSignal("invalidProperties", "parent is not a directory", ["parentId"]);
    }
    parentId = spec.parentId;
  }

  let blobId: string | null = null;
  let size: number | null = typeof spec.size === "number" ? spec.size : null;
  let type: string | null = typeof spec.type === "string" ? spec.type : null;
  if (nodeType === "file") {
    if (typeof spec.blobId !== "string" || spec.blobId.length === 0) {
      throw new SetErrorSignal("invalidProperties", "a file requires a blobId", ["blobId"]);
    }
    const head = await store.headBlob(tenantId, accountId, spec.blobId);
    if (!head) throw new SetErrorSignal("blobNotFound", `no such blob: ${spec.blobId}`, ["blobId"]);
    blobId = spec.blobId;
    if (size === null) size = head.size;
    if (type === null) type = "application/octet-stream";
  } else if (spec.blobId !== undefined && spec.blobId !== null) {
    throw new SetErrorSignal("invalidProperties", `${nodeType} nodes cannot carry a blobId`, [
      "blobId",
    ]);
  }

  const now = Date.now();
  return {
    id: `fn_${crypto.randomUUID()}`,
    parentId,
    name,
    nodeType: nodeType as FileNodeType,
    blobId,
    size,
    type,
    created: now,
    modified: now,
    accessed: now,
    changed: now,
    executable: spec.executable === true,
    isSubscribed: spec.isSubscribed !== false,
    role: typeof spec.role === "string" ? spec.role : null,
  };
}

/**
 * RFC 8620 §5.3-ish shallow patch. FileNode patches are flat (no nested
 * pointers in this slice); a `parentId` change is cycle-checked and a `blobId`
 * change re-verifies the blob and bumps `modified`.
 */
async function validatePatch(
  patch: Record<string, unknown>,
  cur: FileNodeRow,
  store: Mailstore,
  tenantId: string,
  accountId: string,
  byId: Map<string, FileNodeRow>,
): Promise<FileNodePatch> {
  const out: FileNodePatch = {};
  for (const [path, value] of Object.entries(patch)) {
    if (PATCH_REJECTED.has(path) || path.includes("/")) {
      throw new SetErrorSignal("invalidProperties", `${path} cannot be set`, [path]);
    }
    switch (path) {
      case "name":
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > MAX_NAME ||
          value.includes("/")
        ) {
          throw new SetErrorSignal(
            "invalidProperties",
            `name must be a 1..${MAX_NAME}-char string without "/"`,
            ["name"],
          );
        }
        out.name = value;
        break;
      case "parentId": {
        if (value !== null && typeof value !== "string") {
          throw new SetErrorSignal("invalidProperties", "parentId must be an id or null", [
            "parentId",
          ]);
        }
        if (value !== null) {
          if (value === cur.id) {
            throw new SetErrorSignal("invalidProperties", "a node cannot be its own parent", [
              "parentId",
            ]);
          }
          const np = byId.get(value);
          if (!np)
            throw new SetErrorSignal("invalidProperties", "parent does not exist", ["parentId"]);
          if (np.nodeType !== "directory") {
            throw new SetErrorSignal("invalidProperties", "parent is not a directory", [
              "parentId",
            ]);
          }
          if (wouldCycle(cur.id, value, byId)) {
            throw new SetErrorSignal("invalidProperties", "move would create a cycle", [
              "parentId",
            ]);
          }
        }
        out.parentId = value;
        break;
      }
      case "blobId": {
        if (cur.nodeType !== "file") {
          throw new SetErrorSignal("invalidProperties", "only file nodes have a blob", ["blobId"]);
        }
        if (typeof value !== "string" || value.length === 0) {
          throw new SetErrorSignal("invalidProperties", "blobId must be a non-empty id", [
            "blobId",
          ]);
        }
        const head = await store.headBlob(tenantId, accountId, value);
        if (!head) throw new SetErrorSignal("blobNotFound", `no such blob: ${value}`, ["blobId"]);
        out.blobId = value;
        out.size = head.size;
        out.modified = Date.now();
        break;
      }
      case "type":
        if (value !== null && typeof value !== "string") {
          throw new SetErrorSignal("invalidProperties", "type must be a string or null", ["type"]);
        }
        out.type = value as string | null;
        break;
      case "executable":
        if (typeof value !== "boolean") {
          throw new SetErrorSignal("invalidProperties", "executable must be a boolean", [
            "executable",
          ]);
        }
        out.executable = value;
        break;
      case "isSubscribed":
        if (typeof value !== "boolean") {
          throw new SetErrorSignal("invalidProperties", "isSubscribed must be a boolean", [
            "isSubscribed",
          ]);
        }
        out.isSubscribed = value;
        break;
      case "role":
        if (value !== null && typeof value !== "string") {
          throw new SetErrorSignal("invalidProperties", "role must be a string or null", ["role"]);
        }
        out.role = value as string | null;
        break;
      default:
        throw new SetErrorSignal("invalidProperties", `unsupported patch path "${path}"`, [path]);
    }
  }
  return out;
}

function applyPatch(cur: FileNodeRow, p: FileNodePatch): FileNodeRow {
  return {
    ...cur,
    ...(p.parentId !== undefined ? { parentId: p.parentId } : {}),
    ...(p.name !== undefined ? { name: p.name } : {}),
    ...(p.blobId !== undefined ? { blobId: p.blobId } : {}),
    ...(p.size !== undefined ? { size: p.size } : {}),
    ...(p.type !== undefined ? { type: p.type } : {}),
    ...(p.executable !== undefined ? { executable: p.executable } : {}),
    ...(p.isSubscribed !== undefined ? { isSubscribed: p.isSubscribed } : {}),
    ...(p.role !== undefined ? { role: p.role } : {}),
    ...(p.modified !== undefined ? { modified: p.modified } : {}),
    ...(p.changed !== undefined ? { changed: p.changed } : {}),
  };
}

/** Would re-parenting `nodeId` under `newParentId` put nodeId on its own
 * ancestor chain? Walks up from the new parent. */
function wouldCycle(nodeId: string, newParentId: string, byId: Map<string, FileNodeRow>): boolean {
  let pid: string | null = newParentId;
  const seen = new Set<string>();
  while (pid && !seen.has(pid)) {
    if (pid === nodeId) return true;
    seen.add(pid);
    pid = byId.get(pid)?.parentId ?? null;
  }
  return false;
}

/** Every transitive descendant of `id` (not including `id` itself). */
function collectDescendants(id: string, byId: Map<string, FileNodeRow>): FileNodeRow[] {
  const byParent = new Map<string | null, FileNodeRow[]>();
  for (const n of byId.values()) {
    const arr = byParent.get(n.parentId) ?? [];
    arr.push(n);
    byParent.set(n.parentId, arr);
  }
  const out: FileNodeRow[] = [];
  const queue = [...(byParent.get(id) ?? [])];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    queue.push(...(byParent.get(n.id) ?? []));
  }
  return out;
}

interface FileNodeQueryFilter {
  parentId?: string | null;
  ancestorId?: string;
  nodeType?: FileNodeType;
  role?: string;
  name?: string;
  hasBlobId?: boolean;
}

function validateFilter(raw: unknown): FileNodeQueryFilter | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object")
    throw new MethodError("unsupportedFilter", "filter must be an object");
  const f = raw as Record<string, unknown>;
  const allowed = new Set(["parentId", "ancestorId", "nodeType", "role", "name", "hasBlobId"]);
  for (const k of Object.keys(f)) {
    if (!allowed.has(k))
      throw new MethodError("unsupportedFilter", `unknown filter property "${k}"`);
  }
  const out: FileNodeQueryFilter = {};
  if ("parentId" in f) {
    if (f.parentId !== null && typeof f.parentId !== "string") {
      throw new MethodError("unsupportedFilter", "parentId must be an id or null");
    }
    out.parentId = f.parentId as string | null;
  }
  if ("ancestorId" in f) {
    if (typeof f.ancestorId !== "string")
      throw new MethodError("unsupportedFilter", "ancestorId must be an id");
    out.ancestorId = f.ancestorId;
  }
  if ("nodeType" in f) {
    if (typeof f.nodeType !== "string" || !NODE_TYPES.has(f.nodeType as FileNodeType)) {
      throw new MethodError("unsupportedFilter", "nodeType must be file|directory|symlink");
    }
    out.nodeType = f.nodeType as FileNodeType;
  }
  if ("role" in f) {
    if (typeof f.role !== "string")
      throw new MethodError("unsupportedFilter", "role must be a string");
    out.role = f.role;
  }
  if ("name" in f) {
    if (typeof f.name !== "string")
      throw new MethodError("unsupportedFilter", "name must be a string");
    out.name = f.name;
  }
  if ("hasBlobId" in f) {
    if (typeof f.hasBlobId !== "boolean")
      throw new MethodError("unsupportedFilter", "hasBlobId must be a boolean");
    out.hasBlobId = f.hasBlobId;
  }
  return out;
}

function matchesFilter(n: FileNodeRow, f: FileNodeQueryFilter): boolean {
  if (f.nodeType !== undefined && n.nodeType !== f.nodeType) return false;
  if (f.role !== undefined && n.role !== f.role) return false;
  if (f.name !== undefined && n.name !== f.name) return false;
  if (f.hasBlobId !== undefined && (n.blobId !== null) !== f.hasBlobId) return false;
  return true;
}

type FileNodeSort = Array<{
  property: "name" | "created" | "modified" | "changed" | "size";
  isAscending: boolean;
}>;

function validateSort(raw: unknown): FileNodeSort | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new MethodError("unsupportedSort", "sort must be an array");
  const props = new Set(["name", "created", "modified", "changed", "size"]);
  return raw.map((s) => {
    const property = (s as { property?: unknown }).property;
    if (typeof property !== "string" || !props.has(property)) {
      throw new MethodError("unsupportedSort", `unsupported sort property "${String(property)}"`);
    }
    return {
      property: property as FileNodeSort[number]["property"],
      isAscending: (s as { isAscending?: unknown }).isAscending !== false,
    };
  });
}

function sortNodes(nodes: FileNodeRow[], sort: FileNodeSort | undefined): void {
  const spec = sort && sort.length > 0 ? sort : [{ property: "name" as const, isAscending: true }];
  nodes.sort((a, b) => {
    for (const s of spec) {
      const av = a[s.property] ?? 0;
      const bv = b[s.property] ?? 0;
      let cmp: number;
      if (typeof av === "string" || typeof bv === "string")
        cmp = String(av).localeCompare(String(bv));
      else cmp = (av as number) - (bv as number);
      if (cmp !== 0) return s.isAscending ? cmp : -cmp;
    }
    return a.id.localeCompare(b.id);
  });
}

async function commitFileNodeEntry(
  ctx: RequestContext,
  accountId: string,
  entry: ChangeEntry,
): Promise<string> {
  if (entry.created.length + entry.updated.length + entry.destroyed.length === 0) {
    return accountState(ctx, accountId);
  }
  const { newState } = await commitChanges(ctx.env.ACCOUNT_DO, accountId, [entry]);
  return newState;
}
