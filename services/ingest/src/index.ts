import PostalMime from "postal-mime";
import { armResponder, commitChanges } from "@bullmoose/account-do";
import {
  ftsTextOf,
  htmlToIndexText,
  Mailstore,
  normalizeMessageId,
  previewText,
  QUARANTINE_NAME,
  QUARANTINE_ROLE,
  type AttachmentMeta,
  type EmailAddress,
} from "@bullmoose/mailstore";
import {
  EXPENSIVE_STAGE,
  bumpDenyCounter,
  normalizeSender,
  resolveBouncerBinding,
  runBoundaryStages2to4,
  senderDomainOf,
  stage1SenderSets,
  type BouncerBinding,
  type BoundaryVerdict,
} from "./boundary";
import type { BoundaryMessage } from "./boundaryContract";
import { sweepGraduations } from "./graduationSweep";
import { extractDueAt } from "@bullmoose/scheduling";
import { SIDESTEP_WRITER, sidestepAttachments, sidestepThreshold } from "./sidestep";
import {
  composePrivacy,
  mechanicalRequires,
  privacyFloorOf,
  stampInvocationFacets,
} from "./facets";

/**
 * Ingest — the Email Routing target for every hosted domain.
 *
 * Pipeline per message:
 *   1. resolve RCPT via the KV route table (exact → plus-strip → catch-all)
 *   2. the s12 boundary cascade (boundary.ts): stage 1 on the bare envelope
 *      (deny-listed domains exit at the SMTP edge with ZERO storage), stages
 *      2–4 on the parsed message (rejects go to the quarantine mailbox with a
 *      chain row, rescuable — never deleted)
 *   3. store raw RFC 5322 bytes in R2 (blobId = content hash)
 *   4. parse MIME and insert metadata into the account's D1 shard
 *   5. side-step large attachments into the Files realm as FileNodes
 *      (s03.B T3, sidestep.ts) — additive and fail-open
 *   6. commit to AccountDO → state bump + WebSocket push to live clients
 *   7. evaluate delivery-armed responders (vacation, agent watchdogs) and
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
  /**
   * s03.B T3 — bytes at or above which an inbound attachment also becomes a
   * FileNode. Deployment-wide; a route may override it per account. Unset uses
   * `DEFAULT_SIDESTEP_MIN_BYTES`; "0" turns the sidestep off. See sidestep.ts.
   */
  ATTACHMENT_SIDESTEP_BYTES?: string;
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
  /**
   * Per-account attachment-sidestep threshold in bytes (s03.B T3). The route
   * is where a per-account policy value costs nothing: delivery has already
   * read this key to find the recipient. Absent → the worker's env var, then
   * the conservative default; `0` disables the sidestep for this address.
   */
  sidestepBytes?: number;
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

  // Periodic work rides the same cron + scheduled() pattern the agent worker
  // established (services/agent/src/index.ts: failStaleRunning /
  // expireStaleProposals / drain). Here: the s12 graduation sweep — repeat
  // spam domains graduate into the deny list so their future mail exits at
  // the SMTP edge instead of paying Bayes compute.
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await sweepGraduations(env);
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
async function backfillFts(
  env: Env,
  params: URLSearchParams,
): Promise<{
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
        const blob = await store.getBlob(
          await tenantOf(env, tenants, accountId),
          accountId,
          row.blobId,
        );
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
function pokeAgent(env: Env, ctx: ExecutionContext, result: { invocations?: number }): void {
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
): Promise<{
  rejected?: string;
  emailId?: string;
  forwardTo?: string[];
  invocations?: number;
  /** The firing stage, when the boundary shunted this message to quarantine. */
  quarantined?: string;
  /** The mid-band stage, when the message is held pending the classifier. */
  screened?: string;
  /**
   * FileNode ids minted by the attachment sidestep (s03.B T3). Reported so a
   * `/dev/inject` or curl drive — which `s03.B/devPlan.md` makes the real
   * acceptance signal for this UI-free slice — can see that it fired.
   */
  fileNodes?: string[];
}> {
  const [localpart = "", domain = ""] = envelopeTo.toLowerCase().split("@");
  const route = await resolveRoute(env.ROUTES, domain, localpart);
  if (!route) return { rejected: "550 5.1.1 recipient unknown" };

  const store = new Mailstore(env.DB, env.BLOBS);

  // s12 stage 1 — sender sets, on the bare envelope, BEFORE the parse and
  // BEFORE any storage: a deny-listed domain exits at the SMTP edge (5xx —
  // retry becomes the sender's problem) having cost one KV get, one D1 read
  // and one daily-counter upsert. Counters, never chain rows (the industrial
  // tier's audit is proportional to its decision value).
  const s1 = await stage1SenderSets(env, route, envelopeFrom);
  if (s1.action === "REJECT_EDGE") {
    await bumpDenyCounter(env.DB, senderDomainOf(normalizeSender(envelopeFrom)));
    return { rejected: s1.smtpReply ?? "550 5.7.1 sender address rejected" };
  }

  const parsed = await PostalMime.parse(raw);
  const bodyText = bodyTextOf(parsed);

  // s12 stages 2–4 — only for stage-1 survivors; a known-good ACCEPT skips
  // every remaining rejection stage and goes straight to stamping.
  let verdict: BoundaryVerdict = s1;
  if (s1.action === "CONTINUE") {
    const sender = normalizeSender(envelopeFrom);
    const msg: BoundaryMessage = {
      sender,
      senderDomain: senderDomainOf(sender),
      recipient: envelopeTo.toLowerCase(),
      subject: parsed.subject ?? "",
      text: bodyText,
      headers: (parsed.headers ?? []).map((h) => ({ key: h.key.toLowerCase(), value: h.value })),
      size: raw.byteLength,
      hasAttachment: (parsed.attachments ?? []).some((a) => a.disposition !== "inline"),
    };
    verdict = await runBoundaryStages2to4(env.DB, route.accountId, msg);
  }

  if (verdict.action === "REJECT_STORE") {
    try {
      const out = await quarantineDeliver(
        env,
        store,
        route,
        { raw, parsed, bodyText, envelopeFrom },
        verdict.stage ?? "unknown",
      );
      // Expensive-stage (sieve/bayes) rejects feed the graduation loop's
      // per-domain counters (wave 2-C) — bumped only when the hold actually
      // landed, so counts never exceed rescue opportunities. Cheap-stage
      // holds (blocked books, auth) stay chains-only, as wave 1-A pinned.
      if (EXPENSIVE_STAGE.test(verdict.stage ?? "")) {
        await bumpDenyCounter(env.DB, senderDomainOf(normalizeSender(envelopeFrom)));
      }
      return out;
    } catch (err) {
      // Fail OPEN: a shard that predates the quarantine tables (or any store
      // failure) must not bounce or lose mail — deliver to the inbox exactly
      // as pre-s12 ingest did, and say so. This is what keeps the s12
      // migrations non-blockers.
      console.error(
        `quarantine store failed (stage ${verdict.stage}): ${
          err instanceof Error ? err.message : err
        }; delivering to inbox`,
      );
    }
  } else if (verdict.action === "SCREEN") {
    // The Bayes mid-band (stage 5's doorway): hold ONLY when the tenant has
    // a classifier to come for the message — a hold nobody will ever judge
    // is lost mail, so no bouncer binding means normal delivery, said aloud.
    const bouncer = await resolveBouncerBinding(env.DB, route.tenantId);
    if (bouncer === null) {
      console.log(
        `mid-band (${verdict.stage}) with no bouncer binding for tenant ${route.tenantId}: delivering normally`,
      );
    } else {
      try {
        return await screenDeliver(
          env,
          store,
          route,
          { raw, parsed, bodyText, envelopeFrom },
          verdict.stage ?? "bayes-mid",
          bouncer,
        );
      } catch (err) {
        // Same fail-open as the quarantine store: never bounce, never lose.
        console.error(
          `screening store failed (stage ${verdict.stage}): ${
            err instanceof Error ? err.message : err
          }; delivering to inbox`,
        );
      }
    }
  }

  const blobId = await store.putBlob(route.tenantId, route.accountId, raw);
  const inReplyTo = normalizeMessageId(parsed.inReplyTo);
  const threadId = await store.resolveThreadId(route.accountId, inReplyTo);
  const inboxId = await store.ensureRoleMailbox(route.accountId, "inbox", "Inbox");

  const stored = await storeAttachments(store, route, parsed);

  // s03.B T3 — the attachment sidestep. A large attachment ALSO becomes a
  // FileNode under the account's Attachments folder, so it is addressable as a
  // file instead of only as a row inside this one message. Additive: the
  // attachment metadata below is unchanged except for the `fileNodeId`
  // cross-link, and `sidestepAttachments` is total (it never throws), so a
  // Files failure cannot cost the recipient their mail.
  //
  // Its own Mailstore, because provenance differs: emails written by delivery
  // carry NULL provenance (no acting principal), while a file this path
  // creates records `system:ingest` as its writer.
  const sidestep = await sidestepAttachments(
    new Mailstore(env.DB, env.BLOBS, SIDESTEP_WRITER),
    route.accountId,
    stored,
    sidestepThreshold(env, route),
  );
  const attachments = sidestep.attachments;

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
    bodyText,
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
    `SELECT id, name, sla_seconds, config_json FROM agent_bindings
     WHERE account_id = ? AND enabled = 1 AND trigger_on = 'mailbox-delivery'`,
  )
    .bind(route.accountId)
    .all<{ id: string; name: string; sla_seconds: number | null; config_json: string }>();

  // s11 T1/T6 — the mechanical facets, computed ONCE per message (no model,
  // no judgment; the judged facets are s12's bouncer@): the deterministic
  // due-date proposal and the derived capability requirements. Per-binding
  // privacy composes below, because the floor is binding config.
  const dueAt = extractDueAt({ subject: parsed.subject ?? "", text: bodyText, now: Date.now() });
  const requires = mechanicalRequires({
    bodyTextChars: bodyText.length,
    attachmentTypes: attachments.map((a) => a.type),
  });

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
    // The stamp rides AFTER the unchanged INSERT (see stampInvocationFacets
    // for why): ingest stamps no privacy of its own — the stamp is NULL — so
    // the composed class is exactly the binding's floor, or NULL (DefaultCase).
    // sender_class is stage 1's verdict (s12 1-A): 'known'/'unknown' against
    // the recipient's default book, NULL when there is no book to judge by.
    await stampInvocationFacets(env.DB, route.accountId, invId, {
      dueAt,
      privacy: composePrivacy(null, [privacyFloorOf(binding.config_json)]),
      requires,
      senderClass: s1.action === "ACCEPT" || s1.action === "CONTINUE" ? s1.senderClass : null,
    });
    invocationIds.push(invId);
  }

  // Single-writer state bump; pushes StateChange to connected clients.
  await commitChanges(env.ACCOUNT_DO, route.accountId, [
    { collection: "Email", created: [emailId] },
    { collection: "Mailbox", updated: [inboxId] },
    ...(invocationIds.length > 0
      ? [{ collection: "AgentInvocation", created: invocationIds }]
      : []),
    // Side-stepped files ride the SAME commit — one DO round trip, and a
    // client watching FileNode/changes learns about the file in the same push
    // that announces the message it arrived on. A FileNode row that never
    // reached the changelog would read back on a direct get and be invisible
    // to sync (filenode.ts's write-choreography rule).
    ...(sidestep.created.length > 0 ? [{ collection: "FileNode", created: sidestep.created }] : []),
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
    ...(sidestep.created.length > 0 ? { fileNodes: sidestep.created } : {}),
  };
}

/**
 * REJECT-STORE: the message is stored — full fidelity, rescuable, never
 * deleted — but in the HELD mailbox (the registered `junk` role, displayed
 * 'Quarantined'), with its 'shunted' chain row (message + chain commit
 * atomically; see Mailstore.insertQuarantinedEmail).
 *
 * Deliberately absent from this path: agent invocations (suspected spam must
 * not reach the lobby), armed responders (never auto-reply to judged spam),
 * and deliver-AND-forward copies (a shunted message is held, not propagated).
 * The AccountDO commit still runs so live clients see the quarantine fill.
 */
async function quarantineDeliver(
  env: Env,
  store: Mailstore,
  route: Route,
  m: {
    raw: ArrayBuffer;
    parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
    bodyText: string;
    envelopeFrom: string;
  },
  stage: string,
): Promise<{ emailId: string; quarantined: string }> {
  const blobId = await store.putBlob(route.tenantId, route.accountId, m.raw);
  const inReplyTo = normalizeMessageId(m.parsed.inReplyTo);
  const threadId = await store.resolveThreadId(route.accountId, inReplyTo);
  // Lazily ensured (the inbox precedent) so an account provisioned before the
  // seed existed still gets one on first shunt. The role is the REGISTERED
  // 'junk' (RFC 8621) so standards clients treat it as spam; the NAME is
  // 'Quarantined' — see @bullmoose/mailstore QUARANTINE_ROLE.
  const quarantineId = await store.ensureRoleMailbox(
    route.accountId,
    QUARANTINE_ROLE,
    QUARANTINE_NAME,
  );
  const attachments = await storeAttachments(store, route, m.parsed);

  const emailId = `e_${crypto.randomUUID()}`;
  const sender = normalizeSender(m.envelopeFrom);
  await store.insertQuarantinedEmail(
    route.accountId,
    {
      id: emailId,
      blobId,
      threadId,
      messageId: normalizeMessageId(m.parsed.messageId),
      inReplyTo,
      subject: m.parsed.subject ?? "",
      from: toAddresses(m.parsed.from ? [m.parsed.from] : []),
      to: toAddresses(m.parsed.to ?? []),
      cc: toAddresses(m.parsed.cc ?? []),
      bcc: [],
      preview: previewText(m.parsed.text, m.parsed.html),
      bodyText: m.bodyText,
      size: m.raw.byteLength,
      receivedAt: Date.now(),
      hasAttachment: attachments.some((a) => a.disposition !== "inline"),
      attachments,
      mailboxIds: [quarantineId],
      keywords: [],
    },
    {
      event: "shunted",
      sender,
      domain: senderDomainOf(sender),
      stage,
      emailId,
      at: Date.now(),
    },
  );

  await commitChanges(env.ACCOUNT_DO, route.accountId, [
    { collection: "Email", created: [emailId] },
    { collection: "Mailbox", updated: [quarantineId] },
  ]);

  return { emailId, quarantined: stage };
}

/**
 * The MID-BAND hold (s12 wave 2-C, cascade stage 5's doorway): store the
 * message in the HELD mailbox with a 'screened' chain row — distinct
 * from 'shunted', because nothing has judged it spam yet — and enqueue ONE
 * bouncer-classify invocation for the tenant's bouncer binding, all in the
 * SAME D1 batch: "held" and "a classifier is coming" commit together or not
 * at all (a hold with no classifier enqueued is mail nobody will ever free).
 *
 * The hold is bouncer's WORKING STATE, not a human destination: a message the
 * classifier cannot decide becomes a batched PROPOSAL (services/agent
 * midBandProposal.ts), never a pile someone is expected to go browse.
 *
 * Like quarantineDeliver, no mailbox-delivery invocations (nothing reaches
 * the lobby until it is judged clean), no armed responders, no
 * deliver-AND-forward copies. The classifier's enqueue is the same
 * agent_invocations INSERT + poke that ordinary bindings get — it rides the
 * s07 T5 cost machinery like any other invocation (free when the binding's
 * model resolves to workers-ai).
 */
async function screenDeliver(
  env: Env,
  store: Mailstore,
  route: Route,
  m: {
    raw: ArrayBuffer;
    parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
    bodyText: string;
    envelopeFrom: string;
  },
  stage: string,
  bouncer: BouncerBinding,
): Promise<{ emailId: string; screened: string; invocations: number }> {
  const blobId = await store.putBlob(route.tenantId, route.accountId, m.raw);
  const inReplyTo = normalizeMessageId(m.parsed.inReplyTo);
  const threadId = await store.resolveThreadId(route.accountId, inReplyTo);
  const quarantineId = await store.ensureRoleMailbox(
    route.accountId,
    QUARANTINE_ROLE,
    QUARANTINE_NAME,
  );
  const attachments = await storeAttachments(store, route, m.parsed);

  const emailId = `e_${crypto.randomUUID()}`;
  const invId = `inv_${crypto.randomUUID()}`;
  const sender = normalizeSender(m.envelopeFrom);
  const domain = senderDomainOf(sender);
  await store.insertQuarantinedEmail(
    route.accountId,
    {
      id: emailId,
      blobId,
      threadId,
      messageId: normalizeMessageId(m.parsed.messageId),
      inReplyTo,
      subject: m.parsed.subject ?? "",
      from: toAddresses(m.parsed.from ? [m.parsed.from] : []),
      to: toAddresses(m.parsed.to ?? []),
      cc: toAddresses(m.parsed.cc ?? []),
      bcc: [],
      preview: previewText(m.parsed.text, m.parsed.html),
      bodyText: m.bodyText,
      size: m.raw.byteLength,
      receivedAt: Date.now(),
      hasAttachment: attachments.some((a) => a.disposition !== "inline"),
      attachments,
      mailboxIds: [quarantineId],
      keywords: [],
    },
    {
      event: "screened",
      sender,
      domain,
      stage,
      emailId,
      at: Date.now(),
    },
    [
      // The classifier's enqueue, riding the hold's batch. The invocation
      // belongs to the BOUNCER binding's account (the drain joins bindings on
      // the invocation's account); the context names the message's account —
      // the classifier acts across that seam on purpose (bouncer sees the
      // whole tenant's boundary).
      env.DB.prepare(
        `INSERT INTO agent_invocations
           (id, account_id, binding_id, binding_name, status, email_id, context_json, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).bind(
        invId,
        bouncer.accountId,
        bouncer.id,
        bouncer.name,
        emailId,
        JSON.stringify({
          kind: "bouncer-classify",
          accountId: route.accountId,
          tenantId: route.tenantId,
          emailId,
          sender,
          domain,
          stage,
        }),
        Date.now(),
      ),
    ],
  );

  await commitChanges(env.ACCOUNT_DO, route.accountId, [
    { collection: "Email", created: [emailId] },
    { collection: "Mailbox", updated: [quarantineId] },
  ]);
  await commitChanges(env.ACCOUNT_DO, bouncer.accountId, [
    { collection: "AgentInvocation", created: [invId] },
  ]);

  // invocations: 1 → the caller pokes the agent worker, same as any enqueue.
  return { emailId, screened: stage, invocations: 1 };
}

/**
 * Each attachment becomes its own content-hash blob so Email/get can hand
 * out real, individually downloadable blobIds. Shared by the inbox and
 * quarantine store paths — a rescued message must be as whole as a delivered
 * one.
 */
async function storeAttachments(
  store: Mailstore,
  route: Route,
  parsed: Awaited<ReturnType<typeof PostalMime.parse>>,
): Promise<AttachmentMeta[]> {
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
  return attachments;
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

function toAddresses(list: Array<{ name?: string; address?: string }>): EmailAddress[] {
  return list
    .filter((a) => a.address)
    .map((a) => ({ ...(a.name ? { name: a.name } : {}), email: a.address as string }));
}
