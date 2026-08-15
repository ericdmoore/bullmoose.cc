package help

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// TestUnenrichedRoundTripIsByteIdentical is what licenses `help --json` to stop
// being a replay.
//
// Everything else in this package prints Node's captured bytes, so byte-identity
// is structural. The JSON mode now decodes those bytes, adds fields and
// re-encodes them, which is a SECOND RENDERER — the exact thing the package
// header explains was not worth porting. It is worth it here only because it can
// be proved equivalent: decode the captured spec, encode it with nothing
// derived, and the bytes must come back identical. Key order, indentation,
// escaping of `<`, `&` and every em dash in the notes are all pinned by this one
// comparison.
//
// If it fails, the spec upstream grew a shape spec.go does not model. That is
// not a formatting nit: an unmodelled field is DROPPED on decode, so the
// enriched output would be missing data an agent was reading. Structured()
// refuses to enrich in that case and Serve falls back to the captured bytes, so
// the CLI stays correct — this test is the thing that says so out loud.
func TestUnenrichedRoundTripIsByteIdentical(t *testing.T) {
	raw := load().entries["json"].stdout
	if raw == "" {
		t.Fatalf("no --json entry in the artifact\n    fix: %s", Regenerate)
	}

	var spec Spec
	if err := json.Unmarshal([]byte(raw), &spec); err != nil {
		t.Fatalf("the captured `help --json` is not JSON: %v", err)
	}
	got, err := encodeSpec(spec)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if got == raw {
		return
	}
	at := firstDiff(raw, got)
	t.Errorf("re-encoding the captured spec does not reproduce it (%dB vs %dB) — "+
		"internal/help/spec.go no longer models the shape of %s, so a field would be "+
		"dropped from `help --json`.\n    first difference at byte %d:\n      want: %s\n      got:  %s\n"+
		"    fix: teach Spec/Command/Flag the new field (and %s if the spec moved)",
		len(got), len(raw), SpecPath, at, around(raw, at), around(got, at), Regenerate)
}

// TestStructuredIsEnriched pins the fallback the test above describes: in a
// healthy tree the derived surface is actually present. A silently degraded
// `help --json` — correct, but no longer a tool schema — would otherwise look
// exactly like a healthy one.
func TestStructuredIsEnriched(t *testing.T) {
	spec, ok := Structured()
	if !ok {
		t.Fatalf("Structured() refused to enrich — `help --json` is falling back to the "+
			"captured bytes and carries no argument structure at all\n    fix: %s", Regenerate)
	}
	if spec.ArgSpecVersion != ArgSpecVersion {
		t.Errorf("argSpecVersion = %d, want %d", spec.ArgSpecVersion, ArgSpecVersion)
	}
	if len(spec.Options) == 0 {
		t.Error("the global options were not structured")
	}
	for _, c := range spec.Commands {
		if len(c.Flags) > 0 && len(c.Options) == 0 {
			t.Errorf("%s documents %d flags but derived none", c.Name, len(c.Flags))
		}
		for _, sc := range c.Subcommands {
			if len(c.Subcommands) > 0 && len(c.Arguments) != 1 {
				t.Errorf("%s has subcommands, so its first argument should be the verb", c.Name)
			}
			_ = sc
		}
	}
}

// TestServeJSONIsASupersetOfTheCapture is the guarantee the enrichment owes the
// other side: every byte of meaning in the captured spec is still there. It
// compares DECODED values rather than bytes, because the bytes are exactly what
// changed — but nothing an agent could read before may be missing or altered.
func TestServeJSONIsASupersetOfTheCapture(t *testing.T) {
	var out, errb bytes.Buffer
	if code := Serve(bmio.NewTo(&out, &errb), Request{Mode: JSON}); code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	if errb.Len() != 0 {
		t.Errorf("`help --json` wrote %dB to stderr; the spec is a record (§1.1)", errb.Len())
	}

	var got, want any
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("what Serve printed is not JSON: %v", err)
	}
	if err := json.Unmarshal([]byte(load().entries["json"].stdout), &want); err != nil {
		t.Fatalf("the captured spec is not JSON: %v", err)
	}
	if missing := subsetDiff(want, got, "$"); missing != "" {
		t.Errorf("the enriched spec is not a superset of the captured one: %s", missing)
	}
}

// subsetDiff reports the first place `want` is not contained in `got`, so an
// enrichment that renamed, reordered or dropped an upstream field is named
// rather than merely counted.
func subsetDiff(want, got any, path string) string {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return path + ": object became " + typeName(got)
		}
		for k, wv := range w {
			gv, ok := g[k]
			if !ok {
				return path + "." + k + ": missing"
			}
			if d := subsetDiff(wv, gv, path+"."+k); d != "" {
				return d
			}
		}
	case []any:
		g, ok := got.([]any)
		if !ok {
			return path + ": array became " + typeName(got)
		}
		if len(g) != len(w) {
			return path + ": length changed"
		}
		for i := range w {
			if d := subsetDiff(w[i], g[i], path+"["+itoa(i)+"]"); d != "" {
				return d
			}
		}
	default:
		if want != got {
			return path + ": value changed"
		}
	}
	return ""
}

func typeName(v any) string {
	switch v.(type) {
	case map[string]any:
		return "object"
	case []any:
		return "array"
	case nil:
		return "null"
	}
	return "scalar"
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for ; i > 0; i /= 10 {
		b = append([]byte{byte('0' + i%10)}, b...)
	}
	return string(b)
}

func firstDiff(a, b string) int {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			return i
		}
	}
	return n
}

func around(s string, at int) string {
	lo := at - 60
	if lo < 0 {
		lo = 0
	}
	hi := at + 60
	if hi > len(s) {
		hi = len(s)
	}
	return strings.ReplaceAll(s[lo:hi], "\n", "⏎")
}
