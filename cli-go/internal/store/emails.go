package store

import (
	"database/sql"
	"encoding/json"
	"time"
)

// The mirror's email rows: the one lookup `read` does against them, and the
// narrow write-back `send` does after a successful submission.
//
// This is the FIRST Go code that writes the mirror (wave 1 was read-only, see
// Open's note). It writes exactly the rows packages/cli/src/sync.ts:upsertOne
// writes, in the same order, so a row this produces is indistinguishable from one
// a `bullmoose sync` produced — decision 4 (devPlan.md:182) is "same file, same
// schema", and a second row shape would break `log`/`search` for whichever
// implementation did not write it.

// EmailProperties is sync.ts:15 EMAIL_PROPERTIES — the property set a mirror row
// is built from. Named here because the reconcile has to ask for exactly these.
var EmailProperties = []string{
	"id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt",
	"messageId", "inReplyTo", "from", "to", "cc", "bcc", "subject",
	"hasAttachment", "preview", "attachments",
}

// Address is one JMAP EmailAddress as the mirror stores it.
type Address struct {
	Name  *string `json:"name"`
	Email string  `json:"email"`
}

// Email is the JmapEmail shape sync.ts:35 mirrors. Pointer/slice fields are
// nullable on the wire, and the zero values below are the `?? []` / `?? ""`
// defaults upsertOne applies.
type Email struct {
	ID            string          `json:"id"`
	BlobID        string          `json:"blobId"`
	ThreadID      string          `json:"threadId"`
	MailboxIDs    map[string]bool `json:"mailboxIds"`
	Keywords      map[string]bool `json:"keywords"`
	Size          int64           `json:"size"`
	ReceivedAt    string          `json:"receivedAt"`
	MessageID     []string        `json:"messageId"`
	InReplyTo     []string        `json:"inReplyTo"`
	From          []Address       `json:"from"`
	To            []Address       `json:"to"`
	CC            []Address       `json:"cc"`
	BCC           []Address       `json:"bcc"`
	Subject       *string         `json:"subject"`
	HasAttachment bool            `json:"hasAttachment"`
	Preview       string          `json:"preview"`
	Attachments   []any           `json:"attachments"`
}

// OwnerOf returns the account a mirrored message belongs to, or "" when the id is
// not mirrored — main.ts:971's `SELECT account_id FROM emails WHERE id = ?`.
//
// `read` uses it to answer "which account is this id in?" without a selector, so
// an id copied out of a multi-account `log` reads back from the right account. A
// missing table (a mirror that has never synced) is "not mirrored", not an error,
// because the live Email/get below is the authority either way.
func OwnerOf(db *sql.DB, id string) string {
	var account string
	if err := db.QueryRow("SELECT account_id FROM emails WHERE id = ?", id).Scan(&account); err != nil {
		return ""
	}
	return account
}

// UpsertEmail writes one message into the mirror — a transcription of
// sync.ts:351 upsertOne, table for table and default for default.
//
// `send` calls it for the one id it just created, which is sync.ts:191
// reconcileEmails' contract ("call it with ONLY the ids the server reported, and
// ONLY after the write returns"). It deliberately does NOT touch sync_state: the
// cursor still points where it did, so the next real `sync` replays these
// changes rather than skipping them.
func UpsertEmail(db *sql.DB, accountID string, e Email) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	subject := ""
	if e.Subject != nil {
		subject = *e.Subject
	}
	hasAttachment := 0
	if e.HasAttachment {
		hasAttachment = 1
	}
	if _, err := tx.Exec(
		`INSERT OR REPLACE INTO emails (id, account_id, blob_id, thread_id, message_id, in_reply_to,
		   subject, from_json, to_json, cc_json, bcc_json, preview, size, received_at,
		   has_attachment, attachments_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		e.ID, accountID, e.BlobID, e.ThreadID, first(e.MessageID), first(e.InReplyTo),
		subject, addrJSON(e.From), addrJSON(e.To), addrJSON(e.CC), addrJSON(e.BCC),
		e.Preview, e.Size, parseMillis(e.ReceivedAt), hasAttachment, listJSON(e.Attachments),
	); err != nil {
		return err
	}

	if _, err := tx.Exec(`DELETE FROM email_mailboxes WHERE account_id = ? AND email_id = ?`,
		accountID, e.ID); err != nil {
		return err
	}
	for mb, on := range e.MailboxIDs {
		if !on {
			// JS iterates Object.keys, which includes a `false`. The server never
			// sends one, and mirroring a false as membership would be a lie.
			continue
		}
		if _, err := tx.Exec(
			`INSERT INTO email_mailboxes (account_id, email_id, mailbox_id) VALUES (?, ?, ?)`,
			accountID, e.ID, mb); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(`DELETE FROM email_keywords WHERE account_id = ? AND email_id = ?`,
		accountID, e.ID); err != nil {
		return err
	}
	for kw, on := range e.Keywords {
		if !on {
			continue
		}
		if _, err := tx.Exec(
			`INSERT INTO email_keywords (account_id, email_id, keyword) VALUES (?, ?, ?)`,
			accountID, e.ID, kw); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(`DELETE FROM cli_fts WHERE email_id = ?`, e.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT INTO cli_fts (email_id, subject, from_text, to_text, preview) VALUES (?, ?, ?, ?, ?)`,
		e.ID, subject, addrText(e.From), addrText(e.To), e.Preview); err != nil {
		return err
	}
	return tx.Commit()
}

// first is `e.messageId?.[0] ?? null` — the mirror keeps one, and a NULL rather
// than an empty string when there is none.
func first(v []string) any {
	if len(v) == 0 {
		return nil
	}
	return v[0]
}

// addrJSON is `JSON.stringify(e.from ?? [])`: an absent list mirrors as `[]`, not
// `null`, because main.ts:1156 JSON.parses the column unconditionally.
func addrJSON(list []Address) string {
	if list == nil {
		list = []Address{}
	}
	b, err := json.Marshal(list)
	if err != nil {
		return "[]"
	}
	return string(b)
}

func listJSON(list []any) string {
	if list == nil {
		list = []any{}
	}
	b, err := json.Marshal(list)
	if err != nil {
		return "[]"
	}
	return string(b)
}

// addrText is the FTS column: `${name ?? ""} ${email}` per address, space-joined
// (sync.ts:400).
func addrText(list []Address) string {
	out := ""
	for i, a := range list {
		if i > 0 {
			out += " "
		}
		name := ""
		if a.Name != nil {
			name = *a.Name
		}
		out += name + " " + a.Email
	}
	return out
}

// parseMillis is Date.parse: epoch millis, or NULL for an unparseable date (JS
// yields NaN, and SQLite stores that as NULL through node:sqlite).
func parseMillis(iso string) any {
	t, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		return nil
	}
	return t.UnixMilli()
}
