// Capability URNs + the capability gate.
//
// This is the seam every future agent feature renders behind (arch.md §5).
// It is deliberately built into T1 so s03.D is additive, not a rewrite, and so
// the "works as a plain client" invariant (../s03-webAccess/arch.md §8.6) is
// provable NOW, while there is nothing to hide.

import type { Session } from "./types";

export const CORE_CAP = "urn:ietf:params:jmap:core";
export const MAIL_CAP = "urn:ietf:params:jmap:mail";
export const SUBMISSION_CAP = "urn:ietf:params:jmap:submission";
export const VACATION_CAP = "urn:ietf:params:jmap:vacationresponse";
export const CONTACTS_CAP = "urn:ietf:params:jmap:contacts";
export const CALENDARS_CAP = "urn:ietf:params:jmap:calendars";
export const FILENODE_CAP = "urn:ietf:params:jmap:filenode";
export const WEBSOCKET_CAP = "urn:ietf:params:jmap:websocket";

/**
 * The bullmoose agent capability — the gate for every s03.D surface.
 *
 * ⚠️ The arch doc (arch.md §5) writes this as `urn:bullmoose:agent`, but the
 * LIVE server advertises the fuller `urn:bullmoose:params:jmap:agent`
 * (`packages/jmap-core/src/capabilities.ts` AGENT_CAP, echoed by
 * `services/jmap/src/session.ts`). We gate on the REAL URN so the check works
 * against a running bullmoose; the arch string is shorthand. If the two are
 * ever reconciled, change it here in one place.
 */
export const AGENT_CAP = "urn:bullmoose:params:jmap:agent";

/**
 * Does the session advertise a capability? Uses key-presence, not truthiness:
 * the server sets each cap to an object (often `{}`), so `session.capabilities[urn]`
 * would be a truthy `{}` for present caps but `hasOwnProperty` is the honest test.
 */
export function hasCapability(session: Pick<Session, "capabilities">, urn: string): boolean {
  return Object.prototype.hasOwnProperty.call(session.capabilities, urn);
}

/** The one check every agent surface hides behind. */
export function hasAgentCapability(session: Pick<Session, "capabilities">): boolean {
  return hasCapability(session, AGENT_CAP);
}

/**
 * Which capability URN a JMAP method needs in `using[]`. Used to compute a
 * request's `using[]` from the live session so a surface whose capability is
 * absent never sends a call that would 400 (arch.md §2, invariant §6.4).
 */
export function capabilityForMethod(methodName: string): string {
  const type = methodName.split("/")[0] ?? "";
  switch (type) {
    case "Core":
      return CORE_CAP;
    case "Mailbox":
    case "Email":
    case "Thread":
      return MAIL_CAP;
    case "EmailSubmission":
      return SUBMISSION_CAP;
    case "VacationResponse":
      return VACATION_CAP;
    case "AddressBook":
    case "ContactCard":
      return CONTACTS_CAP;
    case "Calendar":
    case "CalendarEvent":
      return CALENDARS_CAP;
    case "FileNode":
      return FILENODE_CAP;
    case "AgentInvocation":
      return AGENT_CAP;
    default:
      // Unknown method — fall back to core; the server will reject the method
      // itself if it truly doesn't exist, which is the honest failure.
      return CORE_CAP;
  }
}
