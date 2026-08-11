// Package cmd is where the native subcommands will live (s08 T6,
// `.plans/s08-go-cli/devPlan.md:116`).
//
// At T4 it holds only the seams that two closed `.feedback` findings must be
// tested against before the commands exist (`arch.md` §6). Each finding is
// fixed in TypeScript the Go port will never read, so a fresh implementation
// reintroduces it by default; the test therefore has to predate the code.
package cmd

import "errors"

// ErrNotImplemented marks a seam T6 has yet to fill. The cli/007 test treats it
// as "skip, for the right reason" rather than a satisfied assertion.
var ErrNotImplemented = errors.New("cli-go: native command not implemented (s08 T6)")

// spec describes what one native command can do. T6 registers entries; the map
// is empty now, exactly like delegate.native (`internal/delegate/delegate.go`),
// because every command still delegates.
type spec struct {
	// json is true when the command honours --json with machine-readable
	// output. cli/008: --json is a GLOBAL flag (packages/cli/src/help.ts
	// GLOBAL_OPTIONS) yet was a silent no-op on eight commands. The registry is
	// where "advertised" meets "implemented"; this bit must never claim support
	// the command does not actually deliver.
	json bool
}

// registry is the single source of truth for which commands this binary serves
// natively. Empty at T4.
var registry = map[string]spec{}

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
