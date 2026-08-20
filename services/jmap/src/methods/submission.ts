import { MAX_DELAYED_SEND_SECONDS, MethodError, type CallMeta, type MethodRegistry } from "@bullmoose/jmap-core";
import { commitChanges, scheduleDelayedSubmission, type DelayedSubmission } from "@bullmoose/account-do";
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
 * — Cloudflare cannot originate SMTP. `/set` supports:
 *
 *  - create, immediate or HELD: a future release time (`sendAt`, or RFC 4865
 *    `HOLDFOR`/`HOLDUNTIL` envelope parameters — the RFC 8621 §7 spelling)
 *    within `maxDelayedSend` inserts the row as `undoStatus: "pending"` and
 *    queues the relay on the AccountDO alarm instead of relaying now;
 *  - update, exactly one transition: `undoStatus` pending → "canceled", the
 *    undo that the hold exists for. After the alarm has relayed, the same
 *    update answers `cannotUnsend` (§7.5's SetError for exactly this);
 *  - onSuccessUpdateEmail + onSuccessDestroyEmail (the standard "move draft
 *    to Sent / discard the draft" dance) — applied inline for immediate
 *    sends, DEFERRED to relay time for held ones;
 *  - destroy is not implemented, and the response says so structurally
 *    rather than pretending.
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
 * `undoStatus` is echoed from the column rather than hardcoded, and since
 * delayed send landed the column genuinely varies: `'pending'` while a held
 * send can still be canceled, `'canceled'` once it was (or once the relay
 * permanently refused it — see AccountDO), `'final'` once the message is on
 * the wire. It is a statement about cancelability, not about delivery — the
 * delivery claim is the one above, and it is null.
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
  /**
   * Requested release time. RFC 8621 §7 makes `sendAt` server-set and spells
   * the request as FUTURERELEASE parameters on `envelope.mailFrom` (RFC 4865
   * `HOLDFOR` seconds / `HOLDUNTIL` timestamp); real clients send either
   * spelling, so `requestedReleaseAt` accepts both.
   */
  sendAt?: string;
  envelope?: {
    mailFrom?: { email?: string; parameters?: Record<string, unknown> | null };
    rcptTo?: Array<{ email?: string }>;
  } | null;
}

async function emailSubmissionSet(
  args: Record<string, unknown>,
  ctx: RequestContext,
  meta?: CallMeta,
): Promise<Record<string, unknown>> {
  const access = await requireAccount(ctx, args, "send");
  const store = storeFor(ctx);
  const oldState = await accountState(ctx, access.accountId);

  const created: Record<string, unknown> = {};
  const notCreated: Record<string, SetError> = {};
  const createdIds: string[] = [];
  /** creation-ref (#cid) → { submissionId, emailId } for onSuccess handling. */
  const byRef = new Map<string, { submissionId: string; emailId: string }>();
  /** submissionId → its hold, for creates that were queued instead of relayed. */
  const holds = new Map<string, DelayedSubmission>();
  /** submissionId → cid, to unwind a hold whose DO queueing failed. */
  const cidOf = new Map<string, string>();

  // Emails whose stored message_id was reconciled to the relay's wire
  // Message-ID (SES substitutes its own — see submitOne). A real change to
  // an Email property, so it must reach the changelog or clients keep the
  // stale id in cache forever.
  const emailsStamped = new Set<string>();

  const create = (args.create as Record<string, CreateSpec> | undefined) ?? {};
  for (const [cid, spec] of Object.entries(create)) {
    try {
      const result = await submitOne(ctx, store, access, spec, meta);
      created[cid] = { id: result.submissionId, undoStatus: result.undoStatus, sendAt: result.sendAt };
      createdIds.push(result.submissionId);
      if (result.emailUpdated) emailsStamped.add(result.emailId);
      byRef.set(cid, result);
      if (result.hold) {
        holds.set(result.submissionId, result.hold);
        cidOf.set(result.submissionId, cid);
      }
    } catch (err) {
      notCreated[cid] =
        err instanceof MethodError
          ? setError(err.type === "invalidArguments" ? "invalidProperties" : err.type, err.description)
          : setError("serverFail", String(err));
    }
  }

  // update (RFC 8621 §7.5): the ONLY mutable property is undoStatus, and the
  // only transition is pending → canceled — the undo the delayed-send hold
  // exists for. The transition is a compare-and-swap against the row (see
  // Mailstore.updateSubmissionUndoStatus): if the AccountDO alarm claimed the
  // row first the message is on the wire and the answer is `cannotUnsend`,
  // the SetError the spec defines for exactly this moment.
  const updated: Record<string, unknown> = {};
  const notUpdated: Record<string, SetError> = {};
  const submissionsUpdated: string[] = [];
  /** submission id → emailId for successful updates (onSuccess key resolution). */
  const updatedRefs = new Map<string, string>();
  const update = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [key, patch] of Object.entries(update)) {
    // "#cid" keys resolve like any creation reference: this call's creates
    // first, then earlier methods' (RFC 8620 §3.3).
    const id = key.startsWith("#")
      ? (byRef.get(key.slice(1))?.submissionId ?? meta?.createdIds.get(key.slice(1)))
      : key;
    if (!id) {
      notUpdated[key] = setError("notFound", `reference ${key} does not match any created id in this request`);
      continue;
    }
    const keys = Object.keys(patch ?? {});
    if (keys.length !== 1 || keys[0] !== "undoStatus" || patch.undoStatus !== "canceled") {
      notUpdated[key] = setError("invalidProperties", `only undoStatus may be updated, and only to "canceled"`);
      continue;
    }
    const [row] = await store.getSubmissions(access.accountId, [id]);
    if (!row) {
      notUpdated[key] = setError("notFound");
      continue;
    }
    if (row.undoStatus === "canceled") {
      // Already what the client asked for — idempotent success.
      updated[key] = null;
      updatedRefs.set(id, row.emailId);
      continue;
    }
    const moved = await store.updateSubmissionUndoStatus(access.accountId, id, "pending", "canceled");
    if (!moved) {
      notUpdated[key] = setError("cannotUnsend", "the message has already been sent");
      continue;
    }
    updated[key] = null;
    updatedRefs.set(id, row.emailId);
    submissionsUpdated.push(id);
  }

  // destroy: not supported, and said so per id rather than silently dropped.
  const destroyRequested = (args.destroy as string[] | undefined) ?? [];
  const notDestroyed: Record<string, SetError> = {};
  for (const id of destroyRequested) {
    notDestroyed[id] = setError("forbidden", "EmailSubmission destroy is not supported");
  }

  /**
   * onSuccess key resolution (RFC 8621 §7.5): a key names an EmailSubmission
   * whose create/update succeeded in THIS call — "#cid" for creates, the
   * plain id for updates (the cancel + "restore my draft" dance). A key that
   * resolves to a HELD create returns its hold instead of applying now:
   * deferred actions ride the DO queue and fire at relay time.
   */
  const resolveSuccessRef = (key: string): { submissionId: string; emailId: string } | undefined => {
    if (key.startsWith("#")) return byRef.get(key.slice(1));
    const emailId = updatedRefs.get(key);
    return emailId ? { submissionId: key, emailId } : undefined;
  };

  // onSuccessUpdateEmail: values are Email PatchObjects applied to the
  // submission's email — inline for immediate sends and successful updates,
  // stored on the hold for pending ones (applied by AccountDO at relay time).
  const mailboxesTouched = new Set<string>();
  const emailsUpdated: string[] = [];
  const onSuccess = (args.onSuccessUpdateEmail as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [key, patch] of Object.entries(onSuccess)) {
    const ref = resolveSuccessRef(key);
    if (!ref) continue; // send failed or unknown ref — nothing to update
    const hold = holds.get(ref.submissionId);
    if (hold) {
      hold.onSuccessPatch = patch;
      continue;
    }
    try {
      await applyEmailPatch(store, access.accountId, ref.emailId, patch, mailboxesTouched);
      emailsUpdated.push(ref.emailId);
    } catch (err) {
      console.error(`onSuccessUpdateEmail failed for ${ref.emailId}:`, err);
    }
  }

  // onSuccessDestroyEmail (RFC 8621 §7.5): destroy the submission's email —
  // the "discard the draft once it sends" client dance. Same key resolution
  // and same deferral as the patch map above. Authorization deliberately
  // matches onSuccessUpdateEmail: the `send` scope that authorized the
  // submission covers its onSuccess actions, because both are bounded to the
  // email of a submission THIS call successfully created or updated — a
  // draft the token was allowed to send — not to arbitrary ids. (Email/set
  // destroy proper still demands the `delete` scope; that gate is for
  // destroying any stored mail, which this cannot reach.)
  const emailsDestroyed: string[] = [];
  const onSuccessDestroy = (args.onSuccessDestroyEmail as string[] | undefined) ?? [];
  for (const key of onSuccessDestroy) {
    if (typeof key !== "string") continue;
    const ref = resolveSuccessRef(key);
    if (!ref) continue; // send failed or unknown ref — nothing to destroy
    const hold = holds.get(ref.submissionId);
    if (hold) {
      hold.onSuccessDestroy = true;
      continue;
    }
    try {
      const row = await store.getEmailRow(access.accountId, ref.emailId);
      if (!row) continue; // already gone
      await store.destroyEmail(access.accountId, ref.emailId);
      for (const mb of row.mailboxIds) mailboxesTouched.add(mb);
      emailsDestroyed.push(ref.emailId);
    } catch (err) {
      console.error(`onSuccessDestroyEmail failed for ${ref.emailId}:`, err);
    }
  }

  // Queue the holds — AFTER the onSuccess walk so each hold carries its
  // deferred actions. A hold the DO refuses is unwound to notCreated: a
  // pending row with no alarm behind it would sit "pending" forever, which
  // is worse than an honest serverFail the client can retry.
  for (const hold of holds.values()) {
    try {
      await scheduleDelayedSubmission(ctx.env.ACCOUNT_DO, hold);
    } catch (err) {
      await store.updateSubmissionUndoStatus(access.accountId, hold.submissionId, "pending", "canceled");
      const cid = cidOf.get(hold.submissionId);
      if (cid) {
        delete created[cid];
        notCreated[cid] = setError("serverFail", `could not queue delayed send: ${String(err)}`);
      }
      const at = createdIds.indexOf(hold.submissionId);
      if (at >= 0) createdIds.splice(at, 1);
    }
  }

  // One Email-updated entry covers both kinds of update this method makes:
  // the onSuccessUpdateEmail patches above and the message_id reconciles
  // from submitOne (deduped — a send with both touches the email once).
  // An email destroyed above is reported as destroyed, not also updated.
  const emailsChanged = [...new Set([...emailsStamped, ...emailsUpdated])].filter(
    (id) => !emailsDestroyed.includes(id),
  );

  let newState = oldState;
  if (createdIds.length + submissionsUpdated.length + emailsChanged.length + emailsDestroyed.length > 0) {
    const entries = [];
    if (createdIds.length > 0 || submissionsUpdated.length > 0) {
      entries.push({ collection: "EmailSubmission", created: createdIds, updated: submissionsUpdated });
    }
    if (emailsChanged.length > 0 || emailsDestroyed.length > 0) {
      entries.push({ collection: "Email", updated: emailsChanged, destroyed: emailsDestroyed });
    }
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
    updated,
    notUpdated,
    destroyed: [],
    notDestroyed,
  };
}

interface SubmitOutcome {
  submissionId: string;
  emailId: string;
  sendAt: string;
  undoStatus: "pending" | "final";
  emailUpdated: boolean;
  /** Present iff the send is HELD: queued on the AccountDO by the caller. */
  hold?: DelayedSubmission;
}

async function submitOne(
  ctx: RequestContext,
  store: Mailstore,
  access: AccountAccess,
  spec: CreateSpec,
  meta: CallMeta | undefined,
): Promise<SubmitOutcome> {
  if (!spec.emailId || !spec.identityId) {
    throw new MethodError("invalidArguments", "emailId and identityId are required");
  }

  // RFC 8620 §3.3 creation references: a batching client submits the draft
  // it created two lines up as `emailId: "#cid"`, and the dispatcher's
  // creation-id map is where that cid became a real id. Unresolvable is a
  // client error naming the ref, not a lookup miss.
  const emailId = resolveCreationRef("emailId", spec.emailId, meta);
  const identityId = resolveCreationRef("identityId", spec.identityId, meta);

  const email = await store.getEmailRow(access.accountId, emailId);
  if (!email) throw new MethodError("invalidArguments", `email ${emailId} not found`);

  // Only unsent drafts may be submitted. Without this a send-scoped token
  // could re-relay any stored message in the account — including inbound
  // mail it merely received — to recipients of its choosing.
  if (!(await isDraft(store, access.accountId, email))) {
    throw new MethodError("forbidden", `email ${emailId} is not a draft`);
  }

  // Identity must be one Identity/get would have offered for this account.
  const identities = await resolveIdentities(ctx, access, store);
  const identity = identities.find((i) => i.id === identityId);
  if (!identity) {
    throw new MethodError("invalidArguments", `identity ${identityId} not found`);
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

  // Delayed send (RFC 8621 §7 / capability `maxDelayedSend`): a future
  // release time means the row is written `pending` and the relay is a
  // PROMISE — an AccountDO alarm entry the caller queues after the
  // onSuccess maps have been attached to it. No requested time, or one in
  // the past, is the immediate path below, byte-for-byte the pre-hold
  // behavior: default-off, because a silent server-side delay would change
  // what "sent" means under every client that already exists.
  const now = Date.now();
  const releaseAt = requestedReleaseAt(spec, now);
  if (releaseAt !== null && releaseAt > now) {
    if (releaseAt - now > MAX_DELAYED_SEND_SECONDS * 1000) {
      throw new MethodError(
        "invalidArguments",
        `requested sendAt is further out than maxDelayedSend (${MAX_DELAYED_SEND_SECONDS}s)`,
      );
    }
    const submissionId = `es_${crypto.randomUUID()}`;
    await store.insertSubmission(access.accountId, {
      id: submissionId,
      emailId,
      identityId: identity.id,
      envelope: { mailFrom, rcptTo },
      undoStatus: "pending",
      relayMessageId: null,
      sendAt: releaseAt,
    });
    return {
      submissionId,
      emailId,
      sendAt: new Date(releaseAt).toISOString(),
      undoStatus: "pending",
      emailUpdated: false,
      hold: {
        submissionId,
        accountId: access.accountId,
        tenantId: access.tenantId,
        emailId,
        envelope: { mailFrom, rcptTo },
        fireAt: releaseAt,
        principal: ctx.principal.username,
        onSuccessPatch: null,
        onSuccessDestroy: false,
      },
    };
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
    await store.updateEmailMessageId(access.accountId, emailId, wireMessageId);
  }

  const submissionId = `es_${crypto.randomUUID()}`;
  const sendAtMs = Date.now();
  await store.insertSubmission(access.accountId, {
    id: submissionId,
    emailId,
    identityId: identity.id,
    envelope: { mailFrom, rcptTo },
    undoStatus: "final",
    relayMessageId,
    sendAt: sendAtMs,
  });

  return {
    submissionId,
    emailId,
    sendAt: new Date(sendAtMs).toISOString(),
    undoStatus: "final",
    emailUpdated: messageIdChanged,
  };
}

/**
 * Resolve an RFC 8620 §3.3 creation reference (`#cid`) against the
 * dispatcher's creation-id map. Plain ids pass through untouched; a `#` value
 * with no binding is refused BY NAME, because the alternative — treating
 * "#big" as a literal id — turns a batching client's one-round-trip send into
 * a baffling "email #big not found".
 */
function resolveCreationRef(field: string, value: string, meta: CallMeta | undefined): string {
  if (!value.startsWith("#")) return value;
  const resolved = meta?.createdIds.get(value.slice(1));
  if (!resolved) {
    throw new MethodError(
      "invalidArguments",
      `${field} reference ${value} does not match any created id in this request`,
    );
  }
  return resolved;
}

/**
 * The requested release time (epoch ms), or null for "now".
 *
 * Two spellings, both honored: RFC 8621 §7's own — FUTURERELEASE (RFC 4865)
 * `HOLDFOR` (seconds) / `HOLDUNTIL` (timestamp) parameters on
 * `envelope.mailFrom`, matched case-insensitively as SMTP extension keywords
 * are — and a literal `sendAt` on the create, which the spec marks server-set
 * but real batching clients send anyway and which round-trips through our own
 * `/get` shape. Parameters win when both appear, being the spec's spelling.
 * A malformed value is refused rather than silently sent immediately: the
 * client asked for a hold, and "sent now by accident" is the one outcome it
 * clearly did not want.
 */
function requestedReleaseAt(spec: CreateSpec, now: number): number | null {
  const params = spec.envelope?.mailFrom?.parameters;
  if (params && typeof params === "object") {
    for (const [key, raw] of Object.entries(params)) {
      const name = key.toUpperCase();
      if (name === "HOLDFOR") {
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds < 0) {
          throw new MethodError("invalidArguments", `HOLDFOR must be a non-negative number of seconds`);
        }
        return now + seconds * 1000;
      }
      if (name === "HOLDUNTIL") {
        const at = Date.parse(String(raw));
        if (Number.isNaN(at)) {
          throw new MethodError("invalidArguments", `HOLDUNTIL is not a valid date-time`);
        }
        return at;
      }
    }
  }
  if (typeof spec.sendAt === "string") {
    const at = Date.parse(spec.sendAt);
    if (Number.isNaN(at)) throw new MethodError("invalidArguments", `sendAt is not a valid date-time`);
    return at;
  }
  return null;
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
