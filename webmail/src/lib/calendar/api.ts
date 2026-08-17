// Every JMAP call `/calendar` makes, in one module.
//
// No second client: this composes the injected `JmapClient`
// (`../jmap/JmapClient.ts`), which already owns batching, back-references and
// computing `using[]` from the LIVE session — so a server without
// `urn:ietf:params:jmap:calendars` never receives a call it would 400
// (`capabilityForMethod`, `../jmap/capabilities.ts:75`).
//
// ⚠️ **The grid is drawn from `CalendarEvent/getOccurrences` and nothing else.**
// Recurrence is expanded ONCE, on the server, by `@bullmoose/calendar-core` —
// the implementation with ~100 tests and python-dateutil as an independent
// oracle, and the one CalDAV serves from (`services/anglebrackets/src/dav.ts`).
// A browser-side expander would be a second thing to be subtly wrong AND would
// disagree with Apple Calendar over the same account. `types.ts` explains why
// even the import is refused.
//
// Three calls in ONE round trip per window, and the middle one exists purely
// for honesty:
//   getOccurrences  the grid
//   query(total)    how many events REALLY overlap, so the 256-candidate
//                   ceiling is observable rather than a silently short month
//                   (`scope.ts`)
//   get(#ids)       the full blobs, back-referenced off the occurrence list —
//                   the editor needs `timeZone`, `duration` and
//                   `recurrenceRules`, none of which an occurrence carries

import { backReference, type JmapClient } from "../jmap/JmapClient";
import type { Invocation } from "../jmap/types";
import { CANDIDATE_EVENT_LIMIT, DEFAULT_OCCURRENCE_CAP, truncationOf, type Truncation } from "./scope";
import type { Calendar, CalendarEvent, Occurrence } from "./types";

export const CALENDAR_ACCOUNT_CAP = "urn:ietf:params:jmap:calendars";

/** A method-level refusal, translated into something a person can act on. */
export interface CalendarRefusal {
  type: string;
  description?: string;
  message: string;
}

export interface CalendarListResult {
  calendars: Calendar[];
  /** The account state — the `ifInState` for the next write. */
  state: string;
}

export async function loadCalendars(client: JmapClient, accountId: string): Promise<CalendarListResult> {
  const result = (await client.requestOne("Calendar/get", { accountId, ids: null })) as {
    list?: Calendar[];
    state?: string;
  };
  const calendars = [...(result.list ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  return { calendars, state: result.state ?? "" };
}

export interface WindowResult {
  occurrences: Occurrence[];
  /** Full blobs by event id, for the editor. */
  events: Record<string, CalendarEvent>;
  state: string;
  truncation: Truncation;
  /** Occurrences the server had before it applied the cap. */
  total: number;
}

export interface WindowRequest {
  after: string;
  before: string;
  maxOccurrences?: number;
  /** Restrict to one calendar (`getOccurrences` forwards it to the filter). */
  inCalendar?: string;
}

export async function loadWindow(client: JmapClient, accountId: string, req: WindowRequest): Promise<WindowResult> {
  const cap = req.maxOccurrences ?? DEFAULT_OCCURRENCE_CAP;
  const window = { after: req.after, before: req.before };

  const calls: Invocation[] = [
    [
      "CalendarEvent/getOccurrences",
      {
        accountId,
        ...window,
        maxOccurrences: cap,
        ...(req.inCalendar ? { inCalendar: req.inCalendar } : {}),
      },
      "o",
    ],
    [
      "CalendarEvent/query",
      {
        accountId,
        filter: { ...window, ...(req.inCalendar ? { inCalendar: req.inCalendar } : {}) },
        calculateTotal: true,
        // The ids are unused — `total` is the whole point of this call.
        limit: 1,
      },
      "q",
    ],
    [
      "CalendarEvent/get",
      {
        accountId,
        // Duplicated ids for a recurring series are harmless: `getCalendarEvents`
        // answers each id once.
        "#ids": backReference("o", "CalendarEvent/getOccurrences", "/list/*/eventId"),
      },
      "g",
    ],
  ];

  const responses = await client.request(calls);
  const occResp = pick(responses, "o");
  if (!occResp || occResp[0] === "error") {
    throw new Error(refusalOf(occResp?.[1] as { type?: string; description?: string }).message);
  }
  const occ = occResp[1] as { list?: Occurrence[]; total?: number };

  // The other two are best-effort: a window still renders without the honesty
  // count or the blobs, and failing the whole load over either would be worse.
  const queryResp = pick(responses, "q");
  const matchingEvents = queryResp && queryResp[0] !== "error" ? (queryResp[1] as { total?: number }).total : undefined;

  const getResp = pick(responses, "g");
  const events: Record<string, CalendarEvent> = {};
  let state = "";
  if (getResp && getResp[0] !== "error") {
    const body = getResp[1] as { list?: CalendarEvent[]; state?: string };
    for (const ev of body.list ?? []) events[ev.id] = ev;
    state = body.state ?? "";
  }

  const list = occ.list ?? [];
  return {
    occurrences: list,
    events,
    state,
    total: occ.total ?? list.length,
    truncation: truncationOf(occ.total ?? list.length, cap, matchingEvents),
  };
}

/**
 * Text search over events. Deliberately a plain `query` + `get`, with no
 * paging UI behind it: the server matches with a full-scan `LIKE` and clamps
 * every request to 256 rows (`scope.ts`), so an interface implying an
 * exhaustible result set would be a lie about what is behind it.
 */
export async function searchEvents(
  client: JmapClient,
  accountId: string,
  text: string,
  limit = 50,
): Promise<{ events: CalendarEvent[]; total: number; clamped: boolean }> {
  const { query, get } = await client.queryThenGet(
    accountId,
    "CalendarEvent/query",
    {
      filter: { text },
      sort: [{ property: "start", isAscending: false }],
      limit: Math.min(limit, CANDIDATE_EVENT_LIMIT),
      calculateTotal: true,
    },
    "CalendarEvent/get",
  );
  const total = (query as { total?: number }).total ?? 0;
  return {
    events: (get as { list?: CalendarEvent[] }).list ?? [],
    total,
    clamped: total > limit,
  };
}

// ── writes ────────────────────────────────────────────────────────────────

export interface SetOutcome {
  createdId?: string;
  updatedIds: string[];
  destroyedIds: string[];
  /** Per-id failures: the call ran, some ids did not apply. */
  problems: Array<{ id: string; type: string; description?: string }>;
  /** The WHOLE call was refused — scope, or a stale `ifInState`. */
  refusal?: CalendarRefusal;
  newState?: string;
}

export interface WriteOptions {
  /**
   * Optimistic concurrency, same shape the mail surface uses
   * (`../mail/triage.ts:126`). The server compares it against the account
   * state and throws `stateMismatch` for the whole call rather than writing
   * half of it (`services/jmap/src/methods/calendars.ts:204-206`) — so a
   * second tab that moved an event underneath you cannot be clobbered.
   */
  ifInState?: string;
}

export async function createEvent(
  client: JmapClient,
  accountId: string,
  spec: Record<string, unknown>,
  opts: WriteOptions = {},
): Promise<SetOutcome> {
  return eventSet(client, accountId, { create: { draft: spec } }, opts);
}

export async function updateEvent(
  client: JmapClient,
  accountId: string,
  id: string,
  patch: Record<string, unknown>,
  opts: WriteOptions = {},
): Promise<SetOutcome> {
  // An empty PatchObject is a no-op the server would still count as a write;
  // skip the round trip and the changelog entry.
  if (Object.keys(patch).length === 0) {
    return { updatedIds: [], destroyedIds: [], problems: [] };
  }
  return eventSet(client, accountId, { update: { [id]: patch } }, opts);
}

export async function destroyEvent(
  client: JmapClient,
  accountId: string,
  id: string,
  opts: WriteOptions = {},
): Promise<SetOutcome> {
  return eventSet(client, accountId, { destroy: [id] }, opts);
}

async function eventSet(
  client: JmapClient,
  accountId: string,
  args: Record<string, unknown>,
  opts: WriteOptions,
): Promise<SetOutcome> {
  const call: Record<string, unknown> = { accountId, ...args };
  if (opts.ifInState) call.ifInState = opts.ifInState;

  const [response] = await client.request([["CalendarEvent/set", call, "s0"]]);
  if (!response) return { updatedIds: [], destroyedIds: [], problems: [] };

  if (response[0] === "error") {
    return {
      updatedIds: [],
      destroyedIds: [],
      problems: [],
      refusal: refusalOf(response[1] as { type?: string; description?: string }),
    };
  }

  const body = response[1] as {
    created?: Record<string, { id?: string }>;
    notCreated?: Record<string, SetErrorBody>;
    updated?: Record<string, unknown>;
    notUpdated?: Record<string, SetErrorBody>;
    destroyed?: string[];
    notDestroyed?: Record<string, SetErrorBody>;
    newState?: string;
  };

  const problems = [
    ...flattenErrors(body.notCreated),
    ...flattenErrors(body.notUpdated),
    ...flattenErrors(body.notDestroyed),
  ];
  const createdId = Object.values(body.created ?? {})[0]?.id;

  return {
    ...(createdId ? { createdId } : {}),
    updatedIds: Object.keys(body.updated ?? {}),
    destroyedIds: body.destroyed ?? [],
    problems,
    ...(body.newState ? { newState: body.newState } : {}),
  };
}

interface SetErrorBody {
  type?: string;
  description?: string;
  properties?: string[];
}

function flattenErrors(
  errors: Record<string, SetErrorBody> | undefined,
): Array<{ id: string; type: string; description?: string }> {
  return Object.entries(errors ?? {}).map(([id, err]) => ({
    id,
    type: err?.type ?? "unknown",
    ...(err?.description ? { description: err.description } : {}),
  }));
}

/**
 * Turn a method-level error into a sentence. Same job as mail's
 * `describeRefusal` (`../mail/triage.ts:200`), different vocabulary: calendar
 * writes need the `calendar` scope (`calendars.ts:200`) and there is no
 * per-operation split to name.
 */
export function refusalOf(detail: { type?: string; description?: string } | undefined): CalendarRefusal {
  const type = detail?.type ?? "error";
  const message =
    type === "forbidden"
      ? "This session is not allowed to change calendars. The action needs the “calendar” permission; the token in use does not have it."
      : type === "stateMismatch"
        ? "The calendar changed while you were editing. Reload and try again — nothing was written."
        : type === "unknownMethod" || type === "unknownCapability"
          ? "This server does not serve calendars."
          : detail?.description || `The server refused: ${type}.`;
  return {
    type,
    ...(detail?.description ? { description: detail.description } : {}),
    message,
  };
}

function pick(responses: Invocation[], callId: string): Invocation | undefined {
  return responses.find((r) => r[2] === callId);
}
