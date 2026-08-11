package cmd

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/account"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// logRow is main.ts:1006 LogRow — one message row from the local mirror, shared
// by `log` and `search` because both funnel through printRows (main.ts:1174).
type logRow struct {
	id         string
	accountID  string
	subject    string
	fromJSON   string
	preview    string
	receivedAt int64
	seen       int64          // EXISTS(...) → 0 | 1
	mailboxes  sql.NullString // group_concat(...) → text | NULL
}

// rowJSON is the --json projection main.ts:1186 emits:
// `{ ...r, from: JSON.parse(r.from_json), from_json: undefined }`. So from_json
// is dropped, `from` is appended, and the key order is exactly the struct order
// below. `from` is the from_json bytes verbatim (RawMessage): db.ts stored them
// as JSON.stringify(from), and re-emitting them compact is byte-identical to
// Node's JSON.parse→JSON.stringify round-trip.
type rowJSON struct {
	ID         string          `json:"id"`
	AccountID  string          `json:"account_id"`
	Subject    string          `json:"subject"`
	Preview    string          `json:"preview"`
	ReceivedAt int64           `json:"received_at"`
	Seen       int64           `json:"seen"`
	Mailboxes  *string         `json:"mailboxes"`
	From       json.RawMessage `json:"from"`
}

// scanRows reads a *sql.Rows of the log/search shape into []logRow.
func scanRows(rows *sql.Rows) ([]logRow, error) {
	defer rows.Close()
	var out []logRow
	for rows.Next() {
		var r logRow
		if err := rows.Scan(&r.id, &r.accountID, &r.subject, &r.fromJSON,
			&r.preview, &r.receivedAt, &r.seen, &r.mailboxes); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// printRows renders a page of messages, main.ts:1174. §1.8 --ids outranks
// everything (the xargs shape); then §1.3 --json (one record per line, no
// wrapping array); then the human table. An empty human result writes NOTHING to
// stdout — "(no messages)" is chrome on stderr, so `log | wc -l` says 0
// (main.ts:1189, contract.mjs:145).
func printRows(s *bmio.Streams, rows []logRow, settings *store.Settings, ids, jsonOut bool) int {
	if ids {
		for _, r := range rows {
			s.Out(r.id)
		}
		return 0
	}
	if jsonOut {
		for _, r := range rows {
			mb := nullable(r.mailboxes)
			if err := s.EmitJSON(rowJSON{
				ID: r.id, AccountID: r.accountID, Subject: r.subject,
				Preview: r.preview, ReceivedAt: r.receivedAt, Seen: r.seen,
				Mailboxes: mb, From: json.RawMessage(r.fromJSON),
			}); err != nil {
				return die(s, err)
			}
		}
		return 0
	}
	if len(rows) == 0 {
		s.Note("(no messages)")
		return 0
	}
	showAccount := len(settings.Accounts) > 1
	for _, r := range rows {
		unread := "●" // ●
		if r.seen != 0 {
			unread = " "
		}
		date := time.UnixMilli(r.receivedAt).UTC().Format("2006-01-02 15:04")
		acct := ""
		if showAccount {
			acct = padTrunc(labelFor(settings, r.accountID), 24) + "  "
		}
		subject := r.subject
		if subject == "" {
			subject = "(no subject)"
		}
		s.Out(fmt.Sprintf("%s %s  %s%s  %s  [%s]  %s",
			unread, date, acct, padTrunc(joinFrom(r.fromJSON), 24),
			padTrunc(subject, 48), r.mailboxes.String, r.id))
	}
	return 0
}

// labelFor is main.ts:1176 — the account label for an id, falling back to the
// bare id for one not in settings.
func labelFor(settings *store.Settings, id string) string {
	for _, a := range settings.Accounts {
		if a.AccountID == id {
			return account.Label(a)
		}
	}
	return account.Label(account.Account{AccountID: id})
}

// joinFrom is `JSON.parse(from_json).map(a => a.name ?? a.email).join(", ")`
// (main.ts:1195): name when present (even ""), else email.
func joinFrom(fromJSON string) string {
	var addrs []struct {
		Name  *string `json:"name"`
		Email string  `json:"email"`
	}
	if err := json.Unmarshal([]byte(fromJSON), &addrs); err != nil {
		return ""
	}
	parts := make([]string, len(addrs))
	for i, a := range addrs {
		if a.Name != nil {
			parts[i] = *a.Name
		} else {
			parts[i] = a.Email
		}
	}
	return strings.Join(parts, ", ")
}

// padTrunc is JS `str.padEnd(w).slice(0, w)` — pad with spaces to width w, or
// truncate to w. Counted in runes; the mirror's content is ASCII, where a rune
// is one JS UTF-16 unit, so this matches main.ts:1200-1202 for the data the CLI
// actually holds.
func padTrunc(s string, w int) string {
	r := []rune(s)
	if len(r) >= w {
		return string(r[:w])
	}
	return s + strings.Repeat(" ", w-len(r))
}

// nullable turns a NULL group_concat into JSON null, else a *string.
func nullable(ns sql.NullString) *string {
	if !ns.Valid {
		return nil
	}
	return &ns.String
}
