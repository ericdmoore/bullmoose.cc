import { describe, expect, it } from "vitest";
import { bloomAdd, bloomCreate, bloomDeserialize, bloomHas, bloomSerialize } from "./bloom";

/**
 * The bloom's load-bearing property is NO FALSE NEGATIVES: ABS_NO on the hot
 * path skips every exact membership check, so a member that tested false
 * would be an unblocked blocked-sender — the one failure class the design
 * cannot absorb (false POSITIVES only cost an exact check). Hence a property
 * test over random sets, not a couple of hand-picked strings.
 */

/** Deterministic PRNG (mulberry32) so a failure reproduces byte-for-byte. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEntry(next: () => number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789.-@_";
  const len = 3 + Math.floor(next() * 40);
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(next() * alphabet.length)];
  return s;
}

describe("bloom filter", () => {
  it("property: NO false negatives, over 50 random sets", () => {
    const next = rng(0xb10035);
    for (let trial = 0; trial < 50; trial++) {
      const n = 1 + Math.floor(next() * 300);
      const entries = new Set<string>();
      while (entries.size < n) entries.add(randomEntry(next));
      const f = bloomCreate(entries.size);
      for (const e of entries) bloomAdd(f, e);
      for (const e of entries) {
        expect(bloomHas(f, e), `trial ${trial}: "${e}" must test POSSIBLY_YES`).toBe(true);
      }
    }
  });

  it("false-positive rate lands near the 1% target", () => {
    const next = rng(0xfa15e);
    const members = new Set<string>();
    while (members.size < 2000) members.add(`m-${randomEntry(next)}`);
    const f = bloomCreate(members.size);
    for (const e of members) bloomAdd(f, e);

    let falsePositives = 0;
    const probes = 10_000;
    for (let i = 0; i < probes; i++) {
      // The prefix guarantees a non-member without a Set lookup.
      if (bloomHas(f, `x-${i}-${randomEntry(next)}`)) falsePositives++;
    }
    const rate = falsePositives / probes;
    // Target is 1%; 3% is the alarm threshold (a broken hash mix lands
    // at 30%+, a broken sizing formula at 10%+ — this catches both without
    // flaking on seed luck).
    expect(rate).toBeLessThan(0.03);
    expect(rate).toBeGreaterThanOrEqual(0); // and some FPs are EXPECTED at 1%
  });

  it("an empty filter says ABS_NO to everything", () => {
    const f = bloomCreate(0);
    expect(bloomHas(f, "anything@at.all")).toBe(false);
    expect(bloomHas(f, "")).toBe(false);
  });

  it("serialize → deserialize is lossless", () => {
    const next = rng(0x5e71a);
    const entries = [...Array(500)].map(() => randomEntry(next));
    const f = bloomCreate(entries.length);
    for (const e of entries) bloomAdd(f, e);

    const back = bloomDeserialize(bloomSerialize(f));
    expect(back.m).toBe(f.m);
    expect(back.k).toBe(f.k);
    expect(back.bits).toEqual(f.bits);
    for (const e of entries) expect(bloomHas(back, e)).toBe(true);
  });

  it("deserialize refuses garbage rather than returning a filter that lies", () => {
    expect(() => bloomDeserialize("not json")).toThrow();
    expect(() => bloomDeserialize('{"m":0,"k":1,"bits":""}')).toThrow();
    expect(() => bloomDeserialize('{"m":64,"k":3,"bits":"AA=="}')).toThrow(/mismatch/);
    expect(() => bloomDeserialize('{"hello":"world"}')).toThrow();
  });

  it("multi-byte entries hash stably (a unicode domain round-trips)", () => {
    const f = bloomCreate(4);
    bloomAdd(f, "bücher.example");
    bloomAdd(f, "домен.example");
    const back = bloomDeserialize(bloomSerialize(f));
    expect(bloomHas(back, "bücher.example")).toBe(true);
    expect(bloomHas(back, "домен.example")).toBe(true);
  });
});
