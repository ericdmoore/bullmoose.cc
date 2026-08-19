// s25 T6 — putting a swiped message back.
//
// The plan's rule for gesture triage is undoable OR confirmed, and this half
// buys the "undoable". Both swipe verbs are MOVES (`triage.ts`: "Trash is a
// MOVE, not a destroy"), so the inverse is knowable exactly: remember which
// mailboxes the message was in before the patch, and put it back in them.
//
// Deliberately NOT a general undo stack. One action, one toast, one Undo —
// the recourse a gesture owes you, not a journal. Anything older is recovered
// the way it always was: from Archive or Trash, which still hold the message.

import type { EmailPatch } from "./triage";

const MAILBOX = "mailboxIds/";

/**
 * The patch that reverses `applied` for a message that was in `before`.
 *
 * Two halves, and both are needed:
 *   - every mailbox the message was in comes back (`true`);
 *   - every mailbox the patch ADDED that it was not in already goes away
 *     (`null`).
 *
 * The server refuses a message that would end up in no mailbox at all
 * (`applyEmailPatch`), so the restores and the removals must travel in one
 * patch — they do, and the restores are non-empty whenever `before` was.
 *
 * Keyword changes in `applied` are ignored on purpose: this reverses a FILING,
 * and silently un-reading a message someone read in the meantime would be a
 * different, unasked-for edit.
 */
export function restorePatch(before: Readonly<Record<string, boolean>>, applied: EmailPatch): EmailPatch {
  const patch: EmailPatch = {};
  for (const [id, present] of Object.entries(before)) {
    if (present) patch[`${MAILBOX}${id}`] = true;
  }
  for (const [key, value] of Object.entries(applied)) {
    if (!key.startsWith(MAILBOX) || value !== true) continue;
    const id = key.slice(MAILBOX.length);
    if (before[id] !== true) patch[key] = null;
  }
  return patch;
}

/** The same, for a batch: `before` and `applied` keyed by email id. Ids whose
 *  inverse would be empty are dropped, so the caller can test the result for
 *  emptiness and skip the round trip. */
export function restorePatches(
  before: Readonly<Record<string, Record<string, boolean>>>,
  applied: Readonly<Record<string, EmailPatch>>,
): Record<string, EmailPatch> {
  const out: Record<string, EmailPatch> = {};
  for (const [id, mailboxes] of Object.entries(before)) {
    const patch = restorePatch(mailboxes, applied[id] ?? {});
    if (Object.keys(patch).length > 0) out[id] = patch;
  }
  return out;
}
