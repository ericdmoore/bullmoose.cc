package cmd

// `mailbox` is a PORTED command, so these tests are written against
// packages/cli/src/mailbox.ts's behaviour rather than against the Go code: every
// expected string below is what the TypeScript prints for the same fixture, and
// every request shape is the one it sends.

import (
	"encoding/json"
	"strings"
	"testing"
)

func mailboxEnv(t *testing.T, f *mailFake) string {
	t.Helper()
	f.withMailboxTree()
	f.start(t)
	return seedMailMirror(t, f.base, "bm_tok", "")
}

// ---- create -----------------------------------------------------------------

// The happy path, and the request it sends: Mailbox/get to resolve, then
// Mailbox/set with the create spec in mailbox.ts:61's key order.
func TestMailbox_Create(t *testing.T) {
	f := newMailFake()
	out, errOut, code := runCmd(t, runMailbox, mailboxEnv(t, f), "mailbox", "create", "Receipts")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %q", code, errOut)
	}
	if out != "created Receipts (mb_new_1)\n" {
		t.Errorf("stdout = %q", out)
	}
	// A write reports the state it landed on, so a script can chain --if-state.
	if !strings.Contains(errOut, "state mbstate-2  (pass to --if-state on the next write)") {
		t.Errorf("stderr should report the new state:\n%s", errOut)
	}
	if got, want := strings.Join(f.names(), ","), "Mailbox/get,Mailbox/set,Mailbox/get"; got != want {
		// The trailing get is refreshMailboxes: the mirror `bullmoose mailboxes`
		// reads must be current without a full sync (mailbox.ts:25).
		t.Errorf("call sequence = %s, want %s", got, want)
	}
	if got, want := f.argsOf("Mailbox/set"),
		`{"accountId":"a_you","create":{"c1":{"name":"Receipts"}}}`; got != want {
		t.Errorf("Mailbox/set args = %s\nwant %s", got, want)
	}
	if got, want := f.argsOf("Mailbox/get"), `{"accountId":"a_you","ids":null}`; got != want {
		t.Errorf("Mailbox/get args = %s, want %s", got, want)
	}
}

// --parent and --sort ride along IN ORDER, and both are resolved before the write.
func TestMailbox_CreateWithParentAndSort(t *testing.T) {
	f := newMailFake()
	_, errOut, code := runCmd(t, runMailbox, mailboxEnv(t, f),
		"mailbox", "create", "2026", "--parent", "Empty", "--sort", "7")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %q", code, errOut)
	}
	if got, want := f.argsOf("Mailbox/set"),
		`{"accountId":"a_you","create":{"c1":{"name":"2026","parentId":"mb_empty","sortOrder":7}}}`; got != want {
		t.Errorf("Mailbox/set args = %s\nwant %s", got, want)
	}
}

// A parent that does not resolve is NOT FOUND, and nothing is written.
func TestMailbox_CreateUnknownParent(t *testing.T) {
	f := newMailFake()
	_, errOut, code := runCmd(t, runMailbox, mailboxEnv(t, f),
		"mailbox", "create", "X", "--parent", "NoSuchBox")
	if code != 3 {
		t.Errorf("code = %d, want 3 (notFound)", code)
	}
	if errOut != "error: no such mailbox: NoSuchBox\n" {
		t.Errorf("stderr = %q", errOut)
	}
	if got := strings.Join(f.names(), ","); got != "Mailbox/get" {
		t.Errorf("an unresolvable parent must not reach Mailbox/set; calls = %s", got)
	}
}

// `--sort` is a non-negative integer or a usage error naming what was typed
// (mailbox.ts:202). `Number("")` is 0, so an EMPTY --sort is a legal 0 — the same
// surprising-but-real answer the TypeScript gives.
func TestMailbox_SortValidation(t *testing.T) {
	for _, c := range []struct {
		sort string
		code int
	}{
		{"0", 0}, {"7", 0}, {"", 0}, {" 4 ", 0}, {"1e3", 0},
		{"notanumber", 2}, {"1.5", 2}, {"-2", 2}, {"Infinity", 2},
	} {
		f := newMailFake()
		_, errOut, code := runCmd(t, runMailbox, mailboxEnv(t, f),
			"mailbox", "create", "X", "--sort", c.sort)
		if code != c.code {
			t.Errorf("--sort %q → code %d, want %d (%s)", c.sort, code, c.code, errOut)
		}
		if c.code == 2 {
			want := "error: --sort must be a non-negative integer, got \"" + c.sort + "\"\n"
			if errOut != want {
				t.Errorf("--sort %q stderr = %q, want %q", c.sort, errOut, want)
			}
			// The resolve has already happened (mailbox.ts:60 gets the boxes
			// before parsing --sort), but nothing may be WRITTEN.
			if got := strings.Join(f.names(), ","); got != "Mailbox/get" {
				t.Errorf("--sort %q sent %s; a refusal must write nothing", c.sort, got)
			}
		}
	}
}

// ---- rename / move / rm -----------------------------------------------------

func TestMailbox_Rename(t *testing.T) {
	f := newMailFake()
	out, _, code := runCmd(t, runMailbox, mailboxEnv(t, f), "mailbox", "rename", "Empty", "Spare")
	if code != 0 || out != "renamed Spare (mb_empty)\n" {
		t.Fatalf("code=%d out=%q", code, out)
	}
	if got, want := f.argsOf("Mailbox/set"),
		`{"accountId":"a_you","update":{"mb_empty":{"name":"Spare"}}}`; got != want {
		t.Errorf("Mailbox/set args = %s\nwant %s", got, want)
	}
	// The rename really landed on the server, not just in the report.
	if got := strings.Join(f.boxNames(), ","); !strings.Contains(got, "Spare") {
		t.Errorf("the fake still holds %s", got)
	}
}

// A selector is an id, a ROLE, or a name — and s12 renamed the junk mailbox's
// DISPLAY name to "Quarantined" while leaving the role `junk`
// (infra/migrations.mjs:575). Both spellings must resolve, and neither is
// hardcoded in the CLI: `--role`-style selection reads the server's role and the
// report prints the server's name.
func TestMailbox_SelectorAcceptsRoleAndDisplayName(t *testing.T) {
	for _, selector := range []string{"junk", "Quarantined", "quarantined", "mb_junk"} {
		f := newMailFake()
		out, errOut, code := runCmd(t, runMailbox, mailboxEnv(t, f), "mailbox", "rm", selector)
		if code != 0 {
			t.Fatalf("%q → code %d (%s)", selector, code, errOut)
		}
		if out != "destroyed Quarantined (mb_junk)\n" {
			t.Errorf("%q → stdout %q, want the SERVER's display name", selector, out)
		}
	}
}

func TestMailbox_Move(t *testing.T) {
	f := newMailFake()
	db := mailboxEnv(t, f)
	if _, errOut, code := runCmd(t, runMailbox, db,
		"mailbox", "move", "Empty", "--parent", "Inbox"); code != 0 {
		t.Fatalf("code = %d (%s)", code, errOut)
	}
	if got, want := f.argsOf("Mailbox/set"),
		`{"accountId":"a_you","update":{"mb_empty":{"parentId":"mb_inbox"}}}`; got != want {
		t.Errorf("Mailbox/set args = %s\nwant %s", got, want)
	}

	// "-" is the only way to say "top level" on a command line (mailbox.ts:95),
	// and it must reach the wire as JSON null.
	f.reset()
	if _, errOut, code := runCmd(t, runMailbox, db,
		"mailbox", "move", "Empty", "--parent", "-"); code != 0 {
		t.Fatalf("code = %d (%s)", code, errOut)
	}
	if got, want := f.argsOf("Mailbox/set"),
		`{"accountId":"a_you","update":{"mb_empty":{"parentId":null}}}`; got != want {
		t.Errorf("`--parent -` args = %s\nwant %s", got, want)
	}
}

// --force is onDestroyRemoveEmails, and it is ABSENT rather than false without
// the flag — which is what makes the server refuse a folder holding mail.
func TestMailbox_RemoveForce(t *testing.T) {
	f := newMailFake()
	out, errOut, code := runCmd(t, runMailbox, mailboxEnv(t, f), "mailbox", "rm", "Full", "--force")
	if code != 0 {
		t.Fatalf("code = %d (%s)", code, errOut)
	}
	if out != "destroyed Full (mb_full)\n" {
		t.Errorf("stdout = %q", out)
	}
	if got, want := f.argsOf("Mailbox/set"),
		`{"accountId":"a_you","destroy":["mb_full"],"onDestroyRemoveEmails":true}`; got != want {
		t.Errorf("Mailbox/set args = %s\nwant %s", got, want)
	}
}

// The §1.5 table, through a SetError: `mailboxHasEmail` is exit 5 — the command
// was right, the folder's contents refused it — and the reason survives.
func TestMailbox_RemoveRefusedByContents(t *testing.T) {
	f := newMailFake()
	out, errOut, code := runCmd(t, runMailbox, mailboxEnv(t, f), "mailbox", "rm", "Full")
	if code != 5 {
		t.Errorf("code = %d, want 5 (conflict)", code)
	}
	if errOut != "error: rm failed: mailboxHasEmail — 3 messages\n" {
		t.Errorf("stderr = %q, want io.ts:429's failSetError shape", errOut)
	}
	if out != "" {
		t.Errorf("nothing belongs on stdout: %q", out)
	}
	if got := strings.Join(f.boxNames(), ","); !strings.Contains(got, "Full") {
		t.Errorf("the refused destroy must have changed nothing; boxes = %s", got)
	}
}

// ---- the refusals that must cost ZERO requests -------------------------------

func TestMailbox_MissingArgumentsCostNothing(t *testing.T) {
	cases := []struct {
		argv []string
		want string
	}{
		{[]string{"mailbox"},
			"error: usage: unknown mailbox subcommand: (none) (create|rename|move|rm)\n"},
		{[]string{"mailbox", "nosuchverb"},
			"error: usage: unknown mailbox subcommand: nosuchverb (create|rename|move|rm)\n"},
		{[]string{"mailbox", "create"},
			"error: usage: bullmoose mailbox create <name> [--parent <id-or-name>] [--sort <n>]\n"},
		{[]string{"mailbox", "rename"},
			"error: usage: bullmoose mailbox rename <id-or-name> <new-name>\n"},
		{[]string{"mailbox", "rename", "Empty"},
			"error: usage: bullmoose mailbox rename <id-or-name> <new-name>\n"},
		{[]string{"mailbox", "move", "Empty"},
			"error: usage: bullmoose mailbox move <id-or-name> --parent <id-or-name|->\n"},
		{[]string{"mailbox", "move"},
			"error: usage: bullmoose mailbox move <id-or-name> --parent <id-or-name|->\n"},
		{[]string{"mailbox", "rm"},
			"error: usage: bullmoose mailbox rm <id-or-name> [--force] [--dry-run]\n"},
	}
	for _, c := range cases {
		f := newMailFake()
		out, errOut, code := runCmd(t, runMailbox, mailboxEnv(t, f), c.argv[0], c.argv[1:]...)
		if code != 2 {
			t.Errorf("%v → code %d, want 2 (usage)", c.argv, code)
		}
		if errOut != c.want {
			t.Errorf("%v → stderr %q, want %q", c.argv, errOut, c.want)
		}
		if out != "" {
			t.Errorf("%v → stdout %q, want silence", c.argv, out)
		}
		if len(f.calls) != 0 {
			t.Errorf("%v cost %d request(s); a refusal must cost ZERO", c.argv, len(f.calls))
		}
	}
}

// An unresolvable target is exit 3 having sent exactly ONE request — the get that
// tried to resolve it.
func TestMailbox_UnknownTarget(t *testing.T) {
	f := newMailFake()
	_, errOut, code := runCmd(t, runMailbox, mailboxEnv(t, f), "mailbox", "rename", "NoSuchBox", "Other")
	if code != 3 || errOut != "error: no such mailbox: NoSuchBox\n" {
		t.Errorf("code=%d stderr=%q, want 3 and mailbox.ts:199's sentence", code, errOut)
	}
	if got := strings.Join(f.names(), ","); got != "Mailbox/get" {
		t.Errorf("calls = %s, want the resolve only", got)
	}
}

// ---- --dry-run / --if-state --------------------------------------------------

// Invariant 4: a dry run RESOLVES its target and writes nothing.
func TestMailbox_DryRun(t *testing.T) {
	f := newMailFake()
	out, errOut, code := runCmd(t, runMailbox, mailboxEnv(t, f), "mailbox", "rm", "Empty", "--dry-run")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if errOut != "dry run: would rm Empty (mb_empty); nothing was written\n" {
		t.Errorf("stderr = %q — the report names the RESOLVED target", errOut)
	}
	if out != "" {
		t.Errorf("the rehearsal is chrome, not a record: %q", out)
	}
	for _, c := range f.names() {
		if c == "Mailbox/set" {
			t.Fatal("invariant 4: a dry run must send NO Mailbox/set")
		}
	}
	if got := strings.Join(f.boxNames(), ","); !strings.Contains(got, "Empty") {
		t.Errorf("the folder must still exist; boxes = %s", got)
	}
	// --force changes what the rehearsal SAYS, because it changes what would
	// happen.
	f.reset()
	_, errOut, _ = runCmd(t, runMailbox, mailboxEnv(t, f), "mailbox", "rm", "Full", "--dry-run", "--force")
	if !strings.Contains(errOut, "would rm Full (mb_full) and its mail") {
		t.Errorf("stderr = %q", errOut)
	}
}

// A dry run that did not resolve would be evidence of nothing (mailbox.ts:117).
func TestMailbox_DryRunStillFailsOnUnknownTarget(t *testing.T) {
	f := newMailFake()
	_, _, code := runCmd(t, runMailbox, mailboxEnv(t, f), "mailbox", "rm", "NoSuchFolder", "--dry-run")
	if code != 3 {
		t.Errorf("code = %d, want 3", code)
	}
}

func TestMailbox_DryRunJSON(t *testing.T) {
	f := newMailFake()
	out, _, code := runCmd(t, runMailbox, mailboxEnv(t, f),
		"mailbox", "create", "Rehearsed", "--dry-run", "--json")
	want := `{"dryRun":true,"action":"create","target":"Rehearsed"}` + "\n"
	if code != 0 || out != want {
		t.Errorf("code=%d out=%q, want %q", code, out, want)
	}
}

// §1.7: a stale --if-state exits 5 and changes nothing.
func TestMailbox_StaleIfState(t *testing.T) {
	f := newMailFake()
	db := mailboxEnv(t, f)
	before := strings.Join(f.boxNames(), ",")
	out, errOut, code := runCmd(t, runMailbox, db,
		"mailbox", "create", "Unwanted", "--if-state", "mbstate-stale")
	if code != 5 {
		t.Errorf("code = %d, want 5 (conflict)", code)
	}
	if !strings.Contains(errOut, "stateMismatch") {
		t.Errorf("stderr should name stateMismatch: %q", errOut)
	}
	if out != "" {
		t.Errorf("stdout = %q", out)
	}
	if got := strings.Join(f.boxNames(), ","); got != before {
		t.Errorf("invariant 6: the refused write changed the fixture (%s → %s)", before, got)
	}
	if got, want := f.argsOf("Mailbox/set"),
		`{"accountId":"a_you","ifInState":"mbstate-stale","create":{"c1":{"name":"Unwanted"}}}`; got != want {
		t.Errorf("Mailbox/set args = %s\nwant %s", got, want)
	}
}

// A FRESH --if-state is accepted — the read-modify-write loop the clause exists
// for (contract.mjs:280).
func TestMailbox_FreshIfStateChains(t *testing.T) {
	f := newMailFake()
	db := mailboxEnv(t, f)
	out, _, code := runCmd(t, runMailbox, db, "mailbox", "create", "Chain", "--json")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	var first struct {
		State string `json:"state"`
	}
	if err := json.Unmarshal([]byte(out), &first); err != nil {
		t.Fatalf("--json is not one object: %v (%q)", err, out)
	}
	if first.State == "" {
		t.Fatal("a write must report the state it landed on")
	}
	out2, errOut, code := runCmd(t, runMailbox, db,
		"mailbox", "rename", "Chain", "Chained", "--if-state", first.State, "--json")
	if code != 0 {
		t.Fatalf("chaining on a fresh state failed: %d (%s)", code, errOut)
	}
	var second struct {
		State string `json:"state"`
	}
	_ = json.Unmarshal([]byte(out2), &second)
	if second.State == first.State {
		t.Errorf("the state must advance after a write (%s)", second.State)
	}
}

// ---- output shapes -----------------------------------------------------------

// --json is ONE object: action, id, name, state, then the SERVER's mailbox list
// with every key in the server's own order. This is the key-order assertion —
// the fixture's keys are deliberately not the CLI's struct order, and it carries
// a property (`totalEmails`) the CLI does not model at all.
func TestMailbox_JSONPreservesServerKeyOrder(t *testing.T) {
	f := newMailFake()
	out, _, code := runCmd(t, runMailbox, mailboxEnv(t, f), "mailbox", "rm", "Empty", "--json")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	want := `{"action":"destroyed","id":"mb_empty","name":"Empty","state":"mbstate-2","mailboxes":[` +
		`{"sortOrder":0,"name":"Inbox","role":"inbox","id":"mb_inbox","parentId":null,"totalEmails":3},` +
		`{"sortOrder":1,"name":"Full","role":null,"id":"mb_full","parentId":null,"totalEmails":3},` +
		`{"sortOrder":3,"name":"Quarantined","role":"junk","id":"mb_junk","parentId":null,"totalEmails":0}` +
		`]}` + "\n"
	if out != want {
		t.Errorf("--json =\n%s\nwant\n%s", out, want)
	}
	if strings.Count(out, "\n") != 1 {
		t.Errorf("§1.3: a show-shaped command emits exactly ONE line: %q", out)
	}
}

// --ids outranks --json and prints the bare id (§1.8).
func TestMailbox_IDsOutranksJSON(t *testing.T) {
	f := newMailFake()
	out, _, code := runCmd(t, runMailbox, mailboxEnv(t, f),
		"mailbox", "create", "Piped", "--ids", "--json")
	if out != "mb_new_1\n" || code != 0 {
		t.Errorf("--ids = %q (code %d), want a bare id", out, code)
	}
}

// The human report ends with the TREE — decoration on stderr, so a pipeline never
// sees it, and the hierarchy is the point of the unit.
func TestMailbox_HumanTree(t *testing.T) {
	f := newMailFake()
	_, errOut, code := runCmd(t, runMailbox, mailboxEnv(t, f),
		"mailbox", "create", "2026", "--parent", "Empty")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	want := "state mbstate-2  (pass to --if-state on the next write)\n" +
		"  Inbox  [inbox]\n" +
		"  Full\n" +
		"  Empty\n" +
		"    2026\n" +
		"  Quarantined  [junk]\n"
	if errOut != want {
		t.Errorf("stderr =\n%q\nwant\n%q", errOut, want)
	}
}

// Ties in sortOrder fall back to the NAME, and JavaScript's localeCompare is not
// a byte compare: "apple" sorts before "Banana" there and after it under Go's
// strings.Compare.
func TestMailbox_TreeTieBreakIsLocaleCompare(t *testing.T) {
	f := newMailFake()
	f.boxes = []string{
		`{"id":"mb_b","parentId":null,"name":"Banana","role":null,"sortOrder":0}`,
		`{"id":"mb_a","parentId":null,"name":"apple","role":null,"sortOrder":0}`,
	}
	f.start(t)
	db := seedMailMirror(t, f.base, "bm_tok", "")
	_, errOut, code := runCmd(t, runMailbox, db, "mailbox", "rename", "apple", "apple")
	if code != 0 {
		t.Fatalf("code = %d (%s)", code, errOut)
	}
	if !strings.HasSuffix(errOut, "  apple\n  Banana\n") {
		t.Errorf("stderr =\n%q\nwant apple before Banana (localeCompare, not byte order)", errOut)
	}
}

// cli/009 through `mailbox`: this is a single-account WRITE, so an ambiguous
// selector is refused with db.ts:225's sentence and exit 2, before any request.
func TestMailbox_AmbiguousAccountRefused(t *testing.T) {
	f := newMailFake()
	f.withMailboxTree()
	f.start(t)
	db := seedMailMirror(t, f.base, "bm_tok",
		`[{"accountId":"a_you","address":"you@stub.test"},{"accountId":"a_work","address":"work@stub.test"}]`)

	out, errOut, code := runCmd(t, runMailbox, db, "mailbox", "create", "X", "--account", "stub.test")
	if code != 2 {
		t.Errorf("code = %d, want 2 (usage)", code)
	}
	want := "error: usage: --account \"stub.test\" matches 2 accounts; name one of:\n" +
		"  you@stub.test\n  work@stub.test\n"
	if errOut != want {
		t.Errorf("stderr =\n%q\nwant\n%q", errOut, want)
	}
	if out != "" || len(f.calls) != 0 {
		t.Errorf("an unresolvable account costs ZERO requests; got %d and stdout %q", len(f.calls), out)
	}
}

// A rejected token is exit 4 on the WRITE path too (contract.mjs:251):
// io.ts:144's taxonomy makes a 401 auth rather than a generic failure.
func TestMailbox_RejectedToken(t *testing.T) {
	f := newMailFake()
	f.httpStatus = 401
	_, errOut, code := runCmd(t, runMailbox, mailboxEnv(t, f), "mailbox", "create", "X")
	if code != 4 {
		t.Errorf("code = %d, want 4 (auth)", code)
	}
	if !strings.Contains(errOut, "HTTP 401") {
		t.Errorf("stderr = %q, want the server's refusal", errOut)
	}
}
