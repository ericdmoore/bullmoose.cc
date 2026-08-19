/**
 * Part-addressed blob ids: `<rawBlobId>~<partId>`.
 *
 * Why they exist: real RFC 8621 clients (Mailtemi, observed live) render a
 * message by walking `bodyStructure` and DOWNLOADING each leaf by its
 * `blobId` — they never read `bodyValues`. PostalMime's flattened parse gives
 * the text/html leaves no stored blob of their own, so until s-this they
 * carried `blobId: null`, the client filled the download template with the
 * literal string "null" (`GET /api/download/<acct>/null/...`), and every
 * message body spun forever. A part address names a part WITHIN the message's
 * raw blob; the download door re-parses that raw message and serves just the
 * addressed part (`handleDownload` in index.ts).
 *
 * Why `~` as the separator — the two properties it must have:
 *
 * 1. IT CANNOT OCCUR IN A REAL BLOB ID, so the two id spaces cannot collide.
 *    Blob ids are minted in exactly one place, `Mailstore.putBlob`
 *    (packages/mailstore): `b_` + 64 lowercase hex chars of the content's
 *    SHA-256. The alphabet is `[b_0-9a-f]` — no `~` possible. Any id
 *    containing `~` is therefore unambiguously a part address, and a
 *    part address can never shadow a stored blob.
 *
 * 2. IT SURVIVES THE URL PATH. `{blobId}` is a path segment in the session's
 *    downloadUrl template, and `~` is "unreserved" per RFC 3986 §2.3 — both
 *    RFC 6570 template expansion and `encodeURIComponent` leave it untouched,
 *    so clients that fill the template literally and clients that expand it
 *    by the book send the same bytes on the wire.
 */
export const PART_SEPARATOR = "~";

/** The blobId served for body part `partId` of the message stored at `rawBlobId`. */
export function partBlobId(rawBlobId: string, partId: string): string {
  return `${rawBlobId}${PART_SEPARATOR}${partId}`;
}

/**
 * Recognize a part address. Returns null for anything else — including a
 * leading/trailing separator, which no id this server ever minted can carry;
 * such strings fall through to the whole-blob lookup and 404 there.
 */
export function parsePartBlobId(id: string): { blobId: string; partId: string } | null {
  const i = id.indexOf(PART_SEPARATOR);
  if (i <= 0 || i === id.length - 1) return null;
  return { blobId: id.slice(0, i), partId: id.slice(i + 1) };
}
