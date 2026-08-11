package delegate

import (
	"fmt"
	"io"
	"os"
)

// The seam has to be observable, or the acceptance gate answers the wrong
// question. `arch.md` §4: "Without it a passing contract run cannot distinguish
// 'the Go implementation is correct' from 'the Go implementation does not exist
// yet', which is the one question the suite is being used to answer."
//
// Hence one line per invocation, on **stderr** so it cannot corrupt piped
// stdout — every §1.3 case in `packages/cli/smoke/contract.mjs` parses stdout as
// NDJSON, and a trace byte on that stream would break them all.

const (
	envTrace = "BULLMOOSE_TRACE"
	// envTraceFile is an additional, append-only sink for the same line.
	//
	// It exists because stderr alone cannot be counted: over twenty cases in
	// `packages/cli/smoke/contract.mjs` run the CLI as `$BM … 2>/dev/null`, and
	// the harness swallows the stderr of the rest, so a suite run reports no
	// split at all. T3 has to publish that split as the port's progress metric
	// (`devPlan.md:77`), so:
	//
	//	BULLMOOSE_TRACE_FILE=/tmp/split.log npm run -w @bullmoose/cli smoke
	//	grep -c 'bullmoose: delegated' /tmp/split.log
	//
	// It never replaces stderr, it only adds to it. Appends are O_APPEND and
	// one short line, so the concurrent invocations `xargs` produces interleave
	// safely rather than tearing.
	envTraceFile = "BULLMOOSE_TRACE_FILE"
)

// traceEnabled treats the usual "off" spellings as off so that
// `BULLMOOSE_TRACE=0` in a shell profile does not switch tracing on. Anything
// else counts as on: the plan documents `=1`, and being strict about the value
// would only produce silent no-ops.
func traceEnabled(v string) bool {
	switch v {
	case "", "0", "false", "no", "off":
		return false
	}
	return true
}

// traceLine is the wire format, in one place so T3 can count it:
//
//	bullmoose: delegated log
//
// `grep -c 'bullmoose: delegated'` over a contract run is the port's progress
// metric (`devPlan.md:77`, `:123`).
func traceLine(disposition, command string) string {
	if command == "" {
		command = "(none)"
	}
	return fmt.Sprintf("bullmoose: %s %s\n", disposition, command)
}

// Trace reports how one invocation was served. Called before the work starts,
// so a command that hangs or is killed still leaves its disposition behind.
func Trace(w io.Writer, disposition, command string) {
	line := traceLine(disposition, command)
	if traceEnabled(os.Getenv(envTrace)) {
		_, _ = io.WriteString(w, line)
	}
	if path := os.Getenv(envTraceFile); path != "" {
		// Silent on failure: an unwritable trace path is an observability
		// problem, and turning it into a command failure would make the
		// measurement change the thing being measured.
		if f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			_, _ = io.WriteString(f, line)
			_ = f.Close()
		}
	}
}
