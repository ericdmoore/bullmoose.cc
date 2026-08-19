import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { commitChanges } from "@bullmoose/account-do";
import { normalizeMessageId } from "@bullmoose/mailstore";
import type { EmailAddress, EmailRow, Mailstore, StoredSubmission } from "@bullmoose/mailstore";
import type { AccountAccess } from "../auth";
import {
  accountState,
  proxyChanges,
  requireAccount,
  setError,
  storeFor,
  type RequestContext,
  type SetError,
} from "./common";
import { applyEmailPatch } from "./email";
import { resolveIdentities } from "./identity";

/**
 * EmailSubmission — `set` (RFC 8621 §7.5), `get` (§7.1), `changes` (§7.2).
 *
 * Sends exit through the submit worker (service binding) which relays via SES
 * — Cloudflare cannot originate SMTP. `/set` supports create +
 * onSuccessUpdateEmail (the standard "move draft to Sent, clear $draft"
 * dance); update and destroy are not implemented, and the response says so
 * structurally rather than pretending.
 */
export function registerSubmissionMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("EmailSubmission/set", emailSubmissionSet);
  registry.register("EmailSubmission/get", emailSubmissionGet);
  registry.register("EmailSubmission/changes", async (args, ctx) => proxyChanges(ctx, args, "EmailSubmission"));
}

/**
 * EmailSubmission/get (RFC 8621 §7.1).
 *
 * This exists because `/changes` was registered without it: `/set` commits
 * created ids to the AccountDO changelog via `commitChanges` below, so the
 * server tells a client which submission ids changed and — until now — offered
 * no method to read them. A conformant client runs `/changes` then `/get`, and
 * dead-ended on the second call. That is the whole of this unit (sVOL `005`).
 *
 * ⚠️ What it deliberately does NOT do: claim a delivery outcome.
 *
 * `deliveryStatus` is `null`, permanently, until something actually populates
 * it. The delivery signal this system receives — SES bounce/complaint events
 * at `services/submit/src/index.ts:108` — is written to a KV suppression list
 * keyed by RECIPIENT and never correlated back to the submission on
 * `relay_message_id`. There is therefore no per-recipient outcome to report.
 * Synthesizing `{"<rcpt>": {delivered: "unknown", ...}}` would be spec-legal,
 * so nothing would ever flag it, and a future surface would render "unknown"
 * as though the server had checked. `null` is the honest answer and it is what
 * RFC 8621 §7 prescribes when the information is unavailable.
 *
 * `undoStatus` is echoed from the column rather than hardcoded. Today it only
 * ever holds `'final'`, written at its single call site in `submitOne` below,
 * and `'final'` is nonetheless TRUE: the row is inserted only after the relay
 * accepted the message, and `maxDelayedSend` is 0 (`session.ts`), so the send
 * genuinely cannot be undone. It is a statement about cancelability, not about
 * delivery — the delivery claim is the one above, and it is null. Echoing
 * rather than hardcoding is also what makes a future `pending`/`canceled`
 * (delayed send) readable without touching this method.
 *
 * `relayMessageId` is not exposed: it is not an RFC 8621 property, it is the
 * upstream relay's internal id, and no client has a use for it.
 */
async function emailSubmissionGet(
  args: Record<string, unknown>,
  ctx: RequestContext,
): Promise<Record<string, unknown>> {
  const access = await requireAccount(ctx, args, "read");
  const store = storeFor(ctx);

  const ids = args.ids === null || args.ids === undefined ? undefined : (args.ids as string[]);
  const properties = Array.isArray(args.properties) ? (args.properties as string[]) : null;

  const rows = await store.getSubmissions(access.accountId, ids);
  const found = new Set(rows.map((r) => r.id));

  const list = rows.map((row) => {
    const full = submissionToJmap(row);
    if (!properties) return full;
    const picked: Record<string, unknown> = { id: full.id };
    for (const p of properties) if (p in full) picked[p] = full[p];
    return picked;
  });

  return {
    accountId: access.accountId,
    state: await accountState(ctx, access.accountId),
    list,
    notFound: (ids ?? []).filter((id) => !found.has(id)),
  };
}

/**
 * Row → RFC 8621 §7 EmailSubmission.
 *
 * The envelope is re-inflated, not echoed: the row stores the flattened shape
 * the relay wants (`{mailFrom: string, rcptTo: string[]}`), while the wire type
 * is `EmailSubmissionAddress` objects — the same shape `/set` accepts. Handing
 * back the stored shape would break the obvious client round-trip of reading a
 * submission and re-submitting its envelope.
 */
function submissionToJmap(row: StoredSubmission): Record<string, unknown> {
  return {
    id: row.id,
    identityId: row.identityId,
    emailId: row.emailId,
    threadId: row.threadId,
    envelope: {
      mailFrom: { email: row.envelope.mailFrom, parameters: null },
      rcptTo: row.envelope.rcptTo.map((email) => ({ email, parameters: null })),
    },
    sendAt: new Date(row.sendAt).toISOString(),
    undoStatus: row.undoStatus,
    deliveryStatus: null,
    dsnBlobIds: [],
    mdnBlobIds: [],
  };
}

interface CreateSpec {
  emailId?: string;
  identityId?: string;
  envelope?: { mailFrom?: { email?: string }; rcptTo?: Array<{ email?: string }> } | null;
}

async function emailSubmissionSet(
  args: Record<string, unknown>,
  ctx: RequestContext,
): Promise<Record<string, unknown>> {
  const access = await requireAccount(ctx, args, "send");
  const store = storeFor(ctx);
  const oldState = await accountState(ctx, access.accountId);

  const created: Record<string, unknown> = {};
  const notCreated: Record<string, SetError> = {};
  const createdIds: string[] = [];
  /** creation-ref (#cid) → { submissionId, emailId } for onSuccess handling. */
  const byRef = new Map<string, { submissionId: string; emailId: string }>();

  // Emails whose stored message_id was reconciled to the relay's wire
  // Message-ID (SES substitutes its own — see submitOne). A real change to
  // an Email property, so it must reach the changelog or clients keep the
  // stale id in cache forever.
  const emailsStamped = new Set<string>();

  const create = (args.create as Record<string, CreateSpec> | undefined) ?? {};
  for (const [cid, spec] of Object.entries(create)) {
    try {
      const result = await submitOne(ctx, store, access, spec);
      created[cid] = { id: result.submissionId, undoStatus: "final", sendAt: result.sendAt };
      createdIds.push(result.submissionId);
      if (result.emailUpdated) emailsStamped.add(result.emailId);
      byRef.set(cid, result);
    } catch (err) {
      notCreated[cid] =
        err instanceof MethodError
          ? setError(err.type === "invalidArguments" ? "invalidProperties" : err.type, err.description)
          : setError("serverFail", String(err));
    }
  }

  // onSuccessUpdateEmail: keys are "#cid" creation refs (or submission ids);
  // values are Email PatchObjects applied to the submission's email.
  const mailboxesTouched = new Set<string>();
  const emailsUpdated: string[] = [];
  const onSuccess = (args.onSuccessUpdateEmail as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [key, patch] of Object.entries(onSuccess)) {
    const ref = key.startsWith("#") ? byRef.get(key.slice(1)) : undefined;
    if (!ref) continue; // send failed or unknown ref — nothing to update
    try {
      await applyEmailPatch(store, access.accountId, ref.emailId, patch, mailboxesTouched);
      emailsUpdated.push(ref.emailId);
    } catch (err) {
      console.error(`onSuccessUpdateEmail failed for ${ref.emailId}:`, err);
    }
  }

  // One Email-updated entry covers both kinds of update this method makes:
  // the onSuccessUpdateEmail patches above and the message_id reconciles
  // from submitOne (deduped — a send with both touches the email once).
  const emailsChanged = [...new Set([...emailsStamped, ...emailsUpdated])];

  let newState = oldState;
  if (createdIds.length > 0 || emailsChanged.length > 0) {
    const entries = [];
    if (createdIds.length > 0) {
      entries.push({ collection: "EmailSubmission", created: createdIds });
    }
    if (emailsChanged.length > 0) entries.push({ collection: "Email", updated: emailsChanged });
    if (mailboxesTouched.size > 0) {
      entries.push({ collection: "Mailbox", updated: [...mailboxesTouched] });
    }
    ({ newState } = await commitChanges(ctx.env.ACCOUNT_DO, access.accountId, entries));
  }

  return {
    accountId: access.accountId,
    oldState,
    newState,
    created,
    notCreated,
    updated: {},
    notUpdated: {},
    destroyed: [],
    notDestroyed: {},
  };
}

async function submitOne(
  ctx: RequestContext,
  store: Mailstore,
  access: AccountAccess,
  spec: CreateSpec,
): Promise<{ submissionId: string; emailId: string; sendAt: string; emailUpdated: boolean }> {
  if (!spec.emailId || !spec.identityId) {
    throw new MethodError("invalidArguments", "emailId and identityId are required");
  }

  const email = await store.getEmailRow(access.accountId, spec.emailId);
  if (!email) throw new MethodError("invalidArguments", `email ${spec.emailId} not found`);

  // Only unsent drafts may be submitted. Without this a send-scoped token
  // could re-relay any stored message in the account — including inbound
  // mail it merely received — to recipients of its choosing.
  if (!(await isDraft(store, access.accountId, email))) {
    throw new MethodError("forbidden", `email ${spec.emailId} is not a draft`);
  }

  // Identity must be one Identity/get would have offered for this account.
  const identities = await resolveIdentities(ctx, access, store);
  const identity = identities.find((i) => i.id === spec.identityId);
  if (!identity) {
    throw new MethodError("invalidArguments", `identity ${spec.identityId} not found`);
  }

  // The identity — never the client — is authoritative for the sender.
  // `envelope.mailFrom` reaches the relay as the outgoing MAIL FROM, and
  // on the Cloudflare Email path (packages/outbound) it becomes the
  // message's actual From: header, so an unchecked value is header
  // forgery, not merely a return-path quirk. An explicit value is allowed
  // (the CLI and RFC 8621 clients send one) but must name the identity.
  const requestedMailFrom = spec.envelope?.mailFrom?.email;
  if (
    typeof requestedMailFrom === "string" &&
    requestedMailFrom.trim().toLowerCase() !== identity.email.trim().toLowerCase()
  ) {
    throw new MethodError("invalidArguments", `envelope.mailFrom must match the identity's email (${identity.email})`);
  }
  const mailFrom = identity.email;

  // Recipients: explicit (Bcc needs this), or derived from the message.
  const rcptTo =
    spec.envelope?.rcptTo?.map((r) => r.email).filter((e): e is string => typeof e === "string") ??
    dedupe([...email.to, ...email.cc, ...email.bcc].map((a: EmailAddress) => a.email));
  if (rcptTo.length === 0) {
    throw new MethodError("invalidArguments", "no recipients");
  }

  const res = await ctx.env.SUBMIT.fetch("https://submit.internal/internal/submit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": ctx.env.INTERNAL_TOKEN,
    },
    body: JSON.stringify({
      accountId: access.accountId,
      tenantId: access.tenantId,
      blobId: email.blobId,
      envelope: { mailFrom, rcptTo },
    }),
  });
  if (res.status === 422) {
    throw new MethodError("forbidden", "recipient(s) on suppression list");
  }
  if (!res.ok) {
    throw new MethodError("serverFail", `relay returned ${res.status}: ${await res.text()}`);
  }
  const { relayMessageId, messageId: relayStamped } = (await res.json()) as {
    relayMessageId: string;
    /** Wire Message-ID, present only when the relay REWROTE the header. */
    messageId?: string;
  };

  // stored == wire. SES substitutes its own Message-ID for the one in the
  // raw message (always — see packages/outbound SendResult), so the id the
  // draft was stamped with is NOT the id the world received. The recipient
  // replies to the SES id; the delivered copy of a self-send carries the
  // SES id; both correlate against this row's message_id. Left stale, every
  // such lookup misses and threads fork — the Mailtemi near-duplicate bug.
  // The relay reports what it put on the wire; the row adopts it.
  const wireMessageId = normalizeMessageId(relayStamped);
  const messageIdChanged = wireMessageId !== null && wireMessageId !== email.messageId;
  if (messageIdChanged) {
    await store.updateEmailMessageId(access.accountId, spec.emailId, wireMessageId);
  }

  const submissionId = `es_${crypto.randomUUID()}`;
  const sendAtMs = Date.now();
  await store.insertSubmission(access.accountId, {
    id: submissionId,
    emailId: spec.emailId,
    identityId: identity.id,
    envelope: { mailFrom, rcptTo },
    undoStatus: "final",
    relayMessageId,
    sendAt: sendAtMs,
  });

  return {
    submissionId,
    emailId: spec.emailId,
    sendAt: new Date(sendAtMs).toISOString(),
    emailUpdated: messageIdChanged,
  };
}

/**
 * Is this email a draft? Either signal counts, because the two supported
 * send flows set different ones: `Email/set` create + `Email/import`
 * both write `$draft`, while a client that only files into the role
 * mailbox (docs/architecture/serverless-jmap.md:264 — "`role=drafts`/
 * `$draft`") is equally legitimate.
 */
async function isDraft(store: Mailstore, accountId: string, email: EmailRow): Promise<boolean> {
  if (email.keywords.includes("$draft")) return true;
  if (email.mailboxIds.length === 0) return false;
  const mailboxes = await store.getMailboxes(accountId, email.mailboxIds);
  return mailboxes.some((m) => m.role === "drafts");
}

function dedupe(list: string[]): string[] {
  return [...new Set(list.map((e) => e.toLowerCase()))];
}
