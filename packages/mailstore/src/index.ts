/**
 * Mailstore — typed data access over the data-plane D1 shard + R2 blobs.
 * Schemas live in ../sql/. The shard for an account comes from the
 * control plane (accounts.shard); for the single-shard MVP every worker
 * binds one D1 database as DB.
 */

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

export interface IdentityRow {
  id: string;
  email: string;
  name: string;
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

export class Mailstore {
  constructor(
    private db: D1Database,
    private blobs: R2Bucket,
  ) {}

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
        `INSERT INTO mailboxes (id, account_id, parent_id, name, role, sort_order)
         VALUES (?, ?, NULL, ?, ?, 0)`,
      )
      .bind(id, accountId, name, role)
      .run();
    return id;
  }

  /** Unread/total counts for Mailbox/get. */
  async mailboxCounts(
    accountId: string,
    mailboxId: string,
  ): Promise<{ totalEmails: number; unreadEmails: number }> {
    const row = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN NOT EXISTS (
             SELECT 1 FROM email_keywords k
             WHERE k.account_id = em.account_id
               AND k.email_id = em.email_id AND k.keyword = '$seen'
           ) THEN 1 ELSE 0 END) AS unread
         FROM email_mailboxes em
         WHERE em.account_id = ? AND em.mailbox_id = ?`,
      )
      .bind(accountId, mailboxId)
      .first<{ total: number; unread: number | null }>();
    return { totalEmails: row?.total ?? 0, unreadEmails: row?.unread ?? 0 };
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
    const where = query.filter ? this.buildFilter(query.filter, params) : "1=1";

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

  private buildFilter(filter: EmailFilter, params: unknown[]): string {
    if ("operator" in filter) {
      const parts = filter.conditions.map((c) => `(${this.buildFilter(c, params)})`);
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
      // LIKE fallback until the FTS index is populated at ingest.
      const like = `%${escapeLike(c.text)}%`;
      clauses.push(
        `(e.subject LIKE ? ESCAPE '\\' OR e.preview LIKE ? ESCAPE '\\'
          OR e.from_json LIKE ? ESCAPE '\\' OR e.to_json LIKE ? ESCAPE '\\')`,
      );
      params.push(like, like, like, like);
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
             has_attachment, attachments_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ];
    await this.db.batch(statements);
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
    if (statements.length > 0) await this.db.batch(statements);
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
                  ctag, created_at, updated_at`;
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
    }));
  }

  async insertAddressBook(accountId: string, book: AddressBookRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO address_books
           (id, account_id, name, description, sort_order, is_default, is_subscribed,
            ctag, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )
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

  async insertContactCard(accountId: string, row: ContactCardRow): Promise<void> {
    await this.insertContactCards(accountId, [row]);
  }

  /** One transactional db.batch — bulk imports must not pay per-card D1 calls. */
  async insertContactCards(accountId: string, rows: ContactCardRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.batch(
      rows.map((row) =>
        this.db
          .prepare(
            `INSERT INTO contact_cards
               (id, account_id, address_book_id, uid, card_json, name_full, dav_name,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          ),
      ),
    );
  }

  async updateContactCard(accountId: string, row: ContactCardRow): Promise<void> {
    await this.db
      .prepare(
        `UPDATE contact_cards
         SET address_book_id = ?, card_json = ?, name_full = ?, dav_name = ?, updated_at = ?
         WHERE account_id = ? AND id = ?`,
      )
      .bind(
        row.addressBookId,
        JSON.stringify(row.card),
        row.nameFull,
        row.davName,
        row.updatedAt,
        accountId,
        row.id,
      )
      .run();
  }

  async destroyContactCard(accountId: string, id: string): Promise<void> {
    await this.destroyContactCards(accountId, [id]);
  }

  /**
   * Bulk destroy with DAV tombstones: sync-collection must answer
   * deletions with the resource name a client knew, and the changelog
   * only keeps ids. Batched — a whole-book cascade stays within the
   * per-request budget.
   */
  async destroyContactCards(accountId: string, ids: string[]): Promise<void> {
    const now = Date.now();
    for (const chunk of chunked(ids)) {
      const marks = chunk.map(() => "?").join(",");
      const { results } = await this.db
        .prepare(
          `SELECT id, address_book_id, dav_name FROM contact_cards
           WHERE account_id = ? AND id IN (${marks})`,
        )
        .bind(accountId, ...chunk)
        .all<{ id: string; address_book_id: string; dav_name: string | null }>();
      if (results.length === 0) continue;
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
      ]);
    }
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
            ctag, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                is_recurring, dav_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          ),
      ),
    );
  }

  async updateCalendarEvent(accountId: string, row: CalendarEventRow): Promise<void> {
    await this.db
      .prepare(
        `UPDATE calendar_events
         SET calendar_id = ?, event_json = ?, title = ?, start_at = ?, end_at = ?,
             is_recurring = ?, dav_name = ?, updated_at = ?
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

  // ---- Identities (control plane, same shard for MVP) ---------------

  async getIdentities(accountId: string): Promise<IdentityRow[]> {
    const { results } = await this.db
      .prepare(`SELECT id, email, name FROM identities WHERE account_id = ?`)
      .bind(accountId)
      .all<IdentityRow>();
    return results;
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
