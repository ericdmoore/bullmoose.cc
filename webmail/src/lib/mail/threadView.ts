// Thread view — `Thread/get` + `Email/get` with bodies in ONE round trip, then
// sanitized rendering (arch.md §4, invariant §6.5: "a thread open is one round
// trip, not N").
//
// The single batch is built on an RFC 8620 §3.7 back-reference with a `*`
// path segment: `Thread/get` returns `list: [{ id, emailIds }]`, and
// `/list/*/emailIds` maps over it and flattens one level — which is exactly
// what `packages/jmap-core/src/dispatch.ts` `walkPointer` implements. Without
// that, opening a five-message thread would be two round trips minimum.

import { backReference } from "../jmap/JmapClient";
import type { JmapClient } from "../jmap/JmapClient";
import type { Invocation } from "../jmap/types";
import { splitQuotedText } from "./quote";
import { sanitizeEmailHtml, textToSafeHtml } from "./sanitize";
import { DETAIL_PROPERTIES, type Email } from "./types";

/**
 * Cap on the bytes of body the server inlines per message. Bounded because a
 * thread view fetches EVERY message's body at once; one 8 MB HTML newsletter
 * should not stall the open. The server honours this via `maxBodyValueBytes`
 * and reports `isTruncated`, which `renderMessage` surfaces.
 */
export const MAX_BODY_BYTES = 512 * 1024;

export interface ThreadDetail {
  threadId: string;
  /** Oldest first — reading order. */
  emails: Email[];
  /** Ids the thread claimed but `Email/get` did not return. */
  notFound: string[];
}

/**
 * Build a thread from cached messages alone — or null if we do not hold all
 * of them.
 *
 * All-or-nothing on purpose. A half-cached thread rendered now and completed a
 * moment later is a message that grows extra paragraphs under the reader's
 * eyes, which is worse than a shimmer: it moves what they were in the middle
 * of reading.
 *
 * The ids come from the ThreadRow that was clicked — the list already knows
 * them, which is why nothing has to be fetched to find out what to look up.
 */
export function threadFromCache(
  threadId: string,
  emailIds: readonly string[],
  cached: ReadonlyMap<string, { email: Email }>,
): ThreadDetail | null {
  if (emailIds.length === 0) return null;
  const emails: Email[] = [];
  for (const id of emailIds) {
    const hit = cached.get(id);
    if (!hit) return null;
    emails.push(hit.email);
  }
  return {
    threadId,
    emails: emails.slice().sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt)),
    notFound: [],
  };
}

/** Open a thread in one batched request. */
export async function loadThread(
  client: JmapClient,
  accountId: string,
  threadId: string,
  opts: { maxBodyBytes?: number } = {},
): Promise<ThreadDetail> {
  const calls: Invocation[] = [
    ["Thread/get", { accountId, ids: [threadId] }, "t"],
    [
      "Email/get",
      {
        accountId,
        "#ids": backReference("t", "Thread/get", "/list/*/emailIds"),
        properties: [...DETAIL_PROPERTIES],
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
        maxBodyValueBytes: opts.maxBodyBytes ?? MAX_BODY_BYTES,
      },
      "e",
    ],
  ];

  const responses = await client.request(calls);
  const threadResp = responses.find((r) => r[2] === "t");
  const emailResp = responses.find((r) => r[2] === "e");
  if (!threadResp || threadResp[0] === "error") {
    throw new ThreadViewError("Thread/get", threadResp?.[1]);
  }
  if (!emailResp || emailResp[0] === "error") {
    throw new ThreadViewError("Email/get", emailResp?.[1]);
  }

  const thread = (threadResp[1] as { list?: Array<{ id: string; emailIds: string[] }> }).list ?? [];
  const wanted = thread[0]?.emailIds ?? [];
  const fetched = ((emailResp[1] as { list?: Email[] }).list ?? []) as Email[];
  const byId = new Map(fetched.map((e) => [e.id, e]));

  const emails = wanted
    .map((id) => byId.get(id))
    .filter((e): e is Email => e !== undefined)
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));

  return {
    threadId,
    emails,
    notFound: wanted.filter((id) => !byId.has(id)),
  };
}

export class ThreadViewError extends Error {
  constructor(
    readonly method: string,
    readonly detail: unknown,
  ) {
    const type = (detail as { type?: string } | undefined)?.type;
    super(`${method} failed${type ? `: ${type}` : ""}`);
    this.name = "ThreadViewError";
  }
}

export interface RenderOptions {
  /** Per-message opt-in. Default false — remote content is blocked (arch.md §4). */
  allowRemoteContent?: boolean;
  /** Map a `cid:` inline attachment to a local URL. */
  resolveCid?: (cid: string) => string | null;
}

export interface RenderedMessage {
  /** Safe HTML for the visible part. */
  html: string;
  /** Safe HTML for the collapsed quote. Empty when there is none. */
  quotedHtml: string;
  /** True when the HTML part was used; false when it fell back to text. */
  isHtml: boolean;
  /** Remote resources neutralized — drives "N blocked images · Show". */
  blockedRemoteCount: number;
  /** The server truncated the body at `maxBodyValueBytes`. */
  truncated: boolean;
  /** Element names dropped with their content, for a "view details" affordance. */
  droppedTags: string[];
}

/**
 * Turn one `Email`'s bodies into render-ready HTML.
 *
 * HTML is preferred when present, because that is what the sender designed;
 * text/plain is the fallback and is escaped, never trusted. Either way the
 * output passes through the sanitizer — there is no path in this module that
 * returns sender markup unsanitized, which is invariant §6.3.
 */
export function renderMessage(email: Email, opts: RenderOptions = {}): RenderedMessage {
  // The server derives htmlBody per RFC 8621 §4.1.4, so for a text-only
  // message it (correctly) contains the text/plain part. Rendering is chosen
  // off the part's TYPE, never off which list it arrived in — a text/plain
  // value must not be interpreted as markup.
  const htmlPart = email.htmlBody?.[0]?.type === "text/html" ? firstBodyValue(email, email.htmlBody) : undefined;
  const textPart = firstBodyValue(email, email.textBody);

  if (htmlPart) {
    const result = sanitizeEmailHtml(htmlPart.value, {
      allowRemoteContent: opts.allowRemoteContent === true,
      ...(opts.resolveCid ? { resolveCid: opts.resolveCid } : {}),
    });
    return {
      html: result.html,
      quotedHtml: result.quotedHtml,
      isHtml: true,
      blockedRemoteCount: result.blockedRemoteCount,
      truncated: htmlPart.isTruncated === true,
      droppedTags: result.droppedTags,
    };
  }

  if (textPart) {
    const split = splitQuotedText(textPart.value);
    const visible = split.signature ? `${split.body}\n${split.signature}` : split.body;
    return {
      html: textToSafeHtml(visible),
      quotedHtml: split.quoted ? textToSafeHtml(split.quoted) : "",
      isHtml: false,
      blockedRemoteCount: 0,
      truncated: textPart.isTruncated === true,
      droppedTags: [],
    };
  }

  // No body at all (the blob is gone, or `Email/get` was called without body
  // properties). Fall back to the preview rather than rendering a blank card.
  return {
    html: textToSafeHtml(email.preview ?? ""),
    quotedHtml: "",
    isHtml: false,
    blockedRemoteCount: 0,
    truncated: false,
    droppedTags: [],
  };
}

function firstBodyValue(email: Email, parts: Email["htmlBody"]): { value: string; isTruncated?: boolean } | undefined {
  const partId = parts?.[0]?.partId;
  if (!partId) return undefined;
  const value = email.bodyValues?.[partId];
  if (!value || typeof value.value !== "string") return undefined;
  return value;
}

/**
 * Which messages start expanded. Gmail's rule, and it is the right one: the
 * newest message always, plus anything unread — a thread you opened because
 * something in it is new should not require a second click to see the new part.
 */
export function defaultExpanded(emails: Email[]): Set<string> {
  const open = new Set<string>();
  for (const e of emails) if (e.keywords?.$seen !== true) open.add(e.id);
  const last = emails[emails.length - 1];
  if (last) open.add(last.id);
  return open;
}

/** Attachments across the thread, deduped by blobId — the thread-level tray. */
export function threadAttachments(emails: Email[]): Array<Email["attachments"][number] & { emailId: string }> {
  const seen = new Set<string>();
  const out: Array<Email["attachments"][number] & { emailId: string }> = [];
  for (const email of emails) {
    for (const att of email.attachments ?? []) {
      // Inline images belong to the body, not the attachment tray.
      if (att.disposition === "inline" && att.cid) continue;
      if (seen.has(att.blobId)) continue;
      seen.add(att.blobId);
      out.push({ ...att, emailId: email.id });
    }
  }
  return out;
}
