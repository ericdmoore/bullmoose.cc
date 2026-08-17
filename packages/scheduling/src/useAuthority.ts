// USE-TIME AUTHORITY (s11 T7 / s17) — the other half of monotonic attenuation.
//
// `attenuation.ts` enforces the invariant when a delegation is CREATED. This
// module enforces it when the delegated authority is USED. Both halves are
// required, and only one of them existed:
//
//   An attenuation checked only at grant time is not an attenuation. It is a
//   comment. The row is written once and then trusted forever — by the next
//   delegation, and by anything else that later learns to read it.
//
// Three things make a stored envelope untrustworthy at use time, and none of
// them is exotic:
//
//   1. IT MAY NOT HAVE BEEN ATTENUATED AT ALL. Every envelope alive today came
//      through `attenuateChild`, but `authority_json` is an ordinary TEXT
//      column: a migration, a repair script, or the `agents:invoke` path s17 is
//      about to build can write one without passing the harness. A gate that
//      trusts the column trusts whoever last wrote it.
//   2. THE CEILING ABOVE IT MOVES. A binding's `config_json.jobs` ceiling can
//      be narrowed while a Job is mid-flight. Every node created before that
//      edit still carries the OLD, wider envelope, and re-delegates it happily.
//      Narrowing a binding must bite the work already in the queue, or it is
//      advice rather than a control.
//   3. IT MAY BE CORRUPT. A truncated or hand-edited envelope must deny, not
//      degrade into "unrestricted" — the direction of the failure is the whole
//      question. `attenuation.ts` rule 3 says a ceiling is not a grant; the
//      corollary is that an UNREADABLE ceiling is not a licence.
//
// ── THE SEMANTICS, STATED ONCE ─────────────────────────────────────────────
//
//   effective(node) = binding.ceiling ∩ env(root) ∩ env(…) ∩ env(node)
//
// folded ROOT-FIRST down the delegation chain, where `∩` is `intersectAuthority`
// below. Two properties follow, and they are the two the house rule asks for:
//
//   NARROWING ONLY. Intersection is monotone: adding a hop can only shrink the
//   result, never grow it. So hop 2 of a chain cannot widen what hop 1 gave up,
//   no matter what hop 2's row says — its envelope is intersected with, not
//   substituted for, everything above it.
//   NO MINTING. The binding's ceiling is the first term, so nothing below can
//   hold what the binding does not. "Decomposition cannot mint authority"
//   (jobs-and-facets §3) becomes arithmetic instead of a promise about the
//   write path.
//
// ── FAIL CLOSED, SPELLED OUT ───────────────────────────────────────────────
// A hop whose envelope is absent, malformed, unparseable, or the wrong SHAPE
// denies the whole fold. Not the hop — the fold: an unreadable link in a
// delegation chain means the chain's bound is unknown, and an unknown bound is
// not a permissive one. `foldChain` therefore returns a REFUSAL rather than a
// degraded authority, so a caller cannot accidentally carry on with a partial
// answer.
//
// This module is pure. The chain walk and the binding read are the caller's
// (`nodeAuthority.ts`, next door — it moved out of `services/agent/src/useGate.ts`
// when per-invocation tokens gave a second worker a way to name the acting
// invocation), for the same reason `attenuation.ts` is
// pure: every axis here is table-testable, and `useAuthority.test.ts` walks
// them.

import type { NodeAuthority } from "./attenuation.js";

/** One thing a delegated principal wants to do, right now. */
export type Use =
  | { kind: "tool"; name: string }
  | { kind: "credential"; name: string }
  /** Micro-USD this act would spend, checked against the node's own ceiling. */
  | { kind: "spend"; micros: number };

/**
 * A use, refused — the legible half. Same field vocabulary as
 * `attenuation.ts`'s `Refusal` (requested / ceiling / why) so a reader who has
 * seen a delegation-time refusal recognises a use-time one instantly, and so
 * an audit can count both by axis.
 *
 * `envelope` is the axis a corrupt or absent chain link refuses under. It is
 * deliberately NOT one of the three capability axes: "your tools list does not
 * include X" and "your delegation chain is unreadable" are different problems
 * with different fixes, and collapsing them would send whoever is debugging to
 * the wrong place.
 */
export interface AuthorityDenial {
  axis: "tools" | "credentials" | "budget" | "envelope";
  requested: string;
  ceiling: string;
  why: string;
}

export type FoldResult = { ok: true; authority: NodeAuthority } | { ok: false; denial: AuthorityDenial };

export type UseResult = { ok: true } | { ok: false; denial: AuthorityDenial };

/**
 * The zero authority: nothing, of anything. What a denial means, written as a
 * value for the callers that would rather narrow than branch.
 */
export const NO_AUTHORITY: NodeAuthority = { tools: [], credentials: [], budgetMicros: 0 };

/** `null` renders as `*` — an UNSET ceiling, never "everything is granted". */
const list = (v: readonly string[] | null): string => (v === null ? "*" : `[${v.join(", ")}]`);
const money = (v: number | null): string => (v === null ? "unbounded" : `${v}µ$`);

/**
 * INTERSECTION — the narrower of two authorities, on every axis.
 *
 * `null` is the identity element, and that is the one line worth reading
 * twice. `null` means "this level declares no ceiling on this axis" (only a
 * binding with no `jobs` config can produce it — see `attenuation.ts`'s
 * NodeAuthority doc), so intersecting it with anything yields the other side
 * unchanged. It does NOT mean "everything", and it never widens: `null ∩ [a]`
 * is `[a]`, not `null`.
 *
 * Commutative and associative on all three axes, which is what lets a chain be
 * folded in any order and still mean the same thing — and what makes the
 * "narrower in both directions" property a consequence rather than a case.
 */
export function intersectAuthority(a: NodeAuthority, b: NodeAuthority): NodeAuthority {
  return {
    tools: intersectSets(a.tools, b.tools),
    credentials: intersectSets(a.credentials, b.credentials),
    budgetMicros: intersectMoney(a.budgetMicros, b.budgetMicros),
  };
}

function intersectSets(a: readonly string[] | null, b: readonly string[] | null): readonly string[] | null {
  if (a === null) return b;
  if (b === null) return a;
  // `a`'s order is kept so the result is deterministic and diffable; both sides
  // are already duplicate-free (asStringSet / parseEnvelope guarantee it).
  return a.filter((x) => b.includes(x));
}

function intersectMoney(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * PARSE ONE STORED ENVELOPE — strictly, and `null` for anything it cannot
 * vouch for.
 *
 * Strict on purpose, and stricter than the write path's own reader was. The
 * pre-existing `parseAuthority` coerced a wrong-typed field to `null`, which on
 * the tools axis means UNRESTRICTED — so `{"tools": "everything"}` read back as
 * a ceiling that stopped nothing. Coercion is the wrong reflex for a security
 * envelope: every field is either exactly the shape `attenuateChild` writes, or
 * the envelope is not one.
 *
 * Accepted, and nothing else:
 *   tools        an array of non-empty strings, or null (unset)
 *   credentials  an array of non-empty strings, or null (unset)
 *   budgetMicros a finite number ≥ 0, or null (no money ceiling)
 * All three keys must be PRESENT. Every envelope this system writes is
 * `JSON.stringify` of a complete `NodeAuthority`, so a missing key is a
 * hand-written or truncated row, and guessing what its author meant is exactly
 * the guess that ends up permissive.
 *
 * @returns the authority, or `null` meaning UNREADABLE — which every caller
 *          must treat as a denial, never as an absent ceiling.
 */
export function parseEnvelope(raw: string | null | undefined): NodeAuthority | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!("tools" in o) || !("credentials" in o) || !("budgetMicros" in o)) return null;

  const tools = strictSet(o.tools);
  if (tools === INVALID) return null;
  const credentials = strictSet(o.credentials);
  if (credentials === INVALID) return null;

  const budget = o.budgetMicros;
  let budgetMicros: number | null;
  if (budget === null) budgetMicros = null;
  else if (typeof budget === "number" && Number.isFinite(budget) && budget >= 0) budgetMicros = budget;
  else return null;

  return { tools, credentials, budgetMicros };
}

/** Sentinel for "this field is not a set" — distinct from a legitimate `null`. */
const INVALID = Symbol("invalid");

function strictSet(v: unknown): readonly string[] | null | typeof INVALID {
  if (v === null) return null;
  if (!Array.isArray(v)) return INVALID;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || item.length === 0) return INVALID;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * THE FOLD — a binding ceiling and a delegation chain, reduced to one
 * effective authority.
 *
 * `chain` is ROOT-FIRST: the raw `authority_json` of the root node, then each
 * descendant in turn, ending with the node that is about to act. Order does not
 * change the result (intersection is commutative) but it does change the
 * DENIAL: naming "hop 2 of 3" tells whoever is debugging which row to open,
 * which is the difference between a refusal and a mystery.
 *
 * An empty chain returns the binding's own ceiling unchanged. That is the
 * honest answer for "no delegation is in play" — and it is the caller, which
 * knows whether this invocation is part of a Job, that decides whether an empty
 * chain was legitimate. Keeping that decision out here keeps the arithmetic
 * pure.
 */
export function foldChain(binding: NodeAuthority, chain: readonly (string | null)[]): FoldResult {
  let acc = binding;
  for (let i = 0; i < chain.length; i++) {
    const env = parseEnvelope(chain[i]);
    if (env === null) {
      return {
        ok: false,
        denial: {
          axis: "envelope",
          requested: `hop ${i + 1} of ${chain.length}`,
          ceiling: "a readable {tools, credentials, budgetMicros} envelope",
          why:
            chain[i] === null || chain[i] === undefined
              ? "this link of the delegation chain carries NO authority envelope — an unbounded link is not an unrestricted one"
              : "this link of the delegation chain carries an unreadable authority envelope",
        },
      };
    }
    acc = intersectAuthority(acc, env);
  }
  return { ok: true, authority: acc };
}

/**
 * THE GATE — may this effective authority do this?
 *
 * `tools`/`credentials` of `null` admit anything, and that is reachable only
 * when NO level of the chain declared the axis (a binding with no `jobs` config
 * running a node that named no tools). It is the DefaultCase the Job columns
 * were built with — the columns tighten, they never strand — and it is not a
 * grant: rule 3 still holds, the Bureau still checks `bureau_grants`, and the
 * governing book still bounds outbound. What this gate adds is that a
 * delegation which DID narrow an axis can no longer be talked out of it.
 */
export function mayUse(effective: NodeAuthority, use: Use): UseResult {
  switch (use.kind) {
    case "tool":
      return inSet(effective.tools, use.name, "tools", "tool");
    case "credential":
      return inSet(effective.credentials, use.name, "credentials", "credential");
    case "spend": {
      if (typeof use.micros !== "number" || !Number.isFinite(use.micros) || use.micros < 0) {
        return {
          ok: false,
          denial: {
            axis: "budget",
            requested: String(use.micros),
            ceiling: money(effective.budgetMicros),
            why: "a spend must be a non-negative finite number of micro-USD",
          },
        };
      }
      if (effective.budgetMicros !== null && use.micros > effective.budgetMicros) {
        return {
          ok: false,
          denial: {
            axis: "budget",
            requested: money(use.micros),
            ceiling: money(effective.budgetMicros),
            why: "this node may not spend more than its delegation chain left it",
          },
        };
      }
      return { ok: true };
    }
  }
}

function inSet(held: readonly string[] | null, name: string, axis: "tools" | "credentials", noun: string): UseResult {
  if (typeof name !== "string" || name.length === 0) {
    return {
      ok: false,
      denial: {
        axis,
        requested: String(name),
        ceiling: list(held),
        why: `a ${noun} name is required`,
      },
    };
  }
  if (held === null || held.includes(name)) return { ok: true };
  return {
    ok: false,
    denial: {
      axis,
      requested: name,
      ceiling: list(held),
      why: `not in this node's effective ${axis} — the delegation that created it did not carry ${name}`,
    },
  };
}

/**
 * A denial, rendered for a result row, a log line, an HTTP body, or a test
 * message. Twin of `describeRefusals`; kept to one sentence because its most
 * common reader is an operator scanning `console.warn`, and its second most
 * common is a model deciding what to try next.
 */
export function describeDenial(d: AuthorityDenial): string {
  return `${d.axis} — asked ${d.requested}, effective ${d.ceiling} (${d.why})`;
}
