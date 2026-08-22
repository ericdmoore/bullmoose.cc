package cmd

// The version surface (s08 T7). Parse-back over byte-diff, per s42: the
// assertions are the two things a consumer actually does with this output —
// `awk '{print $2}'` on the human line, and field lookups on the JSON.

import (
	"bytes"
	"encoding/json"
	"runtime"
	"runtime/debug"
	"strings"
	"testing"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

func TestVersionIsOneRecordWithStableFields(t *testing.T) {
	var out, errOut bytes.Buffer
	s := bmio.NewTo(&out, &errOut)

	if got := runVersion(s, []string{"version"}); got != 0 {
		t.Fatalf("exit = %d, want 0", got)
	}
	if errOut.Len() != 0 {
		t.Errorf("version has no chrome, stderr got %q", errOut.String())
	}

	lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("want exactly one record, got %d: %q", len(lines), out.String())
	}
	// Field COUNT is the contract: `awk '{print $2}'` must mean "version"
	// on every build, including one that does not know its commit.
	f := strings.Fields(lines[0])
	if len(f) != 5 {
		t.Fatalf("want 5 fields (bullmoose version os/arch go commit), got %d: %q", len(f), lines[0])
	}
	if f[0] != "bullmoose" || f[1] != releaseVersion {
		t.Errorf("fields 1-2 = %q %q, want bullmoose %q", f[0], f[1], releaseVersion)
	}
	if f[2] != runtime.GOOS+"/"+runtime.GOARCH {
		t.Errorf("platform field = %q, want %s/%s", f[2], runtime.GOOS, runtime.GOARCH)
	}
	if f[3] != runtime.Version() {
		t.Errorf("go field = %q, want %q", f[3], runtime.Version())
	}
}

func TestVersionJSONParsesBack(t *testing.T) {
	var out, errOut bytes.Buffer
	s := bmio.NewTo(&out, &errOut)

	if got := runVersion(s, []string{"version", "--json"}); got != 0 {
		t.Fatalf("exit = %d, want 0", got)
	}
	var v struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
		Go      string `json:"go"`
		OS      string `json:"os"`
		Arch    string `json:"arch"`
	}
	if err := json.Unmarshal(out.Bytes(), &v); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, out.String())
	}
	if v.Version != releaseVersion || v.Go != runtime.Version() ||
		v.OS != runtime.GOOS || v.Arch != runtime.GOARCH || v.Commit == "" {
		t.Errorf("parsed back %+v — version/go/os/arch must match the runtime, commit must not be empty", v)
	}
}

func TestBuildCommitClassifiesTheStamp(t *testing.T) {
	long := "0123456789abcdef0123456789abcdef01234567"
	for _, tc := range []struct {
		name string
		info *debug.BuildInfo
		ok   bool
		want string
	}{
		// A test binary has no build info at all; "unknown" beats guessing.
		{"no build info", nil, false, "unknown"},
		{"info without vcs", &debug.BuildInfo{}, true, "unknown"},
		{"clean checkout", &debug.BuildInfo{Settings: []debug.BuildSetting{
			{Key: "vcs.revision", Value: long}}}, true, long[:12]},
		{"modified tree owns up to it", &debug.BuildInfo{Settings: []debug.BuildSetting{
			{Key: "vcs.revision", Value: long},
			{Key: "vcs.modified", Value: "true"}}}, true, long[:12] + "+dirty"},
	} {
		if got := buildCommit(tc.info, tc.ok); got != tc.want {
			t.Errorf("%s: buildCommit = %q, want %q", tc.name, got, tc.want)
		}
	}
}
