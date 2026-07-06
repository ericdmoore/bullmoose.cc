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

export interface MailboxRow {
  id: string;
  parentId: string | null;
  name: string;
  role: string | null;
  sortOrder: number;
}

export interface EmailMeta {
  id: string;
  blobId: string;
  threadId: string;
  messageId: string | null;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  preview: string;
  size: number;
  receivedAt: number;
  hasAttachment: boolean;
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
  preview: string;
  size: number;
  receivedAt: number;
  hasAttachment: boolean;
  mailboxIds: string[];
  keywords: string[];
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

  // ---- Emails -------------------------------------------------------

  async insertEmail(accountId: string, email: NewEmail): Promise<void> {
    const statements = [
      this.db
        .prepare(
          `INSERT INTO emails (id, account_id, blob_id, thread_id, message_id, in_reply_to,
             subject, from_json, to_json, preview, size, received_at, has_attachment)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          email.preview,
          email.size,
          email.receivedAt,
          email.hasAttachment ? 1 : 0,
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

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
