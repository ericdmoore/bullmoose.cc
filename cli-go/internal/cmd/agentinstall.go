package cmd

// `bullmoose agent install` / `uninstall` — the daemon offers to survive a
// reboot, opt-in (the s43 follow-on, Eric 2026-08-23). A foreground daemon
// that dies with the terminal is a free lane that quietly stops existing;
// a CLI that silently writes launchd plists is malware-shaped. The line
// between those is CONSENT, and this file inherits the managed-install
// posture whole: print EXACTLY what will be written and where, then one
// honest y/N, and the mutation still refuses over anything it did not
// write itself.
//
// The rules, from the spec:
//   - OPT-IN ONLY. `install` is typed; nothing offers it silently (the
//     end-of-first-serve offer is a later nicety, and its wording is
//     already fixed by the spec when it comes).
//   - Print the unit BEFORE writing it.
//   - REFUSE over an existing unit this tool did not write (the marker
//     below is how it knows its own); `uninstall` removes ONLY what
//     `install` created, and unloads before removing.
//   - Coexistence said aloud: boxes like alpaca carry hand-rolled
//     watchdogs that assume they own restart duty — the printout names
//     the conflict instead of fighting it at 2am.
//
// Graceful shutdown (the port's one named divergence) is what makes
// KeepAlive honest: a restart cycle completes the in-flight claim instead
// of stranding it.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// unitMarker is how install recognizes its own writing. It survives in the
// file verbatim (a plist comment / a systemd comment), so "ours" is a fact
// read from the file, never inferred from the path.
const unitMarker = "written by `bullmoose agent install` — safe to remove with `bullmoose agent uninstall`"

// installDeps carries the effects, injected so tests own the filesystem and
// no test ever runs launchctl (the local.go managed-install deps pattern).
type installDeps struct {
	goos    string
	home    string
	binary  func() (string, error)
	runLoad func(argv []string) error
}

func realInstallDeps() installDeps {
	home, _ := os.UserHomeDir()
	return installDeps{
		goos:   runtime.GOOS,
		home:   home,
		binary: os.Executable,
		runLoad: func(argv []string) error {
			cmd := exec.Command(argv[0], argv[1:]...)
			cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
			return cmd.Run()
		},
	}
}

// unitPlan is everything the human is shown before anything happens.
type unitPlan struct {
	path     string   // where the unit file lands
	contents string   // the unit, byte-for-byte
	load     []string // the loader command run after writing
	unload   []string // the command uninstall runs before removing
}

// planUnit renders the platform's unit for THIS binary and THIS fleet file.
// Absolute paths only: a login agent runs with no working directory worth
// trusting and no PATH worth searching.
func planUnit(d installDeps, fleetPath string) (*unitPlan, error) {
	bin, err := d.binary()
	if err != nil {
		return nil, fmt.Errorf("cannot resolve this binary's own path: %w", err)
	}
	fleet, err := filepath.Abs(fleetPath)
	if err != nil {
		return nil, err
	}
	switch d.goos {
	case "darwin":
		path := filepath.Join(d.home, "Library/LaunchAgents/cc.bullmoose.agent.plist")
		logPath := filepath.Join(d.home, "Library/Logs/bullmoose-agent.log")
		contents := `<?xml version="1.0" encoding="UTF-8"?>
<!-- ` + unitMarker + ` -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>cc.bullmoose.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>` + bin + `</string>
    <string>agent</string>
    <string>serve</string>
    <string>--fleet</string>
    <string>` + fleet + `</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>` + logPath + `</string>
  <key>StandardErrorPath</key><string>` + logPath + `</string>
</dict>
</plist>
`
		return &unitPlan{
			path:     path,
			contents: contents,
			load:     []string{"launchctl", "bootstrap", fmt.Sprintf("gui/%d", os.Getuid()), path},
			unload:   []string{"launchctl", "bootout", fmt.Sprintf("gui/%d", os.Getuid()) + "/cc.bullmoose.agent"},
		}, nil
	case "linux":
		path := filepath.Join(d.home, ".config/systemd/user/bullmoose-agent.service")
		contents := `# ` + unitMarker + `
[Unit]
Description=bullmoose agent daemon (claims and serves agent invocations)

[Service]
ExecStart=` + bin + ` agent serve --fleet ` + fleet + `
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
		return &unitPlan{
			path:     path,
			contents: contents,
			load:     []string{"systemctl", "--user", "enable", "--now", "bullmoose-agent.service"},
			unload:   []string{"systemctl", "--user", "disable", "--now", "bullmoose-agent.service"},
		}, nil
	default:
		return nil, fmt.Errorf("agent install supports macOS (launchd) and Linux (systemd --user); this is %s", d.goos)
	}
}

// foreignUnit answers whether path holds a unit SOMEONE ELSE wrote. Absent
// is not foreign; unreadable is (refusing on doubt is the whole point).
func foreignUnit(path string) (bool, error) {
	body, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return true, err
	}
	return !strings.Contains(string(body), unitMarker), nil
}

func runAgentInstall(s *bmio.Streams, a agentArgs, uninstall bool) int {
	return runAgentInstallWith(s, a, uninstall, realInstallDeps())
}

func runAgentInstallWith(s *bmio.Streams, a agentArgs, uninstall bool, d installDeps) int {
	if !uninstall && a.Fleet == "" {
		s.Note("usage: bullmoose agent install --fleet <path> — the daemon needs its fleet file")
		return 2
	}
	fleet := a.Fleet
	if fleet == "" {
		fleet = "unused-for-uninstall"
	} else if _, err := os.Stat(fleet); err != nil {
		s.Note("error: fleet file " + fleet + " is not readable — the unit would crash-loop on a file that is not there")
		return 2
	}
	plan, err := planUnit(d, fleet)
	if err != nil {
		return die(s, err)
	}

	foreign, err := foreignUnit(plan.path)
	if err != nil {
		return die(s, err)
	}
	if foreign {
		s.Note("error: " + plan.path + " already exists and was not written by this tool — refusing to touch it.")
		s.Note("If it is yours by hand, remove it yourself first; this verb only manages units it created.")
		return 1
	}

	if uninstall {
		if _, err := os.Stat(plan.path); os.IsNotExist(err) {
			s.Note("nothing installed at " + plan.path + " — nothing to remove")
			return 0
		}
		if err := d.runLoad(plan.unload); err != nil {
			// Unloading a stopped unit fails routinely; removal is the act
			// that matters, so say it and continue.
			s.Note("note: unload reported: " + err.Error() + " (continuing — the unit file is what keeps it returning)")
		}
		if err := os.Remove(plan.path); err != nil {
			return die(s, err)
		}
		s.Out("removed " + plan.path + " — the daemon will not return at next login")
		return 0
	}

	// The consent posture: the WHOLE unit, then one question. Nothing has
	// happened yet and the printout is the proof.
	s.Out("agent install would write " + plan.path + ":")
	s.Out("")
	for _, line := range strings.Split(strings.TrimRight(plan.contents, "\n"), "\n") {
		s.Out("  " + line)
	}
	s.Out("")
	s.Out("then load it with: " + strings.Join(plan.load, " "))
	s.Out("")
	s.Out("The daemon auto-starts when you log in and restarts if it dies (KeepAlive).")
	s.Out("If this box runs its own watchdogs that restart things (launchd jobs, cron loops),")
	s.Out("pick ONE owner of restart duty — two supervisors will fight over the corpse.")

	if !defaultConfirm(s, a.Yes)("\nAuto-start the agent at login so this computer helps defray cloud costs? [y/N] ") {
		s.Note("declined — nothing was written")
		return 1
	}

	if err := os.MkdirAll(filepath.Dir(plan.path), 0o755); err != nil {
		return die(s, err)
	}
	if err := os.WriteFile(plan.path, []byte(plan.contents), 0o644); err != nil {
		return die(s, err)
	}
	s.Out("wrote " + plan.path)
	if err := d.runLoad(plan.load); err != nil {
		s.Note("the unit is written but loading failed: " + err.Error())
		s.Note("load it by hand: " + strings.Join(plan.load, " "))
		return 1
	}
	s.Out("loaded — the daemon is running now and will return at every login.")
	s.Out("undo anytime: bullmoose agent uninstall")
	return 0
}
