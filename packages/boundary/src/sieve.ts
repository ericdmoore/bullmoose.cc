// Cascade stage 3 — the sieve (s12 readme, commitment 1): deterministic,
// ordered rules; PASS → CONTINUE to Bayes, FAIL → REJECT with the rule id
// recorded as the reason. Pure: a function of (rules, message), nothing else.
//
// ── This is NOT RFC 5228 Sieve — the delta, named ──────────────────────────
// serverless-jmap.md §17 calls for "a JSON ruleset in D1/control-plane;
// graduate to Sieve if/when a ManageSieve story is wanted". This module is
// that JSON start. Compared to RFC 5228 it deliberately lacks:
//   • scripts and control structure (if/elsif/stop, require) — rules are a
//     flat ordered list, first-match-wins, no implicit keep;
//   • the action vocabulary (fileinto/redirect/vacation/discard) — the only
//     actions are `reject` and `pass`, because stage 3's only outputs are
//     REJECT and CONTINUE;
//   • comparators, relational tests, envelope/body/size tests, :regex —
//     matchers are case-insensitive substring (`contains`) and an ANCHORED
//     glob (`*`/`?` only). Full user-supplied regex is excluded ON PURPOSE:
//     rules are user/tenant data, and a hostile pattern must not be able to
//     buy exponential backtracking (ReDoS) on the ingest hot path. The glob
//     matcher below is the classic iterative two-pointer algorithm — O(n·m)
//     worst case by construction, no backtracking stack, no RegExp at all.
//
// Determinism: rule order is evaluation order; the first rule whose matchers
// ALL hit decides. No clocks, no randomness — same inputs, same verdict.

import type { BoundaryMessage } from "./message.js";

/** The message fields a matcher may address directly (headers go through the
 * header* matchers so the name travels with the rule). */
export type SieveField = "from" | "fromDomain" | "subject";

/**
 * One condition. All string comparison is case-insensitive (both sides are
 * lowercased). `glob` values are ANCHORED: the pattern must cover the whole
 * field value — `spam*` matches "spamhouse" but not "aspam"; use `*spam*`
 * for substring-by-glob (or just `contains`).
 */
export type SieveMatch =
  | { kind: "contains"; field: SieveField; value: string }
  | { kind: "glob"; field: SieveField; value: string }
  | { kind: "headerPresent"; name: string }
  | { kind: "headerContains"; name: string; value: string }
  | { kind: "headerGlob"; name: string; value: string };

/**
 * One rule — JSON-serializable, stored later in config (§17: a synced,
 * versioned collection). `all` is a conjunction: the rule fires only when
 * EVERY matcher hits. An EMPTY `all` never fires (a malformed rule must not
 * silently become a match-everything reject; the engine's default verdict —
 * PASS with no ruleId — already covers "no rule spoke").
 */
export interface SieveRule {
  id: string;
  /** Conjunction of conditions; empty = the rule never fires. */
  all: SieveMatch[];
  /** What a firing rule decides: `reject` → FAIL, `pass` → PASS (an
   * allow-through that also short-circuits later reject rules). */
  action: "reject" | "pass";
}

/**
 * Anchored glob match, `*` = any run (incl. empty), `?` = exactly one char.
 * Iterative two-pointer with single-star backtrack — worst case O(n·m),
 * linear memory, NO RegExp: a pathological pattern cannot cost more than
 * pattern-length × text-length steps. Both arguments must be pre-lowercased
 * by the caller (sieveVerdict does this).
 */
export function globMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1; // index in pattern of the last '*' seen
  let mark = 0; // index in text where that star's run currently ends
  while (t < text.length) {
    const pc = p < pattern.length ? pattern[p] : undefined;
    if (pc !== undefined && (pc === "?" || pc === text[t])) {
      p++;
      t++;
    } else if (pc === "*") {
      star = p;
      p++;
      mark = t;
    } else if (star !== -1) {
      // Mismatch after a star: let the star eat one more char and retry.
      p = star + 1;
      mark++;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Case-insensitive header lookup. First key (insertion order) that matches
 * wins on duplicate names differing only in case — deterministic. */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === want) return headers[key];
  }
  return undefined;
}

function fieldValue(msg: BoundaryMessage, field: SieveField): string {
  switch (field) {
    case "from":
      return msg.from;
    case "fromDomain":
      return msg.fromDomain;
    case "subject":
      return msg.subject;
  }
}

function matches(m: SieveMatch, msg: BoundaryMessage): boolean {
  switch (m.kind) {
    case "contains":
      return fieldValue(msg, m.field).toLowerCase().includes(m.value.toLowerCase());
    case "glob":
      return globMatch(m.value.toLowerCase(), fieldValue(msg, m.field).toLowerCase());
    case "headerPresent":
      return headerValue(msg.headers, m.name) !== undefined;
    case "headerContains": {
      const v = headerValue(msg.headers, m.name);
      return v !== undefined && v.toLowerCase().includes(m.value.toLowerCase());
    }
    case "headerGlob": {
      const v = headerValue(msg.headers, m.name);
      return v !== undefined && globMatch(m.value.toLowerCase(), v.toLowerCase());
    }
  }
}

/**
 * Evaluate the ordered ruleset against one message. First rule whose `all`
 * conjunction fully matches decides; its id is returned either way (a PASS
 * from an explicit allow rule is auditable too). No rule fires → PASS with
 * no ruleId — the sieve stage is CONTINUE-by-default, rejection is opt-in.
 */
export function sieveVerdict(
  rules: SieveRule[],
  msg: BoundaryMessage,
): { verdict: "PASS" | "FAIL"; ruleId?: string } {
  for (const rule of rules) {
    if (rule.all.length === 0) continue; // empty conjunction never fires
    if (rule.all.every((m) => matches(m, msg))) {
      return { verdict: rule.action === "reject" ? "FAIL" : "PASS", ruleId: rule.id };
    }
  }
  return { verdict: "PASS" };
}
