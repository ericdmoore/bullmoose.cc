import type { AttachmentMeta, Mailstore, WriteProvenance } from "@bullmoose/mailstore";

/**
 * The attachment sidestep, inbound half (s03.B T3).
 *
 * The rule, in one line: **an attachment at or above `N` bytes also becomes a
 * FileNode under the account's Attachments folder.** Before this, a big
 * attachment existed only as a row inside `emails.attachments_json` — a blob
 * you could download if you already knew the message, and nothing the Files
 * realm could see. That is why the Files browser had an empty drive to render
 * (`s03.B/arch.md` §5: "this is what makes Files useful on day one").
 *
 * Three things this deliberately does NOT do:
 *
 *  1. **It does not move the attachment.** `putBlob` is content-addressed, so
 *     the FileNode and the message reference ONE R2 object; the message keeps
 *     its attachment metadata byte-for-byte and gains a `fileNodeId`
 *     cross-link. Inbound mail is immutable RFC 5322 bytes — rewriting a
 *     received message to strip an attachment would be a forgery. (The
 *     OUTBOUND half of T3 — attach → link-in-body → no attachment — is a
 *     compose-path change and is not implemented here; `Email/set create`
 *     has no attachment path at all yet.)
 *  2. **It does not run on the quarantine paths.** `quarantineDeliver` and
 *     `screenDeliver` hold suspected spam; filing its attachments into the
 *     user's drive would push unjudged content into a second realm, exactly
 *     like the agent invocations and auto-responders those paths already omit.
 *  3. **It never throws.** See below.
 *
 * ## Fail-open
 *
 * Ingest is the delivery hot path, and the s12 boundary work set the rule in
 * this same file: a store failure must not bounce or lose mail. So every
 * function here is total — the D1 work sits inside one `try`, the accumulators
 * sit OUTSIDE it, and the catch returns the attachments processed so far plus
 * the untouched remainder. The worst case is a delivered message whose
 * attachments carry no `fileNodeId`, which is exactly pre-T3 behaviour.
 *
 * ## Cost when it does not fire
 *
 * Zero. The candidate filter is pure and runs before any binding is touched,
 * so a message with no attachments — or with small ones — pays one array
 * filter and issues no D1 or R2 operation at all.
 */

/** `role` on the directory the sidestep files into; `FileNode/query` filters on it. */
export const ATTACHMENTS_ROLE = "attachments";
/** Display name of that directory, created on first use. */
export const ATTACHMENTS_DIR_NAME = "Attachments";

/**
 * The conservative default `N`, in bytes.
 *
 * Two ceilings bracket the choice. Above: Cloudflare Email Routing refuses
 * inbound mail over ~25 MB, so a threshold anywhere near the SMTP ceiling the
 * OUTBOUND half exists to dodge would simply never fire on delivery. Below:
 * ordinary mail is full of 100 KB PDFs and 1 MB phone photos, and filing those
 * turns the drive into a junk pile rather than a place to find things.
 *
 * 5 MiB sits above everyday attachments and below what can actually arrive, so
 * the rule fires for the messages a person would describe as "the big one".
 */
export const DEFAULT_SIDESTEP_MIN_BYTES = 5 * 1024 * 1024;

/** Longest FileNode name the JMAP layer accepts (`filenode.ts` MAX_NAME). */
const MAX_NAME = 255;

/**
 * Who ingest writes as.
 *
 * Delivery has no authenticated principal — nobody logged in, and the envelope
 * sender is a remote stranger, not a principal of this system — so stamping
 * either would be a lie in the one column an auditor trusts. `system:ingest`
 * cannot collide with a login email (it has no `@`) and answers the question
 * the provenance trio actually asks: which writer put this row here. Binding
 * and invocation stay NULL because no agent acted.
 *
 * Note this is scoped to the sidestep's own Mailstore. Delivery's store keeps
 * writing NULL provenance, as the `Mailstore` constructor documents for system
 * paths — this changes what a FileNode records, not what an email records.
 */
export const SIDESTEP_WRITER: WriteProvenance = {
  principal: "system:ingest",
  binding: null,
  invocation: null,
};

/** What `deliver` needs back: the cross-linked attachments and the new nodes. */
export interface SidestepResult {
  /**
   * `attachments`, in the same order, with `fileNodeId` filled in on the ones
   * that side-stepped. Identical objects otherwise.
   */
  attachments: AttachmentMeta[];
  /** FileNode ids created, for the AccountDO `commitChanges` entry. */
  created: string[];
}

/** The env knobs this module reads (a subset of ingest's `Env`). */
export interface SidestepEnv {
  /**
   * Deployment-wide override for `N`, in bytes. A string because Worker vars
   * are strings. `0` (or any non-positive value) disables the sidestep.
   */
  ATTACHMENT_SIDESTEP_BYTES?: string;
}

/** The route fields this module reads (a subset of ingest's `Route`). */
export interface SidestepRoute {
  /** Per-account override for `N`, in bytes; `0` disables. */
  sidestepBytes?: number;
}

/**
 * Resolve `N`: route (per account) → env var (per deployment) → the default.
 *
 * `s03.B/arch.md` §5 calls the threshold "a policy value, not a constant", so
 * it is settable at the level where policy is actually held. The route value is
 * the cheap place — ingest has already read it from KV to resolve the recipient,
 * so a per-account threshold costs no extra lookup on the hot path.
 *
 * A non-positive or unparseable value means OFF, not "use the default": an
 * operator who sets the knob to 0 wants it off, and a typo should not silently
 * re-enable a policy they tried to change.
 */
export function sidestepThreshold(env: SidestepEnv, route: SidestepRoute): number {
  const raw = route.sidestepBytes ?? numberOrNull(env.ATTACHMENT_SIDESTEP_BYTES);
  if (raw === null || raw === undefined) return DEFAULT_SIDESTEP_MIN_BYTES;
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function numberOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0; // unparseable → OFF, per the doc above
}

/**
 * Does this attachment side-step?
 *
 * Size is the whole rule the plan states ("attachment ≥ N bytes"). The one
 * addition is the `inline` exclusion, and it is the line this file already
 * draws twice: `hasAttachment` is computed as
 * `attachments.some(a => a.disposition !== "inline")`, because a `cid:`-
 * referenced part is body furniture — the newsletter's header image — not a
 * file someone attached. Filing those would fill the drive with things nobody
 * ever "attached", and would still not help the reader, since the message body
 * already renders them.
 *
 * There is no MIME-type rule: type is not a proxy for "is this a file", and a
 * 40 MB video and a 40 MB zip are equally worth having a name for.
 */
export function isSidestepCandidate(att: AttachmentMeta, threshold: number): boolean {
  if (threshold <= 0) return false;
  if (att.disposition === "inline") return false;
  return att.size >= threshold;
}

/**
 * File every large attachment as a FileNode and return the cross-linked list.
 *
 * TOTAL: this never throws, never rejects, and never returns fewer attachments
 * than it was given. On any failure the message still has its attachments; they
 * just have no `fileNodeId`.
 */
export async function sidestepAttachments(
  store: Mailstore,
  accountId: string,
  attachments: AttachmentMeta[],
  threshold: number,
): Promise<SidestepResult> {
  if (!attachments.some((a) => isSidestepCandidate(a, threshold))) {
    // The DefaultCase: not one D1 or R2 operation for ordinary mail.
    return { attachments, created: [] };
  }

  // Outside the try on purpose — a throw half-way through must still return the
  // work that already landed, or a FileNode row exists that nothing cross-links
  // and no `/changes` entry announces.
  const out: AttachmentMeta[] = [];
  const created: string[] = [];

  try {
    const dir = await store.ensureRoleDirectory(accountId, ATTACHMENTS_ROLE, ATTACHMENTS_DIR_NAME);
    // The folder is a created node too. Omit it and the client that syncs on
    // FileNode/changes is handed a file whose parentId it has never seen.
    if (dir.created) created.push(dir.id);
    const siblings = await store.getFileNodeChildren(accountId, dir.id);
    // `UNIQUE(account_id, parent_id, name)` is real for a non-null parent, so a
    // second `invoice.pdf` MUST be renamed rather than left to raise.
    const taken = new Set(siblings.map((n) => n.name));
    // Content addressing means a re-sent attachment is the SAME object; point
    // at the node that already holds it instead of minting "invoice (2).pdf".
    const byBlob = new Map<string, string>();
    for (const n of siblings) if (n.blobId) byBlob.set(n.blobId, n.id);

    for (const att of attachments) {
      if (!isSidestepCandidate(att, threshold)) {
        out.push(att);
        continue;
      }
      const existing = byBlob.get(att.blobId);
      if (existing) {
        out.push({ ...att, fileNodeId: existing });
        continue;
      }

      const name = uniqueName(fileNameFor(att), taken);
      const now = Date.now();
      const id = `fn_${crypto.randomUUID()}`;
      await store.insertFileNode(accountId, {
        id,
        parentId: dir.id,
        name,
        nodeType: "file",
        blobId: att.blobId,
        size: att.size,
        type: att.type,
        created: now,
        modified: now,
        accessed: now,
        changed: now,
        executable: false,
        isSubscribed: true,
        role: null,
      });
      taken.add(name);
      byBlob.set(att.blobId, id);
      created.push(id);
      out.push({ ...att, fileNodeId: id });
    }
  } catch (err) {
    // Fail OPEN, the s12 rule for this worker: a shard that predates
    // `file_nodes`, a D1 blip, a UNIQUE we did not anticipate — none of it may
    // cost the recipient their mail. Say it happened; deliver anyway.
    console.error(
      `attachment sidestep failed for ${accountId}: ${
        err instanceof Error ? err.message : err
      }; delivering with inline attachment metadata only`,
    );
    return { attachments: [...out, ...attachments.slice(out.length)], created };
  }

  return { attachments: out, created };
}

/**
 * A safe FileNode name for an attachment.
 *
 * The JMAP layer requires 1..255 characters with no `/`; a MIME filename is
 * attacker-controlled and can be empty, a path, or full of control characters.
 * An unnamed part gets a stable, recognizable fallback rather than "untitled".
 */
export function fileNameFor(att: AttachmentMeta): string {
  const cleaned = (att.name ?? "")
    // Control characters and the path separators, and nothing else — a
    // filename with spaces or unicode in it is a perfectly good filename.
    .replace(/[\p{Cc}/\\]+/gu, "_")
    .trim()
    .slice(0, MAX_NAME);
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return `attachment-${att.blobId.slice(0, 8)}`;
  }
  return cleaned;
}

/**
 * `name`, or the first `name (2)`, `name (3)`… not already used here.
 *
 * Suffixed BEFORE the extension so a Files browser (and every OS that opens
 * the download) still sees a `.pdf`.
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  // A leading dot is a dotfile, not an extension; a long tail is not one either.
  const hasExt = dot > 0 && name.length - dot <= 11;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`.slice(0, MAX_NAME);
    if (!taken.has(candidate)) return candidate;
  }
  // 998 collisions on one name in one folder: fall back to something unique
  // rather than loop forever or throw on the delivery path.
  return `${stem} (${crypto.randomUUID().slice(0, 8)})${ext}`.slice(0, MAX_NAME);
}
