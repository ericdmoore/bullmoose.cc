// Package store opens the CLI's LOCAL SQLite mirror — the same file, at the same
// path, with the same schema as packages/cli/src/db.ts. `.plans/s08-go-cli`
// decision 4 (devPlan.md:182) is explicit: "same file, same schema", so a user
// mid-migration does not lose their mirror and the two implementations stay
// comparable on identical state.
//
// The driver is pure-Go modernc.org/sqlite, NOT cgo mattn/go-sqlite3 —
// devPlan.md:176 DECIDED this, because cgo forfeits the effortless cross-compile
// that is most of the reason for the Go port (arch.md §1). The read-only wave-1
// commands (mailboxes, search, log, accounts) sit on this.
package store

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/account"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"

	_ "modernc.org/sqlite" // pure-Go driver, registered as "sqlite"
)

// DBPath resolves the mirror's path exactly as db.ts does: the --db flag wins,
// then $BULLMOOSE_DB, then ~/.bullmoose/mail.db (db.ts:76 defaultDbPath, and
// main.ts:232 `openDb(opts.db ?? defaultDbPath())`).
func DBPath(dbFlag string) string {
	if dbFlag != "" {
		return dbFlag
	}
	if env := os.Getenv("BULLMOOSE_DB"); env != "" {
		return env
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	return filepath.Join(home, ".bullmoose", "mail.db")
}

// Open opens the mirror. Reads only — the wave-1 commands never write — so it
// does NOT recreate the schema (db.ts:80 openDb does, because it must also serve
// first-run writers). On a not-yet-configured or absent file the config lookups
// in RequireSettings simply come back empty and produce the usage error, which
// is what db.ts:150 does too.
func Open(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// A short wait so a mid-write mirror (Node's WAL) does not surface a
	// transient "database is locked" on the sequential reads the CLI does.
	if _, err := db.Exec("PRAGMA busy_timeout = 5000"); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

// Settings mirrors db.ts:137 Settings — the login this mirror belongs to.
type Settings struct {
	Base      string
	Token     string
	AccountID string            // default account
	Accounts  []account.Account // every account this login can see
}

// RequireSettings reads the config rows, or fails with the SAME usage error
// db.ts:146 requireSettings raises (exit 2 via bmio.Usage). accounts is parsed
// from the `accounts` config blob; an empty/legacy value falls back to a single
// account of the default id (db.ts:159).
func RequireSettings(db *sql.DB) (*Settings, error) {
	base := getConfig(db, "base")
	token := getConfig(db, "token")
	accountID := getConfig(db, "accountId")
	if base == "" || token == "" || accountID == "" {
		return nil, bmio.Usage("not configured — run: bullmoose login <email>  (or init --base/--token)")
	}

	var raw []struct {
		AccountID string `json:"accountId"`
		Address   string `json:"address"`
		Name      string `json:"name"`
	}
	// db.ts:154 tolerates a bad blob as "legacy config" → []; so does this.
	if blob := getConfig(db, "accounts"); blob != "" {
		_ = json.Unmarshal([]byte(blob), &raw)
	}
	accounts := make([]account.Account, len(raw))
	for i, a := range raw {
		accounts[i] = account.Account{AccountID: a.AccountID, Address: a.Address, Name: a.Name}
	}
	if len(accounts) == 0 {
		accounts = []account.Account{{AccountID: accountID}}
	}
	return &Settings{Base: base, Token: token, AccountID: accountID, Accounts: accounts}, nil
}

// Admin is the provision worker's admin API credential pair. It is a SECOND,
// deliberately separate identity from Settings.Base/.Token: the mail token
// authenticates a mailbox, the admin token authenticates an operator against
// the control plane (packages/cli/src/admin.ts:20). Both live in the same
// mirror `config` table, written by `bullmoose admin init` (admin.ts:130).
type Admin struct {
	URL   string
	Token string
}

// RequireAdmin reads adminUrl/adminToken, or fails with the SAME usage error
// admin.ts:528 raises — `agents` is a control-plane command, so an operator who
// has only ever logged in to mail must be told which credential is missing
// rather than shown a 401 from a URL they never configured.
func RequireAdmin(db *sql.DB) (*Admin, error) {
	url := getConfig(db, "adminUrl")
	token := getConfig(db, "adminToken")
	if url == "" || token == "" {
		return nil, bmio.Usage(
			"admin not configured — run: bullmoose admin init --url <provision-url> --token <admin-token>")
	}
	return &Admin{URL: strings.TrimRight(url, "/"), Token: token}, nil
}

// getConfig reads one config value, or "" — db.ts:118 getConfig. Any error
// (missing row, or a fresh file without the config table at all) is treated as
// "absent", which routes to the not-configured usage error above just as it
// would in Node.
func getConfig(db *sql.DB, key string) string {
	var value string
	if err := db.QueryRow("SELECT value FROM config WHERE key = ?", key).Scan(&value); err != nil {
		return ""
	}
	return value
}
