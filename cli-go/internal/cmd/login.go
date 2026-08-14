package cmd

// `bullmoose login` — the password-based bootstrap, and the command that makes
// this binary standalone. Port of packages/cli/src/tokens.ts:41 cmdLogin.
//
// ── What travels ──────────────────────────────────────────────────────────
//
// The password is used ONCE, in this process, to derive a key
// (internal/authkey). Only the derived key crosses the network and only the
// minted token is stored, in a 0600 mirror. Nothing here writes, logs, echoes or
// returns the raw password — login_test.go asserts that the password appears in
// NO stored artifact, because "we don't log it" is a property that decays
// silently the first time someone adds a debug line.
//
// ── The order of operations is not arbitrary ──────────────────────────────
//
// Scope validation runs BEFORE the password is read: a typo'd `--scopes` should
// cost a local exit 2, not a prompt, a 400ms stretch and a round trip. Discovery
// runs before the prompt for the same reason — being asked for a password by a
// command that is about to fail is the worst order of these three.

import (
	"context"
	"os"
	"strings"

	"golang.org/x/term"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/auth"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/authkey"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/discover"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/scopes"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

const loginUsage = "bullmoose login <email> [--base <url>] [--name <device-name>] [--scopes <a,b,c>]"

// resolver is autodiscovery, as an interface so a test can stand one in.
//
// ⚠️ It is an INTERFACE rather than *discover.Resolver for a reason worth
// keeping: with the concrete type, a test could only steer discovery by making it
// answer a real hostname, and the login POST that follows would then be sent by
// the auth client's own transport — to the real internet. That happened once
// while this file was being written (a test POSTed to the live bullmoose.cc and
// took a 405). A test now supplies the base directly, so no test can reach
// production even by accident. The discovery LADDER is tested where it lives, in
// internal/discover.
type resolver interface {
	Resolve(ctx context.Context, email string) (discover.Result, error)
}

// loginDeps are the two effects a test cannot have: a real resolver and a real
// terminal. Production leaves them nil and gets the real ones.
type loginDeps struct {
	resolver resolver
	// prompt reads the password without echoing. nil → promptHidden.
	prompt func(message string) (string, error)
}

func runLogin(s *bmio.Streams, argv []string) int {
	return runLoginWith(s, argv, loginDeps{})
}

func runLoginWith(s *bmio.Streams, argv []string, deps loginDeps) int {
	a := parse(argv)
	ctx := context.Background()

	base := a.Base
	// A file:// base is a bootstrap bundle carrying the real server URL. Login
	// still goes over the network — the bundle exists to say WHERE, not to
	// authenticate (tokens.ts:44).
	if isFileURL(base) {
		boot, err := loadBootstrap(base)
		if err != nil {
			return die(s, err)
		}
		base = firstNonEmpty(boot.Base, boot.URL)
	}

	email := a.at(1)
	if email == "" {
		return die(s, bmio.Usage(loginUsage))
	}

	// Optional HERE and nowhere else: login is the bootstrap, so a user with no
	// token must be able to run it bare and take the server's default
	// (tokens.ts:52). `token create` is the opposite — see cli/007.
	wanted, err := scopes.ParseFlag(a.scopesFlag(), scopes.SelfService, false)
	if err != nil {
		return die(s, bmio.Fail(err.Error()+"\n(omit --scopes to take the server default)", bmio.ExitUsage))
	}

	if base == "" {
		finder := deps.resolver
		if finder == nil {
			finder = discover.New()
		}
		found, err := finder.Resolve(ctx, email)
		if err != nil {
			return die(s, err)
		}
		base = found.Base
		s.Note("discovered " + found.Base + " (via " + found.Via + ")")
	}

	password, err := readPassword(a, deps)
	if err != nil {
		return die(s, err)
	}
	// Stretching happens HERE — the raw password never leaves this process
	// (tokens.ts:63). ~600k PBKDF2 iterations; the wait is the point.
	loginKey, err := authkey.DeriveLoginKey(email, password)
	if err != nil {
		return die(s, &bmio.CliError{Msg: "deriving the login key failed: " + err.Error(), Code: bmio.ExitFail})
	}

	// The mirror is created HERE — schema and all, and BEFORE the mint. On a
	// machine that has only ever run the Go binary this is the first time the file
	// exists; before this wave only the Node CLI could make one, which is why
	// `watch` could not stand alone (devPlan.md's standalone claim).
	//
	// Before the mint, not after, because /auth/login shows the secret exactly
	// once (authRoutes.ts:112). A mirror that turns out to be unwritable after the
	// token is minted loses that token for good and leaves an orphan row on the
	// server. main.ts:253 opens the mirror before every command for the same
	// reason it holds here.
	db, err := store.Init(store.DBPath(a.DB))
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	name := a.Name
	if name == "" {
		name = deviceName()
	}
	result, err := auth.New(base, "").Login(ctx, email, loginKey, name, wanted)
	if err != nil {
		return die(s, err)
	}

	primary := primaryAccount(result.Accounts, email)
	if primary == nil {
		return die(s, bmio.NotFound("login ok but "+email+" has no accounts — provision one first"))
	}

	accounts := make([]storedAccount, 0, len(result.Accounts))
	for _, acc := range result.Accounts {
		stored := storedAccount{AccountID: acc.AccountID, TenantID: acc.TenantID, Name: acc.Name}
		if acc.Address != nil && *acc.Address != "" {
			stored.Address = *acc.Address
		}
		accounts = append(accounts, stored)
	}
	blob, err := jsonValue(accounts)
	if err != nil {
		return die(s, err)
	}
	for _, kv := range [][2]string{
		{"base", base},
		{"token", result.Token},
		{"accountId", primary.AccountID},
		{"accounts", blob},
	} {
		if err := store.SetConfig(db, kv[0], kv[1]); err != nil {
			return die(s, err)
		}
	}

	// cli/008: `json` used to be threaded into LoginOpts and never read — dead
	// plumbing that looked implemented. The value worth capturing (the account you
	// just bound) is otherwise only in prose (tokens.ts:106).
	if a.JSON {
		if err := s.EmitJSON(loginJSON{
			Username:  result.Username,
			TokenID:   result.TokenID,
			AccountID: primary.AccountID,
			Base:      base,
			Accounts:  result.Accounts,
		}); err != nil {
			return die(s, err)
		}
		return 0
	}
	if a.IDs {
		for _, acc := range result.Accounts {
			s.Out(acc.AccountID)
		}
		return 0
	}
	s.Out("logged in as " + result.Username + " (token " + result.TokenID + ", this device only)")
	for _, acc := range result.Accounts {
		mark := " "
		if acc.AccountID == primary.AccountID {
			mark = "★"
		}
		label := acc.AccountID
		if acc.Address != nil && *acc.Address != "" {
			label = *acc.Address
		}
		s.Out("  " + mark + " " + label + "  (" + acc.Name + ")")
	}
	return 0
}

// loginJSON is tokens.ts:111's record, in that key order.
type loginJSON struct {
	Username  string         `json:"username"`
	TokenID   string         `json:"tokenId"`
	AccountID string         `json:"accountId"`
	Base      string         `json:"base"`
	Accounts  []auth.Account `json:"accounts"`
}

// storedAccount is the `accounts` config blob db.ts:129 AccountRef reads back.
// `address` is omitted rather than null when the server did not report one —
// tokens.ts:100 spreads it conditionally, and the Node CLI reads this blob.
type storedAccount struct {
	AccountID string `json:"accountId"`
	TenantID  string `json:"tenantId"`
	Name      string `json:"name"`
	Address   string `json:"address,omitempty"`
}

// primaryAccount is tokens.ts:86: the account whose address IS the login address,
// else the first. Case-insensitive, because the address the user typed and the
// address the server stores need not agree on case.
func primaryAccount(accounts []auth.Account, email string) *auth.Account {
	for i := range accounts {
		if accounts[i].Address != nil && strings.EqualFold(*accounts[i].Address, email) {
			return &accounts[i]
		}
	}
	if len(accounts) > 0 {
		return &accounts[0]
	}
	return nil
}

// readPassword resolves the password in tokens.ts:62's order: --password, then
// $BULLMOOSE_PASSWORD, then a hidden prompt. The first two are nullish checks,
// so an explicitly EMPTY value at either is a password, not an absence.
func readPassword(a args, deps loginDeps) (string, error) {
	if a.HasPassword {
		return a.Password, nil
	}
	if env, ok := os.LookupEnv("BULLMOOSE_PASSWORD"); ok {
		return env, nil
	}
	if deps.prompt != nil {
		return deps.prompt("password: ")
	}
	return promptHidden("password: ")
}

// promptHidden reads a password without echoing — tokens.ts:264.
//
// The non-TTY branch is not a fallback, it is the scripted path: `echo hunter2 |
// bullmoose login eric@…` reads stdin and trims. The TTY branch turns echo off
// for the duration and prints the prompt to STDERR, so `login --json > out.json`
// still shows the prompt and still produces a clean file.
func promptHidden(message string) (string, error) {
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		piped, err := readAllStdin()
		if err != nil {
			return "", &bmio.CliError{Msg: "reading the password from stdin failed: " + err.Error(), Code: bmio.ExitFail}
		}
		return strings.TrimSpace(piped), nil
	}
	if _, err := os.Stderr.WriteString(message); err != nil {
		return "", err
	}
	secret, err := term.ReadPassword(fd)
	// The newline the user's Enter did not echo, so the next line does not start
	// mid-prompt (tokens.ts:280).
	_, _ = os.Stderr.WriteString("\n")
	if err != nil {
		return "", &bmio.CliError{Msg: "reading the password failed: " + err.Error(), Code: bmio.ExitFail}
	}
	return string(secret), nil
}

// deviceName is tokens.ts:236 — `${USER}@${HOSTNAME}`, with the same fallbacks.
// The token is named after the device it lives on so `token list` is legible
// months later.
func deviceName() string {
	user := os.Getenv("USER")
	if user == "" {
		user = "user"
	}
	host := os.Getenv("HOSTNAME")
	if host == "" {
		host = "host"
	}
	return user + "@" + host
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
