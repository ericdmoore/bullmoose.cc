package cloud

// The probe exists so a source build refuses BEFORE it strands, and says
// something a person can act on. Each case is a refusal someone will
// actually hit.

import (
	"errors"
	"strings"
	"testing"
)

func fakeLook(found map[string]string) lookPath {
	return func(name string) (string, error) {
		if p, ok := found[name]; ok {
			return p, nil
		}
		return "", errors.New("not found")
	}
}

func fakeRun(version string) runner {
	return func(_ string, _ ...string) ([]byte, error) { return []byte(version), nil }
}

func TestProbe_HappyPath(t *testing.T) {
	got := probeToolchainWith(fakeLook(map[string]string{"node": "/usr/bin/node", "npx": "/usr/bin/npx", "git": "/usr/bin/git"}), fakeRun("v22.4.1\n"))
	if !got.OK || got.NodeMajor != 22 || got.Missing != "" {
		t.Fatalf("%+v", got)
	}
}

func TestProbe_NoNode_NamesTheAlternative(t *testing.T) {
	// The refusal must offer the door that needs NOTHING: the published
	// stack. Someone who came here to avoid a toolchain should not be sent
	// to install one without being told there is another way.
	got := probeToolchainWith(fakeLook(map[string]string{"git": "/usr/bin/git"}), fakeRun(""))
	if got.OK {
		t.Fatal("no node must not be OK")
	}
	for _, want := range []string{"Node 22+", "nodejs.org", "cloud install", "needs nothing but this binary"} {
		if !strings.Contains(got.Missing, want) {
			t.Errorf("the refusal lacks %q:\n%s", want, got.Missing)
		}
	}
}

func TestProbe_TooOld_SaysWhichVersionItFound(t *testing.T) {
	got := probeToolchainWith(fakeLook(map[string]string{"node": "/n", "npx": "/x"}), fakeRun("v18.20.0"))
	if got.OK || !strings.Contains(got.Missing, "v18.20.0") || !strings.Contains(got.Missing, "22+") {
		t.Fatalf("%+v", got)
	}
}

func TestProbe_NodeWithoutNpx_IsItsOwnSentence(t *testing.T) {
	// A PATH that reaches one and not the other is common enough that
	// "install Node" would be wrong advice.
	got := probeToolchainWith(fakeLook(map[string]string{"node": "/n"}), fakeRun("v22.0.0"))
	if got.OK || !strings.Contains(got.Missing, "npx") {
		t.Fatalf("%+v", got)
	}
}

func TestProbe_UnreadableVersion_RefusesRatherThanGuessing(t *testing.T) {
	got := probeToolchainWith(fakeLook(map[string]string{"node": "/n", "npx": "/x"}), fakeRun("banana"))
	if got.OK || !strings.Contains(got.Missing, "unreadable") {
		t.Fatalf("%+v", got)
	}
	broken := probeToolchainWith(fakeLook(map[string]string{"node": "/n", "npx": "/x"}), func(string, ...string) ([]byte, error) {
		return nil, errors.New("boom")
	})
	if broken.OK || !strings.Contains(broken.Missing, "would not report its version") {
		t.Fatalf("%+v", broken)
	}
}
