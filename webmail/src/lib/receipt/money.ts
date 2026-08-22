// Aggregate cost, with NULL and 0 kept apart by construction.
//
// `costLabel` (approvals/rows.ts) already renders ONE cost correctly — "cost not
// recorded" / "free" / a figure. `microsLabel` (agents/dossier.ts) already
// renders an aggregate the server COALESCEd to 0, where 0 is arithmetic and not
// an absence. Neither covers the case this surface has: a pile of per-row costs
// where some are NULL, summed in the browser.
//
// That is the case where the rule is easiest to break and worst to break. Doing
// the obvious thing — `rows.reduce((n, r) => n + (r.cost ?? 0), 0)` — produces a
// total that is smaller than the truth by an unknown amount and carries no sign
// that anything was dropped. On a receipt whose entire purpose is "measure, do
// not estimate", that is the one bug that discredits the surface.
//
// So a NULL cannot reach the sum. It can only reach `unrecorded`, which every
// label carries.

import { microsLabel } from "../agents/dossier";
import type { MoneyTotal } from "./types";

export const EMPTY_MONEY: MoneyTotal = { micros: 0, recorded: 0, unrecorded: 0, free: 0 };

/**
 * Sum a column of `cost_micros`, counting what was missing rather than
 * assuming it away. `undefined` is treated exactly as `null`: on a server that
 * predates s26 the field is absent from the wire, which is "not recorded" by a
 * different route, not "free".
 */
export function totalCost(costs: readonly (number | null | undefined)[]): MoneyTotal {
  const out: MoneyTotal = { micros: 0, recorded: 0, unrecorded: 0, free: 0 };
  for (const c of costs) {
    if (typeof c !== "number" || !Number.isFinite(c)) {
      out.unrecorded += 1;
      continue;
    }
    out.recorded += 1;
    out.micros += c;
    if (c === 0) out.free += 1;
  }
  return out;
}

/** Fold several totals into one without ever re-deriving them from labels. */
export function sumMoney(totals: readonly MoneyTotal[]): MoneyTotal {
  return totals.reduce<MoneyTotal>(
    (acc, t) => ({
      micros: acc.micros + t.micros,
      recorded: acc.recorded + t.recorded,
      unrecorded: acc.unrecorded + t.unrecorded,
      free: acc.free + t.free,
    }),
    { ...EMPTY_MONEY },
  );
}

/**
 * The headline figure. There deliberately is no "$0.00" path for an unpriced
 * pile: with nothing recorded the answer is the words, not a number.
 */
export function moneyLabel(t: MoneyTotal): string {
  if (t.recorded === 0) {
    if (t.unrecorded === 0) return "nothing to price";
    return "cost not recorded";
  }
  // Everything recorded and every one of them zero: the honest, load-bearing
  // zero. Said in words so it cannot be misread as a rounded-down figure.
  if (t.micros === 0 && t.free === t.recorded) return "free";
  return microsLabel(t.micros);
}

/**
 * The fine print that must appear wherever `moneyLabel` does. Null when there
 * is nothing to qualify — the caller renders nothing rather than "0 of 0".
 */
export function moneyCaveat(t: MoneyTotal): string | null {
  const parts: string[] = [];
  if (t.recorded > 0) {
    parts.push(`${t.recorded} priced${t.free > 0 ? ` (${t.free} free)` : ""}`);
  }
  if (t.unrecorded > 0) {
    // The sentence that keeps the total honest: not "$0.00 for those", not
    // silence — an explicit count of runs the figure beside it excludes.
    parts.push(`${t.unrecorded} not recorded, and excluded from the total`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
