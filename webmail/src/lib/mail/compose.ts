// Compose / reply / forward, drafts, and send.
//
// Draft creation is `Email/set create` into the Drafts mailbox; sending is
// `EmailSubmission/set create` with `onSuccessUpdateEmail` doing the
// move-to-Sent in the SAME call.
//
// ⚠️ **Sending is two round trips, not one, and that is a server constraint.**
// The natural batch — create the draft, then submit it by back-reference — is
// not expressible: RFC 8620 §3.7 result references only replace TOP-LEVEL
// arguments, and `emailId` lives nested inside `create.<cid>`. JMAP's answer is
// the `#creationId` reference, which `submitOne`
// (`services/jmap/src/methods/submission.ts`) does not resolve — it looks the
// id up directly. So: save, then submit. The batching win stays where it
// matters (list and thread loads); pretending otherwise here would mean a send
// that silently referenced a draft the server had never heard of.

import type { JmapClient } from "../jmap/JmapClient";
import { quoteLines, splitQuotedText } from "./quote";
import { KEYWORD, formatAddress, type Email, type EmailAddress, type Identity } from "./types";

export interface DraftSpec {
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  /** text/plain body. The server builds MIME from this (`buildMime`). */
  text: string;
  /** Optional text/html body. */
  html?: string;
  inReplyTo?: string[] | null;
  /**
   * Attachments the source message had that this draft will NOT carry.
   *
   * ⚠️ `Email/set create` (`createDraft`) builds MIME from addresses, subject
   * and body only — it ignores an `attachments` property entirely. So forwarding
   * a message with a PDF sends the text without the PDF. The composer surfaces
   * this list as a warning rather than dropping the files silently; wiring the
   * real path (blob upload → `Email/import`, or s03.B's link sidestep) is T3.
   */
  droppedAttachments?: Array<{ name: string | null; size: number; type: string }>;
}

export interface ComposeContext {
  identity: Identity;
  now?: Date;
}

/** A blank draft from an identity. */
export function newDraft(ctx: ComposeContext): DraftSpec {
  return {
    from: [identityAddress(ctx.identity)],
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    text: signatureBlock(ctx.identity),
  };
}

/**
 * Reply. `replyAll` adds the original's other recipients; the identity's own
 * address is filtered out of both lists, because replying to a thread should
 * not mail yourself.
 *
 * The server does not return a `replyTo` property on `Email` (`emailToJmap`
 * omits it), so `from` is the reply target. If Reply-To handling is added
 * server-side, this is the single line to change.
 */
export function buildReplyDraft(
  original: Email,
  opts: ComposeContext & { replyAll?: boolean },
): DraftSpec {
  const self = opts.identity.email.toLowerCase();
  const to = dedupeAddresses(original.from ?? []);
  const cc = opts.replyAll ? dedupeAddresses([...(original.to ?? []), ...(original.cc ?? [])]) : [];

  return {
    from: [identityAddress(opts.identity)],
    to: to.filter((a) => a.email.toLowerCase() !== self),
    cc: cc.filter(
      (a) =>
        a.email.toLowerCase() !== self &&
        !to.some((t) => t.email.toLowerCase() === a.email.toLowerCase()),
    ),
    bcc: [],
    subject: prefixSubject(original.subject, "Re:"),
    text: `${signatureBlock(opts.identity)}\n${replyQuote(original, opts.now)}`,
    inReplyTo: original.messageId ?? null,
  };
}

/** Forward. Body gets the standard forwarded-message header block. */
export function buildForwardDraft(original: Email, opts: ComposeContext): DraftSpec {
  const dropped = (original.attachments ?? [])
    .filter((a) => !(a.disposition === "inline" && a.cid))
    .map((a) => ({ name: a.name, size: a.size, type: a.type }));

  const spec: DraftSpec = {
    from: [identityAddress(opts.identity)],
    to: [],
    cc: [],
    bcc: [],
    subject: prefixSubject(original.subject, "Fwd:"),
    text: `${signatureBlock(opts.identity)}\n${forwardBlock(original)}`,
  };
  if (dropped.length > 0) spec.droppedAttachments = dropped;
  return spec;
}

function replyQuote(original: Email, now?: Date): string {
  const when = formatQuoteDate(original.receivedAt, now);
  const who = original.from?.[0] ? formatAddress(original.from[0] as EmailAddress) : "someone";
  const body = plainBodyOf(original);
  // Quote what they WROTE, not what they in turn quoted — otherwise a long
  // thread doubles in size on every reply.
  const { body: fresh } = splitQuotedText(body);
  return `On ${when}, ${who} wrote:\n${quoteLines(fresh || body)}\n`;
}

function forwardBlock(original: Email): string {
  const lines = [
    "---------- Forwarded message ----------",
    `From: ${(original.from ?? []).map(formatAddress).join(", ") || "(unknown)"}`,
    `Date: ${formatQuoteDate(original.receivedAt)}`,
    `Subject: ${original.subject || "(no subject)"}`,
    `To: ${(original.to ?? []).map(formatAddress).join(", ") || "(undisclosed)"}`,
  ];
  const cc = (original.cc ?? []).map(formatAddress).join(", ");
  if (cc) lines.push(`Cc: ${cc}`);
  return `${lines.join("\n")}\n\n${plainBodyOf(original)}\n`;
}

/** Prefer the text part; fall back to preview. Never quotes raw HTML. */
function plainBodyOf(email: Email): string {
  const partId = email.textBody?.[0]?.partId;
  const value = partId ? email.bodyValues?.[partId]?.value : undefined;
  return value ?? email.preview ?? "";
}

function formatQuoteDate(iso: string, now?: Date): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  void now;
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function prefixSubject(subject: string, prefix: "Re:" | "Fwd:"): string {
  const base = (subject ?? "").trim();
  const already = new RegExp(`^${prefix === "Re:" ? "re" : "fwd?"}\\s*:`, "i").test(base);
  if (already) return base;
  return base === "" ? prefix.replace(":", ": (no subject)") : `${prefix} ${base}`;
}

function identityAddress(identity: Identity): EmailAddress {
  return { name: identity.name || null, email: identity.email };
}

function signatureBlock(identity: Identity): string {
  const sig = (identity.textSignature ?? "").trim();
  return sig === "" ? "\n" : `\n\n-- \n${sig}\n`;
}

function dedupeAddresses(list: EmailAddress[]): EmailAddress[] {
  const seen = new Set<string>();
  const out: EmailAddress[] = [];
  for (const a of list) {
    if (!a?.email) continue;
    const key = a.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** Parse a comma-separated recipient input into addresses. */
export function parseAddressList(input: string): EmailAddress[] {
  return input
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const angled = /^(.*?)<([^>]+)>$/.exec(part);
      if (angled) {
        const name = (angled[1] ?? "").trim().replace(/^"|"$/g, "");
        return { name: name === "" ? null : name, email: (angled[2] ?? "").trim() };
      }
      return { name: null, email: part };
    });
}

/** A draft with no recipient cannot be submitted — the server rejects it too. */
export function validateDraft(spec: DraftSpec): string[] {
  const problems: string[] = [];
  const recipients = [...spec.to, ...spec.cc, ...spec.bcc];
  if (recipients.length === 0) problems.push("Add at least one recipient.");
  for (const a of recipients) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email))
      problems.push(`“${a.email}” is not an email address.`);
  }
  if (spec.from.length === 0) problems.push("Choose an identity to send from.");
  return problems;
}

// ── drafts ────────────────────────────────────────────────────────────────

export interface SavedDraft {
  id: string;
  blobId: string;
  threadId: string;
  size: number;
}

/**
 * Save a draft into the Drafts mailbox.
 *
 * ⚠️ **Re-saving replaces rather than edits.** `applyEmailPatch` accepts only
 * `keywords` and `mailboxIds` paths — a message's body and headers are immutable
 * once stored, because the row is a pointer at an immutable MIME blob. So an
 * edited draft is a NEW message plus a destroy of the old one, batched into one
 * `Email/set`.
 *
 * That has a scope consequence worth knowing: create charges `draft` and destroy
 * charges `delete` (`requiredScopesForEmailSet`), so a token with `draft` but
 * not `delete` can save a draft once and then accumulate copies. `replaces` is
 * therefore optional, and the caller can degrade to leaving the old copy.
 */
export async function saveDraft(
  client: JmapClient,
  accountId: string,
  draftsMailboxId: string,
  spec: DraftSpec,
  opts: { replaces?: string } = {},
): Promise<SavedDraft> {
  const args: Record<string, unknown> = {
    accountId,
    create: { draft: toCreateSpec(spec, draftsMailboxId) },
  };
  if (opts.replaces) args.destroy = [opts.replaces];

  const [response] = await client.request([["Email/set", args, "d"]]);
  if (!response) throw new ComposeError("Email/set returned nothing");
  if (response[0] === "error") {
    const detail = response[1] as { type?: string; description?: string };
    throw new ComposeError(`Draft not saved: ${detail.type ?? "error"}`, detail.type);
  }

  const result = response[1] as {
    created?: Record<string, SavedDraft>;
    notCreated?: Record<string, { type?: string; description?: string }>;
  };
  const created = result.created?.draft;
  if (!created) {
    const err = result.notCreated?.draft;
    throw new ComposeError(
      `Draft not saved: ${err?.description ?? err?.type ?? "unknown reason"}`,
      err?.type,
    );
  }
  return created;
}

function toCreateSpec(spec: DraftSpec, draftsMailboxId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    mailboxIds: { [draftsMailboxId]: true },
    // `$seen` because you have obviously read what you just wrote; `$draft` is
    // what `EmailSubmission/set` checks before it will send anything.
    keywords: { [KEYWORD.draft]: true, [KEYWORD.seen]: true },
    from: spec.from,
    to: spec.to,
    cc: spec.cc,
    bcc: spec.bcc,
    subject: spec.subject,
    bodyValues: { t: { value: spec.text } },
    textBody: [{ partId: "t", type: "text/plain" }],
  };
  if (spec.html !== undefined) {
    (body.bodyValues as Record<string, unknown>).h = { value: spec.html };
    body.htmlBody = [{ partId: "h", type: "text/html" }];
  }
  if (spec.inReplyTo) body.inReplyTo = spec.inReplyTo;
  return body;
}

// ── sending ───────────────────────────────────────────────────────────────

export interface SendResult {
  submissionId: string;
  emailId: string;
  /** True when the draft was moved to Sent and un-drafted. */
  filed: boolean;
}

/**
 * Submit an existing draft. One `EmailSubmission/set` call carries both the
 * send and the filing: `onSuccessUpdateEmail` moves the message out of Drafts
 * into Sent and clears `$draft`, server-side, only if the send succeeded.
 *
 * `envelope.mailFrom` is deliberately NOT sent: `submitOne` requires it to equal
 * the identity's address and treats the identity as authoritative anyway, so
 * sending it can only introduce a mismatch error. `rcptTo` IS sent, because the
 * server's fallback derives recipients from the stored message and Bcc must
 * reach the relay.
 */
export async function sendDraft(
  client: JmapClient,
  accountId: string,
  params: {
    emailId: string;
    identityId: string;
    draftsMailboxId: string;
    sentMailboxId: string;
    recipients: EmailAddress[];
  },
): Promise<SendResult> {
  const rcptTo = dedupeAddresses(params.recipients).map((a) => ({ email: a.email }));
  if (rcptTo.length === 0) throw new ComposeError("No recipients");

  const onSuccess: Record<string, unknown> = {
    [`keywords/${KEYWORD.draft}`]: null,
    [`mailboxIds/${params.sentMailboxId}`]: true,
  };
  // Same-mailbox guard: if Sent and Drafts are the same folder, removing it
  // would leave the message in no mailbox and the server would refuse.
  if (params.draftsMailboxId !== params.sentMailboxId) {
    onSuccess[`mailboxIds/${params.draftsMailboxId}`] = null;
  }

  const [response] = await client.request([
    [
      "EmailSubmission/set",
      {
        accountId,
        create: {
          s0: { emailId: params.emailId, identityId: params.identityId, envelope: { rcptTo } },
        },
        onSuccessUpdateEmail: { "#s0": onSuccess },
      },
      "s",
    ],
  ]);

  if (!response) throw new ComposeError("EmailSubmission/set returned nothing");
  if (response[0] === "error") {
    const detail = response[1] as { type?: string; description?: string };
    throw new ComposeError(
      detail.type === "forbidden"
        ? "This session is not allowed to send mail (it needs the “send” permission)."
        : `Send failed: ${detail.description ?? detail.type ?? "error"}`,
      detail.type,
    );
  }

  const result = response[1] as {
    created?: Record<string, { id?: string }>;
    notCreated?: Record<string, { type?: string; description?: string }>;
  };
  const created = result.created?.s0;
  if (!created?.id) {
    const err = result.notCreated?.s0;
    throw new ComposeError(
      `Send failed: ${err?.description ?? err?.type ?? "unknown reason"}`,
      err?.type,
    );
  }
  return { submissionId: created.id, emailId: params.emailId, filed: true };
}

/**
 * The whole send flow: save the draft, then submit it. Two round trips — see
 * the note at the top of this file for why it cannot be one.
 */
export async function saveAndSend(
  client: JmapClient,
  accountId: string,
  params: {
    spec: DraftSpec;
    identityId: string;
    draftsMailboxId: string;
    sentMailboxId: string;
    replaces?: string;
  },
): Promise<SendResult> {
  const problems = validateDraft(params.spec);
  if (problems.length > 0) throw new ComposeError(problems.join(" "));

  const draft = await saveDraft(client, accountId, params.draftsMailboxId, params.spec, {
    ...(params.replaces ? { replaces: params.replaces } : {}),
  });

  return sendDraft(client, accountId, {
    emailId: draft.id,
    identityId: params.identityId,
    draftsMailboxId: params.draftsMailboxId,
    sentMailboxId: params.sentMailboxId,
    recipients: [...params.spec.to, ...params.spec.cc, ...params.spec.bcc],
  });
}

/** Load the identities this account may send as. */
export async function loadIdentities(client: JmapClient, accountId: string): Promise<Identity[]> {
  const result = await client.requestOne("Identity/get", { accountId, ids: null });
  return (result.list as Identity[] | undefined) ?? [];
}

export class ComposeError extends Error {
  constructor(
    message: string,
    readonly jmapType?: string,
  ) {
    super(message);
    this.name = "ComposeError";
  }
}
