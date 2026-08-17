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

export type SectionId = "approvals" | "agents" | "calendar" | "mail" | "contacts" | "files" | "search" | "settings";

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
    // Live as of s07 T4, over s03.D T1's ActionProposal collection
    // (services/jmap/src/methods/actionProposal.ts): the cross-agent queue
    // with Approve / Edit / Decline inline. Its own caveat — the tier-2 hold
    // tray has no commit path until s03.D T2 — is rendered by the section
    // itself (lib/approvals/rows.ts HOLD_UNWIRED_NOTE) rather than duplicated
    // into the nav where it would drift.
    status: "live",
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
    // Live as of s07 T3. Month/week/day over CalendarEvent/getOccurrences —
    // the server expands recurrence, the browser never does. The screen
    // carries its own caveats (the 256-candidate ceiling, the full-scan search)
    // rather than duplicating them into the nav where they would drift.
    status: "live",
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
    // Live as of s07 T3: the eight AddressBook/ContactCard methods now have a
    // browser path, and none of it needed server work. Its own caveats — the
    // unindexed search and the CardDAV group gap — are rendered by the section
    // itself (lib/contacts/cards.ts, lib/contacts/groups.ts) rather than
    // duplicated into the nav where they would drift.
    status: "live",
  },
  {
    id: "files",
    label: "Files",
    href: "/files",
    // Live as of s03.C T3. The wait named here was s03.B T3, the attachment
    // sidestep — it landed (`services/ingest/src/sidestep.ts`), so large
    // incoming attachments become FileNodes under an `Attachments` role
    // directory and the browser has a drive with something in it on day one.
    // Its own caveats — the `draft` scope the upload route demands, the
    // browser-side folders-first ordering, and the missing link back to the
    // message an attachment came from — are rendered by the section itself
    // (lib/files/scope.ts) rather than duplicated into the nav where they
    // would drift. `.feedback common/030` stays open, but nothing this
    // section does reaches `FileNode/copy`.
    status: "live",
  },
  {
    id: "search",
    label: "Search",
    href: "/search",
    // Live as of s07 T6, as the stub-that-names-its-limits: one query fans out
    // to mail (FTS5-indexed), contacts and calendar (full scans), and the page
    // itself declares what is indexed vs scanned vs not searched at all —
    // files, attachment contents — via `lib/search/scope.ts`, rather than
    // duplicating that coverage story into the nav where it would drift.
    status: "live",
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
