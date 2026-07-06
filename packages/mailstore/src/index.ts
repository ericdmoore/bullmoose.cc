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

export class Mailstore {
  constructor(
    private db: D1Database,
    private blobs: R2Bucket,
  ) {}

  // ---- Mailboxes ----------------------------------------------------

  async getMailboxes(accountId: string, ids?: string[]): Promise<MailboxRow[]> {
    let stmt;
    if (ids && ids.length > 0) {
      const marks = ids.map(() => "?").join(",");
      stmt = this.db
        .prepare(
          `SELECT id, parent_id, name, role, sort_order FROM mailboxes
           WHERE account_id = ? AND id IN (${marks})`,
        )
        .bind(accountId, ...ids);
    } else {
      stmt = this.db
        .prepare(
          `SELECT id, parent_id, name, role, sort_order FROM mailboxes
           WHERE account_id = ? ORDER BY sort_order, name`,
        )
        .bind(accountId);
    }
    const { results } = await stmt.all<{
      id: string;
      parent_id: string | null;
      name: string;
      role: string | null;
      sort_order: number;
    }>();
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
    const marks = ids.map(() => "?").join(",");

    const [emails, mailboxes, keywords] = await this.db.batch<Record<string, unknown>>([
      this.db
        .prepare(`SELECT * FROM emails WHERE account_id = ? AND id IN (${marks})`)
        .bind(accountId, ...ids),
      this.db
        .prepare(
          `SELECT email_id, mailbox_id FROM email_mailboxes
           WHERE account_id = ? AND email_id IN (${marks})`,
        )
        .bind(accountId, ...ids),
      this.db
        .prepare(
          `SELECT email_id, keyword FROM email_keywords
           WHERE account_id = ? AND email_id IN (${marks})`,
        )
        .bind(accountId, ...ids),
    ]);

    const mbByEmail = new Map<string, string[]>();
    for (const r of (mailboxes?.results ?? []) as Array<{ email_id: string; mailbox_id: string }>) {
      (mbByEmail.get(r.email_id) ?? mbByEmail.set(r.email_id, []).get(r.email_id)!).push(
        r.mailbox_id,
      );
    }
    const kwByEmail = new Map<string, string[]>();
    for (const r of (keywords?.results ?? []) as Array<{ email_id: string; keyword: string }>) {
      (kwByEmail.get(r.email_id) ?? kwByEmail.set(r.email_id, []).get(r.email_id)!).push(r.keyword);
    }

    for (const r of (emails?.results ?? []) as Array<Record<string, unknown>>) {
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

function escapeLike(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
