import { describe, expect, it } from "vitest";
import { moneyCaveat, moneyLabel, sumMoney, totalCost } from "./money";

// The whole file is one rule, asserted from several directions: `cost_micros`
// NULL means "not recorded" and 0 means "known and genuinely free", and an
// aggregate may never turn the first into the second.

describe("totalCost — a NULL cannot reach the sum", () => {
  it("sums only what was recorded and COUNTS what was not", () => {
    const t = totalCost([1_000, null, 2_000, null]);
    expect(t.micros).toBe(3_000);
    expect(t.recorded).toBe(2);
    expect(t.unrecorded).toBe(2);
  });

  it("counts 0 as recorded — a free Workers AI call is an answer, not an absence", () => {
    const t = totalCost([0, 0, 5_000]);
    expect(t.recorded).toBe(3);
    expect(t.free).toBe(2);
    expect(t.unrecorded).toBe(0);
    expect(t.micros).toBe(5_000);
  });

  it("treats `undefined` as not-recorded — a pre-s26 server omits the field", () => {
    // Same absence by a different route. Coercing it to 0 would report a
    // deploy-skew gap as a month of free inference.
    const t = totalCost([undefined, 4_000]);
    expect(t.unrecorded).toBe(1);
    expect(t.micros).toBe(4_000);
  });

  it("rejects a non-finite cost rather than poisoning the total with NaN", () => {
    const t = totalCost([Number.NaN, 1_000]);
    expect(t.micros).toBe(1_000);
    expect(t.unrecorded).toBe(1);
  });

  it("an empty column prices nothing at all", () => {
    expect(totalCost([])).toEqual({ micros: 0, recorded: 0, unrecorded: 0, free: 0 });
  });
});

describe("sumMoney", () => {
  it("folds without re-deriving — the unrecorded count survives the fold", () => {
    const a = totalCost([1_000, null]);
    const b = totalCost([0, null, null]);
    expect(sumMoney([a, b])).toEqual({ micros: 1_000, recorded: 2, unrecorded: 3, free: 1 });
  });

  it("folds an empty list to nothing", () => {
    expect(sumMoney([])).toEqual({ micros: 0, recorded: 0, unrecorded: 0, free: 0 });
  });
});

describe("moneyLabel — the sin this page exists not to commit", () => {
  it("NEVER renders $0.00 for a pile that was simply not priced", () => {
    const label = moneyLabel(totalCost([null, null, null]));
    expect(label).toBe("cost not recorded");
    expect(label).not.toContain("$");
  });

  it("says 'free' — in words — when every recorded cost is a genuine zero", () => {
    expect(moneyLabel(totalCost([0, 0]))).toBe("free");
  });

  it("distinguishes 'nothing to price' from 'not recorded'", () => {
    // No runs at all is not the same fact as runs whose cost went unstamped.
    expect(moneyLabel(totalCost([]))).toBe("nothing to price");
  });

  it("renders money when there is money", () => {
    expect(moneyLabel(totalCost([1_500_000, 500_000]))).toBe("$2.00");
  });

  it("keeps a sub-cent total legible as micro-dollars rather than rounding to $0.00", () => {
    expect(moneyLabel(totalCost([1_200]))).toContain("µ$");
  });

  it("a mix of priced and unpriced still shows the priced figure — the caveat carries the rest", () => {
    expect(moneyLabel(totalCost([2_000_000, null]))).toBe("$2.00");
  });
});

describe("moneyCaveat — the fine print that keeps the figure honest", () => {
  it("names the excluded rows explicitly", () => {
    const c = moneyCaveat(totalCost([1_000, null, null]));
    expect(c).toContain("2 not recorded");
    expect(c).toContain("excluded from the total");
  });

  it("reports how many priced runs were free", () => {
    expect(moneyCaveat(totalCost([0, 0, 9_000]))).toContain("3 priced (2 free)");
  });

  it("is null when there is nothing to qualify", () => {
    expect(moneyCaveat(totalCost([]))).toBeNull();
  });
});
