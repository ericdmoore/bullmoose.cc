package cmd

import (
	"database/sql"
	"fmt"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/account"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// accountJSON is the --json row main.ts:521 builds, in this exact key order.
type accountJSON struct {
	AccountID string  `json:"accountId"`
	Address   *string `json:"address"`
	Name      *string `json:"name"`
	IsDefault bool    `json:"isDefault"`
	Messages  int64   `json:"messages"`
	State     *string `json:"state"`
	LastSync  *string `json:"lastSync"`
}

// runAccounts is `bullmoose accounts` (main.ts:508): every account this login can
// see, each with its local message count and last sync. It is the read-only
// identity command — the CLI's nearest thing to a "whoami" (there is no `whoami`
// subcommand). It ignores --account entirely, exactly as main.ts does. --ids
// short-circuits to the bare account ids before any per-account query.
func runAccounts(s *bmio.Streams, argv []string) int {
	a := parse(argv)
	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		return die(s, err)
	}
	defer db.Close()
	settings, err := store.RequireSettings(db)
	if err != nil {
		return die(s, err)
	}

	if a.IDs {
		for _, acc := range settings.Accounts {
			s.Out(acc.AccountID)
		}
		return 0
	}

	rows := make([]accountJSON, 0, len(settings.Accounts))
	for _, acc := range settings.Accounts {
		var emailState sql.NullString
		var lastSync sql.NullInt64
		_ = db.QueryRow("SELECT email_state, last_sync FROM sync_state WHERE account_id = ?", acc.AccountID).
			Scan(&emailState, &lastSync)
		var count int64
		if err := db.QueryRow("SELECT COUNT(*) AS n FROM emails WHERE account_id = ?", acc.AccountID).
			Scan(&count); err != nil {
			return die(s, err)
		}
		rows = append(rows, accountJSON{
			AccountID: acc.AccountID,
			Address:   optional(acc.Address),
			Name:      optional(acc.Name),
			IsDefault: acc.AccountID == settings.AccountID,
			Messages:  count,
			State:     nullable(emailState),
			LastSync:  isoOrNil(lastSync),
		})
	}

	if a.JSON {
		for _, r := range rows {
			if err := s.EmitJSON(r); err != nil {
				return die(s, err)
			}
		}
		return 0
	}

	for _, r := range rows {
		star := " "
		if r.IsDefault {
			star = "★" // ★
		}
		synced := "never synced"
		if r.LastSync != nil {
			// main.ts:536 — `synced ${lastSync.slice(0,16).replace("T"," ")}`.
			synced = "synced " + replaceT((*r.LastSync)[:16])
		}
		state := "-"
		if r.State != nil {
			state = *r.State
		}
		s.Out(fmt.Sprintf("%s %-28s %6d msgs  state=%s  %s  (%s)",
			star, humanLabel(r), r.Messages, state, synced, r.AccountID))
	}
	return 0
}

// humanLabel is main.ts:537 — address, else name, else the last 8 of the id.
func humanLabel(r accountJSON) string {
	if r.Address != nil {
		return *r.Address
	}
	if r.Name != nil {
		return *r.Name
	}
	return account.Label(account.Account{AccountID: r.AccountID})
}

// optional maps an absent ("") field to JSON null, as `a.address ?? null`
// (main.ts:523) does for a field the login discovery never set.
func optional(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}

// isoOrNil is `state?.last_sync ? new Date(...).toISOString() : null`
// (main.ts:528): a null OR zero timestamp is null, else the ISO-8601 string with
// millisecond precision and a literal Z, matching Date.prototype.toISOString.
func isoOrNil(ms sql.NullInt64) *string {
	if !ms.Valid || ms.Int64 == 0 {
		return nil
	}
	iso := time.UnixMilli(ms.Int64).UTC().Format("2006-01-02T15:04:05.000Z07:00")
	return &iso
}

// replaceT swaps the first 'T' for a space — the human date's T→" " (main.ts:536).
func replaceT(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] == 'T' {
			return s[:i] + " " + s[i+1:]
		}
	}
	return s
}
