import {
  formatLocalDateTime,
  parseDuration,
  parseLocalDateTime,
  zonedToUtc,
  type JSCalendarEvent,
  type LocalDateTime,
  type RecurrenceRule,
} from "./index.js";

/**
 * iCalendar (RFC 5545) ⇄ JSCalendar for the CalDAV face (Phase 5).
 * Serialize targets what Apple Calendar expects: VCALENDAR with
 * VTIMEZONE per referenced zone (RDATE-based, generated from Intl
 * transition scanning — no bundled tz database), VEVENT with
 * DTSTART;TZID=…, RRULE, EXDATE, and patched occurrences as sibling
 * VEVENTs carrying RECURRENCE-ID. Parse inverts the same subset.
 */

// ---- text escaping / folding -------------------------------------------

function escapeIcs(s: string): string {
  return s
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

function unescapeIcs(s: string): string {
  return s
    .replaceAll("\\n", "\n")
    .replaceAll("\\N", "\n")
    .replaceAll("\\,", ",")
    .replaceAll("\\;", ";")
    .replaceAll("\\\\", "\\");
}

function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  let budget = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > budget) {
      out.push(cur);
      cur = " ";
      curBytes = 1;
      budget = 75;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur) out.push(cur);
  return out.join("\r\n");
}

const icsStamp = (dt: LocalDateTime) =>
  `${String(dt.year).padStart(4, "0")}${p2(dt.month)}${p2(dt.day)}T${p2(dt.hour)}${p2(dt.minute)}${p2(dt.second)}`;
const icsDate = (dt: LocalDateTime) => `${String(dt.year).padStart(4, "0")}${p2(dt.month)}${p2(dt.day)}`;
const p2 = (n: number) => String(n).padStart(2, "0");

function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// ---- RRULE strings -------------------------------------------------------

const DAY_UP: Record<string, string> = { mo: "MO", tu: "TU", we: "WE", th: "TH", fr: "FR", sa: "SA", su: "SU" };
const DAY_DOWN: Record<string, string> = { MO: "mo", TU: "tu", WE: "we", TH: "th", FR: "fr", SA: "sa", SU: "su" };

export function ruleToRrule(rule: RecurrenceRule, timeZone: string): string {
  const parts = [`FREQ=${(rule.frequency ?? "daily").toUpperCase()}`];
  if (rule.interval && rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
  if (rule.until) {
    const dt = parseLocalDateTime(rule.until);
    if (dt) parts.push(`UNTIL=${utcStamp(zonedToUtc(dt, timeZone))}`);
  }
  if (rule.byDay && rule.byDay.length > 0) {
    parts.push(
      `BYDAY=${rule.byDay
        .map((b) => `${b.nthOfPeriod ?? ""}${DAY_UP[(b.day ?? "").toLowerCase()] ?? "MO"}`)
        .join(",")}`,
    );
  }
  if (rule.byMonthDay && rule.byMonthDay.length > 0) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`);
  if (rule.byMonth && rule.byMonth.length > 0) parts.push(`BYMONTH=${rule.byMonth.join(",")}`);
  if (rule.bySetPosition && rule.bySetPosition.length > 0) {
    parts.push(`BYSETPOS=${rule.bySetPosition.join(",")}`);
  }
  return parts.join(";");
}

/** RRULE body → JSCalendar rule; null when a part is unsupported. */
export function rruleToRule(body: string, timeZone: string): RecurrenceRule | null {
  const rule: RecurrenceRule = {};
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
      case "UNTIL": {
        const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
        if (!m) return null;
        if (m[7] === "Z") {
          // Convert the UTC instant into the event zone's wall clock so
          // the expander compares like with like.
          const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? "23"), +(m[5] ?? "59"), +(m[6] ?? "59"));
          rule.until = wallClockIso(ms, timeZone);
        } else {
          rule.until = `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "23"}:${m[5] ?? "59"}:${m[6] ?? "59"}`;
        }
        break;
      }
      case "BYDAY": {
        const byDay: RecurrenceRule["byDay"] = [];
        for (const tok of v.split(",")) {
          const m = tok.match(/^(-?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/i);
          if (!m) return null;
          byDay.push({
            day: DAY_DOWN[m[2]!.toUpperCase()]!,
            ...(m[1] ? { nthOfPeriod: Number(m[1]) } : {}),
          });
        }
        rule.byDay = byDay;
        break;
      }
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
        break; // MO default matches the expander
      default:
        return null;
    }
  }
  return rule.frequency ? rule : null;
}

function wallClockIso(utcMs: number, timeZone: string): string {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => f.find((x) => x.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}:${g("second")}`;
}

// ---- VTIMEZONE (RDATE-based, from Intl) ----------------------------------

function offsetAt(utcMs: number, timeZone: string): number {
  const wc = parseLocalDateTime(wallClockIso(utcMs, timeZone))!;
  return Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second) - utcMs;
}

const fmtOffset = (ms: number) => {
  const sign = ms < 0 ? "-" : "+";
  const abs = Math.abs(ms) / 60000;
  return `${sign}${p2(Math.floor(abs / 60))}${p2(abs % 60)}`;
};

/**
 * Explicit-date VTIMEZONE covering [fromYear, toYear]: scan for offset
 * transitions (day-level, then binary-search to the hour) and emit one
 * STANDARD/DAYLIGHT block per transition. RFC 5545-legal without
 * recurrence rules; a couple of years around the event is plenty for
 * client rendering.
 */
export function vtimezone(timeZone: string, fromYear: number, toYear: number): string {
  if (timeZone === "Etc/UTC" || timeZone === "UTC") return "";
  const lines = [`BEGIN:VTIMEZONE`, `TZID:${timeZone}`];
  let cursor = Date.UTC(fromYear, 0, 1);
  const end = Date.UTC(toYear + 1, 0, 1);
  let prev = offsetAt(cursor, timeZone);
  let blocks = 0;
  while (cursor < end) {
    const next = cursor + 86_400_000;
    const off = offsetAt(next, timeZone);
    if (off !== prev) {
      // Binary-search the hour of the transition.
      let lo = cursor;
      let hi = next;
      while (hi - lo > 3_600_000) {
        const mid = lo + Math.floor((hi - lo) / 2 / 3_600_000) * 3_600_000;
        if (offsetAt(mid, timeZone) === prev) lo = mid;
        else hi = mid;
      }
      const isDst = off > prev;
      const localAtTransition = parseLocalDateTime(wallClockIso(hi - 1, timeZone))!;
      lines.push(
        `BEGIN:${isDst ? "DAYLIGHT" : "STANDARD"}`,
        `TZOFFSETFROM:${fmtOffset(prev)}`,
        `TZOFFSETTO:${fmtOffset(off)}`,
        `DTSTART:${icsStamp({ ...localAtTransition, hour: localAtTransition.hour + 1, minute: 0, second: 0 })}`,
        `END:${isDst ? "DAYLIGHT" : "STANDARD"}`,
      );
      blocks++;
      prev = off;
    }
    cursor = next;
  }
  if (blocks === 0) {
    // Fixed-offset zone: one STANDARD block.
    lines.push(
      `BEGIN:STANDARD`,
      `TZOFFSETFROM:${fmtOffset(prev)}`,
      `TZOFFSETTO:${fmtOffset(prev)}`,
      `DTSTART:19700101T000000`,
      `END:STANDARD`,
    );
  }
  lines.push(`END:VTIMEZONE`);
  return lines.join("\r\n");
}

// ---- serialize -----------------------------------------------------------

export function serializeICal(event: JSCalendarEvent): string {
  const timeZone = typeof event.timeZone === "string" ? event.timeZone : "Etc/UTC";
  const allDay = event.showWithoutTime === true;
  const start = parseLocalDateTime(String(event.start ?? ""));
  const uid = String(event.uid ?? crypto.randomUUID());
  const durationMs = parseDuration(event.duration) || (allDay ? 86_400_000 : 0);

  const overrides = (event.recurrenceOverrides ?? {}) as Record<string, Record<string, unknown>>;
  const rules = Array.isArray(event.recurrenceRules)
    ? (event.recurrenceRules as RecurrenceRule[])
    : [];

  const ev: string[] = ["BEGIN:VEVENT", fold(`UID:${escapeIcs(uid)}`)];
  const updatedMs = typeof event.updated === "string" ? Date.parse(event.updated) : Date.now();
  ev.push(`DTSTAMP:${utcStamp(Number.isFinite(updatedMs) ? updatedMs : Date.now())}`);
  if (typeof event.title === "string") ev.push(fold(`SUMMARY:${escapeIcs(event.title)}`));
  if (typeof event.description === "string") ev.push(fold(`DESCRIPTION:${escapeIcs(event.description)}`));
  const loc = firstLocation(event);
  if (loc) ev.push(fold(`LOCATION:${escapeIcs(loc)}`));

  if (start) {
    if (allDay) {
      ev.push(`DTSTART;VALUE=DATE:${icsDate(start)}`);
      const days = Math.max(1, Math.round(durationMs / 86_400_000));
      const endUtc = new Date(Date.UTC(start.year, start.month - 1, start.day + days));
      ev.push(
        `DTEND;VALUE=DATE:${endUtc.getUTCFullYear()}${p2(endUtc.getUTCMonth() + 1)}${p2(endUtc.getUTCDate())}`,
      );
    } else if (timeZone === "Etc/UTC" || timeZone === "UTC") {
      const ms = zonedToUtc(start, timeZone);
      ev.push(`DTSTART:${utcStamp(ms)}`);
      ev.push(`DTEND:${utcStamp(ms + durationMs)}`);
    } else {
      ev.push(`DTSTART;TZID=${timeZone}:${icsStamp(start)}`);
      if (typeof event.duration === "string") ev.push(`DURATION:${event.duration}`);
    }
  }

  for (const rule of rules) ev.push(fold(`RRULE:${ruleToRrule(rule, timeZone)}`));

  const patchedVevents: string[] = [];
  for (const [rid, patch] of Object.entries(overrides)) {
    const ridDt = parseLocalDateTime(rid);
    if (!ridDt) continue;
    if (patch.excluded === true) {
      ev.push(
        allDay ? `EXDATE;VALUE=DATE:${icsDate(ridDt)}` : `EXDATE;TZID=${timeZone}:${icsStamp(ridDt)}`,
      );
      continue;
    }
    // Patched occurrence → sibling VEVENT with RECURRENCE-ID.
    const effStart = typeof patch.start === "string" ? parseLocalDateTime(patch.start) : ridDt;
    const effDur = typeof patch.duration === "string" ? parseDuration(patch.duration) : durationMs;
    const title = typeof patch.title === "string" ? patch.title : event.title;
    patchedVevents.push(
      [
        "BEGIN:VEVENT",
        fold(`UID:${escapeIcs(uid)}`),
        `DTSTAMP:${utcStamp(Date.now())}`,
        `RECURRENCE-ID;TZID=${timeZone}:${icsStamp(ridDt)}`,
        ...(effStart ? [`DTSTART;TZID=${timeZone}:${icsStamp(effStart)}`] : []),
        ...(effDur ? [`DURATION:${msToDuration(effDur)}`] : []),
        ...(typeof title === "string" ? [fold(`SUMMARY:${escapeIcs(title)}`)] : []),
        "END:VEVENT",
      ].join("\r\n"),
    );
  }
  ev.push("END:VEVENT");

  const needsTz = !allDay && timeZone !== "Etc/UTC" && timeZone !== "UTC";
  const year = start?.year ?? new Date().getUTCFullYear();
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//bullmoose//anglebrackets//EN",
    "CALSCALE:GREGORIAN",
    ...(needsTz ? [vtimezone(timeZone, year - 1, year + 2)] : []),
    ev.join("\r\n"),
    ...patchedVevents,
    "END:VCALENDAR",
    "",
  ]
    .filter((s) => s !== "")
    .join("\r\n") + "\r\n";
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

function firstLocation(event: JSCalendarEvent): string | null {
  const locs = event.locations as Record<string, { name?: unknown }> | undefined;
  if (!locs || typeof locs !== "object") return null;
  for (const l of Object.values(locs)) {
    if (typeof l?.name === "string" && l.name) return l.name;
  }
  return null;
}

// ---- parse ----------------------------------------------------------------

interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseIcsLines(text: string): IcsProp[] {
  const unfolded: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      unfolded.push(line);
    }
  }
  const props: IcsProp[] = [];
  for (const line of unfolded) {
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

function parseIcsDt(prop: IcsProp): { local: LocalDateTime; timeZone: string | null; allDay: boolean } | null {
  const v = prop.value.trim();
  if (prop.params.VALUE === "DATE" || /^\d{8}$/.test(v)) {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    return {
      local: { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: 0, minute: 0, second: 0 },
      timeZone: null,
      allDay: true,
    };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const local = { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]!, second: +m[6]! };
  if (m[7] === "Z") return { local, timeZone: "Etc/UTC", allDay: false };
  return { local, timeZone: prop.params.TZID ?? null, allDay: false };
}

export interface ParsedICal {
  event: JSCalendarEvent | null;
  warnings: string[];
}

/** Parse one VCALENDAR into one JSCalendar event (master + overrides). */
export function parseICal(text: string): ParsedICal {
  const props = parseIcsLines(text);
  const warnings: string[] = [];

  // Split into VEVENT blocks.
  const blocks: IcsProp[][] = [];
  let cur: IcsProp[] | null = null;
  for (const p of props) {
    if (p.name === "BEGIN" && p.value.toUpperCase() === "VEVENT") {
      cur = [];
      continue;
    }
    if (p.name === "END" && p.value.toUpperCase() === "VEVENT") {
      if (cur) blocks.push(cur);
      cur = null;
      continue;
    }
    if (cur) cur.push(p);
  }
  if (blocks.length === 0) return { event: null, warnings: ["no VEVENT found"] };

  const master = blocks.find((b) => !b.some((p) => p.name === "RECURRENCE-ID")) ?? blocks[0]!;
  const get = (b: IcsProp[], name: string) => b.find((p) => p.name === name);

  const dtstart = get(master, "DTSTART");
  const startInfo = dtstart ? parseIcsDt(dtstart) : null;
  if (!startInfo) return { event: null, warnings: ["missing/unparseable DTSTART"] };
  const timeZone = startInfo.timeZone ?? "Etc/UTC";

  const event: JSCalendarEvent = {
    "@type": "Event",
    uid: get(master, "UID") ? unescapeIcs(get(master, "UID")!.value.trim()) : `urn:uuid:${crypto.randomUUID()}`,
    start: formatLocalDateTime(startInfo.local),
    timeZone: startInfo.allDay ? "Etc/UTC" : timeZone,
  };
  if (startInfo.allDay) event.showWithoutTime = true;
  const summary = get(master, "SUMMARY");
  if (summary) event.title = unescapeIcs(summary.value);
  const desc = get(master, "DESCRIPTION");
  if (desc) event.description = unescapeIcs(desc.value);
  const location = get(master, "LOCATION");
  if (location) event.locations = { loc1: { name: unescapeIcs(location.value) } };

  // Duration: explicit, or DTEND − DTSTART.
  const durProp = get(master, "DURATION");
  const dtend = get(master, "DTEND");
  if (durProp) {
    event.duration = durProp.value.trim();
  } else if (dtend) {
    const endInfo = parseIcsDt(dtend);
    if (endInfo) {
      const startMs = zonedToUtc(startInfo.local, startInfo.allDay ? "Etc/UTC" : (endInfo.timeZone ?? timeZone));
      const endMs = zonedToUtc(endInfo.local, endInfo.allDay ? "Etc/UTC" : (endInfo.timeZone ?? timeZone));
      const ms = endMs - startMs;
      if (ms > 0 && !(startInfo.allDay && ms === 86_400_000)) event.duration = msToDuration(ms);
    }
  }

  const rules: RecurrenceRule[] = [];
  for (const p of master.filter((p) => p.name === "RRULE")) {
    const rule = rruleToRule(p.value.trim(), timeZone);
    if (rule) rules.push(rule);
    else warnings.push(`unsupported RRULE kept out: ${p.value.slice(0, 60)}`);
  }
  if (rules.length > 0) event.recurrenceRules = rules;

  const overrides: Record<string, Record<string, unknown>> = {};
  for (const p of master.filter((p) => p.name === "EXDATE")) {
    for (const v of p.value.split(",")) {
      const info = parseIcsDt({ name: "EXDATE", params: p.params, value: v.trim() });
      if (info) overrides[formatLocalDateTime(info.local)] = { excluded: true };
    }
  }
  for (const b of blocks) {
    const rid = get(b, "RECURRENCE-ID");
    if (!rid) continue;
    const ridInfo = parseIcsDt(rid);
    if (!ridInfo) continue;
    const patch: Record<string, unknown> = {};
    const ds = get(b, "DTSTART");
    const dsInfo = ds ? parseIcsDt(ds) : null;
    if (dsInfo) patch.start = formatLocalDateTime(dsInfo.local);
    const sm = get(b, "SUMMARY");
    if (sm) patch.title = unescapeIcs(sm.value);
    const du = get(b, "DURATION");
    if (du) patch.duration = du.value.trim();
    overrides[formatLocalDateTime(ridInfo.local)] = patch;
  }
  if (Object.keys(overrides).length > 0) event.recurrenceOverrides = overrides;

  return { event, warnings };
}
