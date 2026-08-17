import { describe, expect, it } from "vitest";
import { renderTree, resolveMailbox } from "./mailbox.js";

/**
 * The CLI half of sVOL 004 — what makes the unit human-verifiable rather
 * than test-verifiable. `Mailbox/set` alone is a JMAP method with no
 * surface; `bullmoose mailbox create Receipts` is a folder someone can see.
 *
 * These cover the two pure pieces a human actually collides with: typing a
 * folder by NAME rather than by `mb_9f3c…`, and reading the tree back.
 */

const box = (
  id: string,
  name: string,
  role: string | null = null,
  parentId: string | null = null,
) => ({
  id,
  name,
  role,
  parentId,
  sortOrder: 0,
});

const BOXES = [
  box("mb_inbox", "Inbox", "inbox"),
  box("mb_archive", "Archive", "archive"),
  box("mb_r", "Receipts"),
  box("mb_r2", "2026", null, "mb_r"),
];

describe("resolveMailbox", () => {
  it("takes an id verbatim", () => {
    expect(resolveMailbox(BOXES, "mb_r").name).toBe("Receipts");
  });

  it("takes a role, so `mailbox rm trash` means what it looks like", () => {
    expect(resolveMailbox(BOXES, "inbox").id).toBe("mb_inbox");
    expect(resolveMailbox(BOXES, "ARCHIVE").id).toBe("mb_archive");
  });

  it("takes a name, case-insensitively — nobody types mb_9f3c…", () => {
    expect(resolveMailbox(BOXES, "receipts").id).toBe("mb_r");
    expect(resolveMailbox(BOXES, "2026").id).toBe("mb_r2");
  });

  it("prefers an exact id over a name that collides with it", () => {
    const odd = [...BOXES, box("mb_weird", "mb_r")];
    expect(resolveMailbox(odd, "mb_r").id).toBe("mb_r");
  });
});

describe("renderTree", () => {
  it("shows the hierarchy — the whole point of parentId existing", () => {
    expect(renderTree(BOXES).split("\n")).toEqual([
      "  Archive  [archive]",
      "  Inbox  [inbox]",
      "  Receipts",
      "    2026",
    ]);
  });

  it("indents children under their parent", () => {
    const nested = [box("mb_r", "Receipts"), box("mb_r2", "2026", null, "mb_r")];
    expect(renderTree(nested).split("\n")).toEqual(["  Receipts", "    2026"]);
  });
});
