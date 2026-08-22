// The margin's presentation logic (s18 A3) — pure functions between the
// Annotation rows (types.ts) and the medium.com-style gutter that renders
// beside a message (`components/AnnotationMargin.tsx`).
//
// The design rule this file exists to enforce: **the soft register IS the
// epistemics** (s18 devPlan A3). Confidence is never shown as a number on the
// mail surface — it is VOICE. A high-confidence claim is asserted plainly; a
// mid one "sounds like"; a low one hedges. And a NULL rationale renders
// "Why: not stated" — never invented (s20 T4).
//
// The second rule: **anchors bind to the ORIGINAL message**. `marginFor` keys
// strictly on `anchor.objectId === email.id`, so the same promised sentence
// quoted into five replies renders in exactly one margin — the original's.
// (A span-level reference marker on the quoting copies is future work; v1's
// contract is simply "never a duplicate".)

import type { Annotation } from "./types";

/** How a claim speaks. Not a number — a register. */
export type Voice = "assert" | "sounds" | "might";

/**
 * Map a confidence to a voice.
 *
 * | confidence      | voice    | reads as                          |
 * |-----------------|----------|-----------------------------------|
 * | null            | assert   | certain — human-filed, or a deterministic detector (A2 writes NULL because it is *certain, not estimated*) |
 * | ≥ 0.9           | assert   | plain assertion                   |
 * | 0.6 – 0.9       | sounds   | "Sounds like …"                   |
 * | < 0.6           | might    | "Might be nothing, but …"         |
 */
export function voiceFor(confidence: number | null): Voice {
  if (confidence === null) return "assert";
  if (confidence >= 0.9) return "assert";
  if (confidence >= 0.6) return "sounds";
  return "might";
}

/**
 * The claim, spoken in its voice. The body is the agent's stored claim and is
 * never rewritten in the store (annotation.ts refuses body patches); this only
 * *frames* it for reading.
 */
export function speakClaim(body: string, confidence: number | null): string {
  switch (voiceFor(confidence)) {
    case "assert":
      return body;
    case "sounds":
      return `Sounds like ${decap(body)}`;
    case "might":
      return `Might be nothing, but ${decap(body)}`;
  }
}

/**
 * Lower-case the claim's first letter so it reads inside a hedging sentence —
 * except where English keeps the capital: "I"/"I'll"/…, and an acronym-led
 * claim ("IRS wants a reply").
 */
function decap(s: string): string {
  const first = s.split(/\s/, 1)[0] ?? "";
  if (first === "I" || first.startsWith("I'")) return s;
  if (first.length > 1 && first === first.toUpperCase() && /[A-Z]{2}/.test(first)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * The rationale line. NULL renders "not stated" — NEVER an invented reason
 * (s20 T4: "an empty rationale renders as 'Why: not stated' — never invented").
 */
export function whyLine(rationale: string | null): string {
  const why = rationale?.trim();
  return why ? `Why: ${why}` : "Why: not stated";
}

/** Class, displayable. The vocabulary is closed server-side; fall back to the raw string. */
export function classLabel(cls: string): string {
  switch (cls) {
    case "commitment":
      return "Commitment";
    case "decision":
      return "Decision";
    case "task":
      return "Task";
    case "event":
      return "Event";
    case "contact":
      return "Contact";
    default:
      return cls.charAt(0).toUpperCase() + cls.slice(1);
  }
}

/**
 * A closed claim's epitaph. "Dismissed" carries its meaning out loud because a
 * dismissal is a TRAINING LABEL (the s12 rescue→Bayes shape): the human said
 * "not a real one", and the row stays as the record of both the claim and the
 * judgment.
 */
export function statusLabel(status: string): string {
  if (status === "resolved") return "Resolved";
  if (status === "dismissed") return "Dismissed — not a real one";
  return status;
}

/**
 * Group a thread's annotations under the message each one is ANCHORED to.
 *
 * - Only `realm: "Email"` anchors whose objectId is one of the thread's email
 *   ids render — the anchor-to-original guard. An annotation about a message
 *   not in this thread (or about a Watch, a file…) has no margin here.
 * - Deduped by id (defensive: the per-status fetch could overlap on a server
 *   that reports a row twice).
 * - Ordered for reading: OPEN claims first (they carry verbs), then closed,
 *   each oldest-first — the margin reads down the page like the mail does.
 */
export function marginFor(annotations: readonly Annotation[], emailIds: readonly string[]): Map<string, Annotation[]> {
  const wanted = new Set(emailIds);
  const byMessage = new Map<string, Annotation[]>();
  const seen = new Set<string>();
  for (const a of annotations) {
    if (!a.anchor || a.anchor.realm !== "Email" || !wanted.has(a.anchor.objectId)) continue;
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const list = byMessage.get(a.anchor.objectId) ?? [];
    list.push(a);
    byMessage.set(a.anchor.objectId, list);
  }
  for (const list of byMessage.values()) {
    list.sort((a, b) => {
      const aOpen = a.status === "open" ? 0 : 1;
      const bOpen = b.status === "open" ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return a.createdAt - b.createdAt;
    });
  }
  return byMessage;
}

/**
 * The person-panel's rows (s18 A4's rider, scoped v1): the OPEN commitments
 * and tasks anchored to messages in THIS thread — "what is live between us,
 * right here" — newest first. Cross-thread person indexing (everything open
 * involving Bob anywhere) needs a sender join the client cannot do cheaply
 * yet; when the server grows a person filter, this function is the seam.
 */
export function personOpenItems(annotations: readonly Annotation[], emailIds: readonly string[]): Annotation[] {
  const wanted = new Set(emailIds);
  return annotations
    .filter(
      (a) =>
        a.status === "open" &&
        (a.class === "commitment" || a.class === "task") &&
        a.anchor !== null &&
        a.anchor.realm === "Email" &&
        wanted.has(a.anchor.objectId),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
}
