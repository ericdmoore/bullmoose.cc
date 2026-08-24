package cmd

// The s43 follow-on's whole safety story: consent shows the unit BEFORE
// anything exists, "ours" is a fact read from the file (the marker), and
// the tool never touches a unit someone else wrote — in either direction.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

func fakeInstallDeps(t *testing.T, goos string) (installDeps, *[][]string) {
	t.Helper()
	loads := &[][]string{}
	return installDeps{
		goos:   goos,
		home:   t.TempDir(),
		binary: func() (string, error) { return "/opt/bullmoose/bullmoose", nil },
		runLoad: func(argv []string) error {
			*loads = append(*loads, argv)
			return nil
		},
	}, loads
}

func fleetFile(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fleet.json")
	if err := os.WriteFile(path, []byte(`{"bindings":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func installCmd(t *testing.T, d installDeps, uninstall bool, argv ...string) (out, errOut string, code int) {
	t.Helper()
	var o, e strings.Builder
	s := bmio.NewTo(&o, &e)
	a := parseAgent(append([]string{"agent"}, argv...))
	code = runAgentInstallWith(s, a, uninstall, d)
	return o.String(), e.String(), code
}

func TestAgentInstall_PlanShowsEverythingBeforeConsent(t *testing.T) {
	d, loads := fakeInstallDeps(t, "darwin")
	fleet := fleetFile(t)
	// No --yes and no stdin "y": defaultConfirm fails closed — the DEFAULT
	// outcome of this verb is that nothing happens.
	withStdin(t, "\n")
	out, errOut, code := installCmd(t, d, false, "install", "--fleet", fleet)
	if code != 1 || !strings.Contains(errOut, "declined — nothing was written") {
		t.Fatalf("code=%d err=%s", code, errOut)
	}
	// The unit was shown WHOLE before the question: binary, fleet (absolute),
	// KeepAlive, the loader command, and the watchdog coexistence warning.
	for _, want := range []string{
		"/opt/bullmoose/bullmoose", fleet, "KeepAlive", "launchctl bootstrap",
		"defray cloud costs", "two supervisors will fight",
	} {
		if !strings.Contains(out+errOut, want) {
			t.Errorf("the printed plan lacks %q\n%s", want, out)
		}
	}
	if len(*loads) != 0 {
		t.Errorf("declined install ran a loader: %v", *loads)
	}
	if _, err := os.Stat(filepath.Join(d.home, "Library/LaunchAgents/cc.bullmoose.agent.plist")); !os.IsNotExist(err) {
		t.Error("declined install wrote the unit anyway")
	}
}

func TestAgentInstall_YesWritesMarksAndLoads(t *testing.T) {
	d, loads := fakeInstallDeps(t, "darwin")
	out, _, code := installCmd(t, d, false, "install", "--fleet", fleetFile(t), "--yes")
	if code != 0 {
		t.Fatalf("code=%d\n%s", code, out)
	}
	path := filepath.Join(d.home, "Library/LaunchAgents/cc.bullmoose.agent.plist")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), unitMarker) {
		t.Error("the written unit does not carry the ownership marker — uninstall could never prove it ours")
	}
	if len(*loads) != 1 || (*loads)[0][0] != "launchctl" {
		t.Errorf("loads = %v", *loads)
	}
	// Re-install over OUR unit reconciles rather than refusing.
	if _, _, code := installCmd(t, d, false, "install", "--fleet", fleetFile(t), "--yes"); code != 0 {
		t.Errorf("reinstall over our own unit refused: %d", code)
	}
}

func TestAgentInstall_RefusesForeignUnit(t *testing.T) {
	d, loads := fakeInstallDeps(t, "linux")
	path := filepath.Join(d.home, ".config/systemd/user/bullmoose-agent.service")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	handRolled := "[Unit]\nDescription=eric's own unit\n"
	if err := os.WriteFile(path, []byte(handRolled), 0o644); err != nil {
		t.Fatal(err)
	}
	_, errOut, code := installCmd(t, d, false, "install", "--fleet", fleetFile(t), "--yes")
	if code != 1 || !strings.Contains(errOut, "not written by this tool") {
		t.Fatalf("code=%d err=%s", code, errOut)
	}
	body, _ := os.ReadFile(path)
	if string(body) != handRolled {
		t.Error("the foreign unit was modified")
	}
	// Uninstall refuses the same file for the same reason.
	if _, errOut, code := installCmd(t, d, true, "uninstall"); code != 1 || !strings.Contains(errOut, "not written by this tool") {
		t.Errorf("uninstall touched a foreign unit: code=%d err=%s", code, errOut)
	}
	if len(*loads) != 0 {
		t.Errorf("a refusal ran a loader: %v", *loads)
	}
}

func TestAgentUninstall_RemovesOnlyOursAndUnloadsFirst(t *testing.T) {
	d, loads := fakeInstallDeps(t, "linux")
	if _, _, code := installCmd(t, d, false, "install", "--fleet", fleetFile(t), "--yes"); code != 0 {
		t.Fatal("install failed")
	}
	out, _, code := installCmd(t, d, true, "uninstall")
	if code != 0 || !strings.Contains(out, "will not return at next login") {
		t.Fatalf("code=%d out=%s", code, out)
	}
	if len(*loads) != 2 || (*loads)[1][2] != "disable" {
		t.Errorf("unload did not run before removal: %v", *loads)
	}
	if _, err := os.Stat(filepath.Join(d.home, ".config/systemd/user/bullmoose-agent.service")); !os.IsNotExist(err) {
		t.Error("the unit survived uninstall")
	}
	// A second uninstall finds nothing and says so, exit 0.
	if _, errOut, code := installCmd(t, d, true, "uninstall"); code != 0 || !strings.Contains(errOut, "nothing to remove") {
		t.Errorf("empty uninstall: code=%d err=%s", code, errOut)
	}
}

func TestAgentInstall_Refusals(t *testing.T) {
	d, _ := fakeInstallDeps(t, "darwin")
	if _, errOut, code := installCmd(t, d, false, "install"); code != 2 || !strings.Contains(errOut, "--fleet") {
		t.Errorf("missing fleet: code=%d err=%s", code, errOut)
	}
	if _, errOut, code := installCmd(t, d, false, "install", "--fleet", "/no/such/fleet.json"); code != 2 || !strings.Contains(errOut, "crash-loop") {
		t.Errorf("unreadable fleet: code=%d err=%s", code, errOut)
	}
	other, _ := fakeInstallDeps(t, "windows")
	if _, errOut, code := installCmd(t, other, false, "install", "--fleet", fleetFile(t), "--yes"); code == 0 || !strings.Contains(errOut, "launchd") {
		t.Errorf("unsupported OS must refuse by name: code=%d err=%s", code, errOut)
	}
}
