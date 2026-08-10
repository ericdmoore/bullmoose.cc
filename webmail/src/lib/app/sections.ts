// The eight sections, in order, with the reason each unbuilt one is dark.
//
// ⚠️ THE ORDER IS A CLAIM, not a layout detail. The s07 devPlan's "What this is
// NOT" section is explicit: this is a collaboration space for people and
// agents, and it is decision-centric — you arrive to DECIDE something, not to
// find something. "Put /mail first and you have built a mail client with
// extras"; lead with /files and you have built Drive. So the order runs
// decide → when → who-and-what → tools:
//
//   approvals, agents   what needs me, and who is asking
//   calendar            what is about to happen
//   mail, contacts      the correspondence and the people in it
//   files               storage, deliberately NOT the front of the product
//   search, settings    tools over the above, not nouns of their own
//
// `sections.test.ts` asserts that ordering, because a claim nobody checks is a
// comment. `/` is not in this list at all: home is a VIEW (Looking Ahead +
// Waiting Approvals, s07 T0), never a section you drill into.
//
// Reasons live HERE rather than in the layout's markup so that "why is this
// dark" is data — one place to correct when a section ships, and something a
// test can hold to the pages that actually exist.

export type SectionId =
  | "approvals"
  | "agents"
  | "calendar"
  | "mail"
  | "contacts"
  | "files"
  | "search"
  | "settings";

interface SectionBase {
  id: SectionId;
  label: string;
  href: string;
}

/** Built and reachable. There is a page behind this href. */
export interface LiveSection extends SectionBase {
  status: "live";
}

/**
 * Not built. Renders disabled with `reason` visible — never a link, never a
 * 404. `reason` and `detail` are both required: a greyed-out word with no
 * explanation teaches the user that the product is broken rather than
 * unfinished.
 */
export interface PlannedSection extends SectionBase {
  status: "planned";
  /** Short enough to sit under the label in the nav. */
  reason: string;
  /** The full story — what is missing and which task builds it. */
  detail: string;
}

export type Section = LiveSection | PlannedSection;

export const SECTIONS: readonly Section[] = [
  {
    id: "approvals",
    label: "Approvals",
    href: "/approvals",
    status: "planned",
    reason: "no proposal queue yet",
    detail:
      "ActionProposal is fully specified (s03.D arch.md:19-36) and built nowhere — " +
      "nothing produces a proposal, so there is nothing to approve, edit or decline. " +
      "s07 T4 builds the queue and the producer behind it.",
  },
  {
    id: "agents",
    label: "Agents",
    href: "/agents",
    // Live in the sense that matters here — there is a page and it is
    // reachable. Its own caveats (which of its endpoints are unserved) are
    // rendered by the console itself, `AgentConsole.tsx:264`, rather than
    // duplicated into the nav where they would drift.
    status: "live",
  },
  {
    id: "calendar",
    label: "Calendar",
    href: "/calendar",
    status: "planned",
    reason: "server is live, screen is not",
    detail:
      "Calendar/* and CalendarEvent/* — nine JMAP methods, plus full CalDAV — are " +
      "serving today with no browser path to them. s07 T3 needs no server work at all.",
  },
  {
    id: "mail",
    label: "Mail",
    href: "/mail",
    status: "live",
  },
  {
    id: "contacts",
    label: "Contacts",
    href: "/contacts",
    status: "planned",
    reason: "server is live, screen is not",
    detail:
      "AddressBook/* and ContactCard/* — eight JMAP methods, plus full CardDAV — are " +
      "serving today with no browser path to them. s07 T3 needs no server work at all.",
  },
  {
    id: "files",
    label: "Files",
    href: "/files",
    status: "planned",
    reason: "waiting on the attachment sidestep",
    detail:
      "s03.C T3, blocked on s03.B T3 (not started: no threshold, no FileNode on " +
      "ingest), and .feedback common/030 (FileNode copy OOM) is still open. A nav item " +
      "that 500s is worse than one that says why.",
  },
  {
    id: "search",
    label: "Search",
    href: "/search",
    status: "planned",
    reason: "cross-realm query not built",
    detail:
      "The realms are not equally searchable — mail is FTS5-indexed, contacts and " +
      "calendar are full scans, files has no search path at all. s07 T6 ships the " +
      "fan-out with a scope note that says which is which.",
  },
  {
    id: "settings",
    label: "Settings",
    href: "/settings",
    // Live as of s07 T2 over all four `HumanSettings` methods —
    // `Identity/get`+`/set` and `VacationResponse/get`+`/set` — with no server
    // work behind it. What the screen cannot do it says on its own face
    // (`lib/settings/vacation.ts`: no HTML body, no concurrency guard) rather
    // than in the nav, which would drift.
    status: "live",
  },
];

export function sectionById(id: string): Section | undefined {
  return SECTIONS.find((s) => s.id === id);
}
