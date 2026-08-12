// Demo wiring for `/search` (`?demo=1`): the search page fans out to three
// realms, so its demo is the three realms' existing fakes COMPOSED, not a
// fourth fake. `createDemoBackend()` already registers `Email/query`
// (`../jmap/demo.ts:416`); this adds the contacts and calendar realms onto the
// same `FakeJmapClient` through the public `setHandler` seam
// (`../jmap/FakeJmapClient.ts:109`) — the side-module pattern `/contacts` and
// `/calendar` established (`../contacts/demo.ts:21-25`,
// `../calendar/demoCalendar.ts:6-11`), so no shared demo file is edited and
// three sections cannot collide in one.
//
// The fixtures already carry a cross-realm term: "Elk" appears in mail
// subjects ("Project Elk kickoff"), a contact organization and a group card
// ("Project Elk"), and an event title ("Elk standup") — so one demo query
// exercises every leg of the fan-out. `fanout.test.ts` leans on that.
//
// ⚠️ One deliberate demo-only lie, inherited: the mail fake still matches
// subject/preview/from/to ONLY — no body index (`../mail/search.ts:27-30`
// carries the same caveat for `/mail`). The scope note describes the REAL
// server, as it does on `/mail`; against demo data a body-only word will miss.
//
// Loaded via dynamic `import()` in the island, demo-mode only — the fixtures
// and their handlers never reach a live bundle (same discipline as
// `CalendarView.tsx:144`).

import { installDemoCalendar } from "../calendar/demoCalendar";
import { installContactsDemo } from "../contacts/demo";
import type { FakeJmapClient } from "../jmap/FakeJmapClient";

/** Attach the contacts + calendar realms to a running demo client. */
export function installSearchDemo(client: FakeJmapClient, nowMs: number = Date.now()): void {
  installContactsDemo(client);
  installDemoCalendar(client, nowMs);
}
