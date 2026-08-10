import { describe, expect, it } from "vitest";
import { MAX_SPILL_IN_DAYS } from "./grid";
import {
  CANDIDATE_EVENT_LIMIT,
  DEFAULT_OCCURRENCE_CAP,
  EVENT_SEARCH_SCOPE_NOTE,
  MAX_OCCURRENCE_CAP,
  describeTruncation,
  isTruncated,
  spillInNote,
  truncationOf,
} from "./scope";

describe("the constants track the server", () => {
  it("matches the numbers in calendars.ts and calendar-core", () => {
    // getOccurrences: `limit: 256` for candidates (calendars.ts:426),
    // `maxOccurrences ?? 200` capped at MAX_OCCURRENCES = 1000
    // (calendars.ts:411-414, calendar-core:62).
    expect(CANDIDATE_EVENT_LIMIT).toBe(256);
    expect(DEFAULT_OCCURRENCE_CAP).toBe(200);
    expect(MAX_OCCURRENCE_CAP).toBe(1000);
  });
});

describe("truncation is detected, not guessed", () => {
  it("is clean when everything fit", () => {
    const t = truncationOf(40, 200, 12);
    expect(t).toEqual({ occurrences: false, candidates: false });
    expect(isTruncated(t)).toBe(false);
    expect(describeTruncation(t, 40)).toBe("");
  });

  it("flags the per-request occurrence cap", () => {
    const t = truncationOf(500, 200, 12);
    expect(t.occurrences).toBe(true);
    expect(describeTruncation(t, 200)).toMatch(/INCOMPLETE/);
    expect(describeTruncation(t, 200)).toMatch(/occurrence cap/);
  });

  it("flags the 256-candidate ceiling from the separate count", () => {
    const t = truncationOf(120, 200, 900);
    expect(t.candidates).toBe(true);
    expect(describeTruncation(t, 120)).toMatch(/256 events/);
    expect(describeTruncation(t, 120)).toMatch(/earliest-starting/);
  });

  it("cannot flag the candidate ceiling when the count is unavailable", () => {
    // The honesty call is best-effort; claiming truncation we did not observe
    // would be its own kind of lie.
    expect(truncationOf(120, 200, undefined).candidates).toBe(false);
  });

  it("names both causes when both bit", () => {
    const note = describeTruncation(truncationOf(500, 200, 900), 200);
    expect(note).toMatch(/256 events/);
    expect(note).toMatch(/occurrence cap/);
    expect(note).toMatch(/Narrow to a week or a day/);
  });
});

describe("the notes say what is true", () => {
  it("does not claim the search is indexed", () => {
    // `common/004` gave mail FTS5; `queryCalendarEvents` is still the LIKE it
    // replaced (devPlan.md:438-441). The note must not imply otherwise.
    expect(EVENT_SEARCH_SCOPE_NOTE).toMatch(/no index/);
    expect(EVENT_SEARCH_SCOPE_NOTE).toMatch(/full scan/);
    // The two words that would claim mail's treatment: this realm has neither.
    expect(EVENT_SEARCH_SCOPE_NOTE).not.toMatch(/FTS/i);
    expect(EVENT_SEARCH_SCOPE_NOTE).not.toMatch(/\bindexed\b/i);
    expect(EVENT_SEARCH_SCOPE_NOTE).toMatch(/Not searched/);
  });

  it("states the spill-in limit in the same days the window actually pads", () => {
    expect(spillInNote(MAX_SPILL_IN_DAYS)).toContain(String(MAX_SPILL_IN_DAYS));
  });
});
