import { describe, expect, it } from "vitest";
import { EOD_UTC_HOUR, SCAN_LIMIT, extractDueAt } from "./dueDate";

/**
 * The boundary due-date extractor (s11 T1). The table below is the contract:
 * which deadline shapes stamp, and — the half that matters more — which do
 * NOT. A wrong `due_at` is worse than none (s11 readme caution 3), so every
 * ambiguous, relative-without-anchor, past, or merely date-SHAPED input must
 * come back NULL (never-urgent), and the hits must land on the exact instant
 * the sender named.
 *
 * All arithmetic is UTC (no account timezone exists in the schema — see the
 * module header); "end of day" is pinned to 17:00 UTC by its own test so the
 * hour cannot drift silently.
 */

// Tuesday, 2026-08-11, noon UTC — the same anchor the webmail clock tests use.
const NOW = Date.parse("2026-08-11T12:00:00Z");

const at = (iso: string): number => Date.parse(iso);

/** Most cases only vary the text; subject stays inert unless the case says. */
const extract = (text: string, now = NOW, subject = "no cues here"): number | null =>
  extractDueAt({ subject, text, now });

describe("extractDueAt — hits land on the instant the sender named", () => {
  it.each([
    // ---- explicit ISO-ish dates ----
    ["by 2026-08-20", "2026-08-20T17:00:00Z"],
    ["due 2026-08-20 16:30", "2026-08-20T16:30:00Z"],
    ["due 2026-08-20T09:05", "2026-08-20T09:05:00Z"],
    ["due by 2026-09-01", "2026-09-01T17:00:00Z"], // compound cue reduces to "by"
    ["deadline: 2026-08-15", "2026-08-15T17:00:00Z"],
    ["Deadline is 2026-08-14", "2026-08-14T17:00:00Z"],
    ["no later than 2026-08-21", "2026-08-21T17:00:00Z"],
    ["until 2026-08-18", "2026-08-18T17:00:00Z"],
    // ---- "by <weekday>" (from Tuesday 2026-08-11) ----
    ["can you review this by Friday?", "2026-08-14T17:00:00Z"],
    ["reply due Thu", "2026-08-13T17:00:00Z"],
    ["due on Wednesday", "2026-08-12T17:00:00Z"],
    // ---- EOD / end of day ----
    ["need this by EOD", "2026-08-11T17:00:00Z"],
    ["by end of day", "2026-08-11T17:00:00Z"],
    ["by end of the day", "2026-08-11T17:00:00Z"],
    ["before COB", "2026-08-11T17:00:00Z"],
    ["by close of business", "2026-08-11T17:00:00Z"],
    ["can you review this by EOD Thursday", "2026-08-13T17:00:00Z"], // the readme's example
    ["by COB Fri", "2026-08-14T17:00:00Z"],
    // ---- "by <Month> <day>" ----
    ["by August 20", "2026-08-20T17:00:00Z"],
    ["due Aug 20, 2026", "2026-08-20T17:00:00Z"],
    ["due Aug. 20 2026", "2026-08-20T17:00:00Z"],
    ["by Sep 3rd", "2026-09-03T17:00:00Z"],
    ["by September 3", "2026-09-03T17:00:00Z"],
  ])("%s → %s", (text, iso) => {
    expect(extract(text)).toBe(at(iso));
  });

  it("honors a same-day weekday while business hours remain", () => {
    // "by Friday" sent Friday 10:00 UTC means TODAY, not next week.
    const friday10 = Date.parse("2026-08-14T10:00:00Z");
    expect(extract("by Friday", friday10)).toBe(at("2026-08-14T17:00:00Z"));
  });

  it("rolls a weekday across a month boundary", () => {
    // Saturday 2026-08-29 → the next Tuesday is 2026-09-01.
    const sat = Date.parse("2026-08-29T09:00:00Z");
    expect(extract("by Tuesday", sat)).toBe(at("2026-09-01T17:00:00Z"));
  });

  it("scans the subject line, not only the body", () => {
    expect(extractDueAt({ subject: "Report due 2026-08-20", text: "see attached", now: NOW })).toBe(
      at("2026-08-20T17:00:00Z"),
    );
  });

  it("prefers the most explicit form when several match", () => {
    // Pattern precedence (ISO > month-day > EOD > weekday), then position:
    // the vague restatement must not shadow the dated one.
    expect(extract("by Friday at the latest, hard deadline: 2026-08-21")).toBe(at("2026-08-21T17:00:00Z"));
  });

  it("pins end-of-day to 17:00 UTC — the no-account-timezone delta, stated", () => {
    // No account carries a timezone anywhere in the schema, so EOD resolves in
    // UTC. For a US sender that is EARLIER than meant (errs toward escalating
    // sooner, never toward missing the deadline). If an account tz ever lands,
    // this constant is where it threads in.
    expect(EOD_UTC_HOUR).toBe(17);
    expect(extract("by 2026-08-20")).toBe(Date.UTC(2026, 7, 20, EOD_UTC_HOUR, 0));
  });
});

describe("extractDueAt — near-misses and ambiguity return NULL (never-urgent)", () => {
  it.each([
    // date-SHAPED but not deadline-shaped: no cue word introduces it
    ["we met on 2026-08-01 to discuss"],
    ["the 2026-08-20 build is broken"],
    ["see you Friday!"],
    // relative-without-anchor — deliberately unsupported in the no-model pass
    ["please handle this tomorrow"],
    ["in two days"],
    ["by next week"],
    ["ASAP please"],
    ["due soon"],
    // "next <weekday>": this week's or the following's? Ambiguous → NULL.
    ["by next Friday"],
    // cue-adjacent words that are NOT deadlines
    ["the outage was due to Friday's storm"],
    ["I like Friday better than Monday"], // bare "than" must not be a cue
    ["by the way, nice work"],
    ["standing by Monaco this summer"], // "by <proper noun>" — no date form
    // month + year but no day: not a day-precise deadline
    ["by June 2026"],
    // invalid calendar dates must not roll over into real ones
    ["by 2026-02-30"],
    ["by 2026-08-20 25:00"],
    ["by February 30"],
    // no deadline text at all
    ["quarterly numbers attached, no rush"],
    [""],
  ])("%s → null", (text) => {
    expect(extract(text)).toBeNull();
  });

  it("returns NULL for a past explicit date — mis-parse or moot, never overdue-at-birth", () => {
    expect(extract("by 2026-07-01")).toBeNull(); // now is 2026-08-11
    expect(extract("due Aug 1, 2026")).toBeNull();
    expect(extract("by 2025-12-31")).toBeNull();
  });

  it("returns NULL for a year-less month-day that already passed — never a next-year guess", () => {
    expect(extract("by March 3")).toBeNull(); // 2026-03-03 < now; 2027 would be an 11-month guess
  });

  it("returns NULL for a same-day weekday after business hours — the day is over", () => {
    const friday18 = Date.parse("2026-08-14T18:00:00Z");
    expect(extract("by Friday", friday18)).toBeNull();
  });

  it("returns NULL for EOD once 17:00 UTC has passed", () => {
    const late = Date.parse("2026-08-11T17:30:00Z");
    expect(extract("need this by EOD", late)).toBeNull();
  });

  it("does not read EOD out of a longer word", () => {
    expect(extract("caused by eodermdrome rules")).toBeNull();
  });

  it("ignores deadlines buried past the scan limit — quoted history restates old ones", () => {
    const buried = `${"x".repeat(SCAN_LIMIT)} reply by 2026-08-20`;
    expect(extract(buried)).toBeNull();
    // …while the same text inside the window extracts.
    expect(extract(`reply by 2026-08-20 ${"x".repeat(SCAN_LIMIT)}`)).toBe(at("2026-08-20T17:00:00Z"));
  });
});
