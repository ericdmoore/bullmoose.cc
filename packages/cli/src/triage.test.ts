import { describe, expect, it } from "vitest";
import { collectIds, keywordPatch, labelPatch, replacePatch, wouldEmpty } from "./triage.js";

/**
 * The CLI half of sVOL 019 — the pure pieces of the triage verbs, tested
 * without a server. The live path (the actual Email/set round-trip, partial
 * failure, reconciliation, the pipelines) is the smoke script's job
 * (`smoke/contract.mjs`, run by `contract.test.ts`); it needs real pipes.
 *
 * What is asserted HERE is the one invariant a unit test is the right shape
 * for: **per-verb, single-operation patches**. `.feedback/fromClaude/common/027`
 * — `hasScope` is a FLAT set, not the lattice the docs draw, so `move` does not
 * imply `annotate`. `Email/set` derives the scope it charges from the patch's
 * keys (`requiredScopesForEmailSet`, `email.ts:241-265`): a key under
 * `keywords` charges `annotate`, a key under `mailboxIds` charges `move`. So a
 * verb that bundled both would demand BOTH scopes and a cleanly-scoped token
 * would get a server 403 for the half it did not ask for.
 *
 * These tests pin the shapes so that never regresses: `flag`/`seen` are
 * keywords-only (→ annotate alone), `move`/`label` are mailboxIds-only
 * (→ move alone). The mapping from shape to scope is the server's, proven in
 * `services/jmap/src/methods/emailScopes.test.ts`; this proves the CLI actually
 * emits those shapes.
 */

const touchesKeywords = (patch: Record<string, unknown>) =>
  Object.keys(patch).some((k) => k === "keywords" || k.startsWith("keywords/"));
const touchesMailboxes = (patch: Record<string, unknown>) =>
  Object.keys(patch).some((k) => k === "mailboxIds" || k.startsWith("mailboxIds/"));

describe("keywordPatch — flag/seen build a keywords-only patch (charges annotate)", () => {
  it("adds and removes keywords via JSON-pointer paths", () => {
    expect(keywordPatch(["$flagged"], ["$seen"])).toEqual({
      "keywords/$flagged": true,
      "keywords/$seen": null,
    });
  });

  it("never touches mailboxIds — so a token scoped to `annotate` alone can flag", () => {
    const patch = keywordPatch(["$flagged", "$answered"], ["$seen"]);
    expect(touchesKeywords(patch)).toBe(true);
    expect(touchesMailboxes(patch)).toBe(false);
  });

  it("is empty when there is nothing to change", () => {
    expect(keywordPatch([], [])).toEqual({});
  });

  it("refuses an empty keyword (exit 2), rather than sending `keywords/`", () => {
    expect(() => keywordPatch([""], [])).toThrow();
  });
});

describe("replacePatch — move replaces the whole mailbox set (charges move)", () => {
  it("is a whole-property mailboxIds replacement", () => {
    expect(replacePatch("mb_archive")).toEqual({ mailboxIds: { mb_archive: true } });
  });

  it("never touches keywords — so `move` is charged alone, not bundled", () => {
    const patch = replacePatch("mb_archive");
    expect(touchesMailboxes(patch)).toBe(true);
    expect(touchesKeywords(patch)).toBe(false);
  });
});

describe("labelPatch — label adds/removes per-key, keeping the other mailboxes", () => {
  it("uses per-key paths, NOT a whole-property replace", () => {
    expect(labelPatch(["mb_a"], ["mb_b"])).toEqual({
      "mailboxIds/mb_a": true,
      "mailboxIds/mb_b": null,
    });
  });

  it("is mailboxIds-only, so it charges `move` and never `annotate`", () => {
    const patch = labelPatch(["mb_a"], ["mb_b"]);
    expect(touchesMailboxes(patch)).toBe(true);
    expect(touchesKeywords(patch)).toBe(false);
  });

  it("differs from move: it does not clear the set", () => {
    // move is `{ mailboxIds: {…} }` (clears then sets); label is
    // `{ "mailboxIds/x": true }` (adds to whatever is there). Getting this
    // backwards is the classic mail-CLI bug the unit calls out.
    expect(replacePatch("mb_a")).not.toEqual(labelPatch(["mb_a"], []));
  });
});

describe("wouldEmpty — the client-side guard `label --remove` uses", () => {
  it("is true when the removes empty the set — refuse, naming `move`", () => {
    expect(wouldEmpty(["mb_inbox"], [], ["mb_inbox"])).toBe(true);
  });

  it("is false when another mailbox remains", () => {
    expect(wouldEmpty(["mb_inbox", "mb_work"], [], ["mb_inbox"])).toBe(false);
  });

  it("is false when an --add in the same call compensates", () => {
    expect(wouldEmpty(["mb_inbox"], ["mb_archive"], ["mb_inbox"])).toBe(false);
  });

  it("ignores a remove of a mailbox the message is not in", () => {
    expect(wouldEmpty(["mb_inbox"], [], ["mb_other"])).toBe(false);
  });
});

describe("collectIds — the `| xargs bullmoose archive` shape", () => {
  it("takes ids as positional arguments", () => {
    expect(collectIds(["em_1", "em_2"])).toEqual(["em_1", "em_2"]);
  });

  it("returns an empty list for no arguments (stdin is read by cmdTriage)", () => {
    // With arguments present, stdin is never consulted — explicit beats
    // implicit (arch.md §1.4). The no-args → stdin branch needs a real fd 0 and
    // is exercised by the smoke script's `printf … | xargs` cases.
    expect(collectIds(["em_1"])).toEqual(["em_1"]);
  });
});
