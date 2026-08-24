// The first two connectors' READ surface (#4).
//
// Deliberately read-only, and deliberately small. A connector that can
// write into someone's Notion or calendar on an agent's judgement is a
// different authority conversation (and, for anything money-shaped, the
// s33 ceremony's) — reads are what make an agent USEFUL at drafting, which
// is the value Eric named: "both very useful to me".
//
// Each function normalizes the provider's shape into one this codebase
// already speaks, because the alternative — handing raw provider JSON to a
// model — spends context on envelopes and teaches the agent a vocabulary
// that changes when the vendor feels like it.

import { callProvider, type ConnectorRequest } from "./connectors.js";
import type { Env } from "./models.js";

type Ctx = Omit<ConnectorRequest, "path" | "method" | "body">;

export interface UpcomingEvent {
  id: string;
  title: string;
  start: string | null;
  end: string | null;
  /** Google's own word: "confirmed" | "tentative" | "cancelled". */
  status: string;
  attendees: number;
}

/**
 * The next N events from a Google calendar. `singleEvents=true` expands
 * recurrences into instances — without it a weekly standup arrives as ONE
 * master event with a rule, which is correct data and useless for "what is
 * on today".
 */
export async function upcomingEvents(
  env: Env,
  ctx: Ctx,
  opts: { calendarId?: string; max?: number; fromISO?: string } = {},
): Promise<{ events: UpcomingEvent[] } | { error: string }> {
  const calendarId = encodeURIComponent(opts.calendarId ?? "primary");
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(Math.min(Math.max(opts.max ?? 10, 1), 50)),
    timeMin: opts.fromISO ?? new Date().toISOString(),
  });
  const res = await callProvider(env, "google-calendar", {
    ...ctx,
    path: `/calendar/v3/calendars/${calendarId}/events?${params.toString()}`,
  });
  if (res.status !== 200) return { error: errorOf(res.json, `Google Calendar refused (${res.status})`) };
  const items = (res.json as { items?: unknown[] })?.items ?? [];
  return {
    events: items.filter(isObject).map((raw) => {
      const e = raw as Record<string, Record<string, string> | string | unknown[] | undefined>;
      return {
        id: String(e.id ?? ""),
        title: typeof e.summary === "string" ? e.summary : "(no title)",
        // dateTime for timed events, date for all-day — reporting one and
        // silently dropping the other loses every all-day event, which is
        // most of what a calendar is used for.
        start: stampOf(e.start),
        end: stampOf(e.end),
        status: typeof e.status === "string" ? e.status : "confirmed",
        attendees: Array.isArray(e.attendees) ? e.attendees.length : 0,
      };
    }),
  };
}

export interface NotionHit {
  id: string;
  title: string;
  url: string;
  lastEdited: string | null;
}

/**
 * Notion search, normalized. Notion returns title as an array of rich-text
 * runs under a property whose NAME varies per database, so "the title" is a
 * small excavation rather than a field read — and a connector that skipped
 * it would hand the model `{"properties":{"Name":{"title":[{"plain_text":…`
 * and let it guess.
 */
export async function notionSearch(
  env: Env,
  ctx: Ctx,
  opts: { query: string; max?: number },
): Promise<{ hits: NotionHit[] } | { error: string }> {
  const res = await callProvider(env, "notion", {
    ...ctx,
    path: "/v1/search",
    method: "POST",
    body: { query: opts.query, page_size: Math.min(Math.max(opts.max ?? 10, 1), 50) },
  });
  if (res.status !== 200) return { error: errorOf(res.json, `Notion refused (${res.status})`) };
  const results = (res.json as { results?: unknown[] })?.results ?? [];
  return {
    hits: results.filter(isObject).map((raw) => {
      const p = raw as Record<string, unknown>;
      return {
        id: String(p.id ?? ""),
        title: notionTitle(p),
        url: typeof p.url === "string" ? p.url : "",
        lastEdited: typeof p.last_edited_time === "string" ? p.last_edited_time : null,
      };
    }),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Google's start/end: `{dateTime}` for timed, `{date}` for all-day. */
function stampOf(v: unknown): string | null {
  if (!isObject(v)) return null;
  if (typeof v.dateTime === "string") return v.dateTime;
  if (typeof v.date === "string") return v.date;
  return null;
}

/** The title, wherever Notion put it — page titles live under a `title`
 *  property whose key is database-defined; databases carry a top-level one. */
function notionTitle(page: Record<string, unknown>): string {
  const fromRuns = (runs: unknown): string =>
    Array.isArray(runs)
      ? runs
          .filter(isObject)
          .map((r) => (typeof r.plain_text === "string" ? r.plain_text : ""))
          .join("")
      : "";
  if (Array.isArray(page.title)) {
    const t = fromRuns(page.title);
    if (t) return t;
  }
  const props = isObject(page.properties) ? page.properties : {};
  for (const value of Object.values(props)) {
    if (isObject(value) && value.type === "title") {
      const t = fromRuns(value.title);
      if (t) return t;
    }
  }
  return "(untitled)";
}

/** A provider's own error message beats ours, when it has one. */
function errorOf(body: unknown, fallback: string): string {
  if (isObject(body)) {
    if (typeof body.error === "string") return body.error;
    if (isObject(body.error) && typeof body.error.message === "string") return body.error.message;
    if (typeof body.message === "string") return body.message;
  }
  return fallback;
}
