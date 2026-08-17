// The webmail's view of an Annotation (s18 A1/A4) — the agent-commentary noun,
// a CLAIM about a message you adjudicate. This is the client twin of the
// server projection in `services/jmap/src/methods/annotation.ts` (`toJmap`).
//
// Two shape notes that bit the approvals code and would bite here:
//   - `createdAt`/`updatedAt` arrive as NUMBERS (epoch ms), not ISO strings —
//     the server stores them numeric. `parseAnnotation` coerces accordingly.
//   - the row does NOT carry its own `accountId` (the query is per-account), so
//     the caller's account is threaded in as the fallback, exactly as
//     `parseProposal` does for the pre-T7 servers.

export type AnnotationClass = "commitment" | "decision" | "task";
export type AnnotationStatus = "open" | "resolved" | "dismissed";

/** What the claim is about: `{realm, objectId}` — the proposal subject shape. */
export interface AnnotationAnchor {
  realm: string;
  objectId: string;
}

export interface Annotation {
  id: string;
  accountId: string;
  /** 'agent' (an extraction) | 'human' (a filed claim). */
  authorKind: string;
  /** The binding name, or the principal login. */
  author: string;
  anchor: AnnotationAnchor | null;
  /** commitment | decision | task (kept open — the server stores TEXT). */
  class: string;
  body: string;
  /** 0..1 for an agent extraction; null when a human filed it (or unknown). */
  confidence: number | null;
  status: string;
  rationale: string | null;
  sourceRef: string | null;
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
 * Coerce a raw JMAP row into an Annotation, or null when it has no id (an
 * un-id'd row is not addressable and is dropped by the caller). Tolerant of
 * missing fields — a home glance must render whatever loaded, never throw.
 */
export function parseAnnotation(raw: Record<string, unknown>, fallbackAccountId = ""): Annotation | null {
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const a = raw.anchor && typeof raw.anchor === "object" ? (raw.anchor as Record<string, unknown>) : null;
  const anchor =
    a && typeof a.realm === "string" && typeof a.objectId === "string"
      ? { realm: a.realm, objectId: a.objectId }
      : null;
  return {
    id: raw.id,
    accountId: str(raw.accountId) ?? fallbackAccountId,
    authorKind: str(raw.authorKind) ?? "agent",
    author: str(raw.author) ?? "",
    anchor,
    class: str(raw.class) ?? "task",
    body: str(raw.body) ?? "",
    confidence: num(raw.confidence),
    status: str(raw.status) ?? "open",
    rationale: str(raw.rationale),
    sourceRef: str(raw.sourceRef),
    createdAt: num(raw.createdAt) ?? 0,
    updatedAt: num(raw.updatedAt) ?? 0,
  };
}
