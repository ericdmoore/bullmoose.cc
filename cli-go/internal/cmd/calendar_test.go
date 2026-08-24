package cmd

// `bullmoose calendar` (s08 T6 wave 3 / sVOL 018) against a recording fake.
//
// The load-bearing property here is the one sVOL 018 spent its whole "What sVOL
// adds" section on: THE CLIENT MUST NOT WRITE A RULE THE SERVER CANNOT EXPAND.
// `FREQ=YEARLY;BYMONTH=11;BYDAY=4TH` parses clean and the YEARLY branch discards
// BYDAY, so a write would succeed and land on the wrong dates every year. The
// guard is client-side and above the first round trip, which is why the tests
// below assert a request COUNT of zero and not merely an exit code.

import (
	"strings"
	"testing"
)

func runCalendarCmd(t *testing.T, f *cardFake, argv ...string) (out, errOut string, code int) {
	t.Helper()
	srv := f.start(t)
	db := seedMailMirror(t, srv.URL, "tok", "")
	return runCmd(t, runCalendar, db, "calendar", argv...)
}

// ---- the request ------------------------------------------------------------

func TestCalendarListSendsCalendarGet(t *testing.T) {
	f := newCardFake().withCalendars()
	out, _, code := runCalendarCmd(t, f, "list", "--ids")
	if code != 0 {
		t.Fatalf("code = %d, want 0", code)
	}
	if got, want := strings.Join(f.names(), ","), "Calendar/get"; got != want {
		t.Errorf("calls = %s, want %s", got, want)
	}
	if args := f.argsOf("Calendar/get"); args != `{"accountId":"a_you","ids":null}` {
		t.Errorf("args = %s, want ids:null (every calendar)", args)
	}
	if got, want := out, "cal_default\ncal_work\n"; got != want {
		t.Errorf("--ids = %q, want %q", got, want)
	}
	if len(f.usings) == 0 || strings.Join(f.usings[0], ",") !=
		"urn:ietf:params:jmap:core,urn:ietf:params:jmap:calendars" {
		t.Errorf("using = %v, want core+calendars", f.usings)
	}
}

// TestCalendarAgendaAsksTheServerToExpand is the recurrence boundary, asserted:
// `agenda` calls getOccurrences and does NOT read recurrenceRules itself. A Go
// expander appearing in this package would show up here as a missing call.
func TestCalendarAgendaAsksTheServerToExpand(t *testing.T) {
	f := newCardFake().withCalendars()
	f.replies["CalendarEvent/getOccurrences"] = `{"accountId":"a_you","list":[` +
		`{"eventId":"ev_1","title":"Standup","utcStart":"2026-07-08T14:00:00Z",` +
		`"utcEnd":"2026-07-08T14:15:00Z"}]}`
	out, _, code := runCalendarCmd(t, f, "agenda", "--days", "3", "--ids")
	if code != 0 {
		t.Fatalf("code = %d, want 0", code)
	}
	if got, want := strings.Join(f.names(), ","), "CalendarEvent/getOccurrences"; got != want {
		t.Errorf("calls = %s, want ONLY getOccurrences — expansion is the server's", got)
	}
	args := f.argsOf("CalendarEvent/getOccurrences")
	if !strings.Contains(args, `"after":`) || !strings.Contains(args, `"before":`) {
		t.Errorf("args = %s, want the after/before window", args)
	}
	// --ids emits the MASTER event id, because that is the only thing a write verb
	// can address (occurrences are keyed eventId+recurrenceId server-side).
	if got, want := out, "ev_1\n"; got != want {
		t.Errorf("--ids = %q, want the master event id %q", out, want)
	}
}

func TestCalendarAgendaJSONIsTheServersOwnBytes(t *testing.T) {
	f := newCardFake().withCalendars()
	f.replies["CalendarEvent/getOccurrences"] = `{"accountId":"a_you","list":[` +
		`{"eventId":"ev_1","title":"Standup","utcStart":"2026-07-08T14:00:00Z","recurrenceId":"2026-07-08"}]}`
	out, _, code := runCalendarCmd(t, f, "agenda", "--json")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	want := `{"eventId":"ev_1","title":"Standup","utcStart":"2026-07-08T14:00:00Z","recurrenceId":"2026-07-08"}` + "\n"
	if out != want {
		t.Errorf("stdout = %q, want %q", out, want)
	}
}

func TestCalendarAgendaUnknownMethodIsExit2(t *testing.T) {
	// The contract suite's own §1.5 case: a method this server does not implement
	// is a usage error at the CLI/server-version boundary — no retry fixes it.
	f := newCardFake().withCalendars()
	_, errOut, code := runCalendarCmd(t, f, "agenda")
	if code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if !strings.Contains(errOut, "unknownMethod") {
		t.Errorf("stderr = %q, want the reason named", errOut)
	}
}

func TestCalendarExportEnumeratesThenFetches(t *testing.T) {
	f := newCardFake().withCalendars()
	out, _, code := runCalendarCmd(t, f, "export", "--ids")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if got, want := strings.Join(f.names(), ","), "CalendarEvent/query,CalendarEvent/get"; got != want {
		t.Errorf("calls = %s, want %s — CalendarEvent/get with ids:null is not guaranteed", got, want)
	}
	if args := f.argsOf("CalendarEvent/query"); args != `{"accountId":"a_you"}` {
		t.Errorf("query args = %s, want no filter", args)
	}
	if out != "ev_1\n" {
		t.Errorf("--ids = %q", out)
	}
}

func TestCalendarExportCalendarResolvesByNameThenFilters(t *testing.T) {
	f := newCardFake().withCalendars()
	_, _, code := runCalendarCmd(t, f, "export", "--calendar", "work", "--ids")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if got, want := strings.Join(f.names(), ","),
		"Calendar/get,CalendarEvent/query,CalendarEvent/get"; got != want {
		t.Errorf("calls = %s, want %s", got, want)
	}
	// Case-insensitive by NAME, and the resolved ID is what reaches the wire.
	if args := f.argsOf("CalendarEvent/query"); !strings.Contains(args,
		`"filter":{"inCalendar":"cal_work"}`) {
		t.Errorf("query args = %s", args)
	}
}

func TestCalendarExportICSIsSerialisedFromJSCalendar(t *testing.T) {
	f := newCardFake().withCalendars()
	out, _, code := runCalendarCmd(t, f, "export", "--ics")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	for _, want := range []string{
		"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//bullmoose//cli//EN",
		"BEGIN:VEVENT", "UID:urn:uuid:ev1", "SUMMARY:Standup",
		"DTSTART:20260708T090000Z", "DTEND:20260708T091500Z", "END:VCALENDAR",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("iCal export is missing %q:\n%s", want, out)
		}
	}
	if !strings.Contains(out, "\r\n") {
		t.Error("iCal lines are CRLF-terminated (RFC 5545 §3.1)")
	}
}

func TestCalendarEventCreateSendsTheEvent(t *testing.T) {
	f := newCardFake().withCalendars()
	f.replies["CalendarEvent/set"] = `{"accountId":"a_you","created":{"c0":{"id":"ev_new"}},` +
		`"notCreated":{},"newState":"calstate-2"}`
	out, errOut, code := runCalendarCmd(t, f, "event", "create",
		"--title", "Standup", "--start", "2026-07-08T09:00:00", "--duration", "PT15M",
		"--calendar", "Work")
	if code != 0 {
		t.Fatalf("code = %d (%s)", code, errOut)
	}
	if got, want := strings.Join(f.names(), ","), "Calendar/get,CalendarEvent/set"; got != want {
		t.Errorf("calls = %s, want %s", got, want)
	}
	args := f.argsOf("CalendarEvent/set")
	for _, want := range []string{
		`"title":"Standup"`, `"start":"2026-07-08T09:00:00"`, `"duration":"PT15M"`,
		`"calendarIds":{"cal_work":true}`,
	} {
		if !strings.Contains(args, want) {
			t.Errorf("set args = %s, missing %s", args, want)
		}
	}
	if got, want := out, "created Standup (ev_new)\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
}

func TestCalendarEventCreateSendsAValidatedRule(t *testing.T) {
	f := newCardFake().withCalendars()
	f.replies["CalendarEvent/set"] = `{"accountId":"a_you","created":{"c0":{"id":"ev_new"}},"notCreated":{}}`
	_, errOut, code := runCalendarCmd(t, f, "event", "create",
		"--title", "Weekly", "--start", "2026-07-08T09:00:00",
		"--rrule", "FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2")
	if code != 0 {
		t.Fatalf("code = %d (%s)", code, errOut)
	}
	// The rule reaches the wire as a JSCalendar RecurrenceRule, in the key order
	// the RRULE tokens were typed in — which is JSON.stringify's insertion order.
	args := f.argsOf("CalendarEvent/set")
	want := `"recurrenceRules":[{"frequency":"weekly","byDay":[{"day":"mo"},{"day":"we"}],"interval":2}]`
	if !strings.Contains(args, want) {
		t.Errorf("set args = %s\nwant to contain %s", args, want)
	}
}

func TestCalendarRmMapsCalendarHasEventsToConflict(t *testing.T) {
	// `calendarHasEvents` is NOT in the §1.5 table (io.ts is not this unit's to
	// edit), so the command maps it locally to the conflict class it belongs to —
	// with the --force hint, exactly like `mailbox rm` on a non-empty folder.
	f := newCardFake().withCalendars()
	f.replies["Calendar/set"] = `{"accountId":"a_you","destroyed":[],` +
		`"notDestroyed":{"cal_work":{"type":"calendarHasEvents","description":"has events"}}}`
	_, errOut, code := runCalendarCmd(t, f, "rm", "Work")
	if code != 5 {
		t.Fatalf("code = %d, want 5 (conflict)", code)
	}
	if !strings.Contains(errOut, "--force") {
		t.Errorf("the refusal must name the resolution: %q", errOut)
	}
}

func TestCalendarRmForceSendsOnDestroyRemoveEvents(t *testing.T) {
	f := newCardFake().withCalendars()
	f.replies["Calendar/set"] = `{"accountId":"a_you","destroyed":["cal_work"],"notDestroyed":{}}`
	_, errOut, code := runCalendarCmd(t, f, "rm", "Work", "--force")
	if code != 0 {
		t.Fatalf("code = %d (%s)", code, errOut)
	}
	if args := f.argsOf("Calendar/set"); !strings.Contains(args, `"onDestroyRemoveEvents":true`) {
		t.Errorf("set args = %s, want --force to become onDestroyRemoveEvents", args)
	}
}

// ---- a refusal costs nothing ------------------------------------------------

func TestCalendarMissingArgumentsCostZeroRequests(t *testing.T) {
	cases := []struct {
		name string
		argv []string
		want int
	}{
		{"no subcommand", nil, 2},
		{"unknown subcommand", []string{"wat"}, 2},
		{"create without a name", []string{"create"}, 2},
		{"rename without a new name", []string{"rename", "Work"}, 2},
		{"rm without a selector", []string{"rm"}, 2},
		{"event without a verb", []string{"event"}, 2},
		{"event unknown verb", []string{"event", "wat"}, 2},
		{"event edit without an id", []string{"event", "edit"}, 2},
		{"event rm without an id", []string{"event", "rm"}, 2},
		{"event create without a start", []string{"event", "create", "--title", "X"}, 2},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newCardFake().withCalendars()
			_, errOut, code := runCalendarCmd(t, f, c.argv...)
			if code != c.want {
				t.Errorf("code = %d, want %d (%s)", code, c.want, errOut)
			}
			if n := f.count(); n != 0 {
				t.Errorf("a refused invocation sent %d request(s) (%v); it must send none",
					n, f.names())
			}
		})
	}
}

// TestCalendarUnexpandableRruleIsRefusedBeforeAnyRequest is common/003's guard,
// which is the reason this command has an RRULE parser at all. The rule PARSES;
// it is the expander that would discard BYDAY, so nothing but this check stands
// between a clean refusal and a write that succeeds and is silently wrong.
func TestCalendarUnexpandableRruleIsRefusedBeforeAnyRequest(t *testing.T) {
	cases := []struct {
		name, rrule, wantIn string
	}{
		{"the Thanksgiving shape", "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH", "BYDAY"},
		{"an ordinal outside MONTHLY", "FREQ=WEEKLY;BYDAY=2MO", "MONTHLY"},
		{"a frequency with no branch", "FREQ=HOURLY", "no expander branch"},
		{"an unknown part", "FREQ=DAILY;BYHOUR=9", "unknown RRULE part BYHOUR"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newCardFake().withCalendars()
			_, errOut, code := runCalendarCmd(t, f, "event", "create",
				"--title", "X", "--start", "2026-11-26T09:00:00", "--rrule", c.rrule)
			if code != 2 {
				t.Fatalf("code = %d, want 2", code)
			}
			if !strings.Contains(errOut, c.wantIn) {
				t.Errorf("stderr = %q, want it to name %q", errOut, c.wantIn)
			}
			if n := f.count(); n != 0 {
				t.Errorf("the guard must run before the network; sent %d request(s)", n)
			}
			if strings.Contains(errOut, "goroutine") || strings.Contains(errOut, ".go:") {
				t.Errorf("a refusal is not a crash: %q", errOut)
			}
		})
	}
}

// TestCalendarUnexpandableRruleViaICalIsRefusedToo — unlike the server's import
// codec, which warns and drops, the CLI create path REFUSES: silently creating a
// NON-recurring event from a recurring source is the failure mode to avoid.
func TestCalendarUnexpandableRruleViaICalIsRefusedToo(t *testing.T) {
	f := newCardFake().withCalendars()
	withStdin(t, "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261126T090000Z\r\n"+
		"RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
	_, errOut, code := runCalendarCmd(t, f, "event", "create", "-")
	if code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if !strings.Contains(errOut, "BYDAY") {
		t.Errorf("stderr = %q, want the discarded part named", errOut)
	}
	if n := f.count(); n != 0 {
		t.Errorf("sent %d request(s); the guard is client-side", n)
	}
}

// #222 — s05 T3's Done-when, finally met: "editing one occurrence leaves the
// other occurrences untouched (asserted in a test, not assumed)."
//
// The old test here pinned the REFUSAL, which is the assertion the issue
// says was wrong: the devPlan permitted refusing a BARE edit aimed at an
// occurrence id, and REQUIRED --occurrence to write a recurrenceOverrides
// entry. These pin the write.
func TestCalendarOccurrenceEditWritesAnOverride(t *testing.T) {
	f := newCardFake().withCalendars().withEventWrites("ev_1")
	out, errOut, code := runCalendarCmd(t, f,
		"event", "edit", "ev_1", "--occurrence", "2026-07-08T09:00:00", "--title", "moved one")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	body := f.argsOf("CalendarEvent/set")
	// The patch is a NESTED pointer path, which is what leaves every other
	// occurrence's override in place: replacing `recurrenceOverrides` whole
	// would silently drop them.
	if !strings.Contains(body, `recurrenceOverrides/2026-07-08T09:00:00/title`) {
		t.Errorf("expected a nested override path in the patch:\n%s", body)
	}
	if strings.Contains(body, `"recurrenceOverrides":{`) {
		t.Errorf("the whole override map was replaced — the other occurrences would be lost:\n%s", body)
	}
	if !strings.Contains(out+errOut, "edited") {
		t.Errorf("chrome = %q", out+errOut)
	}
}

func TestCalendarOccurrenceRefusesSeriesShapedEdits(t *testing.T) {
	// Recurrence is a property of the SERIES (RFC 8984 §4.3.3), so an
	// override cannot carry one. Refusing NAMES the property instead of
	// letting the server bounce an opaque patch.
	f := newCardFake().withCalendars()
	_, errOut, code := runCalendarCmd(t, f,
		"event", "edit", "ev_1", "--occurrence", "2026-07-08T09:00:00", "--rrule", "FREQ=WEEKLY")
	if code != 2 || !strings.Contains(errOut, "property of the SERIES") {
		t.Fatalf("code=%d err=%s", code, errOut)
	}
	// The GET is legitimate (the patch is assembled against the stored
	// event); what must never happen is the WRITE.
	for _, name := range f.names() {
		if name == "CalendarEvent/set" {
			t.Error("a refused occurrence edit still sent CalendarEvent/set")
		}
	}
}

func TestCalendarOccurrenceIdMustBeALocalDateTime(t *testing.T) {
	// The recurrence id is a KEY in recurrenceOverrides, not a free string:
	// a typo'd key writes an override for an occurrence that does not exist,
	// which reads to the user as "the edit did nothing".
	f := newCardFake().withCalendars()
	_, errOut, code := runCalendarCmd(t, f, "event", "edit", "ev_1", "--occurrence", "2026-07-08", "--title", "x")
	if code != 2 || !strings.Contains(errOut, "LocalDateTime") {
		t.Fatalf("code=%d err=%s", code, errOut)
	}
	if n := f.count(); n != 0 {
		t.Errorf("sent %d request(s); the guard is client-side", n)
	}
}

func TestCalendarEventEditNeedsSomethingToChange(t *testing.T) {
	f := newCardFake().withCalendars()
	withStdin(t, "")
	_, errOut, code := runCalendarCmd(t, f, "event", "edit", "ev_1")
	if code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if !strings.Contains(errOut, "needs something to change") {
		t.Errorf("stderr = %q", errOut)
	}
	// The target IS resolved first (an unknown id must still be exit 3), so one
	// read is expected — but no write.
	if calls := f.mutatingCalls(); len(calls) != 0 {
		t.Errorf("an empty patch must not be written: %v", calls)
	}
}

func TestCalendarDryRunPerformsZeroMutations(t *testing.T) {
	cases := []struct {
		name string
		argv []string
	}{
		{"create", []string{"create", "New", "--dry-run"}},
		{"rename", []string{"rename", "Work", "Werk", "--dry-run"}},
		{"rm", []string{"rm", "Work", "--dry-run"}},
		{"event create", []string{"event", "create", "--title", "X",
			"--start", "2026-07-08T09:00:00", "--dry-run"}},
		{"event rm", []string{"event", "rm", "ev_1", "--dry-run"}},
		{"event edit", []string{"event", "edit", "ev_1", "--title", "Z", "--dry-run"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newCardFake().withCalendars()
			withStdin(t, "")
			out, errOut, code := runCalendarCmd(t, f, c.argv...)
			if code != 0 {
				t.Fatalf("code = %d (%s)", code, errOut)
			}
			if calls := f.mutatingCalls(); len(calls) != 0 {
				t.Errorf("invariant 4: --dry-run performed %v", calls)
			}
			if !strings.Contains(errOut, "dry run: would") {
				t.Errorf("the rehearsal belongs on stderr: %q", errOut)
			}
			if out != "" {
				t.Errorf("a rehearsal is not a record; stdout = %q", out)
			}
		})
	}
}

func TestCalendarDryRunStillResolves(t *testing.T) {
	f := newCardFake().withCalendars()
	_, _, code := runCalendarCmd(t, f, "rm", "NoSuchCalendar", "--dry-run")
	if code != 3 {
		t.Errorf("code = %d, want 3 — --dry-run resolves for real", code)
	}
}

// ---- a server no ------------------------------------------------------------

func TestCalendarServerRefusalsMapToTheTable(t *testing.T) {
	cases := []struct {
		name, typ string
		want      int
	}{
		{"forbidden", "forbidden", 4},
		{"stateMismatch", "stateMismatch", 5},
		{"invalidProperties", "invalidProperties", 2},
		{"serverFail", "serverFail", 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newCardFake().withCalendars()
			f.methodErrors["Calendar/set"] = [2]string{c.typ, "because"}
			_, errOut, code := runCalendarCmd(t, f, "create", "New")
			if code != c.want {
				t.Errorf("code = %d, want %d (%s)", code, c.want, errOut)
			}
			if !strings.Contains(errOut, c.typ) {
				t.Errorf("stderr = %q, want the type named", errOut)
			}
		})
	}
}

func TestCalendarSetErrorIsAsGoodAsAMethodError(t *testing.T) {
	// A PER-OBJECT refusal goes through the same table, so `forbidden` is exit 4
	// whether the server reported it per-object or method-level.
	f := newCardFake().withCalendars()
	f.replies["Calendar/set"] = `{"accountId":"a_you","created":{},` +
		`"notCreated":{"c0":{"type":"forbidden","description":"read-only account"}}}`
	_, errOut, code := runCalendarCmd(t, f, "create", "New")
	if code != 4 {
		t.Fatalf("code = %d, want 4", code)
	}
	if !strings.Contains(errOut, "create failed: forbidden — read-only account") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestCalendarUnknownSelectorsAreExit3(t *testing.T) {
	f := newCardFake().withCalendars()
	_, errOut, code := runCalendarCmd(t, f, "rename", "Nope", "Other")
	if code != 3 {
		t.Fatalf("code = %d, want 3", code)
	}
	if !strings.Contains(errOut, "no such calendar: Nope") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestCalendarAmbiguousNameIsExit2(t *testing.T) {
	// A name that matches two calendars is an error, not a coin flip — the same
	// stance cli/009 took for --account.
	f := newCardFake().withCalendars()
	f.replies["Calendar/get"] = `{"accountId":"a_you","state":"1","list":[` +
		`{"id":"cal_a","name":"Work"},{"id":"cal_b","name":"work"}],"notFound":[]}`
	_, errOut, code := runCalendarCmd(t, f, "rm", "Work")
	if code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if !strings.Contains(errOut, "cal_a, cal_b") {
		t.Errorf("the refusal must list the candidates: %q", errOut)
	}
}

// ---- --json goldens ---------------------------------------------------------

func TestCalendarJSONShapes(t *testing.T) {
	t.Run("list --json is the server's own bytes", func(t *testing.T) {
		f := newCardFake().withCalendars()
		out, _, code := runCalendarCmd(t, f, "list", "--json")
		if code != 0 {
			t.Fatalf("code = %d", code)
		}
		want := `{"id":"cal_default","name":"Personal","isDefault":true}` + "\n" +
			`{"id":"cal_work","name":"Work","isDefault":false}` + "\n"
		if out != want {
			t.Errorf("stdout = %q, want %q", out, want)
		}
	})

	t.Run("export --json is one whole event per line", func(t *testing.T) {
		f := newCardFake().withCalendars()
		out, _, code := runCalendarCmd(t, f, "export", "--json")
		if code != 0 {
			t.Fatalf("code = %d", code)
		}
		want := `{"id":"ev_1","@type":"Event","uid":"urn:uuid:ev1","title":"Standup",` +
			`"start":"2026-07-08T09:00:00","timeZone":"Etc/UTC","duration":"PT15M",` +
			`"calendarIds":{"cal_work":true}}` + "\n"
		if out != want {
			t.Errorf("stdout = %q\nwant %q", out, want)
		}
	})

	t.Run("a write reports action/id/name/state", func(t *testing.T) {
		f := newCardFake().withCalendars()
		f.replies["Calendar/set"] = `{"accountId":"a_you","created":{"c0":{"id":"cal_new"}},` +
			`"notCreated":{},"newState":"calstate-2"}`
		out, _, code := runCalendarCmd(t, f, "create", "Work", "--json")
		if code != 0 {
			t.Fatalf("code = %d", code)
		}
		want := `{"action":"created","id":"cal_new","name":"Work","state":"calstate-2"}` + "\n"
		if out != want {
			t.Errorf("stdout = %q, want %q", out, want)
		}
	})

	t.Run("--dry-run --json reports the rehearsal as data", func(t *testing.T) {
		f := newCardFake().withCalendars()
		out, _, code := runCalendarCmd(t, f, "create", "Work", "--json", "--dry-run")
		if code != 0 {
			t.Fatalf("code = %d", code)
		}
		want := `{"dryRun":true,"action":"create","target":"calendar \"Work\""}` + "\n"
		if out != want {
			t.Errorf("stdout = %q, want %q", out, want)
		}
	})

	t.Run("export --json wins over --ics", func(t *testing.T) {
		f := newCardFake().withCalendars()
		out, _, code := runCalendarCmd(t, f, "export", "--ics", "--json")
		if code != 0 {
			t.Fatalf("code = %d", code)
		}
		if strings.Contains(out, "BEGIN:VCALENDAR") {
			t.Errorf("--json must win over --ics: %q", out)
		}
	})
}
