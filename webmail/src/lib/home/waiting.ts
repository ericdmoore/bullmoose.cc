// The Waiting Approvals stack for `/` — the "what needs me now" glance (s07 T0).
//
// This is the CONDENSED cousin of `/approvals`, and "condensed" is a selection
// rule, not a second queue: the home view shows only the PENDING rows (the
// things still asking for a decision), most-urgent first, capped to a glance,
// with a link through to the full page for the rest. Held rows and history do
// not live here — a held row belongs on the horizon as a lapsing hold
// (`horizon.ts`), and history belongs on `/approvals`.
//
// ⚠️ The ORDER is not re-derived. `orderQueue` (../approvals/clocks.ts:138) is
// the one place urgency is defined — soonest-deadline pending first — and this
// module reuses it rather than sorting again, so home and `/approvals` can
// never disagree about which row is on top. The only thing added here is the
// pending-only narrowing and the cap.

import { orderQueue } from "../approvals/clocks";
import type { ActionProposal } from "../approvals/types";

/** How many pending rows the glance shows before it defers to the full queue. */
export const HOME_APPROVALS_LIMIT = 5;

export interface WaitingApprovals {
  /** The rows to render — pending only, most-urgent first, capped. */
  rows: ActionProposal[];
  /** Every pending row, the honest denominator for the "N more" affordance. */
  pendingTotal: number;
  /** Pending rows NOT shown here — the count the link through to /approvals owns. */
  more: number;
}

/**
 * Pick the pending rows for the home glance.
 *
 * `orderQueue` already sorts pending ahead of everything and by urgency within,
 * so filtering to `pending` after ordering keeps the most urgent at the top and
 * the cap keeps the most urgent, not an arbitrary slice.
 */
export function waitingApprovals(
  proposals: readonly ActionProposal[],
  limit: number = HOME_APPROVALS_LIMIT,
): WaitingApprovals {
  const pending = orderQueue(proposals).filter((p) => p.status === "pending");
  const rows = limit >= 0 ? pending.slice(0, limit) : [...pending];
  return { rows, pendingTotal: pending.length, more: pending.length - rows.length };
}
