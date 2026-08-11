package bmio

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"testing"
)

// conformance/exit-codes.json (T1) is generated from the SAME TypeScript this
// package transcribes (io.ts:52 EXIT, :96 JMAP_EXIT). These tests make that
// committed vector the ORACLE for the Go mapping: if the two disagree, the build
// is red and names the offending key. That is the whole point of T1 — turning an
// import the compiler used to check into a file both languages read and both
// test against (arch.md §5) — and it mirrors infra/migrations.test.ts, which
// reads its data file and fails when code and data diverge.

// exitVector is the shape of conformance/exit-codes.json.
type exitVector struct {
	Exit             map[string]int `json:"exit"`
	JMAPType         map[string]int `json:"jmapType"`
	AbsentJMAPType   int            `json:"absentJmapType"`
	UnlistedJMAPType int            `json:"unlistedJmapType"`
}

// loadVector reads the committed vector. The path is derived from this file's
// own location (runtime.Caller), not the process cwd, so the test is robust to
// wherever `go test` is invoked from. cli-go/internal/io → repo root is three
// directories up, then conformance/.
func loadVector(t *testing.T) exitVector {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate this test file to find the conformance vector")
	}
	path := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "conformance", "exit-codes.json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading the conformance vector (%s): %v", path, err)
	}
	var v exitVector
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("parsing %s: %v", path, err)
	}
	return v
}

// exitConstantByName is how the vector names each EXIT member (io.ts:52).
var exitConstantByName = map[string]ExitCode{
	"OK":        ExitOK,
	"FAIL":      ExitFail,
	"USAGE":     ExitUsage,
	"NOT_FOUND": ExitNotFound,
	"AUTH":      ExitAuth,
	"CONFLICT":  ExitConflict,
}

// TestExitConstantsMatchVector pins the six §1.5 codes against the vector, and
// checks the sets are identical so a code added on one side alone is caught.
func TestExitConstantsMatchVector(t *testing.T) {
	v := loadVector(t)

	if len(v.Exit) != len(exitConstantByName) {
		t.Fatalf("EXIT has %d names in the vector, %d in Go: %v vs %v",
			len(v.Exit), len(exitConstantByName), keys(v.Exit), goExitNames())
	}
	for name, want := range v.Exit {
		got, known := exitConstantByName[name]
		if !known {
			t.Errorf("vector EXIT.%s = %d has no Go constant", name, want)
			continue
		}
		if int(got) != want {
			t.Errorf("EXIT.%s: Go has %d, vector has %d", name, int(got), want)
		}
	}
}

// TestJMAPExitMapMatchesVectorExactly is the map's oracle. It fails, naming the
// key, on any of: a Go entry the vector lacks, a vector entry Go lacks, or a
// value that differs. Mutate one entry in jmapExit (exit.go) and this bites.
func TestJMAPExitMapMatchesVectorExactly(t *testing.T) {
	v := loadVector(t)

	// Go → vector: every entry present with the same value.
	for typ, want := range jmapExit {
		got, ok := v.JMAPType[typ]
		if !ok {
			t.Errorf("jmapExit[%q] = %d exists in Go but not in the vector", typ, int(want))
			continue
		}
		if got != int(want) {
			t.Errorf("jmapExit[%q]: Go maps to %d, vector maps to %d", typ, int(want), got)
		}
	}
	// vector → Go: nothing in the vector is missing from the map.
	for typ, want := range v.JMAPType {
		if _, ok := jmapExit[typ]; !ok {
			t.Errorf("vector jmapType[%q] = %d is missing from the Go jmapExit map", typ, want)
		}
	}
	if len(jmapExit) != len(v.JMAPType) {
		t.Fatalf("JMAP_EXIT size: Go has %d entries, vector has %d", len(jmapExit), len(v.JMAPType))
	}
}

// TestUnlistedAndAbsentJMAPTypeFallToFail pins the fallback the vector captured
// precisely because a naive port gets it wrong (arch.md §5): an empty or
// unrecognised type must fall to 1, not to some default in the map.
func TestUnlistedAndAbsentJMAPTypeFallToFail(t *testing.T) {
	v := loadVector(t)

	if got := int(ExitCodeForJMAPType("")); got != v.AbsentJMAPType {
		t.Errorf("empty JMAP type: Go exits %d, vector says absentJmapType=%d", got, v.AbsentJMAPType)
	}
	if got := int(ExitCodeForJMAPType("noSuchJmapTypeExistsAnywhere")); got != v.UnlistedJMAPType {
		t.Errorf("unlisted JMAP type: Go exits %d, vector says unlistedJmapType=%d", got, v.UnlistedJMAPType)
	}
	// And the vector's own claim is that both are ExitFail — a guard against a
	// future vector that quietly changed the fallback.
	if v.AbsentJMAPType != int(ExitFail) || v.UnlistedJMAPType != int(ExitFail) {
		t.Errorf("the vector's fallbacks are no longer ExitFail: absent=%d unlisted=%d",
			v.AbsentJMAPType, v.UnlistedJMAPType)
	}
}

// TestExitCodeForHTTPStatus pins every branch of io.ts:144. This taxonomy is
// NOT in the T1 vector (arch.md §5 flagged it); re-derived in Go, this table is
// its complete oracle.
func TestExitCodeForHTTPStatus(t *testing.T) {
	cases := []struct {
		status int
		want   ExitCode
	}{
		{200, ExitFail}, // a 2xx is not a failure taxonomy input, but io.ts:149 falls through to FAIL
		{301, ExitFail},
		{400, ExitUsage},
		{401, ExitAuth},
		{403, ExitAuth},
		{404, ExitNotFound},
		{409, ExitConflict},
		{412, ExitConflict},
		{428, ExitConflict},
		{418, ExitUsage},
		{429, ExitUsage}, // HTTP taxonomy: any other 4xx is USAGE, distinct from JMAP rateLimit
		{499, ExitUsage},
		{500, ExitFail},
		{503, ExitFail},
	}
	for _, c := range cases {
		if got := ExitCodeForHTTPStatus(c.status); got != c.want {
			t.Errorf("ExitCodeForHTTPStatus(%d) = %d, want %d", c.status, int(got), int(c.want))
		}
	}
}

// TestExitCodeFor exercises the funnel's precedence (io.ts:177). The two that
// matter are the ones the contract suite drives (contract.mjs:254, :260): a
// known JMAP type wins, and an unrecognised type must NOT short-circuit past a
// perfectly good HTTP status beside it.
func TestExitCodeFor(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want ExitCode
	}{
		{"CliError carries its own code", Conflict("stale"), ExitConflict},
		{"Usage helper", Usage("bad flag"), ExitUsage},
		{"known JMAP type (mailboxHasEmail)", &ServerError{JMAPType: "mailboxHasEmail"}, ExitConflict},
		{"unknown type but 409 beside it (blobInUse)", &ServerError{JMAPType: "blobInUse", HTTPStatus: 409}, ExitConflict},
		{"a 500 nobody can fix", &ServerError{HTTPStatus: 500}, ExitFail},
		{"unknownMethod is usage", &ServerError{JMAPType: "unknownMethod"}, ExitUsage},
		{"unknown type, no status, falls to FAIL", &ServerError{JMAPType: "somethingNovel"}, ExitFail},
		{"a plain error is generic failure", errPlain("boom"), ExitFail},
		{"nil is generic failure", nil, ExitFail},
	}
	for _, c := range cases {
		if got := ExitCodeFor(c.err); got != c.want {
			t.Errorf("%s: ExitCodeFor = %d, want %d", c.name, int(got), int(c.want))
		}
	}
}

// ── small helpers ────────────────────────────────────────────────────────────

type errPlain string

func (e errPlain) Error() string { return string(e) }

func keys(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func goExitNames() []string {
	out := make([]string, 0, len(exitConstantByName))
	for k := range exitConstantByName {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
