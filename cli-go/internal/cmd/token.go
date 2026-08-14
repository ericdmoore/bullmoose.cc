package cmd

// `bullmoose token` — self-service credential management: mint another token,
// list the ones this login holds, revoke one. Port of
// packages/cli/src/tokens.ts:136 cmdToken.
//
// Unlike `login`, every verb here is authenticated by the token the mirror
// already holds, and the server gates a mint on `scopesWithin(requested,
// thisToken.scopes)` — a token can only ever narrow itself. That is exactly why
// --scopes is REQUIRED here and optional on `login`: there is nothing to
// bootstrap, the caller already holds a credential, and demanding one word costs
// them nothing (see TokenCreateScopes, cli/007).

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/auth"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/scopes"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

const tokenUsage = "bullmoose token create --name <n> --scopes <a,b> | list | revoke <id>"

// TokenCreateScopes resolves the scopes for `bullmoose token create`.
//
// cli/007 (`.feedback/fromClaude/cli/007`): this used to default to the widest
// scope the self-service API can express ("mail", which satisfies everything
// except admin) whenever --scopes was omitted. So the shortest invocation
// minted the broadest credential — and that token is precisely the one pasted
// into third-party clients. The TypeScript fix makes --scopes REQUIRED for
// token create (parseScopeFlag(opts.scopes, SELF_SERVICE_SCOPES, /*required*/
// true) in packages/cli/src/tokens.ts:151): an omitted flag is a usage error
// (exit 2), never a wide default. `login` keeps an optional --scopes because it
// is the bootstrap; this seam is `token create` specifically, where the caller
// already holds a token and demanding one word costs them nothing.
//
// scopes is the raw --scopes value, or nil when the flag was absent. The refusal
// must happen HERE, before any request: a network round trip to be told the same
// thing is slower, needs connectivity, and — on a server that ever regressed the
// same default — would not refuse at all.
func TokenCreateScopes(scopesFlag *string) ([]string, error) {
	parsed, err := scopes.ParseFlag(scopesFlag, scopes.SelfService, true)
	if err != nil {
		// bmio.Fail, not bmio.Usage: the message already ends with its own
		// `usage:` line, and Usage would prefix a second one at the top
		// (tokens.ts:153 calls fail(), not usage(), for the same reason).
		return nil, bmio.Fail(err.Error()+
			"\n\nusage: bullmoose token create --name <n> --scopes <a,b,c>", bmio.ExitUsage)
	}
	if len(parsed) == 0 {
		// Unreachable while ParseFlag(required=true) refuses both the absent and
		// the empty flag, and kept because tokens.ts:154 keeps it: the invariant
		// this function must never break is "no scopes in, no scopes out", and
		// stating it costs one branch.
		return nil, bmio.Fail("--scopes is required", bmio.ExitUsage)
	}
	return parsed, nil
}

func runToken(s *bmio.Streams, argv []string) int {
	a := parse(argv)
	ctx := context.Background()

	// main.ts:273 resolves settings BEFORE the verb, so an unconfigured machine
	// is told to log in rather than told which verbs exist.
	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		return die(s, err)
	}
	defer db.Close()
	settings, err := store.RequireSettings(db)
	if err != nil {
		return die(s, err)
	}
	client := auth.New(settings.Base, settings.Token)

	switch a.at(1) {
	case "create":
		return tokenCreate(s, ctx, client, a)
	case "list":
		return tokenList(s, ctx, client, a)
	case "revoke":
		return tokenRevoke(s, ctx, client, a)
	default:
		return die(s, bmio.Usage(tokenUsage))
	}
}

func tokenCreate(s *bmio.Streams, ctx context.Context, client *auth.Client, a args) int {
	wanted, err := TokenCreateScopes(a.scopesFlag())
	if err != nil {
		return die(s, err)
	}
	name := a.Name
	if name == "" {
		name = "token" // tokens.ts:164 — the server's own default, stated here too
	}
	created, err := client.CreateToken(ctx, name, wanted)
	if err != nil {
		return die(s, err)
	}
	if a.JSON {
		if err := s.EmitJSON(tokenCreateJSON{
			TokenID: created.TokenID, Token: created.Token, Scopes: created.Scopes,
		}); err != nil {
			return die(s, err)
		}
		return 0
	}
	// §1.1: the secret is the ONLY thing on stdout, so
	// `T=$(bullmoose token create --name x --scopes read)` is the whole capture.
	// What was minted, with which scopes, and the shown-once warning are chrome —
	// which is why a token used to be un-scriptable without screen-scraping
	// (cli/008). The contract suite asserts exactly this split (contract.mjs:158).
	s.Note("created " + created.TokenID + " [" + strings.Join(created.Scopes, ",") + "]")
	s.Out(created.Token)
	s.Note("shown once — store it now.")
	return 0
}

func tokenList(s *bmio.Streams, ctx context.Context, client *auth.Client, a args) int {
	rows, err := client.ListTokens(ctx)
	if err != nil {
		return die(s, err)
	}
	if a.IDs {
		for _, raw := range rows {
			row, err := decodeTokenRow(raw)
			if err != nil {
				return die(s, err)
			}
			s.Out(row.ID)
		}
		return 0
	}
	if a.JSON {
		// Verbatim, one per line: the server's row is the record, including any
		// field this CLI does not name (see auth.ListTokens).
		for _, raw := range rows {
			if err := s.EmitJSON(raw); err != nil {
				return die(s, err)
			}
		}
		return 0
	}
	for _, raw := range rows {
		row, err := decodeTokenRow(raw)
		if err != nil {
			return die(s, err)
		}
		line, err := row.render()
		if err != nil {
			return die(s, err)
		}
		s.Out(line)
	}
	if len(rows) == 0 {
		s.Note("(no tokens)")
	}
	return 0
}

func tokenRevoke(s *bmio.Streams, ctx context.Context, client *auth.Client, a args) int {
	id := a.at(2)
	if id == "" {
		return die(s, bmio.Usage("bullmoose token revoke <tokenId>"))
	}
	if a.DryRun {
		s.Note("dry run: would revoke token " + id)
		if a.JSON {
			if err := s.EmitJSON(tokenDryRunJSON{DryRun: true, TokenID: id}); err != nil {
				return die(s, err)
			}
		}
		return 0
	}
	revoked, err := client.RevokeToken(ctx, id)
	if err != nil {
		return die(s, err)
	}
	if a.JSON {
		if err := s.EmitJSON(tokenRevokeJSON{TokenID: id, Revoked: revoked}); err != nil {
			return die(s, err)
		}
		return 0
	}
	if revoked {
		s.Out("revoked " + id)
		return 0
	}
	// Not an error: the id was not this principal's. tokens.ts:229 reports it as
	// a note and exits 0, so `revoke` stays idempotent in a script.
	s.Note(id + " not found (or not yours)")
	return 0
}

// The --json records, in tokens.ts's key order (:174, :216, :225).
type tokenCreateJSON struct {
	TokenID string   `json:"tokenId"`
	Token   string   `json:"token"`
	Scopes  []string `json:"scopes"`
}

type tokenDryRunJSON struct {
	DryRun  bool   `json:"dryRun"`
	TokenID string `json:"tokenId"`
}

type tokenRevokeJSON struct {
	TokenID string `json:"tokenId"`
	Revoked bool   `json:"revoked"`
}

// tokenRow is the four fields the human listing prints — tokens.ts:193. `scopes`
// is a JSON STRING in the row (it is stored that way in D1 and handed back
// as-is), hence the second decode in render.
type tokenRow struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Scopes     string `json:"scopes"`
	LastUsedAt *int64 `json:"last_used_at"`
}

func decodeTokenRow(raw json.RawMessage) (tokenRow, error) {
	var row tokenRow
	if err := json.Unmarshal(raw, &row); err != nil {
		return row, &bmio.CliError{Msg: "token list: unexpected row shape (" + err.Error() + ")", Code: bmio.ExitFail}
	}
	return row, nil
}

func (r tokenRow) render() (string, error) {
	var list []string
	if err := json.Unmarshal([]byte(r.Scopes), &list); err != nil {
		return "", &bmio.CliError{
			Msg:  "token list: a row's scopes are not a JSON array (" + r.Scopes + ")",
			Code: bmio.ExitFail,
		}
	}
	lastUsed := "never"
	if r.LastUsedAt != nil && *r.LastUsedAt != 0 {
		// `new Date(ms).toISOString().slice(0, 10)` — the date, not the instant.
		lastUsed = time.UnixMilli(*r.LastUsedAt).UTC().Format("2006-01-02")
	}
	return fmt.Sprintf("%s  %-20s  last-used=%s  %s",
		r.ID, strings.Join(list, ","), lastUsed, r.Name), nil
}
