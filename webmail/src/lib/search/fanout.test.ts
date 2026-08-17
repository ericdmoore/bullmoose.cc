import { describe, expect, it } from "vitest";
import { installDemoCalendar } from "../calendar/demoCalendar";
import type { CalendarEvent } from "../calendar/types";
import type { ContactCard } from "../contacts/types";
import { createDemoBackend } from "../jmap/demo";
import type { Email } from "../mail/types";
import { cardHit, emailHit, eventHit, runSearch, type SearchResponse } from "./fanout";
import { installSearchDemo } from "./demoSearch";
import { planSearch } from "./plan";

// A fixed instant so the calendar fixture anchors deterministically.
const NOW = Date.parse("2026-08-10T12:00:00Z");

/** The full demo composition the `/search` island installs under `?demo=1`. */
async function searchDemo(query: string): Promise<SearchResponse> {
  const demo = createDemoBackend();
  installSearchDemo(demo.client, NOW);
  const session = await demo.client.session();
  return runSearch(demo.client, planSearch(session, query));
}

describe("the fan-out over the demo backend", () => {
  it("answers one query from all three realms — the fixtures share 'elk'", async () => {
    const response = await searchDemo("elk");
    const byRealm = new Map(response.outcomes.map((o) => [o.realm, o]));

    // Mail: "Project Elk kickoff" and its reply (../jmap/demo.ts fixtures).
    const mail = byRealm.get("mail");
    expect(mail?.error).toBeUndefined();
    expect(mail?.hits.map((h) => h.title)).toEqual(
      expect.arrayContaining(["Project Elk kickoff", "Re: Project Elk kickoff"]),
    );

    // Contacts: Grace's organization and the "Project Elk" group card.
    const contacts = byRealm.get("contacts");
    expect(contacts?.hits.map((h) => h.id)).toEqual(expect.arrayContaining(["cc-grace", "cc-elk"]));

    // Calendar: the "Elk standup" series.
    const calendar = byRealm.get("calendar");
    expect(calendar?.hits.map((h) => h.title)).toContain("Elk standup");
  });

  it("carries the coverage declaration ON the response envelope", async () => {
    // Refinement 4: coverage is declared in the response, never implied by
    // which endpoint answered — so no consumer can show hits without scope.
    const response = await searchDemo("elk");
    expect(response.coverage.map((c) => c.realm)).toEqual(["mail", "contacts", "calendar", "files"]);
    expect(response.coverage.find((c) => c.realm === "files")).toMatchObject({
      searched: false,
      reason: "no search path yet",
    });
    expect(response.gaps).toEqual([{ label: "attachment contents", reason: "requires the extraction index" }]);
  });

  it("tags every hit with its realm, and finds nothing for a nonsense term", async () => {
    const hits = (await searchDemo("elk")).outcomes.flatMap((o) => o.hits);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(["mail", "contacts", "calendar"]).toContain(hit.realm);

    const empty = await searchDemo("xyzzy-no-such-term");
    for (const outcome of empty.outcomes) {
      expect(outcome.hits).toEqual([]);
      expect(outcome.error).toBeUndefined();
    }
  });

  it("lets a realm fail ALONE: a dead contacts realm does not blank mail or calendar", async () => {
    // Compose the demo WITHOUT the contacts realm: `ContactCard/query` is then
    // an unknown method, exactly what a server without the datatype returns.
    const demo = createDemoBackend();
    installDemoCalendar(demo.client, NOW);
    const session = await demo.client.session();
    const response = await runSearch(demo.client, planSearch(session, "elk"));

    const byRealm = new Map(response.outcomes.map((o) => [o.realm, o]));
    expect(byRealm.get("contacts")?.error).toBeTruthy();
    expect(byRealm.get("contacts")?.hits).toEqual([]);
    // The failure is the contacts realm's alone.
    expect(byRealm.get("mail")?.hits.length).toBeGreaterThan(0);
    expect(byRealm.get("mail")?.error).toBeUndefined();
    expect(byRealm.get("calendar")?.hits.length).toBeGreaterThan(0);
    expect(byRealm.get("calendar")?.error).toBeUndefined();
  });

  it("reports the server's total so truncation is observable", async () => {
    const mail = (await searchDemo("elk")).outcomes.find((o) => o.realm === "mail");
    // Two fixture emails match; the total must be the match count, not the page.
    expect(mail?.total).toBe(2);
  });
});

describe("hit shaping", () => {
  it("shapes an email: sender + preview snippet, receivedAt as when", () => {
    const email = {
      id: "em-1",
      subject: "Project Elk kickoff",
      from: [{ name: "Grace Hopper", email: "grace@example.test" }],
      receivedAt: "2026-08-01T09:00:00Z",
      preview: "Kickoff notes attached.",
    } as unknown as Email;
    expect(emailHit(email)).toEqual({
      realm: "mail",
      id: "em-1",
      title: "Project Elk kickoff",
      snippet: "Grace Hopper — Kickoff notes attached.",
      when: "2026-08-01T09:00:00Z",
    });
  });

  it("never renders an empty title", () => {
    const email = {
      id: "em-2",
      subject: "",
      from: [],
      receivedAt: "",
      preview: "",
    } as unknown as Email;
    expect(emailHit(email).title).toBe("(no subject)");
    expect(eventHit({ id: "ev-x" } as CalendarEvent).title).toBe("(untitled event)");
  });

  it("shapes a card: display name, email · organization", () => {
    const card = {
      id: "cc-1",
      uid: "urn:uuid:x",
      "@type": "Card",
      version: "1.0",
      name: { full: "Grace Hopper" },
      emails: { e1: { address: "grace@example.test" } },
      organizations: { o1: { name: "Project Elk" } },
    } as unknown as ContactCard;
    expect(cardHit(card)).toEqual({
      realm: "contacts",
      id: "cc-1",
      title: "Grace Hopper",
      snippet: "grace@example.test · Project Elk",
    });
  });

  it("shapes an event and keeps `when` a LOCAL wall clock, untouched", () => {
    const event = {
      id: "ev-1",
      title: "Elk standup",
      description: "Fifteen minutes,   standing up.",
      start: "2026-08-10T09:00:00",
      timeZone: "America/New_York",
    } as CalendarEvent;
    expect(eventHit(event)).toEqual({
      realm: "calendar",
      id: "ev-1",
      title: "Elk standup",
      // Whitespace collapsed by the clip, content otherwise verbatim.
      snippet: "Fifteen minutes, standing up.",
      when: "2026-08-10T09:00:00",
    });
  });
});
