import { describe, expect, it } from "vitest";
import {
  MAX_NAME,
  isValidName,
  nameProblem,
  nameTaken,
  normalizeName,
  safeUploadName,
  takenNames,
  uniqueName,
} from "./names";
import type { FileNode } from "./types";

const dir = (id: string, name: string): FileNode => ({
  id,
  parentId: null,
  name,
  nodeType: "directory",
  blobId: null,
  size: null,
  type: null,
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  accessed: "2026-01-01T00:00:00.000Z",
  changed: "2026-01-01T00:00:00.000Z",
  executable: false,
  isSubscribed: true,
  myRights: {
    mayRead: true,
    mayAddChildren: true,
    mayRename: true,
    mayDelete: true,
    mayModifyContent: true,
    mayShare: true,
  },
  shareWith: null,
  role: null,
});

describe("nameProblem — the server's own test, plus two documented extras", () => {
  it("accepts an ordinary name", () => {
    expect(nameProblem("Invoices")).toBeNull();
    expect(isValidName("Invoices 2026 — final.pdf")).toBe(true);
  });

  it("refuses an empty name, as the server does", () => {
    expect(nameProblem("")).toBe("A name is required.");
  });

  it("refuses a whitespace-only name — the extra the server does NOT enforce", () => {
    // filenode.ts checks `length === 0` only, so "   " creates a folder that
    // renders as a blank row. Refusing it here is deliberate strictness.
    expect(nameProblem("   ")).toBe("A name is required.");
    expect(nameProblem("\t\n")).toBe("A name is required.");
  });

  it("refuses “/”, which is the one character a name can never carry", () => {
    expect(nameProblem("a/b")).toMatch(/cannot contain/);
    expect(nameProblem("/")).toMatch(/cannot contain/);
  });

  it("refuses “.” and “..” — the second documented extra", () => {
    expect(nameProblem(".")).toMatch(/“\.” and “\.\.”/);
    expect(nameProblem("..")).toMatch(/“\.” and “\.\.”/);
    // …but not a name that merely starts with a dot: a dotfile is a real file.
    expect(nameProblem(".gitignore")).toBeNull();
  });

  it("enforces the same 255-character ceiling the server does", () => {
    expect(MAX_NAME).toBe(255);
    expect(nameProblem("x".repeat(255))).toBeNull();
    expect(nameProblem("x".repeat(256))).toMatch(/at most 255/);
  });

  it("validates the TRIMMED name, which is also the one that gets sent", () => {
    expect(nameProblem("  Invoices  ")).toBeNull();
    expect(normalizeName("  Invoices  ")).toBe("Invoices");
    // A name that is only too long because of padding is accepted, and the
    // padding is what goes away.
    expect(nameProblem(` ${"x".repeat(255)} `)).toBeNull();
  });
});

describe("nameTaken", () => {
  const siblings = [dir("a", "Projects"), dir("b", "Scratch")];

  it("spots a collision", () => {
    expect(nameTaken(siblings, "Projects")).toBe(true);
    expect(nameTaken(siblings, "Archive")).toBe(false);
  });

  it("is case-SENSITIVE, matching the server's default comparison", () => {
    // `compareCaseInsensitively` is opt-in per call (filenode.ts:196) and this
    // section never passes it. Predicting case-insensitively would refuse
    // names the server would have accepted.
    expect(nameTaken(siblings, "projects")).toBe(false);
  });

  it("compares the trimmed name", () => {
    expect(nameTaken(siblings, "  Projects ")).toBe(true);
  });

  it("ignores the node being renamed", () => {
    expect(nameTaken(siblings, "Projects", "a")).toBe(false);
  });
});

describe("uniqueName — the sidestep's rule, so both paths agree", () => {
  it("leaves a free name alone", () => {
    expect(uniqueName("report.pdf", new Set())).toBe("report.pdf");
  });

  it("suffixes BEFORE the extension so the file still opens", () => {
    expect(uniqueName("report.pdf", new Set(["report.pdf"]))).toBe("report (2).pdf");
    expect(uniqueName("report.pdf", new Set(["report.pdf", "report (2).pdf"]))).toBe("report (3).pdf");
  });

  it("treats a leading dot as a dotfile, not an extension", () => {
    expect(uniqueName(".zshrc", new Set([".zshrc"]))).toBe(".zshrc (2)");
  });

  it("does not treat a long tail as an extension", () => {
    expect(uniqueName("v1.2026-final-cut", new Set(["v1.2026-final-cut"]))).toBe(
      "v1.2026-final-cut (2)",
    );
  });

  it("builds its candidate set from a directory's children", () => {
    const taken = takenNames([dir("a", "Projects")]);
    expect(uniqueName("Projects", taken)).toBe("Projects (2)");
  });
});

describe("safeUploadName", () => {
  it("passes an ordinary filename through untouched", () => {
    expect(safeUploadName("Q3 board deck.pdf")).toBe("Q3 board deck.pdf");
  });

  it("replaces separators and control characters rather than sending them", () => {
    expect(safeUploadName("a/b\\c.txt")).toBe("a_b_c.txt");
    // A real control character, escaped rather than typed: a raw NUL in a
    // source file is a trap for every tool that reads it.
    expect(safeUploadName("bad\u0000name.txt")).toBe("bad_name.txt");
    // …but spaces are perfectly good in a filename and must survive.
    expect(safeUploadName("keeps spaces.txt")).toBe("keeps spaces.txt");
  });

  it("gives an unnamed or path-shaped file a stable fallback", () => {
    expect(safeUploadName("", "blob-abc123def")).toBe("upload-blob-abc");
    expect(safeUploadName("..", "blob-xyz")).toBe("upload-blob-xyz");
  });

  it("clamps to the 255-character ceiling", () => {
    expect(safeUploadName("y".repeat(400)).length).toBe(255);
  });
});
