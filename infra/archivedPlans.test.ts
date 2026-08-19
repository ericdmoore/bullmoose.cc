import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The archive's two gates (2026-08-19).
 *
 * `.plans/_archived/` is where a section goes when its work is done. The whole
 * value of that is the closing note: the acceptance ledger, the residues with
 * owners, whether the thing is actually REACHABLE. Without a gate the index
 * rots the same way the landing notes did — one audit found four loose ends
 * that archiving had nearly deleted, two of which were recorded nowhere else.
 *
 * So: a folder may not sit in the archive silently. It must carry a closing
 * note, it must appear in the index, and every residue it declares must name a
 * home. These are cheap, mechanical claims — exactly the kind a human should
 * never be asked to re-verify by hand.
 */

const PLANS = new URL("../.plans/", import.meta.url).pathname;
const ARCHIVE = join(PLANS, "_archived");
const INDEX = join(ARCHIVE, "_index.md");

const archivedDirs = (): string[] =>
  readdirSync(ARCHIVE)
    .filter((n) => !n.startsWith("_") && !n.startsWith("."))
    .filter((n) => statSync(join(ARCHIVE, n)).isDirectory());

describe(".plans/_archived — the archive's own contract", () => {
  const dirs = archivedDirs();

  it("has something archived at all (else these gates are vacuous)", () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  it.each(dirs)("%s carries a closingNotes.md", (dir) => {
    const path = join(ARCHIVE, dir, "closingNotes.md");
    // The message names the template, because the fix is to fill one in — not
    // to touch an empty file into existence.
    expect(
      () => statSync(path),
      `${dir} is archived without closing notes. Copy .plans/_closingNotes.template.md and fill it in — the acceptance ledger and the residue owners are the point of archiving.`,
    ).not.toThrow();
  });

  it.each(dirs)("%s is listed in _index.md", (dir) => {
    const index = readFileSync(INDEX, "utf8");
    expect(
      index.includes(dir),
      `${dir} is in the archive but absent from _index.md — the index is how anyone finds it again.`,
    ).toBe(true);
  });

  it("every closing note declares the front-matter the index is built from", () => {
    for (const dir of dirs) {
      const path = join(ARCHIVE, dir, "closingNotes.md");
      let body: string;
      try {
        body = readFileSync(path, "utf8");
      } catch {
        continue; // the per-dir test above already reports this
      }
      for (const key of ["plan:", "status:", "closed_at:", "closing_pr:", "acceptance:"]) {
        expect(body.slice(0, 600), `${dir}/closingNotes.md is missing front-matter key \`${key}\``).toContain(key);
      }
    }
  });

  it("no residue is left without an owner", () => {
    // A "Carried forward" row whose owner cell is empty, "—", "TBD" or "none"
    // is the exact failure this whole exercise exists to prevent: a loose end
    // that reads as closed because the folder it lived in was archived.
    const offenders: string[] = [];
    for (const dir of dirs) {
      let body: string;
      try {
        body = readFileSync(join(ARCHIVE, dir, "closingNotes.md"), "utf8");
      } catch {
        continue;
      }
      const section = body.split(/^## Carried forward\s*$/m)[1]?.split(/^## /m)[0] ?? "";
      for (const line of section.split("\n")) {
        if (!line.trim().startsWith("|")) continue;
        const cells = line.split("|").map((c) => c.trim());
        // | what | why | owner |  →  ["", what, why, owner, ""]
        if (cells.length < 5) continue;
        const [, what, , owner] = cells;
        if (!what || /^-+$/.test(what) || what.toLowerCase() === "what") continue; // header/rule rows
        // `#TBD-something` slipped through an earlier version of this check: it is
        // non-empty and not literally "TBD", but it is still a placeholder standing
        // where an owner belongs. Substring match, deliberately.
        const homeless = !owner || /^(—|-|none|n\/a|\?+)$/i.test(owner) || /tbd/i.test(owner);
        if (homeless) offenders.push(`${dir}: "${what.slice(0, 60)}"`);
      }
    }
    expect(
      offenders,
      `these residues name no owner — file an issue (label \`residue:sNN\`) or point at a live plan:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
