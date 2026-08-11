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

import "errors"

// ErrNotImplemented marks the seam T6 has yet to fill. The cli/009 test treats
// it as "skip, for the right reason".
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

// Pick resolves an --account selector to EXACTLY ONE account, or an error.
//
// The rule, applied identically everywhere (cli/009): a selector that matches
// more than one account is an error, not a choice. `send` was in the old silent
// half, so `--account @domain` on a multi-account login picked a sender by
// enumeration order — and sending from the wrong identity is the one outcome you
// cannot undo. No match → ErrNoMatch (exit 3); more than one → ErrAmbiguous
// (exit 2); exactly one → that account.
//
// T6 implements this; until then it returns ErrNotImplemented so the test skips
// rather than passing for the wrong reason.
func Pick(accounts []Account, selector string) (Account, error) {
	return Account{}, ErrNotImplemented
}
