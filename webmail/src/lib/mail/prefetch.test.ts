import { describe, expect, it } from "vitest";
import {
  mayPrefetch,
  PREFETCH_BODY_BYTES,
  PREFETCH_MAX,
  readNetworkHints,
  selectPrefetch,
  SETTLE_MS,
} from "./prefetch";

describe("mayPrefetch — spending someone else's bandwidth on a guess", () => {
  it("1. an ordinary connection is fair game", () => {
    expect(mayPrefetch({ effectiveType: "4g", visible: true })).toBe(true);
  });

  it("2. saveData is the reader asking us to stop, and it wins", () => {
    // Asked through an interface they already know. There is deliberately no
    // setting of our own — asking twice is a star by another name.
    expect(mayPrefetch({ saveData: true, effectiveType: "4g", visible: true })).toBe(false);
  });

  it("3. a 2g link is not worth speculating on", () => {
    expect(mayPrefetch({ effectiveType: "2g", visible: true })).toBe(false);
    expect(mayPrefetch({ effectiveType: "slow-2g", visible: true })).toBe(false);
    expect(mayPrefetch({ effectiveType: "3g", visible: true })).toBe(true);
  });

  it("4. a backgrounded tab is not being read", () => {
    expect(mayPrefetch({ effectiveType: "4g", visible: false })).toBe(false);
  });

  it("5. silence means an ordinary connection, not a slow one", () => {
    // Most browsers report no `connection` at all. Refusing on silence would
    // switch the feature off for the majority to protect a minority who have
    // a way to say so — and who do say so, via saveData.
    expect(mayPrefetch({})).toBe(true);
  });
});

describe("selectPrefetch — a bounded, decaying net", () => {
  it("10. skips what is already cached", () => {
    expect(selectPrefetch(["a", "b", "c"], new Set(["b"]))).toEqual(["a", "c"]);
  });

  it("11. decays to nothing on a second pass", () => {
    // The whole net costs zero requests once a list has been read through,
    // which is what keeps this from being a tax on every scroll.
    expect(selectPrefetch(["a", "b"], new Set(["a", "b"]))).toEqual([]);
  });

  it("12. is capped — 'everything visible' during a flick is thirty rows", () => {
    const many = Array.from({ length: 30 }, (_, i) => `id${i}`);
    expect(selectPrefetch(many, new Set())).toHaveLength(PREFETCH_MAX);
  });

  it("13. keeps viewport order — the top is the likeliest next open", () => {
    expect(selectPrefetch(["top", "mid", "low"], new Set())).toEqual(["top", "mid", "low"]);
  });

  it("14. never asks for the same id twice in one batch", () => {
    expect(selectPrefetch(["a", "a", "b"], new Set())).toEqual(["a", "b"]);
  });
});

describe("readNetworkHints", () => {
  it("20. reads what the browser offers", () => {
    const hints = readNetworkHints(
      { connection: { saveData: true, effectiveType: "3g" } },
      { visibilityState: "visible" },
    );
    expect(hints).toEqual({ saveData: true, effectiveType: "3g", visible: true });
  });

  it("21. omits what it does not, rather than inventing a default", () => {
    // An absent key and `false` mean different things to mayPrefetch: absent
    // is "unknown, assume ordinary", false is "the reader said no".
    expect(readNetworkHints({}, {})).toEqual({});
  });

  it("22. survives a browser with neither navigator nor document", () => {
    expect(() => readNetworkHints(undefined, undefined)).not.toThrow();
  });
});

describe("the budgets are the design", () => {
  it("30. the body cap is small enough that a wrong guess is cheap", () => {
    // Speculating on a 2MB newsletter must cost kilobytes, not megabytes —
    // that bound is what makes a wide net defensible on a phone.
    expect(PREFETCH_BODY_BYTES).toBeLessThanOrEqual(8192);
    expect(PREFETCH_BODY_BYTES).toBeGreaterThan(1024);
  });

  it("31. settling is long enough to mean 'stopped', short enough to be useful", () => {
    expect(SETTLE_MS).toBeGreaterThanOrEqual(150);
    expect(SETTLE_MS).toBeLessThanOrEqual(500);
  });
});
