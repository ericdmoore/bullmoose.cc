package cmd

import (
	"database/sql"
	"fmt"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/account"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// mailboxJSON is the --json / --ids row main.ts:1160 builds: the SQL row
// `{ id, name, role, total }` with `account` (the account label) appended — so
// the key order is exactly this.
type mailboxJSON struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Role    *string `json:"role"`
	Total   int64   `json:"total"`
	Account string  `json:"account"`
}

// runMailboxes is `bullmoose mailboxes` (main.ts:1141) — a READ of the local
// mailbox mirror per account. Under --json/--ids the rows from every selected
// account accumulate and stream at the end; the human form prints inline, with a
// `# account` banner on stderr only when more than one account is in play
// (main.ts:1165, so awk reading columns never trips on it).
func runMailboxes(s *bmio.Streams, argv []string) int {
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
	selected, err := account.Select(settings.Accounts, settings.AccountID, a.Account)
	if err != nil {
		return die(s, err)
	}

	var all []mailboxJSON
	for _, acc := range selected {
		rows, err := db.Query(
			`SELECT m.id, m.name, m.role,
           (SELECT COUNT(*) FROM email_mailboxes em
            WHERE em.account_id = m.account_id AND em.mailbox_id = m.id) AS total
         FROM mailboxes m WHERE m.account_id = ? ORDER BY m.sort_order, m.name`,
			acc.AccountID)
		if err != nil {
			return die(s, err)
		}
		type mbRow struct {
			id, name string
			role     sql.NullString
			total    int64
		}
		var page []mbRow
		for rows.Next() {
			var r mbRow
			if err := rows.Scan(&r.id, &r.name, &r.role, &r.total); err != nil {
				rows.Close()
				return die(s, err)
			}
			page = append(page, r)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return die(s, err)
		}
		rows.Close()

		if a.JSON || a.IDs {
			label := account.Label(acc)
			for _, r := range page {
				all = append(all, mailboxJSON{
					ID: r.id, Name: r.name, Role: nullable(r.role),
					Total: r.total, Account: label,
				})
			}
			continue
		}
		if len(selected) > 1 {
			s.Note("# " + account.Label(acc))
		}
		for _, r := range page {
			role := "-"
			if r.role.Valid {
				role = r.role.String
			}
			s.Out(fmt.Sprintf("%-8s %5d  %s  (%s)", role, r.total, r.name, r.id))
		}
	}

	if a.IDs {
		for _, r := range all {
			s.Out(r.ID)
		}
	} else if a.JSON {
		for _, r := range all {
			if err := s.EmitJSON(r); err != nil {
				return die(s, err)
			}
		}
	}
	return 0
}
