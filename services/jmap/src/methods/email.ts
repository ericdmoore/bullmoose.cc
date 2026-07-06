import PostalMime from "postal-mime";
import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { commitChanges, type ChangeEntry } from "@bullmoose/account-do";
import { buildMime } from "@bullmoose/mime";
import type { EmailAddress, EmailFilter, EmailRow, EmailSort, Mailstore } from "@bullmoose/mailstore";
import {
  accountState,
  proxyChanges,
  requireAccount,
  setError,
  storeFor,
  type RequestContext,
  type SetError,
} from "./common";

/** Metadata properties served straight from D1 (RFC 8621 §4.4 defaults). */
const DEFAULT_PROPERTIES = [
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
  "sentAt",
  "hasAttachment",
  "preview",
  "attachments",
];

const BODY_PROPERTIES = new Set(["bodyValues", "textBody", "htmlBody"]);

export function registerEmailMethods(registry: MethodRegistry<RequestContext>): void {
  registry.register("Email/get", emailGet);
  registry.register("Email/query", emailQuery);
  registry.register("Email/set", emailSet);
  registry.register("Email/changes", async (args, ctx) => proxyChanges(ctx, args, "Email"));
}

// ---- Email/get -------------------------------------------------------

async function emailGet(
  args: Record<string, unknown>,
  ctx: RequestContext,
): Promise<Record<string, unknown>> {
  const access = requireAccount(ctx, args);
  if (!Array.isArray(args.ids)) {
    throw new MethodError("invalidArguments", "Email/get requires ids");
  }
  const ids = args.ids as string[];
  const properties = (args.properties as string[] | undefined) ?? DEFAULT_PROPERTIES;

  const wantBodies =
    properties.some((p) => BODY_PROPERTIES.has(p)) ||
    args.fetchTextBodyValues === true ||
    args.fetchHTMLBodyValues === true ||
    args.fetchAllBodyValues === true;
  const maxBodyBytes = typeof args.maxBodyValueBytes === "number" ? args.maxBodyValueBytes : 0;

  const store = storeFor(ctx);
  const rows = await store.getEmailRows(access.accountId, ids);

  const list: Record<string, unknown>[] = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) continue;
    const email = emailToJmap(row);
    if (wantBodies) {
      Object.assign(
        email,
        await fetchBodies(store, access.tenantId, access.accountId, row, maxBodyBytes),
      );
    }
    list.push(pick(email, properties));
  }

  return {
    accountId: access.accountId,
    state: await accountState(ctx, access.accountId),
    list,
    notFound: ids.filter((id) => !rows.has(id)),
  };
}

function emailToJmap(row: EmailRow): Record<string, unknown> {
  return {
    id: row.id,
    blobId: row.blobId,
    threadId: row.threadId,
    mailboxIds: Object.fromEntries(row.mailboxIds.map((m) => [m, true])),
    keywords: Object.fromEntries(row.keywords.map((k) => [k, true])),
    size: row.size,
    receivedAt: new Date(row.receivedAt).toISOString(),
    messageId: row.messageId ? [row.messageId] : null,
    inReplyTo: row.inReplyTo ? [row.inReplyTo] : null,
    from: toJmapAddresses(row.from),
    to: toJmapAddresses(row.to),
    cc: toJmapAddresses(row.cc),
    bcc: toJmapAddresses(row.bcc),
    subject: row.subject,
    sentAt: null, // TODO: parse Date header at ingest
    hasAttachment: row.hasAttachment,
    preview: row.preview,
    attachments: row.attachments.map((a) => ({
      partId: null,
      blobId: a.blobId,
      size: a.size,
      name: a.name,
      type: a.type,
      cid: a.cid,
      disposition: a.disposition,
    })),
  };
}

function toJmapAddresses(list: EmailAddress[]): Array<{ name: string | null; email: string }> {
  return list.map((a) => ({ name: a.name ?? null, email: a.email }));
}

/** Parse the raw blob on demand for bodyValues/textBody/htmlBody. */
async function fetchBodies(
  store: Mailstore,
  tenantId: string,
  accountId: string,
  row: EmailRow,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const blob = await store.getBlob(tenantId, accountId, row.blobId);
  if (!blob) return { bodyValues: {}, textBody: [], htmlBody: [] };
  const parsed = await PostalMime.parse(await blob.arrayBuffer());

  const bodyValues: Record<string, unknown> = {};
  const textBody: unknown[] = [];
  const htmlBody: unknown[] = [];

  if (parsed.text !== undefined) {
    bodyValues.t = truncate(parsed.text, maxBytes);
    textBody.push({ partId: "t", blobId: null, type: "text/plain", charset: "utf-8" });
  }
  if (parsed.html !== undefined) {
    bodyValues.h = truncate(parsed.html, maxBytes);
    htmlBody.push({ partId: "h", blobId: null, type: "text/html", charset: "utf-8" });
  }
  return { bodyValues, textBody, htmlBody };
}

function truncate(value: string, maxBytes: number): Record<string, unknown> {
  if (maxBytes > 0) {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length > maxBytes) {
      return {
        value: new TextDecoder().decode(bytes.slice(0, maxBytes)),
        isEncodingProblem: false,
        isTruncated: true,
      };
    }
  }
  return { value, isEncodingProblem: false, isTruncated: false };
}

function pick(obj: Record<string, unknown>, properties: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { id: obj.id };
  for (const p of properties) if (p in obj) out[p] = obj[p];
  return out;
}

// ---- Email/query -----------------------------------------------------

async function emailQuery(
  args: Record<string, unknown>,
  ctx: RequestContext,
): Promise<Record<string, unknown>> {
  const access = requireAccount(ctx, args);
  const store = storeFor(ctx);

  const result = await store.queryEmails(access.accountId, {
    filter: (args.filter as EmailFilter | null | undefined) ?? null,
    sort: args.sort as EmailSort[] | undefined,
    position: typeof args.position === "number" ? args.position : 0,
    limit: typeof args.limit === "number" ? args.limit : undefined,
    calculateTotal: args.calculateTotal === true,
  });

  return {
    accountId: access.accountId,
    queryState: await accountState(ctx, access.accountId),
    canCalculateChanges: false,
    position: result.position,
    ids: result.ids,
    ...(result.total !== undefined ? { total: result.total } : {}),
  };
}

// ---- Email/set -------------------------------------------------------

interface EmailSetResult {
  created: Record<string, unknown>;
  notCreated: Record<string, SetError>;
  updated: Record<string, null>;
  notUpdated: Record<string, SetError>;
  destroyed: string[];
  notDestroyed: Record<string, SetError>;
  emailChanges: ChangeEntry;
  mailboxesTouched: Set<string>;
}

async function emailSet(
  args: Record<string, unknown>,
  ctx: RequestContext,
): Promise<Record<string, unknown>> {
  const access = requireAccount(ctx, args);
  const store = storeFor(ctx);

  const oldState = await accountState(ctx, access.accountId);
  if (typeof args.ifInState === "string" && args.ifInState !== oldState) {
    throw new MethodError("stateMismatch");
  }

  const r: EmailSetResult = {
    created: {},
    notCreated: {},
    updated: {},
    notUpdated: {},
    destroyed: [],
    notDestroyed: {},
    emailChanges: { collection: "Email", created: [], updated: [], destroyed: [] },
    mailboxesTouched: new Set(),
  };

  // -- create (drafts) --
  const create = (args.create as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [cid, spec] of Object.entries(create)) {
    try {
      r.created[cid] = await createDraft(store, access, spec, r);
    } catch (err) {
      r.notCreated[cid] =
        err instanceof MethodError
          ? setError("invalidProperties", err.description ?? err.type)
          : setError("serverFail", String(err));
    }
  }

  // -- update (flags, moves) --
  const update = (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [id, patch] of Object.entries(update)) {
    try {
      await applyEmailPatch(store, access.accountId, id, patch, r.mailboxesTouched);
      r.updated[id] = null;
      r.emailChanges.updated.push(id);
    } catch (err) {
      r.notUpdated[id] =
        err instanceof MethodError && err.type === "invalidArguments"
          ? setError("invalidProperties", err.description)
          : err instanceof NotFoundError
            ? setError("notFound")
            : setError("serverFail", String(err));
    }
  }

  // -- destroy --
  const destroy = (args.destroy as string[] | undefined) ?? [];
  for (const id of destroy) {
    const row = await store.getEmailRow(access.accountId, id);
    if (!row) {
      r.notDestroyed[id] = setError("notFound");
      continue;
    }
    await store.destroyEmail(access.accountId, id);
    for (const mb of row.mailboxIds) r.mailboxesTouched.add(mb);
    r.destroyed.push(id);
    r.emailChanges.destroyed.push(id);
  }

  const newState = await commitEmailChanges(ctx, access.accountId, r);

  return {
    accountId: access.accountId,
    oldState,
    newState,
    created: r.created,
    notCreated: r.notCreated,
    updated: r.updated,
    notUpdated: r.notUpdated,
    destroyed: r.destroyed,
    notDestroyed: r.notDestroyed,
  };
}

async function commitEmailChanges(
  ctx: RequestContext,
  accountId: string,
  r: EmailSetResult,
): Promise<string> {
  const entries: Array<Partial<ChangeEntry> & { collection: string }> = [];
  const e = r.emailChanges;
  if (e.created.length + e.updated.length + e.destroyed.length > 0) entries.push(e);
  if (r.mailboxesTouched.size > 0) {
    entries.push({ collection: "Mailbox", updated: [...r.mailboxesTouched] });
  }
  if (entries.length === 0) return accountState(ctx, accountId);
  const { newState } = await commitChanges(ctx.env.ACCOUNT_DO, accountId, entries);
  return newState;
}

class NotFoundError extends Error {}

/**
 * Apply an RFC 8620 PatchObject to an email. Supported paths:
 *   keywords            (full replace)     keywords/$seen: true|null
 *   mailboxIds          (full replace)     mailboxIds/<id>: true|null
 * Exported for reuse by EmailSubmission/set onSuccessUpdateEmail.
 */
export async function applyEmailPatch(
  store: Mailstore,
  accountId: string,
  emailId: string,
  patch: Record<string, unknown>,
  mailboxesTouched: Set<string>,
): Promise<void> {
  const row = await store.getEmailRow(accountId, emailId);
  if (!row) throw new NotFoundError();

  const keywords = new Set(row.keywords);
  const mailboxIds = new Set(row.mailboxIds);
  let touchedKeywords = false;
  let touchedMailboxes = false;

  for (const [path, value] of Object.entries(patch)) {
    const [head, sub, ...rest] = path.split("/");
    if (rest.length > 0) throw new MethodError("invalidArguments", `unsupported path "${path}"`);

    if (head === "keywords") {
      touchedKeywords = true;
      applySetPatch(keywords, sub, value, path);
    } else if (head === "mailboxIds") {
      touchedMailboxes = true;
      applySetPatch(mailboxIds, sub, value, path);
    } else {
      throw new MethodError("invalidArguments", `property "${path}" is immutable or unknown`);
    }
  }

  if (touchedMailboxes && mailboxIds.size === 0) {
    throw new MethodError("invalidArguments", "an email must belong to at least one mailbox");
  }

  await store.replaceEmailSets(accountId, emailId, {
    ...(touchedMailboxes ? { mailboxIds: [...mailboxIds] } : {}),
    ...(touchedKeywords ? { keywords: [...keywords] } : {}),
  });

  if (touchedMailboxes) {
    for (const mb of row.mailboxIds) mailboxesTouched.add(mb);
    for (const mb of mailboxIds) mailboxesTouched.add(mb);
  } else if (touchedKeywords) {
    // $seen flips change unread counts on containing mailboxes.
    for (const mb of row.mailboxIds) mailboxesTouched.add(mb);
  }
}

function applySetPatch(target: Set<string>, sub: string | undefined, value: unknown, path: string) {
  if (sub === undefined) {
    // Full replace: value is Record<string, true>.
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new MethodError("invalidArguments", `"${path}" must be an object`);
    }
    target.clear();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === true) target.add(k);
    }
  } else if (value === true) {
    target.add(sub);
  } else if (value === null || value === false) {
    target.delete(sub);
  } else {
    throw new MethodError("invalidArguments", `"${path}" must be true or null`);
  }
}

/** Email/set create — build MIME for a simple draft, store blob + row. */
async function createDraft(
  store: Mailstore,
  access: { accountId: string; tenantId: string },
  spec: Record<string, unknown>,
  r: EmailSetResult,
): Promise<Record<string, unknown>> {
  const mailboxIds = Object.entries(
    (spec.mailboxIds as Record<string, unknown> | undefined) ?? {},
  )
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  if (mailboxIds.length === 0) {
    throw new MethodError("invalidArguments", "mailboxIds is required for create");
  }

  const keywords = Object.entries((spec.keywords as Record<string, unknown> | undefined) ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);

  const from = fromJmapAddresses(spec.from);
  const to = fromJmapAddresses(spec.to);
  const cc = fromJmapAddresses(spec.cc);
  const bcc = fromJmapAddresses(spec.bcc);
  const subject = typeof spec.subject === "string" ? spec.subject : "";
  const inReplyTo =
    Array.isArray(spec.inReplyTo) && typeof spec.inReplyTo[0] === "string"
      ? (spec.inReplyTo[0] as string)
      : null;

  // Body: resolve textBody/htmlBody partId refs against bodyValues.
  const bodyValues = (spec.bodyValues as Record<string, { value?: string }> | undefined) ?? {};
  const text = resolveBodyPart(spec.textBody, bodyValues);
  const html = resolveBodyPart(spec.htmlBody, bodyValues);

  const messageId = `${crypto.randomUUID()}@${from[0]?.email.split("@")[1] ?? "localhost"}`;
  const raw = buildMime({
    from,
    to,
    cc,
    bcc,
    subject,
    messageId,
    inReplyTo,
    date: new Date(),
    ...(text !== undefined ? { text } : {}),
    ...(html !== undefined ? { html } : {}),
  });

  const rawBuf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const blobId = await store.putBlob(access.tenantId, access.accountId, rawBuf);
  const threadId = await store.resolveThreadId(access.accountId, inReplyTo);
  const id = `e_${crypto.randomUUID()}`;
  const receivedAt = Date.now();

  await store.insertEmail(access.accountId, {
    id,
    blobId,
    threadId,
    messageId,
    inReplyTo,
    subject,
    from,
    to,
    cc,
    bcc,
    preview: (text ?? "").slice(0, 256),
    size: raw.byteLength,
    receivedAt,
    hasAttachment: false,
    attachments: [],
    mailboxIds,
    keywords,
  });

  r.emailChanges.created.push(id);
  for (const mb of mailboxIds) r.mailboxesTouched.add(mb);

  return { id, blobId, threadId, size: raw.byteLength };
}

function resolveBodyPart(
  partList: unknown,
  bodyValues: Record<string, { value?: string }>,
): string | undefined {
  if (!Array.isArray(partList) || partList.length === 0) return undefined;
  const partId = (partList[0] as { partId?: string }).partId;
  if (!partId) return undefined;
  return bodyValues[partId]?.value;
}

function fromJmapAddresses(value: unknown): EmailAddress[] {
  if (!Array.isArray(value)) return [];
  return (value as Array<{ name?: string | null; email?: string }>)
    .filter((a) => typeof a.email === "string")
    .map((a) => ({ ...(a.name ? { name: a.name } : {}), email: a.email as string }));
}
