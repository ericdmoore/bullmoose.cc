import type { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JmapClient, Invocation } from "./jmap.js";
import type { AccountRef } from "./db.js";

/**
 * Sync engine. Incremental when the server can replay our cursor
 * (Email/changes against the AccountDO changelog), full resync when it
 * can't (cannotCalculateChanges) or on first run — the exact protocol a
 * JMAP client is supposed to speak, which makes this CLI double as an
 * acceptance test for the server's /changes implementation.
 */

const EMAIL_PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "hasAttachment",
  "preview",
  "attachments",
];

interface JmapEmail {
  id: string;
  blobId: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  size: number;
  receivedAt: string;
  messageId: string[] | null;
  inReplyTo: string[] | null;
  from: Array<{ name: string | null; email: string }> | null;
  to: Array<{ name: string | null; email: string }> | null;
  cc: Array<{ name: string | null; email: string }> | null;
  bcc: Array<{ name: string | null; email: string }> | null;
  subject: string | null;
  hasAttachment: boolean;
  preview: string;
  attachments: unknown[];
}

export interface SyncStats {
  mode: "full" | "incremental";
  mailboxes: number;
  created: number;
  updated: number;
  destroyed: number;
  newState: string;
  /** Changed ids, incremental mode only — full resyncs leave these empty
   * (a first sync would otherwise "announce" the whole mailbox). */
  createdIds: string[];
  updatedIds: string[];
  destroyedIds: string[];
}

export type MultiSyncResult = Array<{
  account: AccountRef;
  stats?: SyncStats;
  clean?: boolean;
  error?: string;
}>;

/**
 * Sync many accounts with a batched clean-probe: ONE JMAP request carries
 * an Email/changes call per cursored account (each call names its own
 * accountId — this is why JMAP batching exists). Accounts whose state is
 * unchanged are skipped entirely, so N idle inboxes cost ~one round trip;
 * only dirty or never-synced accounts run the full engine.
 */
export async function syncAll(
  db: DatabaseSync,
  client: JmapClient,
  accounts: AccountRef[],
  opts: { blobs?: string } = {},
): Promise<MultiSyncResult> {
  const cursors = new Map<string, string | null>();
  for (const a of accounts) {
    const row = db
      .prepare("SELECT email_state FROM sync_state WHERE account_id = ?")
      .get(a.accountId) as { email_state: string | null } | undefined;
    cursors.set(a.accountId, row?.email_state ?? null);
  }

  // Probe (chunked at the server's maxCallsInRequest).
  const clean = new Set<string>();
  const probeable = accounts.filter((a) => cursors.get(a.accountId));
  for (let i = 0; i < probeable.length; i += 16) {
    const chunk = probeable.slice(i, i + 16);
    const calls: Invocation[] = chunk.map((a, idx) => [
      "Email/changes",
      { accountId: a.accountId, sinceState: cursors.get(a.accountId), maxChanges: 1 },
      `p${idx}`,
    ]);
    try {
      const responses = await client.call(calls);
      for (const [name, res, callId] of responses) {
        const account = chunk[Number(callId.slice(1))];
        if (!account || name === "error") continue; // dirty by default (e.g. cannotCalculateChanges)
        const r = res as { newState?: unknown; hasMoreChanges?: unknown };
        if (String(r.newState) === cursors.get(account.accountId) && r.hasMoreChanges !== true) {
          clean.add(account.accountId);
        }
      }
    } catch {
      /* probe failure → treat all as dirty; full sync decides */
    }
  }

  const results: MultiSyncResult = [];
  for (const account of accounts) {
    if (clean.has(account.accountId)) {
      results.push({ account, clean: true });
      continue;
    }
    try {
      const stats = await sync(db, client, account.accountId, opts);
      results.push({ account, stats });
    } catch (err) {
      results.push({ account, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

export async function sync(
  db: DatabaseSync,
  client: JmapClient,
  accountId: string,
  opts: { blobs?: string } = {},
): Promise<SyncStats> {
  // Mailboxes: small set — always refresh in full.
  const mb = await client.one("Mailbox/get", { accountId, ids: null });
  const mailboxes = mb.list as Array<{
    id: string;
    parentId: string | null;
    name: string;
    role: string | null;
    sortOrder: number;
  }>;
  db.prepare("DELETE FROM mailboxes WHERE account_id = ?").run(accountId);
  const insMb = db.prepare(
    "INSERT INTO mailboxes (id, account_id, parent_id, name, role, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const m of mailboxes) {
    insMb.run(m.id, accountId, m.parentId, m.name, m.role, m.sortOrder);
  }

  const cursorRow = db
    .prepare("SELECT email_state FROM sync_state WHERE account_id = ?")
    .get(accountId) as { email_state: string | null } | undefined;
  const cursor = cursorRow?.email_state ?? null;

  const stats: SyncStats = {
    mode: cursor ? "incremental" : "full",
    mailboxes: mailboxes.length,
    created: 0,
    updated: 0,
    destroyed: 0,
    newState: "0",
    createdIds: [],
    updatedIds: [],
    destroyedIds: [],
  };

  if (cursor) {
    try {
      await incrementalSync(db, client, accountId, cursor, stats, opts);
    } catch (err) {
      if ((err as { jmapType?: string }).jmapType === "cannotCalculateChanges") {
        stats.mode = "full";
        await fullResync(db, client, accountId, stats, opts);
      } else {
        throw err;
      }
    }
  } else {
    await fullResync(db, client, accountId, stats, opts);
  }

  db.prepare(
    `INSERT INTO sync_state (account_id, email_state, mailbox_state, last_sync)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET
       email_state = excluded.email_state,
       mailbox_state = excluded.mailbox_state,
       last_sync = excluded.last_sync`,
  ).run(accountId, stats.newState, String(mb.state), Date.now());

  // --blobs guarantees a complete local blob store, not just blobs for
  // rows touched this pass — backfill anything missing (content-hash
  // filenames make re-checks cheap: existing file = identical content).
  if (opts.blobs) {
    const rows = db
      .prepare("SELECT DISTINCT blob_id FROM emails WHERE account_id = ?")
      .all(accountId) as Array<{ blob_id: string }>;
    for (const r of rows) await downloadBlob(client, accountId, r.blob_id, opts.blobs);
  }

  return stats;
}

async function incrementalSync(
  db: DatabaseSync,
  client: JmapClient,
  accountId: string,
  cursor: string,
  stats: SyncStats,
  opts: { blobs?: string },
): Promise<void> {
  let since = cursor;
  for (;;) {
    const ch = await client.one("Email/changes", {
      accountId,
      sinceState: since,
      maxChanges: 512,
    });
    const created = ch.created as string[];
    const updated = ch.updated as string[];
    const destroyed = ch.destroyed as string[];

    await upsertEmails(db, client, accountId, [...created, ...updated], opts);
    for (const id of destroyed) deleteEmail(db, accountId, id);

    stats.created += created.length;
    stats.updated += updated.length;
    stats.destroyed += destroyed.length;
    stats.createdIds.push(...created);
    stats.updatedIds.push(...updated);
    stats.destroyedIds.push(...destroyed);
    stats.newState = String(ch.newState);

    if (ch.hasMoreChanges !== true) break;
    since = String(ch.newState);
  }
}

async function fullResync(
  db: DatabaseSync,
  client: JmapClient,
  accountId: string,
  stats: SyncStats,
  opts: { blobs?: string },
): Promise<void> {
  db.prepare("DELETE FROM emails WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM email_mailboxes WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM email_keywords WHERE account_id = ?").run(accountId);
  db.exec("DELETE FROM cli_fts");

  // Snapshot the state BEFORE paging so concurrent changes are caught by
  // the next incremental pass instead of silently skipped.
  const first = await client.one("Email/query", { accountId, position: 0, limit: 1 });
  stats.newState = String(first.queryState);

  const PAGE = 100;
  for (let position = 0; ; position += PAGE) {
    const q = await client.one("Email/query", {
      accountId,
      position,
      limit: PAGE,
      sort: [{ property: "receivedAt", isAscending: true }],
    });
    const ids = q.ids as string[];
    if (ids.length === 0) break;
    await upsertEmails(db, client, accountId, ids, opts);
    stats.created += ids.length;
    if (ids.length < PAGE) break;
  }
}

async function upsertEmails(
  db: DatabaseSync,
  client: JmapClient,
  accountId: string,
  ids: string[],
  opts: { blobs?: string },
): Promise<void> {
  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const res = await client.one("Email/get", {
      accountId,
      ids: chunk,
      properties: EMAIL_PROPERTIES,
    });
    for (const email of res.list as JmapEmail[]) {
      upsertOne(db, accountId, email);
      if (opts.blobs) await downloadBlob(client, accountId, email.blobId, opts.blobs);
    }
  }
}

function upsertOne(db: DatabaseSync, accountId: string, e: JmapEmail): void {
  const from = e.from ?? [];
  const to = e.to ?? [];
  db.prepare(
    `INSERT OR REPLACE INTO emails (id, account_id, blob_id, thread_id, message_id, in_reply_to,
       subject, from_json, to_json, cc_json, bcc_json, preview, size, received_at,
       has_attachment, attachments_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.id,
    accountId,
    e.blobId,
    e.threadId,
    e.messageId?.[0] ?? null,
    e.inReplyTo?.[0] ?? null,
    e.subject ?? "",
    JSON.stringify(from),
    JSON.stringify(to),
    JSON.stringify(e.cc ?? []),
    JSON.stringify(e.bcc ?? []),
    e.preview,
    e.size,
    Date.parse(e.receivedAt),
    e.hasAttachment ? 1 : 0,
    JSON.stringify(e.attachments ?? []),
  );

  db.prepare("DELETE FROM email_mailboxes WHERE account_id = ? AND email_id = ?").run(
    accountId,
    e.id,
  );
  const insMb = db.prepare(
    "INSERT INTO email_mailboxes (account_id, email_id, mailbox_id) VALUES (?, ?, ?)",
  );
  for (const mb of Object.keys(e.mailboxIds ?? {})) insMb.run(accountId, e.id, mb);

  db.prepare("DELETE FROM email_keywords WHERE account_id = ? AND email_id = ?").run(
    accountId,
    e.id,
  );
  const insKw = db.prepare(
    "INSERT INTO email_keywords (account_id, email_id, keyword) VALUES (?, ?, ?)",
  );
  for (const kw of Object.keys(e.keywords ?? {})) insKw.run(accountId, e.id, kw);

  db.prepare("DELETE FROM cli_fts WHERE email_id = ?").run(e.id);
  db.prepare(
    "INSERT INTO cli_fts (email_id, subject, from_text, to_text, preview) VALUES (?, ?, ?, ?, ?)",
  ).run(
    e.id,
    e.subject ?? "",
    from.map((a) => `${a.name ?? ""} ${a.email}`).join(" "),
    to.map((a) => `${a.name ?? ""} ${a.email}`).join(" "),
    e.preview,
  );
}

function deleteEmail(db: DatabaseSync, accountId: string, id: string): void {
  db.prepare("DELETE FROM emails WHERE account_id = ? AND id = ?").run(accountId, id);
  db.prepare("DELETE FROM email_mailboxes WHERE account_id = ? AND email_id = ?").run(accountId, id);
  db.prepare("DELETE FROM email_keywords WHERE account_id = ? AND email_id = ?").run(accountId, id);
  db.prepare("DELETE FROM cli_fts WHERE email_id = ?").run(id);
}

async function downloadBlob(
  client: JmapClient,
  accountId: string,
  blobId: string,
  dir: string,
): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${blobId}.eml`);
  if (existsSync(path)) return; // content-hash ids: existing = identical
  writeFileSync(path, await client.downloadBlob(accountId, blobId));
}
