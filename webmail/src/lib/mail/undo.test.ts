import { describe, expect, it } from "vitest";
import { restorePatch, restorePatches } from "./undo";
import { archivePatch, trashPatch } from "./triage";

// s25 T6 — the "undoable" half of undoable-or-confirmed. These drive the
// inverse against the REAL patch builders (triage.ts), not against a
// hand-written stand-in, so a change to how archiving files mail shows up here
// as a broken undo rather than as a silent one.

describe("restorePatch", () => {
  it("reverses an archive exactly: back to the Inbox, out of Archive", () => {
    const before = { inbox: true };
    const applied = archivePatch({ mailboxIds: before }, "inbox", "archive");
    expect(restorePatch(before, applied)).toEqual({
      "mailboxIds/inbox": true,
      "mailboxIds/archive": null,
    });
  });

  it("reverses a trash move, restoring EVERY mailbox it was filed in", () => {
    const before = { inbox: true, project: true };
    const applied = trashPatch({ mailboxIds: before }, "trash");
    expect(restorePatch(before, applied)).toEqual({
      "mailboxIds/inbox": true,
      "mailboxIds/project": true,
      "mailboxIds/trash": null,
    });
  });

  it("keeps a mailbox the message was already in — no needless removal", () => {
    // Archived out of the Inbox while ALREADY in Archive: the undo puts the
    // inbox back and must not evict Archive, which was never this action's
    // doing.
    const before = { inbox: true, archive: true };
    const applied = archivePatch({ mailboxIds: before }, "inbox", "archive");
    const patch = restorePatch(before, applied);
    expect(patch["mailboxIds/inbox"]).toBe(true);
    expect(patch["mailboxIds/archive"]).toBe(true);
    expect(patch).not.toHaveProperty("mailboxIds/archive", null);
  });

  it("never produces a homeless message — the restore half is always non-empty", () => {
    const before = { inbox: true };
    const patch = restorePatch(before, trashPatch({ mailboxIds: before }, "trash"));
    expect(Object.values(patch).some((v) => v === true)).toBe(true);
  });

  it("ignores keyword changes — an undo reverses a FILING, not a reading", () => {
    expect(restorePatch({ inbox: true }, { "keywords/$seen": true })).toEqual({
      "mailboxIds/inbox": true,
    });
  });

  it("drops mailboxes the message was explicitly NOT in", () => {
    expect(restorePatch({ inbox: true, sent: false }, {})).toEqual({ "mailboxIds/inbox": true });
  });
});

describe("restorePatches", () => {
  it("inverts a whole thread in one batch", () => {
    const before = { e1: { inbox: true }, e2: { inbox: true } };
    const applied = {
      e1: archivePatch({ mailboxIds: before.e1 }, "inbox", "archive"),
      e2: archivePatch({ mailboxIds: before.e2 }, "inbox", "archive"),
    };
    expect(Object.keys(restorePatches(before, applied))).toEqual(["e1", "e2"]);
  });

  it("drops ids whose inverse would be empty, so the caller can skip the round trip", () => {
    expect(restorePatches({ e1: {} }, { e1: {} })).toEqual({});
  });

  it("an id with no recorded patch still gets its filing back", () => {
    expect(restorePatches({ e1: { inbox: true } }, {})).toEqual({ e1: { "mailboxIds/inbox": true } });
  });
});
