import { describe, expect, it } from "vitest";
import { matchesQuery } from "./useRealmSearch";

describe("matchesQuery — the house match for realm filters", () => {
  it("an empty query matches everything (a bar at rest hides nothing)", () => {
    expect(matchesQuery("", "anything")).toBe(true);
    expect(matchesQuery("   ", null)).toBe(true);
  });

  it("is case-insensitive SUBSTRING, not whole-word — 'invo' finds 'invoice'", () => {
    // Mail's search is whole-word because an FTS index backs it; a
    // client-side list filter that refused prefixes would break the promise
    // a filter box makes as you type.
    expect(matchesQuery("invo", "Invoice #4")).toBe(true);
    expect(matchesQuery("ACME", "acme corp")).toBe(true);
  });

  it("searches every field it is given, and tolerates missing ones", () => {
    expect(matchesQuery("bouncer", null, undefined, "bouncer@bullmoose.cc")).toBe(true);
    expect(matchesQuery("nope", "a", "b")).toBe(false);
  });
});
