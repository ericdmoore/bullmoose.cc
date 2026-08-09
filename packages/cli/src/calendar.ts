import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { pickAccountId, requireSettings } from "./db.js";
import {
  conflict,
  emitIds,
  emitJson,
  emitNdjson,
  fail,
  failSetError,
  note,
  notFound,
  out,
  outRaw,
  readInput,
  usage,
  warn,
  EXIT,
  type IoOpts,
} from "./io.js";
import { JmapClient } from "./jmap.js";

/**
 * bullmoose calendar — the CRUD half of the JSCalendar surface (sVOL 018,
 * s05 T3). The read half (`list`, `agenda`) predates this; the write half is
 *
 *   calendar create|rename|rm                 Calendar/set
 *   calendar event create|edit|rm             CalendarEvent/set
 *   calendar export [--ics] [--calendar …]    CalendarEvent/get → iCal/JSON
 *
 * A CLI projection over live JMAP methods — `Calendar/set`
 * (services/jmap/src/methods/calendars.ts) and `CalendarEvent/set` are the
 * source of truth. It obeys the sVOL 016 I/O contract (NDJSON collections,
 * the exit-code map, `--if-state`→`ifInState`, `--dry-run` on `rm`,
 * stdin/`--as` for event bodies).
 *
 * WHY A LOCAL iCal CODEC. The compiled CLI runs as plain `dist/*.js` under
 * Node with no bundler and no `node_modules/@bullmoose` — workspace packages
 * resolve only through tsc `paths` / vitest aliases, never at runtime. So the
 * CLI cannot import `@bullmoose/calendar-core` any more than `contacts.ts`
 * could import `@bullmoose/contacts-core`; it vendors a compact codec here,
 * exactly as `contacts.ts` vendors `vcard.ts`. The server's ical.ts stays the
 * authority for the CalDAV face; this covers the common event shapes the CLI
 * needs to export a backup and round-trip a create.
 */

const CAL_USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"];

/** JSCalendar event — an open object, as the server stores it. */
type JsEvent = Record<string, unknown>;

export interface CalendarOpts extends IoOpts {
  account?: string;
  days?: string;
  title?: string;
  start?: string;
  duration?: string;
  tz?: string;
  allDay?: boolean;
  rrule?: string;
  calendar?: string;
  occurrence?: string;
  ics?: boolean;
  force?: boolean;
}

interface CalendarRef {
  id: string;
  name: string;
  isDefault?: boolean;
}

export async function cmdCalendar(
  db: DatabaseSync,
  positionals: string[],
  opts: CalendarOpts,
): Promise<void> {
  const [sub, arg, arg2] = positionals;
  const settings = requireSettings(db);
  const accountId = pickAccountId(settings, opts.account);
  const client = new JmapClient(settings.base, settings.token);

  switch (sub) {
    case "list":
      return listCalendars(client, accountId, opts);
    case "agenda":
      return agenda(client, accountId, opts);
    case "create":
      return createCalendar(client, accountId, arg, opts);
    case "rename":
      return renameCalendar(client, accountId, arg, arg2, opts);
    case "rm":
      return rmCalendar(client, accountId, arg, opts);
    case "export":
      return exportEvents(client, accountId, opts);
    case "event":
      return eventVerb(client, accountId, positionals.slice(1), opts);
    default:
      usage(
        `unknown calendar subcommand: ${sub ?? "(none)"} ` +
          `(list|agenda|create|rename|rm|event|export)`,
      );
  }
}

// ───────────────────────────── read (pre-existing) ──────────────────────────

async function listCalendars(
  client: JmapClient,
  accountId: string,
  opts: CalendarOpts,
): Promise<void> {
  const res = await client.one("Calendar/get", { accountId, ids: null }, CAL_USING);
  const cals = (res.list as Array<Record<string, unknown>>) ?? [];
  if (opts.ids) return emitIds(cals.map((c) => String(c.id)));
  if (opts.json) return emitNdjson(cals);
  for (const c of cals) {
    out(`${String(c.name).padEnd(24)} ${c.isDefault ? "★ default" : ""}  ${c.id}`);
  }
  if (cals.length === 0) note("(no calendars)");
}

async function agenda(client: JmapClient, accountId: string, opts: CalendarOpts): Promise<void> {
  const days = Math.max(1, Number(opts.days) || 7);
  const after = new Date();
  const before = new Date(after.getTime() + days * 86_400_000);
  const res = await client.one(
    "CalendarEvent/getOccurrences",
    { accountId, after: after.toISOString(), before: before.toISOString() },
    CAL_USING,
  );
  const occ = (res.list as Array<Record<string, unknown>>) ?? [];
  // The addressable id for `event edit|rm` is the master event's id, so THAT
  // is what --ids emits (the server keys occurrences by eventId+recurrenceId;
  // there is no standalone occurrence id to hand to a write verb).
  if (opts.ids) return emitIds(occ.map((o) => String(o.eventId ?? o.id ?? "")));
  if (opts.json) return emitNdjson(occ);
  if (occ.length === 0) {
    note(`(nothing scheduled in the next ${days} day${days === 1 ? "" : "s"})`);
    return;
  }
  let lastDay = "";
  for (const o of occ) {
    const start = new Date(String(o.utcStart));
    const day = start.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    if (day !== lastDay) {
      note(day); // a date heading is decoration between records, not a record
      lastDay = day;
    }
    const time =
      o.showWithoutTime === true
        ? "all day"
        : `${start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}–${new Date(
            String(o.utcEnd),
          ).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
    out(`  ${time.padEnd(16)} ${String(o.title ?? "(untitled)")}  ${String(o.eventId ?? o.id ?? "")}`);
  }
}

// ───────────────────────────── Calendar/set ─────────────────────────────────

async function createCalendar(
  client: JmapClient,
  accountId: string,
  name: string | undefined,
  opts: CalendarOpts,
): Promise<void> {
  if (!name) usage("bullmoose calendar create <name>");
  if (dryRun(opts, "create", `calendar "${name}"`)) return;
  const res = await setCalendar(client, accountId, opts, { create: { c0: { name } } });
  const made = (res.created as Record<string, { id: string }>).c0;
  if (!made) failSetError("create", (res.notCreated as Record<string, unknown>).c0);
  reportWrite(opts, res, { action: "created", id: made.id, name: name! });
}

async function renameCalendar(
  client: JmapClient,
  accountId: string,
  selector: string | undefined,
  newName: string | undefined,
  opts: CalendarOpts,
): Promise<void> {
  if (!selector || !newName) usage("bullmoose calendar rename <id-or-name> <new-name>");
  const target = resolveCalendar(await getCalendars(client, accountId), selector);
  if (dryRun(opts, "rename", `${target.name} → ${newName}`)) return;
  const res = await setCalendar(client, accountId, opts, {
    update: { [target.id]: { name: newName } },
  });
  if (!(target.id in (res.updated as Record<string, unknown>))) {
    failSetError("rename", (res.notUpdated as Record<string, unknown>)[target.id]);
  }
  reportWrite(opts, res, { action: "renamed", id: target.id, name: newName! });
}

async function rmCalendar(
  client: JmapClient,
  accountId: string,
  selector: string | undefined,
  opts: CalendarOpts,
): Promise<void> {
  if (!selector) usage("bullmoose calendar rm <id-or-name> [--force] [--dry-run]");
  // Resolve for real even under --dry-run: an unknown calendar still exits 3.
  const target = resolveCalendar(await getCalendars(client, accountId), selector);
  if (dryRun(opts, "rm", `${target.name} (${target.id})${opts.force ? " and its events" : ""}`)) {
    return;
  }
  const res = await setCalendar(client, accountId, opts, {
    destroy: [target.id],
    // --force is onDestroyRemoveEvents: without it a calendar holding events
    // is refused (the server's default, and the right one).
    ...(opts.force ? { onDestroyRemoveEvents: true } : {}),
  });
  if (!(res.destroyed as string[]).includes(target.id)) {
    const err = (res.notDestroyed as Record<string, { type?: string; description?: string }>)[
      target.id
    ];
    // `calendarHasEvents` is not in the 016 exit-code table (io.ts is not this
    // unit's to edit); map it here to the conflict class it belongs to, with
    // the --force hint, exactly like `mailbox rm` on a non-empty folder.
    if (err?.type === "calendarHasEvents") {
      conflict(`rm refused: "${target.name}" still holds events — pass --force to remove them too`);
    }
    failSetError("rm", err);
  }
  reportWrite(opts, res, { action: "destroyed", id: target.id, name: target.name });
}

// ───────────────────────────── CalendarEvent/set ────────────────────────────

async function eventVerb(
  client: JmapClient,
  accountId: string,
  rest: string[],
  opts: CalendarOpts,
): Promise<void> {
  const [verb, id] = rest;
  switch (verb) {
    case "create":
      return eventCreate(client, accountId, rest[1], opts);
    case "edit":
      return eventEdit(client, accountId, id, opts);
    case "rm":
      return eventRm(client, accountId, id, opts);
    default:
      usage(`unknown calendar event subcommand: ${verb ?? "(none)"} (create|edit|rm)`);
  }
}

async function eventCreate(
  client: JmapClient,
  accountId: string,
  source: string | undefined,
  opts: CalendarOpts,
): Promise<void> {
  // A body may arrive on stdin / a path / `-`; flags overlay it. With neither a
  // body nor --start there is nothing to create.
  const input = readInput(source, { as: opts.as });
  let event: JsEvent = {};
  if (input) {
    if (input.type === "json") {
      event = parseJsonEvent(input.text, input.from);
    } else if (input.type === "ical") {
      const parsed = parseEventIcal(input.text);
      for (const w of parsed.warnings) warn(w);
      if (!parsed.event) fail(`no usable VEVENT in ${input.from}`, EXIT.USAGE);
      event = parsed.event;
    } else {
      fail(
        `${input.from} looks like ${input.type}, not an event — pass --as ical or --as json`,
        EXIT.USAGE,
      );
    }
  }
  applyEventFlags(event, opts); // flags win over the body

  if (typeof event.start !== "string" || !parseLdt(event.start)) {
    usage(
      "calendar event create needs a start: --start 2026-07-08T09:00:00, or a JSON/iCal body",
    );
  }

  // Target calendar: --calendar names it; otherwise the server's default.
  let calendarIds: Record<string, true> | undefined;
  if (opts.calendar) {
    const cal = resolveCalendar(await getCalendars(client, accountId), opts.calendar);
    calendarIds = { [cal.id]: true };
  }
  const spec: JsEvent = { ...event, ...(calendarIds ? { calendarIds } : {}) };
  delete spec.id; // server-set

  if (dryRun(opts, "create", `event "${String(event.title ?? "(untitled)")}" @ ${event.start}`)) {
    return;
  }
  const res = await setEvent(client, accountId, opts, { create: { c0: spec } });
  const made = (res.created as Record<string, { id: string }>).c0;
  if (!made) failSetError("create", (res.notCreated as Record<string, unknown>).c0);
  reportWrite(opts, res, {
    action: "created",
    id: made.id,
    name: String(event.title ?? "(untitled)"),
  });
}

async function eventEdit(
  client: JmapClient,
  accountId: string,
  id: string | undefined,
  opts: CalendarOpts,
): Promise<void> {
  if (!id) usage("bullmoose calendar event edit <id> [--title …] [--rrule …] [<patch.json>|-]");

  // Single-occurrence editing (--occurrence <recurrenceId>) is DEFERRED, not
  // shipped half-working (s05 devPlan Risk; sVOL 018 §2). A clear refusal is
  // the sanctioned v1 — see the note in the unit file. Whole-series edit (a
  // bare `edit`, below) is the supported form and hits the master.
  if (opts.occurrence !== undefined) {
    fail(
      "single-occurrence editing (--occurrence) is not yet implemented; " +
        "`calendar event edit <id>` edits the whole series (the master). " +
        "To change one instance, edit the series or delete+recreate that date.",
      EXIT.USAGE,
    );
  }

  const existing = await getEvent(client, accountId, id);
  if (!existing) notFound(`no such event: ${id}`);

  // The patch: a JSON body if given, plus anything from flags. Sent as a
  // JMAP PatchObject (top-level keys replace their property), so an empty
  // patch is a usage error rather than a no-op write.
  const patch: JsEvent = {};
  const input = readInput(undefined, { as: opts.as });
  if (input) {
    if (input.type !== "json") {
      fail(`edit takes a JSON patch on stdin (got ${input.type}); use flags for iCal-shaped edits`, EXIT.USAGE);
    }
    Object.assign(patch, parseJsonEvent(input.text, input.from));
  }
  applyEventFlags(patch, opts);
  delete patch.id;
  delete patch.uid; // immutable server-side; sending it only earns a rejection

  if (Object.keys(patch).length === 0) {
    usage("calendar event edit needs something to change: --title, --start, --rrule, … or a JSON patch");
  }

  if (dryRun(opts, "edit", `event ${id}: ${Object.keys(patch).join(", ")}`)) return;
  const res = await setEvent(client, accountId, opts, { update: { [id]: patch } });
  if (!(id in (res.updated as Record<string, unknown>))) {
    failSetError("edit", (res.notUpdated as Record<string, unknown>)[id]);
  }
  reportWrite(opts, res, {
    action: "edited",
    id,
    name: String(patch.title ?? existing!.title ?? id),
  });
}

async function eventRm(
  client: JmapClient,
  accountId: string,
  id: string | undefined,
  opts: CalendarOpts,
): Promise<void> {
  if (!id) usage("bullmoose calendar event rm <id> [--dry-run]");
  const existing = await getEvent(client, accountId, id); // resolve first (§1.7)
  if (!existing) notFound(`no such event: ${id}`);
  if (dryRun(opts, "rm", `event "${existing!.title ?? id}" (${id})`)) return;
  const res = await setEvent(client, accountId, opts, { destroy: [id] });
  if (!(res.destroyed as string[]).includes(id)) {
    failSetError("rm", (res.notDestroyed as Record<string, unknown>)[id]);
  }
  reportWrite(opts, res, { action: "destroyed", id, name: String(existing!.title ?? id) });
}

// ───────────────────────────── export ───────────────────────────────────────

async function exportEvents(
  client: JmapClient,
  accountId: string,
  opts: CalendarOpts,
): Promise<void> {
  let calId: string | undefined;
  if (opts.calendar) {
    calId = resolveCalendar(await getCalendars(client, accountId), opts.calendar).id;
  }
  // Enumerate then fetch — CalendarEvent/get with ids:null is not guaranteed,
  // so query for the ids first (optionally scoped to one calendar).
  const q = await client.one(
    "CalendarEvent/query",
    { accountId, ...(calId ? { filter: { inCalendar: calId } } : {}) },
    CAL_USING,
  );
  const ids = (q.ids as string[]) ?? [];
  const events: JsEvent[] = [];
  for (let i = 0; i < ids.length; i += 256) {
    const g = await client.one(
      "CalendarEvent/get",
      { accountId, ids: ids.slice(i, i + 256) },
      CAL_USING,
    );
    events.push(...((g.list as JsEvent[]) ?? []));
  }

  const wantIcs = opts.ics === true || opts.as === "ical" || opts.as === "ics";
  if (opts.ids) return emitIds(events.map((e) => String(e.id)));
  if (wantIcs && !opts.json) {
    // iCal is the requested DATA, so it goes to stdout raw. One VCALENDAR per
    // event keeps each block independently valid and parseable.
    if (events.length === 0) note("(no events)");
    for (const e of events) outRaw(serializeEventIcal(e));
    return;
  }
  if (events.length === 0) {
    if (opts.json) return;
    note("(no events)");
    return;
  }
  emitNdjson(events); // §1.3 — one JSCalendar event per line, streamable
}

// ───────────────────────────── JMAP plumbing ────────────────────────────────

async function setCalendar(
  client: JmapClient,
  accountId: string,
  opts: CalendarOpts,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return client.one(
    "Calendar/set",
    { accountId, ...(opts.ifState ? { ifInState: opts.ifState } : {}), ...args },
    CAL_USING,
  );
}

async function setEvent(
  client: JmapClient,
  accountId: string,
  opts: CalendarOpts,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // §1.7: --if-state → ifInState; a mismatch returns method-level
  // stateMismatch, which JmapClient.one rethrows with jmapType set → exit 5.
  return client.one(
    "CalendarEvent/set",
    { accountId, ...(opts.ifState ? { ifInState: opts.ifState } : {}), ...args },
    CAL_USING,
  );
}

async function getCalendars(client: JmapClient, accountId: string): Promise<CalendarRef[]> {
  const res = await client.one("Calendar/get", { accountId, ids: null }, CAL_USING);
  return (res.list as CalendarRef[]) ?? [];
}

async function getEvent(
  client: JmapClient,
  accountId: string,
  id: string,
): Promise<JsEvent | undefined> {
  const g = await client.one("CalendarEvent/get", { accountId, ids: [id] }, CAL_USING);
  return ((g.list as JsEvent[]) ?? [])[0];
}

/**
 * Accept a calendar id or a (case-insensitive) name — a human types
 * "Personal", not "cal_9f3c…". Exact id wins; an ambiguous name is an error,
 * not a coin flip. Mirrors `resolveMailbox`.
 */
export function resolveCalendar(cals: CalendarRef[], selector: string): CalendarRef {
  const byId = cals.find((c) => c.id === selector);
  if (byId) return byId;
  const byName = cals.filter((c) => c.name.toLowerCase() === selector.toLowerCase());
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    usage(
      `"${selector}" matches ${byName.length} calendars; use an id: ` +
        byName.map((c) => c.id).join(", "),
    );
  }
  notFound(`no such calendar: ${selector}`);
}

/**
 * `--dry-run` (§1.7): returns true when the caller must stop. Everything
 * before it is a read, so the report names the RESOLVED target.
 */
function dryRun(opts: CalendarOpts, verb: string, what: string): boolean {
  if (!opts.dryRun) return false;
  note(`dry run: would ${verb} ${what}; nothing was written`);
  if (opts.json) emitJson({ dryRun: true, action: verb, target: what });
  return true;
}

function reportWrite(
  opts: CalendarOpts,
  res: Record<string, unknown>,
  what: { action: string; id: string; name: string },
): void {
  const state = (res.newState as string | undefined) ?? null;
  if (opts.ids) return emitIds([what.id]);
  if (opts.json) return emitJson({ ...what, state });
  out(`${what.action} ${what.name} (${what.id})`);
  if (state) note(`state ${state}  (pass to --if-state on the next write)`);
}

// ───────────────────────────── event assembly ───────────────────────────────

function parseJsonEvent(text: string, from: string): JsEvent {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    fail(`${from} is not valid JSON: ${(err as Error).message}`, EXIT.USAGE);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${from} must be a single JSCalendar event object`, EXIT.USAGE);
  }
  return value as JsEvent;
}

/** Overlay the flag-set onto an event/patch. `--rrule` is validated here. */
function applyEventFlags(event: JsEvent, opts: CalendarOpts): void {
  if (opts.title !== undefined) event.title = opts.title;
  if (opts.start !== undefined) event.start = opts.start;
  if (opts.duration !== undefined) event.duration = opts.duration;
  if (opts.tz !== undefined) event.timeZone = opts.tz;
  if (opts.allDay) event.showWithoutTime = true;
  if (opts.rrule !== undefined) {
    event.recurrenceRules = [validateRrule(opts.rrule)];
  }
}

// ═════════════════════ vendored iCal / RRULE codec ══════════════════════════
//
// A compact local mirror of packages/calendar-core (see the header note on why
// the CLI cannot import it). Covers the event shapes the CLI produces and
// consumes: timed UTC, timed zoned (TZID passthrough), and all-day, plus an
// RRULE string subset. The server re-validates everything on write, so this
// codec's job is to be honest, not exhaustive.

interface Ldt {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function parseLdt(s: string): Ldt | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  return {
    year: +m[1]!,
    month: +m[2]!,
    day: +m[3]!,
    hour: +m[4]!,
    minute: +m[5]!,
    second: +m[6]!,
  };
}

const p2 = (n: number) => String(n).padStart(2, "0");
const fmtLdt = (d: Ldt) =>
  `${String(d.year).padStart(4, "0")}-${p2(d.month)}-${p2(d.day)}T${p2(d.hour)}:${p2(d.minute)}:${p2(d.second)}`;
const stampLocal = (d: Ldt) =>
  `${String(d.year).padStart(4, "0")}${p2(d.month)}${p2(d.day)}T${p2(d.hour)}${p2(d.minute)}${p2(d.second)}`;
const stampDate = (d: Ldt) => `${String(d.year).padStart(4, "0")}${p2(d.month)}${p2(d.day)}`;
const stampUtc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** ISO-8601 duration → ms (dates approximate: D=24h). Mirrors calendar-core. */
export function parseDurationMs(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(raw);
  if (!m) return 0;
  const [, sign, w, d, h, min, s] = m;
  const ms =
    (Number(w ?? 0) * 7 + Number(d ?? 0)) * 86_400_000 +
    Number(h ?? 0) * 3_600_000 +
    Number(min ?? 0) * 60_000 +
    Number(s ?? 0) * 1000;
  return sign === "-" ? -ms : ms;
}

function msToDuration(ms: number): string {
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  let out = "P";
  if (d) out += `${d}D`;
  if (h || m) out += "T";
  if (h) out += `${h}H`;
  if (m) out += `${m}M`;
  return out === "P" ? "PT0S" : out;
}

const escIcs = (s: string) =>
  s.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll(",", "\\,").replaceAll(";", "\\;");
const unescIcs = (s: string) =>
  s
    .replaceAll("\\n", "\n")
    .replaceAll("\\N", "\n")
    .replaceAll("\\,", ",")
    .replaceAll("\\;", ";")
    .replaceAll("\\\\", "\\");

/** RFC 5545 §3.1 line folding at 75 octets (ASCII-approx, adequate for a CLI). */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let i = 0;
  while (i < line.length) {
    const take = i === 0 ? 75 : 74;
    parts.push((i === 0 ? "" : " ") + line.slice(i, i + take));
    i += take;
  }
  return parts.join("\r\n");
}

// ---- RRULE strings -------------------------------------------------------

const DAY_UP: Record<string, string> = { mo: "MO", tu: "TU", we: "WE", th: "TH", fr: "FR", sa: "SA", su: "SU" };
const DAY_DOWN: Record<string, string> = { MO: "mo", TU: "tu", WE: "we", TH: "th", FR: "fr", SA: "sa", SU: "su" };

interface RuleObj {
  frequency?: string;
  interval?: number;
  count?: number;
  until?: string;
  byDay?: Array<{ day: string; nthOfPeriod?: number }>;
  byMonthDay?: number[];
  byMonth?: string[];
  bySetPosition?: number[];
  firstDayOfWeek?: string;
  /** Any RRULE token this codec does not recognise, kept for the guard. */
  unknownPart?: string;
}

/**
 * The client-side half of the common/003 guard: the `(FREQ, part)` pairs the
 * server's expander actually reads. KEEP IN LOCKSTEP with
 * `SUPPORTED_PARTS` in packages/calendar-core/src/index.ts. A drift here is
 * self-correcting — the server re-checks via `eventSpan` and surfaces the same
 * refusal through `failSetError` — so the worst case is a round-trip instead of
 * a fast local refusal, never a silent wrong write.
 */
const SUPPORTED_PARTS: Record<string, ReadonlySet<string>> = {
  daily: new Set(["interval", "count", "until"]),
  weekly: new Set(["interval", "count", "until", "byDay"]),
  monthly: new Set(["interval", "count", "until", "byDay", "byMonthDay", "bySetPosition"]),
  yearly: new Set(["interval", "count", "until", "byMonth"]),
};

const PART_LABEL: Record<string, string> = {
  interval: "INTERVAL",
  count: "COUNT",
  until: "UNTIL",
  byDay: "BYDAY",
  byMonthDay: "BYMONTHDAY",
  byMonth: "BYMONTH",
  bySetPosition: "BYSETPOS",
};

/** RRULE body → rule object. Unrecognised tokens are recorded, not silently dropped. */
export function parseRruleString(body: string): RuleObj {
  const rule: RuleObj = {};
  for (const part of body.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).toUpperCase();
    const v = part.slice(eq + 1);
    switch (k) {
      case "FREQ":
        rule.frequency = v.toLowerCase();
        break;
      case "INTERVAL":
        rule.interval = Number(v);
        break;
      case "COUNT":
        rule.count = Number(v);
        break;
      case "UNTIL":
        rule.until = untilToLdt(v);
        break;
      case "BYDAY":
        rule.byDay = v.split(",").map((tok) => {
          const m = /^(-?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(tok.trim());
          if (!m) return { day: tok.trim().toLowerCase() }; // invalid → caught by guard
          return { day: DAY_DOWN[m[2]!.toUpperCase()]!, ...(m[1] ? { nthOfPeriod: Number(m[1]) } : {}) };
        });
        break;
      case "BYMONTHDAY":
        rule.byMonthDay = v.split(",").map(Number);
        break;
      case "BYMONTH":
        rule.byMonth = v.split(",");
        break;
      case "BYSETPOS":
        rule.bySetPosition = v.split(",").map(Number);
        break;
      case "WKST":
        rule.firstDayOfWeek = DAY_DOWN[v.toUpperCase()] ?? v.toLowerCase();
        break;
      default:
        rule.unknownPart = k;
    }
  }
  return rule;
}

/** UNTIL token ("20261231T235959Z" | "20261231") → LocalDateTime string. */
function untilToLdt(v: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return v; // unparseable → the guard rejects it
  return `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "23"}:${m[5] ?? "59"}:${m[6] ?? "59"}`;
}

/**
 * Why `rule` cannot be faithfully expanded, or null. The named-part half of
 * the server's `unsupportedRuleReason` — enough to give the required clean,
 * specific CLI error (exit 2, naming the part) without a round-trip.
 */
export function rruleReason(rule: RuleObj): string | null {
  const freq = (rule.frequency ?? "").toLowerCase();
  if (!(freq in SUPPORTED_PARTS)) {
    return `FREQ=${(rule.frequency ?? "").toUpperCase() || "(missing)"} has no expander branch (DAILY/WEEKLY/MONTHLY/YEARLY)`;
  }
  if (rule.unknownPart) return `unknown RRULE part ${rule.unknownPart}`;
  const ok = SUPPORTED_PARTS[freq]!;
  for (const part of ["interval", "count", "until", "byDay", "byMonthDay", "byMonth", "bySetPosition"] as const) {
    if (!present((rule as Record<string, unknown>)[part])) continue;
    if (!ok.has(part)) {
      return `${PART_LABEL[part]} is discarded by the FREQ=${freq.toUpperCase()} expander branch`;
    }
  }
  // nthOfPeriod ("4TH") is only read by the MONTHLY branch — a plain part-set
  // check misses it, which is exactly the Thanksgiving-shaped bug.
  if (Array.isArray(rule.byDay)) {
    for (const b of rule.byDay) {
      if (!(b.day in DAY_UP)) return `BYDAY entry "${b.day}" is not a weekday code (MO..SU)`;
      if (b.nthOfPeriod !== undefined && freq !== "monthly") {
        return `BYDAY with an ordinal (e.g. 4TH) is only read by the FREQ=MONTHLY expander branch`;
      }
    }
  }
  return null;
}

const present = (v: unknown) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);

/**
 * Parse + guard an `--rrule` value, or abort with exit 2 naming the part. The
 * common/003 subtlety: the parser accepts more than the expander can expand,
 * so a supported-parts check is the only thing between a clean refusal and a
 * write that succeeds and silently does the wrong thing.
 */
export function validateRrule(body: string): RuleObj {
  const rule = parseRruleString(body);
  const reason = rruleReason(rule);
  if (reason !== null) fail(`--rrule "${body}": ${reason}`, EXIT.USAGE);
  return rule;
}

function ruleToRrule(rule: RuleObj): string {
  const parts = [`FREQ=${(rule.frequency ?? "daily").toUpperCase()}`];
  if (rule.interval && rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
  if (rule.until) {
    const d = parseLdt(rule.until);
    if (d) parts.push(`UNTIL=${stampLocal(d)}`);
  }
  if (rule.byDay && rule.byDay.length > 0) {
    parts.push(`BYDAY=${rule.byDay.map((b) => `${b.nthOfPeriod ?? ""}${DAY_UP[b.day] ?? "MO"}`).join(",")}`);
  }
  if (rule.byMonthDay && rule.byMonthDay.length > 0) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`);
  if (rule.byMonth && rule.byMonth.length > 0) parts.push(`BYMONTH=${rule.byMonth.join(",")}`);
  if (rule.bySetPosition && rule.bySetPosition.length > 0) parts.push(`BYSETPOS=${rule.bySetPosition.join(",")}`);
  if (rule.firstDayOfWeek) parts.push(`WKST=${DAY_UP[rule.firstDayOfWeek] ?? "MO"}`);
  return parts.join(";");
}

// ---- iCal serialize (JSCalendar → VCALENDAR) -----------------------------

/**
 * One VCALENDAR per event. TZID is passed through without a generated
 * VTIMEZONE — Apple/Google resolve named IANA zones from their own db, and the
 * full VTIMEZONE machinery lives in the server's CalDAV face, not here.
 */
export function serializeEventIcal(event: JsEvent): string {
  const tz = typeof event.timeZone === "string" ? event.timeZone : "Etc/UTC";
  const isUtc = tz === "Etc/UTC" || tz === "UTC";
  const allDay = event.showWithoutTime === true;
  const start = typeof event.start === "string" ? parseLdt(event.start) : null;
  const uid = String(event.uid ?? `urn:uuid:${randomUUID()}`);
  const durationMs = parseDurationMs(event.duration) || (allDay ? 86_400_000 : 0);

  const ev: string[] = ["BEGIN:VEVENT", fold(`UID:${escIcs(uid)}`), `DTSTAMP:${stampUtc(Date.now())}`];
  if (typeof event.title === "string") ev.push(fold(`SUMMARY:${escIcs(event.title)}`));
  if (typeof event.description === "string") ev.push(fold(`DESCRIPTION:${escIcs(event.description)}`));
  const loc = firstLocation(event);
  if (loc) ev.push(fold(`LOCATION:${escIcs(loc)}`));

  if (start) {
    if (allDay) {
      ev.push(`DTSTART;VALUE=DATE:${stampDate(start)}`);
      const days = Math.max(1, Math.round(durationMs / 86_400_000));
      const end = new Date(Date.UTC(start.year, start.month - 1, start.day + days));
      ev.push(`DTEND;VALUE=DATE:${end.getUTCFullYear()}${p2(end.getUTCMonth() + 1)}${p2(end.getUTCDate())}`);
    } else if (isUtc) {
      const ms = Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute, start.second);
      ev.push(`DTSTART:${stampUtc(ms)}`);
      ev.push(`DTEND:${stampUtc(ms + durationMs)}`);
    } else {
      ev.push(`DTSTART;TZID=${tz}:${stampLocal(start)}`);
      if (typeof event.duration === "string") ev.push(`DURATION:${event.duration}`);
      else if (durationMs) ev.push(`DURATION:${msToDuration(durationMs)}`);
    }
  }
  for (const rule of asRules(event.recurrenceRules)) ev.push(fold(`RRULE:${ruleToRrule(rule)}`));
  ev.push("END:VEVENT");

  return (
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//bullmoose//cli//EN",
      "CALSCALE:GREGORIAN",
      ev.join("\r\n"),
      "END:VCALENDAR",
      "",
    ].join("\r\n") + "\r\n"
  );
}

function asRules(raw: unknown): RuleObj[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      frequency: typeof o.frequency === "string" ? o.frequency : undefined,
      interval: typeof o.interval === "number" ? o.interval : undefined,
      count: typeof o.count === "number" ? o.count : undefined,
      until: typeof o.until === "string" ? o.until : undefined,
      byDay: Array.isArray(o.byDay) ? (o.byDay as RuleObj["byDay"]) : undefined,
      byMonthDay: Array.isArray(o.byMonthDay) ? (o.byMonthDay as number[]) : undefined,
      byMonth: Array.isArray(o.byMonth) ? (o.byMonth as string[]) : undefined,
      bySetPosition: Array.isArray(o.bySetPosition) ? (o.bySetPosition as number[]) : undefined,
      firstDayOfWeek: typeof o.firstDayOfWeek === "string" ? o.firstDayOfWeek : undefined,
    };
  });
}

function firstLocation(event: JsEvent): string | null {
  const locs = event.locations as Record<string, { name?: unknown }> | undefined;
  if (!locs || typeof locs !== "object") return null;
  for (const l of Object.values(locs)) if (typeof l?.name === "string" && l.name) return l.name;
  return null;
}

// ---- iCal parse (VCALENDAR → JSCalendar) ---------------------------------

export interface ParsedEvent {
  event: JsEvent | null;
  warnings: string[];
}

interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Parse ONE VEVENT (the master; sibling RECURRENCE-ID VEVENTs are ignored). */
export function parseEventIcal(text: string): ParsedEvent {
  const props = unfold(text);
  const warnings: string[] = [];

  let inEvent = false;
  const block: IcsProp[] = [];
  let sawRid = false;
  for (const p of props) {
    if (p.name === "BEGIN" && p.value.toUpperCase() === "VEVENT") {
      inEvent = true;
      continue;
    }
    if (p.name === "END" && p.value.toUpperCase() === "VEVENT") {
      if (block.length && !sawRid) break; // keep the first master block
      block.length = 0;
      sawRid = false;
      inEvent = false;
      continue;
    }
    if (inEvent) {
      if (p.name === "RECURRENCE-ID") sawRid = true;
      block.push(p);
    }
  }
  if (block.length === 0) return { event: null, warnings: ["no VEVENT found"] };

  const get = (name: string) => block.find((p) => p.name === name);
  const dt = get("DTSTART");
  const startInfo = dt ? parseIcsDt(dt) : null;
  if (!startInfo) return { event: null, warnings: ["missing/unparseable DTSTART"] };

  const event: JsEvent = {
    "@type": "Event",
    uid: get("UID") ? unescIcs(get("UID")!.value.trim()) : `urn:uuid:${randomUUID()}`,
    start: fmtLdt(startInfo.local),
    timeZone: startInfo.allDay ? "Etc/UTC" : startInfo.timeZone ?? "Etc/UTC",
  };
  if (startInfo.allDay) event.showWithoutTime = true;
  if (get("SUMMARY")) event.title = unescIcs(get("SUMMARY")!.value);
  if (get("DESCRIPTION")) event.description = unescIcs(get("DESCRIPTION")!.value);
  if (get("LOCATION")) event.locations = { loc1: { name: unescIcs(get("LOCATION")!.value) } };

  const durProp = get("DURATION");
  const dtend = get("DTEND");
  if (durProp) {
    event.duration = durProp.value.trim();
  } else if (dtend) {
    const endInfo = parseIcsDt(dtend);
    if (endInfo) {
      const ms = icsMs(endInfo) - icsMs(startInfo);
      if (ms > 0 && !(startInfo.allDay && ms === 86_400_000)) event.duration = msToDuration(ms);
    }
  }

  const rules: RuleObj[] = [];
  for (const p of block.filter((x) => x.name === "RRULE")) {
    const rule = parseRruleString(p.value.trim());
    const reason = rruleReason(rule);
    // Unlike the server codec (which warns-and-drops on import), the CLI create
    // path REJECTS an unexpandable RRULE — silently creating a non-recurring
    // event from a recurring source is the failure mode to avoid.
    if (reason !== null) fail(`iCal RRULE "${p.value.trim()}": ${reason}`, EXIT.USAGE);
    rules.push(rule);
  }
  if (rules.length > 0) event.recurrenceRules = rules.map(ruleObjToJson);

  return { event, warnings };
}

function ruleObjToJson(rule: RuleObj): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (rule.frequency) out.frequency = rule.frequency;
  if (rule.interval !== undefined) out.interval = rule.interval;
  if (rule.count !== undefined) out.count = rule.count;
  if (rule.until) out.until = rule.until;
  if (rule.byDay) out.byDay = rule.byDay;
  if (rule.byMonthDay) out.byMonthDay = rule.byMonthDay;
  if (rule.byMonth) out.byMonth = rule.byMonth;
  if (rule.bySetPosition) out.bySetPosition = rule.bySetPosition;
  if (rule.firstDayOfWeek) out.firstDayOfWeek = rule.firstDayOfWeek;
  return out;
}

interface IcsDt {
  local: Ldt;
  timeZone: string | null;
  allDay: boolean;
}

function parseIcsDt(prop: IcsProp): IcsDt | null {
  const v = prop.value.trim();
  if (prop.params.VALUE === "DATE" || /^\d{8}$/.test(v)) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (!m) return null;
    return {
      local: { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: 0, minute: 0, second: 0 },
      timeZone: null,
      allDay: true,
    };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const local = { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]!, second: +m[6]! };
  if (m[7] === "Z") return { local, timeZone: "Etc/UTC", allDay: false };
  return { local, timeZone: prop.params.TZID ?? null, allDay: false };
}

/** UTC-ish ms for duration math — TZID zones are treated as UTC wall clock,
 * which is exact for the UTC/floating events this codec targets. */
function icsMs(dt: IcsDt): number {
  const l = dt.local;
  return Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
}

function unfold(text: string): IcsProp[] {
  const lines: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      lines.push(line);
    }
  }
  const props: IcsProp[] = [];
  for (const line of lines) {
    let colon = -1;
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQ = !inQ;
      else if (ch === ":" && !inQ) {
        colon = i;
        break;
      }
    }
    if (colon <= 0) continue;
    const head = line.slice(0, colon).split(";");
    const params: Record<string, string> = {};
    for (const seg of head.slice(1)) {
      const eq = seg.indexOf("=");
      if (eq > 0) params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1).replace(/^"|"$/g, "");
    }
    props.push({ name: head[0]!.toUpperCase(), params, value: line.slice(colon + 1) });
  }
  return props;
}
