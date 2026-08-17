// The demo backend for `/` — driven under `?demo=1`, and built by COMPOSING the
// two installers the other sections already ship, not by cloning their
// fixtures.
//
// Home reads two realms, so its demo is the union of two realms' fakes:
//   • approvals — `installApprovalsDemo` (../approvals/demoApprovals.ts), whose
//     `demoProposals` are anchored to `now` with relative offsets, so the
//     Waiting Approvals clocks are always mid-flight and the near-expiry / held
//     rows land inside the Looking Ahead horizon on their own.
//   • calendar — `installDemoCalendar` (../calendar/demoCalendar.ts), plus two
//     rows anchored to TODAY and TOMORROW so the horizon actually shows
//     calendar items. The month-anchored fixtures rarely fall on today, so
//     without these the calendar half of Looking Ahead would usually be empty
//     under demo — a demo that silently omits half of what the page is FOR.
//
// The two extra rows are the only new fixture data, and they are pushed onto
// the SAME `rows` array the calendar handlers close over (that array is
// returned from `createDemoCalendar`), so no handler is re-registered and the
// calendar's own semantics — including its refusal to expand recurrence — are
// untouched.

import { demoApprovalsOptions, installApprovalsDemo } from "../approvals/demoApprovals";
import { formatCivilDateTime, type CivilDate } from "../calendar/civil";
import { installDemoCalendar } from "../calendar/demoCalendar";
import type { CalendarEvent } from "../calendar/types";
import type { FakeJmapClient } from "../jmap/FakeJmapClient";
import { horizonDays } from "./horizon";

export interface HomeDemoOptions {
  now?: number;
  /** The viewer's zone — the today/tomorrow events are placed in it. */
  viewerZone?: string;
  /** URL search, forwarded to the approvals demo for the `?send=0` knob. */
  search?: string;
}

/**
 * A calendar row shaped exactly like `demoCalendar`'s internal `DemoEventRow`
 * (which is not exported). Kept structural so it can be pushed onto the backend's
 * `rows` without importing the private type.
 */
interface HorizonEventRow {
  id: string;
  calendarId: string;
  uid: string;
  event: CalendarEvent;
  cannedStarts?: string[];
}

/** One timed event today and one all-day event tomorrow — the horizon's calendar half. */
export function horizonEventRows(now: number, viewerZone: string): HorizonEventRow[] {
  const [today, tomorrow] = horizonDays(now, viewerZone);
  const at = (d: CivilDate, hour: number): string => formatCivilDateTime({ ...d, hour, minute: 0, second: 0 });
  return [
    {
      // Timed, in the viewer's OWN zone so the placement is exact regardless of
      // where the demo runs.
      id: "ev-home-today",
      calendarId: "cal-personal",
      uid: "urn:uuid:demo-home-today",
      event: {
        id: "ev-home-today",
        "@type": "Event",
        uid: "urn:uuid:demo-home-today",
        title: "Sync with Grace",
        start: at(today, 15),
        duration: "PT30M",
        timeZone: viewerZone,
      },
    },
    {
      // All-day tomorrow, stored the way the CalDAV importer stores a VALUE=DATE
      // DTSTART (midnight, Etc/UTC, showWithoutTime) so `place.ts` lands it on
      // the right civil day for every viewer.
      id: "ev-home-tomorrow",
      calendarId: "cal-personal",
      uid: "urn:uuid:demo-home-tomorrow",
      event: {
        id: "ev-home-tomorrow",
        "@type": "Event",
        uid: "urn:uuid:demo-home-tomorrow",
        title: "Midbury Fair setup",
        start: at(tomorrow, 0),
        timeZone: "Etc/UTC",
        showWithoutTime: true,
      },
    },
  ];
}

/** Attach both realms to a running demo client, and seed the horizon's events. */
export function installHomeDemo(client: FakeJmapClient, opts: HomeDemoOptions = {}): void {
  const now = opts.now ?? Date.now();
  const viewerZone = opts.viewerZone ?? "UTC";
  installApprovalsDemo(client, demoApprovalsOptions(opts.search ?? ""));
  const calendar = installDemoCalendar(client, now);
  calendar.rows.push(...horizonEventRows(now, viewerZone));
}
