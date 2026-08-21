/** @jsxImportSource preact */
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { resolveClient } from "../lib/app/client";
import {
  createEvent,
  destroyEvent,
  loadCalendars,
  loadWindow,
  refusalOf,
  searchEvents,
  updateEvent,
  type CalendarRefusal,
} from "../lib/calendar/api";
import { browserTimeZone, dayKey, formatClock, parseDayKey, sameDay, type CivilDate } from "../lib/calendar/civil";
import {
  DAY_CODES,
  DAY_LABELS,
  REPEAT_CHOICES,
  describeRules,
  draftFromEvent,
  draftToCreate,
  draftToPatch,
  newDraft,
  validateDraft,
  type DayCode,
  type EventDraft,
} from "../lib/calendar/draft";
import {
  MAX_SPILL_IN_DAYS,
  gridDays,
  gridTitle,
  isInPeriod,
  queryWindow,
  shiftGrid,
  weekdayHeadings,
  windowKey,
  withView,
  type GridSpec,
  type ViewKind,
} from "../lib/calendar/grid";
import { MINUTES_PER_DAY, layoutDay, segmentsByDay, segmentsOn, type DaySegment } from "../lib/calendar/place";
import { EVENT_SEARCH_SCOPE_NOTE, describeTruncation, isTruncated, spillInNote } from "../lib/calendar/scope";
import type { Calendar, CalendarEvent, Occurrence } from "../lib/calendar/types";
import { CALENDARS_CAP, hasCapability } from "../lib/jmap/capabilities";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Session } from "../lib/jmap/types";

// The calendar section (s07 T3). One island, and a deliberately THIN one.
//
// Every rule lives in `lib/calendar/*` as a pure function with tests — the
// split s03.C settled on and `AgentConsole.tsx:35-39` restates: vitest runs in
// plain Node with no jsdom (`vitest.config.ts` `environment: "node"`), so a
// `.tsx` holding a rule is a rule with no test. Date arithmetic especially: a
// calendar that renders the wrong week is invisible to a green suite, so
// `civil.ts`, `grid.ts` and `place.ts` are where the week is decided and this
// file only asks them.
//
// ⚠️ Nothing here expands a recurrence rule, and nothing here may learn to.
// The grid is `CalendarEvent/getOccurrences` output (`api.ts`); the server
// expands once, through `@bullmoose/calendar-core`, which is the copy with an
// independent oracle behind it and the copy CalDAV serves.

interface Props {
  /** Injected in tests; the screen resolves its own otherwise. */
  client?: JmapClient;
  /** Fixes "today" for a deterministic first render. */
  now?: number;
}

const VIEWS: ViewKind[] = ["month", "week", "day"];

export default function CalendarView({ client: injectedClient, now }: Props) {
  const viewerZone = useMemo(() => browserTimeZone(), []);
  const today = useMemo<CivilDate>(() => {
    // "Today" is a civil date in the VIEWER's zone, not UTC — the highlight
    // must match the day the user believes it is.
    const parts = new Date(now ?? Date.now());
    const key = new Intl.DateTimeFormat("en-CA", {
      timeZone: viewerZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(parts);
    return (
      parseDayKey(key) ?? {
        year: parts.getUTCFullYear(),
        month: parts.getUTCMonth() + 1,
        day: parts.getUTCDate(),
      }
    );
  }, [now, viewerZone]);

  const [client, setClient] = useState<JmapClient | undefined>(injectedClient);
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [accountId, setAccountId] = useState<string>("");
  const [isDemo, setIsDemo] = useState(false);
  const [fatal, setFatal] = useState<string | undefined>(undefined);

  // Anchored on TODAY, not on the 1st: a month grid ignores the anchor's day
  // (`gridDays`), and keeping it is what lets "Week" land on this week.
  const [spec, setSpec] = useState<GridSpec>(() => ({
    kind: "month",
    anchor: today,
    weekStartsOn: 0,
  }));
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  const [events, setEvents] = useState<Record<string, CalendarEvent>>({});
  const [state, setState] = useState<string>("");
  const [truncNote, setTruncNote] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [refusal, setRefusal] = useState<CalendarRefusal | undefined>(undefined);

  const [draft, setDraft] = useState<EventDraft | undefined>(undefined);
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const [searchInput, setSearchInput] = useState("");
  const [searchHits, setSearchHits] = useState<CalendarEvent[] | undefined>(undefined);

  // ── bootstrap ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let jmap = injectedClient;
        if (!jmap) {
          const resolved = resolveClient();
          // Same rule as every other section: no session → the door, never a
          // convincing sample calendar a stranger could mistake for theirs
          // (`lib/app/client.ts`).
          if (resolved.mode === "unauthenticated") {
            location.assign("/login");
            return;
          }
          if (resolved.mode === "demo") {
            // Demo-only, and loaded on demand so the fake calendar — including
            // its canned occurrences and its zone arithmetic — is never in a
            // live bundle. See `lib/calendar/demoCalendar.ts`.
            const { installDemoCalendar } = await import("../lib/calendar/demoCalendar");
            installDemoCalendar(resolved.demo.client, now ?? Date.now());
            if (!cancelled) setIsDemo(true);
          }
          jmap = resolved.client;
        }
        const live = await jmap.session();
        if (cancelled) return;
        setSession(live);
        setClient(jmap);
        // `primaryAccounts` is keyed by capability; a server without the
        // calendars cap has no calendar account and the gate below renders
        // instead of a screen that would 400 on every call.
        if (hasCapability(live, CALENDARS_CAP)) {
          setAccountId(live.primaryAccounts[CALENDARS_CAP] ?? Object.keys(live.accounts)[0] ?? "");
        }
      } catch (err) {
        if (!cancelled) setFatal(message(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [injectedClient, now]);

  // ── calendars ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!client || !accountId) return;
    let cancelled = false;
    void loadCalendars(client, accountId)
      .then((res) => {
        if (cancelled) return;
        setCalendars(res.calendars);
      })
      .catch((err) => {
        if (!cancelled) setFatal(message(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, accountId]);

  const days = useMemo(() => gridDays(spec), [spec]);
  const key = windowKey(spec);

  const reload = useCallback(async () => {
    if (!client || !accountId) return;
    setLoading(true);
    try {
      const window = queryWindow(gridDays(spec));
      const res = await loadWindow(client, accountId, window);
      setOccurrences(res.occurrences);
      setEvents(res.events);
      setState(res.state);
      setTruncNote(isTruncated(res.truncation) ? describeTruncation(res.truncation, res.occurrences.length) : "");
    } catch (err) {
      setFatal(message(err));
    } finally {
      setLoading(false);
    }
  }, [client, accountId, spec]);

  useEffect(() => {
    void reload();
    // `key` rather than `spec`: paging to the same period must not refetch.
  }, [reload, key]);

  const visible = useMemo(() => occurrences.filter((o) => !hidden.has(o.calendarId)), [occurrences, hidden]);
  const byDay = useMemo(() => segmentsByDay(visible, viewerZone), [visible, viewerZone]);
  const calendarById = useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars]);

  // ── editing ─────────────────────────────────────────────────────────────
  const openNew = (day: CivilDate): void => {
    const calendarId = calendars.find((c) => c.isDefault)?.id ?? calendars[0]?.id ?? "";
    setProblems([]);
    setRefusal(undefined);
    setDraft(newDraft(day, calendarId, viewerZone));
  };

  const openExisting = (eventId: string): void => {
    const event = events[eventId];
    if (!event) return;
    const next = draftFromEvent(event, calendars[0]?.id ?? "");
    if (!next) return;
    setProblems([]);
    setRefusal(undefined);
    setDraft(next);
  };

  const save = async (): Promise<void> => {
    if (!client || !accountId || !draft) return;
    const found = validateDraft(draft);
    setProblems(found);
    if (found.length > 0) return;
    setSaving(true);
    setRefusal(undefined);
    try {
      // `ifInState` on every write: the account state we rendered from. A
      // second tab that moved this event underneath us gets a `stateMismatch`
      // for the whole call rather than a silent clobber (`api.ts`).
      const original = draft.id ? events[draft.id] : undefined;
      const outcome =
        draft.id && original
          ? await updateEvent(client, accountId, draft.id, draftToPatch(draft, original), {
              ifInState: state,
            })
          : await createEvent(client, accountId, draftToCreate(draft), { ifInState: state });

      if (outcome.refusal) {
        setRefusal(outcome.refusal);
        return;
      }
      if (outcome.problems.length > 0) {
        setProblems(outcome.problems.map((p) => p.description ?? `The server refused: ${p.type}.`));
        return;
      }
      setDraft(undefined);
      setNotice(draft.id ? "Saved." : "Event created.");
      await reload();
    } catch (err) {
      setRefusal(refusalOf({ type: "error", description: message(err) }));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!client || !accountId || !draft?.id) return;
    setSaving(true);
    try {
      const outcome = await destroyEvent(client, accountId, draft.id, { ifInState: state });
      if (outcome.refusal) {
        setRefusal(outcome.refusal);
        return;
      }
      setDraft(undefined);
      setNotice("Event deleted.");
      await reload();
    } catch (err) {
      setRefusal(refusalOf({ type: "error", description: message(err) }));
    } finally {
      setSaving(false);
    }
  };

  const runSearch = async (ev: Event): Promise<void> => {
    ev.preventDefault();
    if (!client || !accountId) return;
    if (!searchInput.trim()) {
      setSearchHits(undefined);
      return;
    }
    try {
      const res = await searchEvents(client, accountId, searchInput.trim());
      setSearchHits(res.events);
    } catch (err) {
      setFatal(message(err));
    }
  };

  // ── refusals that are not screens ───────────────────────────────────────
  if (fatal) {
    return (
      <div class="cal">
        <p class="cal-fatal">{fatal}</p>
      </div>
    );
  }
  if (!session) {
    return (
      <div class="cal">
        <p class="muted">Loading…</p>
      </div>
    );
  }
  if (!hasCapability(session, CALENDARS_CAP)) {
    // The capability gate, same shape as the agent seam
    // (`AppShell.tsx:591`): a server that does not advertise calendars gets a
    // sentence, not a screen full of empty grid.
    return (
      <div class="cal">
        <p class="cal-fatal">
          This account’s server does not advertise <code>{CALENDARS_CAP}</code>, so there is no calendar to show.
          Nothing is broken — this build simply has no calendar realm.
        </p>
      </div>
    );
  }

  return (
    <div class="cal">
      <header class="cal-bar">
        <div class="cal-nav">
          <button type="button" onClick={() => setSpec(shiftGrid(spec, -1))} aria-label="Previous">
            ‹
          </button>
          <button type="button" onClick={() => setSpec({ ...spec, anchor: today })}>
            Today
          </button>
          <button type="button" onClick={() => setSpec(shiftGrid(spec, 1))} aria-label="Next">
            ›
          </button>
          <h1 class="cal-title">{gridTitle(spec)}</h1>
        </div>

        <div class="cal-views" role="group" aria-label="View">
          {VIEWS.map((v) => (
            <button
              type="button"
              class={v === spec.kind ? "cal-view cal-view-on" : "cal-view"}
              aria-pressed={v === spec.kind}
              onClick={() => setSpec(withView(spec, v))}
            >
              {v[0]!.toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>

        <form class="cal-search" onSubmit={(ev) => void runSearch(ev)}>
          <input
            type="search"
            value={searchInput}
            aria-describedby="cal-search-scope"
            placeholder="Search events"
            onInput={(ev) => setSearchInput((ev.currentTarget as HTMLInputElement).value)}
          />
          {searchHits ? (
            <button
              type="button"
              class="link-button"
              onClick={() => {
                setSearchInput("");
                setSearchHits(undefined);
              }}
            >
              Clear
            </button>
          ) : null}
        </form>
      </header>

      {/* Search honesty, the `common/004` pattern: what the server really
          matches, next to the box that implies otherwise (`scope.ts`). */}
      <p id="cal-search-scope" class="cal-note">
        {EVENT_SEARCH_SCOPE_NOTE}
      </p>

      <div class="cal-body">
        <aside class="cal-side">
          <h2>Calendars</h2>
          <ul class="cal-list">
            {calendars.map((c) => (
              <li>
                <label>
                  <input
                    type="checkbox"
                    checked={!hidden.has(c.id)}
                    onChange={() => {
                      const next = new Set(hidden);
                      if (next.has(c.id)) next.delete(c.id);
                      else next.add(c.id);
                      setHidden(next);
                    }}
                  />
                  <span class="cal-swatch" style={{ background: c.color ?? "var(--accent)" }} />
                  <span>{c.name}</span>
                  {c.isDefault ? <span class="muted"> · default</span> : null}
                </label>
              </li>
            ))}
            {calendars.length === 0 && !loading ? <li class="muted">No calendars.</li> : null}
          </ul>
          {/* Visibility is a local filter, not `Calendar/set isSubscribed`:
              this screen does not write calendars, and pretending a checkbox
              were a server round trip would be the second kind of lie
              `scope.ts` is about. */}
          <p class="muted cal-fine">Hiding a calendar filters this view only.</p>

          <button type="button" class="cal-primary" onClick={() => openNew(today)}>
            New event
          </button>

          <p class="muted cal-fine">
            Times shown in <code>{viewerZone}</code>.
          </p>
          <p class="muted cal-fine">{spillInNote(MAX_SPILL_IN_DAYS)}</p>
          {isDemo ? (
            <p class="cal-warn cal-fine">
              Demo data. The fake server returns canned occurrences and does not expand recurrence rules — a repeating
              event you create here shows only its first occurrence. The real server expands them.
            </p>
          ) : null}
        </aside>

        <section class="cal-grid-wrap">
          {truncNote ? <p class="cal-warn">{truncNote}</p> : null}
          {notice ? (
            <p class="cal-notice" onClick={() => setNotice(undefined)}>
              {notice}
            </p>
          ) : null}

          {searchHits ? (
            <SearchResults
              hits={searchHits}
              onOpen={(id) => {
                const hit = searchHits.find((h) => h.id === id);
                if (hit) {
                  setEvents((prev) => ({ ...prev, [id]: hit }));
                  const next = draftFromEvent(hit, calendars[0]?.id ?? "");
                  if (next) {
                    setProblems([]);
                    setDraft(next);
                  }
                }
              }}
            />
          ) : spec.kind === "month" ? (
            <MonthGrid
              spec={spec}
              days={days}
              today={today}
              byDay={byDay}
              colorOf={(id) => calendarById.get(id)?.color ?? null}
              onOpen={openExisting}
              onNew={openNew}
            />
          ) : (
            <TimeGrid
              days={days}
              today={today}
              byDay={byDay}
              weekStartsOn={spec.weekStartsOn}
              colorOf={(id) => calendarById.get(id)?.color ?? null}
              onOpen={openExisting}
              onNew={openNew}
            />
          )}
          {loading ? <p class="muted">Loading…</p> : null}
        </section>

        {draft ? (
          <EventEditor
            draft={draft}
            calendars={calendars}
            problems={problems}
            refusal={refusal}
            saving={saving}
            onChange={setDraft}
            onSave={() => void save()}
            onDelete={() => void remove()}
            onCancel={() => setDraft(undefined)}
          />
        ) : null}
      </div>
    </div>
  );
}

// ── month ─────────────────────────────────────────────────────────────────

function MonthGrid(props: {
  spec: GridSpec;
  days: CivilDate[];
  today: CivilDate;
  byDay: Map<string, DaySegment[]>;
  colorOf: (calendarId: string) => string | null;
  onOpen: (eventId: string) => void;
  onNew: (day: CivilDate) => void;
}) {
  const { spec, days, today, byDay, colorOf, onOpen, onNew } = props;
  return (
    <div class="cal-month">
      <div class="cal-month-head">
        {weekdayHeadings(spec.weekStartsOn).map((h) => (
          <div class="cal-dow">{h}</div>
        ))}
      </div>
      <div class="cal-month-grid">
        {days.map((day) => {
          const segments = segmentsOn(byDay, day);
          const classes = [
            "cal-cell",
            isInPeriod(spec, day) ? "" : "cal-cell-out",
            sameDay(day, today) ? "cal-cell-today" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div class={classes}>
              <button type="button" class="cal-daynum" onClick={() => onNew(day)} title="New event">
                {day.day}
              </button>
              <ul class="cal-chips">
                {segments.map((s) => (
                  <li>
                    <button
                      type="button"
                      class={s.allDay ? "cal-chip cal-chip-allday" : "cal-chip"}
                      style={{ borderLeftColor: colorOf(s.calendarId) ?? "var(--accent)" }}
                      onClick={() => onOpen(s.eventId)}
                    >
                      {s.allDay ? null : <span class="cal-chip-time">{formatClock(s.fromMinute)}</span>}
                      <span class="cal-chip-title">{s.title}</span>
                      {s.continuesAfter ? <span class="cal-chip-more">›</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── week / day ────────────────────────────────────────────────────────────

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function TimeGrid(props: {
  days: CivilDate[];
  today: CivilDate;
  byDay: Map<string, DaySegment[]>;
  weekStartsOn: 0 | 1;
  colorOf: (calendarId: string) => string | null;
  onOpen: (eventId: string) => void;
  onNew: (day: CivilDate) => void;
}) {
  const { days, today, byDay, colorOf, onOpen, onNew } = props;
  return (
    <div class="cal-time">
      <div class="cal-time-head" style={{ gridTemplateColumns: `4rem repeat(${days.length}, 1fr)` }}>
        <div />
        {days.map((day) => (
          <button
            type="button"
            class={sameDay(day, today) ? "cal-time-day cal-time-today" : "cal-time-day"}
            onClick={() => onNew(day)}
          >
            {dayKey(day).slice(5)}
          </button>
        ))}
      </div>

      {/* All-day band: its own row, above the hours. An all-day event has no
          time of day, so placing it in the hour grid would require inventing
          one — see `place.ts`. */}
      <div class="cal-allday" style={{ gridTemplateColumns: `4rem repeat(${days.length}, 1fr)` }}>
        <div class="cal-time-gutter">all-day</div>
        {days.map((day) => (
          <div class="cal-allday-cell">
            {segmentsOn(byDay, day)
              .filter((s) => s.allDay)
              .map((s) => (
                <button
                  type="button"
                  class="cal-chip cal-chip-allday"
                  style={{ borderLeftColor: colorOf(s.calendarId) ?? "var(--accent)" }}
                  onClick={() => onOpen(s.eventId)}
                >
                  {s.title}
                </button>
              ))}
          </div>
        ))}
      </div>

      <div class="cal-time-body" style={{ gridTemplateColumns: `4rem repeat(${days.length}, 1fr)` }}>
        <div class="cal-hours">
          {HOURS.map((h) => (
            <div class="cal-hour">
              <span>{formatClock(h * 60)}</span>
            </div>
          ))}
        </div>
        {days.map((day) => {
          const laid = layoutDay(segmentsOn(byDay, day));
          return (
            <div class="cal-daycol" onDblClick={() => onNew(day)}>
              {HOURS.map(() => (
                <div class="cal-hour" />
              ))}
              {laid.map(({ segment, column, columns }) => (
                <button
                  type="button"
                  class="cal-event"
                  style={{
                    top: `${(segment.fromMinute / MINUTES_PER_DAY) * 100}%`,
                    height: `${(Math.max(15, segment.toMinute - segment.fromMinute) / MINUTES_PER_DAY) * 100}%`,
                    left: `${(column / columns) * 100}%`,
                    width: `${100 / columns}%`,
                    borderLeftColor: colorOf(segment.calendarId) ?? "var(--accent)",
                  }}
                  onClick={() => onOpen(segment.eventId)}
                >
                  <span class="cal-chip-time">
                    {segment.continuesBefore ? "‹ " : ""}
                    {formatClock(segment.fromMinute)}
                  </span>
                  <span class="cal-chip-title">{segment.title}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── search results ────────────────────────────────────────────────────────

function SearchResults(props: { hits: CalendarEvent[]; onOpen: (id: string) => void }) {
  if (props.hits.length === 0) return <p class="muted">No events matched.</p>;
  return (
    <ul class="cal-hits">
      {props.hits.map((e) => (
        <li>
          <button type="button" onClick={() => props.onOpen(e.id)}>
            <strong>{typeof e.title === "string" && e.title ? e.title : "(no title)"}</strong>
            <span class="muted"> · {String(e.start ?? "")}</span>
            {e.recurrenceRules ? <span class="muted"> · {describeRules(e.recurrenceRules)}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

// ── editor ────────────────────────────────────────────────────────────────

function EventEditor(props: {
  draft: EventDraft;
  calendars: Calendar[];
  problems: string[];
  refusal?: CalendarRefusal;
  saving: boolean;
  onChange: (d: EventDraft) => void;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const { draft, calendars, problems, refusal, saving, onChange } = props;
  const set = <K extends keyof EventDraft>(k: K, v: EventDraft[K]): void => onChange({ ...draft, [k]: v });
  const setRepeat = <K extends keyof EventDraft["repeat"]>(k: K, v: EventDraft["repeat"][K]): void =>
    onChange({ ...draft, repeat: { ...draft.repeat, [k]: v } });

  return (
    <aside class="cal-editor" aria-label={draft.id ? "Edit event" : "New event"}>
      <h2>{draft.id ? "Edit event" : "New event"}</h2>

      {refusal ? <p class="cal-error">{refusal.message}</p> : null}
      {problems.length > 0 ? (
        <ul class="cal-error">
          {problems.map((p) => (
            <li>{p}</li>
          ))}
        </ul>
      ) : null}

      <label>
        Title
        <input
          type="text"
          value={draft.title}
          onInput={(ev) => set("title", (ev.currentTarget as HTMLInputElement).value)}
        />
      </label>

      <label>
        Calendar
        <select
          value={draft.calendarId}
          onChange={(ev) => set("calendarId", (ev.currentTarget as HTMLSelectElement).value)}
        >
          {calendars.map((c) => (
            <option value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>

      <label class="cal-inline">
        <input
          type="checkbox"
          checked={draft.allDay}
          onChange={(ev) => set("allDay", (ev.currentTarget as HTMLInputElement).checked)}
        />
        All day
      </label>

      <div class="cal-when">
        <label>
          Starts
          <input
            type="date"
            value={draft.startDate}
            onInput={(ev) => set("startDate", (ev.currentTarget as HTMLInputElement).value)}
          />
        </label>
        {draft.allDay ? null : (
          <label>
            <span class="visually-hidden">Start time</span>
            <input
              type="time"
              value={draft.startTime}
              onInput={(ev) => set("startTime", (ev.currentTarget as HTMLInputElement).value)}
            />
          </label>
        )}
        <label>
          {draft.allDay ? "Last day" : "Ends"}
          <input
            type="date"
            value={draft.endDate}
            onInput={(ev) => set("endDate", (ev.currentTarget as HTMLInputElement).value)}
          />
        </label>
        {draft.allDay ? null : (
          <label>
            <span class="visually-hidden">End time</span>
            <input
              type="time"
              value={draft.endTime}
              onInput={(ev) => set("endTime", (ev.currentTarget as HTMLInputElement).value)}
            />
          </label>
        )}
      </div>

      <p class="muted cal-fine">
        {draft.allDay ? (
          <>
            All-day events carry a date, not a moment — this one is stored floating (<code>Etc/UTC</code>, the way
            CalDAV stores <code>VALUE=DATE</code>) and shows on the same date in every timezone.
          </>
        ) : (
          <>
            Times are in <code>{draft.timeZone}</code>.
          </>
        )}
      </p>

      <label>
        Location
        <input
          type="text"
          value={draft.location}
          onInput={(ev) => set("location", (ev.currentTarget as HTMLInputElement).value)}
        />
      </label>

      <label>
        Notes
        <textarea
          rows={3}
          value={draft.description}
          onInput={(ev) => set("description", (ev.currentTarget as HTMLTextAreaElement).value)}
        />
      </label>

      {draft.frozenRules ? (
        /* The rule is outside what this form can express, so it is shown and
           NOT touched — `draftToPatch` omits `recurrenceRules` entirely and the
           server leaves the stored value alone. Flattening someone's
           "last Friday of the month" into "monthly" because the editor has no
           control for it would be a data-loss bug wearing a save button. */
        <div class="cal-frozen">
          <strong>Repeats:</strong> {describeRules(draft.frozenRules)}
          <p class="muted cal-fine">
            This repeat rule is more specific than this editor can express, so it is left exactly as it is. Everything
            else here is still editable. Change the rule in a CalDAV client.
          </p>
        </div>
      ) : (
        <fieldset class="cal-repeat">
          <legend>Repeat</legend>
          <select
            value={draft.repeat.frequency}
            onChange={(ev) =>
              setRepeat("frequency", (ev.currentTarget as HTMLSelectElement).value as EventDraft["repeat"]["frequency"])
            }
          >
            {REPEAT_CHOICES.map((c) => (
              <option value={c.value}>{c.label}</option>
            ))}
          </select>

          {draft.repeat.frequency === "" ? null : (
            <>
              <label class="cal-inline">
                Every
                <input
                  type="number"
                  min={1}
                  value={draft.repeat.interval}
                  onInput={(ev) => setRepeat("interval", Number((ev.currentTarget as HTMLInputElement).value))}
                />
              </label>

              {draft.repeat.frequency === "weekly" ? (
                <div class="cal-days">
                  {DAY_CODES.map((d) => (
                    <label class="cal-inline">
                      <input
                        type="checkbox"
                        checked={draft.repeat.weekdays.includes(d)}
                        onChange={() => {
                          const next = draft.repeat.weekdays.includes(d)
                            ? draft.repeat.weekdays.filter((x) => x !== d)
                            : [...draft.repeat.weekdays, d as DayCode];
                          setRepeat("weekdays", next);
                        }}
                      />
                      {DAY_LABELS[d]}
                    </label>
                  ))}
                </div>
              ) : null}

              {draft.repeat.frequency === "monthly" ? (
                <select
                  value={draft.repeat.monthlyMode}
                  onChange={(ev) =>
                    setRepeat(
                      "monthlyMode",
                      (ev.currentTarget as HTMLSelectElement).value as EventDraft["repeat"]["monthlyMode"],
                    )
                  }
                >
                  <option value="dayOfMonth">on the same day of the month</option>
                  <option value="nthWeekday">on the same weekday of the month</option>
                </select>
              ) : null}

              <select
                value={draft.repeat.ends}
                onChange={(ev) =>
                  setRepeat("ends", (ev.currentTarget as HTMLSelectElement).value as EventDraft["repeat"]["ends"])
                }
              >
                <option value="never">forever</option>
                <option value="count">for a number of times</option>
                <option value="until">until a date</option>
              </select>
              {draft.repeat.ends === "count" ? (
                <input
                  type="number"
                  min={1}
                  value={draft.repeat.count}
                  onInput={(ev) => setRepeat("count", Number((ev.currentTarget as HTMLInputElement).value))}
                />
              ) : null}
              {draft.repeat.ends === "until" ? (
                <input
                  type="date"
                  value={draft.repeat.until}
                  onInput={(ev) => setRepeat("until", (ev.currentTarget as HTMLInputElement).value)}
                />
              ) : null}

              {/* The form offers a strict subset of what the expander supports,
                  because the server REFUSES a rule it would mis-expand rather
                  than storing wrong dates (.feedback common/003). */}
              <p class="muted cal-fine">Only repeat patterns this server can expand exactly are offered here.</p>
            </>
          )}
        </fieldset>
      )}

      <div class="cal-actions">
        <button type="button" class="cal-primary" disabled={saving} onClick={props.onSave}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        {draft.id ? (
          <button type="button" class="cal-danger" disabled={saving} onClick={props.onDelete}>
            Delete
          </button>
        ) : null}
      </div>
    </aside>
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
