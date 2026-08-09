import type { DatabaseSync } from "node:sqlite";
import { pickAccountId, requireSettings } from "./db.js";
import { emitIds, emitNdjson, note, out, usage, type IoOpts } from "./io.js";
import { JmapClient } from "./jmap.js";

/**
 * bullmoose calendar — the agent-usefulness surface over the JSCalendar
 * core (Phase 4):
 *   calendar list                 calendars on the account
 *   calendar agenda [--days N]    upcoming occurrences, recurrence-expanded
 *                                 SERVER-side (CalendarEvent/getOccurrences)
 */

const CAL_USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"];

export interface CalendarOpts extends IoOpts {
  account?: string;
  days?: string;
}

export async function cmdCalendar(
  db: DatabaseSync,
  positionals: string[],
  opts: CalendarOpts,
): Promise<void> {
  const [sub] = positionals;
  const settings = requireSettings(db);
  const accountId = pickAccountId(settings, opts.account);
  const client = new JmapClient(settings.base, settings.token);

  switch (sub) {
    case "list": {
      const res = await client.one("Calendar/get", { accountId, ids: null }, CAL_USING);
      const cals = (res.list as Array<Record<string, unknown>>) ?? [];
      if (opts.ids) {
        emitIds(cals.map((c) => String(c.id)));
        return;
      }
      if (opts.json) {
        emitNdjson(cals);
        return;
      }
      for (const c of cals) {
        out(`${String(c.name).padEnd(24)} ${c.isDefault ? "★ default" : ""}  ${c.id}`);
      }
      if (cals.length === 0) note("(no calendars)");
      return;
    }
    case "agenda": {
      const days = Math.max(1, Number(opts.days) || 7);
      const after = new Date();
      const before = new Date(after.getTime() + days * 86_400_000);
      const res = await client.one(
        "CalendarEvent/getOccurrences",
        { accountId, after: after.toISOString(), before: before.toISOString() },
        CAL_USING,
      );
      const occ = (res.list as Array<Record<string, unknown>>) ?? [];
      if (opts.ids) {
        emitIds(occ.map((o) => String(o.id)));
        return;
      }
      if (opts.json) {
        emitNdjson(occ);
        return;
      }
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
          // A date heading is decoration between records, not a record.
          note(day);
          lastDay = day;
        }
        const time =
          o.showWithoutTime === true
            ? "all day"
            : `${start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}–${new Date(String(o.utcEnd)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
        out(`  ${time.padEnd(16)} ${String(o.title ?? "(untitled)")}  ${String(o.id ?? "")}`);
      }
      return;
    }
    default:
      usage(`unknown calendar subcommand: ${sub ?? "(none)"} (list|agenda)`);
  }
}
