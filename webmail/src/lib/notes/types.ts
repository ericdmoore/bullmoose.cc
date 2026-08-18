// The webmail's view of a Note (s18 N1) — the client twin of the server
// projection in `services/jmap/src/methods/note.ts` (`toJmap`).
//
// ⚠️ A Note is NOT an Annotation, and this file is deliberately NOT
// `lib/annotations/types.ts` with optional fields. A Note is a document you
// AUTHOR: it stands alone, it has no anchor, no class, no confidence and no
// status, and the absence of those four is the entity distinction (s18
// devPlan, "The decision: two entities"). An Annotation is a claim about your
// mail that you adjudicate; it lives in the margin of the message it is about
// (`lib/annotations/`), and merging the two types would be the first step back
// to the one-table-with-nullable-columns shortcut the plan rejected.
//
// Shape note, the same one that bit the approvals and annotations code:
// `createdAt`/`updatedAt` arrive as NUMBERS (epoch ms), not ISO strings.

export interface Note {
  id: string;
  accountId: string;
  /**
   * The authoring principal's login, written once by the server and never
   * rewritten. This is the FEDERATION IDENTITY (s18 N3): a mention that
   * travels is authenticated by DKIM on the owner's domain, so "who authored
   * this" has to be a property of the note rather than of whoever last saved
   * it. Nothing federates today.
   */
  owner: string;
  title: string;
  body: string;
  /** Monotonic, bumped by the server on every content write. Last-writer-wins
   *  (no CRDT — explicitly out of scope in s18), so the version a client was
   *  shown is a number it can compare rather than a guess. */
  revision: number;
  /** Who saved it last, and under which agent binding if any (s03.A T1). */
  lastWriter: string | null;
  lastWriterBinding: string | null;
  createdAt: number;
  updatedAt: number;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Coerce a raw JMAP row into a Note, or null when it has no id (an un-id'd row
 * is not addressable). Tolerant of missing fields — a list must render
 * whatever loaded rather than throw over one odd row.
 */
export function parseNote(raw: Record<string, unknown>, fallbackAccountId = ""): Note | null {
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  return {
    id: raw.id,
    accountId: str(raw.accountId) ?? fallbackAccountId,
    owner: str(raw.owner) ?? "",
    title: typeof raw.title === "string" ? raw.title : "",
    body: typeof raw.body === "string" ? raw.body : "",
    revision: num(raw.revision) ?? 1,
    lastWriter: str(raw.lastWriter),
    lastWriterBinding: str(raw.lastWriterBinding),
    createdAt: num(raw.createdAt) ?? 0,
    updatedAt: num(raw.updatedAt) ?? 0,
  };
}
