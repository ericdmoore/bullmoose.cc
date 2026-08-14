package cmd

// The triage verbs (sVOL 019) against a fake that MODELS Email/set rather than
// merely answering it, so three different things can be asserted separately:
//
//   - the REQUEST the CLI sent (byte for byte, because the patch shape is the
//     scope discipline: a keywords-only patch charges `annotate`, a mailboxIds
//     patch charges `move`, and a bundled one would need both);
//   - what the SERVER ended up holding (the choreography half — a local-only
//     write would pass every mirror check and be invisible to the server);
//   - what the MIRROR ended up holding (the reconcile half — a verb that wrote
//     to the server and skipped reconciliation leaves every second stage of a
//     pipeline describing the old world).
//
// A test that only checked the exit code would pass against a port that got any
// of the three wrong.

import (
	"database/sql"
	"strings"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// triageFixture stands up the fake, a seeded mirror with the six role mailboxes,
// and returns both. Every triage test starts here so the mailbox resolver has
// something to resolve and the reconcile has somewhere to write.
func triageFixture(t *testing.T) (*mailFake, string) {
	t.Helper()
	fake := newMailFake()
	fake.mailboxes = `[{"id":"mb_inbox","name":"Inbox","role":"inbox"},` +
		`{"id":"mb_archive","name":"Archive","role":"archive"},` +
		`{"id":"mb_junk","name":"Junk","role":"junk"},` +
		`{"id":"mb_trash","name":"Trash","role":"trash"},` +
		`{"id":"mb_receipts","name":"Receipts","role":null}]`
	srv := fake.start(t)
	dbPath := seedMailMirror(t, srv.URL, "bm_token", "")

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, mb := range [][]any{
		{"mb_inbox", "Inbox", "inbox"},
		{"mb_archive", "Archive", "archive"},
		{"mb_junk", "Junk", "junk"},
		{"mb_trash", "Trash", "trash"},
		{"mb_receipts", "Receipts", nil},
	} {
		if _, err := db.Exec(
			`INSERT INTO mailboxes (id, account_id, parent_id, name, role, sort_order)
			 VALUES (?, 'a_you', NULL, ?, ?, 0)`, mb[0], mb[1], mb[2]); err != nil {
			t.Fatal(err)
		}
	}
	// stdin is not a terminal under `go test`, so collectIDs would read the test
	// binary's stdin. Pin it empty: the no-target cases must be about the ARGV.
	withStdin(t, "")
	return fake, dbPath
}

// mirrorMailboxes reads a message's mailbox membership out of the LOCAL MIRROR —
// what `search`/`log`/`mailboxes` would report.
func mirrorMailboxes(t *testing.T, dbPath, id string) []string {
	t.Helper()
	return mirrorColumn(t, dbPath,
		`SELECT mailbox_id FROM email_mailboxes WHERE email_id = ? ORDER BY mailbox_id`, id)
}

func mirrorKeywords(t *testing.T, dbPath, id string) []string {
	t.Helper()
	return mirrorColumn(t, dbPath,
		`SELECT keyword FROM email_keywords WHERE email_id = ? ORDER BY keyword`, id)
}

func mirrorColumn(t *testing.T, dbPath, query, id string) []string {
	t.Helper()
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query(query, id)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v)
	}
	return out
}

// seedMirrorRow puts a message in the mirror in the state the SERVER currently
// holds it, so a reconcile assertion is about the verb's write and not about the
// row having been absent all along.
func seedMirrorRow(t *testing.T, dbPath, id string, mailboxes, keywords []string) {
	t.Helper()
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(
		`INSERT INTO emails (id, account_id, blob_id, thread_id, subject, size, received_at)
		 VALUES (?, 'a_you', 'b_1', 'th_1', 'subject', 42, 1)`, id); err != nil {
		t.Fatal(err)
	}
	for _, mb := range mailboxes {
		if _, err := db.Exec(
			`INSERT INTO email_mailboxes (account_id, email_id, mailbox_id) VALUES ('a_you', ?, ?)`,
			id, mb); err != nil {
			t.Fatal(err)
		}
	}
	for _, kw := range keywords {
		if _, err := db.Exec(
			`INSERT INTO email_keywords (account_id, email_id, keyword) VALUES ('a_you', ?, ?)`,
			id, kw); err != nil {
			t.Fatal(err)
		}
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// ---- the request shape, per verb -------------------------------------------

// TestTriageSendsTheRightEmailSetRequest pins the exact `Email/set` args each
// verb sends. This is the scope discipline made checkable: `flag` and `seen` must
// carry NO mailboxIds key (or the server charges `move` as well as `annotate`,
// and a token scoped to annotate alone is refused), `move` and its sugar must
// carry NO keywords key, and `label` must patch mailboxIds PER KEY rather than
// replacing the set — a replace there is the classic mail-CLI bug that silently
// unfiles a message.
func TestTriageSendsTheRightEmailSetRequest(t *testing.T) {
	cases := []struct {
		name string
		argv []string
		want string
	}{
		{"seen sets $seen and nothing else", []string{"seen", "em_1"},
			`{"accountId":"a_you","update":{"em_1":{"keywords/$seen":true}}}`},
		{"seen --unset clears it", []string{"seen", "em_1", "--unset"},
			`{"accountId":"a_you","update":{"em_1":{"keywords/$seen":null}}}`},
		{"flag adds and removes keywords in order", []string{"flag", "em_1",
			"--add", "$flagged", "--add", "$important", "--remove", "$seen"},
			`{"accountId":"a_you","update":{"em_1":` +
				`{"keywords/$flagged":true,"keywords/$important":true,"keywords/$seen":null}}}`},
		{"archive REPLACES the mailbox set", []string{"archive", "em_1"},
			`{"accountId":"a_you","update":{"em_1":{"mailboxIds":{"mb_archive":true}}}}`},
		{"junk resolves its role", []string{"junk", "em_1"},
			`{"accountId":"a_you","update":{"em_1":{"mailboxIds":{"mb_junk":true}}}}`},
		{"trash resolves its role", []string{"trash", "em_1"},
			`{"accountId":"a_you","update":{"em_1":{"mailboxIds":{"mb_trash":true}}}}`},
		{"move --mailbox by name", []string{"move", "em_1", "--mailbox", "Receipts"},
			`{"accountId":"a_you","update":{"em_1":{"mailboxIds":{"mb_receipts":true}}}}`},
		{"label ADDS per key, keeping the rest", []string{"label", "em_1", "--add", "Receipts"},
			`{"accountId":"a_you","update":{"em_1":{"mailboxIds/mb_receipts":true}}}`},
		{"many ids ride one request, in argv order", []string{"archive", "em_1", "em_2"},
			`{"accountId":"a_you","update":{"em_1":{"mailboxIds":{"mb_archive":true}},` +
				`"em_2":{"mailboxIds":{"mb_archive":true}}}}`},
		{"--if-state rides along, before update", []string{"archive", "em_1", "--if-state", "emstate-1"},
			`{"accountId":"a_you","ifInState":"emstate-1","update":{"em_1":{"mailboxIds":{"mb_archive":true}}}}`},
		{"rm destroys", []string{"rm", "em_1", "--force"},
			`{"accountId":"a_you","destroy":["em_1"]}`},
		{"delete is the same request as rm", []string{"delete", "em_1", "--force"},
			`{"accountId":"a_you","destroy":["em_1"]}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fake, dbPath := triageFixture(t)
			fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)
			fake.addTriageEmail("em_2", []string{"mb_inbox"}, nil)

			_, errOut, code := runCmd(t, runTriage, dbPath, c.argv[0], c.argv[1:]...)
			if code != 0 {
				t.Fatalf("exit %d: %s", code, errOut)
			}
			if got := fake.argsOf("Email/set"); got != c.want {
				t.Errorf("Email/set args =\n  %s\nwant\n  %s", got, c.want)
			}
		})
	}
}

// TestTriageWritesToTheServerAndThenTheMirror is done-when #2 and #3 together,
// and they are the same bug from two sides. A verb that only touched the mirror
// passes every same-machine read and is invisible to the server forever; one that
// only touched the server leaves `search`/`log` describing the old world until
// the next sync.
func TestTriageWritesToTheServerAndThenTheMirror(t *testing.T) {
	fake, dbPath := triageFixture(t)
	fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)
	seedMirrorRow(t, dbPath, "em_1", []string{"mb_inbox"}, nil)

	out, errOut, code := runCmd(t, runTriage, dbPath, "archive", "em_1")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	// stdout is the ids it acted on, so verbs chain (arch.md §1.1).
	if out != "em_1\n" {
		t.Errorf("stdout = %q, want the acted-on id", out)
	}
	if got := fake.mailboxesOf("em_1"); !equalStrings(got, []string{"mb_archive"}) {
		t.Errorf("the SERVER has %v — the write never left the machine", got)
	}
	if got := mirrorMailboxes(t, dbPath, "em_1"); !equalStrings(got, []string{"mb_archive"}) {
		t.Errorf("the MIRROR has %v — the verb skipped reconciliation, so `log` is stale", got)
	}
	// The reconcile is a re-FETCH of the confirmed id, not a guess: Email/get must
	// come after Email/set.
	names := fake.names()
	if last := names[len(names)-1]; last != "Email/get" {
		t.Errorf("call sequence %v — the reconcile must re-fetch AFTER the write", names)
	}
}

// TestTriageReconcilesOnlyConfirmedIds: sVOL 019 is explicit that reconciling
// optimistically re-introduces the divergence reconciliation exists to prevent.
// em_nope is refused by the server, so it must not appear in the re-fetch.
func TestTriageReconcilesOnlyConfirmedIds(t *testing.T) {
	fake, dbPath := triageFixture(t)
	fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)
	seedMirrorRow(t, dbPath, "em_1", []string{"mb_inbox"}, nil)

	_, _, code := runCmd(t, runTriage, dbPath, "archive", "em_1", "em_nope")
	if code != int(bmio.ExitNotFound) {
		t.Fatalf("exit = %d, want 3 (notFound) — one id failed", code)
	}
	if got := fake.argsOf("Email/get"); !strings.Contains(got, `"em_1"`) || strings.Contains(got, "em_nope") {
		t.Errorf("reconcile fetched %s — only the ids the server CONFIRMED may be re-fetched", got)
	}
}

// TestTriageNoSyncSkipsTheReconcile — the `--no-sync` opt-out for a caller that
// batches and syncs once at the end.
func TestTriageNoSyncSkipsTheReconcile(t *testing.T) {
	fake, dbPath := triageFixture(t)
	fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)
	seedMirrorRow(t, dbPath, "em_1", []string{"mb_inbox"}, nil)

	if _, errOut, code := runCmd(t, runTriage, dbPath, "archive", "em_1", "--no-sync"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	for _, n := range fake.names() {
		if n == "Email/get" {
			t.Errorf("--no-sync still reconciled: %v", fake.names())
		}
	}
	if got := mirrorMailboxes(t, dbPath, "em_1"); !equalStrings(got, []string{"mb_inbox"}) {
		t.Errorf("mirror = %v — --no-sync must leave it for the next sync", got)
	}
}

// TestTriageSeenAndFlagLandOnTheMirrorsKeywords — the keyword half of the same
// reconcile, which `log`'s unread dot reads.
func TestTriageSeenAndFlagLandOnTheMirrorsKeywords(t *testing.T) {
	fake, dbPath := triageFixture(t)
	fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)
	seedMirrorRow(t, dbPath, "em_1", []string{"mb_inbox"}, nil)

	if _, errOut, code := runCmd(t, runTriage, dbPath, "seen", "em_1"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if got := fake.keywordsOf("em_1"); !equalStrings(got, []string{"$seen"}) {
		t.Errorf("server keywords = %v", got)
	}
	if got := mirrorKeywords(t, dbPath, "em_1"); !equalStrings(got, []string{"$seen"}) {
		t.Errorf("mirror keywords = %v — `log` would still show it unread", got)
	}
	if _, errOut, code := runCmd(t, runTriage, dbPath, "seen", "em_1", "--unset"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if got := mirrorKeywords(t, dbPath, "em_1"); len(got) != 0 {
		t.Errorf("mirror keywords after --unset = %v, want none", got)
	}
}

// TestRmDestroysAndDropsTheMirrorRow — the destroy half of the reconcile.
func TestRmDestroysAndDropsTheMirrorRow(t *testing.T) {
	fake, dbPath := triageFixture(t)
	fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)
	seedMirrorRow(t, dbPath, "em_1", []string{"mb_inbox"}, []string{"$seen"})

	out, errOut, code := runCmd(t, runTriage, dbPath, "rm", "em_1", "--force")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if out != "em_1\n" {
		t.Errorf("stdout = %q, want the destroyed id", out)
	}
	if fake.exists("em_1") {
		t.Error("the server still holds the message")
	}
	if got := mirrorMailboxes(t, dbPath, "em_1"); len(got) != 0 {
		t.Errorf("mirror still has membership rows: %v", got)
	}
	if got := mirrorKeywords(t, dbPath, "em_1"); len(got) != 0 {
		t.Errorf("mirror still has keyword rows: %v", got)
	}
}

// ---- the refusals, and their cost in requests ------------------------------

// TestTriageWithNoTargetSendsNOTHING is the zero-request assertion. A verb that
// resolved its account, opened a client, or — worst — sent a mutation before
// noticing it had no ids would be a command that half-acts on a typo.
//
// It covers EVERY verb, because the check lives in one place and a port that
// moved it into one branch would leave the others exposed.
func TestTriageWithNoTargetSendsNOTHING(t *testing.T) {
	for _, verb := range triageVerbs {
		t.Run(verb, func(t *testing.T) {
			fake, dbPath := triageFixture(t)
			fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)

			out, errOut, code := runCmd(t, runTriage, dbPath, verb)
			if code != int(bmio.ExitUsage) {
				t.Errorf("exit = %d, want 2", code)
			}
			if out != "" {
				t.Errorf("stdout = %q — a refusal is not a record", out)
			}
			if !strings.Contains(errOut, "ids as arguments, or piped on stdin") {
				t.Errorf("stderr = %q — the refusal must say how to name a target", errOut)
			}
			if calls := fake.names(); len(calls) != 0 {
				t.Errorf("a targetless %s sent %v — it must cost ZERO requests", verb, calls)
			}
		})
	}
}

// TestRmRefusesWithoutForceAndSendsNOTHING — the hard-delete gate. store's
// destroyEmail orphans the R2 blob and leaves no tombstone, so the refusal has to
// come before the request, not after it.
func TestRmRefusesWithoutForceAndSendsNOTHING(t *testing.T) {
	for _, verb := range []string{"rm", "delete"} {
		t.Run(verb, func(t *testing.T) {
			fake, dbPath := triageFixture(t)
			fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)

			out, errOut, code := runCmd(t, runTriage, dbPath, verb, "em_1")
			if code != int(bmio.ExitUsage) {
				t.Errorf("exit = %d, want 2", code)
			}
			if out != "" {
				t.Errorf("stdout = %q", out)
			}
			if !strings.Contains(errOut, "--force") || !strings.Contains(errOut, "bullmoose trash") {
				t.Errorf("stderr = %q — must name --force AND the safe path", errOut)
			}
			if calls := fake.names(); len(calls) != 0 {
				t.Errorf("%s without --force sent %v — nothing may reach the server", verb, calls)
			}
			if !fake.exists("em_1") {
				t.Error("the message was destroyed by a refused command")
			}
		})
	}
}

// TestDryRunResolvesAndWritesNOTHING is invariant 4: a dry run must resolve its
// target for real (so it is evidence of something) and mutate nothing (so it is
// safe). The Email/set is the assertion — a dry run that sent one is not a
// rehearsal.
func TestDryRunResolvesAndWritesNOTHING(t *testing.T) {
	for _, argv := range [][]string{
		{"trash", "em_1", "--dry-run"},
		{"archive", "em_1", "--dry-run"},
		{"rm", "em_1", "--dry-run"},
		{"seen", "em_1", "--dry-run"},
	} {
		t.Run(argv[0], func(t *testing.T) {
			fake, dbPath := triageFixture(t)
			fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)

			out, errOut, code := runCmd(t, runTriage, dbPath, argv[0], argv[1:]...)
			if code != 0 {
				t.Fatalf("exit %d: %s", code, errOut)
			}
			if !strings.Contains(errOut, "dry run: would "+argv[0]) {
				t.Errorf("stderr = %q — the rehearsal belongs on stderr", errOut)
			}
			if out != "" {
				t.Errorf("stdout = %q — a rehearsal acted on nothing, so it names nothing", out)
			}
			if got := fake.argsOf("Email/set"); got != "" {
				t.Errorf("--dry-run sent Email/set %s", got)
			}
			if got := fake.mailboxesOf("em_1"); !equalStrings(got, []string{"mb_inbox"}) {
				t.Errorf("the message moved: %v", got)
			}
		})
	}
}

// TestDryRunStillFailsOnAnUnresolvableTarget — a dry run that did not resolve
// would be evidence of nothing, so an unknown mailbox is still exit 3.
func TestDryRunStillFailsOnAnUnresolvableTarget(t *testing.T) {
	fake, dbPath := triageFixture(t)
	fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)

	_, errOut, code := runCmd(t, runTriage, dbPath, "move", "em_1", "--mailbox", "NoSuchBox", "--dry-run")
	if code != int(bmio.ExitNotFound) {
		t.Errorf("exit = %d, want 3", code)
	}
	if !strings.Contains(errOut, "no such mailbox: NoSuchBox") {
		t.Errorf("stderr = %q", errOut)
	}
}

// ---- failures the server reports -------------------------------------------

// TestUnknownIdSurfacesTheServersError: the server's own vocabulary decides the
// exit code (notFound → 3) and its sentence reaches stderr. A port that mapped
// every per-object refusal to a generic 1 would pass an exit-code-agnostic test
// and break every script that branches.
func TestUnknownIdSurfacesTheServersError(t *testing.T) {
	fake, dbPath := triageFixture(t)
	fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)

	out, errOut, code := runCmd(t, runTriage, dbPath, "archive", "em_nope")
	if code != int(bmio.ExitNotFound) {
		t.Errorf("exit = %d, want 3", code)
	}
	if out != "" {
		t.Errorf("stdout = %q — a failed id is not a result", out)
	}
	if !strings.Contains(errOut, "archive: em_nope failed: notFound") {
		t.Errorf("stderr = %q — must name the id AND the server's type", errOut)
	}
	if !strings.Contains(errOut, "archive: 0/1 ok") {
		t.Errorf("stderr = %q — must report the tally", errOut)
	}
	// Nothing was reconciled: there is no confirmed id to re-fetch, so the mirror
	// is not touched at all.
	if got := fake.argsOf("Email/get"); got != "" {
		t.Errorf("a wholly-failed verb still reconciled: %s", got)
	}
}

// TestPartialFailureIsHonest is done-when #7: archiving three ids where one does
// not exist archives the other two, prints THEM on stdout, names the failure on
// stderr, and still exits non-zero. Swallowing either half is a different bug.
func TestPartialFailureIsHonest(t *testing.T) {
	fake, dbPath := triageFixture(t)
	fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)
	fake.addTriageEmail("em_2", []string{"mb_inbox"}, nil)
	seedMirrorRow(t, dbPath, "em_1", []string{"mb_inbox"}, nil)
	seedMirrorRow(t, dbPath, "em_2", []string{"mb_inbox"}, nil)

	out, errOut, code := runCmd(t, runTriage, dbPath, "archive", "em_1", "em_2", "em_nope")
	if code != int(bmio.ExitNotFound) {
		t.Errorf("exit = %d, want 3 — non-zero because one id failed", code)
	}
	if out != "em_1\nem_2\n" {
		t.Errorf("stdout = %q — the two that worked, and only those", out)
	}
	if !strings.Contains(errOut, "em_nope failed: notFound") {
		t.Errorf("stderr = %q", errOut)
	}
	if !strings.Contains(errOut, "archive: 2/3 ok") {
		t.Errorf("stderr = %q — the tally must be honest about both halves", errOut)
	}
	// The successes were really applied, not rolled back by the failure.
	for _, id := range []string{"em_1", "em_2"} {
		if got := fake.mailboxesOf(id); !equalStrings(got, []string{"mb_archive"}) {
			t.Errorf("%s = %v on the server — a partial failure must not undo the successes", id, got)
		}
		if got := mirrorMailboxes(t, dbPath, id); !equalStrings(got, []string{"mb_archive"}) {
			t.Errorf("%s = %v in the mirror", id, got)
		}
	}
}

// TestStaleIfStateExitsFiveAndChangesNothing — invariant 6, both halves. The
// "changes nothing" half is the one people forget, and it is the reason
// Email/set checks ifInState before it touches anything.
func TestStaleIfStateExitsFiveAndChangesNothing(t *testing.T) {
	fake, dbPath := triageFixture(t)
	fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)

	out, errOut, code := runCmd(t, runTriage, dbPath, "archive", "em_1", "--if-state", "emstate-stale")
	if code != int(bmio.ExitConflict) {
		t.Errorf("exit = %d, want 5", code)
	}
	if out != "" {
		t.Errorf("stdout = %q", out)
	}
	if !strings.Contains(errOut, "stateMismatch") {
		t.Errorf("stderr = %q — must name the reason a retry could fix", errOut)
	}
	if got := fake.mailboxesOf("em_1"); !equalStrings(got, []string{"mb_inbox"}) {
		t.Errorf("the refused write moved the message to %v", got)
	}
}

// TestLabelRemoveOnTheOnlyMailboxRefusesClientSide is done-when #8. The server
// would answer `invalidProperties`, which is true but useless; the CLI knows the
// membership and can name the verb that does what the user meant.
func TestLabelRemoveOnTheOnlyMailboxRefusesClientSide(t *testing.T) {
	fake, dbPath := triageFixture(t)
	fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)

	out, errOut, code := runCmd(t, runTriage, dbPath, "label", "em_1", "--remove", "inbox")
	if code != int(bmio.ExitUsage) {
		t.Errorf("exit = %d, want 2 (a usage-class refusal, not a server invalidProperties)", code)
	}
	if out != "" {
		t.Errorf("stdout = %q", out)
	}
	if !strings.Contains(errOut, "use `move` to relocate instead") {
		t.Errorf("stderr = %q — must name `move`", errOut)
	}
	// Client-side means client-side: the guard's Email/get may happen, but no
	// Email/set may.
	if got := fake.argsOf("Email/set"); got != "" {
		t.Errorf("the refusal still wrote: %s", got)
	}
	if got := fake.mailboxesOf("em_1"); !equalStrings(got, []string{"mb_inbox"}) {
		t.Errorf("the message changed: %v", got)
	}
}

// TestLabelRemovePartiallyRefuses: the guard rejects only the ids it would empty,
// and the rest still go through. A guard that refused the whole batch would make
// one bad id cost forty good ones.
func TestLabelRemovePartiallyRefuses(t *testing.T) {
	fake, dbPath := triageFixture(t)
	fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)                // would empty
	fake.addTriageEmail("em_2", []string{"mb_inbox", "mb_receipts"}, nil) // survives
	seedMirrorRow(t, dbPath, "em_2", []string{"mb_inbox", "mb_receipts"}, nil)

	out, errOut, code := runCmd(t, runTriage, dbPath, "label", "em_1", "em_2", "--remove", "inbox")
	if code != int(bmio.ExitUsage) {
		t.Errorf("exit = %d, want 2", code)
	}
	if out != "em_2\n" {
		t.Errorf("stdout = %q — the id that could be relabelled", out)
	}
	if !strings.Contains(errOut, "em_1 failed") {
		t.Errorf("stderr = %q", errOut)
	}
	if got := fake.mailboxesOf("em_2"); !equalStrings(got, []string{"mb_receipts"}) {
		t.Errorf("em_2 = %v — the remove should have applied", got)
	}
	if got := fake.mailboxesOf("em_1"); !equalStrings(got, []string{"mb_inbox"}) {
		t.Errorf("em_1 = %v — the rejected id must be untouched", got)
	}
}

// ---- ids in, ids out --------------------------------------------------------

// TestTriageReadsIdsFromStdin — the other half of §1.8: `search --ids | archive`
// as well as `search --ids | xargs archive`.
func TestTriageReadsIdsFromStdin(t *testing.T) {
	fake, dbPath := triageFixture(t)
	fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)
	fake.addTriageEmail("em_2", []string{"mb_inbox"}, nil)
	withStdin(t, "em_1\nem_2\n")

	out, errOut, code := runCmd(t, runTriage, dbPath, "archive")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if out != "em_1\nem_2\n" {
		t.Errorf("stdout = %q", out)
	}
}

// TestExplicitIdsBeatStdin — arch.md §1.4's rule, the same one `send --body`
// follows: a script with stdin redirected somewhere must still be able to name
// its target on the command line.
func TestExplicitIdsBeatStdin(t *testing.T) {
	fake, dbPath := triageFixture(t)
	fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)
	fake.addTriageEmail("em_2", []string{"mb_inbox"}, nil)
	withStdin(t, "em_2\n")

	out, _, code := runCmd(t, runTriage, dbPath, "archive", "em_1")
	if code != 0 {
		t.Fatal(code)
	}
	if out != "em_1\n" {
		t.Errorf("stdout = %q — the argument, not the pipe", out)
	}
}

// TestTriageJSONRecords pins the --json shape per verb: one record per id, the
// verb's own extras, and the state to chain the next write on.
func TestTriageJSONRecords(t *testing.T) {
	cases := []struct {
		name string
		argv []string
		want string
	}{
		{"seen", []string{"seen", "em_1", "--json"},
			`{"id":"em_1","action":"seen","keywords":{"keywords/$seen":true},"state":"emstate-2"}`},
		{"archive", []string{"archive", "em_1", "--json"},
			`{"id":"em_1","action":"archive","mailbox":"mb_archive","mailboxName":"Archive","state":"emstate-2"}`},
		{"label", []string{"label", "em_1", "--add", "Receipts", "--json"},
			`{"id":"em_1","action":"label","add":["mb_receipts"],"remove":[],"state":"emstate-2"}`},
		{"rm", []string{"rm", "em_1", "--force", "--json"},
			`{"id":"em_1","action":"rm","destroyed":true,"state":"emstate-2"}`},
		{"dry run", []string{"trash", "em_1", "--dry-run", "--json"},
			`{"dryRun":true,"action":"trash","ids":["em_1"],"mailbox":"mb_trash","mailboxName":"Trash"}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fake, dbPath := triageFixture(t)
			fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)

			out, errOut, code := runCmd(t, runTriage, dbPath, c.argv[0], c.argv[1:]...)
			if code != 0 {
				t.Fatalf("exit %d: %s", code, errOut)
			}
			if got := strings.TrimRight(out, "\n"); got != c.want {
				t.Errorf("--json =\n  %s\nwant\n  %s", got, c.want)
			}
		})
	}
}

// TestMoveRefusesAnAmbiguousInvocation — --role and --mailbox mean different
// things and naming both is a mistake, not a preference to resolve.
func TestMoveRefusesAnAmbiguousInvocation(t *testing.T) {
	fake, dbPath := triageFixture(t)
	fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)

	cases := []struct {
		argv     []string
		contains string
	}{
		{[]string{"move", "em_1"}, "--role <role> | --mailbox <id-or-name>"},
		{[]string{"move", "em_1", "--role", "archive", "--mailbox", "Receipts"}, "not both"},
		{[]string{"flag", "em_1"}, "--add <keyword>"},
		{[]string{"label", "em_1"}, "--add <mailbox>"},
	}
	for _, c := range cases {
		_, errOut, code := runCmd(t, runTriage, dbPath, c.argv[0], c.argv[1:]...)
		if code != int(bmio.ExitUsage) {
			t.Errorf("%v: exit = %d, want 2", c.argv, code)
		}
		if !strings.Contains(errOut, c.contains) {
			t.Errorf("%v: stderr = %q, want it to contain %q", c.argv, errOut, c.contains)
		}
		if got := fake.argsOf("Email/set"); got != "" {
			t.Errorf("%v: a usage error still wrote: %s", c.argv, got)
		}
	}
}

// TestTriageResolvesTheMailboxFromTheMirrorFirst — 019's bread-crumb: the roles
// are in the mirror, so `archive` should not cost a Mailbox/get round trip. The
// fallback is exercised by the sibling test below.
func TestTriageResolvesTheMailboxFromTheMirrorFirst(t *testing.T) {
	fake, dbPath := triageFixture(t)
	fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)

	if _, errOut, code := runCmd(t, runTriage, dbPath, "archive", "em_1"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	for _, n := range fake.names() {
		if n == "Mailbox/get" {
			t.Errorf("resolved the role over the network: %v", fake.names())
		}
	}
}

// TestTriageFallsBackToMailboxGetOnAnEmptyMirror — `archive` must work before the
// first `sync`, which is exactly when the mirror has no mailboxes.
func TestTriageFallsBackToMailboxGetOnAnEmptyMirror(t *testing.T) {
	fake := newMailFake()
	fake.mailboxes = `[{"id":"mb_inbox","name":"Inbox","role":"inbox"},` +
		`{"id":"mb_archive","name":"Archive","role":"archive"}]`
	srv := fake.start(t)
	dbPath := seedMailMirror(t, srv.URL, "bm_token", "")
	fake.addTriageEmail("em_1", []string{"mb_inbox"}, nil)
	withStdin(t, "")

	if _, errOut, code := runCmd(t, runTriage, dbPath, "archive", "em_1"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if got := fake.argsOf("Email/set"); got !=
		`{"accountId":"a_you","update":{"em_1":{"mailboxIds":{"mb_archive":true}}}}` {
		t.Errorf("Email/set args = %s", got)
	}
}
