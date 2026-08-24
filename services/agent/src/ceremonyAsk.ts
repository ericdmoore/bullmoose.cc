// s33 agent-side — the three verbs a role@ needs around a ceremony:
// ASK (reply into the thread with the link), CONSUME (the tier-3 gate:
// PASS|FAIL and nothing else — the phone-tree principle, the Bureau's own
// invariant applied to identity), and NOTIFY (OQ5: a failed step-up is a
// signal the real person should see, delivered to the ENROLLED address).
//
// The link is deliberately not treated as a secret worth more than its TTL:
// it goes INTO THE THREAD, to the tier-2-verified asker, because a
// compromised mailbox holding the link still cannot produce an assertion —
// that is the entire reason the factor is a passkey (s33 hole #1). What
// never goes to the thread is the DISCLOSURE, which the consuming pipeline
// sends only after a PASS, and the notice, which goes to the enrolled
// address alone.
//
// OQ2, enforced at the ask: the category must be OPERATOR-DECLARED on the
// binding (`disclosureCategories` in config). A category the agent invents
// is a category no one reviewed — refused before a row exists.

import { buildMime } from "@bullmoose/mime";
import { assertOutboundAllowed } from "@bullmoose/mailstore/outboundBound";
import { normalizeMessageId, type Mailstore } from "@bullmoose/mailstore";
import type { Env } from "./models.js";

/** Minutes, not hours: the ask is answerable at peak frustration or not at
 *  all, and a stale described act is a stale description. */
export const CEREMONY_TTL_MS = 5 * 60_000;

const sha256hex = async (s: string): Promise<string> => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const authHost = (env: Env): string => (env as { AUTH_HOST?: string }).AUTH_HOST ?? "auth.bullmoose.cc";

export interface CeremonyAsk {
  category: string;
  /** The described act, verbatim — what the page renders and the human
   *  approves. Written by the PIPELINE, reviewed by being specific. */
  description: string;
  /** The thread the eventual disclosure answers into. */
  messageId?: string;
  /** The asker — the reply's recipient, governed by the binding's book. */
  to: string;
  selfAddress: string;
}

export interface CeremonyJob {
  id: string;
  account_id: string;
  tenant_id: string;
  binding_id: string;
  binding_name: string;
}

/**
 * Write the ceremony row and reply into the thread with the link. Returns
 * the ceremony id, or a named refusal (undeclared category, outbound bound)
 * — never a silent partial: the row lands only if the reply relays.
 */
export async function requestCeremony(
  env: Env,
  store: Mailstore,
  job: CeremonyJob,
  ask: CeremonyAsk,
): Promise<{ ceremonyId: string } | { refused: string }> {
  const binding = await env.DB.prepare(`SELECT config_json FROM agent_bindings WHERE account_id = ? AND id = ?`)
    .bind(job.account_id, job.binding_id)
    .first<{ config_json: string }>();
  if (!binding) return { refused: `binding ${job.binding_id} does not exist` };
  let declared: string[] = [];
  try {
    const cfg = JSON.parse(binding.config_json || "{}") as { disclosureCategories?: unknown };
    if (Array.isArray(cfg.disclosureCategories))
      declared = cfg.disclosureCategories.filter((c) => typeof c === "string");
  } catch {
    /* an unreadable config declares nothing */
  }
  if (!declared.includes(ask.category)) {
    return {
      refused:
        `category "${ask.category}" is not operator-declared on this binding ` +
        `(disclosureCategories: [${declared.join(", ")}]) — a category the agent invents is a category no one reviewed (s33 OQ2)`,
    };
  }

  const owner = await enrolledOf(env, job.account_id);
  if (!owner) return { refused: `account ${job.account_id} has no principal — nobody's passkey could answer` };

  const now = Date.now();
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const ceremonyId = `cer_${crypto.randomUUID()}`;
  const link = `https://${authHost(env)}/ceremony#${token}`;

  const text =
    `This needs you, not just your mailbox.\n\n` +
    `${ask.description}\n\n` +
    `If that is what you want, approve it with your passkey (the link works for 5 minutes):\n${link}\n\n` +
    `If you did not ask for this, do nothing — the ask expires on its own, and doing nothing is a refusal.`;
  const messageId = `<${crypto.randomUUID()}@${ask.selfAddress.split("@")[1] ?? "bullmoose.cc"}>`;
  const raw = buildMime({
    from: [{ name: job.binding_name, email: ask.selfAddress }],
    to: [{ email: ask.to }],
    subject: "Approve with your passkey?",
    messageId,
    ...(ask.messageId ? { inReplyTo: ask.messageId } : {}),
    date: new Date(now),
    text,
    extraHeaders: [
      "Auto-Submitted: auto-replied",
      "X-Auto-Response-Suppress: All",
      `X-Bullmoose-Invocation: ${job.id}`,
    ],
  });
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const blobId = await store.putBlob(job.tenant_id, job.account_id, buf);
  await assertOutboundAllowed(env, job, [ask.to]);
  const res = await env.SUBMIT.fetch("https://submit.internal/internal/submit", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_TOKEN },
    body: JSON.stringify({
      accountId: job.account_id,
      tenantId: job.tenant_id,
      blobId,
      envelope: { mailFrom: ask.selfAddress, rcptTo: [ask.to] },
    }),
  });
  if (!res.ok) return { refused: `the ceremony reply did not relay (${res.status})` };

  // The row lands AFTER the relay succeeded: a ceremony nobody was told
  // about is a ledger row describing an ask that never happened.
  await env.DB.prepare(
    `INSERT INTO ceremonies
       (id, principal_id, account_id, binding_id, category, description, message_id, secret_hash, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(
      ceremonyId,
      owner.principalId,
      job.account_id,
      job.binding_id,
      ask.category,
      ask.description,
      normalizeMessageId(ask.messageId ?? null),
      await sha256hex(token),
      now,
      now + CEREMONY_TTL_MS,
    )
    .run();
  return { ceremonyId };
}

/**
 * The tier-3 gate: PASS exactly once, FAIL every other answer — and the
 * caller learns nothing else (not "expired", not "wrong category", not
 * "never asked"): the distinctions are in the ledger for the human, not in
 * the answer for the machine.
 */
export async function consumeCeremonyPass(
  env: Env,
  q: { accountId: string; bindingId: string; category: string; messageId?: string | null },
): Promise<{ pass: true; ceremonyId: string } | { pass: false }> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT id FROM ceremonies
      WHERE account_id = ? AND binding_id = ? AND category = ?
        AND (? IS NULL OR message_id = ?)
        AND status = 'passed' AND consumed_at IS NULL AND expires_at > ?
      ORDER BY decided_at DESC LIMIT 1`,
  )
    .bind(q.accountId, q.bindingId, q.category, q.messageId ?? null, q.messageId ?? null, now)
    .first<{ id: string }>();
  if (!row) return { pass: false };
  const consumed = await env.DB.prepare(`UPDATE ceremonies SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`)
    .bind(now, row.id)
    .run();
  if (consumed.meta.changes === 0) return { pass: false }; // raced — the other caller won
  return { pass: true, ceremonyId: row.id };
}

async function enrolledOf(env: Env, accountId: string): Promise<{ principalId: string; email: string } | null> {
  const row = await env.DB.prepare(
    `SELECT p.id, p.login_email FROM accounts a JOIN principals p ON p.id = a.principal_id
      WHERE a.id = ? AND a.deleted_at IS NULL`,
  )
    .bind(accountId)
    .first<{ id: string; login_email: string }>();
  return row ? { principalId: row.id, email: row.login_email } : null;
}

/**
 * OQ5's sweep: every FAILED, un-notified ceremony becomes one inbox note to
 * the ENROLLED address — never the asker, never the thread. Delivered as a
 * direct inbox insert (the enrolled address is an account HERE; no egress,
 * no bound questions), stamped so it sends exactly once.
 */
export async function sweepCeremonyFailNotices(env: Env, store: Mailstore): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.account_id, c.description, c.decided_at FROM ceremonies c
      WHERE c.status = 'failed' AND c.notified_at IS NULL`,
  ).all<{ id: string; account_id: string; description: string; decided_at: number | null }>();
  let sent = 0;
  for (const c of results ?? []) {
    const now = Date.now();
    const stamped = await env.DB.prepare(`UPDATE ceremonies SET notified_at = ? WHERE id = ? AND notified_at IS NULL`)
      .bind(now, c.id)
      .run();
    if (stamped.meta.changes === 0) continue; // another sweep won the race
    const inboxId = await store.ensureRoleMailbox(c.account_id, "inbox", "Inbox");
    await store.insertEmail(c.account_id, {
      id: `e_${crypto.randomUUID()}`,
      blobId: `notice-${c.id}`,
      threadId: `t_${crypto.randomUUID()}`,
      messageId: null,
      inReplyTo: null,
      subject: "A passkey approval on your account FAILED",
      from: [{ name: "bullmoose security", email: "security-notice@bullmoose.invalid" }],
      to: [],
      cc: [],
      bcc: [],
      preview: `Someone was asked to approve: ${c.description.slice(0, 140)}`,
      bodyText:
        `Someone opened a passkey approval on your account and it FAILED — wrong passkey, or not yours.\n\n` +
        `What was being asked:\n${c.description}\n\n` +
        `Nothing was disclosed and the ask is closed. If this was you on the wrong device, ask again. ` +
        `If it was not you, someone holds a conversation with your agent — say so now.`,
      size: 0,
      receivedAt: c.decided_at ?? now,
      hasAttachment: false,
      attachments: [],
      mailboxIds: [inboxId],
      keywords: [],
    });
    sent++;
  }
  return sent;
}
