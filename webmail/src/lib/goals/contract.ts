// The contract, as the browser reads it (s20 T6).
//
// ⚠️ `contactAllowed` below is a DELIBERATE SECOND COPY of the rule in
// `packages/scheduling/src/goalContract.ts`, and the asymmetry between the two
// is the point:
//
//   the server's copy is the ENFORCEMENT — it refuses a plan whose task points
//   somewhere the contract does not reach, at both ends of the checkpoint;
//   this copy is a COURTESY — it tells a person who mistyped an address so at
//   the field they typed it into, instead of a minute later through a failed
//   approval.
//
// The client copy can therefore only ever be more permissive than the server's
// with one consequence: a round trip that comes back refused. It cannot widen
// anything, because nothing here decides anything. (webmail does not depend on
// @bullmoose/scheduling — the astro build resolves only what is in
// webmail/package.json — and adding a workspace dependency to share five lines
// would be the bigger change. `contract.test.ts` walks the same table of cases
// the package's own test walks, which is what keeps the two honest.)

import type { GoalContract } from "./types";

/** Exactly two forms: an exact address, or `@domain` for everyone there. No
 *  globs, no substring matching — every near-miss here is an email to a
 *  stranger. */
export function contactAllowed(patterns: readonly string[], address: string): boolean {
  const target = address.trim().toLowerCase();
  if (!target.includes("@")) return false;
  const domain = target.slice(target.indexOf("@"));
  return patterns.some((p) => {
    const pat = p.trim().toLowerCase();
    if (pat.length === 0) return false;
    return pat.startsWith("@") ? pat === domain : pat === target;
  });
}

/** micro-USD → "$750.00". The unit every budget in the schema is stored in. */
export function money(micros: number | null): string {
  if (micros === null) return "no bound";
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/**
 * The contract as four lines a person reads at the moment they hand over
 * authority — not a settings page they configure once and stop reading.
 *
 * `mayNot` is rendered VERBATIM and is never summarized: it is prose the human
 * wrote, the system does not evaluate it, and paraphrasing a prohibition would
 * be the surface pretending to understand a bound it cannot enforce.
 */
export function contractLines(contract: GoalContract | null): Array<{ label: string; value: string }> {
  if (!contract) {
    return [
      {
        label: "Contract",
        value:
          "This goal's contract cannot be read, so its bounds are unknown — every task under it will refuse to act.",
      },
    ];
  }
  return [
    {
      label: "May",
      value:
        [
          contract.may.contact.length > 0 ? `write to ${contract.may.contact.join(", ")}` : "write to nobody",
          contract.may.tools.length > 0 ? `use ${contract.may.tools.join(", ")}` : "use no tools",
        ].join("; ") + ".",
    },
    { label: "May not", value: contract.mayNot.length > 0 ? contract.mayNot.join("; ") + "." : "Nothing stated." },
    {
      label: "Escalate when",
      value: contract.escalateWhen
        ? `${describeDuration(contract.escalateWhen.afterMs)} without being done${
            contract.escalateWhen.note ? ` — ${contract.escalateWhen.note}` : ""
          }.`
        : "Never — no escalation was set.",
    },
    { label: "Done when", value: contract.doneWhen },
  ];
}

/**
 * The spend bound, said with what it actually means. The number bounds what the
 * SYSTEM spends pursuing the goal; it is not — and this line refuses to imply
 * it is — a limit on what anyone may promise a contractor.
 */
export function budgetLine(budgetMicros: number | null, spentMicros: number): string {
  if (budgetMicros === null) return `${money(spentMicros)} spent — no aggregate bound on this goal.`;
  return `${money(spentMicros)} of ${money(budgetMicros)} spent pursuing this goal (agent time, not money promised to anyone).`;
}

function describeDuration(ms: number): string {
  const days = Math.round(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
