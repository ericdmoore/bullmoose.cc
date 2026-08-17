import { commitDueHeldProposals } from "../../jmap/src/methods/actionProposal";
import type { RequestContext } from "../../jmap/src/methods/common";
import type { Env as JmapEnv } from "../../jmap/src/index";
import type { Env } from "./models.js";

/**
 * The hold-tray commit sweep, from the clock's side (s03.D T2).
 *
 * A tier-2 approve parks the proposal `held` for the retraction window; this
 * sweep — riding the agent worker's existing 5-minute cron, the same clock
 * that drains, escalates and expires — commits whatever the window has
 * released. Worst-case approve→egress latency is window + cron interval
 * (~5+5 min), which is the price of the yank being real rather than
 * decorative.
 *
 * The method-layer code runs IN-PROCESS via the jmapBridge pattern (one
 * implementation of the commit choreography, never two — see jmapBridge.ts
 * for the argument). The ctx principal here is a placeholder that is never
 * written: provenance comes from each row's own decision (`by`), because the
 * applied write belongs to the human whose approval it executes.
 */
export async function commitHeldProposals(env: Env): Promise<void> {
  const ctx: RequestContext = {
    env: env as unknown as JmapEnv,
    principal: { username: "system:hold-commit", scopes: [], accounts: [] },
    agent: {},
  };
  const { committed, failed } = await commitDueHeldProposals(ctx);
  if (committed.length > 0) {
    console.log(`hold-tray commit: ${committed.length} proposal(s) egressed — ${committed.join(", ")}`);
  }
  for (const f of failed) {
    // Loud, per row: a failed commit stays `held` and retries next sweep, so
    // a persistent line here is a stuck egress a human approved — exactly
    // the thing an operator wants to see.
    console.error(`hold-tray commit FAILED for ${f.id}: ${f.error} (stays held; will retry)`);
  }
}
