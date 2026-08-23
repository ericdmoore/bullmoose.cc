package store

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestEmbeddedSchemaMatchesRepo is the drift check that makes the embedded copies
// legitimate.
//
// A static binary cannot read packages/mailstore/sql/data-plane.sql at runtime
// and `go:embed` cannot reach outside cli-go's module, so the DDL is copied in
// (schema.go's header). The copy is only defensible while something notices when
// the original moves: this is that something, and it is a BYTE comparison — the
// canonical CLI-local schema was extracted out of db.ts's LOCAL_SCHEMA literal
// into packages/cli/sql/local.sql in the same wave so it could be.
//
// Skips (rather than fails) when the repo is not above this checkout, exactly as
// delegate/argv_test.go's readCliMain does: the module is buildable on its own,
// and a check that cannot run must say so instead of failing for the wrong
// reason. In CI the repo is always there, so the check always runs.
func TestEmbeddedSchemaMatchesRepo(t *testing.T) {
	for _, c := range []struct{ repo, embedded, copied string }{
		{"packages/mailstore/sql/data-plane.sql", dataPlaneSQL, "cli-go/internal/store/sql/data-plane.sql"},
		// packages/cli/sql/local.sql was the second row here until the Node
		// CLI's removal; cli-go/internal/store/sql/local.sql is canonical now,
		// and the embed IS the copy, so there is no pair left to compare.
	} {
		want, ok := repoFile(t, c.repo)
		if !ok {
			continue
		}
		if want != c.embedded {
			t.Errorf("%s and its embedded copy have DRIFTED — the Go CLI would create a mirror "+
				"the Node CLI does not agree with (decision 4: same file, same schema).\n"+
				"    fix: cp %s %s", c.repo, c.repo, c.copied)
		}
	}
}

// TestInitCreatesAReadableMirror is the standalone-binary claim, asserted rather
// than described: after Init, the tables every read command queries exist and
// answer. Before this wave the Go binary could not create a mirror at all — only
// the Node CLI's login/init could — which is what made `watch` unable to stand
// alone.
func TestInitCreatesAReadableMirror(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fresh", "mail.db")
	db, err := Init(path)
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	defer db.Close()

	// One query per table the wave-1/2 commands actually read, so a schema that
	// created "some" tables cannot pass.
	for _, q := range []string{
		"SELECT COUNT(*) FROM config",
		"SELECT COUNT(*) FROM sync_state",
		"SELECT COUNT(*) FROM emails",
		"SELECT COUNT(*) FROM mailboxes",
		"SELECT COUNT(*) FROM email_mailboxes",
		"SELECT COUNT(*) FROM email_keywords",
		"SELECT COUNT(*) FROM cli_fts",
		"SELECT COUNT(*) FROM contact_cards",
	} {
		var n int
		if err := db.QueryRow(q).Scan(&n); err != nil {
			t.Errorf("%s: %v", q, err)
		}
	}

	// dav_name is the column db.ts:101 ALTERs into a pre-existing mirror; on a
	// fresh one the schema file supplies it. Either way it must be queryable, or
	// a Node CLI writing contacts into this mirror fails.
	var dav any
	if err := db.QueryRow("SELECT dav_name FROM contact_cards LIMIT 1").Scan(&dav); err != nil && err.Error() != "sql: no rows in result set" {
		t.Errorf("contact_cards.dav_name missing: %v", err)
	}

	if err := SetConfig(db, "base", "https://example.test"); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	if err := SetConfig(db, "base", "https://second.test"); err != nil {
		t.Fatalf("SetConfig (overwrite): %v", err)
	}
	if got := GetConfig(db, "base"); got != "https://second.test" {
		t.Errorf("config base = %q, want the overwritten value", got)
	}
}

// TestInitIsIdempotentOverAnExistingMirror pins decision 4 (devPlan.md:196):
// running the Go schema over a mirror that already exists must neither fail nor
// lose data — a user mid-migration keeps their local mail.
func TestInitIsIdempotentOverAnExistingMirror(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mail.db")
	first, err := Init(path)
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	if _, err := first.Exec(
		"INSERT INTO emails (account_id, id, blob_id, thread_id, received_at, size) VALUES (?,?,?,?,?,?)",
		"a_1", "em_1", "b_1", "th_1", 1, 10); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := SetConfig(first, "token", "bm_keep_me"); err != nil {
		t.Fatal(err)
	}
	_ = first.Close()

	second, err := Init(path)
	if err != nil {
		t.Fatalf("second Init over an existing mirror: %v", err)
	}
	defer second.Close()
	var n int
	if err := second.QueryRow("SELECT COUNT(*) FROM emails").Scan(&n); err != nil || n != 1 {
		t.Errorf("re-running the schema lost mail: count=%d err=%v", n, err)
	}
	if got := GetConfig(second, "token"); got != "bm_keep_me" {
		t.Errorf("re-running the schema lost config: token=%q", got)
	}
}

// TestInitFileModes: the mirror holds a bearer token and every synced message, so
// it is owner-only — db.ts:83/87 makes both the directory and the file 0700/0600,
// and a port that skips it leaves a readable token on a shared host.
func TestInitFileModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX modes")
	}
	dir := filepath.Join(t.TempDir(), "dot-bullmoose")
	path := filepath.Join(dir, "mail.db")
	db, err := Init(path)
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	defer db.Close()

	di, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := di.Mode().Perm(); got != 0o700 {
		t.Errorf("mirror directory mode = %04o, want 0700 (db.ts:83)", got)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := fi.Mode().Perm(); got != 0o600 {
		t.Errorf("mirror file mode = %04o, want 0600 — it holds the bearer token (db.ts:87)", got)
	}
}

// repoFile reads a repo-relative file by walking up from the test's directory,
// the way delegate/argv_test.go finds packages/cli/src/main.ts. Reports false
// when this checkout has no repo above it.
func repoFile(t *testing.T, rel string) (string, bool) {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel))); err == nil {
			return string(b), true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Logf("%s not found above the test directory — schema drift is unchecked in this checkout", rel)
			return "", false
		}
		dir = parent
	}
}
