// Bulk selection over the card list, as pure functions.
//
// ── Why this exists at all ────────────────────────────────────────────────
//
// A real address book is mostly junk. Eric's has 3,557 cards, and the large
// majority are carrier SMS-gateway addresses — one card per gateway per phone
// number, `2142359031@tmomail.net` and 3,000 of its cousins. There is no
// "clean up" verb that can be written for that; the only honest answer is to
// let a person select many and act on them at once.
//
// Which makes this the most dangerous surface in the section, because
// **there is no trash for contacts.** `ContactCard/set destroy` is final
// (`services/jmap/src/methods/contacts.ts`), so an accidental
// select-all-then-delete is unrecoverable. Two rules follow, and both live
// here rather than in the island so they are testable:
//
//  1. **The confirmation states the exact count.** Not "Delete these
//     contacts?" — `Delete 412 contacts?`. The number is the only part of the
//     prompt that distinguishes "the four I picked" from "everything I
//     loaded", and it is precisely the part a generic prompt omits.
//  2. **An outcome is never "done".** A batched write can succeed for 410 ids
//     and fail for 2, and reporting that as success loses the two forever.
//     `describeBatchOutcome` refuses to render a bare success sentence when
//     anything failed, and names the failures.
//
// ── What "select all" means ───────────────────────────────────────────────
//
// The list is paged (`CARD_PAGE_SIZE`, `cards.ts`), so the header checkbox can
// only ever mean *every row currently loaded*. It must not imply "all 3,557
// matches" — that would be a promise the query cannot keep without a full
// scan per page, and a delete built on it would destroy cards the user never
// saw. Every function here takes the VISIBLE ids explicitly for that reason,
// and `describeSelection` says "of N loaded" out loud.

/** The header checkbox's three states. `some` is the indeterminate one. */
export type HeaderCheck = "none" | "some" | "all";

/** One id's membership, flipped. Returns a new Set — never mutates. */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * What the header checkbox shows for the rows on screen.
 *
 * An EMPTY list is `none`, not `all`: `every()` over nothing is vacuously
 * true, which would render a ticked select-all box above no rows and arm a
 * delete for a selection that does not exist.
 */
export function headerCheck(visible: readonly string[], selected: ReadonlySet<string>): HeaderCheck {
  if (visible.length === 0) return "none";
  let hit = 0;
  for (const id of visible) if (selected.has(id)) hit++;
  if (hit === 0) return "none";
  return hit === visible.length ? "all" : "some";
}

/**
 * The header checkbox's click. All-selected → clear the visible ones;
 * anything else (including the indeterminate middle) → select them all.
 *
 * Ids selected but NOT visible are left alone in both directions: paging in
 * more rows and then clicking the header should not silently discard a
 * selection made three pages up.
 */
export function toggleAll(visible: readonly string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (headerCheck(visible, selected) === "all") {
    for (const id of visible) next.delete(id);
    return next;
  }
  for (const id of visible) next.add(id);
  return next;
}

/**
 * Keep only these ids. Used after a PARTIAL failure, so the rows that could
 * not be deleted stay selected and a retry needs no re-picking — and used
 * nowhere else: a selection is otherwise cleared outright when the ids it
 * refers to stop meaning what they meant (see the module header).
 */
export function retainSelected(selected: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const keep = new Set(ids);
  return new Set([...selected].filter((id) => keep.has(id)));
}

/** "412 selected" / "412 of 1,203 selected" — never "of 3,557".
 *
 *  The word "loaded" used to sit before "selected" to make the denominator
 *  explicit. It left the LABEL (2026-08-20) because at realistic widths it
 *  wrapped the bulk bar onto a second line, and a control that reflows as you
 *  select is worse than a terser one. The nuance did not disappear:
 *  `selectionTitle` carries the long form into the bar's `title`, which costs
 *  no layout, and "of N" already reads as a subset. What must NEVER happen is
 *  the denominator becoming the MATCH total — see the select-all note above. */
export function describeSelection(count: number, loaded?: number): string {
  if (count === 0) return "None selected";
  if (loaded === undefined || loaded <= count) return `${count.toLocaleString()} selected`;
  return `${count.toLocaleString()} of ${loaded.toLocaleString()} selected`;
}

/** The long form, for `title` — where the denominator can be spelled out
 *  without costing a line. `total` is the match count when the query knows it,
 *  and is deliberately NOT in the visible label: a denominator of 3,557 next
 *  to a select-all that only ever means "the loaded rows" is the exact
 *  confusion the note above exists to prevent. */
export function selectionTitle(count: number, loaded?: number, total?: number): string {
  if (loaded === undefined || loaded <= count) return `${count.toLocaleString()} selected`;
  const head = `${count.toLocaleString()} of ${loaded.toLocaleString()} loaded rows selected`;
  return typeof total === "number" && total > loaded ? `${head} — ${total.toLocaleString()} match this search` : head;
}

/**
 * The delete prompt. The count is in the first line because that is the line
 * a person actually reads before hitting Enter, and "no undo" is in the
 * second because it is the fact that makes the first one matter.
 */
export function confirmDeleteCards(count: number): string {
  const noun = count === 1 ? "contact" : "contacts";
  return (
    `Delete ${count.toLocaleString()} ${noun}?\n\n` +
    `This cannot be undone — deleted contacts do not go to a trash folder, ` +
    `and a group that names one keeps the dangling reference. Cancel to keep everything.`
  );
}

/** How a bulk verb reads in its outcome sentence. */
export interface BulkVerb {
  /** Past tense, sentence-initial: "Deleted", "Added". */
  done: string;
  /** The failure clause: "could not be deleted", "could not be added". */
  failed: string;
  /** The unit, singular — "contact". */
  noun?: string;
  /**
   * Where they went, if the verb has a destination — `“Family”` renders as
   * "Added 5 contacts to “Family”." A delete has none; an add to a named
   * group has one, and leaving it out makes two adds to two different groups
   * report identically, which is how a toast stops being evidence.
   */
  target?: string;
}

/** How many failures get named before the sentence gives up and counts. */
const NAMED_FAILURES = 3;

/**
 * The sentence a bulk write reports. **Never a bare "done".**
 *
 * The three shapes it can take are the three things that can actually have
 * happened, and each names the numbers on both sides:
 *
 *   everything worked → "Deleted 412 contacts."
 *   some worked       → "Deleted 410 of 412 contacts. 2 could not be
 *                        deleted: Ada Lovelace (…), Grace Hopper (…)."
 *   nothing worked    → "No contacts were deleted. 412 could not be
 *                        deleted: …"
 *
 * `nameOf` turns an id into something a person recognises; without it the id
 * itself is shown, which is worse but still better than a count alone.
 */
export function describeBatchOutcome(
  verb: BulkVerb,
  outcome: { done: readonly string[]; failed: readonly { id: string; message: string }[] },
  nameOf?: (id: string) => string,
): string {
  const noun = verb.noun ?? "contact";
  const ok = outcome.done.length;
  const bad = outcome.failed.length;
  const plural = (n: number) => (n === 1 ? noun : `${noun}s`);
  const to = verb.target === undefined ? "" : ` to ${verb.target}`;

  if (bad === 0) {
    return ok === 0
      ? `Nothing was ${verb.done.toLowerCase()}${to}.`
      : `${verb.done} ${ok.toLocaleString()} ${plural(ok)}${to}.`;
  }

  const head =
    ok === 0
      ? `No ${noun}s were ${verb.done.toLowerCase()}${to}.`
      : `${verb.done} ${ok.toLocaleString()} of ${(ok + bad).toLocaleString()} ${plural(ok + bad)}${to}.`;

  const named = outcome.failed
    .slice(0, NAMED_FAILURES)
    .map((f) => `${nameOf?.(f.id) ?? f.id} (${f.message})`)
    .join("; ");
  const more = bad > NAMED_FAILURES ? `, and ${(bad - NAMED_FAILURES).toLocaleString()} more` : "";

  return `${head} ${bad.toLocaleString()} ${verb.failed}: ${named}${more}.`;
}

/**
 * The verbs this screen bulk-applies. Adding another means adding a `BulkVerb`
 * here and a control in the bar — not a new outcome format.
 *
 * `DELETE_VERB` is the bar's destructive half. The "add to group" verb is
 * built per call because it names its destination — see `addToGroupVerb`
 * (`groups.ts`), which is where membership vocabulary lives.
 *
 * `MOVE_VERB` pairs with `moveCards` (`write.ts`) — a bulk address-book move.
 * Both are kept and tested as the seam for that action; neither is wired to a
 * control today, because Eric's sketch of the bar is `[Delete] [Add to
 * group ▾]` and three controls is one more than the sketch.
 */
export const DELETE_VERB: BulkVerb = { done: "Deleted", failed: "could not be deleted" };
export const MOVE_VERB: BulkVerb = { done: "Moved", failed: "could not be moved" };
