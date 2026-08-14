package cmd

// `bullmoose show <emailId>` — one message from the LOCAL mirror, with its body
// fetched live (s08 T6 wave 5; a port of main.ts:1106 cmdShow).
//
// It is the sibling of `read` (read.go) and the two differ on purpose:
//
//	read   resolves the id LIVE (Email/query / Email/get), so it works before the
//	       first sync, and prints the SERVER's object under --json.
//	show   resolves the id in the MIRROR, so `log --ids | xargs show` never asks
//	       the server who owns an id it already knows, and prints the MIRROR ROW
//	       under --json — every column, in column order, plus `body`.
//
// Wave 1 stopped `show` and delegated it, correctly: it needs the live JMAP
// client for the body, which the mirror does not hold (devPlan.md:146). Both
// halves are here now.
//
// The account rule is cli/009 §A's fix and NOT `read`'s: `show` fans out over
// every account the selector allows (selectAccounts) rather than picking one,
// because `log` fans out by default — an id pasted from a multi-account `log`
// used to answer "not in local db (run: bullmoose sync)", which was simply false
// (main.ts:1111).

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/account"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// showProperties is main.ts:1146's property list, in that order. `show` asks for
// the BODY only — the metadata comes from the mirror row — which is why its
// --json object is the row's columns and not the server's Email properties.
var showProperties = []string{"bodyValues", "textBody"}

func runShow(s *bmio.Streams, argv []string) int {
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

	id := a.at(1)
	if id == "" {
		return die(s, bmio.Usage("bullmoose show <emailId> [--json]"))
	}

	// The fan-out selector, not Pick: see the header. A selector that matches
	// nothing is a NotFound here (db.ts:169), before any query.
	allowed, err := account.Select(settings.Accounts, settings.AccountID, a.Account)
	if err != nil {
		return die(s, err)
	}
	params := make([]any, 0, len(allowed)+1)
	params = append(params, id)
	for _, acc := range allowed {
		params = append(params, acc.AccountID)
	}
	row, err := selectEmailRow(db,
		"SELECT * FROM emails WHERE id = ? AND account_id IN ("+placeholders(len(allowed))+")", params)
	if err != nil {
		return die(s, err)
	}
	if row == nil {
		return die(s, showNotFound(db, settings, a, id))
	}

	accountID := row.str("account_id")

	// The body is fetched LIVE — the mirror stores metadata plus a preview.
	client := jmap.NewSessionClient(settings.Base, settings.Token)
	raw, err := client.One(context.Background(), "Email/get", emailGetArgs{
		AccountID:           accountID,
		IDs:                 []string{id},
		Properties:          showProperties,
		FetchTextBodyValues: true,
	}, jmap.MailUsing)
	if err != nil {
		return die(s, err)
	}
	var got struct {
		List []json.RawMessage `json:"list"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		return die(s, err)
	}
	// An empty list is NOT an error here, unlike `read`: main.ts:1149 reads
	// `list[0]` with `?.`, so a message the mirror knows and the server no longer
	// serves still prints its mirrored headers with "(no text body)".
	text := "(no text body)"
	if len(got.List) > 0 {
		fields, err := objectFields(got.List[0])
		if err != nil {
			return die(s, err)
		}
		text = firstBodyValue(fields["bodyValues"])
	}

	if a.IDs { // §1.8 — the xargs shape outranks everything
		s.EmitIDs([]string{id})
		return 0
	}
	if a.JSON {
		// §1.3: exactly ONE object, on ONE line — `{...row, body}`, so every
		// column the mirror holds is emitted IN COLUMN ORDER with `body` last.
		// The row is re-emitted rather than re-derived, which is why this walks
		// the driver's column list instead of a struct.
		if err := s.EmitJSON(append(row.fields, member{"body", text})); err != nil {
			return die(s, err)
		}
		return 0
	}

	s.Out("From:    " + joinShowFrom(row.str("from_json")))
	s.Out("Subject: " + row.jsString("subject"))
	s.Out("Date:    " + time.UnixMilli(row.int("received_at")).UTC().Format("2006-01-02T15:04:05.000Z"))
	s.Out("")
	s.Out(text)
	return 0
}

// showNotFound distinguishes "no such id" from "that id belongs to an account you
// did not select" — the second is a different mistake and deserves a different
// fix (main.ts:1124). Both are exit 3.
func showNotFound(db *sql.DB, settings *store.Settings, a args, id string) error {
	var owner string
	err := db.QueryRow("SELECT account_id FROM emails WHERE id = ?", id).Scan(&owner)
	if err == nil && owner != "" {
		ref := account.Account{AccountID: owner}
		for _, acc := range settings.Accounts {
			if acc.AccountID == owner {
				ref = acc
				break
			}
		}
		// `--account "${opts.account}"` interpolates an ABSENT selector as the
		// string "undefined", and this port says the same thing rather than a
		// tidier one — the sentence is the TypeScript's.
		selector := a.Account
		if !a.HasAccount {
			selector = "undefined"
		}
		return bmio.NotFound(id + " belongs to " + account.Label(ref) +
			`, which --account "` + selector + `" did not select`)
	}
	return bmio.NotFound(id + " not in local db (run: bullmoose sync)")
}

// joinShowFrom is main.ts:1161: `JSON.parse(row.from_json)` rendered as
// `Name <addr>` or the bare address. Unlike printRows' joinFrom (which prints the
// NAME alone), this is `read`'s formatting — the two views differ and the port
// keeps both.
func joinShowFrom(fromJSON string) string {
	return formatAddrs(json.RawMessage(fromJSON))
}

// ---- the mirror row, in column order ---------------------------------------

// sqlRow is one `SELECT *` row with its columns IN ORDER, so `--json` can emit
// `{...row}` the way node:sqlite's row object does: the statement's column order,
// with INTEGER columns as JSON numbers and NULLs as null.
//
// A `map[string]any` would have been the obvious Go shape and is exactly wrong —
// it sorts its keys on marshal, so `show --json` would emit `account_id` first
// and every downstream byte-comparison against the Node CLI would fail.
type sqlRow struct {
	fields ordered
}

func (r *sqlRow) raw(column string) any {
	for _, f := range r.fields {
		if f.key == column {
			return f.value
		}
	}
	return nil
}

func (r *sqlRow) str(column string) string {
	if s, ok := r.raw(column).(string); ok {
		return s
	}
	return ""
}

func (r *sqlRow) int(column string) int64 {
	switch v := r.raw(column).(type) {
	case int64:
		return v
	case float64:
		return int64(v)
	}
	return 0
}

// jsString is `String(row.col)` — a NULL column prints "null" and an absent one
// "undefined", exactly as the template literal in main.ts:1165 would.
func (r *sqlRow) jsString(column string) string {
	for _, f := range r.fields {
		if f.key != column {
			continue
		}
		if f.value == nil {
			return "null"
		}
		if s, ok := f.value.(string); ok {
			return s
		}
		encoded, err := jsonValue(f.value)
		if err != nil {
			return ""
		}
		return encoded
	}
	return "undefined"
}

// selectEmailRow runs a `SELECT *` and returns the first row with its columns in
// order, or nil for no rows.
func selectEmailRow(db *sql.DB, query string, params []any) (*sqlRow, error) {
	rows, err := db.Query(query, params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	if !rows.Next() {
		return nil, rows.Err()
	}
	cells := make([]any, len(columns))
	for i := range cells {
		cells[i] = new(any)
	}
	if err := rows.Scan(cells...); err != nil {
		return nil, err
	}
	row := &sqlRow{fields: make(ordered, len(columns))}
	for i, name := range columns {
		row.fields[i] = member{name, jsValueOf(*(cells[i].(*any)))}
	}
	return row, rows.Err()
}

// jsValueOf maps a driver value onto what node:sqlite hands JavaScript: TEXT and
// BLOB are strings, INTEGER and REAL are numbers, NULL is null.
func jsValueOf(v any) any {
	switch t := v.(type) {
	case []byte:
		// Left as a string: Go would otherwise marshal the bytes as base64,
		// where node:sqlite yields text for every column this mirror declares.
		return string(t)
	case nil:
		return nil
	default:
		return t
	}
}
