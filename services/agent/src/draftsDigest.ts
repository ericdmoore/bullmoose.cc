import { commitChanges } from "@bullmoose/account-do";
import { buildMime } from "@bullmoose/mime";
import { Mailstore } from "@bullmoose/mailstore";
import type { Env } from "./models.js";

/**
 * CJ's drafts digest (board #43) — a mailed report of drafts that have sat,
 * deep-linked back to the webmail.
 *
 * The chief-of-staff premise is that the system reaches OUT: everything else
 * built so far waits for the reader to open the app. This is the smallest
 * piece that reverses that — mail you receive about mail you never sent.
 *
 * ## What earns a line, and what earns silence
 *
 * Only drafts older than `STALE_MS`. The draft being typed right now is not
 * nagged about; a digest that mentions today's work-in-progress teaches the
 * reader to delete digests. And two silences are load-bearing:
 *
 *   - NO stale drafts → no marker, no mail, nothing. The frontier digest's
 *     empty-month rule.
 *   - the SAME stale drafts as the last digest → silence too. A daily mail
 *     repeating an unchanged list is a nag, and a nag trains deletion — the
 *     digest speaks when the situation CHANGES (a draft added, one sent or
 *     discarded), which is what makes it worth opening. The previous set
 *     rides in the marker's result_json; comparing costs one row.
 *
 * ## Mechanics — the frontierDigest pattern, deliberately unchanged
 *
 * Marker: a carrier invocation under a synthetic binding, INSERT OR IGNORE on
 * a deterministic id, done on arrival at cost 0 (nothing here calls a model).
 * One per UTC day, so the digest is at-most-daily. Delivery: buildMime →
 * putBlob → insertEmail → commitChanges, straight into the account's own
 * inbox. Nothing egresses, so no outbound gate is implicated. Deterministic
 * and fail-open: a shard without the tables is a warned no-op, never a
 * crashed cron.
 */

/** A draft is "sitting" once it is older than this. */
export const DRAFT_STALE_MS = 24 * 60 * 60 * 1000;

/** Synthetic binding for the carrier row — out of every per-binding join,
 *  visible as an honest record of "digest generated". */
export const DRAFTS_DIGEST_BINDING = "drafts-digest";

const DIGEST_ACCOUNT_LIMIT = 50;

/** The marker id — the idempotence key IS the primary key. */
export function draftsMarkerId(accountId: string, dayKey: string): string {
  return `inv_${DRAFTS_DIGEST_BINDING}_${accountId}_${dayKey}`;
}

/** UTC day, because the marker must agree with itself across shards and
 *  restarts, and the reader's timezone is not knowable here. */
export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface StaleDraft {
  id: string;
  threadId: string;
  subject: string | null;
  receivedAt: number;
}

/** Set equality on draft ids — the unchanged-list suppression. Order must not
 *  matter: two sweeps can enumerate in different orders and mean the same. */
export function sameDraftSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((id) => bs.has(id));
}

/** One line per draft: what it is, how long it has sat, where to finish it. */
export function renderDraftsDigest(
  drafts: readonly StaleDraft[],
  opts: { now: number; webmailOrigin: string },
): { subject: string; text: string } {
  const n = drafts.length;
  const subject = `${n} draft${n === 1 ? "" : "s"} waiting to be sent`;
  const lines: string[] = [
    `You have ${n} draft${n === 1 ? "" : "s"} that ${n === 1 ? "has" : "have"} been sitting for more than a day.`,
    "",
  ];
  for (const d of drafts) {
    const days = Math.max(1, Math.floor((opts.now - d.receivedAt) / (24 * 60 * 60 * 1000)));
    lines.push(`  • ${d.subject?.trim() || "(no subject)"} — ${days} day${days === 1 ? "" : "s"}`);
    // The deep link is the point (board #43): one click lands on the thread.
    lines.push(`    ${opts.webmailOrigin}/mail?thread=${encodeURIComponent(d.threadId)}`);
    lines.push("");
  }
  lines.push("Send them, or discard them — either way this list gets shorter.");
  lines.push("— CJ");
  return { subject, text: lines.join("\n") };
}

interface DigestAccount {
  account_id: string;
  tenant_id: string;
}

/** Accounts holding at least one stale draft — the digest's subjects. */
async function discoverAccounts(env: Env, cutoffMs: number): Promise<DigestAccount[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT m.account_id, a.tenant_id
       FROM mailboxes m
       JOIN email_mailboxes em ON em.account_id = m.account_id AND em.mailbox_id = m.id
       JOIN emails e ON e.account_id = em.account_id AND e.id = em.email_id
       JOIN accounts a ON a.id = m.account_id
      WHERE m.role = 'drafts' AND a.deleted_at IS NULL AND e.received_at < ?
      ORDER BY m.account_id LIMIT ${DIGEST_ACCOUNT_LIMIT}`,
  )
    .bind(cutoffMs)
    .all<DigestAccount>();
  return results;
}

async function staleDrafts(env: Env, accountId: string, cutoffMs: number): Promise<StaleDraft[]> {
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.thread_id AS threadId, e.subject, e.received_at AS receivedAt
       FROM mailboxes m
       JOIN email_mailboxes em ON em.account_id = m.account_id AND em.mailbox_id = m.id
       JOIN emails e ON e.account_id = em.account_id AND e.id = em.email_id
      WHERE m.account_id = ? AND m.role = 'drafts' AND e.received_at < ?
      ORDER BY e.received_at ASC LIMIT 50`,
  )
    .bind(accountId, cutoffMs)
    .all<StaleDraft>();
  return results;
}

/** The most recent prior digest's draft set, from its marker's result_json.
 *  Unreadable or absent → null, and the caller treats that as "changed" —
 *  fail-open means the digest SENDS when it cannot prove silence is right. */
async function previousDraftSet(env: Env, accountId: string): Promise<string[] | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT result_json FROM agent_invocations
        WHERE account_id = ? AND binding_name = ? AND result_json LIKE '%"draftIds"%'
        ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(accountId, DRAFTS_DIGEST_BINDING)
      .first<{ result_json: string }>();
    if (!row) return null;
    const parsed = JSON.parse(row.result_json) as { draftIds?: unknown };
    return Array.isArray(parsed.draftIds) ? (parsed.draftIds as string[]) : null;
  } catch {
    return null;
  }
}

/**
 * The daily pass, wired at the end of the scheduled sweep beside
 * `sweepFrontierDigest`. Returns how many digests were mailed.
 */
export async function sweepDraftsDigest(env: Env, now: number = Date.now()): Promise<{ sent: number }> {
  const cutoff = now - DRAFT_STALE_MS;
  const dayKey = utcDayKey(now);
  const webmailOrigin = env.WEBMAIL_ORIGIN ?? "https://app.bullmoose.cc";

  let accounts: DigestAccount[];
  try {
    accounts = await discoverAccounts(env, cutoff);
  } catch {
    console.warn("drafts digest sweep degraded to no-op (missing mailstore tables?)");
    return { sent: 0 };
  }

  let sent = 0;
  for (const acct of accounts) {
    try {
      const drafts = await staleDrafts(env, acct.account_id, cutoff);
      if (drafts.length === 0) continue;

      // The unchanged-list suppression. No marker is written on a skip, so
      // tomorrow re-checks — and the day the set changes, the digest speaks.
      const prev = await previousDraftSet(env, acct.account_id);
      const ids = drafts.map((d) => d.id);
      if (prev !== null && sameDraftSet(ids, prev)) continue;

      // The daily marker. `changes === 0` means a prior (or racing) sweep
      // already sent today's — the guarded-INSERT idempotence of the
      // frontier digest, unchanged.
      const markerId = draftsMarkerId(acct.account_id, dayKey);
      const marker = await env.DB.prepare(
        `INSERT OR IGNORE INTO agent_invocations
           (id, account_id, binding_id, binding_name, status, context_json,
            created_at, claimed_at, done_at, cost_micros, result_json)
         VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, 0, ?)`,
      )
        .bind(
          markerId,
          acct.account_id,
          // The synthetic name doubles as binding_id — the column is NOT NULL
          // (the same constraint that bit the offer path), and the frontier
          // digest binds it exactly this way.
          DRAFTS_DIGEST_BINDING,
          DRAFTS_DIGEST_BINDING,
          JSON.stringify({ kind: "drafts-digest", dayKey }),
          now,
          now,
          now,
          JSON.stringify({ kind: "drafts-digest", dayKey, draftIds: ids }),
        )
        .run();
      if (marker.meta.changes === 0) continue;

      const { subject, text } = renderDraftsDigest(drafts, { now, webmailOrigin });

      // ---- delivery: into the account's own inbox (frontier pattern) ------
      const store = new Mailstore(env.DB, env.BLOBS);
      const identities = await store.getIdentities(acct.account_id);
      const self = identities[0]?.email;
      if (!self) {
        // The marker is already down, and leaving it would make this SILENCE
        // FOREVER: tomorrow's sweep reads today's set from it and skips as
        // "unchanged". Un-mark so the account retries once it is whole — the
        // frontier digest's unmark() rule, for the same reason.
        await env.DB.prepare(`DELETE FROM agent_invocations WHERE account_id = ? AND id = ?`)
          .bind(acct.account_id, markerId)
          .run();
        console.warn(`drafts digest: ${acct.account_id} has no identity — skipped`);
        continue;
      }
      const messageId = `${crypto.randomUUID()}@${self.split("@")[1] ?? "localhost"}`;
      const raw = buildMime({
        from: [{ name: "CJ", email: self }],
        to: [{ email: self }],
        subject,
        messageId,
        date: new Date(now),
        text,
        extraHeaders: [
          "Auto-Submitted: auto-generated",
          "X-Auto-Response-Suppress: All",
          `X-Bullmoose-Invocation: ${markerId}`,
        ],
      });
      const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
      const blobId = await store.putBlob(acct.tenant_id, acct.account_id, buf);
      const inboxId = await store.ensureRoleMailbox(acct.account_id, "inbox", "Inbox");
      const emailId = `e_${crypto.randomUUID()}`;
      await store.insertEmail(acct.account_id, {
        id: emailId,
        blobId,
        threadId: `t_${crypto.randomUUID()}`,
        messageId,
        inReplyTo: null,
        subject,
        from: [{ name: "CJ", email: self }],
        to: [{ email: self }],
        cc: [],
        bcc: [],
        preview: text.slice(0, 256),
        bodyText: text,
        size: raw.byteLength,
        receivedAt: now,
        hasAttachment: false,
        attachments: [],
        mailboxIds: [inboxId],
        keywords: ["$agent"], // unseen on purpose — it lands to be read
      });
      await commitChanges(env.ACCOUNT_DO, acct.account_id, [
        { collection: "Email", created: [emailId] },
        { collection: "Mailbox", updated: [inboxId] },
        { collection: "AgentInvocation", created: [markerId] },
      ]);
      sent += 1;
    } catch (err) {
      // One account's failure must not sink the batch.
      console.error(`drafts digest: ${acct.account_id} failed: ${String(err).slice(0, 160)}`);
    }
  }
  return { sent };
}
