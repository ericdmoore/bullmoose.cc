// Package sandbox is the LOCAL executor for the platform's compute tool
// (s44 slice 5) — the free-lane twin of the cloud's Cloudflare Sandbox.
//
// ## One runner, a detected binary name
//
// Podman is a drop-in for the docker CLI and Apple's `container` speaks the
// same run shape, so this is ONE code path asking which spelling is
// installed — not three executors. The preference order is podman (rootless,
// daemonless — the right shape for an unattended agent host), then docker,
// then Apple's native `container` on macOS 26+.
//
// ## Contained by construction, not by hope
//
// Every run carries the same flags, and they are built in ONE place so a
// caller cannot forget one:
//
//	--network=none      no egress. The plan's rule 2, and the reason the
//	                    image cannot fetch packages at run time: an attacker
//	                    steering the code cannot exfiltrate what the harness
//	                    fed it, and cannot install what nobody reviewed.
//	--read-only         the image's filesystem is immutable; only the
//	                    tmpfs workdir accepts writes, and it dies with the run.
//	--memory/--cpus     a runaway costs a bounded amount of the host.
//	--pids-limit        no fork bombs.
//	timeout             wall clock, enforced by the harness's own context so
//	                    a hung runtime cannot outlive its invocation.
//
// NO CREDENTIALS EVER CROSS THE BOUNDARY: the run takes an argv and stdin
// the harness wrote, and inherits NO environment. Compute is "act on this
// data", never "act as this person" — the sandbox's user-scope is the
// invocation, not the human.
//
// ## Small budgets on purpose
//
// The defaults below are deliberately modest (Eric, 2026-08-24: "just
// allocate small budgets"). A sandbox that can spend minutes and gigabytes
// by default is a bill waiting to happen; one that has to be RAISED to do
// something big is a decision somebody made.
package sandbox

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Runtime is a detected OCI-compatible binary. Empty Name = none found.
type Runtime struct {
	// Name is the binary as invoked ("podman", "docker", "container").
	Name string
	// Path is its absolute location, for the record and for exec.
	Path string
}

// Flavor is what the host DECLARES it can run (s45's facet vocabulary).
// "oci" today; "wasi" is the deferred floor, and the value is a flavor
// rather than a boolean precisely so a narrower host can say so honestly.
func (r Runtime) Flavor() string {
	if r.Name == "" {
		return ""
	}
	return "oci"
}

// preference order — see the package doc.
var candidates = []string{"podman", "docker", "container"}

// Detect finds the runner this host will use. It does NOT install anything:
// the offer to install is a separate, consented act (the `bullmoose local`
// posture), and a host with nothing simply declares nothing.
func Detect() Runtime {
	for _, name := range candidates {
		// Apple's `container` exists only on macOS; looking for it elsewhere
		// would report a coincidence as a capability.
		if name == "container" && runtime.GOOS != "darwin" {
			continue
		}
		if path, err := exec.LookPath(name); err == nil {
			return Runtime{Name: name, Path: path}
		}
	}
	return Runtime{}
}

// Limits are the run's budget. Zero values take the small defaults.
type Limits struct {
	// Wall is the hard wall-clock ceiling for one run.
	Wall time.Duration
	// MemoryMB caps resident memory.
	MemoryMB int
	// CPUs is a fractional core cap (0.5 = half a core).
	CPUs float64
	// PIDs caps process count — a fork bomb ceiling.
	PIDs int
	// MaxOutputBytes truncates what comes back. Output crosses BACK into a
	// context window, so its size is a cost as well as a bound.
	MaxOutputBytes int
}

// The small defaults. Raising one is a decision somebody makes, not a
// default nobody noticed.
const (
	DefaultWall           = 20 * time.Second
	DefaultMemoryMB       = 512
	DefaultCPUs           = 1.0
	DefaultPIDs           = 128
	DefaultMaxOutputBytes = 64 * 1024
)

func (l Limits) withDefaults() Limits {
	if l.Wall <= 0 {
		l.Wall = DefaultWall
	}
	if l.MemoryMB <= 0 {
		l.MemoryMB = DefaultMemoryMB
	}
	if l.CPUs <= 0 {
		l.CPUs = DefaultCPUs
	}
	if l.PIDs <= 0 {
		l.PIDs = DefaultPIDs
	}
	if l.MaxOutputBytes <= 0 {
		l.MaxOutputBytes = DefaultMaxOutputBytes
	}
	return l
}

// Spec is one run: an image, an argv, and the bytes the harness wrote in.
type Spec struct {
	// Image is the pinned image the tool definition names. The MODEL never
	// chooses this: the image is the provisioning layer, admitted once by a
	// human (the plan's grant-request flow), and what the model steers is
	// the code that runs against the data — never which software exists.
	Image string
	// Argv is the command inside the container.
	Argv []string
	// Stdin is the data under analysis, written by the harness.
	Stdin string
	// Workdir is the writable tmpfs mount point.
	Workdir string
	Limits  Limits
}

// Result is what came back, and what it cost in wall time.
type Result struct {
	Stdout    string
	Stderr    string
	ExitCode  int
	Duration  time.Duration
	Truncated bool
	// TimedOut distinguishes "the code decided to stop" from "we stopped
	// it" — a distinction the caller must be able to tell a model.
	TimedOut bool
}

// ErrNoRuntime is the honest absence: this host declares no sandbox flavor
// and the work belongs somewhere that does.
var ErrNoRuntime = errors.New("no container runtime found (podman, docker, or container)")

// Args builds the full argv INCLUDING the runtime binary. Exported and pure
// so the containment can be asserted without executing anything: the flags
// are the security posture, and a test that could not see them would be
// testing nothing. This is the ONE place the flags are assembled.
func (r Runtime) Args(s Spec) []string {
	l := s.Limits.withDefaults()
	work := s.Workdir
	if work == "" {
		work = "/work"
	}
	args := []string{
		r.Name, "run", "--rm", "-i",
		// RULE 2: no egress. Not "restricted" — absent.
		"--network=none",
		// The image is immutable; only the tmpfs below takes writes.
		"--read-only",
		"--tmpfs", work + ":rw,size=64m,mode=1777",
		"--workdir", work,
		"--memory", strconv.Itoa(l.MemoryMB) + "m",
		"--cpus", strconv.FormatFloat(l.CPUs, 'f', -1, 64),
		"--pids-limit", strconv.Itoa(l.PIDs),
		// RULE 1: nothing of the host's identity crosses. No --env, no
		// --env-file, no volume mounts, no --privileged, ever.
		"--env", "HOME=" + work,
	}
	args = append(args, s.Image)
	args = append(args, s.Argv...)
	return args
}

// Run executes one sandboxed command. The wall clock is enforced HERE, by
// the harness's own context, so a runtime that hangs cannot outlive the
// invocation that started it.
func (r Runtime) Run(ctx context.Context, s Spec) (Result, error) {
	if r.Name == "" {
		return Result{}, ErrNoRuntime
	}
	if s.Image == "" {
		return Result{}, errors.New("no image: the tool definition names it, never the model")
	}
	l := s.Limits.withDefaults()
	runCtx, cancel := context.WithTimeout(ctx, l.Wall)
	defer cancel()

	argv := r.Args(s)
	cmd := exec.CommandContext(runCtx, r.Path, argv[1:]...)
	cmd.Stdin = strings.NewReader(s.Stdin)
	// The child inherits NO environment: an inherited one is how a token in
	// the operator's shell ends up inside a container reading hostile data.
	cmd.Env = []string{}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	start := time.Now()
	err := cmd.Run()
	res := Result{Duration: time.Since(start)}

	out, cut := truncate(stdout.String(), l.MaxOutputBytes)
	errOut, cut2 := truncate(stderr.String(), l.MaxOutputBytes)
	res.Stdout, res.Stderr, res.Truncated = out, errOut, cut || cut2

	if runCtx.Err() == context.DeadlineExceeded {
		res.TimedOut = true
		res.ExitCode = -1
		// A timeout is a RESULT, not a transport failure: the caller hands
		// the model "it ran out of time" as a fact it can answer around.
		return res, nil
	}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			res.ExitCode = ee.ExitCode()
			return res, nil
		}
		return res, fmt.Errorf("%s: %w", r.Name, err)
	}
	return res, nil
}

func truncate(s string, max int) (string, bool) {
	if len(s) <= max {
		return s, false
	}
	return s[:max] + "\n…(truncated)", true
}
