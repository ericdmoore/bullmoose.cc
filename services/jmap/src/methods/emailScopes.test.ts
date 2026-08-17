import { describe, expect, it } from "vitest";
import { requiredScopesForEmailSet } from "./email";

// Regression suite for .feedback/fromCodex/common/003 — Email/set gated
// everything with `draft`.
//
// The lattice is read < annotate < draft < move < send < delete, so a token
// deliberately scoped to compose drafts could flag, move, and permanently
// destroy mail. This asserts the mapping from arguments to required scopes;
// the gate itself is `requireAccountScopes` in common.ts.

describe("requiredScopesForEmailSet", () => {
  it("charges draft for a create", () => {
    expect(requiredScopesForEmailSet({ create: { c1: { subject: "hi" } } })).toEqual(["draft"]);
  });

  it("charges delete for a destroy — NOT draft", () => {
    const scopes = requiredScopesForEmailSet({ destroy: ["e1"] });
    expect(scopes).toEqual(["delete"]);
    expect(scopes).not.toContain("draft");
  });

  it("charges annotate for a keywords-only patch", () => {
    expect(requiredScopesForEmailSet({ update: { e1: { "keywords/$seen": true } } })).toEqual(["annotate"]);
  });

  it("charges move when a patch touches mailboxIds", () => {
    expect(requiredScopesForEmailSet({ update: { e1: { "mailboxIds/mb2": true } } })).toEqual(["move"]);
  });

  it("charges move for a whole-property mailboxIds replacement", () => {
    expect(requiredScopesForEmailSet({ update: { e1: { mailboxIds: { mb2: true } } } })).toEqual(["move"]);
  });

  it("charges both when one call mixes a flag patch and a move patch", () => {
    const scopes = requiredScopesForEmailSet({
      update: { e1: { "keywords/$seen": true }, e2: { "mailboxIds/mb2": true } },
    });
    expect(new Set(scopes)).toEqual(new Set(["annotate", "move"]));
  });

  it("charges every operation a mixed call performs", () => {
    const scopes = requiredScopesForEmailSet({
      create: { c1: {} },
      update: { e1: { "mailboxIds/mb2": true } },
      destroy: ["e2"],
    });
    expect(new Set(scopes)).toEqual(new Set(["draft", "move", "delete"]));
  });

  it("charges BOTH when one patch bundles a move and a flag", () => {
    // Regression: this used to charge only `move`, via a ternary. Because
    // hasScope is a flat set (not the ordered lattice the docs draw), `move`
    // does not imply `annotate` — so a move-scoped token could flip keywords
    // for free by bundling them into a move patch. Found by sVOL 014.
    const scopes = requiredScopesForEmailSet({
      update: { e1: { "mailboxIds/mb2": true, "keywords/$seen": true } },
    });
    expect(new Set(scopes)).toEqual(new Set(["move", "annotate"]));
  });

  it("charges annotate for an empty patch — fail closed", () => {
    expect(requiredScopesForEmailSet({ update: { e1: {} } })).toEqual(["annotate"]);
  });

  it("asks for nothing when nothing is requested", () => {
    // requireAccountScopes still verifies account membership, so this cannot
    // be used to probe for accounts with no scope at all.
    expect(requiredScopesForEmailSet({})).toEqual([]);
    expect(requiredScopesForEmailSet({ create: {}, destroy: [] })).toEqual([]);
  });

  it("does not double-charge a scope across many patches", () => {
    const scopes = requiredScopesForEmailSet({
      update: { a: { "keywords/$seen": true }, b: { "keywords/$flagged": true } },
    });
    expect(scopes).toEqual(["annotate"]);
  });

  it("matches what the CLI actually sends — create only", () => {
    // packages/cli/src/main.ts:454 and agent.ts:196 both use `create` only,
    // so no CLI path needs move/delete. This is the no-regression case.
    expect(requiredScopesForEmailSet({ create: { draft1: { subject: "x" } } })).toEqual(["draft"]);
  });
});
