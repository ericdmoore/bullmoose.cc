package jsobj

// The one property this package exists for: a JSON object survives decode →
// re-encode with its key order intact, because `contacts show`, `contacts export
// --json` and `calendar export --json` all re-emit the SERVER's object and are
// held to byte-identity with a JavaScript CLI where `JSON.parse` →
// `JSON.stringify` preserves order.
//
// A `map[string]json.RawMessage` would pass every other test in the suite and
// silently sort every card. TestOrderSurvivesARoundTrip is the one that notices.

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestOrderSurvivesARoundTrip(t *testing.T) {
	const raw = `{"id":"cc_ada","@type":"Card","version":"1.0","zeta":1,"alpha":2,` +
		`"emails":{"e1":{"address":"a@b"}},"nested":[1,{"k":"v"}],"empty":{},"nil":null}`
	o, err := Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	out, err := o.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != raw {
		t.Errorf("round trip changed the bytes:\n got %s\nwant %s", out, raw)
	}
	// A sorted map would give alpha,@type,… — assert the ORDER explicitly so the
	// failure names the property rather than showing a byte diff.
	want := "id,@type,version,zeta,alpha,emails,nested,empty,nil"
	if got := strings.Join(o.Keys(), ","); got != want {
		t.Errorf("keys = %s, want %s", got, want)
	}
}

func TestSetKeepsAnExistingKeyInPlace(t *testing.T) {
	// JavaScript assignment semantics: `card.uid = x` on a card that already has
	// a uid does NOT move it to the end. vcard's parser depends on this.
	o, _ := Parse([]byte(`{"a":1,"b":2,"c":3}`))
	_ = o.Set("b", 99)
	out, _ := o.MarshalJSON()
	if string(out) != `{"a":1,"b":99,"c":3}` {
		t.Errorf("got %s", out)
	}
	_ = o.Set("d", 4)
	out, _ = o.MarshalJSON()
	if string(out) != `{"a":1,"b":99,"c":3,"d":4}` {
		t.Errorf("a NEW key appends: %s", out)
	}
}

func TestDeleteRemovesFromBothTheMapAndTheOrder(t *testing.T) {
	o, _ := Parse([]byte(`{"id":"x","uid":"u","name":"n"}`))
	o.Delete("id") // every write verb does this — the id is server-set
	out, _ := o.MarshalJSON()
	if string(out) != `{"uid":"u","name":"n"}` {
		t.Errorf("got %s", out)
	}
	if o.Has("id") {
		t.Error("Has still reports the deleted key")
	}
	o.Delete("nosuchkey") // must be a no-op, not a panic
}

func TestValuesIsObjectValues(t *testing.T) {
	o, _ := Parse([]byte(`{"e1":{"address":"a@b"},"e2":{"address":"c@d"},"junk":"str","n":null,"arr":[1]}`))
	vals := o.Values()
	// `v !== null && typeof v === "object"` keeps objects AND arrays, drops
	// strings and null. An array reaches a property access as undefined, which is
	// what an empty Object reads back as.
	if len(vals) != 3 {
		t.Fatalf("len = %d, want 3 (two objects + one array)", len(vals))
	}
	if got := vals[0].StrOr("address", ""); got != "a@b" {
		t.Errorf("first = %q", got)
	}
	if got := vals[1].StrOr("address", ""); got != "c@d" {
		t.Errorf("second = %q", got)
	}
	if vals[2].Len() != 0 {
		t.Errorf("an array member must read as having no properties")
	}
}

func TestNilReceiverIsSafe(t *testing.T) {
	// `card.Obj("emails")` on a card with no emails is nil, and every caller
	// chains straight into it rather than guarding — the JS `?.` shape.
	var o *Object
	if o.Len() != 0 || o.Keys() != nil || o.Values() != nil || o.Has("x") || o.Bool("x") {
		t.Error("a nil object must read as empty")
	}
	if got := o.StrOr("x", "fallback"); got != "fallback" {
		t.Errorf("StrOr = %q", got)
	}
}

func TestJSStringOfMatchesStringCoercion(t *testing.T) {
	cases := []struct{ in, want string }{
		{`"hi"`, "hi"},
		{`5`, "5"},
		{`2.5`, "2.5"},
		{`true`, "true"},
		{`null`, "null"},
		{`{"a":1}`, "[object Object]"},
		{`[1,2]`, "1,2"},
	}
	for _, c := range cases {
		if got := JSStringOf(json.RawMessage(c.in)); got != c.want {
			t.Errorf("JSStringOf(%s) = %q, want %q", c.in, got, c.want)
		}
	}
	o, _ := Parse([]byte(`{"present":"p","nulled":null}`))
	if got := o.JSString("absent"); got != "undefined" {
		t.Errorf("an absent key coerces to %q, want \"undefined\"", got)
	}
	// `??` is NULLISH, so an explicit null takes the fallback too.
	if got := o.JSStringOr("nulled", "fb"); got != "fb" {
		t.Errorf("JSStringOr(null) = %q, want the fallback", got)
	}
	if got := o.JSStringOr("present", "fb"); got != "p" {
		t.Errorf("JSStringOr = %q", got)
	}
}

// TestMarshalDoesNotEscapeHTML — JSON.stringify leaves `<`, `>` and `&` alone;
// encoding/json escapes them by default, which would make every card carrying an
// HTML-ish note differ between the two implementations.
func TestMarshalDoesNotEscapeHTML(t *testing.T) {
	raw, err := Marshal("a<b&c>d")
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `"a<b&c>d"` {
		t.Errorf("got %s", raw)
	}
}

// TestIndent2MatchesJSONStringifyWithTwo — the human rendering of
// `contacts show`, which is `JSON.stringify(card, null, 2)`.
func TestIndent2MatchesJSONStringifyWithTwo(t *testing.T) {
	got, err := Indent2([]byte(`{"id":"x","o":{"k":1},"e":{},"a":[],"l":[1,2]}`))
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"id\": \"x\",\n  \"o\": {\n    \"k\": 1\n  },\n  \"e\": {},\n  \"a\": [],\n  \"l\": [\n    1,\n    2\n  ]\n}"
	if got != want {
		t.Errorf("got\n%q\nwant\n%q", got, want)
	}
}

func TestParseRefusesANonObject(t *testing.T) {
	for _, in := range []string{`[1,2]`, `"str"`, `null`, `3`} {
		if _, err := Parse([]byte(in)); err == nil {
			t.Errorf("Parse(%s) must fail — a card is an object", in)
		} else if !IsNotObject(err) && in != `3` && in != `"str"` && in != `null` {
			t.Errorf("Parse(%s) = %v", in, err)
		}
	}
}

func TestPairsKeepsInsertionOrder(t *testing.T) {
	// The vCard parameter multimap: its order reaches the wire through the
	// RFC 9555 vCardProps fallback (`Object.entries(p.params)`).
	p := NewPairs()
	p.Append("type", "WORK")
	p.Append("pref", "1")
	p.Append("type", "VOICE")
	if got := strings.Join(p.Keys(), ","); got != "type,pref" {
		t.Errorf("keys = %s", got)
	}
	if got := strings.Join(p.Get("type"), ","); got != "WORK,VOICE" {
		t.Errorf("type = %s, want both values under one key", got)
	}
	if v, ok := p.First("pref"); !ok || v != "1" {
		t.Errorf("First(pref) = %q, %v", v, ok)
	}
	if _, ok := p.First("absent"); ok {
		t.Error("First on an absent key must report absence")
	}
}
