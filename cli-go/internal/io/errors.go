package bmio

import (
	"errors"
	"strings"
)

// The error side of the §1.5 contract: CliError already knows its exit code,
// ServerError carries whatever the server said (a JMAP type, an HTTP status),
// and ExitCodeFor is the single funnel every failure goes through — io.ts:157.

// CliError is an error that already knows what the process should exit with —
// io.ts:158. This is the Go home for io.ts's `e.exitCode` case (io.ts:186): a
// failure whose code the CLI decided itself, rather than one derived from a
// server signal.
type CliError struct {
	Msg  string
	Code ExitCode
}

func (e *CliError) Error() string { return e.Msg }

// ServerError carries the vocabulary a server answered with, duck-typed exactly
// like io.ts's `{ jmapType?, httpStatus? }` (io.ts:179). JMAPType == "" means
// "none"; HTTPStatus == 0 means "none".
type ServerError struct {
	Msg        string
	JMAPType   string
	HTTPStatus int
}

func (e *ServerError) Error() string { return e.Msg }

// ExitCodeFor is the single funnel every failure goes through — io.ts:177. The
// precedence is deliberate and load-bearing:
//
//	CliError                 → its own code, the CLI's own judgement
//	ServerError, known type  → the JMAP type, the most specific signal there is
//	ServerError, any status  → the HTTP status (io.ts:184): a type we do NOT
//	                           recognise must not short-circuit to 1 while a good
//	                           status sits beside it — the `blobInUse` on a 409
//	                           the contract suite exercises at contract.mjs:260
//	ServerError, only a type → ExitCodeForJMAPType (unknown → ExitFail)
//	anything else            → ExitFail
func ExitCodeFor(err error) ExitCode {
	var ce *CliError
	if errors.As(err, &ce) {
		return ce.Code
	}
	var se *ServerError
	if errors.As(err, &se) {
		if se.JMAPType != "" {
			if code, ok := jmapExit[se.JMAPType]; ok {
				return code
			}
		}
		if se.HTTPStatus != 0 {
			return ExitCodeForHTTPStatus(se.HTTPStatus)
		}
		if se.JMAPType != "" {
			return ExitCodeForJMAPType(se.JMAPType)
		}
	}
	return ExitFail
}

// ErrorMessage renders any error as a string — io.ts:191.
func ErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// The failure constructors, mirroring io.ts's throw helpers (io.ts:404-421).
// Go returns errors rather than throwing, so these build a *CliError the caller
// returns; a top-level Die (see emit.go) prints it and exits with its code.

// Fail aborts with a message and a code from the §1.5 table (io.ts:404).
func Fail(msg string, code ExitCode) *CliError { return &CliError{Msg: msg, Code: code} }

// Usage is a malformed invocation — always ExitUsage. The "usage:" prefix is
// added iff absent, exactly as io.ts:409 does.
func Usage(line string) *CliError {
	if !strings.HasPrefix(line, "usage:") {
		line = "usage: " + line
	}
	return &CliError{Msg: line, Code: ExitUsage}
}

// NotFound — the named thing is not there, always ExitNotFound (io.ts:414).
func NotFound(msg string) *CliError { return &CliError{Msg: msg, Code: ExitNotFound} }

// Conflict — a state/precondition refusal, always ExitConflict (io.ts:419).
func Conflict(msg string) *CliError { return &CliError{Msg: msg, Code: ExitConflict} }
