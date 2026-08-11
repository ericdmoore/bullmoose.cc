package cmd

import (
	"math"
	"strconv"
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/account"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// rowSelect is the column list shared by `log` and `search` (main.ts:1037 and
// :1061 are identical): id, account, subject, from_json, preview, received_at,
// the $seen keyword as a 0/1, and the comma-joined mailbox roles/names.
const rowSelect = `SELECT e.id, e.account_id, e.subject, e.from_json, e.preview, e.received_at,
         EXISTS (SELECT 1 FROM email_keywords k WHERE k.account_id = e.account_id
                 AND k.email_id = e.id AND k.keyword = '$seen') AS seen,
         (SELECT group_concat(COALESCE(m.role, m.name)) FROM email_mailboxes em
            JOIN mailboxes m ON m.account_id = em.account_id AND m.id = em.mailbox_id
          WHERE em.account_id = e.account_id AND em.email_id = e.id) AS mailboxes`

// runLog is `bullmoose log` (main.ts:1017): the newest N messages from the local
// mirror, fanned across the accounts a selector matches, optionally filtered to
// one mailbox by role or id.
func runLog(s *bmio.Streams, argv []string) int {
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

	limit := limitFromN(a.N)
	marks := placeholders(len(selected))
	params := make([]any, 0, len(selected)+3)
	for _, acc := range selected {
		params = append(params, acc.AccountID)
	}
	mailboxClause := ""
	if a.Mailbox != "" {
		// main.ts:1026 — match a mailbox by role OR id, without joining the
		// whole page.
		mailboxClause = `AND EXISTS (
      SELECT 1 FROM email_mailboxes em JOIN mailboxes m
        ON m.account_id = em.account_id AND m.id = em.mailbox_id
      WHERE em.account_id = e.account_id AND em.email_id = e.id
        AND (m.role = ? OR m.id = ?))`
		params = append(params, a.Mailbox, a.Mailbox)
	}
	params = append(params, limit)

	rows, err := db.Query(rowSelect+`
       FROM emails e
       WHERE e.account_id IN (`+marks+`) `+mailboxClause+`
       ORDER BY e.received_at DESC LIMIT ?`, params...)
	if err != nil {
		return die(s, err)
	}
	page, err := scanRows(rows)
	if err != nil {
		return die(s, err)
	}
	return printRows(s, page, settings, a.IDs, a.JSON)
}

// limitFromN is `Number(opts.n) || 20` (main.ts:1020): a non-numeric or zero
// value falls back to 20, and a numeric one is used as the SQLite LIMIT.
func limitFromN(n string) int64 {
	f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
	if err != nil || f == 0 || math.IsNaN(f) {
		return 20
	}
	return int64(f)
}

// placeholders returns "?,?,...,?" with n marks (never empty here — a login
// always has at least one account).
func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat(",?", n)[1:]
}
