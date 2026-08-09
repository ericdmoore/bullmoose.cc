/** @jsxImportSource preact */
import { hasAgentCapability } from "../lib/jmap/capabilities";
import type { Session } from "../lib/jmap/types";

// The mail-client shell. DELIBERATELY a placeholder in T1 — mail surfaces
// (mailbox list, thread view, compose, search) are T2 and the Files browser is
// T3; neither is built yet (readme.md "Out of scope" / devPlan T2·T3). What T1
// proves here is the SHAPE: an island that receives a `session` and renders the
// capability-gated agent seam behind ONE check, so s03.D is additive.

interface Props {
  /** Injected at runtime once login lands (T2). Absent in the static demo. */
  session?: Session;
}

const DEFERRED = [
  ["Mailbox list", "T2"],
  ["Thread list + view", "T2"],
  ["Compose / reply / forward", "T2"],
  ["Search", "T2"],
  ["Files browser", "T3"],
];

export default function AppShell({ session }: Props) {
  // The plain-client invariant (arch.md §5, invariant §8.6): with the agent
  // capability absent, this seam renders nothing — no error, no dead region.
  const showAgentSeam = session ? hasAgentCapability(session) : false;

  return (
    <main class="shell">
      <h1>bullmoose webmail</h1>
      <p class="tagline">
        App shell — s03.C · T1. The injected <code>JmapClient</code> is live and
        unit-tested; the mail surfaces below are deferred.
      </p>
      <ul class="deferred">
        {DEFERRED.map(([name, wave]) => (
          <li>
            <span class="name">{name}</span> <span class="wave">deferred → {wave}</span>
          </li>
        ))}
      </ul>
      {showAgentSeam ? (
        <section class="agent-seam">{/* s03.D renders here when the cap is present */}</section>
      ) : null}
    </main>
  );
}
