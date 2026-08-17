/**
 * Minimal RFC 5322 / MIME *builder* for drafts created via Email/set.
 * (Inbound parsing is postal-mime's job; this is the write side.)
 *
 * Supports text/plain, text/html, or multipart/alternative with both, plus
 * binary attachments — CID-referenced inline parts in a multipart/related,
 * and ordinary file attachments in a multipart/mixed:
 *
 *   multipart/mixed
 *   ├── multipart/related
 *   │   ├── multipart/alternative
 *   │   │   ├── text/plain
 *   │   │   └── text/html      (references cid: parts)
 *   │   └── inline parts       (Content-ID)
 *   └── attachment parts
 *
 * Empty levels collapse: with no attachments at all the output is byte-for-byte
 * what this builder emitted before they existed, which `index.test.ts` pins
 * against golden strings. That equivalence is not luck — the node/multipart
 * shape below is lifted from `packages/cli/src/mime.ts`, whose single-part and
 * multipart/alternative serialization is already identical to the flat
 * header-pushing version this replaced.
 *
 * Bodies and attachments are base64-encoded (RFC 2045 §6.8), wrapped at 76
 * columns — line-length safe for any content, and no CTE guessing.
 */

export interface MimeAddress {
  name?: string;
  email: string;
}

/**
 * One attachment, with its bytes ALREADY resolved.
 *
 * The builder never fetches: a `blobId` is an authorization question (whose
 * blob is it?) and this package has no store and no notion of an account, so
 * resolving one here would put an access-control decision somewhere it cannot
 * be made. Callers fetch under the caller's own account scope and hand over
 * bytes — see `createDraft` in services/jmap/src/methods/email.ts.
 */
export interface MimeAttachment {
  /** Media type, e.g. "application/pdf". Defaulted by the caller. */
  type: string;
  /** Raw bytes. Base64-encoded into the part. */
  content: Uint8Array;
  /** Filename for Content-Disposition; null/absent omits the parameter. */
  name?: string | null;
  /**
   * Content-ID *without* angle brackets. Its presence — not the disposition —
   * is what puts the part in a multipart/related next to the body, because
   * `related` exists precisely to resolve `cid:` references from the HTML.
   */
  cid?: string | null;
  /** RFC 2183 disposition. Defaults to "inline" with a cid, "attachment" without. */
  disposition?: string | null;
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
  attachments?: MimeAttachment[];
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

  const body = bodyNode(draft);
  return new TextEncoder().encode(headers.join(CRLF) + CRLF + body.headers + CRLF + CRLF + body.content);
}

interface Node {
  /** Content-Type (+ transfer-encoding etc.) header lines, CRLF-joined, leading CRLF-free. */
  headers: string;
  content: string;
}

/**
 * The body tree, innermost first. Each wrapper is added only if it has
 * occupants, so a plain text draft is still a bare text/plain part with the
 * Content-Type on the top-level header block.
 */
function bodyNode(draft: DraftMessage): Node {
  let node = alternativeNode(draft);
  const attachments = draft.attachments ?? [];
  // `related` holds exactly the cid-referenced parts; everything else is a
  // sibling of the body in `mixed`. See MimeAttachment.cid.
  const related = attachments.filter((a) => cidOf(a) !== "");
  const mixed = attachments.filter((a) => cidOf(a) === "");

  if (related.length > 0) {
    node = multipart("related", [node, ...related.map(attachmentNode)]);
  }
  if (mixed.length > 0) {
    node = multipart("mixed", [node, ...mixed.map(attachmentNode)]);
  }
  return node;
}

function alternativeNode(draft: DraftMessage): Node {
  const parts: Node[] = [];
  if (draft.text !== undefined) parts.push(textPart("text/plain", draft.text));
  if (draft.html !== undefined) parts.push(textPart("text/html", draft.html));
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

/**
 * A binary part. EVERY header value here is attacker-reachable through
 * `Email/set create` — `type`, `name` and `cid` all arrive as client JSON —
 * so each goes through the same sanitising chokepoint as the top-level
 * headers (see `stripCtl`). A CRLF in `type` would otherwise forge part
 * headers, and one in `name` would escape the quoted-string parameter.
 */
function attachmentNode(part: MimeAttachment): Node {
  const cid = cidOf(part);
  const disposition = dispositionOf(part);
  const headers = [`Content-Type: ${stripCtl(part.type)}`, "Content-Transfer-Encoding: base64"];
  if (cid !== "") headers.push(`Content-ID: <${cid}>`);
  headers.push(`Content-Disposition: ${disposition}${filenameParam(part.name)}`);
  return { headers: headers.join(CRLF), content: wrap76(base64Bytes(part.content)) };
}

/** Normalized Content-ID, or "" when the part is not cid-referenced. */
function cidOf(part: MimeAttachment): string {
  return part.cid ? msgId(part.cid) : "";
}

function dispositionOf(part: MimeAttachment): string {
  const given = part.disposition ? stripCtl(part.disposition).trim() : "";
  if (given !== "") return given.replaceAll(/[;\s]+/g, "");
  return part.cid ? "inline" : "attachment";
}

/**
 * `; filename=...` for a Content-Disposition, or "" when there is no name.
 *
 * ASCII names take the RFC 2183 quoted-string form. Non-ASCII takes RFC 2231's
 * `filename*` extended value rather than raw UTF-8 in a quoted-string, which is
 * what makes "rapport-café.pdf" survive the trip instead of arriving mojibake.
 */
function filenameParam(name: string | null | undefined): string {
  if (!name) return "";
  const safe = stripCtl(name).replaceAll(/["\\]/g, "");
  if (safe === "") return "";
  return isAscii(safe) ? `; filename="${safe}"` : `; filename*=utf-8''${rfc2231(safe)}`;
}

function rfc2231(value: string): string {
  // encodeURIComponent leaves !'()*~ unescaped; the first four are outside
  // RFC 2231's attribute-char, so escape them by hand.
  return encodeURIComponent(value).replaceAll(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
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
 * responder or an agent auto-reply, a display name, a Message-ID, and since
 * attachments landed, a part's type/filename/Content-ID — and a decoded CRLF
 * in any of them ends the field and starts an attacker-chosen one (`Bcc:` to
 * exfiltrate, or a doubled CRLF to forge the whole body, DKIM-signed by us).
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
 * straight off inbound mail — treat it as hostile. Same for an attachment's
 * `cid`, which the client chooses.
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
  return base64Bytes(new TextEncoder().encode(s));
}

/**
 * `btoa` over a binary string, not `Buffer` — this package is bundled into
 * Workers, where node:buffer is only present under nodejs_compat.
 */
function base64Bytes(bytes: Uint8Array): string {
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
