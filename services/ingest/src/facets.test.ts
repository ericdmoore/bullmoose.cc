import { describe, expect, it, vi } from "vitest";
import {
  CHARS_PER_TOKEN,
  composePrivacy,
  isPrivacyClass,
  mechanicalRequires,
  privacyFloorOf,
  stampInvocationFacets,
  type PrivacyClass,
} from "./facets";

/**
 * The floor rule (s11 T6) — the one hard invariant in this wave. A mis-stamped
 * privacy facet is the dangerous failure: `open` stamped on what should be
 * `pinned` routes private mail to a paid cloud model, so the table below holds
 * `composePrivacy` to "a stamp may raise, never lower below any implicated
 * floor" in every direction, including the NULL (DefaultCase) corners.
 */

describe("composePrivacy — the floor rule, exhaustively", () => {
  it.each<[PrivacyClass | null, Array<PrivacyClass | null | undefined>, PrivacyClass | null]>([
    // stamp BELOW a floor → the floor wins (the leak this rule exists to stop)
    ["open", ["internal"], "internal"],
    ["open", ["pinned"], "pinned"],
    ["internal", ["pinned"], "pinned"],
    // stamp ABOVE the floor → the stamp wins (a stamp may raise)
    ["pinned", ["open"], "pinned"],
    ["pinned", ["internal"], "pinned"],
    ["internal", ["open"], "internal"],
    // stamp EQUAL to the floor → unchanged
    ["internal", ["internal"], "internal"],
    // no floor → the stamp, verbatim
    ["open", [], "open"],
    ["pinned", [], "pinned"],
    ["open", [null], "open"],
    ["internal", [undefined], "internal"],
    // no stamp → the floor alone classifies the binding's work
    [null, ["internal"], "internal"],
    [null, ["pinned"], "pinned"],
    // no stamp, no floor → NULL: no facet at all — the DefaultCase
    [null, [], null],
    [null, [null, undefined], null],
    // several implicated floors (T7 Jobs): the MAX floor binds
    ["open", ["internal", "pinned"], "pinned"],
    [null, ["open", "internal"], "internal"],
    ["pinned", ["open", "internal"], "pinned"],
  ])("stamp %j against floors %j → %j", (stamp, floors, expected) => {
    expect(composePrivacy(stamp, floors)).toBe(expected);
  });

  it("is monotone: composing can never yield a class below any floor", () => {
    const order: Record<PrivacyClass, number> = { open: 0, internal: 1, pinned: 2 };
    const classes: Array<PrivacyClass | null> = [null, "open", "internal", "pinned"];
    for (const stamp of classes) {
      for (const floor of classes) {
        const out = composePrivacy(stamp, [floor]);
        if (floor !== null) {
          expect(out, `stamp=${stamp} floor=${floor}`).not.toBeNull();
          expect(order[out as PrivacyClass]).toBeGreaterThanOrEqual(order[floor]);
        }
      }
    }
  });
});

describe("privacyFloorOf — binding config, junk-tolerated", () => {
  it.each<[string, PrivacyClass | null]>([
    ['{"privacyFloor":"internal"}', "internal"],
    ['{"privacyFloor":"pinned"}', "pinned"],
    ['{"privacyFloor":"open"}', "open"],
    ["{}", null],
    ['{"privacyFloor":"PINNED"}', null], // enum is exact — a typo cannot LOWER, only fail to raise
    ['{"privacyFloor":7}', null], // a score is not a class (jobs-and-facets §2)
    ['{"privacyFloor":null}', null],
    ["not json at all", null],
    ["", null],
  ])("%s → %j", (config, expected) => {
    expect(privacyFloorOf(config)).toBe(expected);
  });

  it("isPrivacyClass guards the enum exactly", () => {
    expect(isPrivacyClass("open")).toBe(true);
    expect(isPrivacyClass("pinned")).toBe(true);
    expect(isPrivacyClass("secret")).toBe(false);
    expect(isPrivacyClass(2)).toBe(false);
  });
});

describe("mechanicalRequires — capabilities derived from the work itself", () => {
  it("derives contextTokens from body length at ~4 chars/token", () => {
    expect(mechanicalRequires({ bodyTextChars: 8000, attachmentTypes: [] })).toEqual({
      contextTokens: 8000 / CHARS_PER_TOKEN,
    });
    // rounds UP — overestimating the requirement is the safe direction
    expect(mechanicalRequires({ bodyTextChars: 10, attachmentTypes: [] })).toEqual({
      contextTokens: 3,
    });
  });

  it("derives vision from any image/* attachment, case-insensitively", () => {
    expect(
      mechanicalRequires({ bodyTextChars: 4, attachmentTypes: ["application/pdf", "IMAGE/PNG"] }),
    ).toEqual({ contextTokens: 1, vision: true });
  });

  it("a PDF alone requires no vision", () => {
    expect(mechanicalRequires({ bodyTextChars: 4, attachmentTypes: ["application/pdf"] })).toEqual({
      contextTokens: 1,
    });
  });

  it("returns NULL — no facet, not an empty one — when there is nothing to require", () => {
    expect(mechanicalRequires({ bodyTextChars: 0, attachmentTypes: [] })).toBeNull();
  });
});

describe("stampInvocationFacets — the tolerant follow-up UPDATE", () => {
  const dbSpy = () => {
    const run = vi.fn().mockResolvedValue({});
    const bind = vi.fn().mockReturnValue({ run });
    const prepare = vi.fn().mockReturnValue({ bind });
    return { db: { prepare } as unknown as D1Database, prepare, bind };
  };

  it("writes NOTHING for an all-NULL stamp — the DefaultCase enqueue is byte-identical", async () => {
    const { db, prepare } = dbSpy();
    await stampInvocationFacets(db, "a_1", "inv_1", {
      dueAt: null,
      privacy: null,
      requires: null,
      senderClass: null,
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("stamps the mechanical columns + sender_class and serializes requires_json", async () => {
    const { db, bind } = dbSpy();
    await stampInvocationFacets(db, "a_1", "inv_1", {
      dueAt: 1_755_000_000_000,
      privacy: "internal",
      requires: { contextTokens: 250, vision: true },
      senderClass: "known",
    });
    expect(bind).toHaveBeenCalledWith(
      1_755_000_000_000,
      "internal",
      '{"contextTokens":250,"vision":true}',
      "known",
      "a_1",
      "inv_1",
    );
  });

  it("swallows a missing-column failure — an unmigrated shard delivers unfaceted, it does not bounce mail", async () => {
    // This tolerance is exactly why invocation-due-at / invocation-facet-columns
    // are NOT deploy blockers (infra/migrations.mjs).
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      prepare: () => {
        throw new Error("no such column: due_at");
      },
    } as unknown as D1Database;
    await expect(
      stampInvocationFacets(db, "a_1", "inv_1", {
        dueAt: 5,
        privacy: null,
        requires: null,
        senderClass: null,
      }),
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledOnce();
    err.mockRestore();
  });
});
