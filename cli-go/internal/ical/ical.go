// Package ical is the iCalendar/RRULE codec `bullmoose calendar` carries — a
// port of the vendored codec at the foot of packages/cli/src/calendar.ts.
//
// WHY IT IS VENDORED, in Go as it already is in TypeScript: the compiled Node CLI
// runs as plain `dist/*.js` with no bundler, so it cannot import
// `@bullmoose/calendar-core` at runtime and keeps its own compact mirror. sVOL 018
// recorded that and flagged the arch claim ("the CLI imports calendar-core") as
// wrong. This package is that same mirror one language over — arch.md §2's point
// exactly: Go does not fork shared code, it changes the language of a fork that
// already happened.
//
// ⚠️ RECURRENCE IS EXPANDED SERVER-SIDE AND IS NOT REIMPLEMENTED HERE. There is
// no expander in this package and there must not be one: `CalendarEvent/
// getOccurrences` is the only thing that turns a rule into dates. What IS here is
// the client half of the common/003 GUARD — the named-part check that answers
// "can the server's expander expand this at all", so `--rrule
// FREQ=YEARLY;BYMONTH=11;BYDAY=4TH` is refused up front (exit 2, naming BYDAY)
// instead of silently writing a series that expands to the wrong dates. Keep
// supportedParts in lockstep with packages/calendar-core's SUPPORTED_PARTS; the
// server re-checks, so a drift costs a round trip, never a wrong write.
package ical

import (
	"crypto/rand"
	"encoding/hex"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jsobj"
)

// Event is a JSCalendar event — an open object, as the server stores it.
type Event = jsobj.Object

// ---- local date-times -------------------------------------------------------

// LDT is a JSCalendar LocalDateTime, decomposed — calendar.ts:547.
type LDT struct {
	Year, Month, Day, Hour, Minute, Second int
}

var reLdt = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})`)

// ParseLDT is calendar.ts:556 — a prefix match, so trailing junk is tolerated
// exactly as the TypeScript tolerates it.
func ParseLDT(s string) (LDT, bool) {
	m := reLdt.FindStringSubmatch(s)
	if m == nil {
		return LDT{}, false
	}
	return LDT{
		Year: atoi(m[1]), Month: atoi(m[2]), Day: atoi(m[3]),
		Hour: atoi(m[4]), Minute: atoi(m[5]), Second: atoi(m[6]),
	}, true
}

func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

func p2(n int) string { return pad(n, 2) }

func pad(n, width int) string {
	s := strconv.Itoa(n)
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	for len(s) < width {
		s = "0" + s
	}
	if neg {
		return "-" + s
	}
	return s
}

func fmtLDT(d LDT) string {
	return pad(d.Year, 4) + "-" + p2(d.Month) + "-" + p2(d.Day) + "T" +
		p2(d.Hour) + ":" + p2(d.Minute) + ":" + p2(d.Second)
}

func stampLocal(d LDT) string {
	return pad(d.Year, 4) + p2(d.Month) + p2(d.Day) + "T" + p2(d.Hour) + p2(d.Minute) + p2(d.Second)
}

func stampDate(d LDT) string { return pad(d.Year, 4) + p2(d.Month) + p2(d.Day) }

// stampUTC is `new Date(ms).toISOString()` with the separators stripped and the
// milliseconds dropped — calendar.ts:575.
func stampUTC(t time.Time) string { return t.UTC().Format("20060102T150405Z") }

var reDuration = regexp.MustCompile(
	`^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$`)

// ParseDurationMs is ISO-8601 duration → milliseconds, with dates approximated at
// D=24h exactly as calendar-core does — calendar.ts:578. A non-string or an
// unparseable value is 0, not an error: the TypeScript returns 0 and the caller's
// `|| (allDay ? 86_400_000 : 0)` depends on it.
func ParseDurationMs(raw string, isString bool) int64 {
	if !isString {
		return 0
	}
	m := reDuration.FindStringSubmatch(raw)
	if m == nil {
		return 0
	}
	num := func(s string) float64 {
		if s == "" {
			return 0
		}
		f, _ := strconv.ParseFloat(s, 64)
		return f
	}
	ms := (num(m[2])*7+num(m[3]))*86_400_000 +
		num(m[4])*3_600_000 + num(m[5])*60_000 + num(m[6])*1000
	if m[1] == "-" {
		return -int64(ms)
	}
	return int64(ms)
}

// msToDuration is calendar.ts:591 — the inverse, to whole minutes.
func msToDuration(ms int64) string {
	d := ms / 86_400_000
	h := (ms % 86_400_000) / 3_600_000
	m := (ms % 3_600_000) / 60_000
	out := "P"
	if d != 0 {
		out += strconv.FormatInt(d, 10) + "D"
	}
	if h != 0 || m != 0 {
		out += "T"
	}
	if h != 0 {
		out += strconv.FormatInt(h, 10) + "H"
	}
	if m != 0 {
		out += strconv.FormatInt(m, 10) + "M"
	}
	if out == "P" {
		return "PT0S"
	}
	return out
}

func escIcs(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	s = strings.ReplaceAll(s, ",", `\,`)
	return strings.ReplaceAll(s, ";", `\;`)
}

func unescIcs(s string) string {
	s = strings.ReplaceAll(s, `\n`, "\n")
	s = strings.ReplaceAll(s, `\N`, "\n")
	s = strings.ReplaceAll(s, `\,`, ",")
	s = strings.ReplaceAll(s, `\;`, ";")
	return strings.ReplaceAll(s, `\\`, `\`)
}

// fold is RFC 5545 §3.1 folding as calendar.ts:614 implements it: by JavaScript
// STRING LENGTH (UTF-16 code units), 75 on the first line and 74 after. That is a
// different function from the vCard folder next door, which counts octets — the
// two are ported separately because they are separate in the TypeScript, and
// "fixing" either would change bytes the other implementation emits.
func fold(l string) string {
	units := utf16.Encode([]rune(l))
	if len(units) <= 75 {
		return l
	}
	var parts []string
	i := 0
	for i < len(units) {
		take := 74
		prefix := " "
		if i == 0 {
			take, prefix = 75, ""
		}
		end := i + take
		if end > len(units) {
			end = len(units)
		}
		parts = append(parts, prefix+string(utf16.Decode(units[i:end])))
		i = end
	}
	return strings.Join(parts, "\r\n")
}

// ---- RRULE strings ----------------------------------------------------------

var dayUp = map[string]string{
	"mo": "MO", "tu": "TU", "we": "WE", "th": "TH", "fr": "FR", "sa": "SA", "su": "SU",
}
var dayDown = map[string]string{
	"MO": "mo", "TU": "tu", "WE": "we", "TH": "th", "FR": "fr", "SA": "sa", "SU": "su",
}

// ByDay is one BYDAY entry.
type ByDay struct {
	Day         string
	NthOfPeriod int
	HasNth      bool
}

// Rule is a JSCalendar RecurrenceRule as this codec reads it. `obj` records the
// key order the RRULE tokens arrived in, because `--rrule` writes the parsed rule
// straight into `recurrenceRules` and JSON.stringify emits insertion order —
// so the bytes on the wire are the order the user typed.
type Rule struct {
	Frequency      string
	Interval       float64
	HasInterval    bool
	Count          float64
	HasCount       bool
	Until          string
	HasUntil       bool
	ByDay          []ByDay
	HasByDay       bool
	ByMonthDay     []float64
	HasByMonthDay  bool
	ByMonth        []string
	HasByMonth     bool
	BySetPosition  []float64
	HasBySetPos    bool
	FirstDayOfWeek string
	HasFirstDay    bool
	// UnknownPart is any RRULE token this codec does not recognise, recorded
	// rather than silently dropped so the guard can name it.
	UnknownPart string

	obj *jsobj.Object
}

// JSON is the rule as `--rrule` writes it: insertion order, matching
// JSON.stringify over the object parseRruleString built.
func (r *Rule) JSON() *jsobj.Object { return r.obj }

// JSONFixed is calendar.ts:949 ruleObjToJson — the FIXED key order the iCal
// import path emits, which is deliberately not the insertion order.
func (r *Rule) JSONFixed() *jsobj.Object {
	out := jsobj.New()
	if r.Frequency != "" {
		_ = out.Set("frequency", r.Frequency)
	}
	if r.HasInterval {
		_ = out.Set("interval", r.Interval)
	}
	if r.HasCount {
		_ = out.Set("count", r.Count)
	}
	if r.HasUntil && r.Until != "" {
		_ = out.Set("until", r.Until)
	}
	if r.HasByDay {
		_ = out.Set("byDay", byDayJSON(r.ByDay))
	}
	if r.HasByMonthDay {
		_ = out.Set("byMonthDay", r.ByMonthDay)
	}
	if r.HasByMonth {
		_ = out.Set("byMonth", r.ByMonth)
	}
	if r.HasBySetPos {
		_ = out.Set("bySetPosition", r.BySetPosition)
	}
	if r.HasFirstDay {
		_ = out.Set("firstDayOfWeek", r.FirstDayOfWeek)
	}
	return out
}

func byDayJSON(days []ByDay) []any {
	out := make([]any, 0, len(days))
	for _, d := range days {
		e := jsobj.New()
		_ = e.Set("day", d.Day)
		if d.HasNth {
			_ = e.Set("nthOfPeriod", d.NthOfPeriod)
		}
		out = append(out, e)
	}
	return out
}

var reByDayToken = regexp.MustCompile(`(?i)^(-?\d+)?(MO|TU|WE|TH|FR|SA|SU)$`)

// ParseRruleString is calendar.ts:671 — RRULE body → rule object, recording
// unrecognised tokens rather than dropping them.
func ParseRruleString(body string) *Rule {
	r := &Rule{obj: jsobj.New()}
	for _, part := range strings.Split(body, ";") {
		eq := strings.Index(part, "=")
		if eq < 0 {
			continue
		}
		k := strings.ToUpper(part[:eq])
		v := part[eq+1:]
		switch k {
		case "FREQ":
			r.Frequency = jsobj.Lower(v)
			_ = r.obj.Set("frequency", r.Frequency)
		case "INTERVAL":
			r.Interval, r.HasInterval = jsNumber(v), true
			_ = r.obj.Set("interval", r.Interval)
		case "COUNT":
			r.Count, r.HasCount = jsNumber(v), true
			_ = r.obj.Set("count", r.Count)
		case "UNTIL":
			r.Until, r.HasUntil = untilToLDT(v), true
			_ = r.obj.Set("until", r.Until)
		case "BYDAY":
			r.ByDay = nil
			for _, tok := range strings.Split(v, ",") {
				t := strings.TrimSpace(tok)
				m := reByDayToken.FindStringSubmatch(t)
				if m == nil {
					r.ByDay = append(r.ByDay, ByDay{Day: jsobj.Lower(t)}) // invalid → caught by the guard
					continue
				}
				entry := ByDay{Day: dayDown[strings.ToUpper(m[2])]}
				if m[1] != "" {
					entry.NthOfPeriod, entry.HasNth = atoi(m[1]), true
				}
				r.ByDay = append(r.ByDay, entry)
			}
			r.HasByDay = true
			_ = r.obj.Set("byDay", byDayJSON(r.ByDay))
		case "BYMONTHDAY":
			r.ByMonthDay = numbers(v)
			r.HasByMonthDay = true
			_ = r.obj.Set("byMonthDay", r.ByMonthDay)
		case "BYMONTH":
			r.ByMonth = strings.Split(v, ",")
			r.HasByMonth = true
			_ = r.obj.Set("byMonth", r.ByMonth)
		case "BYSETPOS":
			r.BySetPosition = numbers(v)
			r.HasBySetPos = true
			_ = r.obj.Set("bySetPosition", r.BySetPosition)
		case "WKST":
			if down, ok := dayDown[strings.ToUpper(v)]; ok {
				r.FirstDayOfWeek = down
			} else {
				r.FirstDayOfWeek = jsobj.Lower(v)
			}
			r.HasFirstDay = true
			_ = r.obj.Set("firstDayOfWeek", r.FirstDayOfWeek)
		default:
			r.UnknownPart = k
			_ = r.obj.Set("unknownPart", k)
		}
	}
	return r
}

func numbers(v string) []float64 {
	parts := strings.Split(v, ",")
	out := make([]float64, len(parts))
	for i, p := range parts {
		out[i] = jsNumber(p)
	}
	return out
}

// jsNumber is JavaScript's `Number(s)` for the numeric RRULE parts. A junk value
// yields 0 here where JS yields NaN; both are refused downstream, and JSON.
// stringify(NaN) is `null`, which no server accepts either.
func jsNumber(s string) float64 {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0
	}
	return f
}

var reUntil = regexp.MustCompile(`^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$`)

// untilToLDT turns an UNTIL token into a LocalDateTime string — calendar.ts:718.
// An unparseable value passes through so the guard rejects it.
func untilToLDT(v string) string {
	m := reUntil.FindStringSubmatch(v)
	if m == nil {
		return v
	}
	h, mi, s := m[4], m[5], m[6]
	if h == "" {
		h, mi, s = "23", "59", "59"
	}
	return m[1] + "-" + m[2] + "-" + m[3] + "T" + h + ":" + mi + ":" + s
}

// supportedParts is the client-side half of the common/003 guard: the
// (FREQ, part) pairs the SERVER's expander actually reads. KEEP IN LOCKSTEP with
// SUPPORTED_PARTS in packages/calendar-core/src/index.ts (and with its mirror in
// packages/cli/src/calendar.ts:653). A drift here is self-correcting — the server
// re-checks via eventSpan and surfaces the same refusal through failSetError — so
// the worst case is a round trip instead of a fast local refusal, never a silent
// wrong write.
var supportedParts = map[string]map[string]bool{
	"daily":   {"interval": true, "count": true, "until": true},
	"weekly":  {"interval": true, "count": true, "until": true, "byDay": true},
	"monthly": {"interval": true, "count": true, "until": true, "byDay": true, "byMonthDay": true, "bySetPosition": true},
	"yearly":  {"interval": true, "count": true, "until": true, "byMonth": true},
}

var partLabel = map[string]string{
	"interval": "INTERVAL", "count": "COUNT", "until": "UNTIL", "byDay": "BYDAY",
	"byMonthDay": "BYMONTHDAY", "byMonth": "BYMONTH", "bySetPosition": "BYSETPOS",
}

// partOrder is the check order, fixed so the message a user sees does not depend
// on map iteration.
var partOrder = []string{"interval", "count", "until", "byDay", "byMonthDay", "byMonth", "bySetPosition"}

// RruleReason is calendar.ts:729 — why `rule` cannot be faithfully expanded, or
// "" when it can. The named-part half of the server's unsupportedRuleReason,
// which is enough for a clean, specific refusal without a round trip.
func RruleReason(r *Rule) string {
	freq := jsobj.Lower(r.Frequency)
	ok, known := supportedParts[freq]
	if !known {
		named := strings.ToUpper(r.Frequency)
		if named == "" {
			named = "(missing)"
		}
		return "FREQ=" + named + " has no expander branch (DAILY/WEEKLY/MONTHLY/YEARLY)"
	}
	if r.UnknownPart != "" {
		return "unknown RRULE part " + r.UnknownPart
	}
	for _, part := range partOrder {
		if !r.present(part) {
			continue
		}
		if !ok[part] {
			return partLabel[part] + " is discarded by the FREQ=" + strings.ToUpper(freq) + " expander branch"
		}
	}
	// nthOfPeriod ("4TH") is only read by the MONTHLY branch — a plain part-set
	// check misses it, which is exactly the Thanksgiving-shaped bug common/003
	// names.
	if r.HasByDay {
		for _, b := range r.ByDay {
			if _, isWeekday := dayUp[b.Day]; !isWeekday {
				return `BYDAY entry "` + b.Day + `" is not a weekday code (MO..SU)`
			}
			if b.HasNth && freq != "monthly" {
				return "BYDAY with an ordinal (e.g. 4TH) is only read by the FREQ=MONTHLY expander branch"
			}
		}
	}
	return ""
}

// present is calendar.ts:755 — set, non-null, and not an empty array.
func (r *Rule) present(part string) bool {
	switch part {
	case "interval":
		return r.HasInterval
	case "count":
		return r.HasCount
	case "until":
		return r.HasUntil
	case "byDay":
		return r.HasByDay && len(r.ByDay) > 0
	case "byMonthDay":
		return r.HasByMonthDay && len(r.ByMonthDay) > 0
	case "byMonth":
		return r.HasByMonth && len(r.ByMonth) > 0
	case "bySetPosition":
		return r.HasBySetPos && len(r.BySetPosition) > 0
	}
	return false
}

// ValidateRrule parses and guards an `--rrule` value — calendar.ts:763. The
// common/003 subtlety: the parser accepts more than the expander can expand, so
// this check is the only thing between a clean refusal and a write that succeeds
// and silently does the wrong thing.
func ValidateRrule(body string) (*Rule, error) {
	r := ParseRruleString(body)
	if reason := RruleReason(r); reason != "" {
		return nil, bmio.Fail(`--rrule "`+body+`": `+reason, bmio.ExitUsage)
	}
	return r, nil
}

// ruleToRrule renders a stored JSCalendar rule back to an RRULE body —
// calendar.ts:770.
func ruleToRrule(r *Rule) string {
	freq := "daily"
	if r.Frequency != "" {
		freq = r.Frequency
	}
	parts := []string{"FREQ=" + strings.ToUpper(freq)}
	if r.HasInterval && r.Interval > 1 {
		parts = append(parts, "INTERVAL="+num(r.Interval))
	}
	if r.HasCount {
		parts = append(parts, "COUNT="+num(r.Count))
	}
	if r.HasUntil && r.Until != "" {
		if d, ok := ParseLDT(r.Until); ok {
			parts = append(parts, "UNTIL="+stampLocal(d))
		}
	}
	if len(r.ByDay) > 0 {
		tokens := make([]string, len(r.ByDay))
		for i, b := range r.ByDay {
			nth := ""
			if b.HasNth {
				nth = strconv.Itoa(b.NthOfPeriod)
			}
			code, ok := dayUp[b.Day]
			if !ok {
				code = "MO"
			}
			tokens[i] = nth + code
		}
		parts = append(parts, "BYDAY="+strings.Join(tokens, ","))
	}
	if len(r.ByMonthDay) > 0 {
		parts = append(parts, "BYMONTHDAY="+joinNums(r.ByMonthDay))
	}
	if len(r.ByMonth) > 0 {
		parts = append(parts, "BYMONTH="+strings.Join(r.ByMonth, ","))
	}
	if len(r.BySetPosition) > 0 {
		parts = append(parts, "BYSETPOS="+joinNums(r.BySetPosition))
	}
	if r.HasFirstDay && r.FirstDayOfWeek != "" {
		code, ok := dayUp[r.FirstDayOfWeek]
		if !ok {
			code = "MO"
		}
		parts = append(parts, "WKST="+code)
	}
	return strings.Join(parts, ";")
}

func num(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

func joinNums(list []float64) string {
	parts := make([]string, len(list))
	for i, f := range list {
		parts[i] = num(f)
	}
	return strings.Join(parts, ",")
}

// ---- iCal serialize (JSCalendar → VCALENDAR) --------------------------------

// SerializeEvent renders ONE VCALENDAR per event — calendar.ts:795. TZID is
// passed through without a generated VTIMEZONE: Apple/Google resolve named IANA
// zones from their own database, and the full VTIMEZONE machinery lives in the
// server's CalDAV face, not here.
func SerializeEvent(event *Event) string {
	tz, isStr := event.Str("timeZone")
	if !isStr {
		tz = "Etc/UTC"
	}
	isUTC := tz == "Etc/UTC" || tz == "UTC"
	allDay := event.Bool("showWithoutTime")
	var start LDT
	haveStart := false
	if s, isStr := event.Str("start"); isStr {
		start, haveStart = ParseLDT(s)
	}
	uid := event.JSStringOr("uid", "urn:uuid:"+randomUUID())
	durationRaw, durationIsStr := event.Str("duration")
	durationMs := ParseDurationMs(durationRaw, durationIsStr)
	if durationMs == 0 && allDay {
		durationMs = 86_400_000
	}

	ev := []string{"BEGIN:VEVENT", fold("UID:" + escIcs(uid)), "DTSTAMP:" + stampUTC(time.Now())}
	if title, isStr := event.Str("title"); isStr {
		ev = append(ev, fold("SUMMARY:"+escIcs(title)))
	}
	if desc, isStr := event.Str("description"); isStr {
		ev = append(ev, fold("DESCRIPTION:"+escIcs(desc)))
	}
	if loc, ok := firstLocation(event); ok {
		ev = append(ev, fold("LOCATION:"+escIcs(loc)))
	}

	if haveStart {
		switch {
		case allDay:
			ev = append(ev, "DTSTART;VALUE=DATE:"+stampDate(start))
			days := roundDays(durationMs) // Math.max(1, Math.round(ms / 86_400_000))
			if days < 1 {
				days = 1
			}
			end := time.Date(start.Year, time.Month(start.Month), start.Day+int(days), 0, 0, 0, 0, time.UTC)
			ev = append(ev, "DTEND;VALUE=DATE:"+pad(end.Year(), 4)+p2(int(end.Month()))+p2(end.Day()))
		case isUTC:
			t := time.Date(start.Year, time.Month(start.Month), start.Day,
				start.Hour, start.Minute, start.Second, 0, time.UTC)
			ev = append(ev, "DTSTART:"+stampUTC(t))
			ev = append(ev, "DTEND:"+stampUTC(t.Add(time.Duration(durationMs)*time.Millisecond)))
		default:
			ev = append(ev, "DTSTART;TZID="+tz+":"+stampLocal(start))
			if durationIsStr {
				ev = append(ev, "DURATION:"+durationRaw)
			} else if durationMs != 0 {
				ev = append(ev, "DURATION:"+msToDuration(durationMs))
			}
		}
	}
	for _, rule := range asRules(event) {
		ev = append(ev, fold("RRULE:"+ruleToRrule(rule)))
	}
	ev = append(ev, "END:VEVENT")

	return strings.Join([]string{
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//bullmoose//cli//EN",
		"CALSCALE:GREGORIAN",
		strings.Join(ev, "\r\n"),
		"END:VCALENDAR",
		"",
	}, "\r\n") + "\r\n"
}

// roundDays is `Math.round(durationMs / 86_400_000)`. JavaScript rounds half UP
// (towards +Infinity), which Go's math.Round does not for negatives — durations
// here are non-negative, and the difference is called out rather than assumed.
func roundDays(ms int64) int64 {
	if ms < 0 {
		return -((-ms + 43_200_000 - 1) / 86_400_000)
	}
	return (ms + 43_200_000) / 86_400_000
}

// asRules is calendar.ts:841 — the stored recurrenceRules, typed loosely because
// the server owns the schema.
func asRules(event *Event) []*Rule {
	raw := event.Arr("recurrenceRules")
	if raw == nil {
		return nil
	}
	out := make([]*Rule, 0, len(raw))
	for _, elem := range raw {
		o, err := jsobj.Parse(elem)
		if err != nil {
			out = append(out, &Rule{obj: jsobj.New()})
			continue
		}
		r := &Rule{obj: o}
		r.Frequency, _ = o.Str("frequency")
		r.Interval, r.HasInterval = o.Num("interval")
		r.Count, r.HasCount = o.Num("count")
		r.Until, r.HasUntil = o.Str("until")
		if days := o.Arr("byDay"); days != nil {
			r.HasByDay = true
			for _, d := range days {
				entry, err := jsobj.Parse(d)
				if err != nil {
					r.ByDay = append(r.ByDay, ByDay{})
					continue
				}
				b := ByDay{Day: entry.StrOr("day", "")}
				if n, isNum := entry.Num("nthOfPeriod"); isNum {
					b.NthOfPeriod, b.HasNth = int(n), true
				}
				r.ByDay = append(r.ByDay, b)
			}
		}
		if list := o.Arr("byMonthDay"); list != nil {
			r.HasByMonthDay = true
			for _, v := range list {
				r.ByMonthDay = append(r.ByMonthDay, jsobj.JSNumberOf(v))
			}
		}
		if list := o.Arr("byMonth"); list != nil {
			r.HasByMonth = true
			for _, v := range list {
				r.ByMonth = append(r.ByMonth, jsobj.JSStringOf(v))
			}
		}
		if list := o.Arr("bySetPosition"); list != nil {
			r.HasBySetPos = true
			for _, v := range list {
				r.BySetPosition = append(r.BySetPosition, jsobj.JSNumberOf(v))
			}
		}
		r.FirstDayOfWeek, r.HasFirstDay = o.Str("firstDayOfWeek")
		out = append(out, r)
	}
	return out
}

// firstLocation is calendar.ts:859 — the first named location, in stored order.
func firstLocation(event *Event) (string, bool) {
	locs := event.Obj("locations")
	if locs == nil {
		return "", false
	}
	for _, l := range locs.Values() {
		if name, isStr := l.Str("name"); isStr && name != "" {
			return name, true
		}
	}
	return "", false
}

// randomUUID is crypto.randomUUID() — RFC 4122 v4, used only when an event has no
// uid of its own.
func randomUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// Unreachable in practice; a fixed nil UUID beats panicking in a codec.
		return "00000000-0000-4000-8000-000000000000"
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// ---- iCal parse (VCALENDAR → JSCalendar) ------------------------------------

// icsProp is one unfolded content line.
type icsProp struct {
	name   string
	params map[string]string
	value  string
}

// ParseEvent parses ONE VEVENT — the master; sibling RECURRENCE-ID VEVENTs are
// ignored (calendar.ts:880). It returns (nil, warnings, nil) when there is no
// usable VEVENT, and an error only for an RRULE the expander cannot expand:
// unlike the server's import codec, which warns and drops, the CLI create path
// REFUSES — silently creating a non-recurring event from a recurring source is
// the failure mode to avoid.
func ParseEvent(text string) (*Event, []string, error) {
	props := unfoldICS(text)
	warnings := []string{}

	inEvent := false
	var block []icsProp
	sawRid := false
	for _, p := range props {
		if p.name == "BEGIN" && strings.ToUpper(p.value) == "VEVENT" {
			inEvent = true
			continue
		}
		if p.name == "END" && strings.ToUpper(p.value) == "VEVENT" {
			if len(block) > 0 && !sawRid {
				break // keep the first master block
			}
			block = nil
			sawRid = false
			inEvent = false
			continue
		}
		if inEvent {
			if p.name == "RECURRENCE-ID" {
				sawRid = true
			}
			block = append(block, p)
		}
	}
	if len(block) == 0 {
		return nil, []string{"no VEVENT found"}, nil
	}

	get := func(name string) (icsProp, bool) {
		for _, p := range block {
			if p.name == name {
				return p, true
			}
		}
		return icsProp{}, false
	}
	dt, hasDT := get("DTSTART")
	var startInfo icsDT
	if hasDT {
		var ok bool
		startInfo, ok = parseIcsDT(dt)
		if !ok {
			hasDT = false
		}
	}
	if !hasDT {
		return nil, []string{"missing/unparseable DTSTART"}, nil
	}

	event := jsobj.New()
	_ = event.Set("@type", "Event")
	uid := "urn:uuid:" + randomUUID()
	if u, ok := get("UID"); ok {
		uid = unescIcs(strings.TrimSpace(u.value))
	}
	_ = event.Set("uid", uid)
	_ = event.Set("start", fmtLDT(startInfo.local))
	tz := "Etc/UTC"
	if !startInfo.allDay && startInfo.timeZone != "" {
		tz = startInfo.timeZone
	}
	_ = event.Set("timeZone", tz)
	if startInfo.allDay {
		_ = event.Set("showWithoutTime", true)
	}
	if p, ok := get("SUMMARY"); ok {
		_ = event.Set("title", unescIcs(p.value))
	}
	if p, ok := get("DESCRIPTION"); ok {
		_ = event.Set("description", unescIcs(p.value))
	}
	if p, ok := get("LOCATION"); ok {
		loc := jsobj.New()
		inner := jsobj.New()
		_ = inner.Set("name", unescIcs(p.value))
		_ = loc.Set("loc1", inner)
		_ = event.Set("locations", loc)
	}

	if durProp, ok := get("DURATION"); ok {
		_ = event.Set("duration", strings.TrimSpace(durProp.value))
	} else if dtend, ok := get("DTEND"); ok {
		if endInfo, parsed := parseIcsDT(dtend); parsed {
			ms := icsMs(endInfo) - icsMs(startInfo)
			if ms > 0 && !(startInfo.allDay && ms == 86_400_000) {
				_ = event.Set("duration", msToDuration(ms))
			}
		}
	}

	var rules []any
	for _, p := range block {
		if p.name != "RRULE" {
			continue
		}
		body := strings.TrimSpace(p.value)
		rule := ParseRruleString(body)
		if reason := RruleReason(rule); reason != "" {
			return nil, warnings, bmio.Fail(`iCal RRULE "`+body+`": `+reason, bmio.ExitUsage)
		}
		rules = append(rules, rule.JSONFixed())
	}
	if len(rules) > 0 {
		_ = event.Set("recurrenceRules", rules)
	}
	return event, warnings, nil
}

type icsDT struct {
	local    LDT
	timeZone string
	allDay   bool
}

var (
	reIcsDate     = regexp.MustCompile(`^(\d{4})(\d{2})(\d{2})$`)
	reIcsDateTime = regexp.MustCompile(`^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$`)
	reEightDigits = regexp.MustCompile(`^\d{8}$`)
)

func parseIcsDT(p icsProp) (icsDT, bool) {
	v := strings.TrimSpace(p.value)
	if p.params["VALUE"] == "DATE" || reEightDigits.MatchString(v) {
		m := reIcsDate.FindStringSubmatch(v)
		if m == nil {
			return icsDT{}, false
		}
		return icsDT{
			local:  LDT{Year: atoi(m[1]), Month: atoi(m[2]), Day: atoi(m[3])},
			allDay: true,
		}, true
	}
	m := reIcsDateTime.FindStringSubmatch(v)
	if m == nil {
		return icsDT{}, false
	}
	local := LDT{
		Year: atoi(m[1]), Month: atoi(m[2]), Day: atoi(m[3]),
		Hour: atoi(m[4]), Minute: atoi(m[5]), Second: atoi(m[6]),
	}
	if m[7] == "Z" {
		return icsDT{local: local, timeZone: "Etc/UTC"}, true
	}
	return icsDT{local: local, timeZone: p.params["TZID"]}, true
}

// icsMs is UTC-ish milliseconds for duration math — TZID zones are treated as a
// UTC wall clock, which is exact for the UTC/floating events this codec targets
// (calendar.ts:987).
func icsMs(dt icsDT) int64 {
	l := dt.local
	t := time.Date(l.Year, time.Month(l.Month), l.Day, l.Hour, l.Minute, l.Second, 0, time.UTC)
	return t.UnixMilli()
}

// unfoldICS is calendar.ts:994 — physical → logical lines, then head/params/value.
func unfoldICS(text string) []icsProp {
	var lines []string
	for _, line := range splitAnyNewline(text) {
		if (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")) && len(lines) > 0 {
			lines[len(lines)-1] += line[1:]
			continue
		}
		if len(line) > 0 {
			lines = append(lines, line)
		}
	}
	var props []icsProp
	for _, line := range lines {
		colon := -1
		inQ := false
		for i := 0; i < len(line); i++ {
			switch line[i] {
			case '"':
				inQ = !inQ
			case ':':
				if !inQ {
					colon = i
				}
			}
			if colon >= 0 {
				break
			}
		}
		if colon <= 0 {
			continue
		}
		head := strings.Split(line[:colon], ";")
		params := map[string]string{}
		for _, seg := range head[1:] {
			eq := strings.Index(seg, "=")
			if eq > 0 {
				params[strings.ToUpper(seg[:eq])] = stripOneQuotePair(seg[eq+1:])
			}
		}
		props = append(props, icsProp{
			name:   strings.ToUpper(head[0]),
			params: params,
			value:  line[colon+1:],
		})
	}
	return props
}

// stripOneQuotePair is `.replace(/^"|"$/g, "")` — at most ONE leading and ONE
// trailing quote, which is not what strings.Trim does.
func stripOneQuotePair(s string) string {
	s = strings.TrimPrefix(s, `"`)
	return strings.TrimSuffix(s, `"`)
}

// splitAnyNewline is JavaScript's `text.split(/\r\n|\r|\n/)`.
func splitAnyNewline(text string) []string {
	var out []string
	start := 0
	for i := 0; i < len(text); i++ {
		switch text[i] {
		case '\r':
			out = append(out, text[start:i])
			if i+1 < len(text) && text[i+1] == '\n' {
				i++
			}
			start = i + 1
		case '\n':
			out = append(out, text[start:i])
			start = i + 1
		}
	}
	return append(out, text[start:])
}
