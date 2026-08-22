package cmd

import (
	"context"
	"strings"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/discover"
	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

type fakeFinder struct {
	result discover.Result
	err    error
	asked  string
}

func (f *fakeFinder) Resolve(_ context.Context, email string) (discover.Result, error) {
	f.asked = email
	return f.result, f.err
}

func runDisc(t *testing.T, finder *fakeFinder, argv ...string) (string, string, int) {
	t.Helper()
	var out, errOut strings.Builder
	s := bmio.NewTo(&out, &errOut)
	code := runDiscoverWith(s, argv, discoverDeps{resolver: finder})
	return out.String(), errOut.String(), code
}

func TestDiscover_RendersTheLadder(t *testing.T) {
	finder := &fakeFinder{result: discover.Result{
		Domain: "b.test", Via: "fallback", Base: "https://mail.b.test",
	}}
	out, _, code := runDisc(t, finder, "discover", "someone@b.test")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	for _, want := range []string{"domain:  b.test", "no SRV record — well-known fallback",
		"base:    https://mail.b.test", "session: ✓"} {
		if !strings.Contains(out, want) {
			t.Errorf("stdout %q missing %q", out, want)
		}
	}
}

func TestDiscover_BareDomainProbesSynthetically(t *testing.T) {
	// `discover b.test` and `discover x@b.test` must resolve identically —
	// discovery only reads the part after the @.
	finder := &fakeFinder{result: discover.Result{Domain: "b.test", Via: "srv", Base: "https://m.b.test"}}
	_, _, code := runDisc(t, finder, "discover", "b.test")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if finder.asked != "probe@b.test" {
		t.Errorf("asked = %q, want the synthetic probe address", finder.asked)
	}
}

func TestDiscover_RedirectIsNeverSilent(t *testing.T) {
	// A base nobody typed must say where it came from — login.go's rule,
	// applied to the surface whose whole job is showing the resolution.
	finder := &fakeFinder{result: discover.Result{
		Domain: "b.test", Via: "srv", Base: "https://real.b.test", RedirectedFrom: "https://typed.b.test",
	}}
	out, _, _ := runDisc(t, finder, "discover", "b.test")
	if !strings.Contains(out, "typed.b.test redirected") {
		t.Errorf("the redirect origin is silent: %q", out)
	}
}

func TestDiscover_NoTargetRefusesWithoutResolving(t *testing.T) {
	finder := &fakeFinder{}
	_, errOut, code := runDisc(t, finder, "discover")
	if code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if finder.asked != "" {
		t.Error("a refusal must not resolve anything")
	}
	if !strings.Contains(errOut, "email-or-domain") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestDiscover_FailureCarriesTheTriedList(t *testing.T) {
	finder := &fakeFinder{err: bmio.NotFound("no JMAP server found for b.test. Tried:\n  …")}
	_, errOut, code := runDisc(t, finder, "discover", "b.test")
	if code == 0 {
		t.Fatal("a failed discovery must exit nonzero")
	}
	if !strings.Contains(errOut, "Tried:") {
		t.Errorf("the tried-list must reach the human: %q", errOut)
	}
}
