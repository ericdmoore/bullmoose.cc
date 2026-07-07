import PostalMime from "postal-mime";
import { armResponder, commitChanges } from "@bullmoose/account-do";
import {
  Mailstore,
  normalizeMessageId,
  type AttachmentMeta,
  type EmailAddress,
} from "@bullmoose/mailstore";

/**
 * Ingest — the Email Routing target for every hosted domain.
 *
 * Pipeline per message:
 *   1. resolve RCPT via the KV route table (exact → plus-strip → catch-all)
 *   2. store raw RFC 5322 bytes in R2 (blobId = content hash)
 *   3. parse MIME and insert metadata into the account's D1 shard
 *   4. commit to AccountDO → state bump + WebSocket push to live clients
 *   5. evaluate delivery-armed responders (vacation, agent watchdogs) and
 *      create agent invocations for mailbox-delivery bindings
 */

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  ROUTES: KVNamespace;
  ACCOUNT_DO: DurableObjectNamespace;
  /** "1" enables POST /dev/inject (guarded; local testing only). */
  DEV_INJECT?: string;
  INTERNAL_TOKEN?: string;
}

/** Value shape stored under route:{domain}:{localpart} in KV. */
interface Route {
  kind: "mailbox" | "alias" | "forward" | "catchall";
  accountId: string;
  tenantId: string;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext) {
    const raw = await new Response(message.raw).arrayBuffer();
    const result = await deliver(env, message.from, message.to, raw);
    if (result.rejected) message.setReject(result.rejected);
  },

  // Local-dev injection: wrangler dev can't receive SMTP, so tests POST
  // raw MIME here. Requires DEV_INJECT=1 AND the internal token.
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (
      env.DEV_INJECT === "1" &&
      request.method === "POST" &&
      url.pathname === "/dev/inject" &&
      request.headers.get("x-internal-token") === (env.INTERNAL_TOKEN ?? "")
    ) {
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      const raw = await request.arrayBuffer();
      const result = await deliver(env, from, to, raw);
      return new Response(JSON.stringify(result), {
        status: result.rejected ? 550 : 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("bullmoose-ingest", { status: 200 });
  },
} satisfies ExportedHandler<Env>;

async function deliver(
  env: Env,
  envelopeFrom: string,
  envelopeTo: string,
  raw: ArrayBuffer,
): Promise<{ rejected?: string; emailId?: string }> {
  const [localpart = "", domain = ""] = envelopeTo.toLowerCase().split("@");
  const route = await resolveRoute(env.ROUTES, domain, localpart);
  if (!route) return { rejected: "550 5.1.1 recipient unknown" };

  const store = new Mailstore(env.DB, env.BLOBS);
  const blobId = await store.putBlob(route.tenantId, route.accountId, raw);

  const parsed = await PostalMime.parse(raw);
  const inReplyTo = normalizeMessageId(parsed.inReplyTo);
  const threadId = await store.resolveThreadId(route.accountId, inReplyTo);
  const inboxId = await store.ensureRoleMailbox(route.accountId, "inbox", "Inbox");

  // Each attachment becomes its own content-hash blob so Email/get can
  // hand out real, individually downloadable blobIds.
  const attachments: AttachmentMeta[] = [];
  for (const att of parsed.attachments ?? []) {
    const content =
      typeof att.content === "string" ? new TextEncoder().encode(att.content).buffer : att.content;
    const attBlobId = await store.putBlob(route.tenantId, route.accountId, content as ArrayBuffer);
    attachments.push({
      blobId: attBlobId,
      type: att.mimeType ?? "application/octet-stream",
      name: att.filename ?? null,
      size: (content as ArrayBuffer).byteLength,
      cid: att.contentId ?? null,
      disposition: att.disposition ?? null,
    });
  }

  const emailId = `e_${crypto.randomUUID()}`;
  await store.insertEmail(route.accountId, {
    id: emailId,
    blobId,
    threadId,
    messageId: normalizeMessageId(parsed.messageId),
    inReplyTo,
    subject: parsed.subject ?? "",
    from: toAddresses(parsed.from ? [parsed.from] : []),
    to: toAddresses(parsed.to ?? []),
    cc: toAddresses(parsed.cc ?? []),
    bcc: [],
    preview: (parsed.text ?? "").slice(0, 256),
    size: raw.byteLength,
    receivedAt: Date.now(),
    hasAttachment: attachments.some((a) => a.disposition !== "inline"),
    attachments,
    mailboxIds: [inboxId],
    keywords: [],
  });

  // Agent bindings: create invocations for mailbox-delivery triggers.
  // The changelog push is what wakes `bullmoose agent serve`.
  const bindings = await env.DB.prepare(
    `SELECT id, name, sla_seconds FROM agent_bindings
     WHERE account_id = ? AND enabled = 1 AND trigger_on = 'mailbox-delivery'`,
  )
    .bind(route.accountId)
    .all<{ id: string; name: string; sla_seconds: number | null }>();

  const invocationIds: string[] = [];
  for (const binding of bindings.results) {
    const invId = `inv_${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO agent_invocations
         (id, account_id, binding_id, binding_name, status, email_id, context_json, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
      .bind(
        invId,
        route.accountId,
        binding.id,
        binding.name,
        emailId,
        JSON.stringify({ emailId, threadId }),
        Date.now(),
      )
      .run();
    invocationIds.push(invId);
  }

  // Single-writer state bump; pushes StateChange to connected clients.
  await commitChanges(env.ACCOUNT_DO, route.accountId, [
    { collection: "Email", created: [emailId] },
    { collection: "Mailbox", updated: [inboxId] },
    ...(invocationIds.length > 0
      ? [{ collection: "AgentInvocation", created: invocationIds }]
      : []),
  ]);

  // Armed responders (vacation, watchdog). RFC 3834: never auto-respond
  // to auto-submitted mail, bounces, or list traffic.
  if (autoResponseEligible(envelopeFrom, parsed)) {
    await armResponders(env, route, {
      sender: envelopeFrom.toLowerCase(),
      accountAddress: envelopeTo.toLowerCase(),
      emailId,
      origMessageId: normalizeMessageId(parsed.messageId),
      origSubject: parsed.subject ?? "",
    });
  }

  return { emailId };
}

function autoResponseEligible(
  envelopeFrom: string,
  parsed: { headers?: Array<{ key: string; value: string }>; from?: { address?: string } },
): boolean {
  if (!envelopeFrom || envelopeFrom === "<>") return false; // null sender = bounce
  const h = (key: string) =>
    parsed.headers?.find((x) => x.key.toLowerCase() === key)?.value?.toLowerCase();
  const auto = h("auto-submitted");
  if (auto && auto !== "no") return false;
  const precedence = h("precedence");
  if (precedence === "bulk" || precedence === "junk" || precedence === "list") return false;
  if (h("list-id")) return false;
  if ((parsed.from?.address ?? "").toLowerCase().startsWith("mailer-daemon")) return false;
  return true;
}

async function armResponders(
  env: Env,
  route: Route,
  msg: {
    sender: string;
    accountAddress: string;
    emailId: string;
    origMessageId: string | null;
    origSubject: string;
  },
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, wait_seconds, cancel_if, from_date, to_date
     FROM responders WHERE account_id = ? AND enabled = 1`,
  )
    .bind(route.accountId)
    .all<{
      id: string;
      wait_seconds: number;
      cancel_if: string;
      from_date: number | null;
      to_date: number | null;
    }>();

  const now = Date.now();
  for (const r of results) {
    if (r.from_date !== null && now < r.from_date) continue;
    if (r.to_date !== null && now > r.to_date) continue;
    await armResponder(env.ACCOUNT_DO, {
      responderId: r.id,
      accountId: route.accountId,
      tenantId: route.tenantId,
      accountAddress: msg.accountAddress,
      sender: msg.sender,
      origMessageId: msg.origMessageId,
      origSubject: msg.origSubject,
      emailId: msg.emailId,
      cancelIf: r.cancel_if === "invocation-active" ? "invocation-active" : "never",
      fireAt: now + r.wait_seconds * 1000,
    });
  }
}

/** exact match → plus-tag stripped → catch-all. Alias fan-out is TODO. */
async function resolveRoute(
  kv: KVNamespace,
  domain: string,
  localpart: string,
): Promise<Route | null> {
  const base = localpart.split("+")[0] ?? localpart;
  return (
    (await kv.get<Route>(`route:${domain}:${localpart}`, "json")) ??
    (base !== localpart ? await kv.get<Route>(`route:${domain}:${base}`, "json") : null) ??
    (await kv.get<Route>(`route:${domain}:*`, "json"))
  );
}

function toAddresses(
  list: Array<{ name?: string; address?: string }>,
): EmailAddress[] {
  return list
    .filter((a) => a.address)
    .map((a) => ({ ...(a.name ? { name: a.name } : {}), email: a.address as string }));
}
