package ical

// The iCal/RRULE codec, tested the way packages/cli/src/calendar.test.ts tests
// its TypeScript twin — same cases, same fixtures.
//
// The recurrence GUARD gets the most attention here, and deliberately: common/003
// is a live correctness bug in which the parser accepts rules the SERVER's
// expander silently mis-expands. `FREQ=YEARLY;BYMONTH=11;BYDAY=4TH` is
// Thanksgiving, a shape Apple Calendar emits, and it expands to the start day of
// every November instead. Nothing downstream can tell a correct write from that
// one, so the check has to be here and it has to be exact.

import (
	"strings"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jsobj"
)

// ---- the guard --------------------------------------------------------------

func TestRruleGuardRejectsTheThanksgivingShape(t *testing.T) {
	_, err := ValidateRrule("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH")
	if err == nil {
		t.Fatal("FREQ=YEARLY;BYDAY=4TH parses clean but the YEARLY branch discards BYDAY — it must be refused")
	}
	if code := bmio.ExitCodeFor(err); code != bmio.ExitUsage {
		t.Errorf("exit = %d, want 2 (usage)", code)
	}
	msg := err.Error()
	if !strings.Contains(msg, "BYDAY") || !strings.Contains(msg, "YEARLY") {
		t.Errorf("the message must name the discarded part AND the branch: %q", msg)
	}
}

func TestRruleGuardAcceptsWhatTheExpanderReads(t *testing.T) {
	rule, err := ValidateRrule("FREQ=WEEKLY;BYDAY=MO,WE,FR;INTERVAL=1")
	if err != nil {
		t.Fatalf("a supported rule was refused: %v", err)
	}
	if rule.Frequency != "weekly" {
		t.Errorf("frequency = %q", rule.Frequency)
	}
	if len(rule.ByDay) != 3 || rule.ByDay[0].Day != "mo" || rule.ByDay[2].Day != "fr" {
		t.Errorf("byDay = %+v", rule.ByDay)
	}
}

// TestRruleGuardCatchesTheOrdinalACheckWouldMiss — BYDAY is in the WEEKLY part
// set, so a plain part-level check passes `FREQ=WEEKLY;BYDAY=2MO`, yet
// nthOfPeriod is only read by the MONTHLY branch. This is the same class of bug
// as Thanksgiving, one level down.
func TestRruleGuardCatchesTheOrdinalACheckWouldMiss(t *testing.T) {
	if got := RruleReason(ParseRruleString("FREQ=WEEKLY;BYDAY=2MO")); !strings.Contains(got, "MONTHLY") {
		t.Errorf("reason = %q, want it to name the MONTHLY branch", got)
	}
	// …but the same ordinal under MONTHLY is fine ("the 2nd Monday").
	if got := RruleReason(ParseRruleString("FREQ=MONTHLY;BYDAY=2MO")); got != "" {
		t.Errorf("reason = %q, want none", got)
	}
}

func TestRruleGuardNamesTheOtherTwoFailures(t *testing.T) {
	if got := RruleReason(ParseRruleString("FREQ=HOURLY")); !strings.Contains(got, "no expander branch") {
		t.Errorf("reason = %q", got)
	}
	if got := RruleReason(ParseRruleString("FREQ=DAILY;BYHOUR=9")); !strings.Contains(got, "unknown RRULE part BYHOUR") {
		t.Errorf("reason = %q", got)
	}
	if got := RruleReason(ParseRruleString("")); !strings.Contains(got, "(missing)") {
		t.Errorf("an absent FREQ must say so: %q", got)
	}
}

// TestRuleJSONKeyOrderIsTheTypedOrder — `--rrule` writes the parsed rule straight
// into recurrenceRules, and JSON.stringify emits insertion order, so the bytes on
// the wire follow the order the user typed the tokens in.
func TestRuleJSONKeyOrderIsTheTypedOrder(t *testing.T) {
	rule := ParseRruleString("BYDAY=MO;FREQ=WEEKLY;INTERVAL=2")
	raw, err := rule.JSON().MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	want := `{"byDay":[{"day":"mo"}],"frequency":"weekly","interval":2}`
	if string(raw) != want {
		t.Errorf("json = %s, want %s", raw, want)
	}
	// The iCal IMPORT path uses the fixed order instead — two orders on purpose,
	// both transcribed from the TypeScript.
	fixed, err := rule.JSONFixed().MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if string(fixed) != `{"frequency":"weekly","interval":2,"byDay":[{"day":"mo"}]}` {
		t.Errorf("fixed json = %s", fixed)
	}
}

// ---- the round trip ---------------------------------------------------------

func TestICalRoundTripPreservesATimedUTCEvent(t *testing.T) {
	event := jsobj.New()
	_ = event.Set("uid", "u1")
	_ = event.Set("title", "Lunch, w/ Bob")
	_ = event.Set("start", "2026-07-08T12:00:00")
	_ = event.Set("timeZone", "Etc/UTC")
	_ = event.Set("duration", "PT1H")
	rule, err := ValidateRrule("FREQ=WEEKLY;BYDAY=TU")
	if err != nil {
		t.Fatal(err)
	}
	_ = event.Set("recurrenceRules", []any{rule.JSONFixed()})

	ics := SerializeEvent(event)
	for _, want := range []string{
		"BEGIN:VEVENT", "DTSTART:20260708T120000Z",
		`SUMMARY:Lunch\, w/ Bob`, // the comma is escaped per RFC 5545 §3.3.11
		"RRULE:FREQ=WEEKLY;BYDAY=TU",
	} {
		if !strings.Contains(ics, want) {
			t.Errorf("iCal is missing %q:\n%s", want, ics)
		}
	}

	back, warnings, err := ParseEvent(ics)
	if err != nil {
		t.Fatalf("re-parse failed: %v (%v)", err, warnings)
	}
	if got := back.StrOr("title", ""); got != "Lunch, w/ Bob" {
		t.Errorf("title = %q", got)
	}
	if got := back.StrOr("start", ""); got != "2026-07-08T12:00:00" {
		t.Errorf("start = %q", got)
	}
	if got := back.StrOr("timeZone", ""); got != "Etc/UTC" {
		t.Errorf("timeZone = %q", got)
	}
	if got := back.StrOr("duration", ""); got != "PT1H" {
		t.Errorf("duration = %q", got)
	}
	rules := back.Arr("recurrenceRules")
	if len(rules) != 1 || string(rules[0]) != `{"frequency":"weekly","byDay":[{"day":"tu"}]}` {
		t.Errorf("recurrenceRules = %s", rules)
	}
}

func TestICalAllDayAndTZIDPassThrough(t *testing.T) {
	allDay := jsobj.New()
	_ = allDay.Set("uid", "u2")
	_ = allDay.Set("title", "Holiday")
	_ = allDay.Set("start", "2026-12-25T00:00:00")
	_ = allDay.Set("timeZone", "Etc/UTC")
	_ = allDay.Set("showWithoutTime", true)
	ics := SerializeEvent(allDay)
	if !strings.Contains(ics, "DTSTART;VALUE=DATE:20261225") {
		t.Errorf("all-day must use a DATE value: %s", ics)
	}
	back, _, err := ParseEvent(ics)
	if err != nil {
		t.Fatal(err)
	}
	if !back.Bool("showWithoutTime") {
		t.Errorf("showWithoutTime lost: %v", back.Keys())
	}
	if got := back.StrOr("start", ""); got != "2026-12-25T00:00:00" {
		t.Errorf("start = %q", got)
	}

	zoned := jsobj.New()
	_ = zoned.Set("uid", "u3")
	_ = zoned.Set("title", "Standup")
	_ = zoned.Set("start", "2026-07-08T09:00:00")
	_ = zoned.Set("timeZone", "America/Chicago")
	_ = zoned.Set("duration", "PT15M")
	// TZID is passed through WITHOUT a generated VTIMEZONE: Apple and Google
	// resolve named IANA zones from their own database, and the VTIMEZONE
	// machinery lives in the server's CalDAV face.
	got := SerializeEvent(zoned)
	if !strings.Contains(got, "DTSTART;TZID=America/Chicago:20260708T090000") {
		t.Errorf("zoned DTSTART: %s", got)
	}
	if !strings.Contains(got, "DURATION:PT15M") {
		t.Errorf("zoned DURATION: %s", got)
	}
	if strings.Contains(got, "BEGIN:VTIMEZONE") {
		t.Errorf("this codec must not invent a VTIMEZONE: %s", got)
	}
}

// TestICalImportRefusesAnUnexpandableRule — unlike the SERVER's import codec,
// which warns and drops, the CLI create path refuses: silently creating a
// non-recurring event from a recurring source is the failure to avoid.
func TestICalImportRefusesAnUnexpandableRule(t *testing.T) {
	_, _, err := ParseEvent("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\n" +
		"DTSTART:20261126T090000Z\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH\r\n" +
		"END:VEVENT\r\nEND:VCALENDAR\r\n")
	if err == nil {
		t.Fatal("an unexpandable RRULE arriving via iCal must be refused, not dropped")
	}
	if code := bmio.ExitCodeFor(err); code != bmio.ExitUsage {
		t.Errorf("exit = %d, want 2", code)
	}
}

func TestICalMissingDTSTARTIsAWarningNotACrash(t *testing.T) {
	event, warnings, err := ParseEvent("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if event != nil {
		t.Errorf("want no event, got %v", event.Keys())
	}
	if len(warnings) == 0 || !strings.Contains(warnings[0], "DTSTART") {
		t.Errorf("warnings = %v", warnings)
	}
}

func TestICalDTENDBecomesADuration(t *testing.T) {
	event, _, err := ParseEvent("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\n" +
		"DTSTART:20260708T090000Z\r\nDTEND:20260708T101500Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
	if err != nil {
		t.Fatal(err)
	}
	if got := event.StrOr("duration", ""); got != "PT1H15M" {
		t.Errorf("duration = %q, want PT1H15M", got)
	}
}

func TestParseDurationMs(t *testing.T) {
	cases := []struct {
		in   string
		want int64
	}{
		{"PT15M", 900_000},
		{"PT1H", 3_600_000},
		{"P1D", 86_400_000},
		{"P1W", 604_800_000},
		{"-PT30M", -1_800_000},
		{"nonsense", 0},
	}
	for _, c := range cases {
		if got := ParseDurationMs(c.in, true); got != c.want {
			t.Errorf("ParseDurationMs(%q) = %d, want %d", c.in, got, c.want)
		}
	}
	if got := ParseDurationMs("PT1H", false); got != 0 {
		t.Errorf("a non-string duration is 0, got %d", got)
	}
}

func TestFoldingIsByUTF16Units(t *testing.T) {
	event := jsobj.New()
	_ = event.Set("uid", "u")
	_ = event.Set("title", strings.Repeat("a", 200))
	_ = event.Set("start", "2026-07-08T09:00:00")
	_ = event.Set("timeZone", "Etc/UTC")
	out := SerializeEvent(event)
	for _, line := range strings.Split(out, "\r\n") {
		if len(line) > 75 {
			t.Errorf("line exceeds 75 (%d): %q", len(line), line)
		}
	}
	back, _, err := ParseEvent(out)
	if err != nil {
		t.Fatal(err)
	}
	if got := back.StrOr("title", ""); got != strings.Repeat("a", 200) {
		t.Errorf("folding is not reversible: %q", got)
	}
}

// TestNoExpanderLivesHere is a structural guard, not a behavioural one: sVOL 018
// and the brief both say recurrence expansion is the SERVER's. If a future change
// starts turning rules into dates here, this package grows a function that takes
// a rule and a window — and the reviewer should be made to argue for it.
func TestNoExpanderLivesHere(t *testing.T) {
	// The only rule→something functions this package exposes are the guard and
	// the two serialisers. Expansion would need a start date and a window, and
	// nothing here accepts either.
	rule := ParseRruleString("FREQ=DAILY;COUNT=3")
	if RruleReason(rule) != "" {
		t.Fatal("fixture rule should be supported")
	}
	if got := ruleToRrule(rule); got != "FREQ=DAILY;COUNT=3" {
		t.Errorf("ruleToRrule = %q — it renders a rule, it does not expand one", got)
	}
}
