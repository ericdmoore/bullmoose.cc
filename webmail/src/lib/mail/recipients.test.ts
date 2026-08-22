import { describe, expect, it } from "vitest";
import { foldRecipients, NAMES_SHOWN, summarizeRecipients } from "./recipients";
import type { EmailAddress } from "./types";

const addr = (email: string, name: string | null = null): EmailAddress => ({ name, email });

/** The message that started this: a forwarded Cc of parents, mostly nameless. */
function tournamentCc(): EmailAddress[] {
  const parents = Array.from({ length: 27 }, (_, i) => addr(`parent${i}@aol.test`));
  return [addr("dana@rec.test", "Coach Dana"), ...parents, addr("jdwade7@aol.test"), addr("tm@rec.test", "Team Mgr")];
}

describe("foldRecipients", () => {
  it("prints a short line whole", () => {
    const fold = foldRecipients([addr("a@x.test", "Ada"), addr("g@x.test", "Grace")]);
    expect(fold.folded).toBe(false);
    expect(fold.visible).toBe("Ada, Grace");
    expect(fold.hidden).toBe(0);
    expect(fold.overflow).toBe("");
  });

  it("does not fold to hide a single person", () => {
    // "…and 1 other" is as wide as the name it replaced, and costs a click.
    const fold = foldRecipients(["a", "b", "c", "d"].map((c) => addr(`${c}@x.test`, c.toUpperCase())));
    expect(fold.folded).toBe(false);
    expect(fold.visible).toBe("A, B, C, D");
  });

  it("folds the 30-recipient Cc down to a line", () => {
    const fold = foldRecipients(tournamentCc());
    expect(fold.all).toHaveLength(30);
    expect(fold.hidden).toBe(27);
    expect(fold.overflow).toBe("and 27 others");
    expect(fold.visible.split(", ")).toHaveLength(NAMES_SHOWN);
  });

  it("spends its slots on people the header can name, in header order", () => {
    // The wall is a Cc of strangers' addresses; naming the first three of
    // THOSE says nothing, while one "Coach Dana" says what the mail is.
    // Both named people win slots over the 28 addresses between them — and
    // the line is then put back in header order, so it reads as a subset of
    // the header rather than a ranking of it.
    const fold = foldRecipients(tournamentCc());
    expect(fold.visible).toBe("Coach Dana, parent0@aol.test, Team Mgr");
  });

  it("names bare addresses when there is nobody named to prefer", () => {
    const fold = foldRecipients(Array.from({ length: 6 }, (_, i) => addr(`p${i}@aol.test`)));
    expect(fold.visible).toBe("p0@aol.test, p1@aol.test, p2@aol.test");
    expect(fold.overflow).toBe("and 3 others");
  });

  it("never invents a name out of a local part", () => {
    const fold = foldRecipients([addr("jdwade7@aol.test")]);
    expect(fold.all[0]?.label).toBe("jdwade7@aol.test");
    expect(fold.all[0]?.full).toBe("jdwade7@aol.test");
    expect(fold.all[0]?.named).toBe(false);
  });

  it("does not print the address twice when the name slot repeats it", () => {
    // Forwarding clients fill the name with the address constantly.
    const fold = foldRecipients([addr("jdwade7@aol.test", "JDWade7@aol.test")]);
    expect(fold.all[0]?.full).toBe("jdwade7@aol.test");
    expect(fold.all[0]?.named).toBe(false);
  });

  it("spells a real name out in full for the expanded list", () => {
    const fold = foldRecipients([addr("ada@x.test", "Ada Lovelace")]);
    expect(fold.all[0]?.full).toBe("Ada Lovelace <ada@x.test>");
  });

  it("counts a repeated address once, however it is cased", () => {
    // A forwarded chain re-lists people; a wrong count is the one thing the
    // reader cannot check by looking.
    const fold = foldRecipients([addr("Sam@x.test", "Sam"), addr("sam@x.test", "Sam"), addr("b@x.test", "B")]);
    expect(fold.all).toHaveLength(2);
  });

  it("keeps the named copy of an address that also arrives bare", () => {
    const fold = foldRecipients([addr("sam@x.test"), addr("sam@x.test", "Sam Vimes")]);
    expect(fold.all).toHaveLength(1);
    expect(fold.all[0]?.label).toBe("Sam Vimes");
  });

  it("drops an entry with neither name nor address rather than counting it", () => {
    const fold = foldRecipients([addr("a@x.test", "Ada"), addr("  ", "  ")]);
    expect(fold.all).toHaveLength(1);
  });

  it("survives an empty line", () => {
    expect(foldRecipients([])).toEqual({ all: [], folded: false, visible: "", hidden: 0, overflow: "" });
  });

  it("says `others` even at the smallest possible fold", () => {
    // MIN_HIDDEN is why: a fold that hides one person never gets built, so
    // there is no singular case to spell.
    const fold = foldRecipients([addr("a@x.test"), addr("b@x.test"), addr("c@x.test")], 1);
    expect(fold.overflow).toBe("and 2 others");
  });

  it("keeps at least one name when asked for none", () => {
    const fold = foldRecipients([addr("a@x.test", "Ada"), addr("b@x.test"), addr("c@x.test")], 0);
    expect(fold.visible).toBe("Ada");
    expect(fold.hidden).toBe(2);
  });
});

describe("summarizeRecipients", () => {
  it("is the folded line as one string", () => {
    expect(summarizeRecipients(tournamentCc())).toBe("Coach Dana, parent0@aol.test, Team Mgr and 27 others");
  });

  it("is just the names when nothing is hidden", () => {
    expect(summarizeRecipients([addr("a@x.test", "Ada"), addr("g@x.test", "Grace")])).toBe("Ada, Grace");
  });

  it("is empty when there is nobody, so the caller can say so in its own words", () => {
    expect(summarizeRecipients([])).toBe("");
  });
});
