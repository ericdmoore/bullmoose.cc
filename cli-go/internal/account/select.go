package account

import (
	"fmt"
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// Select is the FAN-OUT resolver — packages/cli/src/db.ts selectAccounts
// (db.ts:169) over matchAccounts (db.ts:186). It is deliberately NOT Pick
// (cli/009): `log`, `sync`, `search` and `mailboxes` legitimately act on MANY
// accounts, so a selector that matches several is a set, not the error it is for
// the single-account commands. db.ts:216 states this split outright — "it is
// correct for the commands that legitimately fan out (`log`, `sync`, `watch`)".
//
// So porting the wave-1 read commands exercises THIS function, not Pick, and the
// cli/009 seam (Pick) stays a skip until a single-account write command goes
// native. A no-match is a NotFound (exit 3); a match of any size is returned.
func Select(accounts []Account, defaultID, selector string) ([]Account, error) {
	matches := match(accounts, defaultID, selector)
	if len(matches) > 0 {
		return matches, nil
	}
	have := make([]string, len(accounts))
	for i, a := range accounts {
		// db.ts:174 lists `a.address ?? a.accountId` here — note NO name
		// fallback, unlike Label.
		if a.Address != "" {
			have[i] = a.Address
		} else {
			have[i] = a.AccountID
		}
	}
	return nil, bmio.NotFound(
		fmt.Sprintf("no account matches %q; have: %s", selector, strings.Join(have, ", ")),
	)
}

// match mirrors matchAccounts (db.ts:186): the ordered fall-through of
// undefined→all, "default"→the default, exact id/address, "@suffix" domain, then
// a loose substring over address (case-sensitive) / name (case-insensitive) / id.
func match(accounts []Account, defaultID, selector string) []Account {
	if selector == "" {
		return accounts
	}
	if selector == "default" {
		return filter(accounts, func(a Account) bool { return a.AccountID == defaultID })
	}
	if exact := filter(accounts, func(a Account) bool {
		return a.AccountID == selector || (a.Address != "" && a.Address == selector)
	}); len(exact) > 0 {
		return exact
	}
	if strings.HasPrefix(selector, "@") {
		if bySuffix := filter(accounts, func(a Account) bool {
			return a.Address != "" && strings.HasSuffix(a.Address, selector)
		}); len(bySuffix) > 0 {
			return bySuffix
		}
	}
	lower := strings.ToLower(selector)
	return filter(accounts, func(a Account) bool {
		// db.ts:198-203: address match is CASE-SENSITIVE (`a.address?.includes`),
		// name is case-insensitive, id is case-sensitive. The Turkish-i ToLower
		// divergence arch.md §5 warns about is the LOGIN SALT's problem, not this
		// selector's — this is a convenience match, not a credential.
		return (a.Address != "" && strings.Contains(a.Address, selector)) ||
			(a.Name != "" && strings.Contains(strings.ToLower(a.Name), lower)) ||
			strings.Contains(a.AccountID, selector)
	})
}

func filter(accounts []Account, keep func(Account) bool) []Account {
	var out []Account
	for _, a := range accounts {
		if keep(a) {
			out = append(out, a)
		}
	}
	return out
}

// Label is accountLabel (db.ts:242): the short human handle for an account —
// address, else name, else the last 8 of the id.
func Label(a Account) string {
	if a.Address != "" {
		return a.Address
	}
	if a.Name != "" {
		return a.Name
	}
	if len(a.AccountID) <= 8 {
		return a.AccountID
	}
	return a.AccountID[len(a.AccountID)-8:]
}
