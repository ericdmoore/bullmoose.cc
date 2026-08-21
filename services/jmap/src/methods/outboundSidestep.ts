import type { Mailstore } from "@bullmoose/mailstore";
import { mintShareLink, SHARE_DEFAULT_TTL } from "../shares";
import type { RequestContext } from "./common";

/**
 * The attachment sidestep, OUTBOUND half (s03.B T3).
 *
 * The rule, in one line: **a send that would be refused for its attachment
 * bytes goes out as links instead.** `Email/set create` caps attachments at
 * `MAX_ATTACHMENT_BYTES_PER_EMAIL` and refuses over-cap creates with
 * `tooLarge` — correct, and useless to the person holding five phone photos.
 * When the sidestep can fire, that same create SUCCEEDS: the files land in
 * the sender's drive as FileNodes, each gets an expiring share link through
 * the real share door (`mintShareLink`, the exact path `POST /api/share/*`
 * uses), and the message body gains a block naming each file, its size, its
 * link, and the date the links stop working.
 *
 * Constraints that are load-bearing, in order:
 *
 *  1. **It fires ONLY when the create would otherwise be refused.** A create
 *     whose attachments fit under the cap never reaches this module — the
 *     ordinary path runs and its MIME is byte-identical to before this
 *     existed. Nothing changes silently for normal mail; what was impossible
 *     becomes possible.
 *  2. **All-or-nothing.** When it fires, EVERY non-inline attachment moves to
 *     a link — not just enough of them to squeeze under the cap. Partial
 *     sidestep would mean the server choosing which files a recipient gets
 *     inline and which by link, and the recipient reading one message with
 *     two contradictory attachment stories. `cid:`-referenced inline parts
 *     stay on the wire (the HTML displays them; stripping one breaks the
 *     body), so a create whose INLINE bytes alone exceed the cap still
 *     refuses `tooLarge` — there is nothing honest to move.
 *  3. **The links are capability URLs.** Anyone holding one can download the
 *     file until expiry — that is the feature, and the block says so plainly
 *     rather than implying recipient-only access. It also states the expiry
 *     date, because pretending links are permanent is the lie we don't tell.
 *  4. **stored == wire.** The Sent copy IS the wire copy: links in the body,
 *     no oversized parts anywhere. The sender's durable copy of the BYTES is
 *     the FileNodes in the "Sent attachments" folder, which pin the blobs
 *     against GC and are visible in Files.
 *
 * Unlike the INBOUND half (`services/ingest/src/sidestep.ts`), this path has
 * an authenticated principal and a client waiting on the answer, so it does
 * NOT fail open: if a FileNode insert or a link mint fails, the create
 * refuses (`serverFail`) rather than sending a message whose promised links
 * do not all exist. FileNodes minted before the failure stay — they are real
 * files in the drive, announced via the changelog accumulator the caller
 * passes in.
 *
 * No thumbnails yet, so the block is names and links only. The reason
 * recorded here — "Workers cannot resize images" — STOPPED BEING TRUE on
 * 2026-08-20, when Image Transformations were enabled for the zone (sources
 * scoped to `bullmoose.cc`/`*.bullmoose.cc`). The constraint is now a
 * to-do, not a limit.
 *
 * ⚠️ When it is built, do NOT reach it by URL. `/cdn-cgi/image/…` fetches
 * its source from the edge WITHOUT the caller's bearer token, and
 * `/api/download/…` is gated on `principalHasScope(principal, "read")` — so
 * the naive wiring 403s, and the "fix" that makes it work is making
 * attachment blobs publicly fetchable. That would turn every attachment into
 * a bearer-capability URL and delete the auth check this system is built on.
 * The share mechanism is wrong here for the same reason: a share link is a
 * capability for the FULL-FIDELITY original, which is far more than "show me
 * a small picture".
 *
 * The shape that keeps the model: authenticate the principal, read the blob
 * from R2 in this worker, and transform on a subrequest
 * (`fetch(src, { cf: { image: … } })`). Auth first, transform second, no
 * public URL ever minted.
 */

/** `role` on the directory the sidestep files into. */
export const SENT_ATTACHMENTS_ROLE = "sent-attachments";
/** Display name of that directory, created on first use. */
export const SENT_ATTACHMENTS_DIR_NAME = "Sent attachments";

/** Longest FileNode name the JMAP layer accepts (`filenode.ts` MAX_NAME). */
const MAX_NAME = 255;

/** The slice of an email.ts `AttachmentSpec` this module reads. */
export interface OutboundFileSpec {
  blobId: string;
  type: string;
  name: string | null;
  disposition: string;
}

export interface PlannedSidestep<S extends OutboundFileSpec> {
  /** Non-inline attachments, every one of which becomes a link. */
  moved: Array<{ spec: S; size: number }>;
  /** Inline (`cid:`) parts that must stay on the wire. */
  kept: S[];
}

/**
 * Can this over-cap create be saved? `null` means no — the caller rethrows
 * its original `tooLarge`, so an environment where the sidestep cannot fire
 * behaves exactly as before it existed.
 *
 * `null` when:
 *  - there is no non-inline attachment to move, or
 *  - the bytes that MUST stay (inline parts here, plus `reservedSpecs` — the
 *    bodyStructure form's blob-carried body leaves) still exceed the cap, or
 *  - any blob fails to `head` (deleted since the first pass; a retry would
 *    refuse `blobNotFound` anyway, and the original refusal is already
 *    honest).
 *
 * Heads only — no body bytes move here, same reasoning as the cap check in
 * `resolveAttachments`.
 */
export async function planOutboundSidestep<S extends OutboundFileSpec>(
  store: Mailstore,
  access: { accountId: string; tenantId: string },
  specs: S[],
  reservedSpecs: OutboundFileSpec[],
  cap: number,
): Promise<PlannedSidestep<S> | null> {
  const moved: Array<{ spec: S; size: number }> = [];
  const kept: S[] = [];
  let keptTotal = 0;

  for (const spec of reservedSpecs) {
    const head = await store.headBlob(access.tenantId, access.accountId, spec.blobId);
    if (!head) return null;
    keptTotal += head.size;
  }
  for (const spec of specs) {
    const head = await store.headBlob(access.tenantId, access.accountId, spec.blobId);
    if (!head) return null;
    if (spec.disposition === "inline") {
      kept.push(spec);
      keptTotal += head.size;
    } else {
      moved.push({ spec, size: head.size });
    }
  }

  if (moved.length === 0) return null;
  if (keptTotal > cap) return null;
  return { moved, kept };
}

/** One side-stepped file, as the body block and the caller's tests see it. */
export interface SidestepLinkedFile {
  /** FileNode name actually used (sanitized, uniqued among siblings). */
  name: string;
  size: number;
  type: string;
  url: string;
  fileNodeId: string;
  blobId: string;
}

export interface AppliedSidestep {
  files: SidestepLinkedFile[];
  /** Link expiry, epoch seconds — ONE instant, signed into every link. */
  exp: number;
}

/**
 * File each moved attachment as a FileNode under "Sent attachments" and mint
 * its expiring link. Throws on any failure — see the module header for why
 * this half does not fail open.
 *
 * `createdNodeIds` is an accumulator OWNED BY THE CALLER, appended to as each
 * node lands, so nodes that exist by the time of a mid-flight failure still
 * reach the changelog — a FileNode in D1 that no `/changes` entry announces
 * is invisible to every syncing client.
 *
 * All links share one `now`, hence one `exp`, hence ONE honest expiry date in
 * the body block.
 */
export async function applyOutboundSidestep(
  ctx: RequestContext,
  store: Mailstore,
  access: { accountId: string; tenantId: string },
  moved: Array<{ spec: OutboundFileSpec; size: number }>,
  createdNodeIds: string[],
): Promise<AppliedSidestep> {
  const signingKey = ctx.env.SHARE_SIGNING_KEY;
  const origin = ctx.origin;
  if (!signingKey || !origin) {
    // email.ts gates on both (sidestepPlanFor) before ever planning a move;
    // this is the belt-and-braces for a future caller that does not.
    throw new Error("outbound sidestep invoked without share configuration");
  }

  const dir = await store.ensureRoleDirectory(access.accountId, SENT_ATTACHMENTS_ROLE, SENT_ATTACHMENTS_DIR_NAME);
  if (dir.created) createdNodeIds.push(dir.id);

  // Sibling names are DB-unique (`UNIQUE(account_id, parent_id, name)`), so a
  // second `IMG_0001.jpg` must be renamed rather than left to raise. Content
  // addressing means a re-sent file is the SAME blob; reuse its node instead
  // of minting "IMG_0001 (2).jpg" beside it.
  const siblings = await store.getFileNodeChildren(access.accountId, dir.id);
  const taken = new Set(siblings.map((n) => n.name));
  const byBlob = new Map<string, { id: string; name: string }>();
  for (const n of siblings) if (n.blobId) byBlob.set(n.blobId, { id: n.id, name: n.name });

  const now = Date.now();
  const files: SidestepLinkedFile[] = [];

  for (const { spec, size } of moved) {
    let node = byBlob.get(spec.blobId);
    if (!node) {
      const name = uniqueName(fileNameFor(spec), taken);
      const id = `fn_${crypto.randomUUID()}`;
      await store.insertFileNode(access.accountId, {
        id,
        parentId: dir.id,
        name,
        nodeType: "file",
        blobId: spec.blobId,
        size,
        type: spec.type,
        created: now,
        modified: now,
        accessed: now,
        changed: now,
        executable: false,
        isSubscribed: true,
        role: null,
      });
      taken.add(name);
      node = { id, name };
      byBlob.set(spec.blobId, node);
      createdNodeIds.push(id);
    }

    const minted = await mintShareLink(ctx.env.ROUTES, signingKey, origin, {
      tenantId: access.tenantId,
      accountId: access.accountId,
      blobId: spec.blobId,
      name: node.name,
      type: spec.type,
      ttlSeconds: SHARE_DEFAULT_TTL,
      now,
    });

    files.push({
      name: node.name,
      size,
      type: spec.type,
      url: minted.url,
      fileNodeId: node.id,
      blobId: spec.blobId,
    });
  }

  return { files, exp: Math.floor(now / 1000) + SHARE_DEFAULT_TTL };
}

// ---- the body block ----------------------------------------------------

/**
 * Append the link block to whatever body variants the message HAS: text and
 * html both get it when both exist; a message with neither (an all-attachment
 * send) grows a text body, because the links must ride SOMEWHERE.
 */
export function appendSidestepBlock(
  text: string | undefined,
  html: string | undefined,
  applied: AppliedSidestep,
): { text?: string; html?: string } {
  const out: { text?: string; html?: string } = {};
  if (text !== undefined)
    out.text = text === "" ? sidestepBlockText(applied) : `${text}\n\n${sidestepBlockText(applied)}`;
  if (html !== undefined) out.html = html + sidestepBlockHtml(applied);
  if (out.text === undefined && out.html === undefined) out.text = sidestepBlockText(applied);
  return out;
}

/** "available until 2026-09-18 (UTC)" — plain, unambiguous, no pretence. */
export function expiryPhrase(exp: number): string {
  return `${new Date(exp * 1000).toISOString().slice(0, 10)} (UTC)`;
}

function blockIntro(applied: AppliedSidestep): { headline: string; access: string } {
  const n = applied.files.length;
  return {
    headline:
      n === 1
        ? "1 attachment was too large to send with this message, so it was uploaded and linked instead."
        : `${n} attachments were too large to send with this message, so they were uploaded and linked instead.`,
    // Capability-URL honesty: anyone with the link, until the stated date.
    access: `Anyone with a link below can download the file until ${expiryPhrase(applied.exp)}; after that the links stop working.`,
  };
}

export function sidestepBlockText(applied: AppliedSidestep): string {
  const { headline, access } = blockIntro(applied);
  const lines = applied.files.map((f) => `- ${f.name} (${humanSize(f.size)}): ${f.url}`);
  return ["----------------------------------------", headline, access, "", ...lines].join("\n");
}

export function sidestepBlockHtml(applied: AppliedSidestep): string {
  const { headline, access } = blockIntro(applied);
  const items = applied.files
    .map((f) => `<li><a href="${escapeHtml(f.url)}">${escapeHtml(f.name)}</a> (${humanSize(f.size)})</li>`)
    .join("");
  return (
    `<div style="margin-top:24px;padding:12px 16px;border:1px solid #d4d4d4;border-radius:8px">` +
    `<p style="margin:0 0 8px"><strong>${escapeHtml(headline)}</strong></p>` +
    `<p style="margin:0 0 8px">${escapeHtml(access)}</p>` +
    `<ul style="margin:0;padding-left:20px">${items}</ul>` +
    `</div>`
  );
}

/** "8.1 MB", "312 KB", "1.0 GB" — decimal units, one decimal from MB up. */
export function humanSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000_000) return `${Math.round(bytes / 1000)} KB`;
  if (bytes < 1000_000_000) return `${(bytes / 1000_000).toFixed(1)} MB`;
  return `${(bytes / 1000_000_000).toFixed(1)} GB`;
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// ---- naming (same rules as the inbound half) ---------------------------

/**
 * A safe FileNode name for an outgoing attachment: 1..255 chars, no `/`, no
 * control characters; an unnamed part gets a stable, recognizable fallback.
 * Mirrors `fileNameFor` in services/ingest/src/sidestep.ts — duplicated
 * because workers do not import each other's source.
 */
export function fileNameFor(spec: { name: string | null; blobId: string }): string {
  const cleaned = (spec.name ?? "")
    .replace(/[\p{Cc}/\\]+/gu, "_")
    .trim()
    .slice(0, MAX_NAME);
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return `attachment-${spec.blobId.slice(0, 8)}`;
  }
  return cleaned;
}

/** `name`, or the first `name (2)`, `name (3)`… not already used here. */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0 && name.length - dot <= 11;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`.slice(0, MAX_NAME);
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem} (${crypto.randomUUID().slice(0, 8)})${ext}`.slice(0, MAX_NAME);
}
