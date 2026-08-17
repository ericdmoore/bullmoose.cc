// Every JMAP call `/files` makes, in one module.
//
// No second client: this composes the injected `JmapClient`
// (`../jmap/JmapClient.ts`), which already owns batching, back-references and
// computing `using[]` from the LIVE session — so a server without
// `urn:ietf:params:jmap:filenode` never receives a call it would 400
// (`capabilityForMethod`, `../jmap/capabilities.ts:69`).
//
// ══ The one ordering that is not a preference ══════════════════════════════
//
//   upload the bytes  →  get a blobId  →  FileNode/set create
//
// It cannot be the other way round and it cannot be one call. `FileNode/set
// create` for a file REQUIRES a `blobId`, and verifies it with `headBlob`
// before inserting the row (filenode.ts:546-552) — that verification is also
// what PINS the blob against GC (`s03.B/arch.md` §3). Create first and the
// call is refused with `blobNotFound`; create anyway on a failed upload and you
// have a row pointing at nothing. So `uploadFile` below returns before it ever
// reaches `FileNode/set` if the upload did not produce a blob, and
// `api.test.ts` asserts both halves of that: the ORDER on the happy path, and
// that a thrown upload issues no `FileNode/set` at all.
//
// ══ Everything is one round trip where it can be ═══════════════════════════
//
// A directory open is ONE request carrying three calls: the folder plus its
// ancestors (`fetchParents`, for the breadcrumb), the child query, and a
// back-referenced get of exactly those children. Invariant §6.5.
//
// ⚠️ NEVER send `FileNode/get { ids: [] }`. An empty array is not "no ids" to
// the store — `getFileNodes` treats a zero-length list as "no filter" and
// returns the WHOLE account (`mailstore:3310-3328`). The root case omits the
// call instead of passing an empty list.

import { FILENODE_CAP, hasCapability } from "../jmap/capabilities";
import { backReference, type JmapClient } from "../jmap/JmapClient";
import type { Invocation, Session } from "../jmap/types";
import { normalizeName, nameProblem, safeUploadName, takenNames, uniqueName } from "./names";
import { CHILD_PAGE_SIZE, NO_UPLOAD_SCOPE_NOTE, NO_WRITE_SCOPE_NOTE } from "./scope";
import { breadcrumb, sortChildren, type Breadcrumb } from "./tree";
import type { FileNode, FilesRefusal, FileWriteResult, SetError } from "./types";

/** An account this session can reach files in. */
export interface FilesAccount {
  id: string;
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  isPrimary: boolean;
}

/**
 * Every account whose capabilities advertise Files, primary first.
 *
 * Same shape as `contactsAccounts` (../contacts/books.ts) and for the same
 * server reason: `primaryAccounts` is the OWNER's account or the empty string
 * (session.ts:61), so `primaryAccountId()` throws for a principal that reaches
 * an account only through a grant. The account LIST is the truth.
 */
export function filesAccounts(session: Session): FilesAccount[] {
  const primaryId = session.primaryAccounts[FILENODE_CAP] ?? "";
  const out: FilesAccount[] = [];
  for (const [id, account] of Object.entries(session.accounts)) {
    if (!hasCapability({ capabilities: account.accountCapabilities }, FILENODE_CAP)) continue;
    out.push({
      id,
      name: account.name,
      isPersonal: account.isPersonal,
      isReadOnly: account.isReadOnly,
      isPrimary: id === primaryId,
    });
  }
  return out.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    if (a.isPersonal !== b.isPersonal) return a.isPersonal ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ── reads ─────────────────────────────────────────────────────────────────

export interface DirectoryPage {
  /** The folder being shown. `undefined` at the account root, which has no node. */
  dir?: FileNode;
  trail: Breadcrumb;
  /** Sorted directories-first (`tree.ts` `sortChildren`). */
  children: FileNode[];
  /** `FileNode/query`'s `total` — how many children the folder really has. */
  total?: number;
  /** The account state at read time. */
  state: string;
  /** Set when the server refused the whole read (scope, missing account). */
  refusal?: FilesRefusal;
}

export interface LoadDirectoryOptions {
  position?: number;
  limit?: number;
}

/**
 * One directory, its breadcrumb and its children — in one round trip.
 *
 * `position`/`limit` page the CHILDREN. The server sorts by name; the
 * directories-first grouping is applied here afterwards, which is why a
 * partially-loaded folder gets `PARTIAL_SORT_NOTE` on screen.
 */
export async function loadDirectory(
  client: JmapClient,
  accountId: string,
  dirId: string | null,
  opts: LoadDirectoryOptions = {},
): Promise<DirectoryPage> {
  const position = opts.position ?? 0;
  const limit = opts.limit ?? CHILD_PAGE_SIZE;

  const calls: Invocation[] = [];
  if (dirId !== null) {
    // fetchParents gives the ancestors in the SAME call — the breadcrumb costs
    // nothing extra (filenode.ts:83-103).
    calls.push(["FileNode/get", { accountId, ids: [dirId], fetchParents: true }, "d"]);
  }
  calls.push([
    "FileNode/query",
    {
      accountId,
      filter: { parentId: dirId },
      sort: [{ property: "name", isAscending: true }],
      position,
      limit,
      calculateTotal: true,
    },
    "q",
  ]);
  calls.push([
    "FileNode/get",
    { accountId, "#ids": backReference("q", "FileNode/query", "/ids") },
    "g",
  ]);

  const responses = await client.request(calls);
  const refused = (detail: unknown): DirectoryPage => ({
    trail: breadcrumb(new Map(), dirId),
    children: [],
    state: "",
    refusal: describeFilesRefusal(detail as { type?: string; description?: string }, "read"),
  });

  // The child query is the call this screen cannot do without; the ancestor
  // get is decoration (a truncated breadcrumb is a rendered state, not a
  // failure), so they are checked separately rather than as "any error".
  const queried = responses.find((r) => r[2] === "q");
  if (!queried || queried[0] === "error") return refused(queried?.[1] ?? {});
  const query = queried[1] as { ids?: unknown; total?: number; queryState?: string };
  const ids = Array.isArray(query.ids) ? (query.ids as string[]) : [];

  const byId = new Map<string, FileNode>();
  const ancestors = responses.find((r) => r[2] === "d");
  if (ancestors && ancestors[0] !== "error") {
    for (const node of nodesOf(ancestors[1])) byId.set(node.id, node);
  }

  // ⚠️ The children come from the QUERY's id list, resolved through the get —
  // never from the get's `list` wholesale. When a folder is empty the
  // back-reference expands to `ids: []`, and the server reads a zero-length
  // list as "no filter" and answers with EVERY node in the account
  // (`mailstore:3310-3328`). Taking `list` at face value would render the
  // whole drive as the contents of an empty folder. Reported as a server-side
  // gap; this is the client-side guard, and it also drops any row a future
  // server might return that was not asked for.
  let children: FileNode[] = [];
  if (ids.length > 0) {
    const got = responses.find((r) => r[2] === "g");
    if (!got || got[0] === "error") return refused(got?.[1] ?? {});
    const fetched = new Map(nodesOf(got[1]).map((n) => [n.id, n]));
    children = ids.map((id) => fetched.get(id)).filter((n): n is FileNode => n !== undefined);
  }

  return {
    ...(dirId !== null && byId.has(dirId) ? { dir: byId.get(dirId)! } : {}),
    trail: breadcrumb(byId, dirId),
    children: sortChildren(children),
    ...(typeof query.total === "number" ? { total: query.total } : {}),
    state: typeof query.queryState === "string" ? query.queryState : "",
  };
}

/**
 * Every directory in the account — the destinations a move may offer.
 *
 * Bounded rather than paged: `moveTargets` needs the whole set to exclude the
 * moving node's own descendants, and a half-fetched tree would offer a target
 * the server then refuses as a cycle. `MAX_DIRECTORIES` is the honest ceiling;
 * above it the move control says so rather than silently listing a prefix.
 */
export const MAX_DIRECTORIES = 500;

export async function loadDirectories(
  client: JmapClient,
  accountId: string,
): Promise<{ directories: FileNode[]; truncated: boolean }> {
  const { query, get } = await client.queryThenGet(
    accountId,
    "FileNode/query",
    {
      filter: { nodeType: "directory" },
      sort: [{ property: "name", isAscending: true }],
      limit: MAX_DIRECTORIES,
      calculateTotal: true,
    },
    "FileNode/get",
  );
  // Same guard as `loadDirectory`: resolve through the query's id list rather
  // than trusting `list`, because an account with NO directories would
  // back-reference to `ids: []` and be answered with everything.
  const ids = Array.isArray(query.ids) ? (query.ids as string[]) : [];
  const fetched = new Map(nodesOf(get).map((n) => [n.id, n]));
  const directories = ids
    .map((id) => fetched.get(id))
    .filter((n): n is FileNode => n !== undefined && n.nodeType === "directory");
  const total = typeof query.total === "number" ? query.total : directories.length;
  return { directories, truncated: total > directories.length };
}

function nodesOf(result: unknown): FileNode[] {
  const list = (result as { list?: unknown } | undefined)?.list;
  return Array.isArray(list) ? (list as FileNode[]) : [];
}

// ── writes ────────────────────────────────────────────────────────────────

/** One `FileNode/set`, reduced to the single object it acted on. */
async function setOne(
  client: JmapClient,
  args: Record<string, unknown>,
  op: "create" | "update" | "destroy",
  key: string,
): Promise<FileWriteResult> {
  const [response] = await client.request([["FileNode/set", args, "w0"]]);
  if (!response) return { refusal: describeFilesRefusal({}, "write") };
  if (response[0] === "error") {
    return { refusal: describeFilesRefusal(response[1] as { type?: string }, "write") };
  }

  const result = response[1] as {
    created?: Record<string, { id?: string }>;
    notCreated?: Record<string, SetError>;
    updated?: Record<string, unknown>;
    notUpdated?: Record<string, SetError>;
    destroyed?: string[];
    notDestroyed?: Record<string, SetError>;
    newState?: string;
  };
  const newState = typeof result.newState === "string" ? { newState: result.newState } : {};

  if (op === "create") {
    const made = result.created?.[key];
    if (made?.id) return { id: made.id, ...newState };
    return { error: result.notCreated?.[key] ?? { type: "serverFail" }, ...newState };
  }
  if (op === "update") {
    if (result.updated && key in result.updated) return { ...newState };
    return { error: result.notUpdated?.[key] ?? { type: "serverFail" }, ...newState };
  }
  if ((result.destroyed ?? []).includes(key)) return { ...newState };
  return { error: result.notDestroyed?.[key] ?? { type: "serverFail" }, ...newState };
}

/**
 * Make a folder.
 *
 * Client-side validation first (`nameProblem` mirrors the server's own test —
 * see `names.ts`), because a refusal that costs a round trip teaches people to
 * distrust the form. The server still decides: a name that passes here and
 * collides there comes back as `alreadyExists` and is reported verbatim rather
 * than quietly suffixed. A folder is NOT auto-renamed (`names.ts` header).
 */
export async function createFolder(
  client: JmapClient,
  accountId: string,
  parentId: string | null,
  rawName: string,
): Promise<FileWriteResult> {
  const problem = nameProblem(rawName);
  if (problem) {
    return { error: { type: "invalidProperties", description: problem, properties: ["name"] } };
  }
  return setOne(
    client,
    {
      accountId,
      create: {
        d0: {
          name: normalizeName(rawName),
          nodeType: "directory",
          parentId,
          // No `blobId`: the server refuses a directory that carries one
          // (filenode.ts:555-557), and omitting is not the same as null there.
        },
      },
    },
    "create",
    "d0",
  );
}

/** What `uploadFile` needs. `body` is handed to `fetch` untouched — see below. */
export interface UploadItem {
  /** The name to create the node under; already collision-resolved by `planUploads`. */
  name: string;
  size: number;
  type: string;
  /**
   * The bytes. A browser `File` IS a `Blob`, and passing it straight through
   * means the browser streams it — the file is never materialised as a string
   * or a base64 blowup in the tab's heap. `Uint8Array` is accepted for tests.
   */
  body: Blob | Uint8Array;
}

/**
 * Upload the bytes, THEN create the node. See this file's header for why that
 * order is load-bearing.
 *
 * A failed upload returns a refusal and issues no `FileNode/set` — the caller
 * keeps its selection and can retry. A 403 here is almost always the `draft`
 * scope gap (`scope.ts` §3), which gets its own sentence because "upload
 * failed" would send someone hunting for a permission they already hold.
 */
export async function uploadFile(
  client: JmapClient,
  accountId: string,
  parentId: string | null,
  item: UploadItem,
): Promise<FileWriteResult> {
  const type = item.type || "application/octet-stream";
  let blobId: string;
  let size: number;
  try {
    const uploaded = await client.upload(accountId, item.body, type);
    if (!uploaded?.blobId) {
      return {
        refusal: {
          type: "serverFail",
          message: "The server accepted the upload but returned no blob id, so nothing was filed.",
        },
      };
    }
    blobId = uploaded.blobId;
    size = typeof uploaded.size === "number" ? uploaded.size : item.size;
  } catch (err) {
    return { refusal: describeUploadFailure(err) };
  }

  return setOne(
    client,
    {
      accountId,
      create: {
        f0: {
          name: safeUploadName(item.name, blobId),
          nodeType: "file",
          parentId,
          blobId,
          size,
          type,
        },
      },
    },
    "create",
    "f0",
  );
}

/** Rename. `FileNode/set update { name }` is supported (filenode.ts:597-602). */
export async function renameNode(
  client: JmapClient,
  accountId: string,
  id: string,
  rawName: string,
): Promise<FileWriteResult> {
  const problem = nameProblem(rawName);
  if (problem) {
    return { error: { type: "invalidProperties", description: problem, properties: ["name"] } };
  }
  return setOne(
    client,
    { accountId, update: { [id]: { name: normalizeName(rawName) } } },
    "update",
    id,
  );
}

/**
 * Move. `parentId` is a patchable path and the server cycle-checks it
 * (filenode.ts:603-621); `moveTargets` pre-filters so a cycle is never offered.
 */
export async function moveNode(
  client: JmapClient,
  accountId: string,
  id: string,
  parentId: string | null,
): Promise<FileWriteResult> {
  return setOne(client, { accountId, update: { [id]: { parentId } } }, "update", id);
}

/**
 * Destroy.
 *
 * A non-empty directory comes back as `fileNodeHasChildren` unless the call
 * passes `onDestroyRemoveChildren` (filenode.ts:285-290) — that refusal IS the
 * confirmation step the server gives for free, so the UI asks once and obeys
 * the answer, exactly as `destroyBook` does for address books.
 *
 * ⚠️ Destroying a file also REVOKES every live share link for its blob
 * (filenode.ts:294, the `010` obligation). That is not undoable and the
 * confirmation says so.
 */
export async function destroyNode(
  client: JmapClient,
  accountId: string,
  id: string,
  withChildren = false,
): Promise<FileWriteResult> {
  return setOne(
    client,
    { accountId, destroy: [id], ...(withChildren ? { onDestroyRemoveChildren: true } : {}) },
    "destroy",
    id,
  );
}

/**
 * Fetch a file's bytes.
 *
 * ⚠️ This materialises the whole file in the tab, and that is a real
 * limitation rather than an oversight: `GET /api/download/…` authenticates with
 * a **bearer header** (`index.ts:92-95`), so a plain `<a href>` cannot carry
 * the credential, and the only way to put a token in a URL instead is the one
 * `../app/client.ts` exists to prevent (a credential in history, in `Referer`,
 * and in every access log on the path). So the download goes through `fetch`
 * and a `Blob`, and the upload path — which does NOT have this constraint —
 * streams instead.
 */
export async function downloadNode(
  client: JmapClient,
  accountId: string,
  node: FileNode,
): Promise<{ bytes: Uint8Array; name: string; type: string }> {
  if (node.nodeType !== "file" || !node.blobId) {
    throw new Error(`${node.name} has no content to download`);
  }
  const type = node.type ?? "application/octet-stream";
  const bytes = await client.download(accountId, node.blobId, { name: node.name, type });
  return { bytes, name: node.name, type };
}

// ── planning an upload batch ──────────────────────────────────────────────

/** The minimum a planner needs to know about a file — so tests need no `File`. */
export interface UploadCandidate {
  name: string;
  size: number;
  type: string;
}

export interface PlannedUpload<T extends UploadCandidate> {
  candidate: T;
  /** The name that will be sent. */
  name: string;
  /** Set when the name had to change; the UI reports it rather than hiding it. */
  renamedFrom?: string;
}

/**
 * Assign a final name to every file in a drop or a picker selection.
 *
 * Two collision sources, and both matter: the folder's existing children, and
 * THE REST OF THIS BATCH — dropping two `report.pdf`s from different folders is
 * ordinary, and planning them independently would send the same name twice and
 * have the server refuse the second with `alreadyExists`. So the accumulator
 * grows as it goes.
 */
export function planUploads<T extends UploadCandidate>(
  candidates: readonly T[],
  siblings: readonly FileNode[],
): PlannedUpload<T>[] {
  const taken = takenNames(siblings);
  return candidates.map((candidate) => {
    const safe = safeUploadName(candidate.name);
    const name = uniqueName(safe, taken);
    taken.add(name);
    return { candidate, name, ...(name === safe ? {} : { renamedFrom: safe }) };
  });
}

// ── refusals, in the vocabulary of this screen ────────────────────────────

/**
 * Turn a method-level refusal into a sentence. Mirrors
 * `describeContactRefusal` (../contacts/write.ts:61-84) so every section
 * explains a scope failure the same way.
 */
export function describeFilesRefusal(
  detail: { type?: string; description?: string },
  what: "read" | "write",
): FilesRefusal {
  const type = detail.type ?? "error";
  const message =
    type === "forbidden"
      ? what === "write"
        ? NO_WRITE_SCOPE_NOTE
        : "This session is not allowed to read files. The token needs a permission that implies " +
          "read on this account."
      : type === "accountNotFound"
        ? "That account is no longer reachable from this session."
        : type === "stateMismatch"
          ? "Something else in this account changed while you were working. Reload and try again."
          : type === "unknownMethod"
            ? "This server does not implement the Files methods, so there is nothing to browse."
            : detail.description || `The server refused: ${type}.`;
  return {
    type,
    ...(detail.description ? { description: detail.description } : {}),
    message,
  };
}

/** A failed blob upload — the HTTP half, which has no JMAP error type. */
export function describeUploadFailure(err: unknown): FilesRefusal {
  const status = (err as { httpStatus?: number } | null)?.httpStatus;
  const text = err instanceof Error ? err.message : String(err);
  if (status === 403)
    return { type: "forbidden", description: text, message: NO_UPLOAD_SCOPE_NOTE };
  if (status === 404) {
    return {
      type: "accountNotFound",
      description: text,
      message:
        "That account is not reachable from this session, so there is nowhere to put the file.",
    };
  }
  if (status === 413) {
    return {
      type: "tooLarge",
      description: text,
      message: "The server refused the file as too large. Nothing was filed.",
    };
  }
  return {
    type: "uploadFailed",
    description: text,
    message: `The bytes never reached the server, so nothing was filed: ${text}`,
  };
}

/**
 * Explain a per-object `SetError` in the vocabulary of this screen.
 *
 * `subject` is only ever read for its name, so it is typed that way: a create
 * that was refused has no node to point at, and the name the person typed is
 * the thing the sentence needs.
 */
export function describeSetError(error: SetError, subject: Pick<FileNode, "name"> | null): string {
  switch (error.type) {
    case "alreadyExists":
      return (
        `There is already something called “${subject?.name ?? "that"}” here. ` +
        "Names have to be unique inside a folder — pick another one."
      );
    case "fileNodeHasChildren":
      return (
        `“${subject?.name ?? "That folder"}” is not empty. Deleting it deletes everything ` +
        "inside it, and any share links pointing at those files stop working."
      );
    case "notFound":
      return "That item is no longer there — it may have been deleted from another client.";
    case "blobNotFound":
      return "The uploaded bytes are no longer on the server, so the file could not be filed.";
    case "forbidden":
      return error.description ?? NO_WRITE_SCOPE_NOTE;
    case "invalidProperties":
      return error.description ?? `The server rejected: ${(error.properties ?? []).join(", ")}.`;
    default:
      return error.description ?? `The server refused: ${error.type}.`;
  }
}
