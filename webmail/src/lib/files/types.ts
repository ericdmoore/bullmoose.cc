// The Files wire shapes, as the SERVER actually returns them.
//
// Source of truth: `services/jmap/src/methods/filenode.ts` — `nodeToJmap`
// (:472-491) is the projection every `FileNode/get` row goes through, and it is
// the ONLY shape this section may assume. Mirrored here by hand for the same
// reason `../contacts/types.ts` and `../mail/types.ts` are: `@bullmoose/mailstore`
// is Worker source and cannot be dragged into a DOM/Preact bundle.
//
// Three facts about this collection that shape everything in `lib/files/`:
//
//  1. **A directory is an ordinary node.** `nodeType` is the whole distinction
//     — there is no separate collection, no `isFolder`, and the `Attachments`
//     folder the inbound sidestep files into (`services/ingest/src/sidestep.ts`)
//     is just a directory carrying `role: "attachments"`. The browser must
//     render it as a normal folder, because that is what it is.
//  2. **The tree is `parentId` chains and nothing else.** There is no `path`
//     property on the wire. A breadcrumb is DERIVED (`tree.ts`), which is why
//     `FileNode/get` has `fetchParents` — one round trip for the ancestors.
//  3. **`myRights` is always owner rights and `shareWith` is always `null`**
//     (filenode.ts:44-52, and the module header: "sharing is deferred to the
//     ACL/teams epic"). So rights here are NOT the honest per-object gate they
//     are in contacts — reading them as one would be reading a constant. What
//     actually refuses a write is the token's `files` scope, method-level.

/** Rights as `FileNode/get` computes them — currently always `OWNER_RIGHTS`. */
export interface FileNodeRights {
  mayRead: boolean;
  mayAddChildren: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  mayModifyContent: boolean;
  mayShare: boolean;
}

export type FileNodeType = "file" | "directory" | "symlink";

/** One node, as `FileNode/get` returns it (filenode.ts `nodeToJmap`). */
export interface FileNode {
  id: string;
  /** `null` = top level. The only parent pointer that exists. */
  parentId: string | null;
  name: string;
  nodeType: FileNodeType;
  /** R2 key. Files always have one (the server refuses a file without); directories never do. */
  blobId: string | null;
  /** Bytes. Server-derived from R2 when a create omits it. */
  size: number | null;
  /** IANA media type. Defaults to `application/octet-stream` on the server. */
  type: string | null;
  /** ISO 8601, all four. */
  created: string;
  modified: string;
  accessed: string;
  changed: string;
  executable: boolean;
  isSubscribed: boolean;
  myRights: FileNodeRights;
  shareWith: Record<string, FileNodeRights> | null;
  /**
   * Structural marker. `"attachments"` is the one the system mints today
   * (`ATTACHMENTS_ROLE`, sidestep.ts:46); a copy never inherits one
   * (filenode.ts:398).
   */
  role: string | null;
}

/** What `FileNode/set` says when it refuses ONE object (RFC 8620 §5.3). */
export interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}

/** A method-level refusal — the whole call, not one object. */
export interface FilesRefusal {
  type: string;
  description?: string;
  /** Something a person can act on, not a JMAP error type. */
  message: string;
}

/** The result of one write, reduced to the single object it acted on. */
export interface FileWriteResult {
  /** Set on a successful create. */
  id?: string;
  /** Thread into the next write's `ifInState`, when a caller wants one. */
  newState?: string;
  /** The server ran the call and refused this object. */
  error?: SetError;
  /** The server refused the whole call (scope, state mismatch, capability). */
  refusal?: FilesRefusal;
}
