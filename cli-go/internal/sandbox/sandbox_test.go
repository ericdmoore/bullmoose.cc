package sandbox

import (
	"context"
	"strings"
	"testing"
	"time"
)

// s44 slice 5. The PURE tests are the load-bearing ones: containment is the
// flags, so a test that could not read them would be testing nothing. They
// run everywhere, CI included. The integration tests below need a real
// runtime and skip honestly without one — but where one exists (alpaca has
// docker), they put the walls through their paces for real.

func TestArgs_ContainmentIsAlwaysPresent(t *testing.T) {
	got := strings.Join(Runtime{Name: "docker", Path: "/usr/bin/docker"}.Args(Spec{
		Image: "bullmoose/sandbox:pinned",
		Argv:  []string{"sqlite3", ":memory:", "select 1;"},
	}), " ")

	for _, want := range []string{
		"--network=none", // rule 2: no egress, absent rather than restricted
		"--read-only",    // the image is immutable
		"--tmpfs /work:", // only this takes writes, and it dies with the run
		"--memory 512m",  // the small default
		"--cpus 1",
		"--pids-limit 128",
		"--rm", // no corpse outlives the run
	} {
		if !strings.Contains(got, want) {
			t.Errorf("containment lost %q in: %s", want, got)
		}
	}
	// The image the DEFINITION names, and the argv the model steers.
	if !strings.Contains(got, "bullmoose/sandbox:pinned sqlite3 :memory: select 1;") {
		t.Errorf("image/argv: %s", got)
	}
}

func TestArgs_NothingOfTheHostCrosses(t *testing.T) {
	// Rule 1, asserted as an ABSENCE: no volume mounts, no env passthrough,
	// no privilege. A credential inside a container reading hostile data is
	// the failure this whole design exists to prevent.
	got := strings.Join(Runtime{Name: "podman"}.Args(Spec{Image: "img", Argv: []string{"true"}}), " ")
	for _, forbidden := range []string{"--privileged", "-v ", "--volume", "--env-file", "--net=host", "--network=host"} {
		if strings.Contains(got, forbidden) {
			t.Errorf("the boundary leaked %q: %s", forbidden, got)
		}
	}
	// The one --env is a HOME inside the tmpfs, not a passthrough.
	if strings.Count(got, "--env") != 1 || !strings.Contains(got, "--env HOME=/work") {
		t.Errorf("env surface: %s", got)
	}
}

func TestLimits_SmallByDefaultAndRaisableOnPurpose(t *testing.T) {
	d := Limits{}.withDefaults()
	if d.Wall != 20*time.Second || d.MemoryMB != 512 || d.PIDs != 128 || d.MaxOutputBytes != 64*1024 {
		t.Fatalf("the small defaults drifted: %+v", d)
	}
	// Raising one is a decision somebody makes; it must actually take.
	raised := Limits{Wall: time.Minute, MemoryMB: 2048}.withDefaults()
	if raised.Wall != time.Minute || raised.MemoryMB != 2048 || raised.CPUs != DefaultCPUs {
		t.Fatalf("explicit limits must win, unset ones keep the default: %+v", raised)
	}
}

func TestRun_RefusesWithoutARuntimeOrAnImage(t *testing.T) {
	if _, err := (Runtime{}).Run(context.Background(), Spec{Image: "x"}); err != ErrNoRuntime {
		t.Errorf("no runtime: %v", err)
	}
	_, err := Runtime{Name: "docker", Path: "/bin/true"}.Run(context.Background(), Spec{})
	if err == nil || !strings.Contains(err.Error(), "the tool definition names it") {
		t.Errorf("a model must never choose the image: %v", err)
	}
}

func TestFlavor_IsAFactNotABoolean(t *testing.T) {
	if got := (Runtime{Name: "docker"}).Flavor(); got != "oci" {
		t.Errorf("flavor = %q", got)
	}
	if got := (Runtime{}).Flavor(); got != "" {
		t.Errorf("a host with nothing declares nothing, got %q", got)
	}
}

// ---- integration: a real runtime, put through its paces --------------------

func realRuntime(t *testing.T) Runtime {
	t.Helper()
	r := Detect()
	if r.Name == "" {
		t.Skip("no container runtime on this host — the pure tests above still hold")
	}
	return r
}

const alpine = "alpine:3"

func TestIntegration_RunsAndReturnsOutput(t *testing.T) {
	if testing.Short() {
		t.Skip("short mode")
	}
	r := realRuntime(t)
	res, err := r.Run(context.Background(), Spec{
		Image: alpine, Argv: []string{"sh", "-c", "echo hello from the box"},
		Limits: Limits{Wall: 60 * time.Second},
	})
	if err != nil {
		t.Skipf("runtime present but unusable here (%v)", err)
	}
	if res.ExitCode != 0 || !strings.Contains(res.Stdout, "hello from the box") {
		t.Fatalf("res = %+v", res)
	}
}

func TestIntegration_EgressIsAbsent(t *testing.T) {
	if testing.Short() {
		t.Skip("short mode")
	}
	r := realRuntime(t)
	// THE NEGATIVE ASSERTION the plan requires in the transcripts: code that
	// reaches for the network must FAIL, on every executor. This is the rule
	// that keeps attacker-steered code from exfiltrating what it was fed.
	res, err := r.Run(context.Background(), Spec{
		Image:  alpine,
		Argv:   []string{"sh", "-c", "wget -T 3 -q -O- http://example.com || echo EGRESS-REFUSED"},
		Limits: Limits{Wall: 60 * time.Second},
	})
	if err != nil {
		t.Skipf("runtime present but unusable here (%v)", err)
	}
	if !strings.Contains(res.Stdout, "EGRESS-REFUSED") {
		t.Fatalf("THE NETWORK WAS REACHABLE — containment failed: %+v", res)
	}
}

func TestIntegration_RootfsIsReadOnlyButTheWorkdirIsNot(t *testing.T) {
	if testing.Short() {
		t.Skip("short mode")
	}
	r := realRuntime(t)
	res, err := r.Run(context.Background(), Spec{
		Image: alpine,
		Argv: []string{"sh", "-c",
			"touch /etc/planted 2>/dev/null && echo ROOTFS-WRITABLE; touch /work/scratch && echo WORKDIR-OK"},
		Limits: Limits{Wall: 60 * time.Second},
	})
	if err != nil {
		t.Skipf("runtime present but unusable here (%v)", err)
	}
	if strings.Contains(res.Stdout, "ROOTFS-WRITABLE") {
		t.Fatalf("the image was writable — a run could persist into the next: %+v", res)
	}
	if !strings.Contains(res.Stdout, "WORKDIR-OK") {
		t.Fatalf("the workdir must accept writes: %+v", res)
	}
}

func TestIntegration_StdinIsTheDataAndTheHostEnvDoesNotCross(t *testing.T) {
	if testing.Short() {
		t.Skip("short mode")
	}
	t.Setenv("BULLMOOSE_SECRET_CANARY", "do-not-leak")
	r := realRuntime(t)
	res, err := r.Run(context.Background(), Spec{
		Image:  alpine,
		Argv:   []string{"sh", "-c", "cat; echo; env"},
		Stdin:  "the data under analysis",
		Limits: Limits{Wall: 60 * time.Second},
	})
	if err != nil {
		t.Skipf("runtime present but unusable here (%v)", err)
	}
	if !strings.Contains(res.Stdout, "the data under analysis") {
		t.Fatalf("stdin did not arrive: %+v", res)
	}
	if strings.Contains(res.Stdout, "do-not-leak") {
		t.Fatalf("A HOST ENV VAR CROSSED THE BOUNDARY: %+v", res)
	}
}

func TestIntegration_WallClockStopsARunawayAndSaysSo(t *testing.T) {
	if testing.Short() {
		t.Skip("short mode")
	}
	r := realRuntime(t)
	res, err := r.Run(context.Background(), Spec{
		Image: alpine, Argv: []string{"sh", "-c", "sleep 30"},
		Limits: Limits{Wall: 3 * time.Second},
	})
	if err != nil {
		t.Skipf("runtime present but unusable here (%v)", err)
	}
	// A timeout is a RESULT the model can be told, not a transport failure.
	if !res.TimedOut {
		t.Fatalf("the wall clock did not bite: %+v", res)
	}
	if res.Duration > 20*time.Second {
		t.Fatalf("it bit far too late: %v", res.Duration)
	}
}

func TestIntegration_OutputIsBounded(t *testing.T) {
	if testing.Short() {
		t.Skip("short mode")
	}
	r := realRuntime(t)
	res, err := r.Run(context.Background(), Spec{
		Image: alpine, Argv: []string{"sh", "-c", "yes bullmoose | head -c 200000"},
		Limits: Limits{Wall: 60 * time.Second, MaxOutputBytes: 4096},
	})
	if err != nil {
		t.Skipf("runtime present but unusable here (%v)", err)
	}
	// Output crosses BACK into a context window: its size is a cost.
	if !res.Truncated || len(res.Stdout) > 4096+32 {
		t.Fatalf("unbounded output: truncated=%v len=%d", res.Truncated, len(res.Stdout))
	}
}
