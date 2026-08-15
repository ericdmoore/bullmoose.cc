// Package deploy has no Go source — it holds the platform branches of the
// installer. What it does have is one decision that can wreck a machine:
// deploy/install.sh used to copy deploy/cc.bullmoose.popcorn.plist over
// ~/Library/LaunchAgents/ whatever was already there, and on the host popcorn
// actually runs on those two files disagree about every field that matters —
// the binary, the POP3 bind (a tailnet address vs every interface), the TLS
// paths, and whether POPCORN_SMTP_LISTEN exists at all. Running the repo's own
// installer would have taken SMTP submission away, moved POP3 onto the public
// interfaces, aimed TLS at an empty directory, and printed "installed".
//
// The fix splits the installer in two: deploy/lib/plan.sh decides and writes
// nothing, install.sh writes and decides nothing. That is what makes these
// tests possible — every case below runs the real planner as a subprocess and
// asserts on the plan, with no LaunchAgents directory, no launchctl, and no
// installer anywhere near a real machine.
package deploy

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// plan runs deploy/lib/plan.sh with the given inputs and returns its output
// as key -> values (change= and finding= repeat) plus the exit status, which
// is part of the contract: 0 safe, 3 refused, 4 blocked.
func plan(t *testing.T, env map[string]string) (map[string][]string, int) {
	t.Helper()
	cmd := exec.Command("sh", "lib/plan.sh")
	cmd.Env = append(os.Environ(), "POPCORN_PLIST_PARSER=")
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	out, err := cmd.Output()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
		if len(ee.Stderr) > 0 {
			t.Logf("plan.sh stderr: %s", ee.Stderr)
		}
	} else if err != nil {
		t.Fatalf("running plan.sh: %v", err)
	}
	got := map[string][]string{}
	for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		if line == "" {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			t.Fatalf("plan.sh printed a line that is not key=value: %q", line)
		}
		got[k] = append(got[k], v)
	}
	return got, code
}

func one(t *testing.T, got map[string][]string, key string) string {
	t.Helper()
	if len(got[key]) != 1 {
		t.Fatalf("want exactly one %s= line, got %v", key, got[key])
	}
	return got[key][0]
}

func hasFinding(got map[string][]string, code string) bool {
	for _, f := range got["finding"] {
		if strings.HasPrefix(f, "BLOCK "+code+" ") || strings.HasPrefix(f, "WARN "+code+" ") ||
			strings.HasPrefix(f, "INFO "+code+" ") {
			return true
		}
	}
	return false
}

// certs writes a cert/key pair that exists, because "does this path resolve"
// is the whole question in three of the rules below. They are empty files: the
// planner asks the filesystem whether the path is there, not openssl whether
// the contents parse.
func certs(t *testing.T) (cert, key string) {
	t.Helper()
	dir := t.TempDir()
	cert, key = filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	for _, p := range []string{cert, key} {
		if err := os.WriteFile(p, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return cert, key
}

// The template's own defaults, as install.sh sets them for macOS. Tests that
// describe "what a fresh machine gets" use these so the fixture cannot drift
// away from the installer without a test noticing.
func macDefaults(home string) map[string]string {
	return map[string]string{
		"DEF_PROGRAM":     home + "/bin/popcorn",
		"DEF_LISTEN":      "127.0.0.1:9995",
		"DEF_SMTP_LISTEN": "127.0.0.1:9587",
		"DEF_TLS_CERT":    home + "/.popcorn/cert.pem",
		"DEF_TLS_KEY":     home + "/.popcorn/key.pem",
		"DEF_LOG":         home + "/.popcorn/popcorn.log",
	}
}

func merge(base map[string]string, over map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range over {
		out[k] = v
	}
	return out
}

// A machine with nothing on it takes the template wholesale — that path has to
// keep working, or "safe" just means "useless".
func TestFreshMachineTakesTheTemplate(t *testing.T) {
	home := t.TempDir()
	got, code := plan(t, macDefaults(home))
	if code != 0 {
		t.Fatalf("fresh install should be applyable, exit %d (%v)", code, got)
	}
	if a := one(t, got, "action"); a != "install" {
		t.Fatalf("action=%s, want install", a)
	}
	if l := one(t, got, "listen"); l != "127.0.0.1:9995" {
		t.Fatalf("listen=%s, want the template default", l)
	}
	if s := one(t, got, "smtp_listen"); s != "127.0.0.1:9587" {
		t.Fatalf("smtp_listen=%s — the template must carry an SMTP face", s)
	}
	if len(got["change"]) != 0 {
		t.Fatalf("nothing exists to change on a fresh machine, got %v", got["change"])
	}
	// The template names a cert path; on a machine that has no such file the
	// planner drops TLS rather than writing a unit that cannot start.
	if m := one(t, got, "tls_mode"); m != "plaintext" {
		t.Fatalf("tls_mode=%s, want plaintext when the template certs are absent", m)
	}
	if !hasFinding(got, "tls-default-absent") || !hasFinding(got, "plaintext-private") {
		t.Fatalf("dropping TLS must be said out loud, findings: %v", got["finding"])
	}
}

// "Someone who runs it twice must not end up worse off than someone who ran it
// once" — so the output of the first run, fed back in as the machine's state,
// has to plan to nothing. This is the property the old installer failed even on
// its own output, because it rewrote and reloaded the job every time.
func TestSecondRunChangesNothing(t *testing.T) {
	home := t.TempDir()
	first, _ := plan(t, macDefaults(home))

	state := macDefaults(home)
	state["CUR_PRESENT"] = "1"
	state["CUR_PROGRAM"] = one(t, first, "program")
	state["CUR_LISTEN"] = one(t, first, "listen")
	state["CUR_SMTP_LISTEN"] = one(t, first, "smtp_listen")
	state["CUR_TLS_CERT"] = one(t, first, "tls_cert")
	state["CUR_TLS_KEY"] = one(t, first, "tls_key")
	state["CUR_LOG"] = one(t, first, "log")

	second, code := plan(t, state)
	if code != 0 || one(t, second, "action") != "current" {
		t.Fatalf("second run: exit %d action %v, want 0/current", code, second["action"])
	}
	if len(second["change"]) != 0 {
		t.Fatalf("second run wants to change %v", second["change"])
	}
}

// The regression test. This is alpaca's real launchd job as inputs, against
// the repo template as it was: /usr/local/bin, `:9995`, no SMTP, cert paths in
// /usr/local/etc that do not exist. The old installer applied all four. The
// planner must apply none of them.
func TestExistingInstallSurvivesTheTemplate(t *testing.T) {
	cert, key := certs(t)
	got, code := plan(t, map[string]string{
		"CUR_PRESENT":     "1",
		"CUR_PROGRAM":     "/Users/alpaca/bin/popcorn",
		"CUR_LISTEN":      "100.96.149.53:9995",
		"CUR_SMTP_LISTEN": "100.96.149.53:9587",
		"CUR_TLS_CERT":    cert,
		"CUR_TLS_KEY":     key,
		"CUR_LOG":         "/Users/alpaca/.popcorn/popcorn.log",

		"DEF_PROGRAM":     "/usr/local/bin/popcorn",
		"DEF_LISTEN":      ":9995",
		"DEF_SMTP_LISTEN": "",
		"DEF_TLS_CERT":    "/usr/local/etc/popcorn/cert.pem",
		"DEF_TLS_KEY":     "/usr/local/etc/popcorn/key.pem",
		"DEF_LOG":         "/usr/local/var/log/popcorn.log",
	})
	if code != 0 {
		t.Fatalf("re-running on a working machine should be a no-op, exit %d (%v)", code, got)
	}
	if a := one(t, got, "action"); a != "current" {
		t.Fatalf("action=%s, want current — the unit must be left alone", a)
	}
	if len(got["change"]) != 0 {
		t.Fatalf("a re-run must change nothing, got %v", got["change"])
	}
	for key, want := range map[string]string{
		"program":     "/Users/alpaca/bin/popcorn",
		"listen":      "100.96.149.53:9995",
		"smtp_listen": "100.96.149.53:9587",
		"tls_cert":    cert,
		"log":         "/Users/alpaca/.popcorn/popcorn.log",
	} {
		if g := one(t, got, key); g != want {
			t.Errorf("%s=%s, want the machine's own %s", key, g, want)
		}
	}
}

// Requirement 2, in the direction that matters: a specific bind must never
// become a wildcard one. Ranks are the mechanism — loopback < private/tailnet
// < routable < every interface — and the plan may only move down.
func TestListenAddressIsNeverWidened(t *testing.T) {
	cert, key := certs(t)
	base := map[string]string{
		"CUR_PRESENT":  "1",
		"CUR_LISTEN":   "100.96.149.53:9995",
		"CUR_TLS_CERT": cert,
		"CUR_TLS_KEY":  key,
		"DEF_LISTEN":   "127.0.0.1:9995",
	}

	got, code := plan(t, merge(base, map[string]string{"WANT_LISTEN": ":9995"}))
	if code != 4 || one(t, got, "action") != "blocked" {
		t.Fatalf("tailnet -> every interface must be blocked, exit %d (%v)", code, got)
	}
	if !hasFinding(got, "widen-pop3") {
		t.Fatalf("want a widen-pop3 finding, got %v", got["finding"])
	}

	// Explicit consent downgrades it to a warning — but the operator had to
	// type the flag, which is the entire difference from the old behaviour.
	got, code = plan(t, merge(base, map[string]string{"WANT_LISTEN": ":9995", "ALLOW_WIDEN": "1"}))
	if code == 4 {
		t.Fatalf("--allow-widen should not block, got %v", got)
	}
	if !hasFinding(got, "widen-pop3") {
		t.Fatalf("--allow-widen still has to say so, got %v", got["finding"])
	}

	// Narrowing is always fine: loopback is strictly less reachable.
	got, code = plan(t, merge(base, map[string]string{"WANT_LISTEN": "127.0.0.1:9995"}))
	if code == 4 {
		t.Fatalf("narrowing must not be blocked, got %v", got)
	}

	// And the SMTP face is ranked by the same rule.
	got, code = plan(t, merge(base, map[string]string{
		"CUR_SMTP_LISTEN": "100.96.149.53:9587", "WANT_SMTP_LISTEN": "0.0.0.0:587",
	}))
	if code != 4 || !hasFinding(got, "widen-smtp") {
		t.Fatalf("widening SMTP must block too, exit %d (%v)", code, got)
	}
}

// Requirement 4. POPCORN_SMTP_LISTEN is not a setting, it is the on/off switch
// for outgoing mail: cmd/popcorn/main.go only starts the submission listener
// when the variable is non-empty. Losing it during an "install" is a service
// outage that leaves no error behind.
func TestSMTPFaceIsNeverDroppedSilently(t *testing.T) {
	cert, key := certs(t)
	base := map[string]string{
		"CUR_PRESENT":     "1",
		"CUR_LISTEN":      "100.96.149.53:9995",
		"CUR_SMTP_LISTEN": "100.96.149.53:9587",
		"CUR_TLS_CERT":    cert,
		"CUR_TLS_KEY":     key,
	}

	// The template omitting it (the old repo plist) simply loses.
	got, code := plan(t, merge(base, map[string]string{"DEF_SMTP_LISTEN": ""}))
	if code != 0 || one(t, got, "smtp_listen") != "100.96.149.53:9587" {
		t.Fatalf("a silent template must not remove SMTP, exit %d (%v)", code, got)
	}

	// Asking for it explicitly is refused, not obeyed: --force is for config
	// that changed, not for deleting a service face by accident.
	got, code = plan(t, merge(base, map[string]string{"WANT_SMTP_LISTEN": "off", "FORCE": "1"}))
	if code != 4 || !hasFinding(got, "drop-smtp") {
		t.Fatalf("explicitly dropping SMTP must block, exit %d (%v)", code, got)
	}
}

// Requirement 3. Both halves of the pair must exist on disk, because
// tls.LoadX509KeyPair failing is a log.Fatalf in main.go — the process dies
// before it listens and the service manager restarts it forever.
func TestTLSPathsMustExist(t *testing.T) {
	cert, key := certs(t)
	gone := filepath.Join(t.TempDir(), "nope.pem")

	got, code := plan(t, map[string]string{
		"CUR_PRESENT": "1", "CUR_LISTEN": "127.0.0.1:9995",
		"CUR_TLS_CERT": gone, "CUR_TLS_KEY": gone,
	})
	if code != 4 || !hasFinding(got, "tls-missing") {
		t.Fatalf("missing cert paths must block, exit %d (%v)", code, got)
	}
	if m := one(t, got, "tls_mode"); m != "broken" {
		t.Fatalf("tls_mode=%s, want broken", m)
	}

	// Half a pair is worse than none: main.go requires both to be non-empty
	// and quietly serves plaintext when only one is set.
	got, code = plan(t, map[string]string{
		"CUR_PRESENT": "1", "CUR_LISTEN": "127.0.0.1:9995", "CUR_TLS_CERT": cert,
	})
	if code != 4 || !hasFinding(got, "tls-half") {
		t.Fatalf("a lone cert must block, exit %d (%v)", code, got)
	}

	// A real pair is the happy path.
	got, code = plan(t, map[string]string{
		"CUR_PRESENT": "1", "CUR_LISTEN": "127.0.0.1:9995",
		"CUR_TLS_CERT": cert, "CUR_TLS_KEY": key,
	})
	if code != 0 || one(t, got, "tls_mode") != "tls" {
		t.Fatalf("an existing pair should plan cleanly, exit %d (%v)", code, got)
	}
}

// Plaintext is a deployment choice, not a bug — the tailscale variant runs
// without app-layer TLS on purpose, because WireGuard already encrypts the
// hop. The line is drawn at reachability: private is a warning, routable is a
// refusal, and app-password tokens are what is at stake either way.
func TestPlaintextIsGatedByReach(t *testing.T) {
	got, code := plan(t, map[string]string{"DEF_LISTEN": "203.0.113.9:995"})
	if code != 4 || !hasFinding(got, "plaintext-public") {
		t.Fatalf("plaintext on a routable address must block, exit %d (%v)", code, got)
	}

	got, code = plan(t, map[string]string{"DEF_LISTEN": "203.0.113.9:995", "ALLOW_PLAINTEXT": "1"})
	if code != 0 || !hasFinding(got, "plaintext-public") {
		t.Fatalf("--allow-plaintext should proceed but still warn, exit %d (%v)", code, got)
	}

	got, code = plan(t, map[string]string{"DEF_LISTEN": "100.96.149.53:9995"})
	if code != 0 || !hasFinding(got, "plaintext-private") {
		t.Fatalf("plaintext on a tailnet address is a warning, exit %d (%v)", code, got)
	}

	// A comma-separated POPCORN_LISTEN is as exposed as its worst entry.
	got, code = plan(t, map[string]string{"DEF_LISTEN": "127.0.0.1:9995,0.0.0.0:9995"})
	if code != 4 {
		t.Fatalf("a list containing a wildcard must be judged by the wildcard, got %v", got)
	}
}

// Requirement 1. A change to an existing unit is refused by default and
// applied under --force; either way the operator sees the delta first. The
// case here is benign — certs appeared, so TLS can be switched on — which is
// exactly the kind of change that should still not happen behind your back.
func TestExistingUnitNeedsForce(t *testing.T) {
	cert, key := certs(t)
	base := map[string]string{
		"CUR_PRESENT":   "1",
		"CUR_LISTEN":    "127.0.0.1:9995",
		"DEF_LISTEN":    "127.0.0.1:9995",
		"WANT_TLS_CERT": cert, "WANT_TLS_KEY": key,
	}

	got, code := plan(t, base)
	if code != 3 || one(t, got, "action") != "sidecar" {
		t.Fatalf("changing an existing unit must be refused, exit %d (%v)", code, got)
	}
	if len(got["change"]) == 0 {
		t.Fatal("a refusal has to name what it would have changed")
	}

	got, code = plan(t, merge(base, map[string]string{"FORCE": "1"}))
	if code != 0 || one(t, got, "action") != "replace" {
		t.Fatalf("--force should apply, exit %d (%v)", code, got)
	}
}

// The reach ranking underneath every listen-address decision, checked directly
// so a bad case in the tailnet or RFC1918 patterns shows up here rather than
// as a mysteriously permitted widening.
func TestAddressReach(t *testing.T) {
	for _, tc := range []struct{ addr, want string }{
		{":995", "every interface"},
		{"0.0.0.0:995", "every interface"},
		{"[::]:995", "every interface"},
		{"127.0.0.1:9995", "loopback"},
		{"[::1]:9995", "loopback"},
		{"100.96.149.53:9995", "private/tailnet"}, // tailscale CGNAT
		{"100.200.1.1:995", "routable"},           // outside 100.64/10
		{"192.168.7.21:995", "private/tailnet"},
		{"172.16.0.4:995", "private/tailnet"},
		{"172.32.0.4:995", "routable"}, // just past the /12
		{"203.0.113.9:995", "routable"},
		{"127.0.0.1:995,203.0.113.9:995", "routable"},
	} {
		out, err := exec.Command("sh", "-c",
			`. ./lib/plan.sh; addr_reach "$1"`, "sh", tc.addr).Output()
		if err != nil {
			t.Fatalf("addr_reach %s: %v", tc.addr, err)
		}
		if got := string(out); got != tc.want {
			t.Errorf("addr_reach %s = %q, want %q", tc.addr, got, tc.want)
		}
	}
}

// Reading the existing unit is the other half of "do not clobber it": a parser
// that silently returns nothing turns every machine into a fresh one. Both
// layouts appear in the wild — the repo template puts <key> and <string> on
// separate lines, install-tailscale-macos.sh writes them on one — and both
// readers (PlistBuddy where it exists, awk everywhere else) must agree.
func TestPlistReader(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cc.bullmoose.popcorn.plist")
	if err := os.WriteFile(path, []byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>cc.bullmoose.popcorn</string>
    <key>ProgramArguments</key>
    <array><string>/Users/alpaca/bin/popcorn</string></array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>POPCORN_LISTEN</key><string>100.96.149.53:9995</string>
        <key>POPCORN_SMTP_LISTEN</key>
        <string>100.96.149.53:9587</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/alpaca/.popcorn/popcorn.log</string>
</dict>
</plist>
`), 0o600); err != nil {
		t.Fatal(err)
	}

	read := func(parser, fn, arg string) string {
		script := `. ./lib/plan.sh; ` + fn + ` "$1" "$2"`
		cmd := exec.Command("sh", "-c", script, "sh", path, arg)
		cmd.Env = append(os.Environ(), "POPCORN_PLIST_PARSER="+parser)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("%s(%s) via %q: %v", fn, arg, parser, err)
		}
		return strings.TrimRight(string(out), "\n")
	}

	for _, parser := range []string{"awk", ""} { // "" = PlistBuddy when present
		if got := read(parser, "plist_program", ""); got != "/Users/alpaca/bin/popcorn" {
			t.Errorf("[%s] program = %q", parser, got)
		}
		if got := read(parser, "plist_env", "POPCORN_LISTEN"); got != "100.96.149.53:9995" {
			t.Errorf("[%s] POPCORN_LISTEN = %q (one-line form)", parser, got)
		}
		if got := read(parser, "plist_env", "POPCORN_SMTP_LISTEN"); got != "100.96.149.53:9587" {
			t.Errorf("[%s] POPCORN_SMTP_LISTEN = %q (split over two lines)", parser, got)
		}
		if got := read(parser, "plist_env", "POPCORN_TLS_CERT"); got != "" {
			t.Errorf("[%s] absent key = %q, want empty", parser, got)
		}
		if got := read(parser, "plist_log", ""); got != "/Users/alpaca/.popcorn/popcorn.log" {
			t.Errorf("[%s] StandardOutPath = %q", parser, got)
		}
	}
}

// ExecStart is the only thing install.sh substitutes into the systemd unit, so
// reading it back is how a re-run keeps a machine's own binary path.
func TestSystemdExecReader(t *testing.T) {
	path := filepath.Join(t.TempDir(), "popcorn.service")
	if err := os.WriteFile(path, []byte(
		"[Service]\n# ExecStart=/decoy/popcorn\nExecStart=-/opt/popcorn/bin/popcorn --flag\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("sh", "-c",
		`. ./lib/plan.sh; systemd_exec "$1"`, "sh", path).Output()
	if err != nil {
		t.Fatal(err)
	}
	// The comment is not a setting, systemd's `-` prefix is not part of the
	// path, and arguments are not the binary.
	if got := strings.TrimRight(string(out), "\n"); got != "/opt/popcorn/bin/popcorn" {
		t.Errorf("systemd_exec = %q", got)
	}
}

// The template and the installer have to agree, or the rendered unit is
// nonsense in a way no plan-level test would catch: a renamed token leaves a
// literal __POPCORN_LISTEN__ in a plist that launchd will happily load. Both
// branches are rendered here on whatever machine is running the tests, which
// is what POPCORN_FAKE_OS is for. --render writes nothing.
func TestRenderedUnitsAreComplete(t *testing.T) {
	render := func(goos string) string {
		cmd := exec.Command("sh", "install.sh", "--render")
		cmd.Env = append(os.Environ(), "POPCORN_FAKE_OS="+goos, "HOME="+t.TempDir())
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("--render on %s: %v", goos, err)
		}
		return string(out)
	}

	plist := render("Darwin")
	if strings.Contains(plist, "__POPCORN") {
		t.Errorf("rendered plist still has a template token:\n%s", plist)
	}
	if strings.Contains(plist, "template-only") {
		t.Error("the template's own documentation leaked into the rendered plist")
	}
	if !strings.Contains(plist, "<key>POPCORN_SMTP_LISTEN</key>") {
		t.Error("rendered plist has no SMTP face — that is the bug this file exists for")
	}
	// No certs exist under a fresh HOME, so the pair must be absent entirely
	// rather than present and pointing at nothing.
	if strings.Contains(plist, "POPCORN_TLS_CERT") {
		t.Error("rendered plist names a cert path that does not exist on this machine")
	}

	unit := render("Linux")
	if strings.Contains(unit, "__POPCORN") {
		t.Errorf("rendered systemd unit still has a template token:\n%s", unit)
	}
	if !strings.Contains(unit, "\nExecStart=/") {
		t.Error("rendered systemd unit has no absolute ExecStart")
	}
	if !strings.Contains(unit, "POPCORN_LISTEN=") {
		t.Error("rendered EnvironmentFile has no POPCORN_LISTEN")
	}
}

// The installer models five settings. popcorn has nine, and the other four are
// exactly the kind a machine acquires once and never mentions again — a DELE
// mode, a maildrop window, a pinned JMAP base. Rendering from a template drops
// whatever the template does not know about, so the renderer has to carry them
// across even under --force, where the operator has already said "replace it".
func TestUnmodelledSettingsSurviveARewrite(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "Library", "LaunchAgents"), 0o755); err != nil {
		t.Fatal(err)
	}
	unit := filepath.Join(home, "Library", "LaunchAgents", "cc.bullmoose.popcorn.plist")
	if err := os.WriteFile(unit, []byte(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>ProgramArguments</key>
    <array><string>`+home+`/bin/popcorn</string></array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>POPCORN_LISTEN</key><string>127.0.0.1:9995</string>
        <key>POPCORN_DELE_MODE</key><string>noop</string>
        <key>POPCORN_MAX_MESSAGES</key><string>500</string>
    </dict>
</dict>
</plist>
`), 0o600); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("sh", "install.sh", "--render")
	cmd.Env = append(os.Environ(), "POPCORN_FAKE_OS=Darwin", "HOME="+home)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("--render: %v", err)
	}
	for _, want := range []string{
		"<key>POPCORN_DELE_MODE</key><string>noop</string>",
		"<key>POPCORN_MAX_MESSAGES</key><string>500</string>",
	} {
		if !strings.Contains(string(out), want) {
			t.Errorf("rendered unit lost %s:\n%s", want, out)
		}
	}
}

// The systemd side reads /etc/popcorn/env, where the interesting failure is a
// commented-out line: reading `#POPCORN_TLS_CERT=…` as set would invent TLS
// that isn't there and then refuse to install because the file is missing.
func TestEnvFileReader(t *testing.T) {
	path := filepath.Join(t.TempDir(), "env")
	if err := os.WriteFile(path, []byte(
		"POPCORN_LISTEN=127.0.0.1:995\n#POPCORN_TLS_CERT=/etc/popcorn/cert.pem\n"+
			"POPCORN_SMTP_LISTEN=\"127.0.0.1:587\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	read := func(key string) string {
		out, err := exec.Command("sh", "-c",
			`. ./lib/plan.sh; envfile_get "$1" "$2"`, "sh", path, key).Output()
		if err != nil {
			t.Fatalf("envfile_get %s: %v", key, err)
		}
		return strings.TrimRight(string(out), "\n")
	}
	if got := read("POPCORN_LISTEN"); got != "127.0.0.1:995" {
		t.Errorf("POPCORN_LISTEN = %q", got)
	}
	if got := read("POPCORN_TLS_CERT"); got != "" {
		t.Errorf("commented POPCORN_TLS_CERT read as %q, want unset", got)
	}
	if got := read("POPCORN_SMTP_LISTEN"); got != "127.0.0.1:587" {
		t.Errorf("quoted POPCORN_SMTP_LISTEN = %q", got)
	}
}
