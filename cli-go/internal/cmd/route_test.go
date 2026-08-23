package cmd

// The front door's own tests — what survived of delegate/argv_test,
// help_test and native_test when the delegate died. The cases kept are the
// ones whose failure modes outlive the port: naming a flag's value as the
// command, the --status arity collision, help routed before any command, and
// the flag guard refusing (natively now) what it must never silently ignore.

import (
	"bytes"
	"strings"
	"testing"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

func TestCommandOf(t *testing.T) {
	for _, tc := range []struct {
		argv []string
		want string
	}{
		{[]string{"log", "-n", "5", "--json"}, "log"},
		// The value-flag rule this scanner exists for: `--db /tmp/x log`
		// names `log`, not `/tmp/x`.
		{[]string{"--db", "/tmp/x", "log"}, "log"},
		{[]string{"-n", "5", "log"}, "log"},
		{[]string{"--json", "accounts"}, "accounts"},
		{[]string{}, ""},
		{[]string{"--help"}, ""},
		{[]string{"--", "--json"}, "--json"},
		{[]string{"-"}, "-"},
	} {
		if got := commandOf(tc.argv); got != tc.want {
			t.Errorf("commandOf(%v) = %q, want %q", tc.argv, got, tc.want)
		}
	}
}

// The --status collision, pinned so it stays a DECISION rather than an
// oversight: its arity depends on the command (approvals: value; watch:
// boolean), and this scanner runs before the command is known. Both work
// AFTER their command, where the command's own parser owns the grammar; the
// pre-command position deliberately does not, and "fixing" one side must
// confront the other here.
func TestStatusArityCollisionStaysDecided(t *testing.T) {
	if valueFlags["status"] {
		t.Fatal("--status must not join valueFlags: `bullmoose --status watch` would swallow `watch`")
	}
	if !booleanFlags["status"] {
		t.Fatal("--status left booleanFlags: `watch --status` before the command would now be an unknown flag")
	}
}

func TestHelpRequestRouting(t *testing.T) {
	for _, tc := range []struct {
		argv   []string
		isHelp bool
		topic  string
	}{
		{[]string{"help"}, true, ""},
		{[]string{"--help"}, true, ""},
		{[]string{"log", "--help"}, true, "log"},
		{[]string{"help", "log"}, true, "log"},
		// `bullmoose help --help` is the OVERVIEW: no second positional.
		{[]string{"help", "--help"}, true, ""},
		// No command at all is a help invocation (the overview, exit 2).
		{[]string{}, true, ""},
		{[]string{"--json"}, true, ""},
		// An ordinary invocation is not.
		{[]string{"log", "-n", "5"}, false, ""},
		// A parse refusal outranks help: the refusal is the answer.
		{[]string{"--no-such-flag", "--help"}, false, ""},
	} {
		req, ok := helpRequest(tc.argv)
		if ok != tc.isHelp {
			t.Errorf("helpRequest(%v) ok = %v, want %v", tc.argv, ok, tc.isHelp)
			continue
		}
		if ok && req.Topic != tc.topic {
			t.Errorf("helpRequest(%v) topic = %q, want %q", tc.argv, req.Topic, tc.topic)
		}
	}
}

func TestTakesNextToken(t *testing.T) {
	for _, tc := range []struct {
		argv []string
		want bool
	}{
		{[]string{"--sort"}, false},            // argument missing
		{[]string{"--sort", "-1"}, false},      // ambiguous: looks like a flag
		{[]string{"--sort", "1"}, true},        //
		{[]string{"--parent", "-"}, true},      // bare "-" IS a legal value (top level)
		{[]string{"--file", "--other"}, false}, //
		{[]string{"--file", "some.txt"}, true}, //
	} {
		if got := takesNextToken(tc.argv, 0); got != tc.want {
			t.Errorf("takesNextToken(%v) = %v, want %v", tc.argv, got, tc.want)
		}
	}
}

// routeCap drives routeTo against captured streams.
func routeCap(t *testing.T, argv ...string) (string, string, int) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := routeTo(bmio.NewTo(&out, &errOut), argv)
	return out.String(), errOut.String(), code
}

func TestRoute_UnknownFlagIsANativeRefusal(t *testing.T) {
	// §1.5's case, post-Node: exit 2, the flag NAMED, no stack — and the
	// refusal is now this binary's own sentence rather than a delegation to
	// parse_args.js. The guard's premise is unchanged: never run a command
	// that silently ignores a flag the user typed.
	_, errOut, code := routeCap(t, "log", "--no-such-flag")
	if code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if !strings.Contains(errOut, "--no-such-flag") {
		t.Errorf("the offending flag must be named: %q", errOut)
	}
	if strings.Contains(errOut, "goroutine") || strings.Contains(errOut, "panic") {
		t.Errorf("a refusal is not a crash: %q", errOut)
	}

	// A flag that EXISTS globally but is not the command's: same refusal,
	// naming the command whose help explains it.
	_, errOut2, code2 := routeCap(t, "repoint", "--account", "x")
	if code2 != 2 || !strings.Contains(errOut2, "--account") || !strings.Contains(errOut2, "repoint") {
		t.Errorf("code %d stderr %q", code2, errOut2)
	}
}

func TestRoute_ParseRefusalsAreNamed(t *testing.T) {
	for _, tc := range []struct {
		argv []string
		want string
	}{
		{[]string{"log", "--db"}, "needs a value"},
		{[]string{"--json=yes", "log"}, "does not take a value"},
		{[]string{"log", "-x"}, "unknown option '-x'"},
	} {
		_, errOut, code := routeCap(t, tc.argv...)
		if code != 2 {
			t.Errorf("%v: code = %d, want 2 (%q)", tc.argv, code, errOut)
			continue
		}
		if !strings.Contains(errOut, tc.want) {
			t.Errorf("%v: stderr = %q, want %q", tc.argv, errOut, tc.want)
		}
	}
}

func TestRoute_UnknownCommandRendersFromTheSpec(t *testing.T) {
	_, errOut, code := routeCap(t, "nosuchcommand")
	if code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if !strings.Contains(errOut, "nosuchcommand") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestRoute_HelpBeforeAnyCommand(t *testing.T) {
	// `log --help` must reach the artifact, not runLog — a native command
	// does not know the flag.
	out, _, code := routeCap(t, "log", "--help")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(out, "log") {
		t.Errorf("help page missing: %q", out)
	}
}

func TestRoute_GoNativeAnswersItsOwnHelp(t *testing.T) {
	// `version` has no page in the artifact; Route hands it the argv whole
	// rather than telling the user it does not exist.
	out, _, code := routeCap(t, "version")
	if code != 0 || !strings.Contains(out, "bullmoose ") {
		t.Errorf("code %d out %q", code, out)
	}
}
