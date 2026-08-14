// Package account is the ONE account-resolution rule (s08 T6).
//
// cli/009 (`.feedback/fromClaude/cli/009`) was exactly this rule not existing:
// packages/cli/src/db.ts's selectAccounts matched by substring and returned a
// set, and half the CLI silently took the first match while the other half
// refused. The TypeScript fix promoted the strict resolver into one function,
// pickAccount (db.ts:221), and routed every single-account command through it.
// The Go port keeps that shape: every command that needs exactly one account
// calls Pick, so a selector means the same thing everywhere.
package account

import (
	"errors"
	"strconv"
	"strings"
)

// ErrNotImplemented marked the seam before T6 filled it. Kept exported because
// the cli/009 regression test still references it; Pick no longer returns it.
var ErrNotImplemented = errors.New("cli-go: native account resolution not implemented (s08 T6)")

// The two failure modes, distinguished because they map to different exit codes
// (`.plans/s05-cli-crud/arch.md` §1.5, packages/cli/src/io.ts EXIT): an
// ambiguous selector is a USAGE error (exit 2) — the user must name one; no
// match is NOT FOUND (exit 3).
var (
	ErrAmbiguous = errors.New("--account selector matches more than one account")
	ErrNoMatch   = errors.New("--account selector matches no account")
)

// Account is the minimal shape Pick resolves over. Mirrors AccountRef in
// packages/cli/src/db.ts.
type Account struct {
	AccountID string
	Address   string
	Name      string
}

// resolveError carries the TypeScript sentence VERBATIM while still wrapping the
// sentinel a caller maps to an exit code.
//
// It exists because `read` and `send` have TypeScript twins, so their refusals
// are held to byte-identity (arch.md §3) — a Go-phrased "--account selector
// matches no account: …" would be a different sentence for the same event. The
// sentinel travels via Unwrap so `errors.Is` still works and the exit-code
// mapping is unchanged.
type resolveError struct {
	msg  string
	kind error
}

func (e *resolveError) Error() string { return e.msg }
func (e *resolveError) Unwrap() error { return e.kind }

// One resolves an --account selector to EXACTLY ONE account — a transcription of
// packages/cli/src/db.ts:221 pickAccount, including the fall-through to
// selectAccounts (db.ts:169) for the refusals and their exact wording.
//
// The rule, applied identically everywhere (cli/009): a selector that matches
// more than one account is an error, not a choice. `send` was in the old silent
// half, so `--account @domain` on a multi-account login picked a sender by
// enumeration order — and sending from the wrong identity is the one outcome you
// cannot undo. No selector → the DEFAULT account (db.ts:222, and the reason
// defaultID is a parameter rather than a caller's special case); no match →
// ErrNoMatch (exit 3); more than one → ErrAmbiguous (exit 2).
//
// The two messages are quoted from db.ts rather than re-phrased:
//
//	no match   → `no account matches "x"; have: a, b`              (db.ts:174)
//	ambiguous  → `--account "x" matches 2 accounts; name one of:\n  a\n  b`
//	             prefixed `usage: ` by the caller's usage() (db.ts:225)
func One(accounts []Account, defaultID, selector string) (Account, error) {
	if selector == "" {
		// db.ts:222 — the default account, or a bare ref when the accounts blob
		// predates it.
		for _, a := range accounts {
			if a.AccountID == defaultID {
				return a, nil
			}
		}
		return Account{AccountID: defaultID}, nil
	}
	matches := match(accounts, defaultID, selector)
	if len(matches) == 0 {
		// db.ts:174, reached through selectAccounts: `a.address ?? a.accountId`,
		// with NO name fallback (unlike Label).
		have := make([]string, len(accounts))
		for i, a := range accounts {
			have[i] = a.Address
			if have[i] == "" {
				have[i] = a.AccountID
			}
		}
		return Account{}, &resolveError{
			kind: ErrNoMatch,
			msg:  "no account matches \"" + selector + "\"; have: " + strings.Join(have, ", "),
		}
	}
	if len(matches) > 1 {
		// db.ts:225 — one candidate per line, two-space indented, so a long list
		// stays readable. The caller adds the `usage: ` prefix (bmio.Usage).
		var b strings.Builder
		b.WriteString("--account \"" + selector + "\" matches " +
			strconv.Itoa(len(matches)) + " accounts; name one of:")
		for _, a := range matches {
			label := a.Address
			if label == "" {
				label = a.AccountID
			}
			b.WriteString("\n  " + label)
		}
		return Account{}, &resolveError{kind: ErrAmbiguous, msg: b.String()}
	}
	return matches[0], nil
}

// Pick is One without a default — the selector-PRESENT form the cli/009
// regression test drives. It exists so there is exactly ONE resolver body; a
// second implementation is precisely what cli/009 was.
func Pick(accounts []Account, selector string) (Account, error) {
	return One(accounts, "", selector)
}
