package cmd

// `bullmoose repoint [--base <url>]` — move this device's stored server URL
// without re-authenticating. A port of packages/cli/src/repoint.ts, whose
// header records the gap it closes: `base` is written once by login/init, and
// when a deployment retires a hostname the stored value is wrong forever —
// the state PR #201's live smoke actually found.
//
// The discipline that must survive any idiom shift: **validate before
// writing**. A wrong URL leaves the old (even broken) base in place; a base
// that answers but rejects this token is a NEW LOGIN, said in those words,
// not a repoint; a base that lacks this account is refused with the list it
// does have. Only after all three gates does exactly one config row change.

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/discover"
	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

func runRepoint(s *bmio.Streams, argv []string) int {
	return runRepointWith(s, argv, discoverDeps{})
}

func runRepointWith(s *bmio.Streams, argv []string, deps discoverDeps) int {
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

	base, code := repointTarget(s, settings, a, deps)
	if code != 0 {
		return code
	}

	if base == settings.Base {
		s.Note("already pointed at " + base)
		if a.JSON {
			if err := s.EmitJSON(map[string]any{"base": base, "changed": false}); err != nil {
				return die(s, err)
			}
		}
		return 0
	}

	// Gate 1+2: the base must serve the session resource AND accept the token
	// this device already holds.
	client := jmap.NewSessionClient(base, settings.Token)
	session, err := client.Session(context.Background())
	if err != nil {
		var se *bmio.ServerError
		if asServerError(err, &se) && (se.HTTPStatus == 401 || se.HTTPStatus == 403) {
			s.Note(base + " is a JMAP server, but it rejected this device's token (HTTP " +
				strconv.Itoa(se.HTTPStatus) + ").\nNothing was changed. A moved deployment keeps your token; " +
				"a DIFFERENT one does not — if this is a new server, run: bullmoose login <your address> --base " + base)
			return 4
		}
		return die(s, err)
	}

	// Gate 3: the account this device is bound to must exist there.
	if !session.HasAccount(settings.AccountID) {
		accounts, _ := session.Accounts()
		var ids []string
		for _, acc := range accounts {
			ids = append(ids, acc.ID)
		}
		have := strings.Join(ids, ", ")
		if have == "" {
			have = "none"
		}
		s.Note(base + " does not serve account " + settings.AccountID + " (it has: " + have + ").\n" +
			"Nothing was changed — run `bullmoose login " + session.Username + "` if this is a different deployment.")
		return 1
	}

	sessionAccounts, err := session.Accounts()
	if err != nil {
		return die(s, err)
	}
	type storedAcc struct {
		AccountID string `json:"accountId"`
		Name      string `json:"name,omitempty"`
	}
	stored := make([]storedAcc, 0, len(sessionAccounts))
	for _, acc := range sessionAccounts {
		stored = append(stored, storedAcc{AccountID: acc.ID, Name: acc.Name})
	}
	blob, err := json.Marshal(stored)
	if err != nil {
		return die(s, err)
	}

	previous := settings.Base
	if err := store.SetConfig(db, "base", base); err != nil {
		return die(s, err)
	}
	if err := store.SetConfig(db, "accounts", string(blob)); err != nil {
		return die(s, err)
	}

	if a.JSON {
		if err := s.EmitJSON(map[string]any{
			"base": base, "previousBase": previous, "changed": true,
			"accountId": settings.AccountID, "accounts": stored,
		}); err != nil {
			return die(s, err)
		}
		return 0
	}
	s.Out("repointed: " + previous + " -> " + base)
	s.Note("token and account kept (" + session.Username + " / " + settings.AccountID + ")")
	return 0
}

// repointTarget is repoint.ts:87 resolveTarget: a file:// bundle, an explicit
// --base, or autodiscovery from the stored address — login's answer TODAY,
// applied to the config login wrote months ago.
func repointTarget(s *bmio.Streams, settings *store.Settings, a args, deps discoverDeps) (string, int) {
	if isFileURL(a.Base) {
		boot, err := loadBootstrap(a.Base)
		if err != nil {
			return "", die(s, err)
		}
		fromFile := firstNonEmpty(boot.Base, boot.URL)
		if fromFile == "" {
			s.Note("usage: bootstrap bundle names no base: " + a.Base)
			return "", 2
		}
		return fromFile, 0
	}
	if a.Base != "" {
		return a.Base, 0
	}

	address := ""
	for _, acc := range settings.Accounts {
		if acc.AccountID == settings.AccountID && acc.Address != "" {
			address = acc.Address
			break
		}
	}
	if address == "" {
		for _, acc := range settings.Accounts {
			if acc.Address != "" {
				address = acc.Address
				break
			}
		}
	}
	if address == "" {
		s.Note("usage: bullmoose repoint --base <url>  (no stored address to autodiscover from)")
		return "", 2
	}
	finder := deps.resolver
	if finder == nil {
		finder = discover.New()
	}
	found, err := finder.Resolve(context.Background(), address)
	if err != nil {
		return "", die(s, err)
	}
	line := "discovered " + found.Base + " (via " + found.Via + ")"
	if found.RedirectedFrom != "" {
		line += " — " + found.RedirectedFrom + " redirected the session resource here"
	}
	s.Note(line)
	return found.Base, 0
}
