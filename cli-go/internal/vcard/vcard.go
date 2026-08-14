// Package vcard is the vCard ⇄ JSContact codec `bullmoose contacts` carries —
// a port of packages/cli/src/vcard.ts (parse) and the serializer half that lives
// in packages/cli/src/contacts.ts (JSContact → vCard 3.0).
//
// WHY IT IS VENDORED, in Go as it already is in TypeScript. The compiled Node CLI
// runs as plain `dist/*.js` with no bundler and no `node_modules/@bullmoose`, so
// it cannot import `packages/contacts-core` at runtime and keeps its own copy;
// arch.md §2 measured that and concluded the Go port "does not create a second
// implementation, it changes the language of one that is already second". This
// package is that same mirror, one language over.
//
// Losslessness is the property to keep: properties with no JSContact mapping are
// preserved in the RFC 9555 `vCardProps` extension (jCard-shaped entries) and
// re-emitted verbatim on the way out, so `export | import` round-trips a book
// with no drift — which is s05 T2's done-when and the cheapest correctness test
// available for the codec.
package vcard

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jsobj"
)

// Card is a JSContact Card. The CLI treats it as an OPEN object — the server is
// the schema authority — so it is an ordered JSON object rather than a struct.
type Card = jsobj.Object

// Parsed is parseVcf's return: the cards, plus the warnings the caller prints to
// stderr (vcard.ts:18 ParsedVcf).
type Parsed struct {
	Cards    []*Card
	Warnings []string
}

// prop is one content line: [group.]NAME[;params]:value — vcard.ts:23 VProp.
// Name is uppercased and param names are lowercased, as there.
type prop struct {
	group  string
	name   string
	params *jsobj.Pairs
	value  string
}

// ---- content-line lexing ---------------------------------------------------

// unfoldLines undoes RFC 6350 §3.2 folding: a physical line starting with a space
// or tab continues the previous logical line (vcard.ts:33).
func unfoldLines(text string) []string {
	raw := splitAnyNewline(text)
	out := make([]string, 0, len(raw))
	for _, line := range raw {
		if (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")) && len(out) > 0 {
			out[len(out)-1] += line[1:]
			continue
		}
		if len(line) > 0 {
			out = append(out, line)
		}
	}
	return out
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

// splitUnescaped splits on a delimiter, honouring backslash escapes — vcard.ts:47.
// The delimiter and the escape are both ASCII, so a byte walk is exact over UTF-8.
func splitUnescaped(value string, delim byte) []string {
	var parts []string
	var cur strings.Builder
	for i := 0; i < len(value); i++ {
		ch := value[i]
		switch {
		case ch == '\\' && i+1 < len(value):
			cur.WriteByte(ch)
			cur.WriteByte(value[i+1])
			i++
		case ch == delim:
			parts = append(parts, cur.String())
			cur.Reset()
		default:
			cur.WriteByte(ch)
		}
	}
	return append(parts, cur.String())
}

// paramValues splits a parameter value on commas outside quotes, strips the
// quotes, then splits again inside formerly-quoted values — producers disagree on
// whether TYPE="voice,work" is one value or a list, and for the enum-shaped
// params consumed here a list is always right (vcard.ts:72).
func paramValues(raw string) []string {
	var parts []string
	var cur strings.Builder
	inQuotes := false
	for _, ch := range raw {
		switch {
		case ch == '"':
			inQuotes = !inQuotes
		case ch == ',' && !inQuotes:
			parts = append(parts, cur.String())
			cur.Reset()
		default:
			cur.WriteRune(ch)
		}
	}
	parts = append(parts, cur.String())
	var out []string
	for _, p := range parts {
		for _, v := range strings.Split(p, ",") {
			if len(v) > 0 {
				out = append(out, v)
			}
		}
	}
	return out
}

// unescapeText undoes vCard TEXT escaping (RFC 6350 §3.4) — vcard.ts:88. The
// pass ORDER is the TypeScript's and is load-bearing: `\\n` must stay a literal
// backslash followed by n rather than becoming a newline, which the trailing
// `\\\\` pass is what delivers.
func unescapeText(value string) string {
	value = strings.ReplaceAll(value, `\n`, "\n")
	value = strings.ReplaceAll(value, `\N`, "\n")
	value = strings.ReplaceAll(value, `\,`, ",")
	value = strings.ReplaceAll(value, `\;`, ";")
	return strings.ReplaceAll(value, `\\`, `\`)
}

// parseLine reads one content line, or nil when there is no value separator —
// vcard.ts:97.
func parseLine(line string) *prop {
	colon := -1
	inQuotes := false
	for i := 0; i < len(line); i++ {
		switch line[i] {
		case '"':
			inQuotes = !inQuotes
		case ':':
			if !inQuotes {
				colon = i
			}
		}
		if colon >= 0 {
			break
		}
	}
	if colon <= 0 {
		return nil
	}

	head := line[:colon]
	value := line[colon+1:]

	var segments []string
	var cur strings.Builder
	inQuotes = false
	for _, ch := range head {
		switch {
		case ch == '"':
			inQuotes = !inQuotes
			cur.WriteRune(ch)
		case ch == ';' && !inQuotes:
			segments = append(segments, cur.String())
			cur.Reset()
		default:
			cur.WriteRune(ch)
		}
	}
	segments = append(segments, cur.String())

	nameSeg := segments[0]
	group := ""
	if dot := strings.Index(nameSeg, "."); dot > 0 {
		group = nameSeg[:dot]
		nameSeg = nameSeg[dot+1:]
	}

	params := jsobj.NewPairs()
	for _, seg := range segments[1:] {
		if seg == "" {
			continue
		}
		eq := strings.Index(seg, "=")
		// v2.1 bare params ("HOME", "CELL", "QUOTED-PRINTABLE") are TYPEs/encodings.
		pname := "type"
		pvalRaw := seg
		if eq != -1 {
			pname = jsobj.Lower(seg[:eq])
			pvalRaw = seg[eq+1:]
		}
		params.Append(pname, paramValues(pvalRaw)...)
	}

	return &prop{
		group:  group,
		name:   strings.ToUpper(strings.TrimSpace(nameSeg)),
		params: params,
		value:  value,
	}
}

// decodeQP is quoted-printable decoding — vcard.ts:151.
func decodeQP(value string) string {
	var bytesOut []byte
	for i := 0; i < len(value); i++ {
		ch := value[i]
		if ch == '=' && i+3 <= len(value) {
			hexPair := value[i+1 : i+3]
			if isHexPair(hexPair) {
				b, _ := strconv.ParseUint(hexPair, 16, 8)
				bytesOut = append(bytesOut, byte(b))
				i += 2
				continue
			}
		}
		bytesOut = append(bytesOut, ch)
	}
	return string(bytesOut)
}

func isHexPair(s string) bool {
	if len(s) != 2 {
		return false
	}
	for i := 0; i < 2; i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

// parseBlocks splits unfolded lines into vCard blocks — vcard.ts:169.
func parseBlocks(text string) ([][]*prop, []string) {
	lines := unfoldLines(text)
	var blocks [][]*prop
	var warnings []string
	var current []*prop
	started := false

	for i := 0; i < len(lines); i++ {
		line := lines[i]
		p := parseLine(line)
		if p == nil {
			if strings.TrimSpace(line) != "" {
				warnings = append(warnings, "unparseable line skipped: "+jsSlice(line, 60))
			}
			continue
		}
		if p.name == "BEGIN" && strings.ToUpper(strings.TrimSpace(p.value)) == "VCARD" {
			if started {
				warnings = append(warnings, "nested BEGIN:VCARD — starting a new card")
			}
			current = []*prop{}
			started = true
			continue
		}
		if p.name == "END" && strings.ToUpper(strings.TrimSpace(p.value)) == "VCARD" {
			if started {
				blocks = append(blocks, current)
			}
			current = nil
			started = false
			continue
		}
		if !started {
			continue
		}

		// v2.1 quoted-printable: a trailing "=" continues on the next line.
		if hasEncoding(p.params, "QUOTED-PRINTABLE") {
			for strings.HasSuffix(p.value, "=") && i+1 < len(lines) {
				i++
				p.value = p.value[:len(p.value)-1] + lines[i]
			}
			p.value = decodeQP(p.value)
		}
		current = append(current, p)
	}
	if started {
		warnings = append(warnings, "unterminated vCard (missing END:VCARD)")
	}
	return blocks, warnings
}

func hasEncoding(params *jsobj.Pairs, want string) bool {
	for _, e := range params.Get("encoding") {
		if strings.ToUpper(e) == want {
			return true
		}
	}
	return false
}

// jsSlice is `s.slice(0, n)` on UTF-16 code units. Only used for a warning
// string, but a byte slice could split a code point and print a replacement char
// where Node prints half a character.
func jsSlice(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}

// ---- vCard → JSContact ------------------------------------------------------

// telFeatures maps a vCard TEL type to its JSContact phone feature — vcard.ts:209.
var telFeatures = map[string]string{
	"cell": "mobile", "voice": "voice", "fax": "fax",
	"pager": "pager", "text": "text", "video": "video", "textphone": "textphone",
}

// contextsOf is vcard.ts:219 — HOME → private, WORK → work; absent when neither.
func contextsOf(p *prop) *jsobj.Object {
	out := jsobj.New()
	for _, t := range p.params.Get("type") {
		switch jsobj.Lower(t) {
		case "home":
			_ = out.Set("private", true)
		case "work":
			_ = out.Set("work", true)
		}
	}
	if out.Len() == 0 {
		return nil
	}
	return out
}

// prefOf is vcard.ts:228: PREF=n when 1..100, else v3's TYPE=pref → 1.
func prefOf(p *prop) (int, bool) {
	if raw, ok := p.params.First("pref"); ok {
		if n, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && n >= 1 && n <= 100 {
			return n, true
		}
	}
	for _, t := range p.params.Get("type") {
		if jsobj.Lower(t) == "pref" {
			return 1, true
		}
	}
	return 0, false
}

var appleLabel = regexp.MustCompile(`^_\$!<(.+)>!\$_$`)

// cleanLabel unwraps Apple's "_$!<Home>!$_" X-ABLabel form — vcard.ts:240.
func cleanLabel(raw string) string {
	if m := appleLabel.FindStringSubmatch(raw); m != nil {
		return m[1]
	}
	return raw
}

var (
	reFullDate  = regexp.MustCompile(`^(\d{4})-?(\d{2})-?(\d{2})$`)
	reMonthDay  = regexp.MustCompile(`^--(\d{2})-?(\d{2})$`)
	reYearMonth = regexp.MustCompile(`^(\d{4})(?:-(\d{2}))?$`)
	reCompactTS = regexp.MustCompile(`^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{2}:?\d{2})?$`)
)

// anniversaryDate is vCard DATE-AND-OR-TIME → a JSContact PartialDate or
// Timestamp, or nil when it is neither — vcard.ts:246.
func anniversaryDate(value string) *jsobj.Object {
	v := strings.TrimSpace(value)
	if strings.Contains(v, "T") {
		iso, ok := isoTimestamp(v)
		if !ok {
			return nil
		}
		out := jsobj.New()
		_ = out.Set("@type", "Timestamp")
		_ = out.Set("utc", iso)
		return out
	}
	if m := reFullDate.FindStringSubmatch(v); m != nil {
		out := jsobj.New()
		_ = out.Set("year", atoi(m[1]))
		_ = out.Set("month", atoi(m[2]))
		_ = out.Set("day", atoi(m[3]))
		return out
	}
	if m := reMonthDay.FindStringSubmatch(v); m != nil {
		out := jsobj.New()
		_ = out.Set("month", atoi(m[1]))
		_ = out.Set("day", atoi(m[2]))
		return out
	}
	if m := reYearMonth.FindStringSubmatch(v); m != nil {
		out := jsobj.New()
		_ = out.Set("year", atoi(m[1]))
		if m[2] != "" {
			_ = out.Set("month", atoi(m[2]))
		}
		return out
	}
	return nil
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// isoTimestamp is vcard.ts:263: a vCard timestamp (basic or extended) → the
// RFC 3339 UTC form `new Date(ms).toISOString()` produces, which always carries
// exactly three fractional digits.
//
// ⚠️ Divergence bound, stated rather than hidden: `Date.parse` accepts a long tail
// of non-ISO spellings this does not. The forms below are the ones RFC 6350 REV
// and BDAY actually carry; anything else answers "not a timestamp" here, where
// Node might answer a date. The consequence is a property preserved verbatim in
// `vCardProps` instead of mapped — lossless either way, never a wrong value.
func isoTimestamp(v string) (string, bool) {
	normalized := v
	if m := reCompactTS.FindStringSubmatch(v); m != nil {
		zone := m[7]
		if zone == "" {
			zone = "Z"
		}
		normalized = m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":" + m[6] + zone
	}
	layouts := []string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05Z0700",
		"2006-01-02T15:04:05.999999999Z0700",
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, normalized); err == nil {
			return isoString(t), true
		}
	}
	// ES2015 §20.3.3.2: a date-time form with no offset is LOCAL time, a
	// date-only form is UTC. Both are reachable from REV in the wild.
	for _, layout := range []string{"2006-01-02T15:04:05.999999999", "2006-01-02T15:04"} {
		if t, err := time.ParseInLocation(layout, normalized, time.Local); err == nil {
			return isoString(t), true
		}
	}
	if t, err := time.ParseInLocation("2006-01-02", normalized, time.UTC); err == nil {
		return isoString(t), true
	}
	return "", false
}

// isoString is `new Date(ms).toISOString()`.
func isoString(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

var nComponentKinds = []string{"surname", "given", "given2", "title", "credential"}

var adrComponentKinds = []string{
	"postOfficeBox", "apartment", "name", "locality", "region", "postcode", "country",
}

// cardFromBlock is vcard.ts:310. The KEY ORDER of the object it builds is part of
// the output contract (`contacts show` prints it indented, `export --json` prints
// it as one line), so the assignments below happen in the TypeScript's order and
// the collection properties are attached afterwards in the TypeScript's order.
func cardFromBlock(props []*prop, warnings *[]string) *Card {
	card := jsobj.New()
	_ = card.Set("@type", "Card")
	_ = card.Set("version", "1.0")
	var vCardProps []any

	// Apple item groups: itemN.X-ABLabel names its sibling properties.
	groupLabels := map[string]string{}
	for _, p := range props {
		if p.name == "X-ABLABEL" && p.group != "" {
			groupLabels[p.group] = cleanLabel(unescapeText(p.value))
		}
	}
	labelOf := func(p *prop) (string, bool) {
		if p.group == "" {
			return "", false
		}
		l, ok := groupLabels[p.group]
		return l, ok
	}

	emails := jsobj.New()
	phones := jsobj.New()
	addresses := jsobj.New()
	nicknames := jsobj.New()
	organizations := jsobj.New()
	titles := jsobj.New()
	notes := jsobj.New()
	links := jsobj.New()
	media := jsobj.New()
	services := jsobj.New()
	anniversaries := jsobj.New()
	keywords := jsobj.New()
	counter := 0
	nextID := func(prefix string) string {
		counter++
		return prefix + strconv.Itoa(counter)
	}
	// name is created lazily by FN or N, exactly as `card.name ??= {}` does, and
	// its position in the card is wherever the first of the two appeared.
	nameOf := func() *jsobj.Object {
		if n := card.Obj("name"); n != nil {
			return n
		}
		return jsobj.New()
	}

	for _, p := range props {
		switch p.name {
		case "VERSION", "X-ABLABEL":
			// consumed above / not mapped

		case "UID":
			_ = card.Set("uid", unescapeText(strings.TrimSpace(p.value)))

		case "FN":
			name := nameOf()
			if !name.Has("full") {
				_ = name.Set("full", strings.TrimSpace(unescapeText(p.value)))
			}
			_ = card.Set("name", name)

		case "N":
			parts := splitUnescaped(p.value, ';')
			var components []any
			for idx, kind := range nComponentKinds {
				seg := ""
				if idx < len(parts) {
					seg = parts[idx]
				}
				for _, v := range splitUnescaped(seg, ',') {
					value := strings.TrimSpace(unescapeText(v))
					if value == "" {
						continue
					}
					c := jsobj.New()
					_ = c.Set("kind", kind)
					_ = c.Set("value", value)
					components = append(components, c)
				}
			}
			if len(components) > 0 {
				name := nameOf()
				_ = name.Set("components", components)
				_ = card.Set("name", name)
			}

		case "NICKNAME":
			for _, v := range splitUnescaped(p.value, ',') {
				value := strings.TrimSpace(unescapeText(v))
				if value == "" {
					continue
				}
				entry := jsobj.New()
				_ = entry.Set("name", value)
				_ = nicknames.Set(nextID("nick"), entry)
			}

		case "ORG":
			raw := splitUnescaped(p.value, ';')
			parts := make([]string, len(raw))
			for i, v := range raw {
				parts[i] = strings.TrimSpace(unescapeText(v))
			}
			orgName := ""
			if len(parts) > 0 {
				orgName = parts[0]
			}
			var units []any
			if len(parts) > 1 {
				for _, u := range parts[1:] {
					if u == "" {
						continue
					}
					unit := jsobj.New()
					_ = unit.Set("name", u)
					units = append(units, unit)
				}
			}
			org := jsobj.New()
			if orgName != "" {
				_ = org.Set("name", orgName)
			}
			if len(units) > 0 {
				_ = org.Set("units", units)
			}
			_ = organizations.Set(nextID("org"), org)

		case "TITLE", "ROLE":
			kind := "title"
			if p.name == "ROLE" {
				kind = "role"
			}
			entry := jsobj.New()
			_ = entry.Set("kind", kind)
			_ = entry.Set("name", strings.TrimSpace(unescapeText(p.value)))
			_ = titles.Set(nextID("title"), entry)

		case "EMAIL":
			entry := jsobj.New()
			_ = entry.Set("address", strings.TrimSpace(unescapeText(p.value)))
			if ctx := contextsOf(p); ctx != nil {
				_ = entry.Set("contexts", ctx)
			}
			if pref, ok := prefOf(p); ok {
				_ = entry.Set("pref", pref)
			}
			if label, ok := labelOf(p); ok && label != "" {
				_ = entry.Set("label", label)
			}
			_ = emails.Set(nextID("email"), entry)

		case "TEL":
			features := jsobj.New()
			for _, t := range p.params.Get("type") {
				if f, ok := telFeatures[jsobj.Lower(t)]; ok {
					_ = features.Set(f, true)
				}
			}
			entry := jsobj.New()
			_ = entry.Set("number", strings.TrimSpace(unescapeText(p.value)))
			if features.Len() > 0 {
				_ = entry.Set("features", features)
			}
			if ctx := contextsOf(p); ctx != nil {
				_ = entry.Set("contexts", ctx)
			}
			if pref, ok := prefOf(p); ok {
				_ = entry.Set("pref", pref)
			}
			if label, ok := labelOf(p); ok && label != "" {
				_ = entry.Set("label", label)
			}
			_ = phones.Set(nextID("phone"), entry)

		case "ADR":
			parts := splitUnescaped(p.value, ';')
			var components []any
			for idx, kind := range adrComponentKinds {
				seg := ""
				if idx < len(parts) {
					seg = parts[idx]
				}
				for _, v := range splitUnescaped(seg, ',') {
					value := strings.TrimSpace(unescapeText(v))
					if value == "" {
						continue
					}
					c := jsobj.New()
					_ = c.Set("kind", kind)
					_ = c.Set("value", value)
					components = append(components, c)
				}
			}
			if len(components) == 0 {
				break
			}
			entry := jsobj.New()
			_ = entry.Set("components", components)
			if ctx := contextsOf(p); ctx != nil {
				_ = entry.Set("contexts", ctx)
			}
			if label, ok := p.params.First("label"); ok {
				_ = entry.Set("full", unescapeText(label))
			}
			if pref, ok := prefOf(p); ok {
				_ = entry.Set("pref", pref)
			}
			_ = addresses.Set(nextID("addr"), entry)

		case "BDAY", "ANNIVERSARY":
			date := anniversaryDate(p.value)
			if date == nil {
				vCardProps = append(vCardProps, jcard(p))
				break
			}
			kind := "birth"
			if p.name == "ANNIVERSARY" {
				kind = "wedding"
			}
			entry := jsobj.New()
			_ = entry.Set("kind", kind)
			_ = entry.Set("date", date)
			_ = anniversaries.Set(nextID("ann"), entry)

		case "NOTE":
			note := strings.TrimSpace(unescapeText(p.value))
			if note == "" {
				break
			}
			entry := jsobj.New()
			_ = entry.Set("note", note)
			_ = notes.Set(nextID("note"), entry)

		case "URL":
			entry := jsobj.New()
			_ = entry.Set("uri", strings.TrimSpace(unescapeText(p.value)))
			if label, ok := labelOf(p); ok && label != "" {
				_ = entry.Set("label", label)
			}
			_ = links.Set(nextID("link"), entry)

		case "PHOTO":
			uri, ok := photoURI(p)
			if !ok {
				vCardProps = append(vCardProps, jcard(p))
				break
			}
			entry := jsobj.New()
			_ = entry.Set("kind", "photo")
			_ = entry.Set("uri", uri)
			_ = media.Set(nextID("photo"), entry)

		case "CATEGORIES":
			for _, v := range splitUnescaped(p.value, ',') {
				kw := strings.TrimSpace(unescapeText(v))
				if kw != "" {
					_ = keywords.Set(kw, true)
				}
			}

		case "IMPP":
			entry := jsobj.New()
			_ = entry.Set("uri", strings.TrimSpace(unescapeText(p.value)))
			if label, ok := labelOf(p); ok && label != "" {
				_ = entry.Set("label", label)
			}
			_ = services.Set(nextID("svc"), entry)

		case "KIND":
			kind := jsobj.Lower(strings.TrimSpace(p.value))
			switch kind {
			case "individual", "org", "group", "location", "device", "application":
				_ = card.Set("kind", kind)
			}

		case "X-ABSHOWAS":
			if strings.ToUpper(strings.TrimSpace(p.value)) == "COMPANY" {
				_ = card.Set("kind", "org")
			}

		case "REV":
			if iso, ok := isoTimestamp(strings.TrimSpace(p.value)); ok {
				_ = card.Set("updated", iso)
			}

		case "PRODID":
			_ = card.Set("prodId", strings.TrimSpace(unescapeText(p.value)))

		default:
			vCardProps = append(vCardProps, jcard(p))
		}
	}

	setIfAny := func(key string, o *jsobj.Object) {
		if o.Len() > 0 {
			_ = card.Set(key, o)
		}
	}
	setIfAny("emails", emails)
	setIfAny("phones", phones)
	setIfAny("addresses", addresses)
	setIfAny("nicknames", nicknames)
	setIfAny("organizations", organizations)
	setIfAny("titles", titles)
	setIfAny("notes", notes)
	setIfAny("links", links)
	setIfAny("media", media)
	setIfAny("onlineServices", services)
	setIfAny("anniversaries", anniversaries)
	setIfAny("keywords", keywords)
	if len(vCardProps) > 0 {
		_ = card.Set("vCardProps", vCardProps)
	}

	// No UID: derive a deterministic one from identifying content, so
	// re-importing the same file is idempotent (import dedups on uid).
	if uid, ok := card.Str("uid"); !ok || uid == "" {
		_ = card.Set("uid", deterministicUID(card))
	}
	if !card.Has("name") && !card.Has("organizations") {
		*warnings = append(*warnings, "card "+card.StrOr("uid", "undefined")+" has no name or organization")
	}
	return card
}

// photoURI is vcard.ts:524: an inline base64 PHOTO becomes a data: URI, a
// literal data:/http(s): value passes through, anything else is not a photo.
func photoURI(p *prop) (string, bool) {
	value := strings.TrimSpace(p.value)
	inline := false
	for _, e := range p.params.Get("encoding") {
		if u := strings.ToUpper(e); u == "B" || u == "BASE64" {
			inline = true
		}
	}
	if inline {
		subtype := "jpeg"
		if t, ok := p.params.First("type"); ok {
			subtype = strings.ReplaceAll(jsobj.Lower(t), "image/", "")
		}
		return "data:image/" + subtype + ";base64," + stripWhitespace(value), true
	}
	if reDataOrHTTP.MatchString(value) {
		return value, true
	}
	return "", false
}

var reDataOrHTTP = regexp.MustCompile(`(?i)^(data|https?):`)

// stripWhitespace is JavaScript's `replaceAll(/\s/g, "")` over the ASCII
// whitespace a folded base64 payload can carry.
func stripWhitespace(s string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case ' ', '\t', '\n', '\r', '\v', '\f', 0x00a0, 0xfeff:
			return -1
		}
		return r
	}, s)
}

// jcard is the RFC 9555 `vCardProps` lossless fallback — vcard.ts:536. A single
// parameter value collapses to a string; several stay an array; the group, when
// present, is appended last.
func jcard(p *prop) []any {
	params := jsobj.New()
	for _, k := range p.params.Keys() {
		v := p.params.Get(k)
		if len(v) == 1 {
			_ = params.Set(k, v[0])
			continue
		}
		_ = params.Set(k, v)
	}
	if p.group != "" {
		_ = params.Set("group", p.group)
	}
	return []any{jsobj.Lower(p.name), params, "unknown", p.value}
}

// deterministicUID is vcard.ts:543 — sha256 of the identifying content, first 24
// hex characters. Byte-identical to the TypeScript because the joined key is
// identical and both hash UTF-8.
func deterministicUID(card *Card) string {
	var key []string
	name := card.Obj("name")
	if name != nil {
		key = append(key, name.StrOr("full", ""))
		for _, c := range name.Arr("components") {
			comp, err := jsobj.Parse(c)
			if err != nil {
				key = append(key, "")
				continue
			}
			key = append(key, comp.StrOr("value", ""))
		}
	} else {
		key = append(key, "")
	}
	for _, e := range card.Obj("emails").Values() {
		key = append(key, e.StrOr("address", ""))
	}
	for _, p := range card.Obj("phones").Values() {
		key = append(key, p.StrOr("number", ""))
	}
	for _, o := range card.Obj("organizations").Values() {
		key = append(key, o.StrOr("name", ""))
	}
	sum := sha256.Sum256([]byte(strings.Join(key, "|")))
	return "urn:bullmoose:vcf:" + hex.EncodeToString(sum[:])[:24]
}

// ParseVCF parses a .vcf payload (any number of cards) into JSContact Cards —
// vcard.ts:562.
func ParseVCF(text string) Parsed {
	blocks, warnings := parseBlocks(text)
	cards := make([]*Card, 0, len(blocks))
	for _, b := range blocks {
		cards = append(cards, cardFromBlock(b, &warnings))
	}
	return Parsed{Cards: cards, Warnings: warnings}
}
