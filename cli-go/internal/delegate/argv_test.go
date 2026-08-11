package delegate

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

func TestCommand(t *testing.T) {
	cases := []struct {
		argv []string
		want string
	}{
		{nil, ""},
		{[]string{}, ""},
		{[]string{"log"}, "log"},
		{[]string{"log", "-n", "5", "--json"}, "log"},
		{[]string{"mailbox", "rename", "A", "B"}, "mailbox"},

		// The reason this is not "the first token without a dash": parseArgs
		// consumes the value (packages/cli/src/main.ts:68).
		{[]string{"--db", "/tmp/mail.db", "mailboxes"}, "mailboxes"},
		{[]string{"--db=/tmp/mail.db", "mailboxes"}, "mailboxes"},
		{[]string{"-n", "5", "log"}, "log"},

		// Boolean flags consume nothing, so the command follows immediately.
		{[]string{"--json", "log"}, "log"},
		{[]string{"--dry-run", "--force", "mailbox", "rm", "X"}, "mailbox"},
		{[]string{"-h", "log"}, "log"},

		// No command at all — the Node CLI answers these with help
		// (packages/cli/src/main.ts:184).
		{[]string{"--help"}, ""},
		{[]string{"--json"}, ""},
		{[]string{"--db", "/tmp/mail.db"}, ""},

		// `--` ends option parsing; whatever follows is the positional.
		{[]string{"--", "log"}, "log"},
		{[]string{"--", "--json"}, "--json"},
		{[]string{"--"}, ""},

		// A bare `-` is stdin, not a flag (arch.md §1.4).
		{[]string{"contacts", "import", "-"}, "contacts"},

		// Unknown flags are the Node CLI's business to reject; the shim must
		// not stop at one, and must not treat it as the command.
		{[]string{"--no-such-flag", "log"}, "log"},
	}
	for _, c := range cases {
		if got := Command(c.argv); got != c.want {
			t.Errorf("Command(%q) = %q, want %q", c.argv, got, c.want)
		}
	}
}

// TestValueFlagsMatchTheTypeScript is the drift check on a hand-kept copy of
// another language's declaration.
//
// Same mechanism, and same justification, as packages/cli/src/scopes.test.ts:
// it reads auth-core's source as text and regex-parses it because nothing else
// "actually fails when someone adds a scope on one side". arch.md §5 says the
// cross-language couplings become generated artifacts; the parseArgs spec is
// not one of the three named there, so until it is, this is the check that
// notices.
func TestValueFlagsMatchTheTypeScript(t *testing.T) {
	src := readCliMain(t)

	// Matches `db: { type: "string" },` and `"dry-run": { type: "boolean", … },`
	// as they appear in packages/cli/src/main.ts:64-163.
	spec := regexp.MustCompile(`(?m)^\s+"?([A-Za-z-]+)"?:\s*\{\s*type:\s*"(string|boolean)"([^\n]*)`)
	short := regexp.MustCompile(`short:\s*"([A-Za-z])"`)

	wantValue := map[string]bool{}
	wantShort := map[string]bool{}
	booleans := 0
	for _, m := range spec.FindAllStringSubmatch(src, -1) {
		name, kind := m[1], m[2]
		if kind == "string" {
			wantValue[name] = true
		} else {
			booleans++
		}
		if s := short.FindStringSubmatch(m[3]); s != nil && kind == "string" {
			wantShort[s[1]] = true
		}
	}

	// A regex that silently stopped matching would make every assertion below
	// pass vacuously.
	if len(wantValue) < 50 || booleans < 15 {
		t.Fatalf("the parseArgs spec did not parse (%d string, %d boolean flags found) — has main.ts changed shape?",
			len(wantValue), booleans)
	}

	if missing := diff(wantValue, valueFlags); len(missing) > 0 {
		t.Errorf("valueFlags is missing %v — packages/cli/src/main.ts declares them `type: \"string\"`, so the token after each is a value and not the command", missing)
	}
	if extra := diff(valueFlags, wantValue); len(extra) > 0 {
		t.Errorf("valueFlags has %v, which packages/cli/src/main.ts no longer declares as `type: \"string\"`", extra)
	}
	if missing := diff(wantShort, shortValueFlags); len(missing) > 0 {
		t.Errorf("shortValueFlags is missing %v", missing)
	}
	if extra := diff(shortValueFlags, wantShort); len(extra) > 0 {
		t.Errorf("shortValueFlags has %v, no longer a value-taking short option", extra)
	}
}

// readCliMain returns packages/cli/src/main.ts, found by walking up from the
// test's own directory. `.plans/s08-go-cli/devPlan.md:153` decided cli-go lives
// in this repo precisely so cross-language checks like this are a file read.
func readCliMain(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range ancestors(dir) {
		p := filepath.Join(a, "packages", "cli", "src", "main.ts")
		if b, err := os.ReadFile(p); err == nil {
			return string(b)
		}
	}
	t.Skipf("packages/cli/src/main.ts not found above %s — drift against the TypeScript flag spec is unchecked in this checkout", dir)
	return ""
}

// diff returns the keys of a that are not in b.
func diff(a, b map[string]bool) []string {
	var out []string
	for k := range a {
		if !b[k] {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// Guards the trace format T3 counts (devPlan.md:77).
func TestTraceLine(t *testing.T) {
	if got, want := traceLine("delegated", "log"), "bullmoose: delegated log\n"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if got := traceLine("native", ""); !strings.Contains(got, "(none)") {
		t.Errorf("a command-less invocation should still trace: %q", got)
	}
}

func TestTraceEnabled(t *testing.T) {
	for _, v := range []string{"", "0", "false", "no", "off"} {
		if traceEnabled(v) {
			t.Errorf("%q should be off", v)
		}
	}
	for _, v := range []string{"1", "true", "yes", "2"} {
		if !traceEnabled(v) {
			t.Errorf("%q should be on", v)
		}
	}
}
