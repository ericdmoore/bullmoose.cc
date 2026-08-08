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
    `Message-ID: <${msgId(draft.messageId)}>`,
    `From: ${formatAddressList(draft.from)}`,
    `To: ${formatAddressList(draft.to)}`,
  ];
  if (draft.cc && draft.cc.length > 0) headers.push(`Cc: ${formatAddressList(draft.cc)}`);
  if (draft.inReplyTo) {
    // inReplyTo is copied from INBOUND mail, so it is attacker-controlled.
    const ref = msgId(draft.inReplyTo);
    headers.push(`In-Reply-To: <${ref}>`);
    headers.push(`References: <${ref}>`);
  }
  headers.push(`Subject: ${encodeHeaderValue(draft.subject)}`);
  // Callers pass whole "Name: value" lines; one CRLF here is an extra header.
  for (const h of draft.extraHeaders ?? []) headers.push(stripCtl(h));
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
  // Both halves are attacker-reachable: `email` was interpolated with zero
  // escaping, and the quoted-string branch below only escapes \ and " — it
  // never touched CR/LF.
  const email = stripCtl(a.email);
  if (!a.name) return email;
  const rawName = stripCtl(a.name);
  const name = /^[\w .'-]+$/.test(rawName)
    ? rawName
    : isAscii(rawName)
      ? `"${rawName.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
      : encodeWord(rawName);
  return `${name} <${email}>`;
}

/**
 * RFC 5322 §2.2: a header field body may not contain bare CR or LF.
 *
 * This is the header-injection chokepoint. Untrusted values reach header
 * lines from several directions — an inbound Subject echoed by the vacation
 * responder or an agent auto-reply, a display name, a Message-ID — and a
 * decoded CRLF in any of them ends the field and starts an attacker-chosen
 * one (`Bcc:` to exfiltrate, or a doubled CRLF to forge the whole body,
 * DKIM-signed by us).
 *
 * Sanitising lives in the BUILDER rather than at each caller, so a new
 * caller cannot forget. Folding to a single space rather than deleting
 * matches RFC 5322 unfolding, which replaces CRLF+WSP with WSP.
 *
 * NB `isAscii` is not a guard here: CR (0x0D), LF (0x0A) and NUL are all
 * inside `[\x00-\x7F]`, which is exactly why the old code let them through.
 */
function stripCtl(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\r\n\0]+/g, " ");
}

/**
 * A msg-id sits inside angle brackets, so `<`, `>` or whitespace would
 * terminate or split the field even without a CRLF. `inReplyTo` is copied
 * straight off inbound mail — treat it as hostile.
 */
function msgId(value: string): string {
  return stripCtl(value).replace(/[<>\s]+/g, "");
}

/** RFC 2047 B-encoding for non-ASCII header values. */
export function encodeHeaderValue(value: string): string {
  const safe = stripCtl(value);
  return isAscii(safe) ? safe : encodeWord(safe);
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
