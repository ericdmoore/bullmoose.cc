import type { Annotation } from "../annotations/types";

// The two chief-of-staff questions, as pure partitions of the open annotations
// (s18 A4). "What am I waiting on?" and "What did I promise?" — the two views
// the devPlan says are the only two, because they are the two a chief of staff
// is FOR. Both are QUERIES over the annotations table; the server has no author
// filter (annotation.ts), so the partition is here, exactly as the approvals
// queue orders client-side because "urgency is a UI concern, not a server one".

/** The condensed glance shows a handful; the rest is a "more →". */
export const HOME_ANNOTATIONS_LIMIT = 5;

export interface AnnotationStack {
  rows: Annotation[];
  total: number;
  more: number;
}

/**
 * "What am I waiting on?" — the waiting-on detector's findings (`author` is the
 * 'waiting-on' producer, s20 T1↔T4). These are the threads where you're blocked
 * on someone else's reply; the detector graduated them into `task` annotations
 * (extract.ts / waitingOn.ts).
 */
export function waitingOn(annotations: readonly Annotation[], limit = HOME_ANNOTATIONS_LIMIT): AnnotationStack {
  return stack(
    annotations.filter((a) => a.status === "open" && a.author === "waiting-on"),
    limit,
  );
}

/**
 * "What did I promise?" — open `commitment` annotations. These come from the
 * extractor once it is turned on (a human may also file one); a promise you
 * made that has not been resolved or dismissed.
 */
export function commitments(annotations: readonly Annotation[], limit = HOME_ANNOTATIONS_LIMIT): AnnotationStack {
  return stack(
    annotations.filter((a) => a.status === "open" && a.class === "commitment"),
    limit,
  );
}

/** Newest first (the freshest claim leads), capped, with the overflow counted. */
function stack(rows: readonly Annotation[], limit: number): AnnotationStack {
  const ordered = [...rows].sort((a, b) => b.createdAt - a.createdAt);
  return {
    rows: ordered.slice(0, limit),
    total: ordered.length,
    more: Math.max(0, ordered.length - limit),
  };
}
