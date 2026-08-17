import { describe, expect, it } from "vitest";
import {
  NO_AUTHORITY,
  describeDenial,
  foldChain,
  intersectAuthority,
  mayUse,
  parseEnvelope,
  type Use,
} from "./useAuthority.js";
import type { NodeAuthority } from "./attenuation.js";

/**
 * s17 — USE-TIME AUTHORITY, the other half of the invariant.
 *
 * `attenuation.test.ts` is the adversary's test suite for the WRITE path. This
 * is the adversary's test suite for the READ path, and the adversary is
 * different: there, a planner asks for more than it holds; here, a row already
 * SAYS more than it should — because it was written by something that skipped
 * the harness, because the ceiling above it was narrowed afterwards, or because
 * it is simply corrupt.
 *
 * The property under test, stated once:
 *
 *   effective(node) = binding ∩ env(root) ∩ … ∩ env(node), and every hop can
 *   only narrow it. No envelope, however generous, widens the fold; no
 *   unreadable envelope leaves it permissive.
 */

const A = (over: Partial<NodeAuthority> = {}): NodeAuthority => ({
  tools: ["files.read", "email.draft"],
  credentials: ["aws-mcp"],
  budgetMicros: 1_000_000,
  ...over,
});

/** An envelope, as the harness stores it: JSON of a complete NodeAuthority. */
const env = (a: Partial<NodeAuthority>): string =>
  JSON.stringify({ tools: null, credentials: null, budgetMicros: null, ...a });

const UNSET: NodeAuthority = { tools: null, credentials: null, budgetMicros: null };

const denied = (a: NodeAuthority, use: Use): string | null => {
  const r = mayUse(a, use);
  return r.ok ? null : r.denial.axis;
};

// ---------------------------------------------------------------------------

describe("intersection is the NARROWER of the two — in both directions", () => {
  it("tools: the common subset, whichever side is narrower", () => {
    const wide = A({ tools: ["a", "b", "c"] });
    const narrow = A({ tools: ["b"] });
    expect(intersectAuthority(wide, narrow).tools).toEqual(["b"]);
    // The SAME answer with the arguments swapped. A gate that is narrower only
    // when the ceiling happens to be on the left is not an intersection.
    expect(intersectAuthority(narrow, wide).tools).toEqual(["b"]);
  });

  it("credentials: the common subset, whichever side is narrower", () => {
    const wide = A({ credentials: ["x", "y"] });
    const narrow = A({ credentials: ["y"] });
    expect(intersectAuthority(wide, narrow).credentials).toEqual(["y"]);
    expect(intersectAuthority(narrow, wide).credentials).toEqual(["y"]);
  });

  it("budget: the MINIMUM, whichever side is smaller", () => {
    expect(intersectAuthority(A({ budgetMicros: 10 }), A({ budgetMicros: 4 })).budgetMicros).toBe(4);
    expect(intersectAuthority(A({ budgetMicros: 4 }), A({ budgetMicros: 10 })).budgetMicros).toBe(4);
  });

  it("disjoint sets intersect to EMPTY — never to a union", () => {
    const r = intersectAuthority(A({ tools: ["a"] }), A({ tools: ["b"] }));
    expect(r.tools).toEqual([]);
  });

  it("`null` is the IDENTITY (an unset ceiling), never a widening", () => {
    // Unset ∩ [a] is [a] — the declared side survives untouched...
    expect(intersectAuthority(UNSET, A({ tools: ["a"] })).tools).toEqual(["a"]);
    expect(intersectAuthority(A({ tools: ["a"] }), UNSET).tools).toEqual(["a"]);
    // ...and it does NOT become null (which would mean "unrestricted").
    expect(intersectAuthority(UNSET, A({ tools: ["a"] })).tools).not.toBeNull();
    expect(intersectAuthority(UNSET, UNSET)).toEqual(UNSET);
  });

  it("intersecting with NO_AUTHORITY yields nothing, from any starting point", () => {
    expect(intersectAuthority(A(), NO_AUTHORITY)).toEqual({
      tools: [],
      credentials: [],
      budgetMicros: 0,
    });
  });

  it("is commutative and associative — so the fold order cannot change the answer", () => {
    const x = A({ tools: ["a", "b", "c"], budgetMicros: 9 });
    const y = A({ tools: ["b", "c"], budgetMicros: 5 });
    const z = A({ tools: ["c", "d"], budgetMicros: 7 });
    const left = intersectAuthority(intersectAuthority(x, y), z);
    const right = intersectAuthority(x, intersectAuthority(y, z));
    expect(left).toEqual(right);
    expect(left.tools).toEqual(["c"]);
    expect(left.budgetMicros).toBe(5);
  });
});

describe("parseEnvelope is STRICT — anything it cannot vouch for is unreadable", () => {
  it("reads a well-formed envelope exactly as written", () => {
    expect(parseEnvelope(env({ tools: ["a"], credentials: ["c"], budgetMicros: 7 }))).toEqual({
      tools: ["a"],
      credentials: ["c"],
      budgetMicros: 7,
    });
  });

  it("null and empty string are UNREADABLE (absent is not unrestricted)", () => {
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope("")).toBeNull();
    expect(parseEnvelope(undefined)).toBeNull();
  });

  it("a JSON PARSE FAILURE is unreadable — never a default", () => {
    expect(parseEnvelope("{not json")).toBeNull();
    expect(parseEnvelope('{"tools": ["a"], ')).toBeNull();
  });

  it("a non-object envelope is unreadable", () => {
    expect(parseEnvelope("null")).toBeNull();
    expect(parseEnvelope("42")).toBeNull();
    expect(parseEnvelope('"tools"')).toBeNull();
    expect(parseEnvelope('["a"]')).toBeNull();
  });

  it("a MISSING key is unreadable — every envelope this system writes has all three", () => {
    expect(parseEnvelope(JSON.stringify({ tools: ["a"], credentials: [] }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ credentials: [], budgetMicros: 1 }))).toBeNull();
    expect(parseEnvelope("{}")).toBeNull();
  });

  it("a WRONG-TYPED axis is unreadable, and is NOT coerced to `unrestricted`", () => {
    // The regression this strictness exists for: the old reader turned a
    // non-array `tools` into `null`, i.e. a ceiling that stopped nothing.
    expect(parseEnvelope(env({ tools: "everything" as never }))).toBeNull();
    expect(parseEnvelope(env({ tools: [1, 2] as never }))).toBeNull();
    expect(parseEnvelope(env({ tools: [""] as never }))).toBeNull();
    expect(parseEnvelope(env({ credentials: {} as never }))).toBeNull();
    expect(parseEnvelope(env({ budgetMicros: "1000" as never }))).toBeNull();
    expect(parseEnvelope(env({ budgetMicros: -1 }))).toBeNull();
    // `1e999` is valid JSON and parses to Infinity — the one non-finite number
    // that reaches this function through a real column.
    expect(parseEnvelope(`{"tools":[],"credentials":[],"budgetMicros":1e999}`)).toBeNull();
  });

  it("an explicit `null` axis IS readable — that is a declared unset ceiling", () => {
    expect(parseEnvelope(env({ tools: null, credentials: null, budgetMicros: null }))).toEqual(UNSET);
  });

  it("de-duplicates a set rather than refusing it", () => {
    expect(parseEnvelope(env({ tools: ["a", "a", "b"] }))!.tools).toEqual(["a", "b"]);
  });
});

describe("foldChain FAILS CLOSED — an unreadable hop denies the whole fold", () => {
  const BINDING = A({ tools: ["a", "b"], credentials: ["c1"], budgetMicros: 100 });

  it("an ABSENT envelope at any hop denies, and never defaults to allow", () => {
    const r = foldChain(BINDING, [env({ tools: ["a"] }), null]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.denial.axis).toBe("envelope");
      expect(r.denial.why).toMatch(/NO authority envelope/);
      expect(r.denial.requested).toBe("hop 2 of 2");
    }
  });

  it("a MALFORMED envelope at any hop denies — a parse failure is a denial, not a warning", () => {
    const r = foldChain(BINDING, [env({ tools: ["a"] }), "{oops"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.denial.axis).toBe("envelope");
      expect(r.denial.why).toMatch(/unreadable/);
    }
  });

  it("a wrong-SHAPED envelope denies too, even though JSON.parse succeeds", () => {
    const r = foldChain(BINDING, [env({ tools: "*" as never })]);
    expect(r.ok).toBe(false);
  });

  it("the denial NAMES the hop, so the row to open is not a guess", () => {
    const r = foldChain(BINDING, [env({ tools: ["a"] }), env({ tools: ["a"] }), null]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.denial.requested).toBe("hop 3 of 3");
      expect(describeDenial(r.denial)).toMatch(/^envelope — asked hop 3 of 3/);
    }
  });

  it("an empty chain is the BINDING's own ceiling — no delegation, nothing to narrow", () => {
    const r = foldChain(BINDING, []);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.authority).toEqual(BINDING);
  });
});

describe("a chain can only NARROW — hop 2 cannot widen what hop 1 gave up", () => {
  const BINDING = A({ tools: ["a", "b", "c"], credentials: ["c1", "c2"], budgetMicros: 1000 });

  it("hop 1 drops a tool and hop 2 CANNOT get it back, however loudly it asks", () => {
    // hop 1 narrowed to [a]; hop 2's row claims [a, b, c] — a row that never
    // came through `attenuateChild`, or one written before hop 1 was narrowed.
    const r = foldChain(BINDING, [
      env({ tools: ["a"], credentials: ["c1"], budgetMicros: 500 }),
      env({ tools: ["a", "b", "c"], credentials: ["c1", "c2"], budgetMicros: 900 }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.authority.tools).toEqual(["a"]);
    expect(r.authority.credentials).toEqual(["c1"]);
    expect(r.authority.budgetMicros).toBe(500);
    // And the capability hop 2 tried to reclaim is refused at use time.
    expect(denied(r.authority, { kind: "tool", name: "b" })).toBe("tools");
    expect(denied(r.authority, { kind: "credential", name: "c2" })).toBe("credentials");
    expect(denied(r.authority, { kind: "spend", micros: 900 })).toBe("budget");
  });

  it("a THREE-hop chain narrows monotonically — each hop is a floor nobody re-raises", () => {
    const r = foldChain(BINDING, [
      env({ tools: ["a", "b"], credentials: ["c1"], budgetMicros: 800 }),
      env({ tools: ["a"], credentials: ["c1"], budgetMicros: 400 }),
      env({ tools: ["a", "b", "c"], credentials: ["c1", "c2"], budgetMicros: 999_999 }),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.authority).toEqual({ tools: ["a"], credentials: ["c1"], budgetMicros: 400 });
    }
  });

  it("THE BINDING BOUND: a chain may not hold what the binding itself does not", () => {
    // Every hop claims `d` — a tool the binding never granted. The binding is
    // the first term of the fold, so `d` is not in the answer. This is
    // "decomposition cannot mint authority", as arithmetic.
    const r = foldChain(BINDING, [
      env({ tools: ["a", "d"], credentials: ["c1"], budgetMicros: 1000 }),
      env({ tools: ["a", "d"], credentials: ["c1"], budgetMicros: 1000 }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.authority.tools).toEqual(["a"]);
    expect(denied(r.authority, { kind: "tool", name: "d" })).toBe("tools");
  });

  it("THE BINDING BOUND bites a chain written BEFORE the binding was narrowed", () => {
    // The mid-flight edit: an operator narrows `config_json.jobs` to [a] while
    // a Job is running. Every existing node still carries the old, wider
    // envelope — and every one of them is bounded anyway.
    const narrowedBinding = A({ tools: ["a"], credentials: [], budgetMicros: 10 });
    const r = foldChain(narrowedBinding, [env({ tools: ["a", "b"], credentials: ["c1"], budgetMicros: 1000 })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.authority).toEqual({ tools: ["a"], credentials: [], budgetMicros: 10 });
    expect(denied(r.authority, { kind: "tool", name: "b" })).toBe("tools");
    expect(denied(r.authority, { kind: "credential", name: "c1" })).toBe("credentials");
    expect(denied(r.authority, { kind: "spend", micros: 11 })).toBe("budget");
  });

  it("an UNSET binding ceiling widens nothing — the chain still bounds itself", () => {
    const r = foldChain(UNSET, [env({ tools: ["a"], credentials: [], budgetMicros: 5 })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.authority).toEqual({ tools: ["a"], credentials: [], budgetMicros: 5 });
    expect(denied(r.authority, { kind: "tool", name: "b" })).toBe("tools");
  });
});

describe("mayUse — the three axes, at the point of use", () => {
  const EFFECTIVE = A({ tools: ["files.read"], credentials: ["aws-mcp"], budgetMicros: 500 });

  it("ALLOWS exactly what the effective authority holds", () => {
    expect(mayUse(EFFECTIVE, { kind: "tool", name: "files.read" }).ok).toBe(true);
    expect(mayUse(EFFECTIVE, { kind: "credential", name: "aws-mcp" }).ok).toBe(true);
    expect(mayUse(EFFECTIVE, { kind: "spend", micros: 500 }).ok).toBe(true);
    expect(mayUse(EFFECTIVE, { kind: "spend", micros: 0 }).ok).toBe(true);
  });

  it("DENIES a tool the envelope omitted even though the binding holds it", () => {
    // The headline case: `email.draft` is in the binding's ceiling (see `A()`)
    // and NOT in this node's effective set, because the delegation dropped it.
    const r = mayUse(EFFECTIVE, { kind: "tool", name: "email.draft" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.denial.axis).toBe("tools");
      expect(r.denial.requested).toBe("email.draft");
      expect(r.denial.ceiling).toBe("[files.read]");
      expect(r.denial.why).toMatch(/did not carry email\.draft/);
    }
  });

  it("DENIES a credential the envelope omitted, and names it", () => {
    const r = mayUse(EFFECTIVE, { kind: "credential", name: "stripe" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.denial.axis).toBe("credentials");
      expect(describeDenial(r.denial)).toContain("stripe");
    }
  });

  it("DENIES a spend over the node's own ceiling", () => {
    const r = mayUse(EFFECTIVE, { kind: "spend", micros: 501 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.denial.axis).toBe("budget");
      expect(r.denial.ceiling).toBe("500µ$");
    }
  });

  it("DENIES a nonsense spend rather than coercing it", () => {
    expect(denied(EFFECTIVE, { kind: "spend", micros: -1 })).toBe("budget");
    expect(denied(EFFECTIVE, { kind: "spend", micros: Number.NaN })).toBe("budget");
    expect(denied(EFFECTIVE, { kind: "spend", micros: "5" as never })).toBe("budget");
  });

  it("DENIES an empty capability name — a blank is not a wildcard", () => {
    expect(denied(EFFECTIVE, { kind: "tool", name: "" })).toBe("tools");
    expect(denied(EFFECTIVE, { kind: "credential", name: "" })).toBe("credentials");
  });

  it("NO_AUTHORITY holds nothing at all, on every axis", () => {
    expect(denied(NO_AUTHORITY, { kind: "tool", name: "files.read" })).toBe("tools");
    expect(denied(NO_AUTHORITY, { kind: "credential", name: "aws-mcp" })).toBe("credentials");
    expect(denied(NO_AUTHORITY, { kind: "spend", micros: 1 })).toBe("budget");
    // Zero-cost work is still permitted under a zero budget: `budgetMicros: 0`
    // is a money ceiling, and free is under it. Refusing it would strand every
    // structural node in a Job the moment its budget ran out.
    expect(mayUse(NO_AUTHORITY, { kind: "spend", micros: 0 }).ok).toBe(true);
  });

  it("an UNSET axis admits anything — the DefaultCase, and still not a grant", () => {
    expect(mayUse(UNSET, { kind: "tool", name: "anything" }).ok).toBe(true);
    expect(mayUse(UNSET, { kind: "credential", name: "anything" }).ok).toBe(true);
    expect(mayUse(UNSET, { kind: "spend", micros: 10 ** 9 }).ok).toBe(true);
  });
});

describe("the end-to-end property, in one line each", () => {
  it("fold-then-use == use against the narrowest hop, for every axis", () => {
    const binding = A({ tools: ["a", "b", "c"], credentials: ["c1", "c2"], budgetMicros: 900 });
    const chain = [
      env({ tools: ["a", "b"], credentials: ["c1", "c2"], budgetMicros: 700 }),
      env({ tools: ["b", "c"], credentials: ["c2"], budgetMicros: 800 }),
    ];
    const r = foldChain(binding, chain);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // tools: [a,b,c] ∩ [a,b] ∩ [b,c] = [b]
    expect(r.authority.tools).toEqual(["b"]);
    // credentials: [c1,c2] ∩ [c1,c2] ∩ [c2] = [c2]
    expect(r.authority.credentials).toEqual(["c2"]);
    // budget: min(900, 700, 800) = 700
    expect(r.authority.budgetMicros).toBe(700);
  });
});
