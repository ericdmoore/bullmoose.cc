// A plain Bloom filter, dependency-free (s12 1-A).
//
// Fronts the union of ALL blocked tiers on the delivery hot path: ABS_NO
// (`bloomHas` false) lets legit mail skip every exact membership check for
// free, because Bloom filters have no false negatives — an entry that was
// added ALWAYS tests true. POSSIBLY_YES falls through to the exact checks
// against the owning tier, so a false positive costs one D1 lookup, never a
// wrong verdict. The filter is a DERIVED index (jobs-and-facets.md §6 /
// s12 readme): each tier stays canonical for its entries, and the whole
// filter is rebuilt (never patched) when any source changes.
//
// Sizing: m = -n·ln(p)/ln(2)² bits, k = m/n·ln(2) hashes — the textbook
// optimum. At the default p = 0.01 that is ~9.6 bits and 7 hashes per entry;
// 5k deny-listed domains ≈ 6 KB, comfortably a KV value and isolate-cacheable.
//
// Hashing: double hashing over two independent 32-bit FNV-1a passes,
// g_i = h1 + i·h2 (mod m). Kirsch–Mitzenmacher shows this preserves the
// false-positive bound of k independent hashes; `h2 |= 1` keeps the stride
// from degenerating to a fixed point. FNV-1a is not cryptographic and does
// not need to be — an attacker who grinds a colliding domain buys one extra
// exact check, not a verdict.

export interface BloomFilter {
  /** Size in bits. */
  m: number;
  /** Number of hash probes per entry. */
  k: number;
  bits: Uint8Array;
}

const LN2 = Math.log(2);

/** An empty filter sized for `expectedN` entries at `fpRate` false positives. */
export function bloomCreate(expectedN: number, fpRate = 0.01): BloomFilter {
  const n = Math.max(1, expectedN);
  const m = Math.max(64, Math.ceil((-n * Math.log(fpRate)) / (LN2 * LN2)));
  const k = Math.max(1, Math.round((m / n) * LN2));
  return { m, k, bits: new Uint8Array(Math.ceil(m / 8)) };
}

/** 32-bit FNV-1a over the UTF-8 code units of `s`, from a given basis. */
function fnv1a(s: string, basis: number): number {
  let h = basis >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Split non-ASCII code units into bytes so multi-byte text hashes stably.
    h ^= c & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    if (c > 0xff) {
      h ^= c >>> 8;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

function probes(f: BloomFilter, entry: string): number[] {
  const h1 = fnv1a(entry, 0x811c9dc5);
  // `| 1` (odd stride — never a fixed point) yields a SIGNED 32-bit value;
  // `>>> 0` brings it back to unsigned. Without that, a stride ≥ 2^31 walks
  // the probe sequence NEGATIVE and every later probe indexes off the end of
  // the bit array — a guaranteed false negative, the one error class this
  // structure exists to rule out. (Found by the no-false-negatives property
  // test; do not "simplify" this back.)
  const h2 = (fnv1a(entry, 0x9dc5811c) | 1) >>> 0;
  const out: number[] = [];
  let g = h1 % f.m;
  const step = h2 % f.m;
  for (let i = 0; i < f.k; i++) {
    out.push(g);
    g = (g + step) % f.m; // incremental: stays in [0, 2m), never overflows
  }
  return out;
}

export function bloomAdd(f: BloomFilter, entry: string): void {
  for (const bit of probes(f, entry)) {
    f.bits[bit >> 3]! |= 1 << (bit & 7);
  }
}

/** false = ABS_NO (definitely never added); true = POSSIBLY_YES. */
export function bloomHas(f: BloomFilter, entry: string): boolean {
  for (const bit of probes(f, entry)) {
    if ((f.bits[bit >> 3]! & (1 << (bit & 7))) === 0) return false;
  }
  return true;
}

/** JSON string, safe for a KV value. */
export function bloomSerialize(f: BloomFilter): string {
  let bin = "";
  for (let i = 0; i < f.bits.length; i += 0x8000) {
    bin += String.fromCharCode(...f.bits.subarray(i, i + 0x8000));
  }
  return JSON.stringify({ m: f.m, k: f.k, bits: btoa(bin) });
}

/** Inverse of `bloomSerialize`. Throws on garbage — callers treat that as "no bloom". */
export function bloomDeserialize(serialized: string): BloomFilter {
  const raw = JSON.parse(serialized) as { m: number; k: number; bits: string };
  if (
    typeof raw?.m !== "number" ||
    typeof raw?.k !== "number" ||
    typeof raw?.bits !== "string" ||
    raw.m < 1 ||
    raw.k < 1
  ) {
    throw new Error("not a serialized bloom filter");
  }
  const bin = atob(raw.bits);
  const bits = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bits[i] = bin.charCodeAt(i);
  if (bits.length !== Math.ceil(raw.m / 8)) throw new Error("bloom bit length mismatch");
  return { m: raw.m, k: raw.k, bits };
}
