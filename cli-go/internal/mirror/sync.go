// Package mirror is the sync engine — the Go port of packages/cli/src/sync.ts.
//
// It is what `watch` actually does with a push. `watch.ts`'s design note is the
// whole architecture and it is preserved here verbatim in behaviour:
//
//	PUSH IS A HINT, THE CHANGELOG IS THE TRUTH.
//
// A StateChange never carries data and is never interpreted. Every hint just
// triggers the ordinary incremental sync off the LOCAL CURSOR
// (sync_state.email_state), so a missed push is harmless and a duplicated push
// is a no-op: the second Email/changes from the advanced cursor returns nothing.
// That single property is what makes reconnect-and-resume correct rather than
// hopeful — the socket carries no state, so dropping it loses nothing.
//
// The package name is `mirror`, not `sync`, so files here can still use the
// standard library's sync package.
package mirror

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
)

// emailProperties is the Email/get property list sync.ts:15 asks for. Kept
// identical so the Go mirror rows are byte-for-byte the ones a Node sync writes
// (devPlan.md decision 4: same file, same schema).
var emailProperties = []string{
	"id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt",
	"messageId", "inReplyTo", "from", "to", "cc", "bcc", "subject",
	"hasAttachment", "preview", "attachments",
}

// changesPageSize is sync.ts:274's maxChanges. Paging is not an optimisation
// here: hasMoreChanges is how the server says "your cursor moved but there is
// more", and a client that ignored it would skip mail.
const changesPageSize = 512

// fullPageSize is sync.ts:313's Email/query page.
const fullPageSize = 100

// Address is one JMAP EmailAddress, for the places the CLI RENDERS a name (the
// FTS text and the watch event line). The stored column keeps the server's own
// bytes instead — see Email.From.
type Address struct {
	Name  *string `json:"name"`
	Email string  `json:"email"`
}

// Email is the subset of the JMAP Email object the mirror stores — sync.ts:35.
//
// The four address lists and `attachments` are held as RAW JSON on purpose:
// db.ts stores `JSON.stringify(from)` and cmd/rows.go re-emits that column
// verbatim under --json, so passing the server's bytes straight through is both
// simpler and byte-identical to what a Node sync writes. Re-marshalling a
// struct would silently reorder keys.
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
	From          json.RawMessage `json:"from"`
	To            json.RawMessage `json:"to"`
	CC            json.RawMessage `json:"cc"`
	BCC           json.RawMessage `json:"bcc"`
	Subject       *string         `json:"subject"`
	HasAttachment bool            `json:"hasAttachment"`
	Preview       string          `json:"preview"`
	Attachments   json.RawMessage `json:"attachments"`
}

// Stats is SyncStats (sync.ts:55). The *Ids slices are incremental-mode only:
// a full resync leaves them empty on purpose, so a first sync does not
// "announce" the whole mailbox as new mail (sync.ts:62).
type Stats struct {
	Mode         string
	Mailboxes    int
	Created      int
	Updated      int
	Destroyed    int
	NewState     string
	CreatedIDs   []string
	UpdatedIDs   []string
	DestroyedIDs []string
}

// Mailbox is the mirrored mailbox row — sync.ts:138 MirroredMailbox.
type Mailbox struct {
	ID        string  `json:"id"`
	ParentID  *string `json:"parentId"`
	Name      string  `json:"name"`
	Role      *string `json:"role"`
	SortOrder int64   `json:"sortOrder"`
}

// Cursor reads the account's stored Email state — the resume point. "" means
// never synced, which sends the next pass down the full-resync path.
func Cursor(db *sql.DB, accountID string) (string, error) {
	var state sql.NullString
	err := db.QueryRow("SELECT email_state FROM sync_state WHERE account_id = ?", accountID).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return state.String, nil
}

// Sync is sync.ts:198 — refresh the mailbox mirror, then advance the email
// mirror from the stored cursor, then commit the new cursor.
//
// The cursor is written ONCE, at the end, and only from the state the server
// reported. That ordering is the resume contract: a pass that dies mid-flight
// leaves the old cursor in place, so the next pass replays the same window
// rather than skipping it. Replaying is safe (INSERT OR REPLACE); skipping is
// not recoverable.
func Sync(ctx context.Context, db *sql.DB, client *jmap.Client, accountID string) (*Stats, error) {
	mailboxes, mailboxState, err := RefreshMailboxes(ctx, db, client, accountID)
	if err != nil {
		return nil, err
	}
	cursor, err := Cursor(db, accountID)
	if err != nil {
		return nil, err
	}

	stats := &Stats{Mode: "full", Mailboxes: len(mailboxes), NewState: "0"}
	if cursor != "" {
		stats.Mode = "incremental"
		if err := incremental(ctx, db, client, accountID, cursor, stats); err != nil {
			// cannotCalculateChanges is the server saying "your cursor is too old
			// to replay" — the one error that is not a failure but an instruction
			// (sync.ts:228).
			if !isCannotCalculateChanges(err) {
				return nil, err
			}
			stats.Mode = "full"
			stats.CreatedIDs, stats.UpdatedIDs, stats.DestroyedIDs = nil, nil, nil
			stats.Created, stats.Updated, stats.Destroyed = 0, 0, 0
			if err := fullResync(ctx, db, client, accountID, stats); err != nil {
				return nil, err
			}
		}
	} else if err := fullResync(ctx, db, client, accountID, stats); err != nil {
		return nil, err
	}

	if _, err := db.ExecContext(ctx,
		`INSERT INTO sync_state (account_id, email_state, mailbox_state, last_sync)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET
           email_state = excluded.email_state,
           mailbox_state = excluded.mailbox_state,
           last_sync = excluded.last_sync`,
		accountID, stats.NewState, mailboxState, nowMillis()); err != nil {
		return nil, err
	}
	return stats, nil
}

// RefreshMailboxes rewrites the mailbox mirror in full — sync.ts:155. A blind
// DELETE + re-INSERT rather than a merge, because Mailbox/set can DESTROY a
// mailbox and an incremental merge would leave the dead row behind.
func RefreshMailboxes(ctx context.Context, db *sql.DB, client *jmap.Client, accountID string) ([]Mailbox, string, error) {
	raw, err := client.One(ctx, "Mailbox/get",
		map[string]any{"accountId": accountID, "ids": nil}, jmap.MailUsing)
	if err != nil {
		return nil, "", err
	}
	var got struct {
		List  []Mailbox `json:"list"`
		State string    `json:"state"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		return nil, "", err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "DELETE FROM mailboxes WHERE account_id = ?", accountID); err != nil {
		return nil, "", err
	}
	for _, m := range got.List {
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO mailboxes (id, account_id, parent_id, name, role, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
			m.ID, accountID, m.ParentID, m.Name, m.Role, m.SortOrder); err != nil {
			return nil, "", err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, "", err
	}
	return got.List, got.State, nil
}

// incremental is sync.ts:261: page Email/changes from the cursor until the
// server stops saying hasMoreChanges.
func incremental(ctx context.Context, db *sql.DB, client *jmap.Client, accountID, cursor string, stats *Stats) error {
	since := cursor
	for {
		raw, err := client.One(ctx, "Email/changes", map[string]any{
			"accountId":  accountID,
			"sinceState": since,
			"maxChanges": changesPageSize,
		}, jmap.MailUsing)
		if err != nil {
			return err
		}
		var ch struct {
			Created        []string `json:"created"`
			Updated        []string `json:"updated"`
			Destroyed      []string `json:"destroyed"`
			NewState       string   `json:"newState"`
			HasMoreChanges bool     `json:"hasMoreChanges"`
		}
		if err := json.Unmarshal(raw, &ch); err != nil {
			return err
		}
		if err := upsertEmails(ctx, db, client, accountID, append(append([]string{}, ch.Created...), ch.Updated...)); err != nil {
			return err
		}
		for _, id := range ch.Destroyed {
			if err := deleteEmail(ctx, db, accountID, id); err != nil {
				return err
			}
		}
		stats.Created += len(ch.Created)
		stats.Updated += len(ch.Updated)
		stats.Destroyed += len(ch.Destroyed)
		stats.CreatedIDs = append(stats.CreatedIDs, ch.Created...)
		stats.UpdatedIDs = append(stats.UpdatedIDs, ch.Updated...)
		stats.DestroyedIDs = append(stats.DestroyedIDs, ch.Destroyed...)
		stats.NewState = ch.NewState

		if !ch.HasMoreChanges {
			return nil
		}
		since = ch.NewState
	}
}

// fullResync is sync.ts:296: drop this account's rows and re-page the whole
// mailbox. The state is snapshotted BEFORE paging so concurrent changes are
// caught by the next incremental pass instead of silently skipped.
func fullResync(ctx context.Context, db *sql.DB, client *jmap.Client, accountID string, stats *Stats) error {
	for _, stmt := range []string{
		"DELETE FROM emails WHERE account_id = ?",
		"DELETE FROM email_mailboxes WHERE account_id = ?",
		"DELETE FROM email_keywords WHERE account_id = ?",
	} {
		if _, err := db.ExecContext(ctx, stmt, accountID); err != nil {
			return err
		}
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM cli_fts"); err != nil {
		return err
	}

	first, err := client.One(ctx, "Email/query",
		map[string]any{"accountId": accountID, "position": 0, "limit": 1}, jmap.MailUsing)
	if err != nil {
		return err
	}
	var head struct {
		QueryState string `json:"queryState"`
	}
	if err := json.Unmarshal(first, &head); err != nil {
		return err
	}
	stats.NewState = head.QueryState

	for position := 0; ; position += fullPageSize {
		raw, err := client.One(ctx, "Email/query", map[string]any{
			"accountId": accountID,
			"position":  position,
			"limit":     fullPageSize,
			"sort":      []any{map[string]any{"property": "receivedAt", "isAscending": true}},
		}, jmap.MailUsing)
		if err != nil {
			return err
		}
		var page struct {
			IDs []string `json:"ids"`
		}
		if err := json.Unmarshal(raw, &page); err != nil {
			return err
		}
		if len(page.IDs) == 0 {
			return nil
		}
		if err := upsertEmails(ctx, db, client, accountID, page.IDs); err != nil {
			return err
		}
		stats.Created += len(page.IDs)
		if len(page.IDs) < fullPageSize {
			return nil
		}
	}
}

// upsertEmails fetches ids in batches and writes their mirror rows — sync.ts:329.
func upsertEmails(ctx context.Context, db *sql.DB, client *jmap.Client, accountID string, ids []string) error {
	const batch = 100
	for i := 0; i < len(ids); i += batch {
		end := min(i+batch, len(ids))
		raw, err := client.One(ctx, "Email/get", map[string]any{
			"accountId":  accountID,
			"ids":        ids[i:end],
			"properties": emailProperties,
		}, jmap.MailUsing)
		if err != nil {
			return err
		}
		var got struct {
			List []Email `json:"list"`
		}
		if err := json.Unmarshal(raw, &got); err != nil {
			return err
		}
		for _, e := range got.List {
			if err := upsertOne(ctx, db, accountID, e); err != nil {
				return err
			}
		}
	}
	return nil
}

// upsertOne writes one message's rows — sync.ts:351. INSERT OR REPLACE, so a
// replayed window (the safe direction after an interrupted pass) is idempotent.
func upsertOne(ctx context.Context, db *sql.DB, accountID string, e Email) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx,
		`INSERT OR REPLACE INTO emails (id, account_id, blob_id, thread_id, message_id, in_reply_to,
           subject, from_json, to_json, cc_json, bcc_json, preview, size, received_at,
           has_attachment, attachments_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		e.ID, accountID, e.BlobID, e.ThreadID, firstOrNil(e.MessageID), firstOrNil(e.InReplyTo),
		deref(e.Subject), jsonList(e.From), jsonList(e.To), jsonList(e.CC), jsonList(e.BCC),
		e.Preview, e.Size, ParseMillis(e.ReceivedAt), boolInt(e.HasAttachment),
		jsonList(e.Attachments)); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx,
		"DELETE FROM email_mailboxes WHERE account_id = ? AND email_id = ?", accountID, e.ID); err != nil {
		return err
	}
	for _, mb := range sortedKeys(e.MailboxIDs) {
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO email_mailboxes (account_id, email_id, mailbox_id) VALUES (?, ?, ?)",
			accountID, e.ID, mb); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx,
		"DELETE FROM email_keywords WHERE account_id = ? AND email_id = ?", accountID, e.ID); err != nil {
		return err
	}
	for _, kw := range sortedKeys(e.Keywords) {
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO email_keywords (account_id, email_id, keyword) VALUES (?, ?, ?)",
			accountID, e.ID, kw); err != nil {
			return err
		}
	}

	if _, err := tx.ExecContext(ctx, "DELETE FROM cli_fts WHERE email_id = ?", e.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		"INSERT INTO cli_fts (email_id, subject, from_text, to_text, preview) VALUES (?, ?, ?, ?, ?)",
		e.ID, deref(e.Subject), addressText(ParseAddresses(e.From)),
		addressText(ParseAddresses(e.To)), e.Preview); err != nil {
		return err
	}
	return tx.Commit()
}

func deleteEmail(ctx context.Context, db *sql.DB, accountID, id string) error {
	for _, stmt := range []string{
		"DELETE FROM emails WHERE account_id = ? AND id = ?",
		"DELETE FROM email_mailboxes WHERE account_id = ? AND email_id = ?",
		"DELETE FROM email_keywords WHERE account_id = ? AND email_id = ?",
	} {
		if _, err := db.ExecContext(ctx, stmt, accountID, id); err != nil {
			return err
		}
	}
	_, err := db.ExecContext(ctx, "DELETE FROM cli_fts WHERE email_id = ?", id)
	return err
}

// isCannotCalculateChanges recognises the one JMAP error that means "resync"
// rather than "fail" — sync.ts:228 reads err.jmapType for exactly this.
func isCannotCalculateChanges(err error) bool {
	var se *bmio.ServerError
	return errors.As(err, &se) && se.JMAPType == "cannotCalculateChanges"
}

// addressText is sync.ts:402's FTS text for an address list:
// `${a.name ?? ""} ${a.email}` joined by a space, untrimmed.
func addressText(list []Address) string {
	parts := make([]string, len(list))
	for i, a := range list {
		parts[i] = deref(a.Name) + " " + a.Email
	}
	return strings.Join(parts, " ")
}
