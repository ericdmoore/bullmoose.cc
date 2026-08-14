package store

// The mirror's DDL, and the schema-creating open that `login` and `init` use.
//
// ── Why the .sql files are EMBEDDED rather than read ────────────────────────
//
// The whole argument for the Go port is a binary you `scp` to a host with no
// Node, no repo and no package manager (arch.md §1). Reading
// packages/mailstore/sql/data-plane.sql at runtime the way db.ts:110 does would
// make that binary depend on a checkout, so the DDL is compiled in with
// `go:embed`. `go:embed` cannot reach outside the module directory (cli-go is
// its own module, devPlan.md:58), so the two files here are COPIES.
//
// A silent copy would be the wrong answer, so it is not silent: schema_test.go
// byte-compares each embedded file against the repo original and fails with the
// `cp` that fixes it. The canonical files stay on the TypeScript side —
// packages/mailstore/sql/data-plane.sql (shared with the server's D1) and
// packages/cli/sql/local.sql (the three CLI-only tables, extracted from db.ts's
// LOCAL_SCHEMA literal in this same wave so the comparison could be over BYTES
// rather than a regex over another language's source, which is the mechanism
// arch.md §5 calls crude and only tolerates where nothing better exists).
//
// ── Why this is not in Open ────────────────────────────────────────────────
//
// Open (store.go) deliberately does not run the DDL: reads are the overwhelming
// majority of invocations and re-running ~40 CREATE-IF-NOT-EXISTS statements on
// every `bullmoose log` spends startup — the thing the port is fastest at — on a
// mirror that already exists. db.ts:80 does run it on every command because its
// openDb is the only door. Here the two doors are named: readers Open, and the
// two commands that CREATE a mirror (login, init) call Init.

import (
	"database/sql"
	_ "embed"
	"os"
	"path/filepath"
)

// dataPlaneSQL is packages/mailstore/sql/data-plane.sql — the SAME tables the
// server's D1 data plane has, so a local query is the same SQL you would run
// server-side (db.ts:52).
//
//go:embed sql/data-plane.sql
var dataPlaneSQL string

// localSQL is packages/cli/sql/local.sql — config, sync_state and the populated
// FTS index. Client-only tables; the server has no use for them.
//
//go:embed sql/local.sql
var localSQL string

// columnMigrations are the ALTERs db.ts:101 applies to a PRE-EXISTING mirror
// before the schema file runs, because a CREATE TABLE IF NOT EXISTS never adds a
// column to a table that already exists. An error means "already there", which
// is exactly the wanted outcome — so, as in db.ts, every error is discarded.
var columnMigrations = []string{
	"ALTER TABLE contact_cards ADD COLUMN dav_name TEXT",
}

// Init opens the mirror and creates its schema — the Go port of db.ts:80 openDb,
// including the file modes. It is what makes a machine with ONLY the Go binary
// able to `login`/`init` and then sync: before this wave the mirror could only
// be created by the Node CLI, so `watch` on a fresh host had nothing to read.
//
// Idempotent by construction (every statement is IF NOT EXISTS), so running it
// against a mirror the Node CLI created is a no-op — decision 4 (devPlan.md:196)
// is "same file, same schema", and this is the half of it that writes.
func Init(path string) (*sql.DB, error) {
	// The mirror holds the bearer token AND the synced mailbox — owner-only,
	// both the directory and the file (db.ts:83).
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	_, statErr := os.Stat(path)
	preexisting := statErr == nil

	db, err := Open(path)
	if err != nil {
		return nil, err
	}
	// WAL, and the first statement that actually creates the file — database/sql
	// connects lazily, so the chmod below has to come after it.
	if _, err := db.Exec("PRAGMA journal_mode = WAL"); err != nil {
		_ = db.Close()
		return nil, err
	}
	if !preexisting {
		// db.ts:87 — the db and its WAL sidecars, each best-effort because a
		// sidecar may not exist yet.
		for _, p := range []string{path, path + "-wal", path + "-shm"} {
			_ = os.Chmod(p, 0o600)
		}
	}

	for _, m := range columnMigrations {
		_, _ = db.Exec(m)
	}
	for _, schema := range []string{dataPlaneSQL, localSQL} {
		if _, err := db.Exec(schema); err != nil {
			_ = db.Close()
			return nil, err
		}
	}
	return db, nil
}

// SetConfig writes one config row — db.ts:125 setConfig, INSERT OR REPLACE so a
// second `login` overwrites the first rather than failing on the primary key.
func SetConfig(db *sql.DB, key, value string) error {
	_, err := db.Exec("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", key, value)
	return err
}

// GetConfig reads one config value, or "" — the exported form of getConfig
// (store.go), for the tests and commands that need to read back what they wrote.
func GetConfig(db *sql.DB, key string) string { return getConfig(db, key) }
