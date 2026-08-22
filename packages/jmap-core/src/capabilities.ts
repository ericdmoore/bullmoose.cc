/** Capability URNs and the server's advertised core limits. */

export const CORE_CAP = "urn:ietf:params:jmap:core";
export const MAIL_CAP = "urn:ietf:params:jmap:mail";
export const SUBMISSION_CAP = "urn:ietf:params:jmap:submission";
export const WEBSOCKET_CAP = "urn:ietf:params:jmap:websocket";
export const VACATION_CAP = "urn:ietf:params:jmap:vacationresponse";
/** RFC 9661. Advertised only since SieveScript/get became real (s31 slice 1). */
export const SIEVE_CAP = "urn:ietf:params:jmap:sieve";
export const CONTACTS_CAP = "urn:ietf:params:jmap:contacts";
/** JMAP for Calendars is still an IETF draft; we advertise the URN and
 * implement the pragmatic core (Calendar/CalendarEvent CRUD + query +
 * changes + a bullmoose occurrence expansion helper). */
export const CALENDARS_CAP = "urn:ietf:params:jmap:calendars";
/** Vendor capability: AgentInvocation queue etc. (agent-integration.md). */
export const AGENT_CAP = "urn:bullmoose:params:jmap:agent";
/**
 * JMAP for Files (sVOL 011). Still an IETF WG draft — we advertise the URN and
 * implement the pragmatic core (FileNode get/set/query/changes/queryChanges/copy
 * over an inode table + the existing R2 blob path).
 *
 * ⚠️ The targeted draft version is PINNED here per s03.B/arch.md §1: the URN is
 * stable but field semantics can shift between revisions, so when a new draft
 * lands, re-read the diff before bumping this constant. `shareWith` is always
 * null in this slice (named-principal ACLs are the teams epic).
 */
export const FILENODE_CAP = "urn:ietf:params:jmap:filenode";
export const FILENODE_DRAFT_VERSION = "draft-ietf-jmap-filenode-14";

/** RFC 8620 §2 core capability object. */
export const coreCapability = {
  maxSizeUpload: 50_000_000,
  maxConcurrentUpload: 4,
  maxSizeRequest: 10_000_000,
  maxConcurrentRequests: 4,
  maxCallsInRequest: 16,
  maxObjectsInGet: 500,
  maxObjectsInSet: 500,
  collationAlgorithms: ["i;ascii-numeric", "i;ascii-casemap", "i;unicode-casemap"],
} as const;

/**
 * RFC 9610 §1.3 contacts capability object (per-account).
 * maxAddressBooksPerCard: 1 advertises the v1 single-book-per-card
 * constraint (spec-legal: any integer >= 1); the schema keeps the full
 * addressBookIds set in the blob so lifting it later is a backfill.
 */
export const contactsCapability = {
  maxAddressBooksPerCard: 1,
  mayCreateAddressBook: true,
} as const;

/**
 * Ceiling on the TOTAL attachment bytes in one `Email/set` create, enforced in
 * `services/jmap/src/methods/email.ts` and advertised below as
 * `maxSizeAttachmentsPerEmail` — one constant so the promise and the guard
 * cannot drift.
 *
 * A Worker isolate has a hard 128 MB memory limit, and an attachment is
 * resident several times over on its way into a message: the raw bytes off R2
 * (N), the base64 string (4N/3 characters — and a JS string is UTF-16, so 8N/3
 * bytes), the 76-column line array plus its join (another ~8N/3), and finally
 * the whole message re-encoded to UTF-8. Peak is roughly 6-8x the raw total,
 * so 10 MB of attachments costs ~60-80 MB and anything much larger gets the
 * isolate killed mid-write — which reaches the user as a draft that silently
 * vanished, not as an error.
 *
 * This was 50_000_000, a number the isolate could never have honoured: a
 * client that believed the advertisement and uploaded 50 MB got an OOM instead
 * of a `tooLarge`. 10 MB is also close to the practical inbound ceiling of the
 * MTAs on the other end, since base64 inflates it to ~13.3 MB on the wire.
 */
export const MAX_ATTACHMENT_BYTES_PER_EMAIL = 10_000_000;

/**
 * How far in the future `EmailSubmission/set` will schedule a send, in
 * seconds — the RFC 8621 §1.3 `maxDelayedSend` value, and the ceiling the
 * create path enforces (`services/jmap/src/methods/submission.ts`), one
 * constant so the promise and the guard cannot drift.
 *
 * Why 24 hours: the window exists so `undoStatus: "pending"` →
 * `"canceled"` can mean something (a send the client can still take back)
 * and so "send this tomorrow morning" works, while keeping the tail short
 * enough that a forgotten pending send is a same-day surprise, not a
 * month-later one. Deliberately NOT config: one binding-free constant.
 *
 * ⚠️ There is no default hold. A create with no requested release time
 * relays immediately, exactly as before this constant existed — a silent
 * server-side delay on every send would change the meaning of "sent" under
 * every existing client (CLI, webmail, agent runtime) at once. The hold is
 * opt-in per submission: `sendAt`, or FUTURERELEASE `HOLDFOR`/`HOLDUNTIL`
 * envelope parameters (RFC 4865), whichever the client speaks.
 */
export const MAX_DELAYED_SEND_SECONDS = 86_400;

/** RFC 8621 §1.3 submission capability object (per-account). */
export const submissionCapability = {
  maxDelayedSend: MAX_DELAYED_SEND_SECONDS,
  submissionExtensions: {},
} as const;

/** RFC 8621 §1.3 mail capability object (per-account). */
export const mailCapability = {
  maxMailboxesPerEmail: null,
  maxMailboxDepth: 10,
  maxSizeMailboxName: 200,
  maxSizeAttachmentsPerEmail: MAX_ATTACHMENT_BYTES_PER_EMAIL,
  emailQuerySortOptions: ["receivedAt", "size", "from", "to", "subject"],
  mayCreateTopLevelMailbox: true,
} as const;
