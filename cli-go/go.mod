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

require golang.org/x/term v0.45.0

require golang.org/x/sys v0.47.0 // indirect
