import type { DatabaseSync } from "node:sqlite";
import { requireSettings, selectAccounts, type Settings } from "./db.js";
import { JmapClient } from "./jmap.js";

/**
 * bullmoose calendar — the agent-usefulness surface over the JSCalendar
 * core (Phase 4):
 *   calendar list                 calendars on the account
 *   calendar agenda [--days N]    upcoming occurrences, recurrence-expanded
 *                                 SERVER-side (CalendarEvent/getOccurrences)
 */

const CAL_USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"];

export interface CalendarOpts {
  account?: string;
  days?: string;
  json: boolean;
}

export async function cmdCalendar(
  db: DatabaseSync,
  positionals: string[],
  opts: CalendarOpts,
): Promise<void> {
  const [sub] = positionals;
  const settings = requireSettings(db);
  const accountId = pickAccount(settings, opts.account);
  const client = new JmapClient(settings.base, settings.token);

  switch (sub) {
    case "list": {
      const res = await client.one("Calendar/get", { accountId, ids: null }, CAL_USING);
      const cals = (res.list as Array<Record<string, unknown>>) ?? [];
      if (opts.json) {
        console.log(JSON.stringify(cals, null, 2));
        return;
      }
      for (const c of cals) {
        console.log(`${String(c.name).padEnd(24)} ${c.isDefault ? "★ default" : ""}  ${c.id}`);
      }
      if (cals.length === 0) console.log("(no calendars)");
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
      if (opts.json) {
        console.log(JSON.stringify(occ, null, 2));
        return;
      }
      if (occ.length === 0) {
        console.log(`(nothing scheduled in the next ${days} day${days === 1 ? "" : "s"})`);
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
          console.log(`\n${day}`);
          lastDay = day;
        }
        const time =
          o.showWithoutTime === true
            ? "all day"
            : `${start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}–${new Date(String(o.utcEnd)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
        console.log(`  ${time.padEnd(16)} ${o.title ?? "(untitled)"}`);
      }
      return;
    }
    default:
      console.error(`unknown calendar subcommand: ${sub ?? "(none)"} (list|agenda)`);
      process.exit(1);
  }
}

function pickAccount(settings: Settings, selector?: string): string {
  if (!selector) return settings.accountId;
  const matches = selectAccounts(settings, selector);
  if (matches.length !== 1) {
    console.error(`--account "${selector}" matches ${matches.length} accounts`);
    process.exit(1);
  }
  return matches[0]!.accountId;
}
