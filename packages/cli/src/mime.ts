/**
 * MIME builder for the CLI's send path (which the CLI can't get from the
 * server's @bullmoose/mime at runtime: that workspace package exports TS
 * source for wrangler's bundler, and this is plain compiled Node). Inline CID
 * images (multipart/related) and file attachments (multipart/mixed).
 *
 * No longer a superset: `@bullmoose/mime` grew the same nested-multipart
 * structure when Email/set learned to attach blobs, and its node/multipart
 * shape was lifted from here so the two emit the same bytes for the same
 * input. What still differs is `extraHeaders` (there only), `Buffer` vs
 * `btoa` base64 (here only), and the fact that this one takes no `disposition`
 * — it infers one from which list a part is in. A structural fix means giving
 * `@bullmoose/mime` a build step and dual exports; see its README.
 *
 *   multipart/mixed
 *   ├── multipart/related
 *   │   ├── multipart/alternative
 *   │   │   ├── text/plain
 *   │   │   └── text/html      (references cid: parts)
 *   │   └── inline parts       (Content-ID)
 *   └── attachment parts
 *
 * Empty levels collapse (no attachments → no mixed wrapper, etc.).
 */

export interface MimeAddress {
  name?: string;
  email: string;
}

export interface InlinePart {
  cid: string;
  type: string;
  name: string;
  content: Uint8Array;
}

export interface AttachmentPart {
  type: string;
  name: string;
  content: Uint8Array;
}

export interface OutgoingMessage {
  from: MimeAddress[];
  to: MimeAddress[];
  cc?: MimeAddress[];
  subject: string;
  /** Without angle brackets. */
  messageId: string;
  inReplyTo?: string | null;
  date: Date;
  text?: string;
  html?: string;
  inline?: InlinePart[];
  attachments?: AttachmentPart[];
}

const CRLF = "\r\n";

export function buildMime(msg: OutgoingMessage): Uint8Array {
  const headers: string[] = [
    `Date: ${rfc5322Date(msg.date)}`,
    `Message-ID: <${msgId(msg.messageId)}>`,
    `From: ${msg.from.map(formatAddress).join(", ")}`,
    `To: ${msg.to.map(formatAddress).join(", ")}`,
  ];
  if (msg.cc && msg.cc.length > 0) headers.push(`Cc: ${msg.cc.map(formatAddress).join(", ")}`);
  // Bcc is deliberately NOT written into the message — bcc recipients
  // travel only in the SMTP envelope (EmailSubmission's rcptTo).
  if (msg.inReplyTo) {
    // Copied from inbound mail on reply, so treat it as attacker-controlled.
    const ref = msgId(msg.inReplyTo);
    headers.push(`In-Reply-To: <${ref}>`);
    headers.push(`References: <${ref}>`);
  }
  headers.push(`Subject: ${encodeHeaderValue(msg.subject)}`);
  headers.push("MIME-Version: 1.0");

  const body = bodyNode(msg);
  return new TextEncoder().encode(headers.join(CRLF) + CRLF + body.headers + CRLF + CRLF + body.content);
}

interface Node {
  /** Content-Type (+ transfer-encoding etc.) header lines, CRLF-joined, leading CRLF-free. */
  headers: string;
  content: string;
}

function bodyNode(msg: OutgoingMessage): Node {
  let node = alternativeNode(msg);
  if (msg.inline && msg.inline.length > 0) {
    node = multipart("related", [
      node,
      ...msg.inline.map((p) =>
        binaryPart(p.type, p.content, [
          `Content-ID: <${p.cid}>`,
          `Content-Disposition: inline; filename="${sanitizeName(p.name)}"`,
        ]),
      ),
    ]);
  }
  if (msg.attachments && msg.attachments.length > 0) {
    node = multipart("mixed", [
      node,
      ...msg.attachments.map((p) =>
        binaryPart(p.type, p.content, [`Content-Disposition: attachment; filename="${sanitizeName(p.name)}"`]),
      ),
    ]);
  }
  return node;
}

function alternativeNode(msg: OutgoingMessage): Node {
  const parts: Node[] = [];
  if (msg.text !== undefined) parts.push(textPart("text/plain", msg.text));
  if (msg.html !== undefined) parts.push(textPart("text/html", msg.html));
  if (parts.length === 0) parts.push(textPart("text/plain", ""));
  if (parts.length === 1) return parts[0] as Node;
  return multipart("alternative", parts);
}

function multipart(subtype: string, parts: Node[]): Node {
  const boundary = `=_bm_${crypto.randomUUID().replaceAll("-", "")}`;
  const content = [...parts.flatMap((p) => [`--${boundary}`, p.headers, "", p.content]), `--${boundary}--`, ""].join(
    CRLF,
  );
  return {
    headers: `Content-Type: multipart/${subtype}; boundary="${boundary}"`,
    content,
  };
}

function textPart(type: string, content: string): Node {
  return {
    headers: [`Content-Type: ${type}; charset=utf-8`, "Content-Transfer-Encoding: base64"].join(CRLF),
    content: wrap76(base64Bytes(new TextEncoder().encode(content))),
  };
}

function binaryPart(type: string, content: Uint8Array, extraHeaders: string[]): Node {
  return {
    headers: [`Content-Type: ${type}`, "Content-Transfer-Encoding: base64", ...extraHeaders].join(CRLF),
    content: wrap76(base64Bytes(content)),
  };
}

// ---- helpers -----------------------------------------------------------

function rfc5322Date(d: Date): string {
  return d.toUTCString().replace(/GMT$/, "+0000");
}

export function formatAddress(a: MimeAddress): string {
  // Both halves are reachable: `email` had zero escaping, and the quoted
  // branch below escapes only \ and " — never CR/LF.
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
 * Mirrors `packages/mime`'s guard — the two builders have diverged (this one
 * does nested multipart + CID inlining) so the fix has to land in both. See
 * `.feedback/fromClaude/common/002`.
 *
 * `isAscii` is not a guard: CR (0x0D), LF (0x0A) and NUL are all inside
 * `[\x00-\x7F]`, which is exactly why the old code let them through. Note
 * `sanitizeName` below already knew this — it was just never applied to the
 * header path.
 */
function stripCtl(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\r\n\0]+/g, " ");
}

/** A msg-id sits inside angle brackets; `<`, `>` and WSP split the field. */
function msgId(value: string): string {
  return stripCtl(value).replace(/[<>\s]+/g, "");
}

export function encodeHeaderValue(value: string): string {
  const safe = stripCtl(value);
  return isAscii(safe) ? safe : encodeWord(safe);
}

function encodeWord(value: string): string {
  return `=?utf-8?B?${base64Bytes(new TextEncoder().encode(value))}?=`;
}

function isAscii(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(s);
}

function sanitizeName(name: string): string {
  return name.replaceAll('"', "").replaceAll(/[\r\n]/g, " ");
}

function base64Bytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function wrap76(s: string): string {
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += 76) lines.push(s.slice(i, i + 76));
  return lines.join(CRLF);
}
