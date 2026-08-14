package vcard

// JSContact → vCard 3.0 — the serialize direction `contacts export` needs and
// that ParseVCF lacks, so `export` is a real inverse of `import`. A port of
// packages/cli/src/contacts.ts:872 serializeVcard.
//
// 3.0 because that is what Apple Contacts requests and emits. Unmapped source
// properties preserved on import as `vCardProps` are re-emitted verbatim, so a
// round trip drops nothing — which is what makes `export | import` a real
// correctness test rather than a smoke test.

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jsobj"
)

// line is one content line before folding — contacts.ts:854.
type line struct {
	group  string
	name   string
	params []string // preformatted "TYPE=HOME" segments
	value  string   // already escaped as the property requires
}

// featureTypes: only `mobile` → `CELL` differs from the JSContact feature name
// upper-cased, so everything else derives from ToUpper — contacts.ts:956.
var featureTypes = map[string]string{"mobile": "CELL"}

var reDataImage = regexp.MustCompile(`(?is)^data:image/([a-z0-9.+-]+);base64,(.+)$`)
var reHTTP = regexp.MustCompile(`(?i)^https?:`)

// Serialize renders one JSContact Card as a vCard 3.0 block, CRLF-terminated.
func Serialize(card *Card) string {
	var lines []line
	item := 0
	push := func(l line) { lines = append(lines, l) }
	withLabel := func(label string, hasLabel bool, l line) {
		if !hasLabel || label == "" {
			push(l)
			return
		}
		item++
		group := "item" + strconv.Itoa(item)
		l.group = group
		push(l)
		push(line{group: group, name: "X-ABLABEL", value: escapeText(label)})
	}

	name := card.Obj("name")

	// FN is mandatory in 3.0. The `??` chain is nullish, so a components list
	// that renders to the EMPTY string still wins over the organization
	// fallback — contacts.ts:891, kept literally.
	fn, ok := "", false
	if name != nil {
		if v, isStr := name.Str("full"); isStr {
			fn, ok = v, true
		}
	}
	if !ok && name != nil && name.Has("components") {
		var parts []string
		for _, c := range name.Arr("components") {
			comp, err := jsobj.Parse(c)
			if err != nil {
				continue
			}
			kind := comp.StrOr("kind", "")
			value, isStr := comp.Str("value")
			// `c.kind !== "separator" && c.value` — a falsy (empty) value drops.
			if kind == "separator" || !isStr || value == "" {
				continue
			}
			parts = append(parts, value)
		}
		fn, ok = strings.TrimSpace(strings.Join(parts, " ")), true
	}
	if !ok {
		if v, found := firstValue(card.Obj("organizations"), "name"); found {
			fn, ok = v, true
		}
	}
	if !ok {
		if v, found := firstValue(card.Obj("emails"), "address"); found {
			fn, ok = v, true
		}
	}
	if !ok {
		fn = "Unnamed"
	}
	push(line{name: "FN", value: escapeText(fn)})

	if name != nil && len(name.Arr("components")) > 0 {
		slots := map[string][]string{}
		for _, c := range name.Arr("components") {
			comp, err := jsobj.Parse(c)
			if err != nil {
				continue
			}
			kind := comp.StrOr("kind", "")
			if !contains(nComponentKinds, kind) {
				continue
			}
			if value, isStr := comp.Str("value"); isStr {
				slots[kind] = append(slots[kind], value)
			}
		}
		push(line{name: "N", value: joinSlots(nComponentKinds, slots)})
	}

	for _, org := range card.Obj("organizations").Values() {
		values := []string{org.JSStringOr("name", "")}
		for _, u := range org.Arr("units") {
			unit, err := jsobj.Parse(u)
			if err != nil {
				values = append(values, "undefined")
				continue
			}
			values = append(values, unit.JSStringOr("name", ""))
		}
		escaped := make([]string, len(values))
		for i, v := range values {
			escaped[i] = escapeComponent(v)
		}
		push(line{name: "ORG", value: strings.Join(escaped, ";")})
	}

	for _, t := range card.Obj("titles").Values() {
		propName := "TITLE"
		if t.StrOr("kind", "") == "role" {
			propName = "ROLE"
		}
		push(line{name: propName, value: escapeText(t.JSStringOr("name", ""))})
	}

	var nicknames []string
	for _, n := range card.Obj("nicknames").Values() {
		// `.map(n => n.name).filter(Boolean)` — an absent or empty name drops.
		if raw, has := n.Raw("name"); has && isTruthy(raw) {
			nicknames = append(nicknames, escapeText(jsobj.JSStringOf(raw)))
		}
	}
	if len(nicknames) > 0 {
		push(line{name: "NICKNAME", value: strings.Join(nicknames, ",")})
	}

	for _, e := range card.Obj("emails").Values() {
		label, hasLabel := e.Str("label")
		withLabel(label, hasLabel, line{
			name:   "EMAIL",
			params: append([]string{"TYPE=INTERNET"}, typeParams(e)...),
			value:  escapeText(e.JSStringOr("address", "")),
		})
	}

	for _, p := range card.Obj("phones").Values() {
		var params []string
		for _, f := range p.Obj("features").Keys() {
			mapped, known := featureTypes[f]
			if !known {
				mapped = strings.ToUpper(f)
			}
			if mapped == "" {
				continue
			}
			params = append(params, "TYPE="+mapped)
		}
		label, hasLabel := p.Str("label")
		withLabel(label, hasLabel, line{
			name:   "TEL",
			params: append(params, typeParams(p)...),
			value:  escapeText(p.JSStringOr("number", "")),
		})
	}

	for _, a := range card.Obj("addresses").Values() {
		slots := map[string][]string{}
		for _, c := range a.Arr("components") {
			comp, err := jsobj.Parse(c)
			if err != nil {
				continue
			}
			kind := comp.StrOr("kind", "")
			if !contains(adrComponentKinds, kind) {
				continue
			}
			if value, isStr := comp.Str("value"); isStr {
				slots[kind] = append(slots[kind], value)
			}
		}
		push(line{name: "ADR", params: typeParams(a), value: joinSlots(adrComponentKinds, slots)})
	}

	for _, ann := range card.Obj("anniversaries").Values() {
		d := ann.Obj("date")
		if d == nil {
			continue
		}
		value := ""
		if utc, isStr := d.Str("utc"); isStr {
			value = jsSlice(utc, 10)
		} else {
			year, hasYear := d.Num("year")
			month, hasMonth := d.Num("month")
			day, hasDay := d.Num("day")
			switch {
			case hasYear && year != 0 && hasMonth && month != 0 && hasDay && day != 0:
				value = pad(int(year), 4) + "-" + pad(int(month), 2) + "-" + pad(int(day), 2)
			case hasMonth && month != 0 && hasDay && day != 0:
				// Apple's yearless-date convention.
				value = "1604-" + pad(int(month), 2) + "-" + pad(int(day), 2)
			}
		}
		if value == "" {
			continue
		}
		var params []string
		if strings.HasPrefix(value, "1604-") {
			params = []string{"X-APPLE-OMIT-YEAR=1604"}
		}
		switch ann.StrOr("kind", "") {
		case "birth":
			push(line{name: "BDAY", params: params, value: value})
		case "wedding":
			push(line{name: "ANNIVERSARY", params: params, value: value})
		}
	}

	for _, n := range card.Obj("notes").Values() {
		if raw, has := n.Raw("note"); has && isTruthy(raw) {
			push(line{name: "NOTE", value: escapeText(jsobj.JSStringOf(raw))})
		}
	}
	for _, l := range card.Obj("links").Values() {
		if raw, has := l.Raw("uri"); has && isTruthy(raw) {
			label, hasLabel := l.Str("label")
			withLabel(label, hasLabel, line{name: "URL", value: jsobj.JSStringOf(raw)})
		}
	}
	for _, s := range card.Obj("onlineServices").Values() {
		if raw, has := s.Raw("uri"); has && isTruthy(raw) {
			label, hasLabel := s.Str("label")
			withLabel(label, hasLabel, line{name: "IMPP", value: jsobj.JSStringOf(raw)})
		}
	}
	for _, m := range card.Obj("media").Values() {
		uri, isStr := m.Str("uri")
		if m.StrOr("kind", "") != "photo" || !isStr {
			continue
		}
		if data := reDataImage.FindStringSubmatch(uri); data != nil {
			push(line{
				name:   "PHOTO",
				params: []string{"ENCODING=b", "TYPE=" + strings.ToUpper(data[1])},
				value:  stripWhitespace(data[2]),
			})
			continue
		}
		if reHTTP.MatchString(uri) {
			push(line{name: "PHOTO", params: []string{"VALUE=uri"}, value: uri})
		}
	}

	if keywords := card.Obj("keywords"); keywords != nil && keywords.Len() > 0 {
		escaped := make([]string, 0, keywords.Len())
		for _, k := range keywords.Keys() {
			escaped = append(escaped, escapeText(k))
		}
		push(line{name: "CATEGORIES", value: strings.Join(escaped, ",")})
	}
	if card.StrOr("kind", "") == "org" {
		push(line{name: "X-ABSHOWAS", value: "COMPANY"})
	}
	if updated, isStr := card.Str("updated"); isStr {
		if t, err := parseJSDate(updated); err == nil {
			push(line{name: "REV", value: t.UTC().Format("2006-01-02T15:04:05Z")})
		}
	}

	// Lossless tail: re-emit preserved unmapped properties verbatim.
	for _, raw := range card.Arr("vCardProps") {
		var tuple []json.RawMessage
		if json.Unmarshal(raw, &tuple) != nil || len(tuple) < 4 {
			continue
		}
		pname := jsobj.JSStringOf(tuple[0])
		pvalue := jsobj.JSStringOf(tuple[3])
		l := line{name: strings.ToUpper(pname), value: pvalue}
		if params, err := jsobj.Parse(tuple[1]); err == nil {
			for _, k := range params.Keys() {
				v, _ := params.Raw(k)
				if k == "group" {
					// Prefix preserved group names so they cannot collide with the
					// itemN groups minted for labels above (relative grouping
					// survives the rename).
					if g, isStr := params.Str("group"); isStr {
						l.group = "p" + g
					}
					continue
				}
				for _, one := range jsValuesOrSelf(v) {
					l.params = append(l.params, strings.ToUpper(k)+"="+jsobj.JSStringOf(one))
				}
			}
		}
		push(l)
	}

	out := []string{"BEGIN:VCARD", "VERSION:3.0", "PRODID:-//bullmoose//cli//EN"}
	if uid, isStr := card.Str("uid"); isStr {
		out = append(out, fold("UID:"+escapeText(uid)))
	}
	for _, l := range lines {
		head := l.name
		if l.group != "" {
			head = l.group + "." + head
		}
		if len(l.params) > 0 {
			head += ";" + strings.Join(l.params, ";")
		}
		out = append(out, fold(head+":"+l.value))
	}
	out = append(out, "END:VCARD")
	return strings.Join(out, "\r\n") + "\r\n"
}

// jsValuesOrSelf is `(Array.isArray(v) ? v : [v])` — a vCardProps parameter is a
// single value or a list of them.
func jsValuesOrSelf(raw json.RawMessage) []json.RawMessage {
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, "[") {
		var list []json.RawMessage
		if json.Unmarshal(raw, &list) == nil {
			return list
		}
	}
	return []json.RawMessage{raw}
}

// isTruthy is JavaScript truthiness for a JSON value: "" and 0 and false and
// null are falsy, everything else is not. The serializer's `if (l.uri)` guards
// turn on exactly this.
func isTruthy(raw json.RawMessage) bool {
	switch trimmed := strings.TrimSpace(string(raw)); {
	case trimmed == "", trimmed == "null", trimmed == "false", trimmed == `""`, trimmed == "0":
		return false
	default:
		return true
	}
}

// joinSlots renders a structured value: each kind's values joined by "," and the
// kinds joined by ";" in the fixed component order.
func joinSlots(kinds []string, slots map[string][]string) string {
	parts := make([]string, len(kinds))
	for i, k := range kinds {
		escaped := make([]string, len(slots[k]))
		for j, v := range slots[k] {
			escaped[j] = escapeComponent(v)
		}
		parts[i] = strings.Join(escaped, ",")
	}
	return strings.Join(parts, ";")
}

// firstValue is contacts.ts:1119 — the first non-empty string under `key` across
// a map's values.
func firstValue(m *jsobj.Object, key string) (string, bool) {
	for _, v := range m.Values() {
		if s, isStr := v.Str(key); isStr && s != "" {
			return s, true
		}
	}
	return "", false
}

// typeParams is contacts.ts:1126 — the vCard TYPE parameters a JSContact
// contexts/pref pair implies.
func typeParams(entry *jsobj.Object) []string {
	var out []string
	ctx := entry.Obj("contexts")
	if ctx != nil && ctx.Bool("private") {
		out = append(out, "TYPE=HOME")
	}
	if ctx != nil && ctx.Bool("work") {
		out = append(out, "TYPE=WORK")
	}
	if pref, isNum := entry.Num("pref"); isNum && pref == 1 {
		out = append(out, "TYPE=pref")
	}
	return out
}

// escapeText is RFC 6350 §3.4 TEXT escaping, in the TypeScript's pass order —
// the backslash pass runs FIRST so the escapes introduced after it are not
// double-escaped (contacts.ts:1077).
func escapeText(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, "\n", `\n`)
	value = strings.ReplaceAll(value, ",", `\,`)
	return strings.ReplaceAll(value, ";", `\;`)
}

// escapeComponent is the escaping for one component of a structured value
// (N/ADR/ORG). Identical to escapeText today, kept separate because the two are
// separate in the TypeScript and RFC 6350 treats them as different productions.
func escapeComponent(value string) string { return escapeText(value) }

// fold is RFC 6350 §3.2 folding at 75 OCTETS, never splitting a code point —
// contacts.ts:1091. (RFC 5545's folding, in internal/ical, counts differently on
// purpose: that one is a port of a different function.)
func fold(l string) string {
	if len(l) <= 75 {
		return l
	}
	var out []string
	var cur strings.Builder
	curBytes := 0
	for _, r := range l {
		n := utf8.RuneLen(r)
		if curBytes+n > 75 {
			out = append(out, cur.String())
			cur.Reset()
			cur.WriteByte(' ')
			curBytes = 1
		}
		cur.WriteRune(r)
		curBytes += n
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return strings.Join(out, "\r\n")
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

func pad(n, width int) string {
	s := strconv.Itoa(n)
	for len(s) < width {
		s = "0" + s
	}
	return s
}

// parseJSDate is `Date.parse` for the ISO forms `card.updated` can hold — it was
// written by isoTimestamp above, so the round trip is closed.
func parseJSDate(v string) (time.Time, error) {
	for _, layout := range []string{
		time.RFC3339Nano, "2006-01-02T15:04:05Z0700", "2006-01-02T15:04:05.999999999Z0700",
	} {
		if t, err := time.Parse(layout, v); err == nil {
			return t, nil
		}
	}
	return time.ParseInLocation("2006-01-02T15:04:05.999999999", v, time.Local)
}
