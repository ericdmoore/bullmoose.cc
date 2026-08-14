package cmd

// `bullmoose calendar` — the JSCalendar surface (s08 T6 wave 3; a port of
// packages/cli/src/calendar.ts, specced by sVOL 018).
//
//	calendar list                              Calendar/get
//	calendar agenda [--days N]                 CalendarEvent/getOccurrences
//	calendar create|rename|rm                  Calendar/set
//	calendar event create|edit|rm              CalendarEvent/set
//	calendar export [--ics] [--calendar …]     CalendarEvent/query → get → iCal/JSON
//
// Subcommand dispatch is agents.go's shape, one front door and a nested one for
// `event`.
//
// ── RECURRENCE IS THE SERVER'S ────────────────────────────────────────────────
//
// Expansion happens in `CalendarEvent/getOccurrences` and nowhere else. There is
// no RRULE expander in this command or in internal/ical, and there must not be:
// `agenda` ASKS the server for occurrences and renders what comes back. What the
// client does carry is the common/003 GUARD — a named-part check that refuses a
// rule the server's expander cannot expand (`--rrule
// FREQ=YEARLY;BYMONTH=11;BYDAY=4TH` → exit 2, naming BYDAY) before any write,
// because that rule PARSES clean and would otherwise produce a series silently
// landing on the wrong dates.
//
// ── Two deliberate calls inherited from the TypeScript ───────────────────────
//
//  1. Single-occurrence editing is DEFERRED, not shipped half-working.
//     `--occurrence` refuses with exit 2 and points at the whole-series form
//     (s05 devPlan Risk / sVOL 018 §2). The refusal is checked BEFORE the event
//     is fetched, so it costs zero requests.
//  2. `calendarHasEvents` is not in the §1.5 exit-code table (io.ts is not this
//     unit's to edit), so `rm` maps it locally to the conflict class it belongs
//     to, with the --force hint — exactly as `mailbox rm` does on a non-empty
//     folder.
//
// ── One known, bounded divergence ────────────────────────────────────────────
//
// `agenda`'s HUMAN rendering uses locale date/time formatting. The TypeScript
// calls toLocaleDateString/toLocaleTimeString with an undefined locale, i.e.
// whatever ICU resolves for the host; Go has no ICU and formats with fixed
// patterns chosen to match en-US ("Wed, Jul 8", "09:00 AM"). Under a non-en-US
// locale the two implementations print the same events with different headings.
// `--json` and `--ids` are unaffected — they re-emit the server's own bytes —
// and the contract suite never reaches this path, because its stub leaves
// getOccurrences unimplemented on purpose. Recorded here rather than discovered.

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/ical"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jsobj"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// calendarRef is calendar.ts:67 CalendarRef.
type calendarRef struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	IsDefault bool   `json:"isDefault"`
}

type calendarRunner struct {
	s         *bmio.Streams
	a         args
	client    *jmap.Client
	accountID string
	ctx       context.Context
}

func runCalendar(s *bmio.Streams, argv []string) int {
	a := parse(argv)

	// calendar.ts:78 — settings, account, client, all before the verb switch, so
	// an unknown verb or a missing argument refuses having sent zero requests.
	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		return die(s, err)
	}
	defer db.Close()
	settings, err := store.RequireSettings(db)
	if err != nil {
		return die(s, err)
	}
	acc, err := resolveAccount(settings, a.Account)
	if err != nil {
		return die(s, err)
	}
	r := &calendarRunner{
		s: s, a: a, accountID: acc.AccountID, ctx: context.Background(),
		client: jmap.NewSessionClient(settings.Base, settings.Token),
	}

	sub, arg, arg2 := a.at(1), a.at(2), a.at(3)
	switch sub {
	case "list":
		return r.list()
	case "agenda":
		return r.agenda()
	case "create":
		if arg == "" {
			return die(s, bmio.Usage("bullmoose calendar create <name>"))
		}
		return r.createCalendar(arg)
	case "rename":
		if arg == "" || arg2 == "" {
			return die(s, bmio.Usage("bullmoose calendar rename <id-or-name> <new-name>"))
		}
		return r.renameCalendar(arg, arg2)
	case "rm":
		if arg == "" {
			return die(s, bmio.Usage("bullmoose calendar rm <id-or-name> [--force] [--dry-run]"))
		}
		return r.rmCalendar(arg)
	case "export":
		return r.export()
	case "event":
		return r.event(arg, arg2)
	default:
		named := sub
		if named == "" {
			named = "(none)"
		}
		return die(s, bmio.Usage("unknown calendar subcommand: "+named+
			" (list|agenda|create|rename|rm|event|export)"))
	}
}

// ---- request shapes ---------------------------------------------------------

type calendarGetArgs struct {
	AccountID string   `json:"accountId"`
	IDs       []string `json:"ids"` // always nil → `null`
}

type occurrencesArgs struct {
	AccountID string `json:"accountId"`
	After     string `json:"after"`
	Before    string `json:"before"`
}

type inCalendarFilter struct {
	InCalendar string `json:"inCalendar"`
}

type eventQueryArgs struct {
	AccountID string            `json:"accountId"`
	Filter    *inCalendarFilter `json:"filter,omitempty"`
}

type eventGetArgs struct {
	AccountID string   `json:"accountId"`
	IDs       []string `json:"ids"`
}

// ---- read -------------------------------------------------------------------

func (r *calendarRunner) list() int {
	cals, err := r.rawCalendars()
	if err != nil {
		return die(r.s, err)
	}
	if r.a.IDs {
		ids := make([]string, len(cals))
		for i, c := range cals {
			ids[i] = c.JSString("id")
		}
		r.s.EmitIDs(ids)
		return 0
	}
	if r.a.JSON {
		return r.emitObjects(cals)
	}
	for _, c := range cals {
		def := ""
		if c.Bool("isDefault") {
			def = "★ default"
		}
		r.s.Out(padRight(c.JSString("name"), 24) + " " + def + "  " + c.JSString("id"))
	}
	if len(cals) == 0 {
		r.s.Note("(no calendars)")
	}
	return 0
}

func (r *calendarRunner) agenda() int {
	days := jsLimit(r.a.Days, 7)
	after := time.Now()
	before := after.Add(time.Duration(days*86_400_000) * time.Millisecond)
	raw, err := r.client.One(r.ctx, "CalendarEvent/getOccurrences", occurrencesArgs{
		AccountID: r.accountID,
		After:     isoMillis(after),
		Before:    isoMillis(before),
	}, jmap.CalendarUsing)
	if err != nil {
		// The stub server (and any server predating the method) answers
		// `unknownMethod`, which the §1.5 table maps to exit 2 — a usage error at
		// the CLI/server-version boundary, because no retry fixes it.
		return die(r.s, err)
	}
	occ, err := listOf(raw)
	if err != nil {
		return die(r.s, err)
	}

	// The addressable id for `event edit|rm` is the MASTER event's id, so that is
	// what --ids emits: the server keys occurrences by eventId+recurrenceId, and
	// there is no standalone occurrence id to hand to a write verb.
	if r.a.IDs {
		ids := make([]string, len(occ))
		for i, o := range occ {
			ids[i] = occurrenceID(o)
		}
		r.s.EmitIDs(ids)
		return 0
	}
	if r.a.JSON {
		return r.emitObjects(occ)
	}
	if len(occ) == 0 {
		plural := "s"
		if days == 1 {
			plural = ""
		}
		r.s.Note("(nothing scheduled in the next " + num(days) + " day" + plural + ")")
		return 0
	}
	lastDay := ""
	for _, o := range occ {
		start, ok := parseISO(o.JSString("utcStart"))
		if !ok {
			continue
		}
		day := start.Local().Format("Mon, Jan 2")
		if day != lastDay {
			// A date heading is decoration between records, not a record.
			r.s.Note(day)
			lastDay = day
		}
		slot := "all day"
		if !o.Bool("showWithoutTime") {
			endTime := start
			if e, ok := parseISO(o.JSString("utcEnd")); ok {
				endTime = e
			}
			slot = clockTime(start) + "–" + clockTime(endTime)
		}
		r.s.Out("  " + padRight(slot, 16) + " " + o.JSStringOr("title", "(untitled)") +
			"  " + occurrenceID(o))
	}
	return 0
}

// occurrenceID is `String(o.eventId ?? o.id ?? "")`.
func occurrenceID(o *jsobj.Object) string {
	if raw, ok := o.Raw("eventId"); ok && string(raw) != "null" {
		return jsobj.JSStringOf(raw)
	}
	if raw, ok := o.Raw("id"); ok && string(raw) != "null" {
		return jsobj.JSStringOf(raw)
	}
	return ""
}

// clockTime is `toLocaleTimeString(undefined, {hour:"2-digit",minute:"2-digit"})`
// for en-US. See the file header's divergence note.
func clockTime(t time.Time) string { return t.Local().Format("03:04 PM") }

// ---- Calendar/set -----------------------------------------------------------

func (r *calendarRunner) createCalendar(name string) int {
	if r.dryRun("create", `calendar "`+name+`"`) {
		return 0
	}
	raw, err := r.client.One(r.ctx, "Calendar/set", r.setArgs(jmap.Member{
		Key: "create", Value: jmap.Object{{Key: "c0", Value: map[string]string{"name": name}}},
	}), jmap.CalendarUsing)
	if err != nil {
		return die(r.s, err)
	}
	res := parseSetResponse(raw)
	made, ok := res.Created["c0"]
	if !ok || made.ID == "" {
		return die(r.s, failSetErrorOf("create", res.NotCreated["c0"]))
	}
	return r.reportWrite("created", made.ID, name, res.state())
}

func (r *calendarRunner) renameCalendar(selector, newName string) int {
	target, err := r.resolveCalendar(selector)
	if err != nil {
		return die(r.s, err)
	}
	if r.dryRun("rename", target.Name+" → "+newName) {
		return 0
	}
	raw, err := r.client.One(r.ctx, "Calendar/set", r.setArgs(jmap.Member{
		Key:   "update",
		Value: jmap.Object{{Key: target.ID, Value: map[string]string{"name": newName}}},
	}), jmap.CalendarUsing)
	if err != nil {
		return die(r.s, err)
	}
	res := parseSetResponse(raw)
	if _, ok := res.Updated[target.ID]; !ok {
		return die(r.s, failSetErrorOf("rename", res.NotUpdated[target.ID]))
	}
	return r.reportWrite("renamed", target.ID, newName, res.state())
}

func (r *calendarRunner) rmCalendar(selector string) int {
	// Resolve for real even under --dry-run: an unknown calendar still exits 3.
	target, err := r.resolveCalendar(selector)
	if err != nil {
		return die(r.s, err)
	}
	andEvents := ""
	if r.a.Force {
		andEvents = " and its events"
	}
	if r.dryRun("rm", target.Name+" ("+target.ID+")"+andEvents) {
		return 0
	}
	members := []jmap.Member{{Key: "destroy", Value: []string{target.ID}}}
	if r.a.Force {
		// --force is onDestroyRemoveEvents: without it a calendar holding events
		// is refused (the server's default, and the right one).
		members = append(members, jmap.Member{Key: "onDestroyRemoveEvents", Value: true})
	}
	raw, err := r.client.One(r.ctx, "Calendar/set", r.setArgs(members...), jmap.CalendarUsing)
	if err != nil {
		return die(r.s, err)
	}
	res := parseSetResponse(raw)
	if !containsString(res.Destroyed, target.ID) {
		e := res.NotDestroy[target.ID]
		if e.Type == "calendarHasEvents" {
			return die(r.s, bmio.Conflict(`rm refused: "`+target.Name+
				`" still holds events — pass --force to remove them too`))
		}
		return die(r.s, failSetErrorOf("rm", e))
	}
	return r.reportWrite("destroyed", target.ID, target.Name, res.state())
}

// ---- CalendarEvent/set ------------------------------------------------------

func (r *calendarRunner) event(verb, id string) int {
	switch verb {
	case "create":
		return r.eventCreate(id) // rest[1] — a path or `-`, not an id
	case "edit":
		if id == "" {
			return die(r.s, bmio.Usage(
				"bullmoose calendar event edit <id> [--title …] [--rrule …] [<patch.json>|-]"))
		}
		return r.eventEdit(id)
	case "rm":
		if id == "" {
			return die(r.s, bmio.Usage("bullmoose calendar event rm <id> [--dry-run]"))
		}
		return r.eventRm(id)
	default:
		named := verb
		if named == "" {
			named = "(none)"
		}
		return die(r.s, bmio.Usage("unknown calendar event subcommand: "+named+" (create|edit|rm)"))
	}
}

func (r *calendarRunner) eventCreate(source string) int {
	// A body may arrive on stdin / a path / `-`; flags overlay it. With neither a
	// body nor --start there is nothing to create.
	input, err := readSource(source, r.a.As, r.a.HasAs, false, "")
	if err != nil {
		return die(r.s, err)
	}
	event := jsobj.New()
	if input != nil {
		switch input.Type {
		case typeJSON:
			parsed, perr := parseJSONEvent(input.Text, input.From)
			if perr != nil {
				return die(r.s, perr)
			}
			event = parsed
		case typeICal:
			parsed, warnings, perr := ical.ParseEvent(input.Text)
			for _, w := range warnings {
				r.s.Warn(w)
			}
			if perr != nil {
				return die(r.s, perr)
			}
			if parsed == nil {
				return die(r.s, bmio.Fail("no usable VEVENT in "+input.From, bmio.ExitUsage))
			}
			event = parsed
		default:
			return die(r.s, bmio.Fail(input.From+" looks like "+string(input.Type)+
				", not an event — pass --as ical or --as json", bmio.ExitUsage))
		}
	}
	if err := r.applyEventFlags(event); err != nil { // flags win over the body
		return die(r.s, err)
	}

	start, isStr := event.Str("start")
	if _, ok := ical.ParseLDT(start); !isStr || !ok {
		return die(r.s, bmio.Usage(
			"calendar event create needs a start: --start 2026-07-08T09:00:00, or a JSON/iCal body"))
	}

	// Target calendar: --calendar names it; otherwise the server's default.
	if r.a.Calendar != "" {
		cal, err := r.resolveCalendar(r.a.Calendar)
		if err != nil {
			return die(r.s, err)
		}
		ids := jsobj.New()
		_ = ids.Set(cal.ID, true)
		_ = event.Set("calendarIds", ids)
	}
	event.Delete("id") // server-set

	if r.dryRun("create", `event "`+event.JSStringOr("title", "(untitled)")+`" @ `+start) {
		return 0
	}
	raw, err := r.client.One(r.ctx, "CalendarEvent/set", r.setArgs(jmap.Member{
		Key: "create", Value: jmap.Object{{Key: "c0", Value: event}},
	}), jmap.CalendarUsing)
	if err != nil {
		return die(r.s, err)
	}
	res := parseSetResponse(raw)
	made, ok := res.Created["c0"]
	if !ok || made.ID == "" {
		return die(r.s, failSetErrorOf("create", res.NotCreated["c0"]))
	}
	return r.reportWrite("created", made.ID, event.JSStringOr("title", "(untitled)"), res.state())
}

func (r *calendarRunner) eventEdit(id string) int {
	// Single-occurrence editing (--occurrence <recurrenceId>) is DEFERRED, not
	// shipped half-working (s05 devPlan Risk; sVOL 018 §2). A clear refusal is the
	// sanctioned v1, and it happens here — above every round trip — so a mistyped
	// invocation cannot half-write.
	if r.a.HasOccurrence {
		return die(r.s, bmio.Fail(
			"single-occurrence editing (--occurrence) is not yet implemented; "+
				"`calendar event edit <id>` edits the whole series (the master). "+
				"To change one instance, edit the series or delete+recreate that date.",
			bmio.ExitUsage))
	}

	existing, err := r.getEvent(id)
	if err != nil {
		return die(r.s, err)
	}
	if existing == nil {
		return die(r.s, bmio.NotFound("no such event: "+id))
	}

	// The patch: a JSON body if given, plus anything from flags. Sent as a JMAP
	// PatchObject (top-level keys replace their property), so an EMPTY patch is a
	// usage error rather than a no-op write.
	patch := jsobj.New()
	input, err := readSource("", r.a.As, r.a.HasAs, false, "")
	if err != nil {
		return die(r.s, err)
	}
	if input != nil {
		if input.Type != typeJSON {
			return die(r.s, bmio.Fail("edit takes a JSON patch on stdin (got "+string(input.Type)+
				"); use flags for iCal-shaped edits", bmio.ExitUsage))
		}
		body, perr := parseJSONEvent(input.Text, input.From)
		if perr != nil {
			return die(r.s, perr)
		}
		for _, k := range body.Keys() {
			raw, _ := body.Raw(k)
			patch.SetRaw(k, raw)
		}
	}
	if err := r.applyEventFlags(patch); err != nil {
		return die(r.s, err)
	}
	patch.Delete("id")
	patch.Delete("uid") // immutable server-side; sending it only earns a rejection

	if patch.Len() == 0 {
		return die(r.s, bmio.Usage(
			"calendar event edit needs something to change: --title, --start, --rrule, … or a JSON patch"))
	}

	if r.dryRun("edit", "event "+id+": "+strings.Join(patch.Keys(), ", ")) {
		return 0
	}
	raw, err := r.client.One(r.ctx, "CalendarEvent/set", r.setArgs(jmap.Member{
		Key: "update", Value: jmap.Object{{Key: id, Value: patch}},
	}), jmap.CalendarUsing)
	if err != nil {
		return die(r.s, err)
	}
	res := parseSetResponse(raw)
	if _, ok := res.Updated[id]; !ok {
		return die(r.s, failSetErrorOf("edit", res.NotUpdated[id]))
	}
	// `String(patch.title ?? existing.title ?? id)` — the new title if the edit
	// set one, else the stored one, else the id.
	name := id
	if raw, ok := existing.Raw("title"); ok && string(raw) != "null" {
		name = jsobj.JSStringOf(raw)
	}
	if raw, ok := patch.Raw("title"); ok && string(raw) != "null" {
		name = jsobj.JSStringOf(raw)
	}
	return r.reportWrite("edited", id, name, res.state())
}

func (r *calendarRunner) eventRm(id string) int {
	existing, err := r.getEvent(id) // resolve first (§1.7)
	if err != nil {
		return die(r.s, err)
	}
	if existing == nil {
		return die(r.s, bmio.NotFound("no such event: "+id))
	}
	title := existing.JSStringOr("title", id)
	if r.dryRun("rm", `event "`+title+`" (`+id+")") {
		return 0
	}
	raw, err := r.client.One(r.ctx, "CalendarEvent/set", r.setArgs(jmap.Member{
		Key: "destroy", Value: []string{id},
	}), jmap.CalendarUsing)
	if err != nil {
		return die(r.s, err)
	}
	res := parseSetResponse(raw)
	if !containsString(res.Destroyed, id) {
		return die(r.s, failSetErrorOf("rm", res.NotDestroy[id]))
	}
	return r.reportWrite("destroyed", id, title, res.state())
}

// ---- export -----------------------------------------------------------------

func (r *calendarRunner) export() int {
	var filter *inCalendarFilter
	if r.a.Calendar != "" {
		cal, err := r.resolveCalendar(r.a.Calendar)
		if err != nil {
			return die(r.s, err)
		}
		filter = &inCalendarFilter{InCalendar: cal.ID}
	}
	// Enumerate then fetch — CalendarEvent/get with ids:null is not guaranteed,
	// so query for the ids first (optionally scoped to one calendar).
	raw, err := r.client.One(r.ctx, "CalendarEvent/query",
		eventQueryArgs{AccountID: r.accountID, Filter: filter}, jmap.CalendarUsing)
	if err != nil {
		return die(r.s, err)
	}
	var q struct {
		IDs []string `json:"ids"`
	}
	if err := json.Unmarshal(raw, &q); err != nil {
		return die(r.s, err)
	}
	var events []*jsobj.Object
	for i := 0; i < len(q.IDs); i += 256 {
		end := i + 256
		if end > len(q.IDs) {
			end = len(q.IDs)
		}
		got, err := r.client.One(r.ctx, "CalendarEvent/get",
			eventGetArgs{AccountID: r.accountID, IDs: q.IDs[i:end]}, jmap.CalendarUsing)
		if err != nil {
			return die(r.s, err)
		}
		page, err := listOf(got)
		if err != nil {
			return die(r.s, err)
		}
		events = append(events, page...)
	}

	wantICS := r.a.ICS || r.a.As == "ical" || r.a.As == "ics"
	if r.a.IDs {
		ids := make([]string, len(events))
		for i, e := range events {
			ids[i] = e.JSString("id")
		}
		r.s.EmitIDs(ids)
		return 0
	}
	if wantICS && !r.a.JSON {
		// iCal is the requested DATA, so it goes to stdout raw. One VCALENDAR per
		// event keeps each block independently valid and parseable.
		if len(events) == 0 {
			r.s.Note("(no events)")
		}
		for _, e := range events {
			r.s.OutRaw(ical.SerializeEvent(e))
		}
		return 0
	}
	if len(events) == 0 {
		if r.a.JSON {
			return 0
		}
		r.s.Note("(no events)")
		return 0
	}
	return r.emitObjects(events) // §1.3 — one JSCalendar event per line
}

// ---- JMAP plumbing ----------------------------------------------------------

// setArgs is `{accountId, ...(ifState ? {ifInState} : {}), …}` — §1.7. A
// mismatch returns method-level stateMismatch, which Client.One rethrows with the
// type set, so the §1.5 table maps it to exit 5 and nothing is written.
func (r *calendarRunner) setArgs(rest ...jmap.Member) jmap.Object {
	args := jmap.Object{{Key: "accountId", Value: r.accountID}}
	if r.a.HasIfState && r.a.IfState != "" {
		args = append(args, jmap.Member{Key: "ifInState", Value: r.a.IfState})
	}
	return append(args, rest...)
}

func (r *calendarRunner) rawCalendars() ([]*jsobj.Object, error) {
	raw, err := r.client.One(r.ctx, "Calendar/get",
		calendarGetArgs{AccountID: r.accountID}, jmap.CalendarUsing)
	if err != nil {
		return nil, err
	}
	return listOf(raw)
}

func (r *calendarRunner) getCalendars() ([]calendarRef, error) {
	raw, err := r.client.One(r.ctx, "Calendar/get",
		calendarGetArgs{AccountID: r.accountID}, jmap.CalendarUsing)
	if err != nil {
		return nil, err
	}
	var res struct {
		List []calendarRef `json:"list"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, err
	}
	return res.List, nil
}

func (r *calendarRunner) getEvent(id string) (*jsobj.Object, error) {
	raw, err := r.client.One(r.ctx, "CalendarEvent/get",
		eventGetArgs{AccountID: r.accountID, IDs: []string{id}}, jmap.CalendarUsing)
	if err != nil {
		return nil, err
	}
	list, err := listOf(raw)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, nil
	}
	return list[0], nil
}

// resolveCalendar accepts a calendar id or a (case-insensitive) name — a human
// types "Personal", not "cal_9f3c…". An exact id wins; an AMBIGUOUS name is an
// error, not a coin flip (calendar.ts:475, mirroring resolveMailbox and the
// cli/009 rule).
func (r *calendarRunner) resolveCalendar(selector string) (calendarRef, error) {
	cals, err := r.getCalendars()
	if err != nil {
		return calendarRef{}, err
	}
	for _, c := range cals {
		if c.ID == selector {
			return c, nil
		}
	}
	var byName []calendarRef
	for _, c := range cals {
		if strings.EqualFold(c.Name, selector) {
			byName = append(byName, c)
		}
	}
	switch len(byName) {
	case 1:
		return byName[0], nil
	case 0:
		return calendarRef{}, bmio.NotFound("no such calendar: " + selector)
	default:
		ids := make([]string, len(byName))
		for i, c := range byName {
			ids[i] = c.ID
		}
		return calendarRef{}, bmio.Usage(`"` + selector + `" matches ` +
			strconv.Itoa(len(byName)) + " calendars; use an id: " + strings.Join(ids, ", "))
	}
}

// ---- event assembly ---------------------------------------------------------

func parseJSONEvent(text, from string) (*jsobj.Object, error) {
	var value json.RawMessage
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		return nil, bmio.Fail(from+" is not valid JSON: "+jsJSONError(err), bmio.ExitUsage)
	}
	event, err := jsobj.Parse(value)
	if err != nil {
		return nil, bmio.Fail(from+" must be a single JSCalendar event object", bmio.ExitUsage)
	}
	return event, nil
}

// applyEventFlags overlays the flag set onto an event or a patch — calendar.ts:528.
// `--rrule` is validated HERE, which is what makes the common/003 refusal cost
// zero requests.
func (r *calendarRunner) applyEventFlags(event *jsobj.Object) error {
	if r.a.HasTitle {
		_ = event.Set("title", r.a.Title)
	}
	if r.a.HasStart {
		_ = event.Set("start", r.a.Start)
	}
	if r.a.HasDuration {
		_ = event.Set("duration", r.a.Duration)
	}
	if r.a.HasTZ {
		_ = event.Set("timeZone", r.a.TZ)
	}
	if r.a.AllDay {
		_ = event.Set("showWithoutTime", true)
	}
	if r.a.HasRRule {
		rule, err := ical.ValidateRrule(r.a.RRule)
		if err != nil {
			return err
		}
		_ = event.Set("recurrenceRules", []any{rule.JSON()})
	}
	return nil
}

// ---- shared output ----------------------------------------------------------

func (r *calendarRunner) dryRun(verb, what string) bool {
	if !r.a.DryRun {
		return false
	}
	r.s.Note("dry run: would " + verb + " " + what + "; nothing was written")
	if r.a.JSON {
		out := jsobj.New()
		_ = out.Set("dryRun", true)
		_ = out.Set("action", verb)
		_ = out.Set("target", what)
		_ = r.s.EmitJSON(out)
	}
	return true
}

// reportWrite is calendar.ts:500. Its --json shape is `{...what, state}`, i.e.
// action/id/name/state — the same four fields contacts reports, in the same order.
func (r *calendarRunner) reportWrite(action, id, name, state string) int {
	if r.a.IDs {
		r.s.EmitIDs([]string{id})
		return 0
	}
	if r.a.JSON {
		out := jsobj.New()
		_ = out.Set("action", action)
		_ = out.Set("id", id)
		_ = out.Set("name", name)
		if state == "" {
			out.SetRaw("state", json.RawMessage("null"))
		} else {
			_ = out.Set("state", state)
		}
		if err := r.s.EmitJSON(out); err != nil {
			return die(r.s, err)
		}
		return 0
	}
	r.s.Out(action + " " + name + " (" + id + ")")
	if state != "" {
		r.s.Note("state " + state + "  (pass to --if-state on the next write)")
	}
	return 0
}

func (r *calendarRunner) emitObjects(list []*jsobj.Object) int {
	for _, o := range list {
		raw, err := o.MarshalJSON()
		if err != nil {
			return die(r.s, err)
		}
		r.s.Out(string(raw))
	}
	return 0
}

// listOf decodes a `list` array into ordered objects, keeping each element's key
// order — `--json` re-emits the server's own bytes.
func listOf(raw json.RawMessage) ([]*jsobj.Object, error) {
	var res struct {
		List []json.RawMessage `json:"list"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, err
	}
	out := make([]*jsobj.Object, 0, len(res.List))
	for _, item := range res.List {
		o, err := jsobj.Parse(item)
		if err != nil {
			continue
		}
		out = append(out, o)
	}
	return out, nil
}

// isoMillis is `new Date(...).toISOString()` — the exact-3-fractional-digit form
// the TypeScript sends as `after`/`before`.
func isoMillis(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// parseISO reads an RFC 3339 instant the server sent.
func parseISO(v string) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// num renders a JS number the way String() does — `days` is `Number(...)`, so a
// whole value prints without a decimal point.
func num(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }
