package mirror

import (
	"database/sql"
	"encoding/json"
	"strings"
)

// EventRow is one message as `watch` announces it — watch.ts:32 WatchRow. The
// watcher reads these from the MIRROR after a sync, never from the push payload:
// the push is a hint, so the row it announces is the row a `log` would show.
type EventRow struct {
	ID         string
	Subject    string
	FromJSON   json.RawMessage
	Preview    string
	ReceivedAt int64
	// Mailboxes is the comma-joined role/name list, or nil when the message is
	// in none (group_concat over an empty set is NULL).
	Mailboxes *string
}

// From is `JSON.parse(row.from_json).map(a => a.name ?? a.email).join(", ")`
// (watch.ts:266) — the display sender, and one of the attacker-controlled values
// a `--exec` hook receives.
func (r EventRow) From() string {
	addrs := ParseAddresses(r.FromJSON)
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

// EventRows loads the announced rows for a set of ids — watch.ts:255.
//
// The result is returned in the ORDER OF ids, not in whatever order SQLite
// returns them. watch.ts leans on those coinciding (rows freshly inserted in
// changes order come back in rowid order); saying so explicitly costs a map and
// removes a dependency on storage-layer luck.
func EventRows(db *sql.DB, accountID string, ids []string) ([]EventRow, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	marks := strings.TrimPrefix(strings.Repeat(",?", len(ids)), ",")
	params := make([]any, 0, len(ids)+1)
	params = append(params, accountID)
	for _, id := range ids {
		params = append(params, id)
	}
	rows, err := db.Query(`SELECT e.id, e.subject, e.from_json, e.preview, e.received_at,
           (SELECT group_concat(COALESCE(m.role, m.name)) FROM email_mailboxes em
              JOIN mailboxes m ON m.account_id = em.account_id AND m.id = em.mailbox_id
            WHERE em.account_id = e.account_id AND em.email_id = e.id) AS mailboxes
         FROM emails e WHERE e.account_id = ? AND e.id IN (`+marks+`)`, params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	found := make(map[string]EventRow, len(ids))
	for rows.Next() {
		var (
			r  EventRow
			fj string
			mb sql.NullString
		)
		if err := rows.Scan(&r.ID, &r.Subject, &fj, &r.Preview, &r.ReceivedAt, &mb); err != nil {
			return nil, err
		}
		r.FromJSON = json.RawMessage(fj)
		if mb.Valid {
			v := mb.String
			r.Mailboxes = &v
		}
		found[r.ID] = r
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]EventRow, 0, len(found))
	for _, id := range ids {
		if r, ok := found[id]; ok {
			out = append(out, r)
		}
	}
	return out, nil
}
