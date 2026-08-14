// What this section can and cannot actually do — stated out loud, in one
// module, so the screen cannot drift from the server.
//
// The pattern is `../calendar/scope.ts` and `../mail/search.ts`, and the lesson
// behind it is `.feedback common/004`: mail shipped for months with a search
// box whose scope note was quietly false. Files has four limits worth a
// sentence and one of them is sharp enough to change what the UI OFFERS.
//
// ── 1. The capability (the plain-client floor) ─────────────────────────────
//
// `urn:ietf:params:jmap:filenode` is what makes any of this reachable. This
// build's server advertises it unconditionally (session.ts:38/72 — and
// `.feedback common/030` notes the "absent when disabled" acceptance is
// unmet), but the floor is not about THIS server: a bullmoose without the
// Files realm must render a sentence, not an empty drive and five dead
// buttons (`../../../.plans/s03-webAccess/arch.md` §8.6).
//
// ── 2. Reading needs `read`; writing needs `files` ─────────────────────────
//
// `FileNode/{get,query,changes}` gate on `("read", "files")` and
// `FileNode/{set,copy}` on `("files", "files")` (filenode.ts:73, 124, 188).
// Since `common/027` closed the realm→read edge, holding `files` satisfies
// `read` (`packages/auth-core/src/index.ts:107-115`) — so the module header in
// filenode.ts, which still says a `files`-only token "can WRITE but not READ",
// is stale. The live behaviour is the sane one.
//
// ── 3. But UPLOADING needs `draft`, which `files` does not imply ───────────
//
// `POST /api/upload/{accountId}` gates on the MAIL verb `draft`
// (`services/jmap/src/index.ts:98-100`), and `hasScope` gives no path from a
// realm scope to a mail verb. A token scoped `["files"]` can therefore create
// folders, rename, move and delete — but can never add a file, because the
// blob upload 403s and `FileNode/set create` refuses a file without a
// `blobId` that exists (filenode.ts:546-552). That is a real cross-realm gap
// in the server, not something the browser can route around, so the UI's job
// is to NAME it when it happens instead of showing "upload failed".
//
// ── 4. Folders-first is a client ordering ─────────────────────────────────
//
// `FileNode/query` sorts on name/created/modified/changed/size only
// (filenode.ts:780) — there is no `nodeType` sort key — so grouping directories
// first happens in the browser, over the rows that have loaded. Same
// window-local honesty the thread list carries.

/** The capability that makes the section reachable at all. */
export const FILENODE_CAPABILITY = "urn:ietf:params:jmap:filenode";

/** Realm scope for writes. */
export const FILES_WRITE_SCOPE = "files";
/** Mail verb the blob upload route demands (see §3 above). */
export const UPLOAD_SCOPE = "draft";

/** Children fetched per directory page. The store defaults to 256 when a call
 *  omits `limit` (`mailstore:3522`); we ask explicitly so the number on screen
 *  and the number in the request are the same one. */
export const CHILD_PAGE_SIZE = 200;

/** Rendered when the session does not advertise the Files capability. */
export const NO_CAPABILITY_NOTE =
  `This account’s server does not advertise ${FILENODE_CAPABILITY}, so there are no files ` +
  `to browse. Nothing is broken — this build simply has no Files realm, and every other ` +
  `section works exactly as it did.`;

/** Rendered when a read is refused for scope reasons. */
export const NO_READ_SCOPE_NOTE =
  "This session is not allowed to read files. The token needs the “files” permission — or " +
  "any permission at all that implies read — on an account with a Files realm.";

/** Rendered when writes are refused but reads work. */
export const NO_WRITE_SCOPE_NOTE =
  "This session can look but not touch: creating, renaming, moving and deleting all need the " +
  "“files” permission, which this token does not hold.";

/**
 * The sentence for §3 — the one gap a person would otherwise read as a bug.
 * Deliberately explicit that folders still work, because that is the confusing
 * part: the New folder button succeeds and the upload beside it does not.
 */
export const NO_UPLOAD_SCOPE_NOTE =
  "Uploading is refused for this session. The upload route needs the “draft” permission — a MAIL " +
  "permission — which the “files” permission does not include, so a files-only token can make " +
  "folders but cannot add a file. That is a gap in the server’s scope model, not something you " +
  "typed wrong.";

/**
 * Rendered under a partially-loaded directory.
 *
 * Two orderings meet here and they do not agree: the server pages with
 * `ORDER BY name` under SQLite's BINARY collation (every uppercase letter
 * before every lowercase one), and the browser re-sorts what arrives with
 * `localeCompare`, which is case-insensitive at its primary strength. Within
 * one page that is a cosmetic difference. Across pages it decides WHICH rows
 * you have, which is not cosmetic at all.
 */
export const PARTIAL_SORT_NOTE =
  "Folders are grouped first by this browser, not by the server — in a folder this large the " +
  "grouping, and the alphabetical order it sits inside, only hold over the rows loaded so far.";

/** What a directory listing is, and is not. */
export function describeListing(loaded: number, total: number | undefined): string {
  if (total === undefined || total <= loaded) return "";
  return `Showing ${loaded} of ${total} — this folder has more than one page of children.`;
}

/**
 * The `Attachments` folder is not a special place in the UI, and this is the
 * one line that says why it is there at all. `role: "attachments"` is minted by
 * the inbound sidestep (`services/ingest/src/sidestep.ts:46`) the first time a
 * large attachment arrives.
 */
export const ATTACHMENTS_ROLE = "attachments";
export const ATTACHMENTS_ROLE_NOTE =
  "Large incoming attachments are filed here automatically when mail is delivered. They are the " +
  "same bytes as the message’s attachment, not a copy — the message still carries it.";

/**
 * The reverse link that does not exist yet. A file filed by the sidestep knows
 * nothing about the message it came from: the cross-link is one-way, stored on
 * the EMAIL (`attachments[].fileNodeId`, mailstore:75), and `file_nodes` has no
 * column pointing back (`data-plane.sql:718-739`). Saying so beats a detail
 * pane that silently omits the only question a person asks about a file that
 * appeared on its own.
 */
export const NO_SOURCE_LINK_NOTE =
  "Where a filed attachment came from is recorded on the message, not on the file, so this pane " +
  "cannot link back to it.";
