/**
 * Mailstore — typed data access over the data-plane D1 shard + R2 blobs.
 * Schemas live in ../sql/. The shard for an account comes from the
 * control plane (accounts.shard); for the single-shard MVP every worker
 * binds one D1 database as DB.
 */

import {
  BookWriteRefused,
  cardContribution,
  cardMemberUids,
  cardOwnEmails,
  contributionDelta,
  normalizeAddress,
  refusedDirectWrite,
  refusedNestedGroup,
  type BookWritePolicy,
  type ContactWriter,
} from "./governance";

// Book governance (s10 T1/T2) — the pure half of the contact-write chokepoint.
export {
  BookWriteRefused,
  cardContribution,
  cardMemberUids,
  cardOwnEmails,
  contributionDelta,
  normalizeAddress,
  reconcileBookMembership,
  type BookMembershipEvent,
  type BookWritePolicy,
  type BookWriteRefusalReason,
  type ContactWriter,
} from "./governance";

export interface EmailAddress {
  name?: string;
  email: string;
}

export interface AttachmentMeta {
  blobId: string;
  type: string;
  name: string | null;
  size: number;
  cid: string | null;
  disposition: string | null;
}

/** One stored object, as blob enumeration reports it. */
export interface BlobInfo {
  blobId: string;
  size: number;
  /** ISO-8601, from R2's own `uploaded`. */
  uploaded: string;
}

export interface MailboxRow {
  id: string;
  parentId: string | null;
  name: string;
  role: string | null;
  sortOrder: number;
}

export interface EmailRow {
  id: string;
  blobId: string;
  threadId: string;
  messageId: string | null;
  inReplyTo: string | null;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  preview: string;
  size: number;
  receivedAt: number;
  hasAttachment: boolean;
  attachments: AttachmentMeta[];
  mailboxIds: string[];
  keywords: string[];
}

export interface NewEmail {
  id: string;
  blobId: string;
  threadId: string;
  messageId: string | null;
  inReplyTo: string | null;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  preview: string;
  size: number;
  receivedAt: number;
  hasAttachment: boolean;
  attachments: AttachmentMeta[];
  mailboxIds: string[];
  keywords: string[];
  /**
   * The message's plain-text body, for the full-text index ONLY — it is not a
   * column and `Email/get` never reads it back (the bytes live in R2).
   *
   * Optional so that every existing call site keeps compiling, but a caller
   * that omits it makes only `preview` searchable, which is the pre-common/004
   * behaviour. Supply it wherever the parse is already in hand: ingest,
   * `Email/set` create, `Email/import`. Truncated to `FTS_BODY_LIMIT`.
   */
  bodyText?: string;
}

/** JMAP Email/query filter (RFC 8621 §4.4.1), the subset we support. */
export type EmailFilter = EmailFilterOperator | EmailFilterCondition;

export interface EmailFilterOperator {
  operator: "AND" | "OR" | "NOT";
  conditions: EmailFilter[];
}

export interface EmailFilterCondition {
  inMailbox?: string;
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  before?: string; // UTCDate
  after?: string;
  hasKeyword?: string;
  notKeyword?: string;
  hasAttachment?: boolean;
  minSize?: number;
  maxSize?: number;
}

export interface EmailSort {
  property: "receivedAt" | "size" | "subject" | "from";
  isAscending: boolean;
}

export interface EmailQuery {
  filter?: EmailFilter | null;
  sort?: EmailSort[];
  position?: number;
  limit?: number;
  calculateTotal?: boolean;
}

/**
 * A row of `identities` — the addresses an account may send as.
 *
 * Widened by sVOL 006. `services/agent/src/index.ts` and
 * `EmailSubmission/set` both read `.id`/`.email` only, so the extra
 * properties are additive for them.
 */
export interface IdentityRow {
  id: string;
  email: string;
  name: string;
  /** RFC 8621 §6.1 replyTo — `null` means unset, not "empty list". */
  replyTo: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  textSignature: string;
  htmlSignature: string;
  /** False for the provisioned primary: `Identity/set` refuses to destroy it. */
  mayDelete: boolean;
}

/** The writable half of an identity — everything except `id` and `email`. */
export interface IdentityColumns {
  name?: string;
  reply_to_json?: string | null;
  bcc_json?: string | null;
  text_signature?: string;
  html_signature?: string;
  may_delete?: number;
}

export interface AddressBookRow {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isDefault: boolean;
  isSubscribed: boolean;
  ctag: number;
  createdAt: number;
  updatedAt: number;
  /** s10 T1 — per-book write policy the contact-write chokepoint enforces. */
  writePolicy: BookWritePolicy;
}

/**
 * JSContact Card (RFC 9553). Stored losslessly as card_json; only the
 * properties the server itself reads or maintains are typed here.
 */
export interface JSContactCard {
  "@type"?: string;
  version?: string;
  uid?: string;
  created?: string; // UTCDate
  updated?: string;
  kind?: string;
  name?: {
    full?: string;
    components?: Array<{ kind?: string; value?: string } & Record<string, unknown>>;
  } & Record<string, unknown>;
  addressBookIds?: Record<string, boolean>;
  [key: string]: unknown;
}

export interface ContactCardRow {
  id: string;
  addressBookId: string;
  uid: string;
  card: JSContactCard;
  nameFull: string | null;
  /** CardDAV resource name (client PUT filename); null → id serves. */
  davName: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  sortOrder: number;
  isDefault: boolean;
  isSubscribed: boolean;
  ctag: number;
  createdAt: number;
  updatedAt: number;
}

/** JSCalendar Event (RFC 8984) — stored losslessly; open object. */
export type JSCalendarEventBlob = Record<string, unknown>;

export interface CalendarEventRow {
  id: string;
  calendarId: string;
  uid: string;
  event: JSCalendarEventBlob;
  title: string | null;
  /** Outer span in UTC ms; endAt null = unbounded recurrence. */
  startAt: number | null;
  endAt: number | null;
  isRecurring: boolean;
  davName: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarEventFilterCondition {
  inCalendar?: string;
  uid?: string;
  /** UTCDate: occurrence span must end after this. */
  after?: string;
  /** UTCDate: occurrence span must start before this. */
  before?: string;
  text?: string;
  title?: string;
}

export interface CalendarEventQuery {
  filter?: CalendarEventFilterCondition | null;
  sort?: Array<{ property: "start" | "updated" | "created"; isAscending: boolean }>;
  position?: number;
  limit?: number;
  calculateTotal?: boolean;
}

/** FileNode inode row (JMAP for Files, draft-ietf-jmap-filenode-14). Metadata
 * only — content bytes live in R2 under blobId via the existing blob path. */
export type FileNodeType = "file" | "directory" | "symlink";

export interface FileNodeRow {
  id: string;
  parentId: string | null;
  name: string;
  nodeType: FileNodeType;
  blobId: string | null;
  size: number | null;
  type: string | null;
  /** All four are epoch ms; the JMAP layer emits UTCDate strings. */
  created: number;
  modified: number;
  accessed: number;
  changed: number;
  executable: boolean;
  isSubscribed: boolean;
  role: string | null;
}

/** Shallow patch for updateFileNode — only the mutable columns. */
export interface FileNodePatch {
  parentId?: string | null;
  name?: string;
  blobId?: string | null;
  size?: number | null;
  type?: string | null;
  executable?: boolean;
  isSubscribed?: boolean;
  role?: string | null;
  modified?: number;
  changed?: number;
  accessed?: number;
}

export interface FileNodeFilterCondition {
  /** Direct children of this parent; null = top-level nodes. */
  parentId?: string | null;
  nodeType?: FileNodeType;
  role?: string;
  /** Exact sibling/name match. */
  name?: string;
  /** true → only nodes with a blob; false → only nodes without. */
  hasBlobId?: boolean;
}

export interface FileNodeQuery {
  filter?: FileNodeFilterCondition | null;
  sort?: Array<{ property: "name" | "created" | "modified" | "changed" | "size"; isAscending: boolean }>;
  position?: number;
  limit?: number;
  calculateTotal?: boolean;
}

/** JMAP ContactCard/query filter (RFC 9610 §4.4.1), the subset we support. */
export type ContactFilter = ContactFilterOperator | ContactFilterCondition;

export interface ContactFilterOperator {
  operator: "AND" | "OR" | "NOT";
  conditions: ContactFilter[];
}

export interface ContactFilterCondition {
  inAddressBook?: string;
  uid?: string;
  kind?: string;
  hasMember?: string;
  createdBefore?: string; // UTCDate
  createdAfter?: string;
  updatedBefore?: string;
  updatedAfter?: string;
  text?: string;
  name?: string;
  nickname?: string;
  organization?: string;
  email?: string;
  phone?: string;
  note?: string;
}

export interface ContactSort {
  property: "created" | "updated" | "name";
  isAscending: boolean;
}

export interface ContactQuery {
  filter?: ContactFilter | null;
  sort?: ContactSort[];
  position?: number;
  limit?: number;
  calculateTotal?: boolean;
  /** Sharing: restrict results to these AddressBook ids (grant-scoped viewers). */
  restrictToBooks?: string[];
}

export interface SubmissionRow {
  id: string;
  emailId: string;
  identityId: string;
  envelope: { mailFrom: string; rcptTo: string[] };
  undoStatus: string;
  relayMessageId: string | null;
  sendAt: number;
}

/**
 * A submission read back out. Identical to what was written, plus the
 * `threadId` that RFC 8621 §7 lists as an EmailSubmission property and that
 * this table does not store — it is resolved from the email. Null when the
 * email has since been destroyed, which is a state the schema permits
 * (`email_submissions` declares no foreign key, and nothing cascades).
 */
export interface StoredSubmission extends SubmissionRow {
  threadId: string | null;
}

/**
 * Cross-realm provenance (s03.A T1) — the writer stamped onto every mutable
 * data-plane record by the shared write path below.
 *
 * The motivating gap: `grant_audit` only fires on *delegated* (grant-reached)
 * access, so an agent scrambling its OWNER's data leaves zero trace. These three
 * columns, stamped in `Mailstore` (never per JMAP method — that guarantees
 * drift), make every write attributable to a principal, and — when an agent
 * binding acted — to its binding and invocation.
 */
export interface WriteProvenance {
  /** Acting principal — login email, the same value `grant_audit.principal` holds. */
  principal: string;
  /** Agent binding name, when a binding drove the write; null/omitted otherwise. */
  binding?: string | null;
  /** `agent_invocations.id`, when an invocation drove the write; null/omitted otherwise. */
  invocation?: string | null;
}

/** The SQL column list for the provenance trio, in bind order. */
const PROVENANCE_COLUMNS =
  "last_writer_principal, last_writer_binding, last_writer_invocation";

const blobKey = (tenantId: string, accountId: string, blobId: string) =>
  `mail/${tenantId}/${accountId}/blobs/${blobId}`;

/**
 * Production D1 caps bound parameters at 100 per query (local SQLite
 * allows ~1000, so only prod trips it). Split id lists for IN (...)
 * queries; callers merge the per-chunk results.
 */
const MAX_BINDS = 90;

function chunked<T>(items: T[], size = MAX_BINDS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Normalize an RFC 5322 Message-ID for storage: JMAP exposes ids WITHOUT
 * angle brackets, and thread resolution compares stored message_id against
 * stored in_reply_to — so every write path must strip consistently
 * (postal-mime returns "<id@host>"; Email/set create generates bare ids).
 */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return null;
  return trimmed.replace(/^<|>$/g, "") || null;
}

// ---- Full-text search (common/004) ------------------------------------
//
// `emails_fts` is a CONTENTLESS FTS5 index (see sql/data-plane.sql). Three
// facts drive every line below:
//
//  1. Its rowid is an integer and an email id is a uuid, so `emails_fts_map`
//     holds the mapping. `docid` is allocated by AUTOINCREMENT, never by us.
//  2. Contentless means the index cannot be read back — only matched. Every
//     value we want to SELECT has to come from `emails` or the map table.
//  3. Contentless also means no UPDATE. Re-indexing is delete-then-insert,
//     which is why `insertEmail` clears the row before writing it and is
//     therefore safe to re-run (the backfill depends on that).

/**
 * How much body text goes into the index, in characters.
 *
 * Unbounded would be wrong in two directions: D1 caps a single bound value at
 * ~2 MB (capacity-and-scaling.md §2.5), and one pathological 5 MB message
 * would cost more index than a thousand ordinary ones. 64 KiB is ~15 printed
 * pages — past the length of any mail a human wrote, and comfortably inside
 * both limits.
 */
export const FTS_BODY_LIMIT = 64 * 1024;

/** The text of one message, as the index sees it. */
export interface EmailFtsText {
  subject: string;
  fromText: string;
  toText: string;
  bodyText: string;
}

/**
 * Strip an HTML body down to indexable words.
 *
 * Not a sanitizer. It exists because HTML-only mail (most newsletters, most
 * transactional mail) has NO text/plain part, so `parsed.text` is undefined
 * and such a message would otherwise be searchable by subject and sender
 * alone. `<script>` and `<style>` go first, or their contents become "words".
 *
 * ⚠️ This output IS displayed, via `previewText` below — the earlier version
 * of this comment said it never was, which stopped being true when `preview`
 * started falling back to it. That matters because the entity decoding here
 * runs in the *unsafe* direction: `&lt;script&gt;` becomes `<script>`. Correct
 * for an index (you want the words) and correct per RFC 8621, which defines
 * `preview` as *plaintext* — so the obligation to escape sits with whatever
 * renders it. Our own client satisfies that by construction (Preact escapes
 * `{email.preview}`); a third-party JMAP client is responsible for its own.
 * Do not interpolate this into HTML without escaping.
 */
export function htmlToIndexText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The `preview` column: a one-line plaintext fragment, RFC 8621 §4.1.4.
 *
 * All three write paths (delivery, `Email/set` create, `Email/import`) cut it
 * as `(parsed.text ?? "").slice(0, 256)`, which yields **empty string** for
 * HTML-only mail — i.e. for most newsletters and most transactional mail, the
 * thread list showed a blank line. This is the same `text`-then-`html` fallback
 * the FTS `bodyText` sites already use, so preview and index now agree on what
 * a message says.
 *
 * Whitespace is collapsed on BOTH paths, which is a deliberate change to the
 * plaintext one: a preview is rendered as a single line, and letting the two
 * paths differ in shape (HTML collapsed, plaintext not) would be worse than
 * either. Cut happens after collapsing, so 256 characters means 256 visible
 * ones rather than 256 mostly-newlines.
 */
export function previewText(
  text: string | null | undefined,
  html: string | null | undefined,
): string {
  const plain = text && text.trim() !== "" ? text : htmlToIndexText(html);
  return plain.replace(/\s+/g, " ").trim().slice(0, 256);
}

/** `[{name, email}]` → "Ada Lovelace ada@example.com", the form FTS indexes. */
function addressText(addresses: EmailAddress[]): string {
  return addresses.map((a) => [a.name, a.email].filter(Boolean).join(" ")).join(" ");
}

/** Everything about an email that the `text` condition should match. */
export function ftsTextOf(email: {
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc?: EmailAddress[];
  preview: string;
  bodyText?: string;
}): EmailFtsText {
  // `preview` is the fallback, not an addition: it is a prefix of bodyText
  // whenever both exist, and indexing it twice would only inflate the index.
  const body = email.bodyText ?? email.preview ?? "";
  return {
    subject: email.subject ?? "",
    fromText: addressText(email.from ?? []),
    // cc rides in to_text: JMAP's `text` condition is "any address", and a
    // separate column would buy nothing a caller can ask for.
    toText: addressText([...(email.to ?? []), ...(email.cc ?? [])]),
    bodyText: body.length > FTS_BODY_LIMIT ? body.slice(0, FTS_BODY_LIMIT) : body,
  };
}

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression, or `null` when
 * it contains nothing the tokenizer would index.
 *
 * FTS5's query language is a language: bare input can carry `AND`/`OR`/`NOT`,
 * `NEAR(...)`, column filters (`subject:`), prefix stars, parentheses and
 * quotes. A user typing `foo AND bar` means the literal string, and a user
 * typing a lone `"` should not get a 500. So EVERY whitespace-run becomes a
 * quoted phrase — inside double quotes the only metacharacter left is `"`
 * itself, which FTS5 escapes by doubling — and the phrases are joined by
 * implicit AND.
 *
 * The result is "every word must appear somewhere in the message", which is
 * both what a search box means and what the LIKE it replaces approximated.
 * Two honest differences from LIKE, worth knowing before reading a test:
 *
 *   · FTS matches WHOLE TOKENS. `ell` no longer finds `hello`.
 *   · `foo bar` no longer requires the words to be adjacent — for that,
 *     the caller's words are still matched as a phrase within each run only.
 */
export function ftsMatchQuery(raw: string): string | null {
  const phrases: string[] = [];
  for (const run of raw.split(/\s+/)) {
    // unicode61 indexes only alphanumerics; a run of pure punctuation ("--",
    // "?!") produces an empty phrase, and `""` is an FTS5 syntax error.
    if (!/[\p{L}\p{N}]/u.test(run)) continue;
    phrases.push(`"${run.replace(/"/g, '""')}"`);
  }
  return phrases.length > 0 ? phrases.join(" ") : null;
}

export class Mailstore {
  constructor(
    private db: D1Database,
    private blobs: R2Bucket,
    /**
     * Who is writing (s03.A T1). Optional and defaults to null so every
     * existing `new Mailstore(db, blobs)` call site keeps compiling and writes
     * NULL provenance — the safe value for system paths (inbound delivery,
     * provisioning) that have no acting principal. The JMAP write path supplies
     * it via `storeFor(ctx)`, so every JMAP `/set` records the writer.
     */
    private writer: WriteProvenance | null = null,
  ) {}

  /**
   * The provenance trio as positional bind values, in `PROVENANCE_COLUMNS`
   * order. THE single source of the last_writer_* values — every insert/update
   * of a mutable data-plane record threads these, so no write path can bypass
   * provenance without dropping this call (which the tests assert). Binding and
   * invocation are null unless an agent binding drove the write.
   */
  private provenanceValues(): [string | null, string | null, string | null] {
    const w = this.writer;
    return [w?.principal ?? null, w?.binding ?? null, w?.invocation ?? null];
  }

  /**
   * Append the provenance SET clauses + bind values to a dynamic UPDATE, so an
   * update stamps the same trio an insert does. Call it only when the update is
   * real (`sets.length > 0`): a no-op patch stays a no-op rather than becoming a
   * provenance-only write.
   */
  private appendProvenance(sets: string[], params: unknown[]): void {
    sets.push(
      "last_writer_principal = ?",
      "last_writer_binding = ?",
      "last_writer_invocation = ?",
    );
    params.push(...this.provenanceValues());
  }

  // ---- Mailboxes ----------------------------------------------------

  async getMailboxes(accountId: string, ids?: string[]): Promise<MailboxRow[]> {
    type Row = {
      id: string;
      parent_id: string | null;
      name: string;
      role: string | null;
      sort_order: number;
    };
    const results: Row[] = [];
    if (ids && ids.length > 0) {
      for (const chunk of chunked(ids)) {
        const marks = chunk.map(() => "?").join(",");
        const { results: r } = await this.db
          .prepare(
            `SELECT id, parent_id, name, role, sort_order FROM mailboxes
             WHERE account_id = ? AND id IN (${marks})`,
          )
          .bind(accountId, ...chunk)
          .all<Row>();
        results.push(...r);
      }
    } else {
      const { results: r } = await this.db
        .prepare(
          `SELECT id, parent_id, name, role, sort_order FROM mailboxes
           WHERE account_id = ? ORDER BY sort_order, name`,
        )
        .bind(accountId)
        .all<Row>();
      results.push(...r);
    }
    return results.map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      name: r.name,
      role: r.role,
      sortOrder: r.sort_order,
    }));
  }

  /** Fetch the mailbox with a given role, creating it if missing. */
  async ensureRoleMailbox(accountId: string, role: string, name: string): Promise<string> {
    const existing = await this.db
      .prepare(`SELECT id FROM mailboxes WHERE account_id = ? AND role = ?`)
      .bind(accountId, role)
      .first<{ id: string }>();
    if (existing) return existing.id;

    const id = `mb_${crypto.randomUUID()}`;
    await this.db
      .prepare(
        `INSERT INTO mailboxes (id, account_id, parent_id, name, role, sort_order, ${PROVENANCE_COLUMNS})
         VALUES (?, ?, NULL, ?, ?, 0, ?, ?, ?)`,
      )
      .bind(id, accountId, name, role, ...this.provenanceValues())
      .run();
    return id;
  }

  /**
   * Mailbox writes. Bare, like every other write here: no depth check, no
   * sibling-name check, no role protection. Mailstore is a thin data layer
   * and maintains no invariants — the choreography and the validation live
   * in Mailbox/set, next to the SetError they produce.
   */
  async insertMailbox(accountId: string, row: MailboxRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO mailboxes (id, account_id, parent_id, name, role, sort_order, ${PROVENANCE_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.id, accountId, row.parentId, row.name, row.role, row.sortOrder, ...this.provenanceValues())
      .run();
  }

  /** Patch a mailbox. `parentId: null` reparents to top level. */
  async updateMailbox(
    accountId: string,
    id: string,
    patch: { name?: string; parentId?: string | null; sortOrder?: number },
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      params.push(patch.name);
    }
    if (patch.parentId !== undefined) {
      sets.push("parent_id = ?");
      params.push(patch.parentId);
    }
    if (patch.sortOrder !== undefined) {
      sets.push("sort_order = ?");
      params.push(patch.sortOrder);
    }
    if (sets.length === 0) return;
    this.appendProvenance(sets, params);
    await this.db
      .prepare(`UPDATE mailboxes SET ${sets.join(", ")} WHERE account_id = ? AND id = ?`)
      .bind(...params, accountId, id)
      .run();
  }

  async deleteMailbox(accountId: string, id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM mailboxes WHERE account_id = ? AND id = ?`)
      .bind(accountId, id)
      .run();
  }

  /** Every email filed in a mailbox — the onDestroyRemoveEmails input. */
  async emailIdsInMailbox(accountId: string, mailboxId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT email_id FROM email_mailboxes WHERE account_id = ? AND mailbox_id = ?`,
      )
      .bind(accountId, mailboxId)
      .all<{ email_id: string }>();
    return results.map((r) => r.email_id);
  }

  /**
   * The four RFC 8621 §2 count properties for Mailbox/get.
   *
   * Threads are counted, not guessed. `Mailbox/get` used to return
   * `totalThreads: counts.totalEmails` behind a TODO, and threading here is
   * real — `resolveThreadId` joins a reply to its parent by In-Reply-To — so
   * the two numbers genuinely diverge as soon as a thread has two messages
   * in one mailbox.
   *
   * `totalThreads` is exactly the RFC's definition: threads with at least one
   * email in this mailbox.
   *
   * `unreadThreads` counts threads with at least one unread email IN THIS
   * MAILBOX. RFC 8621 §2 defines it thread-wide — at least one unread email
   * anywhere in the thread — but pairs that with a refinement excluding mail
   * that only exists in Trash. Implementing the thread-wide clause WITHOUT
   * the Trash refinement is strictly worse than this for the mailbox list it
   * feeds: a thread whose only unread copy sits in the Trash would inflate
   * the Inbox's badge forever. Both together need thread-wide scans and the
   * identity of the trash mailbox inside a per-mailbox aggregate; filed as
   * fromClaude/common/029 rather than half-done here.
   *
   * One aggregate, no extra round trip. The LEFT JOIN is deliberate: an
   * `email_mailboxes` row whose `emails` row is missing must still count
   * toward `totalEmails` exactly as it did before, and `COUNT(DISTINCT …)`
   * skips the NULL `thread_id` it produces.
   */
  async mailboxCounts(
    accountId: string,
    mailboxId: string,
  ): Promise<{
    totalEmails: number;
    unreadEmails: number;
    totalThreads: number;
    unreadThreads: number;
  }> {
    // Defined once and used by both unread aggregates, so the message count
    // and the thread count can never drift apart on what "unread" means.
    const UNREAD = `NOT EXISTS (
             SELECT 1 FROM email_keywords k
             WHERE k.account_id = em.account_id
               AND k.email_id = em.email_id AND k.keyword = '$seen'
           )`;
    const row = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN ${UNREAD} THEN 1 ELSE 0 END) AS unread,
           COUNT(DISTINCT e.thread_id) AS total_threads,
           COUNT(DISTINCT CASE WHEN ${UNREAD} THEN e.thread_id END) AS unread_threads
         FROM email_mailboxes em
         LEFT JOIN emails e
           ON e.account_id = em.account_id AND e.id = em.email_id
         WHERE em.account_id = ? AND em.mailbox_id = ?`,
      )
      .bind(accountId, mailboxId)
      .first<{
        total: number;
        unread: number | null;
        total_threads: number | null;
        unread_threads: number | null;
      }>();
    return {
      totalEmails: row?.total ?? 0,
      unreadEmails: row?.unread ?? 0,
      totalThreads: row?.total_threads ?? 0,
      unreadThreads: row?.unread_threads ?? 0,
    };
  }

  // ---- Emails: read -------------------------------------------------

  async getEmailRows(accountId: string, ids: string[]): Promise<Map<string, EmailRow>> {
    const out = new Map<string, EmailRow>();
    if (ids.length === 0) return out;

    const emailRows: Array<Record<string, unknown>> = [];
    const mbByEmail = new Map<string, string[]>();
    const kwByEmail = new Map<string, string[]>();
    for (const chunk of chunked(ids)) {
      const marks = chunk.map(() => "?").join(",");
      const [emails, mailboxes, keywords] = await this.db.batch<Record<string, unknown>>([
        this.db
          .prepare(`SELECT * FROM emails WHERE account_id = ? AND id IN (${marks})`)
          .bind(accountId, ...chunk),
        this.db
          .prepare(
            `SELECT email_id, mailbox_id FROM email_mailboxes
             WHERE account_id = ? AND email_id IN (${marks})`,
          )
          .bind(accountId, ...chunk),
        this.db
          .prepare(
            `SELECT email_id, keyword FROM email_keywords
             WHERE account_id = ? AND email_id IN (${marks})`,
          )
          .bind(accountId, ...chunk),
      ]);
      emailRows.push(...((emails?.results ?? []) as Array<Record<string, unknown>>));
      for (const r of (mailboxes?.results ?? []) as Array<{ email_id: string; mailbox_id: string }>) {
        (mbByEmail.get(r.email_id) ?? mbByEmail.set(r.email_id, []).get(r.email_id)!).push(
          r.mailbox_id,
        );
      }
      for (const r of (keywords?.results ?? []) as Array<{ email_id: string; keyword: string }>) {
        (kwByEmail.get(r.email_id) ?? kwByEmail.set(r.email_id, []).get(r.email_id)!).push(
          r.keyword,
        );
      }
    }

    for (const r of emailRows) {
      const id = r.id as string;
      out.set(id, {
        id,
        blobId: r.blob_id as string,
        threadId: r.thread_id as string,
        messageId: (r.message_id as string) ?? null,
        inReplyTo: (r.in_reply_to as string) ?? null,
        subject: r.subject as string,
        from: JSON.parse(r.from_json as string),
        to: JSON.parse(r.to_json as string),
        cc: JSON.parse(r.cc_json as string),
        bcc: JSON.parse(r.bcc_json as string),
        preview: r.preview as string,
        size: r.size as number,
        receivedAt: r.received_at as number,
        hasAttachment: (r.has_attachment as number) === 1,
        attachments: JSON.parse(r.attachments_json as string),
        mailboxIds: mbByEmail.get(id) ?? [],
        keywords: kwByEmail.get(id) ?? [],
      });
    }
    return out;
  }

  async getEmailRow(accountId: string, id: string): Promise<EmailRow | null> {
    return (await this.getEmailRows(accountId, [id])).get(id) ?? null;
  }

  /** Email/query → ordered id list (+ optional total). */
  async queryEmails(
    accountId: string,
    query: EmailQuery,
  ): Promise<{ ids: string[]; position: number; total?: number }> {
    const params: unknown[] = [accountId];
    const where = query.filter ? this.buildFilter(query.filter, params, accountId) : "1=1";

    const sort = (query.sort ?? [{ property: "receivedAt", isAscending: false }])
      .map((s) => `${SORT_COLUMNS[s.property] ?? "received_at"} ${s.isAscending ? "ASC" : "DESC"}`)
      .join(", ");

    const position = Math.max(0, query.position ?? 0);
    const limit = Math.min(Math.max(1, query.limit ?? 50), 256);

    const { results } = await this.db
      .prepare(
        `SELECT e.id FROM emails e WHERE e.account_id = ? AND (${where})
         ORDER BY ${sort} LIMIT ? OFFSET ?`,
      )
      .bind(...params, limit, position)
      .all<{ id: string }>();

    const out: { ids: string[]; position: number; total?: number } = {
      ids: results.map((r) => r.id),
      position,
    };

    if (query.calculateTotal) {
      const row = await this.db
        .prepare(`SELECT COUNT(*) AS n FROM emails e WHERE e.account_id = ? AND (${where})`)
        .bind(...params)
        .first<{ n: number }>();
      out.total = row?.n ?? 0;
    }
    return out;
  }

  private buildFilter(filter: EmailFilter, params: unknown[], accountId: string): string {
    if ("operator" in filter) {
      const parts = filter.conditions.map((c) => `(${this.buildFilter(c, params, accountId)})`);
      if (parts.length === 0) return "1=1";
      switch (filter.operator) {
        case "AND":
          return parts.join(" AND ");
        case "OR":
          return parts.join(" OR ");
        case "NOT":
          return `NOT (${parts.join(" OR ")})`;
      }
    }

    const clauses: string[] = [];
    const c = filter as EmailFilterCondition;
    if (c.inMailbox !== undefined) {
      clauses.push(
        `EXISTS (SELECT 1 FROM email_mailboxes em WHERE em.account_id = e.account_id
           AND em.email_id = e.id AND em.mailbox_id = ?)`,
      );
      params.push(c.inMailbox);
    }
    if (c.hasKeyword !== undefined) {
      clauses.push(
        `EXISTS (SELECT 1 FROM email_keywords k WHERE k.account_id = e.account_id
           AND k.email_id = e.id AND k.keyword = ?)`,
      );
      params.push(c.hasKeyword);
    }
    if (c.notKeyword !== undefined) {
      clauses.push(
        `NOT EXISTS (SELECT 1 FROM email_keywords k WHERE k.account_id = e.account_id
           AND k.email_id = e.id AND k.keyword = ?)`,
      );
      params.push(c.notKeyword);
    }
    if (c.text !== undefined) {
      // Full-text, over the FTS5 index that `insertEmail` maintains — subject,
      // addresses AND the message body (common/004). The subquery is
      // UNCORRELATED on purpose: SQLite materialises it once, so the MATCH runs
      // a single index lookup instead of once per candidate row. Written as
      // `e.id IN (…)` rather than a JOIN so it composes inside the AND/OR/NOT
      // tree above exactly like every other condition.
      const match = ftsMatchQuery(c.text);
      if (match !== null) {
        clauses.push(
          `e.id IN (SELECT m.email_id FROM emails_fts f
                      JOIN emails_fts_map m ON m.docid = f.rowid
                     WHERE emails_fts MATCH ? AND m.account_id = ?)`,
        );
        params.push(match, accountId);
      } else {
        // Nothing tokenizable — `"..."`, `-`, `!!!`. FTS5 cannot express that
        // query at all, so keep the old LIKE for it rather than inventing a
        // result. This is the ONLY surviving LIKE path for `text`.
        const like = `%${escapeLike(c.text)}%`;
        clauses.push(
          `(e.subject LIKE ? ESCAPE '\\' OR e.preview LIKE ? ESCAPE '\\'
            OR e.from_json LIKE ? ESCAPE '\\' OR e.to_json LIKE ? ESCAPE '\\')`,
        );
        params.push(like, like, like, like);
      }
    }
    if (c.from !== undefined) {
      clauses.push(`e.from_json LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(c.from)}%`);
    }
    if (c.to !== undefined) {
      clauses.push(`e.to_json LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(c.to)}%`);
    }
    if (c.subject !== undefined) {
      clauses.push(`e.subject LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(c.subject)}%`);
    }
    if (c.before !== undefined) {
      clauses.push(`e.received_at < ?`);
      params.push(Date.parse(c.before));
    }
    if (c.after !== undefined) {
      clauses.push(`e.received_at >= ?`);
      params.push(Date.parse(c.after));
    }
    if (c.hasAttachment !== undefined) {
      clauses.push(`e.has_attachment = ?`);
      params.push(c.hasAttachment ? 1 : 0);
    }
    if (c.minSize !== undefined) {
      clauses.push(`e.size >= ?`);
      params.push(c.minSize);
    }
    if (c.maxSize !== undefined) {
      clauses.push(`e.size <= ?`);
      params.push(c.maxSize);
    }
    return clauses.length > 0 ? clauses.join(" AND ") : "1=1";
  }

  // ---- Emails: write ------------------------------------------------

  async insertEmail(accountId: string, email: NewEmail): Promise<void> {
    const statements = [
      this.db
        .prepare(
          `INSERT INTO emails (id, account_id, blob_id, thread_id, message_id, in_reply_to,
             subject, from_json, to_json, cc_json, bcc_json, preview, size, received_at,
             has_attachment, attachments_json, ${PROVENANCE_COLUMNS})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          email.id,
          accountId,
          email.blobId,
          email.threadId,
          email.messageId,
          email.inReplyTo,
          email.subject,
          JSON.stringify(email.from),
          JSON.stringify(email.to),
          JSON.stringify(email.cc),
          JSON.stringify(email.bcc),
          email.preview,
          email.size,
          email.receivedAt,
          email.hasAttachment ? 1 : 0,
          JSON.stringify(email.attachments),
          ...this.provenanceValues(),
        ),
      ...email.mailboxIds.map((mb) =>
        this.db
          .prepare(
            `INSERT INTO email_mailboxes (account_id, email_id, mailbox_id) VALUES (?, ?, ?)`,
          )
          .bind(accountId, email.id, mb),
      ),
      ...email.keywords.map((kw) =>
        this.db
          .prepare(`INSERT INTO email_keywords (account_id, email_id, keyword) VALUES (?, ?, ?)`)
          .bind(accountId, email.id, kw),
      ),
      ...this.ftsIndexStatements(accountId, email.id, ftsTextOf(email)),
    ];
    await this.db.batch(statements);
  }

  /**
   * Statements that leave `emails_fts` holding exactly one up-to-date row for
   * this message. Delete-then-insert because a contentless FTS5 table has no
   * UPDATE; `INSERT OR IGNORE` on the map because re-indexing must reuse the
   * SAME docid it allocated the first time (otherwise the old index entries
   * are orphaned under a rowid nothing points at).
   *
   * All three are ordinary statements — no round trip to read the docid back —
   * so they ride inside the caller's existing `db.batch()` and inherit its
   * atomicity. If the batch rolls back, so does the index.
   *
   * Idempotent by construction, which is what makes the backfill safe to
   * re-run over a database that is already partly indexed.
   */
  private ftsIndexStatements(
    accountId: string,
    emailId: string,
    text: EmailFtsText,
  ): D1PreparedStatement[] {
    return [
      this.db
        .prepare(`INSERT OR IGNORE INTO emails_fts_map (account_id, email_id) VALUES (?, ?)`)
        .bind(accountId, emailId),
      this.db
        .prepare(
          `DELETE FROM emails_fts WHERE rowid IN
             (SELECT docid FROM emails_fts_map WHERE account_id = ? AND email_id = ?)`,
        )
        .bind(accountId, emailId),
      this.db
        .prepare(
          `INSERT INTO emails_fts (rowid, subject, from_text, to_text, body_text)
             SELECT docid, ?, ?, ?, ? FROM emails_fts_map
              WHERE account_id = ? AND email_id = ?`,
        )
        .bind(text.subject, text.fromText, text.toText, text.bodyText, accountId, emailId),
    ];
  }

  /** Statements that retract a message from the index. Safe if never indexed. */
  private ftsDeleteStatements(accountId: string, emailId: string): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          `DELETE FROM emails_fts WHERE rowid IN
             (SELECT docid FROM emails_fts_map WHERE account_id = ? AND email_id = ?)`,
        )
        .bind(accountId, emailId),
      this.db
        .prepare(`DELETE FROM emails_fts_map WHERE account_id = ? AND email_id = ?`)
        .bind(accountId, emailId),
    ];
  }

  /**
   * Re-index one already-stored message. The backfill path (see
   * `services/ingest` `POST /admin/fts/backfill`) — nothing in the request
   * path needs it, because `insertEmail` indexes as it writes.
   */
  async reindexEmailText(
    accountId: string,
    emailId: string,
    text: EmailFtsText,
  ): Promise<void> {
    await this.db.batch(this.ftsIndexStatements(accountId, emailId, text));
  }

  /**
   * Ids of stored messages with no `emails_fts_map` row — i.e. not indexed.
   *
   * The backfill's work queue, and the reason it is resumable: each pass
   * indexes what it takes, so the next call sees a strictly smaller set and an
   * interrupted run loses nothing. Ordered by `received_at DESC` so a run that
   * never finishes has still made the newest mail searchable.
   */
  async unindexedEmailIds(
    accountId: string | null,
    limit: number,
  ): Promise<Array<{ accountId: string; id: string }>> {
    const scope = accountId === null ? "" : "AND e.account_id = ?";
    const binds = accountId === null ? [limit] : [accountId, limit];
    const { results } = await this.db
      .prepare(
        `SELECT e.account_id, e.id FROM emails e
          WHERE NOT EXISTS (SELECT 1 FROM emails_fts_map m
                             WHERE m.account_id = e.account_id AND m.email_id = e.id)
            ${scope}
          ORDER BY e.received_at DESC LIMIT ?`,
      )
      .bind(...binds)
      .all<{ account_id: string; id: string }>();
    return results.map((r) => ({ accountId: r.account_id, id: r.id }));
  }

  /** How many stored messages are still missing from the index. */
  async unindexedEmailCount(accountId: string | null): Promise<number> {
    const scope = accountId === null ? "" : "AND e.account_id = ?";
    const binds = accountId === null ? [] : [accountId];
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM emails e
          WHERE NOT EXISTS (SELECT 1 FROM emails_fts_map m
                             WHERE m.account_id = e.account_id AND m.email_id = e.id)
            ${scope}`,
      )
      .bind(...binds)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Replace the full mailboxIds and/or keywords sets for an email. */
  async replaceEmailSets(
    accountId: string,
    emailId: string,
    sets: { mailboxIds?: string[]; keywords?: string[] },
  ): Promise<void> {
    const statements: D1PreparedStatement[] = [];
    if (sets.mailboxIds) {
      statements.push(
        this.db
          .prepare(`DELETE FROM email_mailboxes WHERE account_id = ? AND email_id = ?`)
          .bind(accountId, emailId),
        ...sets.mailboxIds.map((mb) =>
          this.db
            .prepare(
              `INSERT INTO email_mailboxes (account_id, email_id, mailbox_id) VALUES (?, ?, ?)`,
            )
            .bind(accountId, emailId, mb),
        ),
      );
    }
    if (sets.keywords) {
      statements.push(
        this.db
          .prepare(`DELETE FROM email_keywords WHERE account_id = ? AND email_id = ?`)
          .bind(accountId, emailId),
        ...sets.keywords.map((kw) =>
          this.db
            .prepare(`INSERT INTO email_keywords (account_id, email_id, keyword) VALUES (?, ?, ?)`)
            .bind(accountId, emailId, kw),
        ),
      );
    }
    if (statements.length > 0) {
      // A flag/move mutates the email's state through child tables, not the
      // `emails` row — so stamp provenance onto the email itself, or "who last
      // touched this message?" would miss every triage action.
      statements.push(
        this.db
          .prepare(
            `UPDATE emails
             SET last_writer_principal = ?, last_writer_binding = ?, last_writer_invocation = ?
             WHERE account_id = ? AND id = ?`,
          )
          .bind(...this.provenanceValues(), accountId, emailId),
      );
      await this.db.batch(statements);
    }
  }

  async destroyEmail(accountId: string, emailId: string): Promise<void> {
    // Blob is retained in R2 for now — content-hash blobs may be shared;
    // garbage collection is a separate sweep (TODO).
    await this.db.batch([
      this.db
        .prepare(`DELETE FROM email_mailboxes WHERE account_id = ? AND email_id = ?`)
        .bind(accountId, emailId),
      this.db
        .prepare(`DELETE FROM email_keywords WHERE account_id = ? AND email_id = ?`)
        .bind(accountId, emailId),
      // Before the `emails` row goes: an index entry that outlives its message
      // is a search result pointing at nothing, and the id could later be
      // matched against a different account's row.
      ...this.ftsDeleteStatements(accountId, emailId),
      this.db.prepare(`DELETE FROM emails WHERE account_id = ? AND id = ?`).bind(accountId, emailId),
    ]);
  }

  /** Resolve threadId: join by In-Reply-To / References, else new thread. */
  async resolveThreadId(accountId: string, inReplyTo: string | null): Promise<string> {
    if (inReplyTo) {
      const parent = await this.db
        .prepare(`SELECT thread_id FROM emails WHERE account_id = ? AND message_id = ?`)
        .bind(accountId, inReplyTo)
        .first<{ thread_id: string }>();
      if (parent) return parent.thread_id;
    }
    return `th_${crypto.randomUUID()}`;
  }

  // ---- Threads ------------------------------------------------------

  async getThreadEmailIds(accountId: string, threadId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id FROM emails WHERE account_id = ? AND thread_id = ?
         ORDER BY received_at ASC`,
      )
      .bind(accountId, threadId)
      .all<{ id: string }>();
    return results.map((r) => r.id);
  }

  // ---- Address books (JMAP Contacts, RFC 9610) ----------------------

  async getAddressBooks(accountId: string, ids?: string[]): Promise<AddressBookRow[]> {
    const cols = `id, name, description, sort_order, is_default, is_subscribed,
                  ctag, created_at, updated_at, write_policy`;
    type Row = {
      id: string;
      name: string;
      description: string | null;
      sort_order: number;
      is_default: number;
      is_subscribed: number;
      ctag: number;
      created_at: number;
      updated_at: number;
      write_policy: string | null;
    };
    const results: Row[] = [];
    if (ids && ids.length > 0) {
      for (const chunk of chunked(ids)) {
        const marks = chunk.map(() => "?").join(",");
        const { results: r } = await this.db
          .prepare(`SELECT ${cols} FROM address_books WHERE account_id = ? AND id IN (${marks})`)
          .bind(accountId, ...chunk)
          .all<Row>();
        results.push(...r);
      }
    } else {
      const { results: r } = await this.db
        .prepare(`SELECT ${cols} FROM address_books WHERE account_id = ? ORDER BY sort_order, name`)
        .bind(accountId)
        .all<Row>();
      results.push(...r);
    }
    return results.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      sortOrder: r.sort_order,
      isDefault: r.is_default === 1,
      isSubscribed: r.is_subscribed === 1,
      ctag: r.ctag,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      writePolicy: (r.write_policy as BookWritePolicy) ?? "open",
    }));
  }

  async insertAddressBook(accountId: string, book: AddressBookRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO address_books
           (id, account_id, name, description, sort_order, is_default, is_subscribed,
            ctag, created_at, updated_at, write_policy, ${PROVENANCE_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        book.id,
        accountId,
        book.name,
        book.description,
        book.sortOrder,
        book.isDefault ? 1 : 0,
        book.isSubscribed ? 1 : 0,
        book.ctag,
        book.createdAt,
        book.updatedAt,
        book.writePolicy ?? "open",
        ...this.provenanceValues(),
      )
      .run();
  }

  /**
   * Flip a book's write policy (s10 T1). Not reachable over JMAP/DAV in this
   * slice — governing books are marked by provisioning/operator tooling; the
   * chokepoint below is what makes the mark mean something.
   */
  async setAddressBookWritePolicy(
    accountId: string,
    id: string,
    policy: BookWritePolicy,
  ): Promise<void> {
    await this.db
      .prepare(`UPDATE address_books SET write_policy = ? WHERE account_id = ? AND id = ?`)
      .bind(policy, accountId, id)
      .run();
  }

  async updateAddressBook(
    accountId: string,
    id: string,
    patch: { name?: string; description?: string | null; sortOrder?: number; isSubscribed?: boolean },
  ): Promise<void> {
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [Date.now()];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      params.push(patch.name);
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      params.push(patch.description);
    }
    if (patch.sortOrder !== undefined) {
      sets.push("sort_order = ?");
      params.push(patch.sortOrder);
    }
    if (patch.isSubscribed !== undefined) {
      sets.push("is_subscribed = ?");
      params.push(patch.isSubscribed ? 1 : 0);
    }
    this.appendProvenance(sets, params);
    await this.db
      .prepare(`UPDATE address_books SET ${sets.join(", ")} WHERE account_id = ? AND id = ?`)
      .bind(...params, accountId, id)
      .run();
  }

  async deleteAddressBook(accountId: string, id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM address_books WHERE account_id = ? AND id = ?`)
      .bind(accountId, id)
      .run();
  }

  /** Make `id` the account's default book (clearing any previous default). */
  async setDefaultAddressBook(accountId: string, id: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(`UPDATE address_books SET is_default = 0 WHERE account_id = ? AND is_default = 1`)
        .bind(accountId),
      this.db
        .prepare(`UPDATE address_books SET is_default = 1 WHERE account_id = ? AND id = ?`)
        .bind(accountId, id),
    ]);
  }

  /**
   * Resolve the default address book, creating "Contacts" on first touch
   * (mirrors ensureRoleMailbox). If books exist but none is default —
   * e.g. the default was destroyed — the oldest is promoted.
   * Callers must commit the returned change to the account changelog.
   */
  async ensureDefaultAddressBook(
    accountId: string,
  ): Promise<{ id: string; change: "created" | "updated" | null }> {
    const existing = await this.db
      .prepare(`SELECT id FROM address_books WHERE account_id = ? AND is_default = 1`)
      .bind(accountId)
      .first<{ id: string }>();
    if (existing) return { id: existing.id, change: null };

    const oldest = await this.db
      .prepare(
        `SELECT id FROM address_books WHERE account_id = ? ORDER BY created_at LIMIT 1`,
      )
      .bind(accountId)
      .first<{ id: string }>();
    if (oldest) {
      await this.setDefaultAddressBook(accountId, oldest.id);
      return { id: oldest.id, change: "updated" };
    }

    const id = `ab_${crypto.randomUUID()}`;
    const now = Date.now();
    await this.insertAddressBook(accountId, {
      id,
      name: "Contacts",
      description: null,
      sortOrder: 0,
      isDefault: true,
      isSubscribed: true,
      ctag: 0,
      createdAt: now,
      updatedAt: now,
      writePolicy: "open",
    });
    return { id, change: "created" };
  }

  /**
   * Bump the DAV ctag of the given books (member changed). Deliberately
   * leaves updated_at alone — that tracks the book object itself.
   */
  async bumpAddressBookCtags(accountId: string, ids: Iterable<string>): Promise<void> {
    for (const chunk of chunked([...new Set(ids)])) {
      const marks = chunk.map(() => "?").join(",");
      await this.db
        .prepare(
          `UPDATE address_books SET ctag = ctag + 1 WHERE account_id = ? AND id IN (${marks})`,
        )
        .bind(accountId, ...chunk)
        .run();
    }
  }

  async cardIdsInBook(accountId: string, bookId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(`SELECT id FROM contact_cards WHERE account_id = ? AND address_book_id = ?`)
      .bind(accountId, bookId)
      .all<{ id: string }>();
    return results.map((r) => r.id);
  }

  // ---- Contact cards --------------------------------------------------

  async getContactCards(accountId: string, ids?: string[]): Promise<ContactCardRow[]> {
    const cols = `id, address_book_id, uid, card_json, name_full, dav_name, created_at, updated_at`;
    type Row = {
      id: string;
      address_book_id: string;
      uid: string;
      card_json: string;
      name_full: string | null;
      dav_name: string | null;
      created_at: number;
      updated_at: number;
    };
    const rows: Row[] = [];
    if (ids && ids.length > 0) {
      for (const chunk of chunked(ids)) {
        const marks = chunk.map(() => "?").join(",");
        const { results } = await this.db
          .prepare(`SELECT ${cols} FROM contact_cards WHERE account_id = ? AND id IN (${marks})`)
          .bind(accountId, ...chunk)
          .all<Row>();
        rows.push(...results);
      }
    } else {
      const { results } = await this.db
        .prepare(`SELECT ${cols} FROM contact_cards WHERE account_id = ? ORDER BY name_full, id`)
        .bind(accountId)
        .all<Row>();
      rows.push(...results);
    }
    return rows.map((r) => ({
      id: r.id,
      addressBookId: r.address_book_id,
      uid: r.uid,
      card: JSON.parse(r.card_json) as JSContactCard,
      nameFull: r.name_full,
      davName: r.dav_name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** Resolve a CardDAV resource inside a book: dav_name first, id fallback. */
  async getCardByDavName(
    accountId: string,
    bookId: string,
    resourceName: string,
  ): Promise<ContactCardRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id FROM contact_cards
         WHERE account_id = ? AND address_book_id = ? AND (dav_name = ? OR id = ?)
         LIMIT 1`,
      )
      .bind(accountId, bookId, resourceName, resourceName)
      .first<{ id: string }>();
    if (!row) return null;
    return (await this.getContactCards(accountId, [row.id]))[0] ?? null;
  }

  /**
   * Column-only card refs — no card_json read/parse. Serving skinny
   * ContactCard/get requests (sync scans: id/uid/addressBookIds) from
   * columns keeps big photo blobs out of the Worker CPU budget.
   */
  async getContactCardRefs(
    accountId: string,
    ids?: string[],
  ): Promise<
    Array<{ id: string; addressBookId: string; uid: string; davName: string | null; updatedAt: number }>
  > {
    type Row = {
      id: string;
      address_book_id: string;
      uid: string;
      dav_name: string | null;
      updated_at: number;
    };
    const cols = `id, address_book_id, uid, dav_name, updated_at`;
    const rows: Row[] = [];
    if (ids && ids.length > 0) {
      for (const chunk of chunked(ids)) {
        const marks = chunk.map(() => "?").join(",");
        const { results } = await this.db
          .prepare(`SELECT ${cols} FROM contact_cards WHERE account_id = ? AND id IN (${marks})`)
          .bind(accountId, ...chunk)
          .all<Row>();
        rows.push(...results);
      }
    } else {
      const { results } = await this.db
        .prepare(`SELECT ${cols} FROM contact_cards WHERE account_id = ? ORDER BY name_full, id`)
        .bind(accountId)
        .all<Row>();
      rows.push(...results);
    }
    return rows.map((r) => ({
      id: r.id,
      addressBookId: r.address_book_id,
      uid: r.uid,
      davName: r.dav_name,
      updatedAt: r.updated_at,
    }));
  }

  /** Refs for every card in one book (DAV listings / initial sync). */
  async cardRefsInBook(
    accountId: string,
    bookId: string,
  ): Promise<Array<{ id: string; uid: string; davName: string | null; updatedAt: number }>> {
    const { results } = await this.db
      .prepare(
        `SELECT id, uid, dav_name, updated_at FROM contact_cards
         WHERE account_id = ? AND address_book_id = ? ORDER BY id`,
      )
      .bind(accountId, bookId)
      .all<{ id: string; uid: string; dav_name: string | null; updated_at: number }>();
    return results.map((r) => ({
      id: r.id,
      uid: r.uid,
      davName: r.dav_name,
      updatedAt: r.updated_at,
    }));
  }

  /** Id of the card holding `uid`, if any (RFC 9610: uid unique per account). */
  async contactCardIdByUid(accountId: string, uid: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT id FROM contact_cards WHERE account_id = ? AND uid = ?`)
      .bind(accountId, uid)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  /** Batch uid → id lookup — one query per 90 uids, not one per card. */
  async contactCardIdsByUids(accountId: string, uids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const chunk of chunked(uids)) {
      const marks = chunk.map(() => "?").join(",");
      const { results } = await this.db
        .prepare(`SELECT id, uid FROM contact_cards WHERE account_id = ? AND uid IN (${marks})`)
        .bind(accountId, ...chunk)
        .all<{ id: string; uid: string }>();
      for (const r of results) out.set(r.uid, r.id);
    }
    return out;
  }

  async insertContactCard(accountId: string, row: ContactCardRow, writer: ContactWriter): Promise<void> {
    await this.insertContactCards(accountId, [row], writer);
  }

  /**
   * One transactional db.batch — bulk imports must not pay per-card D1 calls.
   *
   * THE CHOKEPOINT (s10 T1/T2). Every contact-write path — JMAP
   * `ContactCard/set`, CardDAV PUT/DELETE, MCP `contacts_*` and the CLI, which
   * all funnel here — is policy-gated ONCE, in this class, so a fifth protocol
   * added later cannot silently bypass the bound. `writer` is required: the
   * gate turns on `writer.kind`, and the membership chain rows (T2) it emits
   * ride IN THE SAME batch as the card write — card + chain commit together or
   * neither.
   */
  async insertContactCards(
    accountId: string,
    rows: ContactCardRow[],
    writer: ContactWriter,
  ): Promise<void> {
    if (rows.length === 0) return;
    const chain = await this.governContactWrites(
      accountId,
      writer,
      rows.map((row) => ({ op: "insert" as const, next: row })),
    );
    await this.db.batch([
      ...rows.map((row) =>
        this.db
          .prepare(
            `INSERT INTO contact_cards
               (id, account_id, address_book_id, uid, card_json, name_full, dav_name,
                created_at, updated_at, ${PROVENANCE_COLUMNS})
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            row.id,
            accountId,
            row.addressBookId,
            row.uid,
            JSON.stringify(row.card),
            row.nameFull,
            row.davName,
            row.createdAt,
            row.updatedAt,
            ...this.provenanceValues(),
          ),
      ),
      ...chain,
    ]);
  }

  async updateContactCard(
    accountId: string,
    row: ContactCardRow,
    writer: ContactWriter,
  ): Promise<void> {
    const chain = await this.governContactWrites(accountId, writer, [
      { op: "update", next: row },
    ]);
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE contact_cards
           SET address_book_id = ?, card_json = ?, name_full = ?, dav_name = ?, updated_at = ?,
               last_writer_principal = ?, last_writer_binding = ?, last_writer_invocation = ?
           WHERE account_id = ? AND id = ?`,
        )
        .bind(
          row.addressBookId,
          JSON.stringify(row.card),
          row.nameFull,
          row.davName,
          row.updatedAt,
          ...this.provenanceValues(),
          accountId,
          row.id,
        ),
      ...chain,
    ]);
  }

  async destroyContactCard(accountId: string, id: string, writer: ContactWriter): Promise<void> {
    await this.destroyContactCards(accountId, [id], writer);
  }

  /**
   * Bulk destroy with DAV tombstones: sync-collection must answer
   * deletions with the resource name a client knew, and the changelog
   * only keeps ids. Batched — a whole-book cascade stays within the
   * per-request budget. Deletion is a CHAIN EVENT (s10 T2): an unlogged
   * remove puts a hole in the membership chain exactly where someone
   * would want one, so the `removed` rows commit with the DELETE.
   */
  async destroyContactCards(
    accountId: string,
    ids: string[],
    writer: ContactWriter,
  ): Promise<void> {
    const now = Date.now();
    for (const chunk of chunked(ids)) {
      const marks = chunk.map(() => "?").join(",");
      const { results } = await this.db
        .prepare(
          `SELECT id, address_book_id, uid, card_json, dav_name FROM contact_cards
           WHERE account_id = ? AND id IN (${marks})`,
        )
        .bind(accountId, ...chunk)
        .all<{
          id: string;
          address_book_id: string;
          uid: string;
          card_json: string;
          dav_name: string | null;
        }>();
      if (results.length === 0) continue;
      const chain = await this.governContactWrites(
        accountId,
        writer,
        results.map((r) => ({ op: "destroy" as const, prevRow: r })),
      );
      await this.db.batch([
        ...results.map((r) =>
          this.db
            .prepare(
              `INSERT OR REPLACE INTO dav_tombstones
                 (account_id, collection_id, item_id, resource_name, deleted_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(accountId, r.address_book_id, r.id, r.dav_name ?? r.id, now),
        ),
        this.db
          .prepare(
            `DELETE FROM contact_cards WHERE account_id = ? AND id IN (${results
              .map(() => "?")
              .join(",")})`,
          )
          .bind(accountId, ...results.map((r) => r.id)),
        ...chain,
      ]);
    }
  }

  // ---- the write-policy gate + membership chain (s10 T1/T2) -----------

  /**
   * Books whose policy is not 'open', i.e. the only books governance work
   * applies to. Empty map (the overwhelmingly common case) short-circuits the
   * whole engine, so ungoverned accounts pay one indexed SELECT per write.
   * The value filter is deliberate: only the two known non-open policies
   * activate the engine — an unknown value written by a future version does
   * not half-run today's rules.
   */
  private async nonOpenBookPolicies(
    accountId: string,
  ): Promise<Map<string, Exclude<BookWritePolicy, "open">>> {
    const { results } = await this.db
      .prepare(
        `SELECT id, write_policy FROM address_books
         WHERE account_id = ? AND write_policy != 'open'`,
      )
      .bind(accountId)
      .all<{ id: string; write_policy: string }>();
    const out = new Map<string, Exclude<BookWritePolicy, "open">>();
    for (const r of results) {
      if (r.write_policy === "propose" || r.write_policy === "governed") {
        out.set(r.id, r.write_policy);
      }
    }
    return out;
  }

  /**
   * Enforce write policy and build the membership-chain INSERTs for a set of
   * card writes. Returns statements the caller MUST include in the same
   * db.batch as the card writes (T2 atomicity). Throws `BookWriteRefused`
   * before anything is written when the policy refuses the writer.
   *
   * A write "touches" a non-open book when the card lives (or lands) in it,
   * OR when a group in such a book references the card's uid — the latter is
   * the viral-reference rule: membership of a governed book must not be
   * widenable by editing a member card parked in an open book.
   */
  private async governContactWrites(
    accountId: string,
    writer: ContactWriter,
    changes: Array<
      | { op: "insert"; next: ContactCardRow }
      | { op: "update"; next: ContactCardRow }
      | {
          op: "destroy";
          prevRow: { id: string; address_book_id: string; uid: string; card_json: string };
        }
    >,
  ): Promise<D1PreparedStatement[]> {
    const policies = await this.nonOpenBookPolicies(accountId);
    if (policies.size === 0) return [];

    const now = Date.now();
    const authorized =
      typeof writer.authorization?.proposalId === "string" &&
      writer.authorization.proposalId.length > 0;
    const stmts: D1PreparedStatement[] = [];

    // One `uid → old card` read for the update ops (the delta needs it).
    const updateIds = changes.flatMap((c) => (c.op === "update" ? [c.next.id] : []));
    const prevById = new Map<string, ContactCardRow>();
    if (updateIds.length > 0) {
      for (const prev of await this.getContactCards(accountId, updateIds)) {
        prevById.set(prev.id, prev);
      }
    }

    // Policy 'propose'/'governed': humans write through (devPlan decision 4);
    // agents are refused unless the write carries a proposal id. The store
    // cannot know WHICH binding a book governs, so the self-write rule (the
    // governed agent never writes its own book, authorization or not) is
    // enforced in services/agent where binding identity is known.
    const enforce = (bookId: string): void => {
      const policy = policies.get(bookId);
      if (!policy) return;
      if (writer.kind === "agent" && !authorized) throw refusedDirectWrite(policy, bookId);
    };

    const emit = (
      bookId: string,
      event: "added" | "removed",
      addresses: Iterable<string>,
      card: { id: string; uid: string },
    ): void => {
      for (const address of addresses) {
        stmts.push(
          this.db
            .prepare(
              `INSERT INTO book_membership_log
                 (account_id, book_id, event, address, card_id, uid, actor, via_proposal_id, at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              accountId,
              bookId,
              event,
              address,
              card.id,
              card.uid,
              writer.principal,
              writer.authorization?.proposalId ?? null,
              now,
            ),
        );
      }
    };

    for (const change of changes) {
      const prev =
        change.op === "update"
          ? (prevById.get(change.next.id) ?? null)
          : change.op === "destroy"
            ? {
                id: change.prevRow.id,
                addressBookId: change.prevRow.address_book_id,
                uid: change.prevRow.uid,
                card: JSON.parse(change.prevRow.card_json) as JSContactCard,
              }
            : null;
      const next = change.op === "destroy" ? null : change.next;
      const uid = (next ?? prev)!.uid;
      const cardRef = { id: (next ?? prev)!.id, uid };

      // -- enforcement over every touched non-open book --
      if (next) enforce(next.addressBookId);
      if (prev && prev.addressBookId !== next?.addressBookId) enforce(prev.addressBookId);
      const referencing = await this.referencingGroups(accountId, uid, policies, cardRef.id);
      for (const g of referencing) enforce(g.bookId);

      // -- nested groups are refused into a governed book: adding one member
      //    to a nested group would widen an agent without touching its list --
      if (next && policies.get(next.addressBookId) === "governed" && next.card.kind === "group") {
        const memberUids = cardMemberUids(next.card);
        if (memberUids.length > 0) {
          const members = await this.cardsByUids(accountId, memberUids);
          for (const memberUid of memberUids) {
            if (members.get(memberUid)?.kind === "group") {
              throw refusedNestedGroup(next.addressBookId, memberUid);
            }
          }
        }
      }

      // -- chain rows: the card's own contribution to its book(s) --
      const prevContribution = prev ? await this.contributionOf(accountId, prev.card) : new Set<string>();
      const nextContribution = next ? await this.contributionOf(accountId, next.card) : new Set<string>();
      const prevBook = prev && policies.has(prev.addressBookId) ? prev.addressBookId : null;
      const nextBook = next && policies.has(next.addressBookId) ? next.addressBookId : null;
      if (prevBook !== null && prevBook === nextBook) {
        const delta = contributionDelta(prevContribution, nextContribution);
        emit(prevBook, "added", delta.added, cardRef);
        emit(prevBook, "removed", delta.removed, cardRef);
      } else {
        if (prevBook !== null) emit(prevBook, "removed", prevContribution, cardRef);
        if (nextBook !== null) emit(nextBook, "added", nextContribution, cardRef);
      }

      // -- chain rows: groups in non-open books referencing this uid — their
      //    contribution shifts by exactly this card's change --
      for (const g of referencing) {
        const before = await this.contributionOf(accountId, g.card, {
          uid,
          card: prev?.card ?? null,
        });
        const after = await this.contributionOf(accountId, g.card, {
          uid,
          card: next?.card ?? null,
        });
        const delta = contributionDelta(before, after);
        emit(g.bookId, "added", delta.added, cardRef);
        emit(g.bookId, "removed", delta.removed, cardRef);
      }
    }
    return stmts;
  }

  /** Group cards in non-open books whose `members` reference `uid`. */
  private async referencingGroups(
    accountId: string,
    uid: string,
    policies: Map<string, Exclude<BookWritePolicy, "open">>,
    excludeCardId: string,
  ): Promise<Array<{ bookId: string; card: JSContactCard }>> {
    const marks = [...policies.keys()].map(() => "?").join(",");
    const { results } = await this.db
      .prepare(
        // `c` alias: jsonMapExists (the ContactCard/query hasMember helper)
        // hardcodes it.
        `SELECT c.id, c.address_book_id, c.card_json FROM contact_cards c
         WHERE c.account_id = ? AND c.address_book_id IN (${marks})
           AND ${jsonMapExists("$.members", "je.key = ?")}`,
      )
      .bind(accountId, ...policies.keys(), uid)
      .all<{ id: string; address_book_id: string; card_json: string }>();
    return results
      .filter((r) => r.id !== excludeCardId)
      .map((r) => ({
        bookId: r.address_book_id,
        card: JSON.parse(r.card_json) as JSContactCard,
      }));
  }

  /** uid → card for a set of uids (member resolution, chunked). */
  private async cardsByUids(accountId: string, uids: string[]): Promise<Map<string, JSContactCard>> {
    const out = new Map<string, JSContactCard>();
    for (const chunk of chunked([...new Set(uids)])) {
      const marks = chunk.map(() => "?").join(",");
      const { results } = await this.db
        .prepare(
          `SELECT uid, card_json FROM contact_cards WHERE account_id = ? AND uid IN (${marks})`,
        )
        .bind(accountId, ...chunk)
        .all<{ uid: string; card_json: string }>();
      for (const r of results) out.set(r.uid, JSON.parse(r.card_json) as JSContactCard);
    }
    return out;
  }

  /**
   * The addresses `card` contributes to a book: its own emails plus, for a
   * group, one level of member expansion. `override` substitutes one member's
   * card (or its absence) so a referencing group's before/after contribution
   * can be computed around a member write without re-reading the world.
   */
  private async contributionOf(
    accountId: string,
    card: JSContactCard,
    override?: { uid: string; card: JSContactCard | null },
  ): Promise<Set<string>> {
    const memberUids = cardMemberUids(card);
    const resolved =
      memberUids.length > 0 ? await this.cardsByUids(accountId, memberUids) : new Map<string, JSContactCard>();
    if (override) {
      if (override.card === null) resolved.delete(override.uid);
      else resolved.set(override.uid, override.card);
    }
    return cardContribution(card, (uid) => resolved.get(uid) ?? null);
  }

  /**
   * A book's effective membership — the outbound allowlist the send gate and
   * the fold-reconciliation invariant both read. Cards' own emails plus one
   * level of group-member expansion (resolved account-wide by uid; a nested
   * group contributes nothing — fail-closed). Normalized lowercase; matching
   * against it must be EXACT equality, never LIKE.
   */
  async bookMembership(accountId: string, bookId: string): Promise<Set<string>> {
    const { results } = await this.db
      .prepare(`SELECT card_json FROM contact_cards WHERE account_id = ? AND address_book_id = ?`)
      .bind(accountId, bookId)
      .all<{ card_json: string }>();
    const members = new Set<string>();
    const memberUids: string[] = [];
    const groups: JSContactCard[] = [];
    for (const r of results) {
      const card = JSON.parse(r.card_json) as JSContactCard;
      for (const a of cardOwnEmails(card)) members.add(a);
      const uids = cardMemberUids(card);
      if (uids.length > 0) {
        groups.push(card);
        memberUids.push(...uids);
      }
    }
    if (groups.length > 0) {
      const resolved = await this.cardsByUids(accountId, memberUids);
      for (const g of groups) {
        for (const a of cardContribution(g, (uid) => resolved.get(uid) ?? null)) members.add(a);
      }
    }
    return members;
  }

  /** The membership chain of one book, oldest first (reconciliation input). */
  async bookMembershipLog(
    accountId: string,
    bookId: string,
  ): Promise<
    Array<{
      id: number;
      event: "added" | "removed";
      address: string;
      cardId: string | null;
      uid: string | null;
      actor: string | null;
      viaProposalId: string | null;
      at: number;
    }>
  > {
    const { results } = await this.db
      .prepare(
        `SELECT id, event, address, card_id, uid, actor, via_proposal_id, at
         FROM book_membership_log WHERE account_id = ? AND book_id = ? ORDER BY id`,
      )
      .bind(accountId, bookId)
      .all<{
        id: number;
        event: string;
        address: string;
        card_id: string | null;
        uid: string | null;
        actor: string | null;
        via_proposal_id: string | null;
        at: number;
      }>();
    return results.map((r) => ({
      id: r.id,
      event: r.event as "added" | "removed",
      address: r.address,
      cardId: r.card_id,
      uid: r.uid,
      actor: r.actor,
      viaProposalId: r.via_proposal_id,
      at: r.at,
    }));
  }

  /** resource names for destroyed card ids (sync-collection 404s). */
  async tombstoneNames(
    accountId: string,
    ids: string[],
  ): Promise<Map<string, { resourceName: string; collectionId: string }>> {
    const out = new Map<string, { resourceName: string; collectionId: string }>();
    for (const chunk of chunked(ids)) {
      const marks = chunk.map(() => "?").join(",");
      const { results } = await this.db
        .prepare(
          `SELECT item_id, resource_name, collection_id FROM dav_tombstones
           WHERE account_id = ? AND item_id IN (${marks})`,
        )
        .bind(accountId, ...chunk)
        .all<{ item_id: string; resource_name: string; collection_id: string }>();
      for (const r of results) {
        out.set(r.item_id, { resourceName: r.resource_name, collectionId: r.collection_id });
      }
    }
    return out;
  }

  /** Age out tombstones the DO changelog can no longer reference. */
  async pruneTombstones(accountId: string, olderThanMs: number): Promise<void> {
    await this.db
      .prepare(`DELETE FROM dav_tombstones WHERE account_id = ? AND deleted_at < ?`)
      .bind(accountId, Date.now() - olderThanMs)
      .run();
  }

  /** ContactCard/query → ordered id list (+ optional total). */
  async queryContactCards(
    accountId: string,
    query: ContactQuery,
  ): Promise<{ ids: string[]; position: number; total?: number }> {
    const params: unknown[] = [accountId];
    let where = query.filter ? this.buildContactFilter(query.filter, params) : "1=1";
    if (query.restrictToBooks) {
      const books = query.restrictToBooks.slice(0, MAX_BINDS);
      if (books.length === 0) return { ids: [], position: 0, ...(query.calculateTotal ? { total: 0 } : {}) };
      where = `(${where}) AND c.address_book_id IN (${books.map(() => "?").join(",")})`;
      params.push(...books);
    }

    const sort = (query.sort ?? [{ property: "name", isAscending: true }])
      .map(
        (s) =>
          `${CONTACT_SORT_COLUMNS[s.property] ?? "c.name_full"} ${s.isAscending ? "ASC" : "DESC"}`,
      )
      .join(", ");

    const position = Math.max(0, query.position ?? 0);
    const limit = Math.min(Math.max(1, query.limit ?? 100), 256);

    const { results } = await this.db
      .prepare(
        `SELECT c.id FROM contact_cards c WHERE c.account_id = ? AND (${where})
         ORDER BY ${sort}, c.id LIMIT ? OFFSET ?`,
      )
      .bind(...params, limit, position)
      .all<{ id: string }>();

    const out: { ids: string[]; position: number; total?: number } = {
      ids: results.map((r) => r.id),
      position,
    };

    if (query.calculateTotal) {
      const row = await this.db
        .prepare(`SELECT COUNT(*) AS n FROM contact_cards c WHERE c.account_id = ? AND (${where})`)
        .bind(...params)
        .first<{ n: number }>();
      out.total = row?.n ?? 0;
    }
    return out;
  }

  private buildContactFilter(filter: ContactFilter, params: unknown[]): string {
    if ("operator" in filter) {
      const parts = filter.conditions.map((c) => `(${this.buildContactFilter(c, params)})`);
      if (parts.length === 0) return "1=1";
      switch (filter.operator) {
        case "AND":
          return parts.join(" AND ");
        case "OR":
          return parts.join(" OR ");
        case "NOT":
          return `NOT (${parts.join(" OR ")})`;
      }
    }

    const clauses: string[] = [];
    const c = filter as ContactFilterCondition;
    if (c.inAddressBook !== undefined) {
      clauses.push(`c.address_book_id = ?`);
      params.push(c.inAddressBook);
    }
    if (c.uid !== undefined) {
      clauses.push(`c.uid = ?`);
      params.push(c.uid);
    }
    if (c.kind !== undefined) {
      // JSContact defaults kind to "individual" when absent.
      clauses.push(`COALESCE(json_extract(c.card_json, '$.kind'), 'individual') = ?`);
      params.push(c.kind);
    }
    if (c.hasMember !== undefined) {
      clauses.push(jsonMapExists("$.members", `je.key = ?`));
      params.push(c.hasMember);
    }
    if (c.createdBefore !== undefined) {
      clauses.push(`c.created_at < ?`);
      params.push(Date.parse(c.createdBefore));
    }
    if (c.createdAfter !== undefined) {
      clauses.push(`c.created_at >= ?`);
      params.push(Date.parse(c.createdAfter));
    }
    if (c.updatedBefore !== undefined) {
      clauses.push(`c.updated_at < ?`);
      params.push(Date.parse(c.updatedBefore));
    }
    if (c.updatedAfter !== undefined) {
      clauses.push(`c.updated_at >= ?`);
      params.push(Date.parse(c.updatedAfter));
    }
    // Substring matchers. Each targets the RFC-named properties via
    // json_each so a query for "phone" can't false-positive on the JSON
    // key "phones" the way a raw card_json LIKE would.
    if (c.name !== undefined) clauses.push(nameClause(params, c.name));
    if (c.nickname !== undefined) {
      clauses.push(jsonMapLike("$.nicknames", ["$.name"], params, c.nickname));
    }
    if (c.organization !== undefined) {
      clauses.push(jsonMapLike("$.organizations", ["$.name"], params, c.organization));
    }
    if (c.email !== undefined) {
      clauses.push(jsonMapLike("$.emails", ["$.address", "$.label"], params, c.email));
    }
    if (c.phone !== undefined) {
      clauses.push(jsonMapLike("$.phones", ["$.number", "$.label"], params, c.phone));
    }
    if (c.note !== undefined) {
      clauses.push(jsonMapLike("$.notes", ["$.note"], params, c.note));
    }
    if (c.text !== undefined) {
      clauses.push(
        `(${[
          nameClause(params, c.text),
          jsonMapLike("$.nicknames", ["$.name"], params, c.text),
          jsonMapLike("$.organizations", ["$.name"], params, c.text),
          jsonMapLike("$.emails", ["$.address", "$.label"], params, c.text),
          jsonMapLike("$.phones", ["$.number", "$.label"], params, c.text),
          jsonMapLike("$.notes", ["$.note"], params, c.text),
        ].join(" OR ")})`,
      );
    }
    return clauses.length > 0 ? clauses.join(" AND ") : "1=1";
  }

  // ---- Calendars (JSCalendar-on-JMAP, Phase 4) -----------------------

  async getCalendars(accountId: string, ids?: string[]): Promise<CalendarRow[]> {
    const cols = `id, name, description, color, sort_order, is_default, is_subscribed,
                  ctag, created_at, updated_at`;
    type Row = {
      id: string;
      name: string;
      description: string | null;
      color: string | null;
      sort_order: number;
      is_default: number;
      is_subscribed: number;
      ctag: number;
      created_at: number;
      updated_at: number;
    };
    const results: Row[] = [];
    if (ids && ids.length > 0) {
      for (const chunk of chunked(ids)) {
        const marks = chunk.map(() => "?").join(",");
        const { results: r } = await this.db
          .prepare(`SELECT ${cols} FROM calendars WHERE account_id = ? AND id IN (${marks})`)
          .bind(accountId, ...chunk)
          .all<Row>();
        results.push(...r);
      }
    } else {
      const { results: r } = await this.db
        .prepare(`SELECT ${cols} FROM calendars WHERE account_id = ? ORDER BY sort_order, name`)
        .bind(accountId)
        .all<Row>();
      results.push(...r);
    }
    return results.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      color: r.color,
      sortOrder: r.sort_order,
      isDefault: r.is_default === 1,
      isSubscribed: r.is_subscribed === 1,
      ctag: r.ctag,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async insertCalendar(accountId: string, cal: CalendarRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO calendars
           (id, account_id, name, description, color, sort_order, is_default, is_subscribed,
            ctag, created_at, updated_at, ${PROVENANCE_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        cal.id,
        accountId,
        cal.name,
        cal.description,
        cal.color,
        cal.sortOrder,
        cal.isDefault ? 1 : 0,
        cal.isSubscribed ? 1 : 0,
        cal.ctag,
        cal.createdAt,
        cal.updatedAt,
        ...this.provenanceValues(),
      )
      .run();
  }

  async updateCalendar(
    accountId: string,
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      color?: string | null;
      sortOrder?: number;
      isSubscribed?: boolean;
    },
  ): Promise<void> {
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [Date.now()];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      params.push(patch.name);
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      params.push(patch.description);
    }
    if (patch.color !== undefined) {
      sets.push("color = ?");
      params.push(patch.color);
    }
    if (patch.sortOrder !== undefined) {
      sets.push("sort_order = ?");
      params.push(patch.sortOrder);
    }
    if (patch.isSubscribed !== undefined) {
      sets.push("is_subscribed = ?");
      params.push(patch.isSubscribed ? 1 : 0);
    }
    this.appendProvenance(sets, params);
    await this.db
      .prepare(`UPDATE calendars SET ${sets.join(", ")} WHERE account_id = ? AND id = ?`)
      .bind(...params, accountId, id)
      .run();
  }

  async deleteCalendar(accountId: string, id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM calendars WHERE account_id = ? AND id = ?`)
      .bind(accountId, id)
      .run();
  }

  async setDefaultCalendar(accountId: string, id: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(`UPDATE calendars SET is_default = 0 WHERE account_id = ? AND is_default = 1`)
        .bind(accountId),
      this.db
        .prepare(`UPDATE calendars SET is_default = 1 WHERE account_id = ? AND id = ?`)
        .bind(accountId, id),
    ]);
  }

  /** Resolve the default calendar, creating "Calendar" on first touch. */
  async ensureDefaultCalendar(
    accountId: string,
  ): Promise<{ id: string; change: "created" | "updated" | null }> {
    const existing = await this.db
      .prepare(`SELECT id FROM calendars WHERE account_id = ? AND is_default = 1`)
      .bind(accountId)
      .first<{ id: string }>();
    if (existing) return { id: existing.id, change: null };
    const oldest = await this.db
      .prepare(`SELECT id FROM calendars WHERE account_id = ? ORDER BY created_at LIMIT 1`)
      .bind(accountId)
      .first<{ id: string }>();
    if (oldest) {
      await this.setDefaultCalendar(accountId, oldest.id);
      return { id: oldest.id, change: "updated" };
    }
    const id = `cal_${crypto.randomUUID()}`;
    const now = Date.now();
    await this.insertCalendar(accountId, {
      id,
      name: "Calendar",
      description: null,
      color: null,
      sortOrder: 0,
      isDefault: true,
      isSubscribed: true,
      ctag: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { id, change: "created" };
  }

  async bumpCalendarCtags(accountId: string, ids: Iterable<string>): Promise<void> {
    for (const chunk of chunked([...new Set(ids)])) {
      const marks = chunk.map(() => "?").join(",");
      await this.db
        .prepare(`UPDATE calendars SET ctag = ctag + 1 WHERE account_id = ? AND id IN (${marks})`)
        .bind(accountId, ...chunk)
        .run();
    }
  }

  async eventIdsInCalendar(accountId: string, calendarId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(`SELECT id FROM calendar_events WHERE account_id = ? AND calendar_id = ?`)
      .bind(accountId, calendarId)
      .all<{ id: string }>();
    return results.map((r) => r.id);
  }

  // ---- Calendar events -----------------------------------------------

  async getCalendarEvents(accountId: string, ids?: string[]): Promise<CalendarEventRow[]> {
    const cols = `id, calendar_id, uid, event_json, title, start_at, end_at, is_recurring,
                  dav_name, created_at, updated_at`;
    type Row = {
      id: string;
      calendar_id: string;
      uid: string;
      event_json: string;
      title: string | null;
      start_at: number | null;
      end_at: number | null;
      is_recurring: number;
      dav_name: string | null;
      created_at: number;
      updated_at: number;
    };
    const rows: Row[] = [];
    if (ids && ids.length > 0) {
      for (const chunk of chunked(ids)) {
        const marks = chunk.map(() => "?").join(",");
        const { results } = await this.db
          .prepare(`SELECT ${cols} FROM calendar_events WHERE account_id = ? AND id IN (${marks})`)
          .bind(accountId, ...chunk)
          .all<Row>();
        rows.push(...results);
      }
    } else {
      const { results } = await this.db
        .prepare(`SELECT ${cols} FROM calendar_events WHERE account_id = ? ORDER BY start_at, id`)
        .bind(accountId)
        .all<Row>();
      rows.push(...results);
    }
    return rows.map((r) => ({
      id: r.id,
      calendarId: r.calendar_id,
      uid: r.uid,
      event: JSON.parse(r.event_json) as JSCalendarEventBlob,
      title: r.title,
      startAt: r.start_at,
      endAt: r.end_at,
      isRecurring: r.is_recurring === 1,
      davName: r.dav_name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async calendarEventIdsByUids(accountId: string, uids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const chunk of chunked(uids)) {
      const marks = chunk.map(() => "?").join(",");
      const { results } = await this.db
        .prepare(`SELECT id, uid FROM calendar_events WHERE account_id = ? AND uid IN (${marks})`)
        .bind(accountId, ...chunk)
        .all<{ id: string; uid: string }>();
      for (const r of results) out.set(r.uid, r.id);
    }
    return out;
  }

  async insertCalendarEvents(accountId: string, rows: CalendarEventRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.batch(
      rows.map((row) =>
        this.db
          .prepare(
            `INSERT INTO calendar_events
               (id, account_id, calendar_id, uid, event_json, title, start_at, end_at,
                is_recurring, dav_name, created_at, updated_at, ${PROVENANCE_COLUMNS})
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            row.id,
            accountId,
            row.calendarId,
            row.uid,
            JSON.stringify(row.event),
            row.title,
            row.startAt,
            row.endAt,
            row.isRecurring ? 1 : 0,
            row.davName,
            row.createdAt,
            row.updatedAt,
            ...this.provenanceValues(),
          ),
      ),
    );
  }

  async updateCalendarEvent(accountId: string, row: CalendarEventRow): Promise<void> {
    await this.db
      .prepare(
        `UPDATE calendar_events
         SET calendar_id = ?, event_json = ?, title = ?, start_at = ?, end_at = ?,
             is_recurring = ?, dav_name = ?, updated_at = ?,
             last_writer_principal = ?, last_writer_binding = ?, last_writer_invocation = ?
         WHERE account_id = ? AND id = ?`,
      )
      .bind(
        row.calendarId,
        JSON.stringify(row.event),
        row.title,
        row.startAt,
        row.endAt,
        row.isRecurring ? 1 : 0,
        row.davName,
        row.updatedAt,
        ...this.provenanceValues(),
        accountId,
        row.id,
      )
      .run();
  }

  /** Bulk destroy with DAV tombstones (same contract as contact cards:
   * CalDAV sync must 404 the resource name the client knows). */
  async destroyCalendarEvents(accountId: string, ids: string[]): Promise<void> {
    const now = Date.now();
    for (const chunk of chunked(ids)) {
      const marks = chunk.map(() => "?").join(",");
      const { results } = await this.db
        .prepare(
          `SELECT id, calendar_id, dav_name FROM calendar_events
           WHERE account_id = ? AND id IN (${marks})`,
        )
        .bind(accountId, ...chunk)
        .all<{ id: string; calendar_id: string; dav_name: string | null }>();
      if (results.length === 0) continue;
      await this.db.batch([
        ...results.map((r) =>
          this.db
            .prepare(
              `INSERT OR REPLACE INTO dav_tombstones
                 (account_id, collection_id, item_id, resource_name, deleted_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(accountId, r.calendar_id, r.id, r.dav_name ?? r.id, now),
        ),
        this.db
          .prepare(
            `DELETE FROM calendar_events WHERE account_id = ? AND id IN (${results
              .map(() => "?")
              .join(",")})`,
          )
          .bind(accountId, ...results.map((r) => r.id)),
      ]);
    }
  }

  /** Refs for every event in one calendar (CalDAV listings / initial sync). */
  async eventRefsInCalendar(
    accountId: string,
    calendarId: string,
  ): Promise<Array<{ id: string; uid: string; davName: string | null; updatedAt: number }>> {
    const { results } = await this.db
      .prepare(
        `SELECT id, uid, dav_name, updated_at FROM calendar_events
         WHERE account_id = ? AND calendar_id = ? ORDER BY id`,
      )
      .bind(accountId, calendarId)
      .all<{ id: string; uid: string; dav_name: string | null; updated_at: number }>();
    return results.map((r) => ({
      id: r.id,
      uid: r.uid,
      davName: r.dav_name,
      updatedAt: r.updated_at,
    }));
  }

  /** Column-only event refs by ids (sync filtering). */
  async getCalendarEventRefs(
    accountId: string,
    ids: string[],
  ): Promise<Array<{ id: string; calendarId: string; davName: string | null; updatedAt: number }>> {
    const out: Array<{ id: string; calendarId: string; davName: string | null; updatedAt: number }> = [];
    for (const chunk of chunked(ids)) {
      const marks = chunk.map(() => "?").join(",");
      const { results } = await this.db
        .prepare(
          `SELECT id, calendar_id, dav_name, updated_at FROM calendar_events
           WHERE account_id = ? AND id IN (${marks})`,
        )
        .bind(accountId, ...chunk)
        .all<{ id: string; calendar_id: string; dav_name: string | null; updated_at: number }>();
      out.push(
        ...results.map((r) => ({
          id: r.id,
          calendarId: r.calendar_id,
          davName: r.dav_name,
          updatedAt: r.updated_at,
        })),
      );
    }
    return out;
  }

  /** Resolve a CalDAV resource inside a calendar: dav_name first, id fallback. */
  async getEventByDavName(
    accountId: string,
    calendarId: string,
    resourceName: string,
  ): Promise<CalendarEventRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id FROM calendar_events
         WHERE account_id = ? AND calendar_id = ? AND (dav_name = ? OR id = ?) LIMIT 1`,
      )
      .bind(accountId, calendarId, resourceName, resourceName)
      .first<{ id: string }>();
    if (!row) return null;
    return (await this.getCalendarEvents(accountId, [row.id]))[0] ?? null;
  }

  /**
   * CalendarEvent/query candidates by indexed OUTER span; time-range
   * refinement against actual occurrences happens in the method layer
   * (calendar-core expansion — the span can over-include, never miss).
   */
  async queryCalendarEvents(
    accountId: string,
    query: CalendarEventQuery,
  ): Promise<{ ids: string[]; position: number; total?: number }> {
    const params: unknown[] = [accountId];
    const clauses: string[] = [];
    const c = query.filter ?? {};
    if (c.inCalendar !== undefined) {
      clauses.push(`e.calendar_id = ?`);
      params.push(c.inCalendar);
    }
    if (c.uid !== undefined) {
      clauses.push(`e.uid = ?`);
      params.push(c.uid);
    }
    if (c.before !== undefined) {
      clauses.push(`e.start_at IS NOT NULL AND e.start_at < ?`);
      params.push(Date.parse(c.before));
    }
    if (c.after !== undefined) {
      clauses.push(`(e.end_at IS NULL OR e.end_at > ?)`);
      params.push(Date.parse(c.after));
    }
    if (c.title !== undefined) {
      clauses.push(`COALESCE(e.title, '') LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(c.title)}%`);
    }
    if (c.text !== undefined) {
      const like = `%${escapeLike(c.text)}%`;
      clauses.push(
        `(COALESCE(e.title, '') LIKE ? ESCAPE '\\'
          OR COALESCE(json_extract(e.event_json, '$.description'), '') LIKE ? ESCAPE '\\')`,
      );
      params.push(like, like);
    }
    const where = clauses.length > 0 ? clauses.join(" AND ") : "1=1";

    const SORT: Record<string, string> = {
      start: "e.start_at",
      updated: "e.updated_at",
      created: "e.created_at",
    };
    const sort = (query.sort ?? [{ property: "start", isAscending: true }])
      .map((s) => `${SORT[s.property] ?? "e.start_at"} ${s.isAscending ? "ASC" : "DESC"}`)
      .join(", ");

    const position = Math.max(0, query.position ?? 0);
    const limit = Math.min(Math.max(1, query.limit ?? 100), 256);

    const { results } = await this.db
      .prepare(
        `SELECT e.id FROM calendar_events e WHERE e.account_id = ? AND (${where})
         ORDER BY ${sort}, e.id LIMIT ? OFFSET ?`,
      )
      .bind(...params, limit, position)
      .all<{ id: string }>();

    const out: { ids: string[]; position: number; total?: number } = {
      ids: results.map((r) => r.id),
      position,
    };
    if (query.calculateTotal) {
      const row = await this.db
        .prepare(`SELECT COUNT(*) AS n FROM calendar_events e WHERE e.account_id = ? AND (${where})`)
        .bind(...params)
        .first<{ n: number }>();
      out.total = row?.n ?? 0;
    }
    return out;
  }

  // ---- FileNode inodes (JMAP for Files, draft-14) -------------------
  //
  // Thin data layer, exactly like calendars/contacts: bare reads and writes,
  // no invariant maintenance. Sibling-name uniqueness, cycle rejection,
  // onDestroyRemoveChildren, blob pinning and the 010 revoke-on-destroy path
  // all live in the JMAP method layer (services/jmap/src/methods/filenode.ts).

  async getFileNodes(accountId: string, ids?: string[]): Promise<FileNodeRow[]> {
    const results: FileNodeRawRow[] = [];
    if (ids && ids.length > 0) {
      for (const chunk of chunked(ids)) {
        const marks = chunk.map(() => "?").join(",");
        const { results: r } = await this.db
          .prepare(`SELECT ${FILE_NODE_COLS} FROM file_nodes WHERE account_id = ? AND id IN (${marks})`)
          .bind(accountId, ...chunk)
          .all<FileNodeRawRow>();
        results.push(...r);
      }
    } else {
      const { results: r } = await this.db
        .prepare(`SELECT ${FILE_NODE_COLS} FROM file_nodes WHERE account_id = ? ORDER BY name`)
        .bind(accountId)
        .all<FileNodeRawRow>();
      results.push(...r);
    }
    return results.map(rowToFileNode);
  }

  /** Direct children of a parent; `null` = the account's top-level nodes. */
  async getFileNodeChildren(accountId: string, parentId: string | null): Promise<FileNodeRow[]> {
    const clause = parentId === null ? "parent_id IS NULL" : "parent_id = ?";
    const binds = parentId === null ? [accountId] : [accountId, parentId];
    const { results } = await this.db
      .prepare(`SELECT ${FILE_NODE_COLS} FROM file_nodes WHERE account_id = ? AND ${clause} ORDER BY name`)
      .bind(...binds)
      .all<FileNodeRawRow>();
    return results.map(rowToFileNode);
  }

  async insertFileNode(accountId: string, row: FileNodeRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO file_nodes
           (id, account_id, parent_id, name, node_type, blob_id, size, type,
            created, modified, accessed, changed, executable, is_subscribed, role,
            ${PROVENANCE_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        accountId,
        row.parentId,
        row.name,
        row.nodeType,
        row.blobId,
        row.size,
        row.type,
        row.created,
        row.modified,
        row.accessed,
        row.changed,
        row.executable ? 1 : 0,
        row.isSubscribed ? 1 : 0,
        row.role,
        ...this.provenanceValues(),
      )
      .run();
  }

  async updateFileNode(accountId: string, id: string, patch: FileNodePatch): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const put = (col: string, val: unknown) => {
      sets.push(`${col} = ?`);
      params.push(val);
    };
    if (patch.parentId !== undefined) put("parent_id", patch.parentId);
    if (patch.name !== undefined) put("name", patch.name);
    if (patch.blobId !== undefined) put("blob_id", patch.blobId);
    if (patch.size !== undefined) put("size", patch.size);
    if (patch.type !== undefined) put("type", patch.type);
    if (patch.executable !== undefined) put("executable", patch.executable ? 1 : 0);
    if (patch.isSubscribed !== undefined) put("is_subscribed", patch.isSubscribed ? 1 : 0);
    if (patch.role !== undefined) put("role", patch.role);
    if (patch.modified !== undefined) put("modified", patch.modified);
    if (patch.changed !== undefined) put("changed", patch.changed);
    if (patch.accessed !== undefined) put("accessed", patch.accessed);
    if (sets.length === 0) return;
    this.appendProvenance(sets, params);
    await this.db
      .prepare(`UPDATE file_nodes SET ${sets.join(", ")} WHERE account_id = ? AND id = ?`)
      .bind(...params, accountId, id)
      .run();
  }

  async deleteFileNodes(accountId: string, ids: string[]): Promise<void> {
    for (const chunk of chunked(ids)) {
      if (chunk.length === 0) continue;
      const marks = chunk.map(() => "?").join(",");
      await this.db
        .prepare(`DELETE FROM file_nodes WHERE account_id = ? AND id IN (${marks})`)
        .bind(accountId, ...chunk)
        .run();
    }
  }

  async queryFileNodes(
    accountId: string,
    query: FileNodeQuery,
  ): Promise<{ ids: string[]; total?: number; position: number }> {
    const where: string[] = ["account_id = ?"];
    const params: unknown[] = [accountId];
    const f = query.filter;
    if (f) {
      if (f.parentId !== undefined) {
        if (f.parentId === null) where.push("parent_id IS NULL");
        else {
          where.push("parent_id = ?");
          params.push(f.parentId);
        }
      }
      if (f.nodeType !== undefined) {
        where.push("node_type = ?");
        params.push(f.nodeType);
      }
      if (f.role !== undefined) {
        where.push("role = ?");
        params.push(f.role);
      }
      if (f.name !== undefined) {
        where.push("name = ?");
        params.push(f.name);
      }
      if (f.hasBlobId !== undefined) {
        where.push(f.hasBlobId ? "blob_id IS NOT NULL" : "blob_id IS NULL");
      }
    }
    const whereSql = where.join(" AND ");

    let total: number | undefined;
    if (query.calculateTotal) {
      const row = await this.db
        .prepare(`SELECT COUNT(*) AS n FROM file_nodes WHERE ${whereSql}`)
        .bind(...params)
        .first<{ n: number }>();
      total = row?.n ?? 0;
    }

    const sortCols: Record<string, string> = {
      name: "name",
      created: "created",
      modified: "modified",
      changed: "changed",
      size: "size",
    };
    const order =
      query.sort && query.sort.length > 0
        ? query.sort
            .map((s) => `${sortCols[s.property] ?? "name"} ${s.isAscending ? "ASC" : "DESC"}`)
            .join(", ")
        : "name ASC";
    const position = query.position ?? 0;
    const limit = query.limit ?? 256;
    const { results } = await this.db
      .prepare(
        `SELECT id FROM file_nodes WHERE ${whereSql} ORDER BY ${order}, id ASC LIMIT ? OFFSET ?`,
      )
      .bind(...params, limit, position)
      .all<{ id: string }>();
    return { ids: results.map((r) => r.id), position, ...(total !== undefined ? { total } : {}) };
  }

  /**
   * FileNode ids in this account that reference a blob — the pinning lookup.
   * A blob with ≥1 live FileNode reference MUST NOT be GC'd or explicitly
   * deleted (s03.B/arch.md §3). `handleBlobDelete` calls this to refuse.
   */
  async fileNodesReferencingBlob(accountId: string, blobId: string, limit = 5): Promise<string[]> {
    const { results } = await this.db
      .prepare(`SELECT id FROM file_nodes WHERE account_id = ? AND blob_id = ? LIMIT ?`)
      .bind(accountId, blobId, limit)
      .all<{ id: string }>();
    return results.map((r) => r.id);
  }

  // ---- Identities (control plane, same shard for MVP) ---------------

  async getIdentities(accountId: string): Promise<IdentityRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, email, name, reply_to_json, bcc_json, text_signature,
                html_signature, may_delete
         FROM identities WHERE account_id = ? ORDER BY may_delete, email`,
      )
      .bind(accountId)
      .all<{
        id: string;
        email: string;
        name: string;
        reply_to_json: string | null;
        bcc_json: string | null;
        text_signature: string;
        html_signature: string;
        may_delete: number;
      }>();
    return results.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      replyTo: r.reply_to_json === null ? null : (JSON.parse(r.reply_to_json) as EmailAddress[]),
      bcc: r.bcc_json === null ? null : (JSON.parse(r.bcc_json) as EmailAddress[]),
      textSignature: r.text_signature,
      htmlSignature: r.html_signature,
      mayDelete: r.may_delete === 1,
    }));
  }

  /**
   * Bare SQL, no invariants — `Identity/set` owns the validation (the
   * active-domain check, immutable `email`, the undeletable primary). The
   * `UNIQUE (account_id, email)` index is deliberately left to raise, so a
   * duplicate address is caught by the database rather than by a
   * read-then-write race in the method.
   */
  async insertIdentity(
    accountId: string,
    row: { id: string; email: string; name: string } & IdentityColumns,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO identities
           (id, account_id, email, name, reply_to_json, bcc_json,
            text_signature, html_signature, may_delete)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        accountId,
        row.email,
        row.name,
        row.reply_to_json ?? null,
        row.bcc_json ?? null,
        row.text_signature ?? "",
        row.html_signature ?? "",
        row.may_delete ?? 1,
      )
      .run();
  }

  async updateIdentity(
    accountId: string,
    id: string,
    columns: IdentityColumns,
  ): Promise<void> {
    const entries = Object.entries(columns);
    if (entries.length === 0) return;
    const set = entries.map(([c]) => `${c} = ?`).join(", ");
    await this.db
      .prepare(`UPDATE identities SET ${set} WHERE account_id = ? AND id = ?`)
      .bind(...entries.map(([, v]) => v), accountId, id)
      .run();
  }

  async deleteIdentity(accountId: string, id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM identities WHERE account_id = ? AND id = ?`)
      .bind(accountId, id)
      .run();
  }

  /**
   * Is `domain` wired to this tenant and sending? The `identities` DDL has
   * always said "must be on an active domain" and nothing enforced it;
   * `Identity/set` create does, using this.
   */
  async isActiveDomain(tenantId: string, domain: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS ok FROM domains WHERE domain = ? AND tenant_id = ? AND status = 'active'`)
      .bind(domain.toLowerCase(), tenantId)
      .first<{ ok: number }>();
    return row?.ok === 1;
  }

  // ---- EmailSubmissions ----------------------------------------------

  async insertSubmission(accountId: string, sub: SubmissionRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO email_submissions
           (id, account_id, email_id, identity_id, envelope_json, undo_status,
            relay_message_id, send_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        sub.id,
        accountId,
        sub.emailId,
        sub.identityId,
        JSON.stringify(sub.envelope),
        sub.undoStatus,
        sub.relayMessageId,
        sub.sendAt,
      )
      .run();
  }

  /**
   * Submissions for an account. `ids` undefined = all; an EMPTY array is a
   * request for nothing and returns nothing (RFC 8620 §5.1) — deliberately
   * unlike `getMailboxes`, whose `ids && ids.length > 0` test treats `[]` as
   * "everything". Mirroring that quirk here would make `/get` with `ids: []`
   * return the whole account.
   *
   * The LEFT JOIN carries `threadId` (see `StoredSubmission`); it is a join on
   * `emails`' primary key, so it costs an index seek per row and cannot drop a
   * submission whose email is gone.
   */
  async getSubmissions(accountId: string, ids?: string[]): Promise<StoredSubmission[]> {
    type Row = {
      id: string;
      email_id: string;
      identity_id: string;
      envelope_json: string;
      undo_status: string;
      relay_message_id: string | null;
      send_at: number;
      thread_id: string | null;
    };
    const select = `SELECT s.id, s.email_id, s.identity_id, s.envelope_json, s.undo_status,
                           s.relay_message_id, s.send_at, e.thread_id
                    FROM email_submissions s
                    LEFT JOIN emails e ON e.account_id = s.account_id AND e.id = s.email_id`;

    const results: Row[] = [];
    if (ids) {
      for (const chunk of chunked(ids)) {
        const marks = chunk.map(() => "?").join(",");
        const { results: r } = await this.db
          .prepare(`${select} WHERE s.account_id = ? AND s.id IN (${marks})`)
          .bind(accountId, ...chunk)
          .all<Row>();
        results.push(...r);
      }
    } else {
      const { results: r } = await this.db
        .prepare(`${select} WHERE s.account_id = ? ORDER BY s.send_at DESC, s.id`)
        .bind(accountId)
        .all<Row>();
      results.push(...r);
    }

    return results.map((r) => ({
      id: r.id,
      emailId: r.email_id,
      identityId: r.identity_id,
      threadId: r.thread_id,
      envelope: JSON.parse(r.envelope_json) as { mailFrom: string; rcptTo: string[] },
      undoStatus: r.undo_status,
      relayMessageId: r.relay_message_id,
      sendAt: r.send_at,
    }));
  }

  // ---- Contact photos ⇄ R2 (RFC 9610 media blobId) --------------------
  //
  // Inline data: photos dominated card_json storage (92% of the shard).
  // Every WRITE path offloads them to content-hashed R2 blobs (identical
  // photos dedupe for free); JMAP serves the blobId per RFC 9610; the
  // CardDAV face re-INFLATES at serialize time because Apple clients
  // only accept photos inline in the vCard.

  /** Replace data: URIs in card.media with R2 blobIds. Mutates card;
   * returns bytes moved (0 = nothing to do). */
  async offloadCardPhotos(
    tenantId: string,
    accountId: string,
    card: JSContactCard,
  ): Promise<number> {
    const media = card.media as Record<string, Record<string, unknown>> | undefined;
    if (!media || typeof media !== "object") return 0;
    let moved = 0;
    for (const entry of Object.values(media)) {
      if (!entry || typeof entry !== "object") continue;
      const uri = entry.uri;
      if (typeof uri !== "string" || !uri.startsWith("data:")) continue;
      const m = uri.match(/^data:([a-z0-9.+/-]+);base64,([\s\S]*)$/i);
      if (!m) continue;
      const bytes = b64ToBytes(m[2]!.replaceAll(/\s/g, ""));
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      entry.blobId = await this.putBlob(tenantId, accountId, buf as ArrayBuffer);
      if (entry.mediaType === undefined) entry.mediaType = m[1]!.toLowerCase();
      entry.size = bytes.byteLength;
      delete entry.uri;
      moved += bytes.byteLength;
    }
    return moved;
  }

  /** Resolve blobId media back to data: URIs (DAV serialization).
   * Returns a clone when inflation happened; missing blobs are skipped
   * (the card serializes without that photo rather than failing). */
  async inflateCardPhotos(
    tenantId: string,
    accountId: string,
    card: JSContactCard,
  ): Promise<JSContactCard> {
    const media = card.media as Record<string, Record<string, unknown>> | undefined;
    if (!media || typeof media !== "object") return card;
    const needs = Object.values(media).some(
      (e) => e && typeof e === "object" && typeof e.blobId === "string" && e.uri === undefined,
    );
    if (!needs) return card;

    const out = structuredClone(card);
    for (const entry of Object.values(out.media as Record<string, Record<string, unknown>>)) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.blobId !== "string" || entry.uri !== undefined) continue;
      const obj = await this.getBlob(tenantId, accountId, entry.blobId);
      if (!obj) continue;
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const mediaType = typeof entry.mediaType === "string" ? entry.mediaType : "image/jpeg";
      entry.uri = `data:${mediaType};base64,${bytesToB64(bytes)}`;
    }
    return out;
  }

  // ---- Blobs (R2) ---------------------------------------------------

  async putBlob(tenantId: string, accountId: string, raw: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", raw);
    const blobId = `b_${hex(digest)}`;
    await this.blobs.put(blobKey(tenantId, accountId, blobId), raw);
    return blobId;
  }

  async getBlob(tenantId: string, accountId: string, blobId: string): Promise<R2ObjectBody | null> {
    return this.blobs.get(blobKey(tenantId, accountId, blobId));
  }

  /**
   * Metadata only — no body transfer.
   *
   * Minting a share link verified the blob existed by GETting it
   * (`services/jmap/src/index.ts`), which streams the whole object to decide
   * a boolean. Existence checks use this.
   */
  async headBlob(tenantId: string, accountId: string, blobId: string): Promise<R2Object | null> {
    return this.blobs.head(blobKey(tenantId, accountId, blobId));
  }

  /**
   * What this account actually holds in R2.
   *
   * `blobKey` puts every account's objects under one prefix, so per-account
   * listing is a prefix scan and needs no index. Until this existed nothing —
   * not the CLI, not JMAP, not an operator — could answer "what is stored and
   * how big is it", while R2 billed for all of it.
   */
  async listBlobs(
    tenantId: string,
    accountId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<{ blobs: BlobInfo[]; cursor?: string }> {
    const prefix = blobKey(tenantId, accountId, "");
    const page = await this.blobs.list({
      prefix,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
    });
    const blobs = page.objects.map((o) => ({
      blobId: o.key.slice(prefix.length),
      size: o.size,
      uploaded: o.uploaded.toISOString(),
    }));
    return page.truncated ? { blobs, cursor: page.cursor } : { blobs };
  }

  /**
   * Emails that still reference this blob, as the raw RFC 5322 object
   * (`emails.blob_id`) or as an attachment (`emails.attachments_json`).
   *
   * THIS IS WHY BLOB DELETE NEEDS A GUARD. `putBlob` is content-addressed, so
   * the same bytes attached to two messages are ONE object: deleting it
   * because one message is gone silently breaks the other. `destroyEmail`
   * takes the opposite tack — it leaves the object behind and says so — which
   * means orphans accumulate but nothing is ever wrongly destroyed.
   *
   * Cost: `blob_id` is a plain column, but the attachment side is a JSON scan
   * with no index — O(emails in the account). Fine for an interactive
   * single-blob delete; NOT a sweep. `limit` caps the evidence gathered,
   * since the caller only needs to know that a reference exists and to name a
   * couple of them.
   */
  async blobReferences(accountId: string, blobId: string, limit = 5): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id FROM emails
          WHERE account_id = ?
            AND (blob_id = ?
                 OR EXISTS (SELECT 1 FROM json_each(emails.attachments_json) je
                             WHERE json_extract(je.value, '$.blobId') = ?))
          LIMIT ?`,
      )
      .bind(accountId, blobId, blobId, limit)
      .all<{ id: string }>();
    return results.map((r) => r.id);
  }

  /**
   * Remove one object. Unconditional — reference checking is the caller's
   * decision to make and to report on, so it stays in the route handler
   * rather than being buried here.
   */
  async deleteBlob(tenantId: string, accountId: string, blobId: string): Promise<void> {
    await this.blobs.delete(blobKey(tenantId, accountId, blobId));
  }
}

const SORT_COLUMNS: Record<string, string> = {
  receivedAt: "e.received_at",
  size: "e.size",
  subject: "e.subject",
  from: "e.from_json",
};

const CONTACT_SORT_COLUMNS: Record<string, string> = {
  created: "c.created_at",
  updated: "c.updated_at",
  name: "c.name_full",
};

// ---- FileNode row mapping -------------------------------------------------

const FILE_NODE_COLS = `id, parent_id, name, node_type, blob_id, size, type,
  created, modified, accessed, changed, executable, is_subscribed, role`;

interface FileNodeRawRow {
  id: string;
  parent_id: string | null;
  name: string;
  node_type: string;
  blob_id: string | null;
  size: number | null;
  type: string | null;
  created: number;
  modified: number;
  accessed: number;
  changed: number;
  executable: number;
  is_subscribed: number;
  role: string | null;
}

function rowToFileNode(r: FileNodeRawRow): FileNodeRow {
  return {
    id: r.id,
    parentId: r.parent_id,
    name: r.name,
    nodeType: r.node_type as FileNodeType,
    blobId: r.blob_id,
    size: r.size,
    type: r.type,
    created: r.created,
    modified: r.modified,
    accessed: r.accessed,
    changed: r.changed,
    executable: r.executable === 1,
    isSubscribed: r.is_subscribed === 1,
    role: r.role,
  };
}

function escapeLike(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/**
 * EXISTS over the values of a JSContact Id-map property (e.g. $.emails),
 * testing `condition` against each entry as `je`. COALESCE keeps
 * json_each happy when the property is absent from the card.
 */
function jsonMapExists(path: string, condition: string): string {
  return `EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(c.card_json, '${path}'), '{}')) je
          WHERE ${condition})`;
}

/** jsonMapExists specialised to "any of these subfields LIKE ?". */
function jsonMapLike(path: string, fields: string[], params: unknown[], needle: string): string {
  const like = `%${escapeLike(needle)}%`;
  const tests = fields.map((f) => {
    params.push(like);
    return `COALESCE(json_extract(je.value, '${f}'), '') LIKE ? ESCAPE '\\'`;
  });
  return jsonMapExists(path, tests.join(" OR "));
}

/** RFC 9610 `name` filter: the extracted full name or any name component. */
function nameClause(params: unknown[], needle: string): string {
  const like = `%${escapeLike(needle)}%`;
  params.push(like, like);
  return `(COALESCE(c.name_full, '') LIKE ? ESCAPE '\\'
     OR EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(c.card_json, '$.name.components'), '[]')) jn
        WHERE COALESCE(json_extract(jn.value, '$.value'), '') LIKE ? ESCAPE '\\'))`;
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  // Chunked: String.fromCharCode(...bytes) overflows the stack on photos.
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
