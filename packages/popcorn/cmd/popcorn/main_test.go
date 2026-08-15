package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

// The package documentation states the defaults as a contract:
//
//	POPCORN_DELE_MODE  archive (default) | noop — popcorn NEVER destroys
//
// "archive by default" is half of that promise and it lives entirely in this
// one envOr call: pop3's QUIT treats every value except "noop" as archive, so
// an unset variable that fell through to "" would still archive — but a typo'd
// fallback, or a fallback of "noop", would silently turn DELE into a no-op for
// every deployment that never set the variable. Nothing else in the system
// would notice; mail would simply stop being filed.
//
// t.Setenv restores the environment when each test ends, so this reads the real
// os.Getenv path without leaving anything behind for the rest of the run.
func TestDeleModeDefaultsToArchive(t *testing.T) {
	if got := envOr("POPCORN_DELE_MODE", "archive"); got != "archive" {
		t.Fatalf("unset POPCORN_DELE_MODE → %q, want archive", got)
	}
	t.Setenv("POPCORN_DELE_MODE", "noop")
	if got := envOr("POPCORN_DELE_MODE", "archive"); got != "noop" {
		t.Fatalf("POPCORN_DELE_MODE=noop → %q", got)
	}
	// An empty value is an unset value. An operator who writes
	// `POPCORN_DELE_MODE=` in a unit file gets the safe mode, not "".
	t.Setenv("POPCORN_DELE_MODE", "")
	if got := envOr("POPCORN_DELE_MODE", "archive"); got != "archive" {
		t.Fatalf("empty POPCORN_DELE_MODE → %q, want the default", got)
	}
}

// The test above proves envOr honours whatever fallback it is handed; it says
// nothing about which fallback main() hands it, and that is where the promise
// actually lives. Changing "archive" to "noop" in the config literal passes
// every other test in this module — DELE keeps replying +OK, QUIT keeps
// signing off, and mail quietly stops being filed.
//
// So this reads the source, the same mechanism and the same justification as
// cli-go/internal/delegate/argv_test.go's drift check on the TypeScript: it is
// ugly, and it is the only thing that fails when someone edits that one string.
// It also pins the doc comment, because "archive (default)" is the sentence
// operators actually read.
func TestTheArchiveDefaultIsWiredIntoMain(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}

	// Matches `DeleMode:    envOr("POPCORN_DELE_MODE", "archive"),`
	wiring := regexp.MustCompile(`envOr\("POPCORN_DELE_MODE",\s*"([^"]*)"\)`).FindSubmatch(src)
	if wiring == nil {
		t.Fatal("main.go no longer builds DeleMode from POPCORN_DELE_MODE with a literal default")
	}
	if got := string(wiring[1]); got != "archive" {
		t.Errorf("main() defaults POPCORN_DELE_MODE to %q, want \"archive\" — DELE would stop filing mail for every deployment that never set the variable", got)
	}

	if !strings.Contains(string(src), "archive (default) | noop — popcorn NEVER destroys") {
		t.Error("the documented POPCORN_DELE_MODE contract changed; the tests in internal/pop3 enforce the old wording's promise")
	}
}

// Every numeric setting here is a bound on something that costs memory or
// keeps a connection alive. A value that parses to zero or a negative — from a
// typo, an unexpanded shell variable, a stray quote — must fall back rather
// than be honoured: MaxMessages 0 is an empty maildrop, and IdleTimeout 0 is a
// read deadline of "now", which disconnects every client immediately.
func TestBadNumericSettingsFallBackInsteadOfDisablingTheBound(t *testing.T) {
	for _, tc := range []struct {
		name, value string
		want        int
	}{
		{"a real value is used", "500", 500},
		{"zero is not a maildrop size", "0", 200},
		{"negative is not a maildrop size", "-1", 200},
		{"unparseable", "lots", 200},
		{"empty", "", 200},
		{"an unexpanded shell variable", "$MAX", 200},
		{"whitespace is not trimmed for us", " 500 ", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("POPCORN_MAX_MESSAGES", tc.value)
			if got := envInt("POPCORN_MAX_MESSAGES", 200); got != tc.want {
				t.Errorf("POPCORN_MAX_MESSAGES=%q → %d, want %d", tc.value, got, tc.want)
			}
		})
	}

	for _, tc := range []struct {
		name, value string
		want        time.Duration
	}{
		{"a real duration is used", "10m", 10 * time.Minute},
		{"seconds", "90s", 90 * time.Second},
		{"zero would disconnect every client on arrival", "0", 5 * time.Minute},
		{"negative", "-5m", 5 * time.Minute},
		{"a bare number is not a duration", "300", 5 * time.Minute},
		{"unparseable", "forever", 5 * time.Minute},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("POPCORN_IDLE_TIMEOUT", tc.value)
			if got := envDuration("POPCORN_IDLE_TIMEOUT", 5*time.Minute); got != tc.want {
				t.Errorf("POPCORN_IDLE_TIMEOUT=%q → %v, want %v", tc.value, got, tc.want)
			}
		})
	}
}
