import PostalMime from "postal-mime";
import { armResponder, commitChanges } from "@bullmoose/account-do";
import {
  ftsTextOf,
  htmlToIndexText,
  Mailstore,
  normalizeMessageId,
  previewText,
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
  /** Cloud agent runtime — poked after invocation inserts (fast path). */
  AGENT?: Fetcher;
  /** "1" enables POST /dev/inject (guarded; local testing only). */
  DEV_INJECT?: string;
  INTERNAL_TOKEN?: string;
}

/** Value shape stored under route:{domain}:{localpart} in KV. */
interface Route {
  kind: "mailbox" | "alias" | "forward" | "catchall";
  accountId: string;
  tenantId: string;
  /**
   * Verified Email Routing destinations that also get a copy after the
   * message is stored (deliver-AND-forward — e.g. keep Gmail as a live
   * backup while trialing the platform).
   */
  forwardTo?: string[];
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    const raw = await new Response(message.raw).arrayBuffer();
    const result = await deliver(env, message.from, message.to, raw);
    if (result.rejected) {
      message.setReject(result.rejected);
      return;
    }
    pokeAgent(env, ctx, result);
    // Copies go out only after the store succeeded; a forward failure must
    // not bounce a message we already delivered.
    for (const addr of result.forwardTo ?? []) {
      try {
        await message.forward(addr);
      } catch (err) {
        console.error(`forwardTo ${addr} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  },

  // Local-dev injection: wrangler dev can't receive SMTP, so tests POST
  // raw MIME here. Requires DEV_INJECT=1 AND the internal token.
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
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
      pokeAgent(env, _ctx, result);
      return new Response(JSON.stringify(result), {
        status: result.rejected ? 550 : 200,
        headers: { "content-type": "application/json" },
      });
    }

    // One-shot full-text backfill for databases that predate common/004.
    // Lives here because this worker already owns "extract text from raw
    // MIME" and already binds both DB and BLOBS. Same internal-token guard
    // as /dev/inject, but NOT behind DEV_INJECT — it is a production runbook
    // step (docs/DEPLOY.md).
    if (
      request.method === "POST" &&
      url.pathname === "/admin/fts/backfill" &&
      (env.INTERNAL_TOKEN ?? "") !== "" &&
      request.headers.get("x-internal-token") === env.INTERNAL_TOKEN
    ) {
      return Response.json(await backfillFts(env, url.searchParams));
    }

    return new Response("bullmoose-ingest", { status: 200 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Index one batch of already-stored messages, newest first.
 *
 * Resumable and idempotent: the work queue is "emails with no `emails_fts_map`
 * row", so every pass shrinks it, an interrupted run loses nothing, and
 * re-running after it reaches zero is a no-op. The operator loops on
 * `remaining` — see docs/DEPLOY.md.
 *
 * `deep=1` (the default) re-reads each raw message from R2 and parses it, so
 * historical mail gets its FULL body indexed, the same as new mail. `deep=0`
 * indexes subject/addresses/preview only: no R2 reads, far faster, and the
 * honest choice if you only want the scan-to-index speedup and can live with
 * old bodies being searchable to 256 characters.
 */
async function backfillFts(env: Env, params: URLSearchParams): Promise<{
  scanned: number;
  indexed: number;
  failed: number;
  remaining: number;
  deep: boolean;
}> {
  const store = new Mailstore(env.DB, env.BLOBS);
  const account = params.get("account");
  const deep = params.get("deep") !== "0";
  // A deep pass costs one MIME parse per message, and CPU-per-invocation is
  // the tightest budget on the free tier (capacity-and-scaling.md §2.1), so
  // the default is small and the LOOP does the volume. Shallow passes are
  // pure D1 and can take the ceiling.
  const fallback = deep ? 25 : 200;
  const ceiling = deep ? 200 : 500;
  const asked = Number(params.get("limit") ?? fallback);
  // `limit=0` is a STATUS call: report `remaining` and index nothing. An
  // operator running the loop below needs a way to ask "how far in am I?"
  // that does not itself do work.
  const limit = Math.min(Math.max(0, Number.isFinite(asked) ? asked : fallback), ceiling);

  const todo = limit === 0 ? [] : await store.unindexedEmailIds(account, limit);
  let indexed = 0;
  let failed = 0;
  const tenants = new Map<string, string>();

  for (const { accountId, id } of todo) {
    const row = await store.getEmailRow(accountId, id);
    if (!row) continue; // destroyed between the scan and now
    let bodyText = row.preview;
    if (deep) {
      try {
        const blob = await store.getBlob(await tenantOf(env, tenants, accountId), accountId, row.blobId);
        if (blob) {
          const parsed = await PostalMime.parse(await blob.arrayBuffer());
          bodyText = bodyTextOf(parsed) || row.preview;
        }
      } catch (err) {
        // A blob that will not parse must not stall the whole backfill —
        // index what D1 knows and keep going, but say that it happened.
        failed++;
        console.error(`fts backfill: ${id} body unavailable: ${err}`);
      }
    }
    await store.reindexEmailText(accountId, id, ftsTextOf({ ...row, bodyText }));
    indexed++;
  }

  return {
    scanned: todo.length,
    indexed,
    failed,
    remaining: await store.unindexedEmailCount(account),
    deep,
  };
}

/** Fast-path wake for the cloud agent runtime; the cron sweep is the net. */
function pokeAgent(
  env: Env,
  ctx: ExecutionContext,
  result: { invocations?: number },
): void {
  if (!env.AGENT || !result.invocations) return;
  ctx.waitUntil(
    env.AGENT.fetch("https://agent.internal/drain", {
      method: "POST",
      headers: { "x-internal-token": env.INTERNAL_TOKEN ?? "" },
    }).then(
      () => undefined,
      (err) => console.error(`agent poke failed: ${err}`),
    ),
  );
}

async function deliver(
  env: Env,
  envelopeFrom: string,
  envelopeTo: string,
  raw: ArrayBuffer,
): Promise<{ rejected?: string; emailId?: string; forwardTo?: string[]; invocations?: number }> {
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
    preview: previewText(parsed.text, parsed.html),
    // The full body, for the FTS index only — never stored as a column
    // (the bytes are in R2). This is the step that makes message bodies
    // searchable server-side at all; see common/004.
    bodyText: bodyTextOf(parsed),
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
        // envelopeTo keeps the plus-tag (route lookup strips it) — the
        // ledger pipeline uses it to select a digest target.
        JSON.stringify({ emailId, threadId, envelopeTo: envelopeTo.toLowerCase() }),
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

  return {
    emailId,
    ...(route.forwardTo?.length ? { forwardTo: route.forwardTo } : {}),
    ...(invocationIds.length > 0 ? { invocations: invocationIds.length } : {}),
  };
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

/**
 * The tenant an account belongs to — needed to build an R2 blob key, and NOT
 * something delivery ever has to look up (the KV route carries it).
 *
 * `accounts.tenant_id` is authoritative; the id-prefix fallback holds because
 * provisioning mints `${tenantId}__a_${rand}` (`services/provision`), and it
 * is what keeps this working if the control plane ever moves off this binding.
 * Memoised per request: a backfill batch is usually one account.
 */
async function tenantOf(env: Env, cache: Map<string, string>, accountId: string): Promise<string> {
  const hit = cache.get(accountId);
  if (hit !== undefined) return hit;
  let tenantId = accountId.split("__")[0] ?? "";
  try {
    const row = await env.DB.prepare(`SELECT tenant_id FROM accounts WHERE id = ?`)
      .bind(accountId)
      .first<{ tenant_id: string }>();
    if (row?.tenant_id) tenantId = row.tenant_id;
  } catch {
    /* control plane not on this binding — the prefix is the answer */
  }
  cache.set(accountId, tenantId);
  return tenantId;
}

/**
 * The searchable text of a parsed message.
 *
 * `text/plain` when there is one; otherwise the HTML part stripped to words.
 * The `??`-with-fallback order matters — an HTML-only newsletter has no
 * `.text` at all, and those are exactly the messages people search for later.
 */
function bodyTextOf(parsed: { text?: string; html?: string }): string {
  const text = parsed.text?.trim();
  return text && text.length > 0 ? text : htmlToIndexText(parsed.html);
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
