// The console's capability gate.
//
// Every agent surface hides behind `hasAgentCapability` (arch.md §5), and the
// plain-client floor — *"with the capability absent, nothing errors, 400s, or
// renders a dead region"* (s03.C T4, arch.md invariant §8.6) — is a property
// this slice must not break. The console is the largest agent surface yet, so
// the gate gets a pure function and a test rather than an `&&` in a component.
//
// The decision is deliberately three-valued. "Absent" and "present but the read
// interface is not deployed" are different states and must render differently:
// the first is a plain client working exactly as designed, the second is a
// misconfiguration someone should fix. Collapsing them into one empty panel is
// how a broken deployment gets mistaken for a supported one.

import { hasAgentCapability } from "../jmap/capabilities";
import type { Session } from "../jmap/types";

export type ConsoleGateState = "open" | "no-capability";

export interface ConsoleGate {
  state: ConsoleGateState;
  /** Should the shell render an entry point to the console at all? */
  visible: boolean;
  reason: string;
}

export function consoleGate(session: Pick<Session, "capabilities"> | undefined): ConsoleGate {
  if (!session) {
    return { state: "no-capability", visible: false, reason: "no session yet" };
  }
  if (!hasAgentCapability(session)) {
    return {
      state: "no-capability",
      visible: false,
      // Not an error string: this is the supported plain-client configuration.
      reason:
        "This server does not advertise the bullmoose agent capability, so there are no agents, " +
        "credentials or delegated-access records to show. The mail client is unaffected.",
    };
  }
  return { state: "open", visible: true, reason: "agent capability advertised" };
}
