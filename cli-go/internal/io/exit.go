package bmio

// The §1.5 exit codes and the error → code mappings, transcribed from
// packages/cli/src/io.ts. conformance/exit-codes.json (T1) is generated from
// the SAME TypeScript constants (io.ts:52 EXIT, :96 JMAP_EXIT), and exit_test.go
// makes that vector the oracle: if this Go map and the committed vector
// disagree, that is a red build across languages — the entire point of turning
// the coupling into a file both sides read (arch.md §5).

// ExitCode is one of the six public §1.5 codes. A script branches on them, so
// they may be added to but never redefined (io.ts:51).
type ExitCode int

const (
	// ExitOK — success (io.ts:53).
	ExitOK ExitCode = 0
	// ExitFail — generic failure: nothing more specific applies, or the server
	// broke, or the caller can do nothing about it (io.ts:55).
	ExitFail ExitCode = 1
	// ExitUsage — the command as typed cannot be valid (io.ts:57).
	ExitUsage ExitCode = 2
	// ExitNotFound — the named thing does not exist (io.ts:59).
	ExitNotFound ExitCode = 3
	// ExitAuth — not permitted, and no retype changes that (io.ts:61).
	ExitAuth ExitCode = 4
	// ExitConflict — a precondition or state check refused the write (io.ts:63).
	ExitConflict ExitCode = 5
)

// jmapExit maps a JMAP error type to an exit code — io.ts:96 JMAP_EXIT,
// transcribed verbatim including the reasoning that decides the hard cases
// (io.ts:80-95): overQuota is 1 not 2 (no phrasing fixes it), tooLarge is 2 (a
// smaller input does), mailboxHasEmail is 5 (the command was right, the folder's
// contents refused it). Anything unlisted falls to ExitFail (io.ts:95).
var jmapExit = map[string]ExitCode{
	// ---- method-level (RFC 8620 §3.6.2) ----
	"accountNotFound":             ExitNotFound,
	"accountNotSupportedByMethod": ExitUsage,
	"accountReadOnly":             ExitAuth,
	"anchorNotFound":              ExitNotFound,
	"cannotCalculateChanges":      ExitFail,
	"forbidden":                   ExitAuth,
	"invalidArguments":            ExitUsage,
	"invalidResultReference":      ExitUsage,
	"requestTooLarge":             ExitUsage,
	"serverFail":                  ExitFail,
	"serverPartialFail":           ExitFail,
	"serverUnavailable":           ExitFail,
	"stateMismatch":               ExitConflict,
	"unknownCapability":           ExitUsage,
	"unknownMethod":               ExitUsage,
	"unsupportedFilter":           ExitUsage,
	"unsupportedSort":             ExitUsage,

	// ---- request-level (RFC 8620 §3.6.1) ----
	"notJSON":    ExitUsage,
	"notRequest": ExitUsage,
	"limit":      ExitFail,

	// ---- SetError (RFC 8620 §5.3) ----
	"alreadyExists":     ExitConflict,
	"invalidPatch":      ExitUsage,
	"invalidProperties": ExitUsage,
	"notFound":          ExitNotFound,
	"overQuota":         ExitFail,
	"rateLimit":         ExitFail,
	"singleton":         ExitUsage,
	"tooLarge":          ExitUsage,
	"willDestroy":       ExitConflict,

	// ---- mail-specific SetError (RFC 8621) ----
	"blobNotFound":           ExitNotFound,
	"cannotUnsend":           ExitConflict,
	"invalidEmail":           ExitUsage,
	"mailboxHasChild":        ExitConflict,
	"mailboxHasEmail":        ExitConflict,
	"addressBookHasContents": ExitConflict,
	"tooManyKeywords":        ExitUsage,
	"tooManyMailboxes":       ExitUsage,
}

// ExitCodeForHTTPStatus is the same taxonomy for the CLI's non-JMAP HTTP
// endpoints (/auth, /api/…) — io.ts:144.
//
// Re-derived here rather than read from the vector, and deliberately so.
// conformance/exit-codes.json (T1) captured EXIT and JMAP_EXIT only; arch.md §5
// flagged this function as "Not in the T1 vector … Either extend the vector or
// record why the Go port re-derives it." Extending the vector means editing the
// TypeScript generator (conformance/vectors.ts) and regenerating — a T1-scoped
// change, whereas T5's remit is cli-go/ only (devPlan.md:120). The mapping is
// four branches over literal status numbers with no hidden data, so the Go-side
// table test in exit_test.go pinning every branch is a complete oracle. This is
// reported as a delta to fold into T5's devPlan notes.
func ExitCodeForHTTPStatus(status int) ExitCode {
	switch {
	case status == 401 || status == 403:
		return ExitAuth
	case status == 404:
		return ExitNotFound
	case status == 409 || status == 412 || status == 428:
		return ExitConflict
	case status >= 400 && status < 500:
		return ExitUsage
	default:
		return ExitFail
	}
}

// ExitCodeForJMAPType maps a JMAP error type to a code, falling to ExitFail for
// an empty or unlisted type — io.ts:152. The empty and unlisted fallbacks are
// pinned against the vector's absentJmapType / unlistedJmapType fields, because
// "unlisted falls to 1" is a rule a naive port silently gets wrong (arch.md §5).
func ExitCodeForJMAPType(typ string) ExitCode {
	if typ == "" {
		return ExitFail
	}
	if code, ok := jmapExit[typ]; ok {
		return code
	}
	return ExitFail
}
