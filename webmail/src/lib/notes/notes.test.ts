import { describe, expect, it } from "vitest";
import {
  NOT_ANNOTATIONS_NOTE,
  NO_FEDERATION_NOTE,
  SHARED_ROW_REASON,
  filterNotes,
  isDirty,
  isWritable,
  noteSnippet,
  noteTitle,
  notesCollections,
  notesGate,
  orderNotes,
} from "./notes";
import type { Note } from "./types";

// s18 N1 — the Notes realm's pure rules. Two of these tests are about WORDS
// rather than behaviour, on purpose: the Note/Annotation distinction and the
// "nothing federates" limit are only true if the screen says them, and a claim
// nobody checks is a comment.

const note = (over: Partial<Note> = {}): Note => ({
  id: "nt_1",
  accountId: "a_eric",
  owner: "eric@bullmoose.cc",
  title: "Board order",
  body: "Sergio quoted $750.",
  revision: 1,
  lastWriter: "eric@bullmoose.cc",
  lastWriterBinding: null,
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});

describe("notesGate — the plain-client floor", () => {
  it("refuses a server that does not advertise the agent capability", () => {
    const gate = notesGate({ capabilities: { "urn:ietf:params:jmap:core": {} } });
    expect(gate.state).toBe("no-capability");
    // Note methods RIDE the agent URN (s18: no new plane, no new auth model),
    // so the sentence has to explain that rather than blame the user.
    expect(gate.reason).toMatch(/agent capability/);
    expect(gate.reason).toMatch(/Mail, contacts and calendar are unaffected/);
  });

  it("opens when it does", () => {
    expect(notesGate({ capabilities: { "urn:bullmoose:params:jmap:agent": {} } }).state).toBe("open");
  });

  it("is closed before a session arrives", () => {
    expect(notesGate(undefined).state).toBe("no-capability");
  });
});

describe("the copy the realm must not lose", () => {
  it("says a note is not a comment on someone else's message", () => {
    // The whole s18 split in one sentence, where a person will read it.
    expect(NOT_ANNOTATIONS_NOTE).toMatch(/annotation/i);
    expect(NOT_ANNOTATIONS_NOTE).toMatch(/margin/);
    expect(NOT_ANNOTATIONS_NOTE).toMatch(/confirm or dismiss/);
  });

  it("says nothing federates, and that an @address does nothing", () => {
    expect(NO_FEDERATION_NOTE).toMatch(/do not travel/);
    expect(NO_FEDERATION_NOTE).toMatch(/@address does nothing/);
    expect(NO_FEDERATION_NOTE).toMatch(/not built/);
  });
});

describe("orderNotes", () => {
  it("puts the most recently edited first, with a total order on ties", () => {
    const a = note({ id: "nt_a", updatedAt: 5 });
    const b = note({ id: "nt_b", updatedAt: 9 });
    const c = note({ id: "nt_c", updatedAt: 5 });
    // Ties break by id DESCENDING — the server's own `ORDER BY updated_at
    // DESC, id DESC`, so a locally sorted list and a server-sorted one agree.
    expect(orderNotes([a, b, c]).map((n) => n.id)).toEqual(["nt_b", "nt_c", "nt_a"]);
    // Same inputs, different arrival order — same answer. A list that shuffles
    // between renders is worse than one in the wrong order.
    expect(orderNotes([c, a, b]).map((n) => n.id)).toEqual(["nt_b", "nt_c", "nt_a"]);
  });

  it("does not mutate its input", () => {
    const list = [note({ id: "nt_a", updatedAt: 1 }), note({ id: "nt_b", updatedAt: 2 })];
    orderNotes(list);
    expect(list.map((n) => n.id)).toEqual(["nt_a", "nt_b"]);
  });
});

describe("noteTitle / noteSnippet", () => {
  it("uses the title when there is one", () => {
    expect(noteTitle(note())).toBe("Board order");
  });

  it("derives a name from the first non-empty body line, never inventing one", () => {
    expect(noteTitle({ title: "  ", body: "\n\nAsk about the hinges.\nBrass, 3in." })).toBe("Ask about the hinges.");
  });

  it("falls back to 'Untitled note' only when there are no words at all", () => {
    expect(noteTitle({ title: "", body: "   \n  " })).toBe("Untitled note");
  });

  it("does not repeat the line the title was derived from", () => {
    const untitled = { title: "", body: "Ask about the hinges.\nBrass, 3in, five per door." };
    expect(noteTitle(untitled)).toBe("Ask about the hinges.");
    expect(noteSnippet(untitled)).toBe("Brass, 3in, five per door.");
    // With an explicit title, the first body line IS the snippet.
    expect(noteSnippet({ title: "Hinges", body: "Brass, 3in." })).toBe("Brass, 3in.");
  });

  it("clips long text with an ellipsis rather than overflowing the row", () => {
    const long = noteSnippet({ title: "t", body: "x".repeat(400) }, 20);
    expect(long).toHaveLength(20);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("notesCollections", () => {
  it("counts the notes and states the federation limit as a disabled row", () => {
    const groups = notesCollections([note(), note({ id: "nt_2" })]);
    const items = groups[0]!.items;
    expect(items[0]).toMatchObject({ id: "all", label: "All notes", count: 2 });
    // Never a dead row and never a hidden one: the thing that does not exist
    // is visible, greyed, WITH its reason (the planned-row idiom).
    expect(items[1]).toMatchObject({ id: "shared", disabled: true, reason: SHARED_ROW_REASON });
    expect(SHARED_ROW_REASON).toMatch(/not built/);
  });
});

describe("filterNotes", () => {
  it("matches title and body, case-insensitively", () => {
    const list = [
      note({ id: "nt_a", title: "Hinges", body: "brass" }),
      note({ id: "nt_b", title: "Load calc", body: "the HINGE spec" }),
      note({ id: "nt_c", title: "Groceries", body: "milk" }),
    ];
    expect(filterNotes(list, "hinge").map((n) => n.id)).toEqual(["nt_a", "nt_b"]);
  });

  it("an empty or blank query is not a filter", () => {
    const list = [note(), note({ id: "nt_2" })];
    expect(filterNotes(list, "")).toHaveLength(2);
    expect(filterNotes(list, "   ")).toHaveLength(2);
  });
});

describe("isWritable / isDirty — what the Save button is allowed to be", () => {
  it("refuses an empty draft before the round trip does", () => {
    expect(isWritable({ title: "", body: "" })).toBe(false);
    expect(isWritable({ title: "  ", body: "\n" })).toBe(false);
    expect(isWritable({ title: "", body: "something" })).toBe(true);
  });

  it("a save that changes nothing is not a save — revision must not move", () => {
    const n = note({ title: "T", body: "B" });
    expect(isDirty({ title: "T", body: "B" }, n)).toBe(false);
    expect(isDirty({ title: "T", body: "B!" }, n)).toBe(true);
  });

  it("a NEW note is dirty exactly when it has content", () => {
    expect(isDirty({ title: "", body: "" }, undefined)).toBe(false);
    expect(isDirty({ title: "x", body: "" }, undefined)).toBe(true);
  });
});
