package mirror

// The whole-run shape of `bullmoose sync` — a port of sync.ts:83 syncAll.
//
// It is NOT a second sync engine: every account that has anything to do goes
// through Sync, the same function `watch` drives on a push. What lives here is
// only the part a one-shot multi-account run adds — the batched clean-probe, and
// the per-account result record `sync` prints.
//
// The probe is why this exists at all. ONE JMAP request carries an Email/changes
// call per cursored account (each call names its own accountId — this is what
// JMAP batching is for), so N idle inboxes cost about one round trip instead of
// N full engine passes. An account whose state is unchanged is skipped entirely;
// everything else falls through to the engine, which decides for itself between
// incremental and full.
//
// Every uncertainty resolves to DIRTY: a probe that errors, a call the server
// answered with `["error", …]`, a response that cannot be matched back to its
// account. A false "clean" silently skips mail; a false "dirty" costs a round
// trip. Only one of those is a bug.

import (
	"context"
	"database/sql"
	"encoding/json"
	"strconv"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/account"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
)

// probeChunk is sync.ts:100's window — the server's maxCallsInRequest. A batch
// larger than the server accepts is refused whole, which would make every
// account in it look dirty.
const probeChunk = 16

// Result is one account's outcome, matching the union sync.ts:69
// MultiSyncResult describes: exactly one of Clean, Error or Stats is set.
type Result struct {
	Account account.Account
	// Stats is set when the engine ran.
	Stats *Stats
	// Clean is true when the probe proved there was nothing to do.
	Clean bool
	// Error is the failure MESSAGE, not the error: sync.ts:132 keeps
	// `err.message` per account so one broken account does not abort the others,
	// and `sync` reports it per account and exits 1 at the end.
	Error string
}

// changesProbe is the Email/changes call the probe sends, in sync.ts:104's key
// order. maxChanges is 1 because the probe reads only newState/hasMoreChanges —
// it never wants the page.
type changesProbe struct {
	AccountID  string `json:"accountId"`
	SinceState string `json:"sinceState"`
	MaxChanges int    `json:"maxChanges"`
}

// SyncAll syncs many accounts, skipping the ones a batched probe proves clean.
//
// It returns one Result per account IN THE ORDER GIVEN — `sync`'s per-account
// stderr lines are read by a human against the account list they typed, so
// reordering them would be a regression even though nothing parses them.
func SyncAll(ctx context.Context, db *sql.DB, client *jmap.Client, accounts []account.Account, opts Options) ([]Result, error) {
	cursors := make(map[string]string, len(accounts))
	for _, a := range accounts {
		cursor, err := Cursor(db, a.AccountID)
		if err != nil {
			// A mirror that cannot be read is not a per-account failure — it is
			// the whole run failing, which is what sync.ts's uncaught throw does.
			return nil, err
		}
		cursors[a.AccountID] = cursor
	}

	// Only a cursored account can be probed: a never-synced one has nothing to
	// compare against and must run the engine regardless (sync.ts:99).
	var probeable []account.Account
	for _, a := range accounts {
		if cursors[a.AccountID] != "" {
			probeable = append(probeable, a)
		}
	}

	clean := make(map[string]bool, len(probeable))
	for i := 0; i < len(probeable); i += probeChunk {
		end := min(i+probeChunk, len(probeable))
		chunk := probeable[i:end]
		calls := make([]jmap.Invocation, len(chunk))
		for idx, a := range chunk {
			calls[idx] = jmap.Invocation{
				Name: "Email/changes",
				Args: changesProbe{
					AccountID:  a.AccountID,
					SinceState: cursors[a.AccountID],
					MaxChanges: 1,
				},
				CallID: "p" + strconv.Itoa(idx),
			}
		}
		responses, err := client.Call(ctx, jmap.MailUsing, calls)
		if err != nil {
			continue // probe failure → treat all as dirty; the engine decides
		}
		for _, resp := range responses {
			// The callId carries the account's index in this chunk — sync.ts:110
			// reads it back the same way, because responses may not arrive in
			// call order.
			if len(resp.CallID) < 2 || resp.CallID[0] != 'p' {
				continue
			}
			idx, err := strconv.Atoi(resp.CallID[1:])
			if err != nil || idx < 0 || idx >= len(chunk) {
				continue
			}
			if resp.Name == "error" {
				continue // dirty by default (e.g. cannotCalculateChanges)
			}
			var r struct {
				NewState       json.RawMessage `json:"newState"`
				HasMoreChanges bool            `json:"hasMoreChanges"`
			}
			if err := json.Unmarshal(resp.Args, &r); err != nil {
				continue
			}
			acc := chunk[idx]
			if stateString(r.NewState) == cursors[acc.AccountID] && !r.HasMoreChanges {
				clean[acc.AccountID] = true
			}
		}
	}

	results := make([]Result, 0, len(accounts))
	for _, a := range accounts {
		if clean[a.AccountID] {
			results = append(results, Result{Account: a, Clean: true})
			continue
		}
		stats, err := Sync(ctx, db, client, a.AccountID, opts)
		if err != nil {
			results = append(results, Result{Account: a, Error: err.Error()})
			continue
		}
		results = append(results, Result{Account: a, Stats: stats})
	}
	return results, nil
}
