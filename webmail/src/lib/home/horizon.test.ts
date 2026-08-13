import { describe, expect, it } from "vitest";
import type { ActionProposal } from "../approvals/types";
import type { Occurrence } from "../calendar/types";
import {
  ALLDAY_MINUTE,
  eventItems,
  expiringItems,
  holdItems,
  horizonDays,
  horizonEnd,
  HORIZON_MS,
  lookingAhead,
} from "./horizon";

const NOW = Date.parse("2026-08-11T12:00:00Z");
const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ZONE = "Etc/UTC"; // explicit, so the test is deterministic under any host TZ

function proposal(partial: Partial<ActionProposal> & Pick<ActionProposal, "id">): ActionProposal {
  return {
    agent: "Emily",
    kind: "reply-draft",
    tier: 2,
    subject: { realm: "Email", objectId: "e-1" },
    payload: { to: "grace@example.test", subject: "Re: kickoff" },
    editedPayload: null,
    rationale: "why",
    evidence: [],
    status: "pending",
    decision: null,
    createdAt: new Date(NOW - HOUR).toISOString(),
    decidedAt: null,
    holdUntil: null,
    expiresAt: null,
    question: null,
    amendments: [],
    invocationStatus: "done",
    claimedAt: null,
    ...partial,
  };
}

function timed(id: string, iso: string, mins = 30): Occurrence {
  const startMs = Date.parse(iso);
  return {
    eventId: id,
    calendarId: "cal-1",
    uid: `uid-${id}`,
    recurrenceId: iso.replace("Z", ""),
    start: iso.replace("Z", ""),
    utcStart: new Date(startMs).toISOString(),
    utcEnd: new Date(startMs + mins * MIN).toISOString(),
    title: id,
    showWithoutTime: false,
  };
}

describe("horizonDays / horizonEnd", () => {
  it("gives today and tomorrow as civil dates in the viewer's zone", () => {
    expect(horizonDays(NOW, ZONE)).toEqual([
      { year: 2026, month: 8, day: 11 },
      { year: 2026, month: 8, day: 12 },
    ]);
  });

  it("extends the proposal horizon two days out", () => {
    expect(horizonEnd(NOW)).toBe(NOW + HORIZON_MS);
    expect(HORIZON_MS).toBe(2 * DAY);
  });
});

describe("the two clocks stay DISTINCT (s07 §T0)", () => {
  // The bug the module exists to prevent: one proposal carrying BOTH
  // timestamps must yield exactly ONE horizon item, of the kind its status
  // dictates, with the label sourced from the matching clock.
  const both = {
    expiresAt: new Date(NOW + 35 * MIN).toISOString(),
    holdUntil: new Date(NOW + 3 * MIN).toISOString(),
  };

  it("a PENDING proposal is an 'expiring' item — its deadline clock, never the hold", () => {
    const p = proposal({ id: "pb", status: "pending", ...both });
    expect(expiringItems([p], NOW, horizonEnd(NOW), ZONE).map((i) => i.id)).toEqual(["expiring:pb"]);
    expect(holdItems([p], NOW, horizonEnd(NOW), ZONE)).toEqual([]);
    const item = expiringItems([p], NOW, horizonEnd(NOW), ZONE)[0]!;
    expect(item.clockLabel).toBe("expires in 35m");
    expect(item.clockLabel).not.toContain("retraction");
  });

  it("a HELD proposal is a 'hold' item — its retraction clock, never the deadline", () => {
    const p = proposal({ id: "hb", status: "held", decidedAt: new Date(NOW - 2 * MIN).toISOString(), ...both });
    expect(holdItems([p], NOW, horizonEnd(NOW), ZONE).map((i) => i.id)).toEqual(["hold:hb"]);
    expect(expiringItems([p], NOW, horizonEnd(NOW), ZONE)).toEqual([]);
    const item = holdItems([p], NOW, horizonEnd(NOW), ZONE)[0]!;
    // Worded so nothing reads as egress — before OR after the window lapses.
    expect(item.clockLabel).toContain("nothing has been sent");
    expect(item.clockLabel).not.toContain("expires in");
  });

  it("a hold item's label never claims a send even once the window has lapsed", () => {
    const p = proposal({ id: "lapsed", status: "held", decidedAt: new Date(NOW - 6 * MIN).toISOString(), holdUntil: new Date(NOW - MIN).toISOString() });
    const item = holdItems([p], NOW, horizonEnd(NOW), ZONE)[0]!;
    expect(item.clockLabel).toContain("still not sent");
    expect(item.clockLabel).toContain("s03.D T2");
  });
});

describe("horizon windowing", () => {
  it("excludes a pending proposal whose deadline is beyond the horizon", () => {
    const far = proposal({ id: "far", status: "pending", expiresAt: new Date(NOW + 5 * DAY).toISOString() });
    expect(expiringItems([far], NOW, horizonEnd(NOW), ZONE)).toEqual([]);
  });

  it("includes a pending proposal expiring inside the horizon", () => {
    const near = proposal({ id: "near", status: "pending", expiresAt: new Date(NOW + 6 * HOUR).toISOString() });
    expect(expiringItems([near], NOW, horizonEnd(NOW), ZONE).map((i) => i.id)).toEqual(["expiring:near"]);
  });

  it("ignores proposals with no deadline at all — no invented clock", () => {
    const open = proposal({ id: "open", status: "pending", expiresAt: null });
    expect(expiringItems([open], NOW, horizonEnd(NOW), ZONE)).toEqual([]);
  });
});

describe("eventItems — reuses the calendar's own placement", () => {
  it("buckets timed occurrences onto today and tomorrow in the viewer's zone", () => {
    const occ = [
      timed("today-pm", "2026-08-11T15:00:00Z"),
      timed("tomorrow-am", "2026-08-12T09:00:00Z"),
      timed("day-after", "2026-08-13T09:00:00Z"), // outside the two-day window
    ];
    const days = horizonDays(NOW, ZONE);
    const items = eventItems(occ, ZONE, days);
    expect(items.map((i) => i.title).sort()).toEqual(["today-pm", "tomorrow-am"]);
    const today = items.find((i) => i.title === "today-pm")!;
    expect(today.dayKey).toBe("2026-08-11");
    expect(today.minute).toBe(15 * 60);
    expect(today.clockLabel).toBe("15:00");
  });

  it("marks an all-day occurrence with the all-day sort minute", () => {
    const allDay: Occurrence = {
      eventId: "fair",
      calendarId: "cal-1",
      uid: "uid-fair",
      recurrenceId: "2026-08-12T00:00:00",
      start: "2026-08-12T00:00:00",
      utcStart: "2026-08-12T00:00:00Z",
      utcEnd: "2026-08-13T00:00:00Z",
      title: "Fair",
      showWithoutTime: true,
    };
    const [item] = eventItems([allDay], ZONE, horizonDays(NOW, ZONE));
    expect(item!.allDay).toBe(true);
    expect(item!.minute).toBe(ALLDAY_MINUTE);
    expect(item!.clockLabel).toBe("all day");
  });
});

describe("lookingAhead — one chronological list across realms", () => {
  it("orders by day, then all-day ahead of timed, then time", () => {
    const occurrences = [
      timed("today-3pm", "2026-08-11T15:00:00Z"),
      {
        eventId: "fair",
        calendarId: "cal-1",
        uid: "uid-fair",
        recurrenceId: "2026-08-12T00:00:00",
        start: "2026-08-12T00:00:00",
        utcStart: "2026-08-12T00:00:00Z",
        utcEnd: "2026-08-13T00:00:00Z",
        title: "Fair",
        showWithoutTime: true,
      } satisfies Occurrence,
    ];
    const proposals = [
      proposal({ id: "expiring-soon", status: "pending", expiresAt: new Date(NOW + 2 * HOUR).toISOString() }),
      proposal({ id: "held-now", status: "held", decidedAt: new Date(NOW - MIN).toISOString(), holdUntil: new Date(NOW + 4 * MIN).toISOString() }),
    ];
    const items = lookingAhead({ proposals, occurrences, viewerZone: ZONE, now: NOW });
    // 08-11: hold (12:04), expiring (14:00), event (15:00); then 08-12 all-day.
    expect(items.map((i) => i.kind)).toEqual(["hold", "expiring", "event", "event"]);
    expect(items.map((i) => i.id)).toEqual([
      "hold:held-now",
      "expiring:expiring-soon",
      "event:today-3pm:2026-08-11T15:00:00:2026-08-11",
      "event:fair:2026-08-12T00:00:00:2026-08-12",
    ]);
  });

  it("degrades to calendar-only when there are no proposals (the plain-client floor)", () => {
    const items = lookingAhead({
      proposals: [],
      occurrences: [timed("today-3pm", "2026-08-11T15:00:00Z")],
      viewerZone: ZONE,
      now: NOW,
    });
    expect(items.map((i) => i.kind)).toEqual(["event"]);
  });
});
