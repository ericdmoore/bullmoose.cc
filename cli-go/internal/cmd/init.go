package cmd

// `bullmoose init` — bind this machine to a server with a token somebody else
// minted. Port of packages/cli/src/main.ts:442 cmdInit.
//
// login and init are the two doors into the same room: login mints a credential
// from a password, init accepts one that already exists (an operator's bundle, a
// CI secret, a token pasted from another device). Both end in the same four
// config rows, and both CREATE THE LOCAL MIRROR — which is the half that was
// missing from the Go binary until this wave, and the reason `watch` could not
// run on a machine that had never had Node.
//
// ⚠️ Ordering note against the TypeScript: main.ts:253 opens (and therefore
// creates) the mirror for EVERY command, before the switch. Here the mirror is
// created once there is something to put in it — after validation and after the
// session check. Nothing observable differs; what differs is that a failed
// `init` on a fresh machine leaves no half-made ~/.bullmoose/mail.db behind.

import (
	"context"
	"database/sql"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

const initUsage = "bullmoose init --base <url> --token <token>  (or a file:// bundle)"

func runInit(s *bmio.Streams, argv []string) int {
	a := parse(argv)
	ctx := context.Background()

	// `--url` is accepted as an alias because it parses, is documented in
	// packages/cli/README.md, and used to be silently discarded — which failed
	// with "init requires --base" and no hint (cli/010 §5).
	base := a.URL
	if a.HasBase {
		base = a.Base
	}
	token, account := a.Token, a.Account
	// Whether the account was NAMED at all, by either source — main.ts:454 merges
	// flag and bundle with `??` and then tests the merged value, so a bundle's
	// accountId must win over the session's primary exactly as the flag does.
	accountNamed := a.HasAccount

	if isFileURL(base) {
		boot, err := loadBootstrap(base)
		if err != nil {
			return die(s, err)
		}
		base = firstNonEmpty(boot.Base, boot.URL)
		if !a.HasToken {
			token = boot.Token
		}
		if !accountNamed && boot.AccountID != "" {
			account, accountNamed = boot.AccountID, true
		}
	}
	if base == "" || token == "" {
		return die(s, bmio.Usage(initUsage))
	}

	if a.Offline {
		// Store without touching the network — for prepping machines before they
		// have connectivity. Needs an explicit accountId, because there is no
		// session to discover one from (main.ts:458).
		if account == "" {
			return die(s, bmio.Usage("--offline requires an accountId (flag or bootstrap file)"))
		}
		db, err := writeSettings(store.DBPath(a.DB), base, token, account, "")
		if err != nil {
			return die(s, err)
		}
		defer db.Close()
		if a.JSON {
			if err := s.EmitJSON(initOfflineJSON{Base: base, AccountID: account, Validated: false}); err != nil {
				return die(s, err)
			}
			return 0
		}
		s.Out("configured (offline, unvalidated): " + account + " @ " + base)
		return 0
	}

	session, err := jmap.NewSessionClient(base, token).Session(ctx)
	if err != nil {
		return die(s, err)
	}

	// main.ts:476: an explicit --account wins, else the account the server names
	// as primary for mail. `??` is nullish, so `--account ""` is a value and gets
	// refused below rather than silently replaced by the primary.
	accountID, named := account, accountNamed
	if !named {
		accountID, named = session.PrimaryAccounts["urn:ietf:params:jmap:mail"]
	}
	if !named || accountID == "" || !session.HasAccount(accountID) {
		return die(s, bmio.NotFound("account "+orNone(accountID, named)+
			" not in session; available: "+joinAccountIDs(session)))
	}

	accounts, err := session.Accounts()
	if err != nil {
		return die(s, err)
	}
	rows := make([]initAccount, 0, len(accounts))
	for _, acc := range accounts {
		rows = append(rows, initAccount{AccountID: acc.ID, Name: acc.Name})
	}
	blob, err := jsonValue(rows)
	if err != nil {
		return die(s, err)
	}
	db, err := writeSettings(store.DBPath(a.DB), base, token, accountID, blob)
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	if a.JSON {
		if err := s.EmitJSON(initJSON{
			Base:      base,
			AccountID: accountID,
			Username:  session.Username,
			Accounts:  rows,
			Validated: true,
		}); err != nil {
			return die(s, err)
		}
		return 0
	}
	s.Out("configured: " + session.Username + " / " + accountID + " @ " + base)
	return 0
}

// writeSettings creates the mirror if it is not there and writes the four config
// rows both doors write. An empty `accounts` blob is skipped rather than stored
// as "": main.ts's offline branch does not write the key at all, and db.ts:154
// treats a bad blob as legacy config.
func writeSettings(path, base, token, accountID, accountsBlob string) (*sql.DB, error) {
	db, err := store.Init(path)
	if err != nil {
		return nil, err
	}
	rows := [][2]string{{"base", base}, {"token", token}, {"accountId", accountID}}
	if accountsBlob != "" {
		rows = append(rows, [2]string{"accounts", accountsBlob})
	}
	for _, kv := range rows {
		if err := store.SetConfig(db, kv[0], kv[1]); err != nil {
			_ = db.Close()
			return nil, err
		}
	}
	return db, nil
}

// initAccount is main.ts:483's `{accountId, name}`; `name` is omitted when the
// session did not carry one, exactly as JSON.stringify drops an undefined.
type initAccount struct {
	AccountID string `json:"accountId"`
	Name      string `json:"name,omitempty"`
}

// The two --json records, in main.ts's key order (:466 and :492).
type initOfflineJSON struct {
	Base      string `json:"base"`
	AccountID string `json:"accountId"`
	Validated bool   `json:"validated"`
}

type initJSON struct {
	Base      string        `json:"base"`
	AccountID string        `json:"accountId"`
	Username  string        `json:"username"`
	Accounts  []initAccount `json:"accounts"`
	Validated bool          `json:"validated"`
}

// orNone is main.ts:479's `accountId ?? "(none)"`: nullish, so an account that
// was NAMED but empty prints as itself (empty), and only an absent one is
// "(none)".
func orNone(accountID string, named bool) string {
	if !named {
		return "(none)"
	}
	return accountID
}

func joinAccountIDs(session *jmap.Session) string {
	accounts, err := session.Accounts()
	if err != nil {
		return ""
	}
	out := ""
	for i, a := range accounts {
		if i > 0 {
			out += ", "
		}
		out += a.ID
	}
	return out
}
