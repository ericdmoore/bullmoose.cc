package cloud

// The build toolchain, probed BEFORE it is needed — and named when absent.
//
// `cloud install` against a published stack needs nothing but this binary:
// the bundles are already built, which is the whole point of the download
// path. `--from-source` is the other case, and it cannot avoid Node —
// wrangler's bundler is what turns a checkout into deployable modules, and
// wrangler is an npm package.
//
// So the rule is the one `agent install` set for launchd/systemd: shelling
// out to a platform tool is fine, dying on `exec: "npx": executable file
// not found` is not. Probe first, refuse with the version we need and the
// place to get it, and never start work that will strand halfway.
//
// What this deliberately does NOT do is install Node. A CLI that
// silently drags a language runtime onto someone's machine is the
// malware-shaped move `agent install` already refused in its own domain;
// the honest offer is an accurate sentence about what is missing.

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// MinNodeMajor is the repo's own floor (package.json engines / CI).
const MinNodeMajor = 22

// Toolchain is what a from-source build needs, and what was found.
type Toolchain struct {
	NodePath    string
	NodeVersion string
	NodeMajor   int
	GitPath     string
	OK          bool
	// Missing is the human sentence — what is absent, what version, where
	// to get it. Empty iff OK.
	Missing string
}

type lookPath func(string) (string, error)
type runner func(name string, args ...string) ([]byte, error)

func realRunner(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).Output()
}

// ProbeToolchain answers whether a source build can even start.
func ProbeToolchain() Toolchain { return probeToolchainWith(exec.LookPath, realRunner) }

func probeToolchainWith(look lookPath, run runner) Toolchain {
	t := Toolchain{}
	if p, err := look("git"); err == nil {
		t.GitPath = p
	}
	p, err := look("node")
	if err != nil {
		t.Missing = "Node " + strconv.Itoa(MinNodeMajor) + "+ is not installed, and a source build cannot run without it " +
			"(wrangler's bundler turns the checkout into deployable modules, and wrangler is an npm package). " +
			"Install it from https://nodejs.org — or skip source entirely: `bullmoose cloud install` applies the " +
			"published stack and needs nothing but this binary."
		return t
	}
	t.NodePath = p
	out, err := run(p, "--version")
	if err != nil {
		t.Missing = "node was found at " + p + " but would not report its version — the toolchain is not usable"
		return t
	}
	t.NodeVersion = strings.TrimSpace(string(out))
	major, perr := majorOf(t.NodeVersion)
	if perr != nil {
		t.Missing = "node reported an unreadable version (" + t.NodeVersion + ")"
		return t
	}
	t.NodeMajor = major
	if major < MinNodeMajor {
		t.Missing = fmt.Sprintf(
			"node %s is older than the %d+ this build needs. Upgrade from https://nodejs.org — or skip source "+
				"entirely: `bullmoose cloud install` applies the published stack and needs nothing but this binary.",
			t.NodeVersion, MinNodeMajor)
		return t
	}
	// npx ships with npm, which ships with node — but a stripped install or
	// a PATH that finds node and not npm is common enough to name.
	if _, err := look("npx"); err != nil {
		t.Missing = "node " + t.NodeVersion + " is installed but `npx` is not on PATH — npm ships with Node, so " +
			"this usually means a partial install or a PATH that reaches one and not the other"
		return t
	}
	t.OK = true
	return t
}

func majorOf(v string) (int, error) {
	trimmed := strings.TrimPrefix(strings.TrimSpace(v), "v")
	head, _, _ := strings.Cut(trimmed, ".")
	return strconv.Atoi(head)
}
