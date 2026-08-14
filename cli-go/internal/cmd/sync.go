package cmd

// `bullmoose sync` — the one-shot counterpart to `watch` (s08 T6), a port of
// main.ts:498 cmdSync.
//
// The engine is NOT here. internal/mirror already holds the port of sync.ts,
// including the changes cursor, because `watch` needed it first; this file is
// only the whole-run shape a one-shot invocation adds on top: fan out across the
// accounts a selector matches, print one progress line per account on STDERR,
// emit the same information as NDJSON records on stdout under --json, and exit 1
// if any account failed while the others still ran.
//
// That stderr/stdout split is arch.md §1.1 and the contract suite pins it from
// both sides: `sync > /dev/null` must still show progress, and `sync 2>/dev/null`
// must print nothing at all — progress is not a record.

import (
	"context"
	"fmt"
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/account"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/mirror"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// The three --json record shapes, one per branch of main.ts:507's loop. They are
// separate structs rather than one struct with omitempty because the TypeScript
// builds three DIFFERENT objects — a clean account has no `mode` key at all, and
// emitting `"mode":""` for it would be a different record.
type (
	syncCleanJSON struct {
		Account string `json:"account"`
		Clean   bool   `json:"clean"`
	}
	syncErrorJSON struct {
		Account string `json:"account"`
		Error   string `json:"error"`
	}
	// syncStatsJSON is `{ account, clean: false, ...r.stats }` (main.ts:517), so
	// the key order after `clean` is SyncStats' own declaration order
	// (sync.ts:212).
	syncStatsJSON struct {
		Account      string   `json:"account"`
		Clean        bool     `json:"clean"`
		Mode         string   `json:"mode"`
		Mailboxes    int      `json:"mailboxes"`
		Created      int      `json:"created"`
		Updated      int      `json:"updated"`
		Destroyed    int      `json:"destroyed"`
		NewState     string   `json:"newState"`
		CreatedIDs   []string `json:"createdIds"`
		UpdatedIDs   []string `json:"updatedIds"`
		DestroyedIDs []string `json:"destroyedIds"`
	}
)

// runSync serves `bullmoose sync [--account <sel>] [--blobs <dir>] [--json]`.
func runSync(s *bmio.Streams, argv []string) int {
	a := parse(argv)

	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		return die(s, err)
	}
	defer db.Close()
	// One connection, for the reason cmd/watch.go states: node:sqlite gives the
	// TypeScript a single synchronous handle and therefore serializes the mirror
	// writes for free, and database/sql would not. A CLI has nothing to gain from
	// write concurrency against a local file it is the only writer of.
	db.SetMaxOpenConns(1)

	settings, err := store.RequireSettings(db)
	if err != nil {
		return die(s, err)
	}
	// `sync` legitimately FANS OUT (db.ts:216 names it, beside `log` and
	// `watch`), so it resolves through account.Select and not the single-account
	// account.One: a selector matching three accounts syncs three accounts.
	selected, err := account.Select(settings.Accounts, settings.AccountID, a.Account)
	if err != nil {
		return die(s, err)
	}

	// The session client, not the computed-path one: `--blobs` downloads through
	// the session's downloadUrl TEMPLATE, which only the server can supply, and
	// the contract stub advertises an apiUrl that is not `/api/jmap` (session.go).
	client := jmap.NewSessionClient(settings.Base, settings.Token)

	results, err := mirror.SyncAll(context.Background(), db, client, selected, mirror.Options{Blobs: a.Blobs})
	if err != nil {
		return die(s, err)
	}

	failures := 0
	records := make([]any, 0, len(results))
	for _, r := range results {
		label := account.Label(r.Account)
		// Per-account lines are PROGRESS (arch.md §1.1 names them explicitly), so
		// they go to stderr; --json gives the same information as data on stdout.
		padded := padEnd(label, 28)
		switch {
		case r.Clean:
			records = append(records, syncCleanJSON{Account: label, Clean: true})
			s.Note(padded + " clean (no changes)")
		case r.Error != "":
			records = append(records, syncErrorJSON{Account: label, Error: r.Error})
			s.Note(padded + " FAILED: " + r.Error)
			failures++
		case r.Stats != nil:
			st := r.Stats
			records = append(records, syncStatsJSON{
				Account: label, Clean: false,
				Mode: st.Mode, Mailboxes: st.Mailboxes,
				Created: st.Created, Updated: st.Updated, Destroyed: st.Destroyed,
				NewState:   st.NewState,
				CreatedIDs: orEmpty(st.CreatedIDs), UpdatedIDs: orEmpty(st.UpdatedIDs),
				DestroyedIDs: orEmpty(st.DestroyedIDs),
			})
			s.Note(fmt.Sprintf("%s %s → state %s: +%d ~%d -%d (%d mailboxes)",
				padded, st.Mode, st.NewState, st.Created, st.Updated, st.Destroyed, st.Mailboxes))
		}
	}

	if a.JSON {
		if err := s.EmitNDJSON(records); err != nil {
			return die(s, err)
		}
	}
	if failures > 0 {
		// One broken account does not hide the ones that worked, and it does not
		// exit 0 either (main.ts:526).
		return int(bmio.ExitFail)
	}
	return 0
}

// padEnd is JavaScript's String.prototype.padEnd: pad to width with spaces, and
// leave a longer string alone. NOT padTrunc (rows.go), which also truncates —
// main.ts:508 pads the account label and never cuts it.
func padEnd(s string, width int) string {
	if n := len([]rune(s)); n < width {
		return s + strings.Repeat(" ", width-n)
	}
	return s
}

// orEmpty renders a nil slice as `[]` rather than `null`. The TypeScript
// initialises these to `[]` (sync.ts:219), so a full resync — which leaves them
// empty on purpose — emits `"createdIds":[]`, and `jq '.createdIds | length'`
// answers 0 instead of erroring on a null.
func orEmpty(ids []string) []string {
	if ids == nil {
		return []string{}
	}
	return ids
}
