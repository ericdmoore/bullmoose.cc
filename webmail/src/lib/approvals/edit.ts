// Edit — the load-bearing verb (s07 devPlan §T4).
//
// Approve/Decline is a gate; Edit is collaboration: the human amends the
// proposal and approves the amended thing. The data contract that makes it
// worth having is retention: the human's version goes to `editedPayload` and
// the agent's `payload` is NEVER overwritten (actionProposal.ts:222-228,
// data-plane.sql `edited_payload_json`), so the diff between the two — "here
// is exactly what right looked like" — survives as the highest-signal feedback
// the system collects. This module owns both halves: building an
// `editedPayload` that is honestly an edit, and computing the diff back out.
//
// The subtle rule, tested because it is easy to lose: an edit session that
// changes NOTHING must send NO `editedPayload`. "Approved clean" and "approved
// after edit" are different outcomes with different meanings for the agent
// (s07 §T4's three-outcome table), and opening the editor must not be able to
// move a row from one column to the other.

import type { ActionProposal } from "./types";

// ── what is editable ──────────────────────────────────────────────────────

export type EditorForm =
  /** A reply-shaped payload: the two fields a human actually rewrites. */
  | { shape: "reply"; subject: string; text: string }
  /** Anything else structured: the payload as pretty JSON, edited whole. */
  | { shape: "json"; json: string };

/**
 * Open an editor over the payload — or refuse. `grant-request` is not
 * editable here: the ask is approve/deny as asked (arch.md §1); narrowing a
 * requested grant is provision's vocabulary (s04), and a UI that silently
 * rewrote a permission request would be granting something nobody requested.
 */
export function editorFor(p: Pick<ActionProposal, "kind" | "payload">): EditorForm | null {
  if (p.kind === "grant-request") return null;
  if (p.kind === "reply-draft" || p.kind === "start-thread") {
    return {
      shape: "reply",
      subject: typeof p.payload.subject === "string" ? p.payload.subject : "",
      text: typeof p.payload.text === "string" ? p.payload.text : "",
    };
  }
  return { shape: "json", json: JSON.stringify(p.payload, null, 2) };
}

export interface EditOutcome {
  /**
   * The full edited payload to send, or `undefined` when the edit is a no-op
   * — in which case the caller approves WITHOUT `editedPayload` and the row
   * stays "approved clean".
   */
  editedPayload?: Record<string, unknown>;
  /** A reason the edit cannot be applied (bad JSON). Nothing is sent. */
  problem?: string;
}

/**
 * Merge the human's fields back over the agent's payload. Reply edits touch
 * only `subject` and `text` — `to`, `blobId`, `inReplyTo` and the rest ride
 * through untouched, so the send-shaped fields the server validates
 * (actionProposal.ts:429-436) survive the edit.
 */
export function applyEdit(payload: Record<string, unknown>, form: EditorForm): EditOutcome {
  if (form.shape === "reply") {
    const edited = { ...payload, subject: form.subject, text: form.text };
    return sameJson(edited, payload) ? {} : { editedPayload: edited };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(form.json);
  } catch {
    return { problem: "Edited payload is not valid JSON — nothing was sent." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    // Mirrors the server's own check: `editedPayload must be an object`
    // (actionProposal.ts:226-228). Refusing here keeps the refusal local
    // instead of a round trip away.
    return { problem: "Edited payload must be a JSON object — nothing was sent." };
  }
  const edited = parsed as Record<string, unknown>;
  return sameJson(edited, payload) ? {} : { editedPayload: edited };
}

// ── the diff back out ─────────────────────────────────────────────────────

/** One payload key that differs between the agent's version and the human's. */
export interface FieldDiff {
  key: string;
  /** Absent = the key was added by the edit. */
  before?: unknown;
  /** Absent = the key was removed by the edit. */
  after?: unknown;
}

/**
 * Key-level diff of `payload` vs `editedPayload`, in the original's key order
 * with additions last. This is what the row renders under "edited before
 * approval" — the retained original on the left, the human's word on the
 * right.
 */
export function payloadDiff(
  original: Record<string, unknown>,
  edited: Record<string, unknown>,
): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const key of Object.keys(original)) {
    if (!(key in edited)) out.push({ key, before: original[key] });
    else if (!sameJson(original[key], edited[key])) {
      out.push({ key, before: original[key], after: edited[key] });
    }
  }
  for (const key of Object.keys(edited)) {
    if (!(key in original)) out.push({ key, after: edited[key] });
  }
  return out;
}

export type DiffOp = "same" | "del" | "add";

export interface DiffLine {
  op: DiffOp;
  text: string;
}

/**
 * Line diff for the one field where a key-level "before/after" is unreadable:
 * a rewritten reply body. Plain LCS over lines — payloads here are a few
 * hundred bytes of prose, so no Myers, no tokenization, nothing clever enough
 * to be wrong.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // lcs[i][j] = LCS length of a[i..] vs b[j..]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: "del", text: a[i]! });
      i++;
    } else {
      out.push({ op: "add", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ op: "del", text: a[i++]! });
  while (j < b.length) out.push({ op: "add", text: b[j++]! });
  return out;
}

/** Structural equality via stable JSON — key order must not count as an edit. */
function sameJson(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : 1));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stable(val)}`).join(",")}}`;
}
