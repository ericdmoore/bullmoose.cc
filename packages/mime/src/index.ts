/**
 * Minimal RFC 5322 / MIME *builder* for drafts created via Email/set.
 * (Inbound parsing is postal-mime's job; this is the write side.)
 *
 * Supports text/plain, text/html, or multipart/alternative with both.
 * Bodies are base64-encoded — line-length safe for any content.
 * Attachment parts are future work (drafts with uploads reference blobs).
 */

export interface MimeAddress {
  name?: string;
  email: string;
}

export interface DraftMessage {
  from: MimeAddress[];
  to: MimeAddress[];
  cc?: MimeAddress[];
  bcc?: MimeAddress[];
  subject: string;
  /** Without angle brackets; they're added on serialization. */
  messageId: string;
  inReplyTo?: string | null;
  date: Date;
  text?: string;
  html?: string;
  /** Verbatim extra header lines, e.g. "Auto-Submitted: auto-replied". */
  extraHeaders?: string[];
}

const CRLF = "\r\n";

export function buildMime(draft: DraftMessage): Uint8Array {
  const headers: string[] = [
    `Date: ${rfc5322Date(draft.date)}`,
    `Message-ID: <${draft.messageId}>`,
    `From: ${formatAddressList(draft.from)}`,
    `To: ${formatAddressList(draft.to)}`,
  ];
  if (draft.cc && draft.cc.length > 0) headers.push(`Cc: ${formatAddressList(draft.cc)}`);
  if (draft.inReplyTo) {
    headers.push(`In-Reply-To: <${draft.inReplyTo}>`);
    headers.push(`References: <${draft.inReplyTo}>`);
  }
  headers.push(`Subject: ${encodeHeaderValue(draft.subject)}`);
  for (const h of draft.extraHeaders ?? []) headers.push(h);
  headers.push("MIME-Version: 1.0");

  let body: string;
  const text = draft.text;
  const html = draft.html;

  if (text !== undefined && html !== undefined) {
    const boundary = `=_bm_${crypto.randomUUID().replaceAll("-", "")}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      ...textPart("text/plain", text),
      `--${boundary}`,
      ...textPart("text/html", html),
      `--${boundary}--`,
      "",
    ].join(CRLF);
  } else if (html !== undefined) {
    const [typeHeader, encHeader, encoded] = inlinePart("text/html", html);
    headers.push(typeHeader, encHeader);
    body = encoded;
  } else {
    const [typeHeader, encHeader, encoded] = inlinePart("text/plain", text ?? "");
    headers.push(typeHeader, encHeader);
    body = encoded;
  }

  return new TextEncoder().encode(headers.join(CRLF) + CRLF + CRLF + body);
}

function textPart(type: string, content: string): string[] {
  const [typeHeader, encHeader, encoded] = inlinePart(type, content);
  return [typeHeader, encHeader, "", encoded];
}

function inlinePart(type: string, content: string): [string, string, string] {
  return [
    `Content-Type: ${type}; charset=utf-8`,
    "Content-Transfer-Encoding: base64",
    wrap76(base64Utf8(content)),
  ];
}

// ---- helpers ---------------------------------------------------------

/** "Mon, 06 Jul 2026 04:00:00 +0000" */
function rfc5322Date(d: Date): string {
  return d.toUTCString().replace(/GMT$/, "+0000");
}

export function formatAddressList(list: MimeAddress[]): string {
  return list.map(formatAddress).join(", ");
}

export function formatAddress(a: MimeAddress): string {
  if (!a.name) return a.email;
  const name = /^[\w .'-]+$/.test(a.name)
    ? a.name
    : isAscii(a.name)
      ? `"${a.name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
      : encodeWord(a.name);
  return `${name} <${a.email}>`;
}

/** RFC 2047 B-encoding for non-ASCII header values. */
export function encodeHeaderValue(value: string): string {
  return isAscii(value) ? value : encodeWord(value);
}

function encodeWord(value: string): string {
  return `=?utf-8?B?${base64Utf8(value)}?=`;
}

function isAscii(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(s);
}

function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function wrap76(s: string): string {
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += 76) lines.push(s.slice(i, i + 76));
  return lines.join(CRLF);
}
