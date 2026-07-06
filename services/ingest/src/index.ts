import PostalMime from "postal-mime";
import { commitChanges } from "@bullmoose/account-do";
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
 */

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  ROUTES: KVNamespace;
  ACCOUNT_DO: DurableObjectNamespace;
}

/** Value shape stored under route:{domain}:{localpart} in KV. */
interface Route {
  kind: "mailbox" | "alias" | "forward" | "catchall";
  accountId: string;
  tenantId: string;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext) {
    const [localpart = "", domain = ""] = message.to.toLowerCase().split("@");
    const route = await resolveRoute(env.ROUTES, domain, localpart);
    if (!route) {
      message.setReject("550 5.1.1 recipient unknown");
      return;
    }

    const raw = await new Response(message.raw).arrayBuffer();
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

    // Single-writer state bump; pushes StateChange to connected clients.
    await commitChanges(env.ACCOUNT_DO, route.accountId, [
      { collection: "Email", created: [emailId] },
      { collection: "Mailbox", updated: [inboxId] },
    ]);
  },
} satisfies ExportedHandler<Env>;

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
