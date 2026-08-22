package cmd

import (
	"strings"
	"testing"
)

// vacation — the RFC 8621 singleton, under s42 rules: choreography exact,
// refusals free, and one new refusal the TypeScript did not have.

func TestVacation_StatusChoreography(t *testing.T) {
	f := newMailFake()
	f.vacation = `{"accountId":"a_you","list":[{"id":"singleton","isEnabled":true,"subject":"Away","toDate":"2026-09-01T00:00:00Z"}]}`
	out, _, code := runCmd(t, runVacation, sendEnv(t, f), "vacation", "status")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if got := strings.Join(f.names(), ","); got != "VacationResponse/get" {
		t.Fatalf("calls = %s", got)
	}
	for _, want := range []string{"ON", "subject: Away", "until: 2026-09-01"} {
		if !strings.Contains(out, want) {
			t.Errorf("stdout %q missing %q", out, want)
		}
	}
}

func TestVacation_BareCommandIsStatus(t *testing.T) {
	f := newMailFake()
	_, _, code := runCmd(t, runVacation, sendEnv(t, f), "vacation")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if got := strings.Join(f.names(), ","); got != "VacationResponse/get" {
		t.Fatalf("calls = %s", got)
	}
}

func TestVacation_OnSetsTheSingleton(t *testing.T) {
	f := newMailFake()
	out, _, code := runCmd(t, runVacation, sendEnv(t, f), "vacation", "on",
		"--subject", "Away", "--until", "2026-09-01")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	args := f.argsOf("VacationResponse/set")
	for _, want := range []string{`"isEnabled":true`, `"subject":"Away"`, `"toDate":"2026-09-01T00:00:00Z"`, `"singleton"`} {
		if !strings.Contains(args, want) {
			t.Errorf("set args %s missing %s", args, want)
		}
	}
	if !strings.Contains(out, "vacation ON") {
		t.Errorf("stdout = %q", out)
	}
}

func TestVacation_GarbageUntilRefusesBeforeAnyRequest(t *testing.T) {
	// THE s42-added refusal. The TypeScript passed `new Date(opts.until)`
	// straight through, so a typo'd date died mid-flight as a RangeError after
	// the session round trip. Parsing client-side makes it a usage error that
	// costs zero requests.
	f := newMailFake()
	_, errOut, code := runCmd(t, runVacation, sendEnv(t, f), "vacation", "on", "--until", "next tuesday")
	if code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if len(f.names()) != 0 {
		t.Fatalf("refusal must cost zero requests, got %v", f.names())
	}
	if !strings.Contains(errOut, "YYYY-MM-DD") {
		t.Errorf("the error should teach the accepted shapes: %q", errOut)
	}
}

func TestVacation_DryRunSetsNothing(t *testing.T) {
	f := newMailFake()
	_, errOut, code := runCmd(t, runVacation, sendEnv(t, f), "vacation", "off", "--dry-run")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if len(f.names()) != 0 {
		t.Fatalf("dry run must not call the server, got %v", f.names())
	}
	if !strings.Contains(errOut, "would set vacation OFF") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestVacation_UnknownVerbRefused(t *testing.T) {
	f := newMailFake()
	_, _, code := runCmd(t, runVacation, sendEnv(t, f), "vacation", "maybe")
	if code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if len(f.names()) != 0 {
		t.Fatalf("refusal must cost zero requests, got %v", f.names())
	}
}
