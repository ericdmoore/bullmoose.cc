// The Finder's one query path (s20 T5): compile the session to the SAME
// `Email/query` filter `/mail`'s search box builds (`../mail/search.ts`
// `buildEmailFilter`) and run it through the injected client's
// `queryThenGet`. No second JMAP client, no re-implemented filter — the
// Finder and the mail surface answer from one code path, so they cannot
// disagree about what `from:` or a date window means.
//
// v1 is DIRECTED FIND OVER YOUR OWN MAIL HISTORY — deliberately not the
// cross-realm fan-out `/search` used to render. The fan-out modules
// (`../search/plan.ts`, `../search/fanout.ts`) stay, tested, as the future
// MCP `search` tool's seam; the Finder's loop — refine, narrow, back out —
// only has mail semantics today (threads, senders, receivedAt windows), and
// pretending contacts rows can be narrowed by `has:attachment` would be the
// dishonest version. `FINDER_SCOPE_NOTE` says so on the page.
//
// FUTURE(s20-t5b): agent-directed refinement plugs in here — the s20 T5 "Ask"
// endgame runs this same module server-side through the MCP tool layer, with
// the agent choosing the next refinement instead of the human. `runFind` is
// already pure over an injected client for exactly that reason.

import type { JmapClient } from "../jmap/JmapClient";
import { buildEmailFilter } from "../mail/search";
import type { Email } from "../mail/types";
import { isBlank, toSearchSpec, type FinderSession } from "./session";

/**
 * Page size. One page, no pager, on purpose for v1: the Finder's answer to
 * "too many results" is a refinement chip, not page 7 — the loop IS the
 * product. `total` says what lies beyond the page, and the UI renders that
 * number next to an invitation to narrow.
 */
export const FINDER_PAGE_LIMIT = 50;

/** One result row — the projection the list and detail panes render. */
export interface FinderHit {
  id: string;
  threadId: string;
  subject: string;
  /** Display name if the server has one, else the address. */
  sender: string;
  senderEmail: string;
  /** ISO instant. */
  receivedAt: string;
  /** The server-computed snippet — the detail pane's honest "excerpt". */
  preview: string;
  hasAttachment: boolean;
}

export interface FinderResult {
  /** Newest first (the server's sort). */
  hits: FinderHit[];
  /** The server's `calculateTotal` — matches beyond the page exist. */
  total: number;
}

/** What this surface searches, and — as important — what it does not. The
 *  page renders this verbatim; a test holds that it names the boundary. */
export const FINDER_SCOPE_NOTE =
  "Finds in your mail history — subject, sender, recipients and full message bodies, matching whole words. " +
  "Contacts, calendar and files are not part of the find loop.";

/**
 * Run the session. A blank session (no text, no chips) queries NOTHING and
 * returns the empty result — "everything ever received" is browsing, and
 * `/mail` already does it better.
 */
export async function runFind(client: JmapClient, accountId: string, session: FinderSession): Promise<FinderResult> {
  if (isBlank(session)) return { hits: [], total: 0 };
  const filter = buildEmailFilter(toSearchSpec(session));
  const { query, get } = await client.queryThenGet(
    accountId,
    "Email/query",
    {
      filter,
      sort: [{ property: "receivedAt", isAscending: false }],
      limit: FINDER_PAGE_LIMIT,
      calculateTotal: true,
    },
    "Email/get",
    // Rows and the excerpt pane need no bodies: `preview` is server-computed.
    ["id", "threadId", "subject", "from", "receivedAt", "preview", "hasAttachment"],
  );
  const list = (get as { list?: Email[] }).list ?? [];
  const total = (query as { total?: number }).total;
  return {
    hits: list.map(toHit),
    total: typeof total === "number" ? total : list.length,
  };
}

export function toHit(email: Email): FinderHit {
  const from = email.from?.[0];
  return {
    id: email.id,
    threadId: email.threadId,
    subject: email.subject || "(no subject)",
    sender: from ? from.name || from.email : "(unknown sender)",
    senderEmail: from?.email ?? "",
    receivedAt: email.receivedAt,
    preview: email.preview ?? "",
    hasAttachment: email.hasAttachment === true,
  };
}
