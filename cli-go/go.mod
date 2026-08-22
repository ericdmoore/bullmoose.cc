module github.com/ericdmoore/bullmoose.cc/cli-go

// One dependency, added at T5 and justified: golang.org/x/term (pulling
// golang.org/x/sys) is `isatty` on the real fd, needed by internal/io's colour
// policy (`.plans/s08-go-cli/arch.md` §3, io.ts:260). It is the idiomatic,
// correct terminal check — reimplementing the per-OS ioctl by hand is the
// "reimplement isatty badly" the task warns against, and the stdlib heuristic
// (os.ModeCharDevice) misreports /dev/null as a terminal. Both packages are pure
// Go with no cgo, so the single-static-binary and effortless cross-compile goals
// (arch.md §1) are preserved — verified building GOOS=linux and GOOS=windows.
// Everything else stays standard library; devPlan.md:156 still decides SQLite
// (modernc) at its own later task.
go 1.26

// The BUILD pin, which the `go` line above is not: that is a LANGUAGE
// FLOOR. Go ships security fixes in the statically-linked stdlib, so the
// toolchain that compiles a binary IS its patch level. Without this line
// a laptop build and a CI build can differ silently — which is exactly
// how the deployed popcorn ended up on go1.26.5 while 1.26.7 was current
// (#241). GOTOOLCHAIN fetches this automatically, so no local install
// has to match. Raise it on Go's schedule; raise the `go` floor only
// when a feature actually needs it.
toolchain go1.26.7

// goldmark (T6) renders `send --expandMD html`. Pure Go, no cgo, so the
// single-static-binary and cross-compile goals hold. It is here because the
// alternative was writing a Markdown parser, and the byte-identity contract
// that would have forced matching `marked` was deliberately loosened for this
// one path — see internal/markdown, and the golden corpus that replaced it.
require (
	github.com/yuin/goldmark v1.8.5
	golang.org/x/term v0.45.0
	modernc.org/sqlite v1.56.0
)

require (
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	golang.org/x/sys v0.47.0 // indirect
	modernc.org/libc v1.74.4 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.11.0 // indirect
)
