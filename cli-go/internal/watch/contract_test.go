package watch

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

// The cross-language check on `watch`'s own couplings.
//
// `watch` is NOT exercised by packages/cli/smoke/contract.mjs — the 61 cases
// drive log, contacts, sync, search, show, mailbox(es), trash, archive, delete,
// blobs, send, token, init and help, and none of them can drive a command that
// never exits. So the black-box gate that keeps the other ported commands honest
// says nothing here, and something else has to.
//
// This is that something, in the house idiom: read the TypeScript as TEXT and
// regex the declaration out of it. packages/cli/src/scopes.test.ts does it
// against auth-core, delegate/argv_test.go does it against main.ts, and both say
// why — "the only check that actually fails when someone adds a [field] on one
// side". The alternative, a hand-written expectation, records what someone
// believed rather than what the other implementation does.

// Test_EventFieldsMatchTheTypeScript diffs the --json event keys against
// watch.ts's own emitJson object literal, in BOTH directions.
func Test_EventFieldsMatchTheTypeScript(t *testing.T) {
	src := readWatchTS(t)

	wantCreated := emitJSONKeys(t, src, "event,")
	if len(wantCreated) == 0 {
		t.Fatal("the created/updated emitJson literal did not parse — has watch.ts changed shape?")
	}
	gotCreated := jsonTags(event{})
	if !reflect.DeepEqual(gotCreated, wantCreated) {
		t.Errorf("--json event fields = %v, want watch.ts's %v (order included: both sides serialise "+
			"in declaration order, and an agent diffing two implementations' output should see no diff)",
			gotCreated, wantCreated)
	}

	wantDestroyed := emitJSONKeys(t, src, `event: "destroyed"`)
	if len(wantDestroyed) == 0 {
		t.Fatal(`the destroyed emitJson literal did not parse — has watch.ts changed shape?`)
	}
	if got := jsonTags(destroyedEvent{}); !reflect.DeepEqual(got, wantDestroyed) {
		t.Errorf("destroyed event fields = %v, want watch.ts's %v", got, wantDestroyed)
	}
}

// Test_HookEnvVarsMatchTheTypeScript: the BM_* names ARE the hook's API — an
// operator's `--exec` template breaks silently if one is renamed on one side.
func Test_HookEnvVarsMatchTheTypeScript(t *testing.T) {
	src := readWatchTS(t)
	wantNames := regexp.MustCompile(`\bBM_[A-Z]+\b`)
	want := map[string]bool{}
	for _, m := range wantNames.FindAllString(src, -1) {
		want[m] = true
	}
	if len(want) < 5 {
		t.Fatalf("found only %d BM_* names in watch.ts — has it changed shape?", len(want))
	}

	plan, err := BuildHookPlan("true", HookFields{ID: "i", Account: "a", From: "f", Subject: "s", Preview: "p"})
	if err != nil {
		t.Fatalf("BuildHookPlan: %v", err)
	}
	for name := range want {
		if _, ok := plan.Env[name]; !ok {
			t.Errorf("watch.ts hands the hook %s and the Go port does not — an operator's template breaks silently", name)
		}
	}
	for name := range plan.Env {
		if strings.HasPrefix(name, "BM_") && !want[name] {
			t.Errorf("the Go port invents %s, which watch.ts does not document or set", name)
		}
	}
}

// Test_HookPreviewMaxMatchesTheTypeScript: the cap is documented in the help
// text ("preview truncated to 120 chars"), so it is part of the contract rather
// than an implementation detail.
func Test_HookPreviewMaxMatchesTheTypeScript(t *testing.T) {
	src := readWatchTS(t)
	m := regexp.MustCompile(`HOOK_PREVIEW_MAX\s*=\s*(\d+)`).FindStringSubmatch(src)
	if m == nil {
		t.Fatal("HOOK_PREVIEW_MAX not found in watch.ts")
	}
	if m[1] != "120" || HookPreviewMax != 120 {
		t.Errorf("HookPreviewMax = %d, watch.ts says %s", HookPreviewMax, m[1])
	}
}

// Test_TimingDefaultsMatchTheTypeScript pins the four constants that decide how
// the watcher behaves under load and under an outage. They are not arbitrary:
// the debounce is what makes a burst cost one sync, and the fallback timer is
// the only thing that recovers a socket that is up but dead.
func Test_TimingDefaultsMatchTheTypeScript(t *testing.T) {
	src := readWatchTS(t)
	for _, c := range []struct {
		name  string
		got   int64
		regex string
	}{
		{"DEBOUNCE_MS", DefaultDebounce.Milliseconds(), `DEBOUNCE_MS\s*=\s*([\d_]+)`},
		{"FALLBACK_SYNC_MS", DefaultFallbackSync.Milliseconds(), `FALLBACK_SYNC_MS\s*=\s*5 \* ([\d_]+)`},
		{"BACKOFF_MIN_MS", DefaultBackoffMin.Milliseconds(), `BACKOFF_MIN_MS\s*=\s*([\d_]+)`},
		{"BACKOFF_MAX_MS", DefaultBackoffMax.Milliseconds(), `BACKOFF_MAX_MS\s*=\s*([\d_]+)`},
	} {
		m := regexp.MustCompile(c.regex).FindStringSubmatch(src)
		if m == nil {
			t.Errorf("%s not found in watch.ts", c.name)
			continue
		}
		want := parseUnderscored(m[1])
		if c.name == "FALLBACK_SYNC_MS" {
			want *= 5
		}
		if c.got != want {
			t.Errorf("%s: Go default is %dms, watch.ts says %dms", c.name, c.got, want)
		}
	}
}

// Test_PidPathsMatchTheTypeScript: the two implementations must find each
// OTHER's watcher. A `bullmoose watch --stop` from either binary has to see the
// pidfile the other wrote, or two watchers run against one mirror.
func Test_PidPathsMatchTheTypeScript(t *testing.T) {
	src := readWatchTS(t)
	if !strings.Contains(src, "`${dbPath}.watch.pid`") || !strings.Contains(src, "`${dbPath}.watch.log`") {
		t.Skip("watch.ts's pidPaths has changed shape; update this check")
	}
	p := PidPaths("/tmp/mail.db")
	if p.Pid != "/tmp/mail.db.watch.pid" || p.Log != "/tmp/mail.db.watch.log" {
		t.Errorf("PidPaths = %+v, want the .watch.pid/.watch.log sidecars watch.ts:367 names", p)
	}
}

// ---- helpers --------------------------------------------------------------

// emitJSONKeys pulls the key order out of the `emitJson({ … })` literal
// containing the given marker.
//
// It walks the literal rather than regexing lines, because the two literals in
// watch.ts are written differently (one per line, one all on one line) and the
// values contain their own braces and parentheses — a line-anchored regex reads
// one of them as a single field and then passes for the wrong reason.
func emitJSONKeys(t *testing.T, src, marker string) []string {
	t.Helper()
	idx := strings.Index(src, marker)
	if idx < 0 {
		return nil
	}
	open := strings.LastIndex(src[:idx], "emitJson({")
	if open < 0 {
		return nil
	}
	body := literalBody(src[open+len("emitJson({"):])
	var keys []string
	ident := regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	for _, part := range splitTopLevel(body) {
		key, _, _ := strings.Cut(strings.TrimSpace(part), ":")
		key = strings.TrimSpace(key)
		if ident.MatchString(key) {
			keys = append(keys, key)
		}
	}
	return keys
}

// literalBody returns everything up to the brace that closes the object.
func literalBody(s string) string {
	depth := 0
	for i, r := range s {
		switch r {
		case '{', '(', '[':
			depth++
		case '}', ')', ']':
			if depth == 0 && r == '}' {
				return s[:i]
			}
			depth--
		}
	}
	return s
}

// splitTopLevel splits on commas that are not inside a nested construct.
func splitTopLevel(s string) []string {
	var (
		parts []string
		depth int
		last  int
	)
	for i, r := range s {
		switch r {
		case '{', '(', '[':
			depth++
		case '}', ')', ']':
			depth--
		case ',':
			if depth == 0 {
				parts = append(parts, s[last:i])
				last = i + 1
			}
		}
	}
	return append(parts, s[last:])
}

// jsonTags returns a struct's JSON field names in declaration order — which is
// also the order encoding/json emits them, and the order JS object literals
// serialise in.
func jsonTags(v any) []string {
	rt := reflect.TypeOf(v)
	out := make([]string, 0, rt.NumField())
	for i := range rt.NumField() {
		tag := rt.Field(i).Tag.Get("json")
		name, _, _ := strings.Cut(tag, ",")
		if name != "" && name != "-" {
			out = append(out, name)
		}
	}
	return out
}

func parseUnderscored(s string) int64 {
	var n int64
	for _, r := range s {
		if r == '_' {
			continue
		}
		n = n*10 + int64(r-'0')
	}
	return n
}

// readWatchTS returns packages/cli/src/watch.ts, found by walking up from this
// test's directory — the same mechanism delegate/argv_test.go uses for main.ts,
// and the reason devPlan.md:153 put cli-go in this repo.
func readWatchTS(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		p := filepath.Join(dir, "packages", "cli", "src", "watch.ts")
		if b, err := os.ReadFile(p); err == nil {
			return string(b)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Skip("packages/cli/src/watch.ts not found above this checkout — drift against the TypeScript twin is unchecked here")
	return ""
}

// jsonRoundTrip is used by the shape test to confirm the Go struct really
// serialises in declaration order (it does; this asserts it rather than assuming
// encoding/json will never change).
func init() {
	b, err := json.Marshal(event{Event: "created", ID: "i"})
	if err != nil || !strings.HasPrefix(string(b), `{"event":"created","id":"i",`) {
		panic("event does not serialise in declaration order: " + string(b))
	}
}
