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
	"fmt"
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

// Pick resolves an --account selector to EXACTLY ONE account, or an error —
// packages/cli/src/db.ts:221 pickAccount, over the same matchAccounts
// fall-through Select uses.
//
// The rule, applied identically everywhere (cli/009): a selector that matches
// more than one account is an error, not a choice. `send` was in the old silent
// half, so `--account @domain` on a multi-account login picked a sender by
// enumeration order — and sending from the wrong identity is the one outcome you
// cannot undo. No match → ErrNoMatch (exit 3); more than one → ErrAmbiguous
// (exit 2); exactly one → that account.
//
// s08 T6 fills this seam the first time a SINGLE-ACCOUNT WRITE goes native
// (devPlan.md:151). `approvals` is that write — a per-account decision surface —
// so it routes here rather than duplicating account resolution and reintroducing
// exactly the inconsistency cli/009 closed. The returned errors WRAP the
// sentinels, so `errors.Is` still identifies them and the caller maps each to its
// exit code (ambiguous → usage/2, no match → not found/3).
func Pick(accounts []Account, selector string) (Account, error) {
	// Pick is the selector-PRESENT resolver; the no-selector default belongs to
	// the caller (db.ts:222), so an empty selector is treated as no match here.
	matches := match(accounts, "", selector)
	if len(matches) == 0 {
		have := make([]string, len(accounts))
		for i, a := range accounts {
			have[i] = Label(a)
		}
		return Account{}, fmt.Errorf("%w: --account %q (have: %s)",
			ErrNoMatch, selector, strings.Join(have, ", "))
	}
	if len(matches) > 1 {
		named := make([]string, len(matches))
		for i, a := range matches {
			named[i] = Label(a)
		}
		return Account{}, fmt.Errorf("%w: --account %q matches %d accounts; name one of: %s",
			ErrAmbiguous, selector, len(matches), strings.Join(named, ", "))
	}
	return matches[0], nil
}
