// Notes presentation rules (s18 N1) — how the realm gates, orders, groups and
// WORDS itself. Pure and tested; the island stays markup-only, the same split
// `lib/activity/feed.ts` and `lib/approvals/rows.ts` follow.
//
// The copy in this file is load-bearing, not decoration. Two things have to
// survive contact with the next reader:
//
//   1. A NOTE IS NOT AN ANNOTATION. s18 resolved these as two entities (Eric,
//      2026-08-17): a Note is a document you author; an Annotation is a claim
//      about your mail that you adjudicate, and it renders in the margin of
//      the message it is about. The UI says so out loud, because a "Notes"
//      screen that quietly listed the agent's commitments would re-merge them
//      in the user's head even though the tables never merged.
//   2. NOTHING FEDERATES YET. The plan's arc is "a private document that
//      federates" and v1 built only the private half. The realm states that as
//      a visible, disabled row rather than as an absence a user has to infer.

import { hasAgentCapability } from "../jmap/capabilities";
import type { Session } from "../jmap/types";
import type { CollectionGroup } from "../shell/collections";
import type { Note } from "./types";

// ── the gate ──────────────────────────────────────────────────────────────

export type NotesGateState = "open" | "no-capability";

export interface NotesGate {
  state: NotesGateState;
  reason: string;
}

/**
 * The plain-client floor (arch.md §8.6). `Note/*` rides the existing
 * `urn:bullmoose:params:jmap:agent` vendor capability — s18 deliberately mints
 * no new URN and no new auth plane (readme §1) — so a server that does not
 * advertise it has no Note methods, and this realm says so instead of
 * throwing an unknownMethod at the user.
 */
export function notesGate(session: Pick<Session, "capabilities"> | undefined): NotesGate {
  if (!session) return { state: "no-capability", reason: "no session yet" };
  if (!hasAgentCapability(session)) {
    return {
      state: "no-capability",
      reason:
        "This server does not advertise the bullmoose agent capability, and Note methods ride it, " +
        "so there is nowhere to keep notes here. Mail, contacts and calendar are unaffected.",
    };
  }
  return { state: "open", reason: "agent capability advertised" };
}

// ── the copy that keeps the two entities apart ────────────────────────────

/** The realm's one-line subtitle. */
export const NOTES_SUB = "Your own documents. You write them; nobody else can read them.";

/**
 * Said on the screen, once, near the top. The distinction is invisible in the
 * data (two tables, two method families) and would be invisible in the UI too
 * unless something says it.
 */
export const NOT_ANNOTATIONS_NOTE =
  "A note is yours to write and edit. It is not a comment on someone else's message — " +
  "what an agent notices about your mail is an annotation, and those live in the margin of " +
  "the message they are about, where you confirm or dismiss them.";

/**
 * The federation seam, stated as a limit rather than a roadmap. s18 N2/N3 are
 * unbuilt: no `@mention` is parsed, no mail is sent, nothing is shared.
 */
export const NO_FEDERATION_NOTE =
  "Notes do not travel yet. Typing an @address does nothing — mentions, sharing and the " +
  "mention mail that would carry a note to someone else are not built.";

/** Rendered under the disabled "Shared with me" collection row. */
export const SHARED_ROW_REASON = "not built — no note reaches another person yet";

/** What `Note/query`'s text filter actually is, said where it is used: a LIKE
 *  scan over title and body, not an index. `/search` learned the hard way that
 *  an unstated scan reads as a broken index. */
export const SEARCH_SCOPE_NOTE = "Filtering scans every note's title and body — there is no index behind it.";

// ── ordering, grouping, wording ───────────────────────────────────────────

/** Most recently edited first, ties broken by id so the order is total (two
 *  notes saved in the same millisecond must not shuffle between renders). */
export function orderNotes(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** A note with no title still needs a name in a list. Derived from the first
 *  line of the body — never invented, never "Untitled" when there are words. */
export function noteTitle(note: Pick<Note, "title" | "body">): string {
  const explicit = note.title.trim();
  if (explicit) return explicit;
  const firstLine = note.body.split("\n").find((l) => l.trim() !== "");
  const derived = firstLine?.trim() ?? "";
  return derived ? clip(derived, 60) : "Untitled note";
}

/** The list row's second line. Skips the line the title was derived from, so
 *  an untitled note does not read the same words twice. */
export function noteSnippet(note: Pick<Note, "title" | "body">, max = 120): string {
  const lines = note.body.split("\n").filter((l) => l.trim() !== "");
  const rest = note.title.trim() ? lines : lines.slice(1);
  return clip(rest.join(" ").replace(/\s+/g, " ").trim(), max);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The CollectionColumn's groups. v1 has exactly one real collection — there
 * are no folders, tags or shares to subset by — plus one DISABLED row that
 * states the federation limit in the place a user would look for it. The
 * planned-row idiom (`lib/app/sections.ts`, extended to collection items in
 * s25 T2): never a dead row, never a hidden one.
 */
export function notesCollections(notes: readonly Note[]): CollectionGroup[] {
  return [
    {
      id: "notes",
      label: "Notes",
      items: [
        { id: "all", label: "All notes", count: notes.length },
        { id: "shared", label: "Shared with me", disabled: true, reason: SHARED_ROW_REASON },
      ],
    },
  ];
}

/** The realm's filter (the s24 T5 contextual bar, and the in-page box): a
 *  case-insensitive substring over title and body — the same predicate the
 *  server's `Note/query {filter: {text}}` applies, so a locally filtered list
 *  and a server-filtered one agree. */
export function filterNotes(notes: readonly Note[], text: string): Note[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [...notes];
  return notes.filter((n) => n.title.toLowerCase().includes(needle) || n.body.toLowerCase().includes(needle));
}

/**
 * Is this draft worth a write? The server refuses a note with neither a title
 * nor a body ("a note needs a title or a body"); saying so before the round
 * trip means the button can be disabled rather than the refusal explained.
 */
export function isWritable(draft: { title: string; body: string }): boolean {
  return draft.title.trim() !== "" || draft.body.trim() !== "";
}

/** Has this draft actually diverged from the note it was opened from? A save
 *  that changes nothing would still bump `revision`, and a version number that
 *  moves without a change is a lie to whoever reads it next (including, one
 *  day, a far end that was shown revision 2). */
export function isDirty(draft: { title: string; body: string }, note: Pick<Note, "title" | "body"> | undefined) {
  if (!note) return isWritable(draft);
  return draft.title !== note.title || draft.body !== note.body;
}
