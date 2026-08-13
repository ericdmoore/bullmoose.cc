package cmd

// `bullmoose watch` — the push-triggered live sync (s08 T6 wave 4,
// devPlan.md:152). Unlike `approvals` and `agents`, this command HAS a
// TypeScript twin (packages/cli/src/watch.ts + main.ts:885 cmdWatch), so it is
// held to the byte-identity rule: the same status lines, the same human rows,
// the same --json event shapes, the same pidfile trio.
//
// It is the first native command that is simultaneously a live-server client, a
// mirror WRITER, and a long-running process. The three parts live where they can
// be tested on their own: internal/ws (the RFC 6455 client), internal/mirror
// (the sync engine and the changes cursor) and internal/watch (the loop, the
// event shapes and the --exec hook).

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/account"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/watch"
)

// runWatch is main.ts:885 cmdWatch: three management verbs that answer and
// return, then the loop that does not.
func runWatch(s *bmio.Streams, argv []string) int {
	a := parseWatch(argv)
	dbPath := store.DBPath(a.DB)
	paths := watch.PidPaths(dbPath)

	if a.Stop {
		return watchStop(s, a, paths)
	}
	if a.Status {
		return watchStatus(s, a, paths)
	}
	// DIVERGENCE from main.ts, deliberate: Node accepts `--exec ""` and then runs
	// `sh -c ""` once per message, forever, silently. Refusing it costs a
	// keystroke and cannot break a working invocation — no template that does
	// anything is empty.
	if a.HasExec && strings.TrimSpace(a.Exec) == "" {
		return die(s, bmio.Usage("--exec needs a command"))
	}

	db, err := store.Open(dbPath)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()
	// `watch` is the first native command that WRITES the mirror, and it fans out
	// across accounts, so two syncs can be in flight at once. node:sqlite gives
	// watch.ts one synchronous connection and therefore serializes those writes
	// for free; database/sql pools, so it does not. One connection restores the
	// TypeScript model exactly — and a CLI has nothing to gain from write
	// concurrency against a local file it is the only writer of.
	db.SetMaxOpenConns(1)
	settings, err := store.RequireSettings(db)
	if err != nil {
		return die(s, err)
	}
	// `watch` legitimately FANS OUT (db.ts:216 names it as such), so it resolves
	// through account.Select, not the single-account Pick. cli/009's rule is
	// about the commands that need exactly one account; this is not one.
	selected, err := account.Select(settings.Accounts, settings.AccountID, a.Account)
	if err != nil {
		return die(s, err)
	}

	// A --daemon parent writes the CHILD's pid before the child boots, so the
	// child finds its own pid here — that is us, not a rival watcher
	// (main.ts:915).
	if running := watch.ReadAlivePid(paths.Pid); running != 0 && running != os.Getpid() {
		return die(s, &bmio.CliError{
			Msg:  fmt.Sprintf("watcher already running (pid %d) — bullmoose watch --stop first", running),
			Code: bmio.ExitConflict,
		})
	}

	if a.Daemon {
		return watchDaemonize(s, a, dbPath, paths)
	}

	// Foreground. If we were spawned by --daemon our pid is already in the
	// pidfile; claim it for cleanup-on-exit either way.
	if err := watch.WritePid(paths.Pid, os.Getpid()); err != nil {
		return die(s, err)
	}
	defer func() { _ = os.Remove(paths.Pid) }()

	accounts := make([]watch.Account, len(selected))
	for i, acc := range selected {
		accounts[i] = watch.Account{ID: acc.AccountID, Label: account.Label(acc)}
	}

	// SIGINT/SIGTERM end the loop cleanly — sockets closed, pidfile removed,
	// exit 0 (watch.ts:190 shutdown).
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	w := watch.New(watch.Options{
		DB:       db,
		Client:   jmap.NewClient(settings.Base, settings.Token),
		Base:     settings.Base,
		Token:    settings.Token,
		Accounts: accounts,
		Out:      s,
		JSON:     a.JSON,
		Exec:     a.Exec,
	})
	if err := w.Run(ctx); err != nil {
		return die(s, err)
	}
	return 0
}

// watchStop is main.ts:889. A missing watcher is NOT an error: `watch --stop` in
// a teardown script must be idempotent, so it notes and exits 0.
func watchStop(s *bmio.Streams, a watchArgs, paths watch.Paths) int {
	pid := watch.ReadAlivePid(paths.Pid)
	if pid == 0 {
		s.Note("no watcher running")
		return 0
	}
	if err := terminate(pid); err != nil {
		return die(s, &bmio.CliError{
			Msg: fmt.Sprintf("could not signal watcher (pid %d): %v", pid, err), Code: bmio.ExitFail})
	}
	if a.JSON {
		if err := s.EmitJSON(stoppedJSON{Stopped: true, PID: pid}); err != nil {
			return die(s, err)
		}
		return 0
	}
	s.Out(fmt.Sprintf("stopped watcher (pid %d)", pid))
	return 0
}

// watchStatus is main.ts:901.
func watchStatus(s *bmio.Streams, a watchArgs, paths watch.Paths) int {
	pid := watch.ReadAlivePid(paths.Pid)
	if a.JSON {
		out := statusJSON{Running: pid != 0, Log: paths.Log}
		if pid != 0 {
			out.PID = &pid
		}
		if err := s.EmitJSON(out); err != nil {
			return die(s, err)
		}
		return 0
	}
	if pid != 0 {
		s.Out(fmt.Sprintf("watcher running (pid %d, log: %s)", pid, paths.Log))
		return 0
	}
	s.Note("no watcher running")
	return 0
}

// watchDaemonize re-execs THIS binary detached, minus --daemon, with the db
// pinned — main.ts:922. The Go version re-execs os.Executable() where Node
// re-execs `process.execPath argv[1]`; the shape is the same, and pinning --db
// matters for the same reason (the child must not re-resolve a relative default
// from a different working directory).
func watchDaemonize(s *bmio.Streams, a watchArgs, dbPath string, paths watch.Paths) int {
	self, err := os.Executable()
	if err != nil {
		return die(s, &bmio.CliError{Msg: "cannot find own executable: " + err.Error(), Code: bmio.ExitFail})
	}
	// The log carries senders and subjects, so it is owner-only, like the db.
	log, err := os.OpenFile(paths.Log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return die(s, &bmio.CliError{Msg: "cannot open " + paths.Log + ": " + err.Error(), Code: bmio.ExitFail})
	}
	defer log.Close()

	args := []string{"watch", "--db", dbPath}
	if a.JSON {
		args = append(args, "--json")
	}
	if a.HasExec {
		args = append(args, "--exec", a.Exec)
	}
	if a.Account != "" {
		args = append(args, "--account", a.Account)
	}
	child := exec.Command(self, args...) //nolint:gosec // our own path, our own flags
	child.Stdin = nil
	child.Stdout = log
	child.Stderr = log
	child.SysProcAttr = detachAttr()
	if err := child.Start(); err != nil {
		return die(s, &bmio.CliError{Msg: "could not start watcher: " + err.Error(), Code: bmio.ExitFail})
	}
	pid := child.Process.Pid
	// Release, or the parent's exit would leave the child parented to a process
	// that is waiting on it. The child re-parents to init.
	_ = child.Process.Release()
	if err := watch.WritePid(paths.Pid, pid); err != nil {
		return die(s, err)
	}
	if a.JSON {
		if err := s.EmitJSON(daemonJSON{Daemon: true, PID: pid, Log: paths.Log}); err != nil {
			return die(s, err)
		}
		return 0
	}
	s.Out(fmt.Sprintf("watch daemon started (pid %d, log: %s)", pid, paths.Log))
	s.Note("stop with: bullmoose watch --stop")
	return 0
}

// The three --json shapes, each in main.ts's own key order.
type (
	stoppedJSON struct {
		Stopped bool `json:"stopped"`
		PID     int  `json:"pid"`
	}
	statusJSON struct {
		Running bool   `json:"running"`
		PID     *int   `json:"pid"` // null when nothing is running (main.ts:904)
		Log     string `json:"log"`
	}
	daemonJSON struct {
		Daemon bool   `json:"daemon"`
		PID    int    `json:"pid"`
		Log    string `json:"log"`
	}
)

// ---- arg parsing ----------------------------------------------------------

// watchArgs is watch's flag view. Like approvals it owns its whole grammar,
// because the flags it reads (--exec/--daemon/--status/--stop) are outside the
// wave-1 shared set.
type watchArgs struct {
	JSON    bool
	Daemon  bool
	Status  bool
	Stop    bool
	DB      string
	Account string
	Exec    string
	// HasExec distinguishes `--exec ""` (a refused empty hook) from no --exec at
	// all, which is a silent watch.
	HasExec bool
}

func parseWatch(argv []string) watchArgs {
	var a watchArgs
	endOpts := false
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch {
		case endOpts:
		case arg == "--":
			endOpts = true
		case strings.HasPrefix(arg, "--"):
			name, inlineVal, inline := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
			value := func() string {
				if inline {
					return inlineVal
				}
				if i+1 < len(argv) {
					i++
					return argv[i]
				}
				return ""
			}
			switch name {
			case "json":
				a.JSON = true
			case "daemon":
				a.Daemon = true
			case "status":
				a.Status = true
			case "stop":
				a.Stop = true
			case "db":
				a.DB = value()
			case "account":
				a.Account = value()
			case "exec":
				a.Exec = value()
				a.HasExec = true
			}
		}
	}
	return a
}
