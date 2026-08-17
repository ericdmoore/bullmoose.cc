// An in-memory Files realm for the `FakeJmapClient` — the same job
// `lib/calendar/demoCalendar.ts` does for calendars, with the same discipline:
// **mirror the SERVER's semantics, warts included**, because a fake that is
// kinder than the real thing hides exactly the bugs it should catch.
//
// The warts it reproduces on purpose, each with the line it comes from in
// `services/jmap/src/methods/filenode.ts`:
//
//   • `FileNode/queryChanges` throws `cannotCalculateChanges` (:119-121) and
//     `FileNode/query` reports `canCalculateChanges: false` (:180) — so a
//     surface that tried to sync by delta here would fail here too.
//   • a create is refused with `alreadyExists` when a sibling has that name
//     (:232), case-SENSITIVELY unless `compareCaseInsensitively` is passed.
//   • a file create without a `blobId` is `invalidProperties` (:546-552); a
//     directory create WITH one is too (:555-557).
//   • `name` must be 1..255 characters and contain no `/` (:520-523).
//   • server-set properties on a create are rejected outright (:514-518).
//   • an update may not touch `id`, `nodeType`, `size` or the timestamps
//     (`PATCH_REJECTED`, :57-67), and a `parentId` move is cycle-checked
//     (:616-618).
//   • destroying a non-empty directory is `fileNodeHasChildren` unless
//     `onDestroyRemoveChildren` is passed (:285-290).
//   • `FileNode/get { ids: [] }` returns the WHOLE account, because the store
//     treats an empty list as "no filter" (`mailstore:3310-3328`). That is the
//     sharpest one — it is the reason `api.ts` never sends an empty `ids`, and
//     a kind fake would have hidden it.
//
// The one thing it does NOT reproduce: blob existence. `FileNode/set create`
// verifies the blob with `headBlob` before inserting (and that check is what
// PINS it against GC); `FakeJmapClient.upload` mints `blob-N` into a private
// map this module cannot see, so the fake accepts any non-empty blobId. A
// create that would have been `blobNotFound` on the server succeeds here.
//
// ── The fixture ───────────────────────────────────────────────────────────
//
// A small drive with the shape the section has to render: nesting two deep, an
// empty folder, files of wildly different sizes, and — the one that matters —
// an `Attachments` directory carrying `role: "attachments"`, exactly as the
// inbound sidestep mints it (`services/ingest/src/sidestep.ts:46-48`), holding
// files big enough to have crossed the 5 MiB threshold. It is an ORDINARY
// directory in every other respect, which is the claim `demoFiles.test.ts`
// checks: nothing in `lib/files/` special-cases it.

import { FILENODE_CAP } from "../jmap/capabilities";
import { FakeJmapClient, defaultSession, type MethodHandler } from "../jmap/FakeJmapClient";
import type { Session } from "../jmap/types";
import { ATTACHMENTS_ROLE } from "./scope";
import type { FileNode, FileNodeType } from "./types";

const ACCOUNT = "acct-fake";
const MAX_NAME = 255;

/** Owner rights — the only rights the server mints (filenode.ts:44-52). */
const OWNER_RIGHTS = {
  mayRead: true,
  mayAddChildren: true,
  mayRename: true,
  mayDelete: true,
  mayModifyContent: true,
  mayShare: true,
} as const;

const CREATE_REJECTED = ["id", "myRights", "shareWith", "created", "modified", "accessed", "changed"];
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

export interface DemoFilesBackend {
  nodes: FileNode[];
  handlers: Record<string, MethodHandler>;
  state(): string;
}

export interface DemoFilesOptions {
  /** Anchor for the fixture's timestamps. */
  now?: number;
  /**
   * Refuse every write with `forbidden`, as a token without the `files` scope
   * would (filenode.ts:188 → `requireAccount(…, "files", "files")`). The knob
   * exists so the read-only degrade path is DRIVABLE in a browser, not only
   * asserted in a test — same intent as `demo.ts`'s `scopes`.
   */
  canWrite?: boolean;
  /** Refuse every READ with `forbidden`. The other half of the same story. */
  canRead?: boolean;
}

const MB = 1_000_000;

/** The fixture drive. Exported so the test can assert its shape directly. */
export function demoFileNodes(now = Date.now()): FileNode[] {
  const day = 86_400_000;
  const node = (
    id: string,
    parentId: string | null,
    name: string,
    nodeType: FileNodeType,
    extra: Partial<FileNode> = {},
  ): FileNode => {
    const at = new Date(now - (extra.size ? 3 : 9) * day).toISOString();
    return {
      id,
      parentId,
      name,
      nodeType,
      blobId: nodeType === "file" ? `blob-${id}` : null,
      size: null,
      type: nodeType === "directory" ? null : "application/octet-stream",
      created: at,
      modified: at,
      accessed: at,
      changed: at,
      executable: false,
      isSubscribed: true,
      myRights: { ...OWNER_RIGHTS },
      shareWith: null,
      role: null,
      ...extra,
    };
  };

  return [
    // The sidestep's folder. An ordinary directory that happens to carry a role.
    node("fn-attachments", null, "Attachments", "directory", {
      role: ATTACHMENTS_ROLE,
      created: new Date(now - 60 * day).toISOString(),
    }),
    node("fn-att-deck", "fn-attachments", "Q3 board deck.pdf", "file", {
      size: 18 * MB,
      type: "application/pdf",
      modified: new Date(now - 2 * day).toISOString(),
    }),
    node("fn-att-survey", "fn-attachments", "site-survey-raw.zip", "file", {
      size: 41 * MB,
      type: "application/zip",
      modified: new Date(now - 11 * day).toISOString(),
    }),
    // Two names that differ only by case, to prove the case-SENSITIVE
    // collision rule is the one both the fake and the browser apply.
    node("fn-att-notes", "fn-attachments", "notes.txt", "file", {
      size: 4_200,
      type: "text/plain",
    }),

    node("fn-projects", null, "Projects", "directory"),
    node("fn-roadmap", "fn-projects", "2026 roadmap", "directory"),
    node("fn-roadmap-doc", "fn-roadmap", "roadmap.md", "file", {
      size: 24_800,
      type: "text/markdown",
    }),
    node("fn-roadmap-sheet", "fn-roadmap", "budget.csv", "file", {
      size: 91_400,
      type: "text/csv",
    }),
    node("fn-projects-logo", "fn-projects", "logo.png", "file", {
      size: 512_000,
      type: "image/png",
    }),
    // Deliberately empty: the empty-folder state is a real state.
    node("fn-scratch", null, "Scratch", "directory"),

    node("fn-readme", null, "README.txt", "file", { size: 1_100, type: "text/plain" }),
    node("fn-photo", null, "porch-2026.jpeg", "file", { size: 3_400_000, type: "image/jpeg" }),
  ];
}

/** Build the realm. `handlers` attach to a `FakeJmapClient` via `setHandler`. */
export function createDemoFiles(opts: DemoFilesOptions = {}): DemoFilesBackend {
  const now = opts.now ?? Date.now();
  const canWrite = opts.canWrite !== false;
  const canRead = opts.canRead !== false;
  const nodes = demoFileNodes(now);
  let counter = 0;
  let idSeq = 0;
  const state = (): string => String(counter);
  const bump = (): string => String(++counter);

  const forbidden = (scope: string) =>
    ["error", { type: "forbidden", description: `token lacks the "${scope}" scope` }] as ReturnType<MethodHandler>;

  const byId = (id: string): FileNode | undefined => nodes.find((n) => n.id === id);
  const iso = (ms: number): string => new Date(ms).toISOString();

  const descendants = (id: string): FileNode[] => {
    const out: FileNode[] = [];
    const queue = nodes.filter((n) => n.parentId === id);
    const seen = new Set<string>();
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next || seen.has(next.id)) continue;
      seen.add(next.id);
      out.push(next);
      queue.push(...nodes.filter((n) => n.parentId === next.id));
    }
    return out;
  };

  const nameTaken = (parentId: string | null, name: string, ci: boolean, exclude?: string): boolean => {
    const norm = ci ? name.toLowerCase() : name;
    return nodes.some(
      (n) => n.id !== exclude && n.parentId === parentId && (ci ? n.name.toLowerCase() : n.name) === norm,
    );
  };

  const wouldCycle = (nodeId: string, newParentId: string): boolean => {
    let cursor: string | null = newParentId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      if (cursor === nodeId) return true;
      seen.add(cursor);
      cursor = byId(cursor)?.parentId ?? null;
    }
    return false;
  };

  /** `properties` projection, as `pickProps` does server-side (filenode.ts:493). */
  const project = (node: FileNode, properties: unknown): FileNode => {
    if (!Array.isArray(properties)) return node;
    const full = node as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = { id: node.id };
    for (const p of properties as string[]) if (p in full) out[p] = full[p];
    return out as unknown as FileNode;
  };

  const handlers: Record<string, MethodHandler> = {
    "FileNode/get": (args) => {
      if (!canRead) return forbidden("read");
      const ids = args.ids as string[] | null | undefined;
      // The empty-array wart: an empty list is "no filter" on the server.
      const rows = ids && ids.length > 0 ? nodes.filter((n) => ids.includes(n.id)) : nodes.slice();
      const list = [...rows];
      if (args.fetchParents === true) {
        const present = new Set(list.map((n) => n.id));
        for (const row of rows) {
          let pid = row.parentId;
          const seen = new Set<string>();
          while (pid && !seen.has(pid)) {
            seen.add(pid);
            const parent = byId(pid);
            if (!parent) break;
            if (!present.has(parent.id)) {
              present.add(parent.id);
              list.push(parent);
            }
            pid = parent.parentId;
          }
        }
      }
      return {
        accountId: ACCOUNT,
        state: state(),
        list: list.map((n) => project(n, args.properties)),
        notFound: (ids ?? []).filter((id) => !byId(id)),
      };
    },

    "FileNode/query": (args) => {
      if (!canRead) return forbidden("read");
      const filter = (args.filter ?? null) as Record<string, unknown> | null;
      let rows = nodes.slice();
      if (filter) {
        if ("parentId" in filter) rows = rows.filter((n) => n.parentId === (filter.parentId as string | null));
        if ("ancestorId" in filter) {
          const within = new Set(descendants(filter.ancestorId as string).map((n) => n.id));
          rows = rows.filter((n) => within.has(n.id));
        }
        if ("nodeType" in filter) rows = rows.filter((n) => n.nodeType === filter.nodeType);
        if ("role" in filter) rows = rows.filter((n) => n.role === filter.role);
        if ("name" in filter) rows = rows.filter((n) => n.name === filter.name);
        if ("hasBlobId" in filter) rows = rows.filter((n) => (n.blobId !== null) === filter.hasBlobId);
      }
      const sort = (args.sort as Array<{ property: string; isAscending?: boolean }> | undefined) ?? [
        { property: "name", isAscending: true },
      ];
      rows.sort((a, b) => {
        for (const s of sort) {
          const av = (a as unknown as Record<string, unknown>)[s.property] ?? 0;
          const bv = (b as unknown as Record<string, unknown>)[s.property] ?? 0;
          const cmp =
            typeof av === "string" || typeof bv === "string"
              ? String(av).localeCompare(String(bv))
              : (av as number) - (bv as number);
          if (cmp !== 0) return s.isAscending === false ? -cmp : cmp;
        }
        return a.id.localeCompare(b.id);
      });
      const position = typeof args.position === "number" ? args.position : 0;
      const limit = typeof args.limit === "number" ? args.limit : 256;
      return {
        accountId: ACCOUNT,
        queryState: state(),
        canCalculateChanges: false,
        position,
        ids: rows.slice(position, position + limit).map((n) => n.id),
        ...(args.calculateTotal === true ? { total: rows.length } : {}),
      };
    },

    "FileNode/queryChanges": () => ["error", { type: "cannotCalculateChanges" }],

    "FileNode/changes": (args) => ({
      accountId: ACCOUNT,
      oldState: String(args.sinceState ?? "0"),
      newState: state(),
      hasMoreChanges: false,
      created: [],
      updated: [],
      destroyed: [],
    }),

    "FileNode/set": (args) => {
      if (!canWrite) return forbidden("files");
      const oldState = state();
      if (typeof args.ifInState === "string" && args.ifInState !== oldState) {
        return ["error", { type: "stateMismatch" }];
      }
      const ci = args.compareCaseInsensitively === true;
      const removeChildren = args.onDestroyRemoveChildren === true;

      const created: Record<string, Record<string, unknown>> = {};
      const notCreated: Record<string, unknown> = {};
      const updated: Record<string, null> = {};
      const notUpdated: Record<string, unknown> = {};
      const destroyed: string[] = [];
      const notDestroyed: Record<string, unknown> = {};
      let touched = false;

      for (const [cid, rawSpec] of Object.entries(
        (args.create as Record<string, Record<string, unknown>> | undefined) ?? {},
      )) {
        const spec = rawSpec ?? {};
        const rejected = CREATE_REJECTED.find((k) => spec[k] !== undefined);
        if (rejected) {
          notCreated[cid] = {
            type: "invalidProperties",
            description: `${rejected} is server-set`,
            properties: [rejected],
          };
          continue;
        }
        const name = spec.name;
        if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME || name.includes("/")) {
          notCreated[cid] = {
            type: "invalidProperties",
            description: `name must be a 1..${MAX_NAME}-char string without "/"`,
            properties: ["name"],
          };
          continue;
        }
        const nodeType = spec.nodeType;
        if (nodeType !== "file" && nodeType !== "directory" && nodeType !== "symlink") {
          notCreated[cid] = {
            type: "invalidProperties",
            description: 'nodeType must be "file", "directory" or "symlink"',
            properties: ["nodeType"],
          };
          continue;
        }
        const parentId = (spec.parentId ?? null) as string | null;
        if (parentId !== null) {
          const parent = byId(parentId);
          if (!parent) {
            notCreated[cid] = {
              type: "invalidProperties",
              description: "parent does not exist",
              properties: ["parentId"],
            };
            continue;
          }
          if (parent.nodeType !== "directory") {
            notCreated[cid] = {
              type: "invalidProperties",
              description: "parent is not a directory",
              properties: ["parentId"],
            };
            continue;
          }
        }
        if (nodeType === "file" && (typeof spec.blobId !== "string" || spec.blobId.length === 0)) {
          notCreated[cid] = {
            type: "invalidProperties",
            description: "a file requires a blobId",
            properties: ["blobId"],
          };
          continue;
        }
        if (nodeType !== "file" && spec.blobId !== undefined && spec.blobId !== null) {
          notCreated[cid] = {
            type: "invalidProperties",
            description: `${nodeType} nodes cannot carry a blobId`,
            properties: ["blobId"],
          };
          continue;
        }
        if (nameTaken(parentId, name, ci)) {
          notCreated[cid] = {
            type: "alreadyExists",
            description: `a node named "${name}" already exists here`,
            properties: ["name"],
          };
          continue;
        }
        const at = iso(now);
        const row: FileNode = {
          id: `fn-new-${++idSeq}`,
          parentId,
          name,
          nodeType,
          blobId: nodeType === "file" ? (spec.blobId as string) : null,
          size: typeof spec.size === "number" ? spec.size : null,
          type: typeof spec.type === "string" ? spec.type : nodeType === "file" ? "application/octet-stream" : null,
          created: at,
          modified: at,
          accessed: at,
          changed: at,
          executable: spec.executable === true,
          isSubscribed: spec.isSubscribed !== false,
          myRights: { ...OWNER_RIGHTS },
          shareWith: null,
          role: typeof spec.role === "string" ? spec.role : null,
        };
        nodes.push(row);
        touched = true;
        created[cid] = {
          id: row.id,
          blobId: row.blobId,
          size: row.size,
          type: row.type,
          created: at,
          modified: at,
          accessed: at,
          changed: at,
          myRights: { ...OWNER_RIGHTS },
          shareWith: null,
        };
      }

      for (const [id, patch] of Object.entries(
        (args.update as Record<string, Record<string, unknown>> | undefined) ?? {},
      )) {
        const current = byId(id);
        if (!current) {
          notUpdated[id] = { type: "notFound" };
          continue;
        }
        const bad = Object.keys(patch ?? {}).find((p) => PATCH_REJECTED.has(p) || p.includes("/"));
        if (bad) {
          notUpdated[id] = {
            type: "invalidProperties",
            description: `${bad} cannot be set`,
            properties: [bad],
          };
          continue;
        }
        const next: FileNode = { ...current };
        let refusal: Record<string, unknown> | undefined;
        for (const [path, value] of Object.entries(patch ?? {})) {
          if (path === "name") {
            if (typeof value !== "string" || value.length === 0 || value.length > MAX_NAME || value.includes("/")) {
              refusal = {
                type: "invalidProperties",
                description: `name must be a 1..${MAX_NAME}-char string without "/"`,
                properties: ["name"],
              };
              break;
            }
            next.name = value;
          } else if (path === "parentId") {
            if (value !== null && typeof value !== "string") {
              refusal = {
                type: "invalidProperties",
                description: "parentId must be an id or null",
                properties: ["parentId"],
              };
              break;
            }
            if (typeof value === "string") {
              const parent = byId(value);
              if (value === id) {
                refusal = {
                  type: "invalidProperties",
                  description: "a node cannot be its own parent",
                  properties: ["parentId"],
                };
                break;
              }
              if (!parent) {
                refusal = {
                  type: "invalidProperties",
                  description: "parent does not exist",
                  properties: ["parentId"],
                };
                break;
              }
              if (parent.nodeType !== "directory") {
                refusal = {
                  type: "invalidProperties",
                  description: "parent is not a directory",
                  properties: ["parentId"],
                };
                break;
              }
              if (wouldCycle(id, value)) {
                refusal = {
                  type: "invalidProperties",
                  description: "move would create a cycle",
                  properties: ["parentId"],
                };
                break;
              }
            }
            next.parentId = value as string | null;
          } else if (path === "type" || path === "role") {
            next[path] = value as string | null;
          } else if (path === "executable" || path === "isSubscribed") {
            next[path] = value === true;
          } else if (path === "blobId") {
            if (current.nodeType !== "file") {
              refusal = {
                type: "invalidProperties",
                description: "only file nodes have a blob",
                properties: ["blobId"],
              };
              break;
            }
            next.blobId = value as string;
          } else {
            refusal = {
              type: "invalidProperties",
              description: `unsupported patch path "${path}"`,
              properties: [path],
            };
            break;
          }
        }
        if (refusal) {
          notUpdated[id] = refusal;
          continue;
        }
        if (nameTaken(next.parentId, next.name, ci, id)) {
          notUpdated[id] = {
            type: "alreadyExists",
            description: `a node named "${next.name}" already exists here`,
            properties: ["name"],
          };
          continue;
        }
        next.changed = iso(now);
        nodes[nodes.findIndex((n) => n.id === id)] = next;
        touched = true;
        updated[id] = null;
      }

      for (const id of (args.destroy as string[] | undefined) ?? []) {
        const node = byId(id);
        if (!node) {
          notDestroyed[id] = { type: "notFound" };
          continue;
        }
        const kids = descendants(id);
        if (kids.length > 0 && !removeChildren) {
          notDestroyed[id] = {
            type: "fileNodeHasChildren",
            description: "directory is not empty; pass onDestroyRemoveChildren: true to remove it and its contents",
          };
          continue;
        }
        const gone = new Set([id, ...kids.map((n) => n.id)]);
        for (let i = nodes.length - 1; i >= 0; i--) if (gone.has(nodes[i]!.id)) nodes.splice(i, 1);
        touched = true;
        destroyed.push(id);
      }

      return {
        accountId: ACCOUNT,
        oldState,
        newState: touched ? bump() : oldState,
        created,
        notCreated,
        updated,
        notUpdated,
        destroyed,
        notDestroyed,
      };
    },
  };

  return { nodes, handlers, state };
}

/** Attach the realm to a client and hand back the backend for assertions. */
export function installDemoFiles(client: FakeJmapClient, opts: DemoFilesOptions = {}): DemoFilesBackend {
  const backend = createDemoFiles(opts);
  for (const [name, handler] of Object.entries(backend.handlers)) client.setHandler(name, handler);
  return backend;
}

/** A session with the Files capability REMOVED — key presence is the gate, so
 *  removal is the only faithful simulation of a server without the realm. */
export function sessionWithoutFiles(): Session {
  const base = defaultSession();
  const capabilities = { ...base.capabilities };
  delete capabilities[FILENODE_CAP];
  const accounts: Session["accounts"] = {};
  for (const [id, account] of Object.entries(base.accounts)) {
    const accountCapabilities = { ...account.accountCapabilities };
    delete accountCapabilities[FILENODE_CAP];
    accounts[id] = { ...account, accountCapabilities };
  }
  const primaryAccounts = { ...base.primaryAccounts };
  delete primaryAccounts[FILENODE_CAP];
  return { ...base, capabilities, accounts, primaryAccounts };
}

/**
 * What `/files?demo=1` runs against. Two knobs, both there so a REFUSAL PATH is
 * drivable in a browser rather than only asserted in a test — the s03.C T2
 * lesson was that a green suite and a clean build both reported success while
 * the page rendered empty:
 *
 *   `?filecap=0`  — a server with no Files realm at all (the plain-client floor)
 *   `?readonly=1` — a session whose token cannot write (the `files` scope)
 */
export function filesDemoClient(demoClient: FakeJmapClient, search: string): FakeJmapClient {
  const params = new URLSearchParams(search);
  if (params.get("filecap") === "0") {
    // No handlers installed either: a server without the capability has no
    // FileNode methods, and the fake answers `unknownMethod` exactly as one
    // would. The screen must never get that far.
    return new FakeJmapClient({ session: sessionWithoutFiles() });
  }
  installDemoFiles(demoClient, { canWrite: params.get("readonly") !== "1" });
  return demoClient;
}
