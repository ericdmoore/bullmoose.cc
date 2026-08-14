// Package cmd is where the native subcommands live (s08 T6,
// `.plans/s08-go-cli/devPlan.md:116`).
//
// Wave 1 (devPlan.md:135) fills the read-only / local-mirror commands:
// `mailboxes` ("mailbox list"), `search`, `log`, and `accounts` (the CLI's
// nearest thing to the plan's "whoami" — there is no `whoami` subcommand). Each
// reads packages/cli/src/db.ts's local SQLite mirror through internal/store and
// emits byte-identical output to the Node CLI via internal/io (bmio). Writes,
// login, token, watch and the vendored codecs are later waves.
//
// This package also still holds the T4 seams (cli/007, cli/008) that two closed
// `.feedback` findings are tested against (arch.md §6).
package cmd

import (
	"errors"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// ErrNotImplemented marks a seam T6 has yet to fill. The cli/007 test treats it
// as "skip, for the right reason" rather than a satisfied assertion.
var ErrNotImplemented = errors.New("cli-go: native command not implemented (s08 T6)")

// spec describes one native command: whether it honours --json (the cli/008
// capability bit), whether it is Go-native-only (no Node twin), which extra
// flags it owns beyond the shared wave-1 set, and the handler.
type spec struct {
	// json is true when the command honours --json with machine-readable
	// output. cli/008: --json is a GLOBAL flag (packages/cli/src/help.ts
	// GLOBAL_OPTIONS) yet was a silent no-op on eight commands. This bit must
	// never claim support the command does not actually deliver.
	json bool
	// goNative marks a command with NO TypeScript counterpart. Install wires such
	// a command through delegate.RegisterNativeOnly so Dispatch never delegates it
	// (Node has no such command) — the "byte-identical to Node" invariant does not
	// apply because there is nothing to match. `approvals` is the first (s08).
	goNative bool
	// valueFlags / boolFlags are the flags THIS command owns beyond the shared
	// wave-1 set (delegate/native.go). They matter only for a command with a Node
	// twin: the byte-identity guard delegates any invocation carrying a flag the
	// native side does not consume, so a ported command whose own flags were not
	// declared here would silently never run natively. Scoping them per command
	// rather than widening the shared set keeps `log --exec …` delegating to the
	// Node CLI that rejects it.
	valueFlags []string
	boolFlags  []string
	// run serves the command against the process streams, returning the exit
	// code. nil for a command listed for capability only.
	run func(s *bmio.Streams, argv []string) int
}

// registry is the single source of truth for which commands this binary serves
// natively. delegate.native is wired from exactly this set by Install, so routing
// and capability cannot drift apart.
//
//   - wave 1: four read-only local-mirror commands (mailboxes/search/log/accounts).
//   - approvals: Go-NATIVE-ONLY (s08) — the first command that talks to the LIVE
//     server (ActionProposal is not in the mirror). No Node twin, so it is
//     additive: the 61-case contract suite does not exercise it.
//   - agents: Go-NATIVE-ONLY (s10 T4) — the agent CONFIGURATION surface. Also
//     additive, and the first command on the CONTROL plane (the provision
//     worker's admin API) rather than the mail account's JMAP endpoint.
//   - watch: wave 4 (devPlan.md:152) and NOT Go-native-only — it has a Node twin
//     (packages/cli/src/watch.ts), so it is held to byte-identity and declares
//     its own four flags so the guard lets them through to this side.
var registry = map[string]spec{
	"mailboxes": {json: true, run: runMailboxes},
	"search":    {json: true, run: runSearch},
	"log":       {json: true, run: runLog},
	"accounts":  {json: true, run: runAccounts},
	"approvals": {json: true, goNative: true, run: runApprovals},
	"agents":    {json: true, goNative: true, run: runAgents},
	"watch": {
		json:       true,
		valueFlags: []string{"exec"},
		boolFlags:  []string{"daemon", "status", "stop"},
		run:        runWatch,
	},
}

// SupportsJSON reports whether the NATIVE command honours --json, and whether it
// is implemented at all. A command that still delegates is (false, false): the
// cli/008 test skips those rather than failing, because the requirement is about
// commands this binary actually serves — a delegated command's --json is the
// TypeScript CLI's job.
func SupportsJSON(command string) (jsonSupported, implemented bool) {
	s, ok := registry[command]
	if !ok {
		return false, false
	}
	return s.json, true
}

// Install wires every registered native command into the delegate's routing map
// (via the callbacks main.go passes). Each handler is bound to the process
// streams (bmio.New) at call time, so a broken-pipe mid-output exits 0 exactly as
// io.ts does. A goNative command is additionally registered as native-only, so
// Dispatch never delegates it. Keeping delegate.native derived from this registry
// is what keeps the routing table and the cli/008 capability table the same source.
func Install(
	register func(command string, run func(argv []string) int),
	registerNativeOnly func(command string),
) {
	InstallWithFlags(register, registerNativeOnly, nil)
}

// InstallWithFlags is Install plus the per-command flag declarations. main.go
// passes delegate.RegisterOwnedFlags; the two-function form is kept so existing
// callers and tests that only care about routing are unaffected.
func InstallWithFlags(
	register func(command string, run func(argv []string) int),
	registerNativeOnly func(command string),
	registerOwnedFlags func(command string, valueFlags, boolFlags []string),
) {
	for name, s := range registry {
		if s.run == nil {
			continue
		}
		run := s.run
		register(name, func(argv []string) int { return run(bmio.New(), argv) })
		if s.goNative {
			registerNativeOnly(name)
		}
		if registerOwnedFlags != nil && (len(s.valueFlags) > 0 || len(s.boolFlags) > 0) {
			registerOwnedFlags(name, s.valueFlags, s.boolFlags)
		}
	}
}
