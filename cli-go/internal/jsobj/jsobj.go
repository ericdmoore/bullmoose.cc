// Package jsobj is a JSON object that remembers the order its keys arrived in.
//
// It exists because the contacts and calendar ports (s08 T6 wave 3) are held to
// byte-identity with `packages/cli/src/{contacts,calendar}.ts`, and both commands
// re-emit SERVER objects verbatim:
//
//	contacts show          JSON.stringify(card, null, 2)   — a whole card, indented
//	contacts export --json emitNdjson(cards)                — a whole card per line
//	calendar export --json emitNdjson(events)               — likewise
//
// In JavaScript `JSON.parse` → `JSON.stringify` is order-preserving, so those
// bytes are the server's own key order. A Go `map[string]any` marshals its keys
// SORTED, so decode → re-encode would silently reorder every card and every
// event. `internal/cmd/read.go` already met this and walked the raw bytes by
// hand; contacts needs the same thing repeatedly, plus the ability to EDIT the
// object (delete `id`, set `addressBookIds`) without disturbing the rest, so the
// walk is a type here rather than a function there.
//
// The vCard serializer needs the same property for a second reason: it iterates
// `Object.values(card.emails)` and writes one EMAIL line per entry, so the order
// of the emitted vCard is the order of the stored JSContact map.
package jsobj

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

// Object is a JSON object with its members in order. The zero value is an empty
// object ready to use.
type Object struct {
	keys []string
	vals map[string]json.RawMessage
}

// New returns an empty object.
func New() *Object { return &Object{vals: map[string]json.RawMessage{}} }

// Parse decodes one JSON object, preserving key order. A non-object (including
// `null`) is an error; ParseValue is the tolerant form.
func Parse(raw []byte) (*Object, error) {
	o := New()
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '{' {
		return nil, errNotObject
	}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, _ := keyTok.(string)
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		o.SetRaw(key, value)
	}
	return o, nil
}

type parseError struct{ msg string }

func (e *parseError) Error() string { return e.msg }

var errNotObject = &parseError{msg: "jsobj: value is not a JSON object"}

// IsNotObject reports whether err came from Parse being handed a non-object.
func IsNotObject(err error) bool { return err == errNotObject }

// Len is the number of members.
func (o *Object) Len() int {
	if o == nil {
		return 0
	}
	return len(o.keys)
}

// Keys returns the member names in order.
func (o *Object) Keys() []string {
	if o == nil {
		return nil
	}
	return append([]string(nil), o.keys...)
}

// Raw returns one member's bytes.
func (o *Object) Raw(key string) (json.RawMessage, bool) {
	if o == nil {
		return nil, false
	}
	v, ok := o.vals[key]
	return v, ok
}

// Has reports member presence — the JS `key in obj`, which is NOT the same as a
// non-null value.
func (o *Object) Has(key string) bool {
	_, ok := o.Raw(key)
	return ok
}

// Str is `typeof o[key] === "string" ? o[key] : ""`, with the second return
// distinguishing "absent or not a string" from "the empty string".
func (o *Object) Str(key string) (string, bool) {
	raw, ok := o.Raw(key)
	if !ok {
		return "", false
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}

// StrOr is Str with a fallback for the absent/non-string case.
func (o *Object) StrOr(key, fallback string) string {
	if s, ok := o.Str(key); ok {
		return s
	}
	return fallback
}

// JSString is JavaScript's `String(o[key])`: an absent key is the literal
// "undefined" and a JSON null is "null", because that is what the TypeScript
// prints when a property it expected is missing. Faithful rather than tidy — a
// card with a numeric `name` really does serialise its digits.
func (o *Object) JSString(key string) string {
	raw, ok := o.Raw(key)
	if !ok {
		return "undefined"
	}
	return JSStringOf(raw)
}

// JSStringOr is `String(o[key] ?? fallback)` — `??` is nullish, so BOTH an absent
// key and an explicit null take the fallback.
func (o *Object) JSStringOr(key, fallback string) string {
	raw, ok := o.Raw(key)
	if !ok || string(raw) == "null" {
		return fallback
	}
	return JSStringOf(raw)
}

// JSStringOf renders one JSON value as `String(value)` does.
func JSStringOf(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return "undefined"
	}
	switch trimmed[0] {
	case '"':
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return s
		}
	case '{':
		return "[object Object]"
	case '[':
		// Array.prototype.toString is the elements joined by "," — reached only
		// by malformed input, but silently printing JSON would be a lie.
		var list []json.RawMessage
		if json.Unmarshal(raw, &list) == nil {
			parts := make([]string, len(list))
			for i, e := range list {
				parts[i] = JSStringOf(e)
			}
			return strings.Join(parts, ",")
		}
	case 'n', 't', 'f':
		// null / true / false print as their literal. Handled BEFORE the numeric
		// attempt because `json.Unmarshal([]byte("null"), &float64)` SUCCEEDS and
		// leaves the zero value — which would render null as "0".
		return trimmed
	default:
		var n float64
		if json.Unmarshal(raw, &n) == nil {
			return strconv.FormatFloat(n, 'f', -1, 64)
		}
	}
	return trimmed
}

// JSNumberOf is `Number(value)` for the numeric slots a server-stored list can
// hold — a non-number is 0 here where JS answers NaN, and both are refused by
// whatever consumes them.
func JSNumberOf(raw json.RawMessage) float64 {
	var n float64
	if json.Unmarshal(raw, &n) == nil {
		return n
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if f, err := strconv.ParseFloat(strings.TrimSpace(s), 64); err == nil {
			return f
		}
	}
	return 0
}

// Num is `typeof o[key] === "number"`.
func (o *Object) Num(key string) (float64, bool) {
	raw, ok := o.Raw(key)
	if !ok {
		return 0, false
	}
	var n float64
	if json.Unmarshal(raw, &n) != nil {
		return 0, false
	}
	return n, true
}

// Bool is `o[key] === true`.
func (o *Object) Bool(key string) bool {
	raw, ok := o.Raw(key)
	return ok && string(raw) == "true"
}

// Obj returns a member as an object, or nil when it is absent or not one.
func (o *Object) Obj(key string) *Object {
	raw, ok := o.Raw(key)
	if !ok {
		return nil
	}
	sub, err := Parse(raw)
	if err != nil {
		return nil
	}
	return sub
}

// Arr returns a member as a list of raw elements, or nil when it is not an array.
func (o *Object) Arr(key string) []json.RawMessage {
	raw, ok := o.Raw(key)
	if !ok {
		return nil
	}
	var list []json.RawMessage
	if json.Unmarshal(raw, &list) != nil {
		return nil
	}
	return list
}

// SetRaw stores pre-encoded bytes. An existing key KEEPS ITS POSITION, which is
// JavaScript's assignment semantics and the reason `card.uid = …` on a card that
// already had a UID does not move it to the end.
func (o *Object) SetRaw(key string, value json.RawMessage) {
	if o.vals == nil {
		o.vals = map[string]json.RawMessage{}
	}
	if _, exists := o.vals[key]; !exists {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = value
}

// Set marshals and stores a value. HTML escaping is OFF so `<`, `>` and `&`
// survive as themselves — JSON.stringify does not escape them (see bmio's
// marshalCompact).
func (o *Object) Set(key string, value any) error {
	raw, err := Marshal(value)
	if err != nil {
		return err
	}
	o.SetRaw(key, raw)
	return nil
}

// Delete removes a member — the `delete card.id` every write path performs
// because the id is server-set.
func (o *Object) Delete(key string) {
	if o == nil {
		return
	}
	if _, ok := o.vals[key]; !ok {
		return
	}
	delete(o.vals, key)
	for i, k := range o.keys {
		if k == key {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

// Values is `Object.values(o)` filtered to the entries JavaScript calls objects:
// `v !== null && typeof v === "object"`. That set INCLUDES arrays, which reach a
// property access as undefined — an array member therefore yields an empty
// Object here, which reads back the same way.
func (o *Object) Values() []*Object {
	if o == nil {
		return nil
	}
	out := make([]*Object, 0, len(o.keys))
	for _, k := range o.keys {
		raw := o.vals[k]
		trimmed := bytes.TrimLeft(raw, " \t\r\n")
		if len(trimmed) == 0 {
			continue
		}
		switch trimmed[0] {
		case '{':
			sub, err := Parse(raw)
			if err != nil {
				continue
			}
			out = append(out, sub)
		case '[':
			out = append(out, New()) // an array: every property access is undefined
		}
	}
	return out
}

// MarshalJSON writes the members in order, compact.
func (o *Object) MarshalJSON() ([]byte, error) {
	if o == nil {
		return []byte("null"), nil
	}
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		key, err := Marshal(k)
		if err != nil {
			return nil, err
		}
		buf.Write(key)
		buf.WriteByte(':')
		var compact bytes.Buffer
		if err := json.Compact(&compact, o.vals[k]); err != nil {
			return nil, err
		}
		buf.Write(compact.Bytes())
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// Marshal is json.Marshal with HTML escaping OFF and no trailing newline, so the
// bytes match JSON.stringify.
func Marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// Compact renders pre-existing JSON bytes on one line — `emitJson(serverValue)`,
// where the value is repeated rather than re-derived.
func Compact(raw json.RawMessage) (string, error) {
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// Indent2 is `JSON.stringify(value, null, 2)` over pre-existing bytes — the
// human rendering of `contacts show`. encoding/json's Indent produces exactly
// those bytes, colon spacing and empty-object collapsing included.
func Indent2(raw json.RawMessage) (string, error) {
	var buf bytes.Buffer
	if err := json.Indent(&buf, raw, "", "  "); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// Pairs is an ordered map of string → []string, for the vCard parameter lists
// whose insertion order reaches the wire through the RFC 9555 `vCardProps`
// fallback (`Object.entries(p.params)`).
type Pairs struct {
	keys []string
	vals map[string][]string
}

// NewPairs returns an empty ordered multimap.
func NewPairs() *Pairs { return &Pairs{vals: map[string][]string{}} }

// Append adds values under a key, creating it in order on first use.
func (p *Pairs) Append(key string, values ...string) {
	if p.vals == nil {
		p.vals = map[string][]string{}
	}
	if _, ok := p.vals[key]; !ok {
		p.keys = append(p.keys, key)
	}
	p.vals[key] = append(p.vals[key], values...)
}

// Get returns the values stored under a key.
func (p *Pairs) Get(key string) []string {
	if p == nil {
		return nil
	}
	return p.vals[key]
}

// First is `p[key]?.[0]`.
func (p *Pairs) First(key string) (string, bool) {
	v := p.Get(key)
	if len(v) == 0 {
		return "", false
	}
	return v[0], true
}

// Keys returns the key names in insertion order.
func (p *Pairs) Keys() []string {
	if p == nil {
		return nil
	}
	return append([]string(nil), p.keys...)
}

// Lower lowercases with Go's simple mapping. Called out because arch.md §5 warns
// that `strings.ToLower` and JS `toLowerCase` disagree on the Turkish dotted I —
// that divergence is load-bearing for the LOGIN SALT and irrelevant here, where
// the inputs are vCard parameter names and ASCII enum tokens.
func Lower(s string) string { return strings.ToLower(s) }
