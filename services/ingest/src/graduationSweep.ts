// The graduation sweep (s12 wave 2-C) — "the cascade optimizes its own cost"
// (readme, commitment 1). A domain repeatedly rejected by the EXPENSIVE
// stages (sieve/bayes — deliver() bumps deny_counters for exactly those
// holds) with no rescues graduates DOWNWARD into the industrial deny list,
// so its future mail exits at the SMTP edge for nanoseconds instead of
// paying parse + Bayes.
//
// Periodic-work pattern: the agent worker's cron + scheduled() sweep
// (services/agent/src/index.ts — failStaleRunning / expireStaleProposals /
// drain), reused verbatim: wrangler.jsonc `triggers.crons` on THIS worker
// invokes `scheduled`, which calls `sweepGraduations`. Ingest hosts it
// because the sweep writes bouncer@'s working data and republishes the
// stage-1 bloom, both of which live here.
//
// The policy itself is pure (@bullmoose/boundary graduationDue +
// DEFAULT_GRADUATION_POLICY); this file is only the aggregation, the write,
// and the evidence record. The inverse — demotion on rescue — was already
// wired in wave 1-A (Mailstore.rescueQuarantined), and the policy's
// maxRescues: 0 means ONE rescue blocks graduation for as long as the chain
// remembers it: rescues never decay, so a domain a human vouched for once
// does not creep back in via volume.

import { DEFAULT_GRADUATION_POLICY, graduationDue } from "./boundaryContract";
import { addDenyDomain, rebuildBoundaryBloom, type BoundaryEnv } from "./boundary";

/**
 * One sweep pass. Fail-open end to end: a shard that predates any s12 table
 * reads as "nothing to graduate" (logged), never a crash — the sweep is an
 * optimization, and a missed pass costs only Bayes compute.
 *
 * Reject evidence: deny_counters summed per domain across days. Rescue
 * evidence: 'rescued' chain rows per domain — the human corrections. Both
 * feed graduationDue; each due domain is added with source 'graduated' and
 * evidence '<N>×rejects, 0 rescues' (the policy guarantees the 0), tenant
 * resolved from the domain's own quarantine chain rows. The bloom rebuilds
 * ONCE per sweep, and only when something was actually added.
 */
export async function sweepGraduations(
  env: BoundaryEnv,
): Promise<{ graduated: string[]; bloomRebuilt: boolean }> {
  let rejects: Array<{ domain: string; rejects: number }>;
  let rescues: Array<{ domain: string; rescues: number }>;
  try {
    rejects = (
      await env.DB.prepare(
        `SELECT domain, SUM(count) AS rejects FROM deny_counters GROUP BY domain`,
      ).all<{ domain: string; rejects: number }>()
    ).results;
    rescues = (
      await env.DB.prepare(
        `SELECT domain, COUNT(*) AS rescues FROM quarantine_events
         WHERE event = 'rescued' GROUP BY domain`,
      ).all<{ domain: string; rescues: number }>()
    ).results;
  } catch (err) {
    console.error(
      `graduation sweep degraded to no-op (${err instanceof Error ? err.message : err})`,
    );
    return { graduated: [], bloomRebuilt: false };
  }

  const rescuesOf = new Map(rescues.map((r) => [r.domain, r.rescues]));
  const counts = rejects.map((r) => ({
    domain: r.domain,
    rejects: r.rejects,
    rescues: rescuesOf.get(r.domain) ?? 0,
  }));

  const graduated: string[] = [];
  let added = false;
  for (const domain of graduationDue(counts, DEFAULT_GRADUATION_POLICY)) {
    const rejectCount = counts.find((c) => c.domain === domain)?.rejects ?? 0;
    try {
      const res = await addDenyDomain(
        env,
        domain,
        "graduated",
        `${rejectCount}×rejects, 0 rescues`,
        // ONE rebuild per sweep (below), not one per domain.
        { rebuildBloom: false },
      );
      if (res.added) {
        added = true;
        graduated.push(domain);
      }
    } catch (err) {
      // One domain's write failing must not starve the rest of the sweep.
      console.error(
        `graduation of ${domain} failed (${err instanceof Error ? err.message : err})`,
      );
    }
  }

  if (added) {
    await rebuildBoundaryBloom(env);
    console.log(`graduation sweep: graduated ${graduated.join(", ")}; bloom rebuilt`);
  }
  return { graduated, bloomRebuilt: added };
}
