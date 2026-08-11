// Package bmio ports the Unix I/O contract from packages/cli/src/io.ts — the
// spec the cross-language acceptance gate (packages/cli/smoke/contract.mjs)
// actually tests. It is `.plans/s08-go-cli` T5: TTY detection, colour policy,
// --json framing, the broken-pipe guard, and the EXIT/JMAP_EXIT mapping from
// T1's committed vector (conformance/exit-codes.json). Every native command
// (s08 T6) sits on this.
//
// T5 is the substrate, not the wiring. It does NOT flip any command to native:
// delegate.native stays empty, main.go is untouched, and the contract suite
// stays 61/61 with the trace split at 0 native / N delegated (arch.md §3, §4).
// So nothing in the shipped binary imports this package yet; it is built and
// tested by `go ... ./...` regardless, and T6 imports it when it fills a seam.
//
// The package is named bmio, not io, so it does not shadow the standard
// library's io in the command packages that will consume it — those files use
// both `io.Writer` and this package's helpers, and one identifier cannot be two
// things. The directory stays internal/io to match devPlan.md:120.
package bmio
