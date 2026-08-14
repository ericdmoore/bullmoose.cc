package cmd

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/watch"
)

// The command layer of `watch`: the three management verbs (--status, --stop,
// --daemon), which are the parts a script drives and therefore the parts whose
// exact output is a contract. The loop itself is tested in internal/watch, where
// it can be driven against a real socket.

func runW(t *testing.T, argv ...string) (stdout, stderr string, code int) {
	t.Helper()
	out, errBuf := &bytes.Buffer{}, &bytes.Buffer{}
	code = runWatch(bmio.NewTo(out, errBuf), argv)
	return out.String(), errBuf.String(), code
}

// Test_WatchStatus_NoWatcher: "nothing is running" is not an error, and under
// --json it is a record with `pid: null` rather than an absent key — an agent
// branching on the field must find it.
func Test_WatchStatus_NoWatcher(t *testing.T) {
	db := filepath.Join(t.TempDir(), "mail.db")

	stdout, stderr, code := runW(t, "watch", "--db", db, "--status")
	if code != 0 {
		t.Errorf("exit %d, want 0 — no watcher is a state, not a failure", code)
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want nothing (the notice is chrome, §1.1)", stdout)
	}
	if !strings.Contains(stderr, "no watcher running") {
		t.Errorf("stderr = %q, want `no watcher running`", stderr)
	}

	stdout, _, code = runW(t, "watch", "--db", db, "--status", "--json")
	if code != 0 {
		t.Errorf("exit %d, want 0", code)
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(stdout)), &rec); err != nil {
		t.Fatalf("--json status is not JSON: %q", stdout)
	}
	if rec["running"] != false {
		t.Errorf("running = %#v, want false", rec["running"])
	}
	if pid, ok := rec["pid"]; !ok || pid != nil {
		t.Errorf("pid = %#v (present=%v), want an explicit null", pid, ok)
	}
	if rec["log"] != db+".watch.log" {
		t.Errorf("log = %#v, want %q", rec["log"], db+".watch.log")
	}
}

// Test_WatchStop_NoWatcher: `watch --stop` must be idempotent, because it lives
// in teardown scripts where a non-zero exit stops everything after it.
func Test_WatchStop_NoWatcher(t *testing.T) {
	db := filepath.Join(t.TempDir(), "mail.db")
	stdout, stderr, code := runW(t, "watch", "--db", db, "--stop")
	if code != 0 {
		t.Errorf("exit %d, want 0 — stopping nothing is not a failure", code)
	}
	if stdout != "" || !strings.Contains(stderr, "no watcher running") {
		t.Errorf("stdout=%q stderr=%q", stdout, stderr)
	}
}

// Test_WatchStatus_LiveWatcher uses THIS process as the "running watcher": its
// pid is real and alive, which is exactly what the liveness probe is for.
func Test_WatchStatus_LiveWatcher(t *testing.T) {
	db := filepath.Join(t.TempDir(), "mail.db")
	paths := watch.PidPaths(db)
	if err := watch.WritePid(paths.Pid, os.Getpid()); err != nil {
		t.Fatal(err)
	}

	stdout, _, code := runW(t, "watch", "--db", db, "--status")
	if code != 0 {
		t.Errorf("exit %d, want 0", code)
	}
	if !strings.Contains(stdout, "watcher running (pid ") {
		t.Errorf("stdout = %q, want main.ts:907's `watcher running (pid N, log: …)`", stdout)
	}

	stdout, _, _ = runW(t, "watch", "--db", db, "--status", "--json")
	var rec map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(stdout)), &rec); err != nil {
		t.Fatalf("not JSON: %q", stdout)
	}
	if rec["running"] != true || rec["pid"] != float64(os.Getpid()) {
		t.Errorf("status = %#v, want running with this pid", rec)
	}
}

// Test_StalePidfileIsSwept: a watcher killed by a reboot leaves a pidfile
// behind. Reporting it as running would make `watch` refuse to start forever,
// with no hint why.
func Test_StalePidfileIsSwept(t *testing.T) {
	db := filepath.Join(t.TempDir(), "mail.db")
	paths := watch.PidPaths(db)
	// A pid that cannot be running: the kernel's max is well under this.
	if err := os.WriteFile(paths.Pid, []byte("99999999\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if pid := watch.ReadAlivePid(paths.Pid); pid != 0 {
		t.Errorf("ReadAlivePid = %d, want 0 for a dead process", pid)
	}
	if _, err := os.Stat(paths.Pid); err == nil {
		t.Error("the stale pidfile was left behind; watch.ts:381 removes it")
	}
}

// Test_PidfileIsOwnerOnly: it sits beside a db holding a bearer token, and a
// world-writable pidfile is a way to make someone else's --stop signal a process
// of your choosing.
func Test_PidfileIsOwnerOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mail.db.watch.pid")
	if err := watch.WritePid(path, 1234); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("pidfile mode = %o, want 600 (watch.ts:390)", perm)
	}
}

// Test_WatchRefusesARivalWatcher: two watchers on one mirror double every
// notification and race each other's cursor writes. main.ts:918 makes it a
// CONFLICT (exit 5), not a generic failure — the command was right, the state
// refused it.
func Test_WatchRefusesARivalWatcher(t *testing.T) {
	// A configured mirror: main.ts:912 reads settings BEFORE the pidfile check,
	// so an unconfigured db would fail with usage(2) and never reach the rival
	// test at all.
	db := seedMirror(t, "http://127.0.0.1:1", "tok", "t_x__a_1")
	// A pid that is alive and is NOT us: our own parent, which is alive by
	// definition for as long as this test runs.
	if err := watch.WritePid(watch.PidPaths(db).Pid, os.Getppid()); err != nil {
		t.Fatal(err)
	}
	_, stderr, code := runW(t, "watch", "--db", db)
	if code != int(bmio.ExitConflict) {
		t.Errorf("exit %d, want %d (conflict)", code, bmio.ExitConflict)
	}
	if !strings.Contains(stderr, "watcher already running") {
		t.Errorf("stderr = %q, want main.ts:919's message", stderr)
	}
}

// Test_EmptyExecIsAUsageError: `--exec ""` is refused before anything connects,
// so the mistake costs a keystroke rather than a silent no-op per message.
func Test_EmptyExecIsAUsageError(t *testing.T) {
	db := filepath.Join(t.TempDir(), "mail.db")
	_, stderr, code := runW(t, "watch", "--db", db, "--exec", "")
	if code != int(bmio.ExitUsage) {
		t.Errorf("exit %d, want %d (usage)", code, bmio.ExitUsage)
	}
	if !strings.Contains(stderr, "--exec needs a command") {
		t.Errorf("stderr = %q", stderr)
	}
}

// Test_ParseWatch covers the flag grammar in the shapes a person types.
func Test_ParseWatch(t *testing.T) {
	cases := []struct {
		argv []string
		want watchArgs
	}{
		{[]string{"watch"}, watchArgs{}},
		{[]string{"watch", "--json"}, watchArgs{JSON: true}},
		{[]string{"watch", "--daemon", "--json"}, watchArgs{Daemon: true, JSON: true}},
		{[]string{"watch", "--stop"}, watchArgs{Stop: true}},
		{[]string{"watch", "--status"}, watchArgs{Status: true}},
		{[]string{"watch", "--db", "/tmp/x.db"}, watchArgs{DB: "/tmp/x.db"}},
		{[]string{"watch", "--db=/tmp/x.db"}, watchArgs{DB: "/tmp/x.db"}},
		{[]string{"watch", "--account", "@bullmoose.cc"}, watchArgs{Account: "@bullmoose.cc"}},
		{[]string{"watch", "--exec", "notify-send x"}, watchArgs{Exec: "notify-send x", HasExec: true}},
		{[]string{"watch", "--exec="}, watchArgs{Exec: "", HasExec: true}},
		// A hook template that starts with a dash is still the flag's VALUE.
		{[]string{"watch", "--exec", "--not-a-flag"}, watchArgs{Exec: "--not-a-flag", HasExec: true}},
	}
	for _, c := range cases {
		if got := parseWatch(c.argv); got != c.want {
			t.Errorf("parseWatch(%q) = %+v, want %+v", c.argv, got, c.want)
		}
	}
}

// Test_WatchIsRegisteredWithItsOwnFlags: the byte-identity guard delegates any
// invocation carrying a flag the native side does not declare, so a `watch`
// whose four flags were not registered would compile, pass every unit test, and
// silently never run natively.
func Test_WatchIsRegisteredWithItsOwnFlags(t *testing.T) {
	s, ok := registry["watch"]
	if !ok {
		t.Fatal("watch is not in the registry")
	}
	if s.goNative {
		t.Error("watch is marked goNative, but it HAS a Node twin (packages/cli/src/watch.ts) " +
			"— that flag would exempt it from byte-identity and stop it delegating unowned flags")
	}
	if !s.json {
		t.Error("watch honours --json (NDJSON events) and must claim it — cli/008")
	}
	want := map[string]bool{"exec": true}
	for _, f := range s.value {
		delete(want, f)
	}
	if len(want) > 0 {
		t.Errorf("watch does not declare value flag(s) %v", want)
	}
	wantBool := map[string]bool{"daemon": true, "status": true, "stop": true}
	for _, f := range s.boolean {
		delete(wantBool, f)
	}
	if len(wantBool) > 0 {
		t.Errorf("watch does not declare boolean flag(s) %v", wantBool)
	}
}
