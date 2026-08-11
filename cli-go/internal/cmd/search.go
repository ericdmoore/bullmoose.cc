package cmd

import (
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/account"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// runSearch is `bullmoose search` (main.ts:1052): a local FTS5 query over the
// populated cli_fts index, joined back to the emails page and rendered by the
// same printRows as `log`. The query is every positional after the command,
// space-joined (main.ts:1054).
func runSearch(s *bmio.Streams, argv []string) int {
	a := parse(argv)
	query := strings.Join(a.Positionals[1:], " ")
	if query == "" {
		// main.ts:1055 — the one required argument.
		return die(s, bmio.Usage("bullmoose search <fts5-query> [--account <sel>] [--json|--ids]"))
	}

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

	marks := placeholders(len(selected))
	params := make([]any, 0, len(selected)+1)
	for _, acc := range selected {
		params = append(params, acc.AccountID)
	}
	params = append(params, query)

	// main.ts:1067 — join cli_fts to emails, MATCH the query, rank order, cap 50.
	rows, err := db.Query(rowSelect+`
       FROM cli_fts f JOIN emails e ON e.id = f.email_id
       WHERE e.account_id IN (`+marks+`) AND cli_fts MATCH ?
       ORDER BY rank LIMIT 50`, params...)
	if err != nil {
		// A malformed FTS5 query (e.g. an unbalanced term) errors at query time,
		// before any row is written — so stdout stays empty and `search … | wc -l`
		// reports 0, exactly as the thrown SqliteError does in Node (die → exit 1,
		// contract.mjs:145).
		return die(s, err)
	}
	page, err := scanRows(rows)
	if err != nil {
		return die(s, err)
	}
	return printRows(s, page, settings, a.IDs, a.JSON)
}
