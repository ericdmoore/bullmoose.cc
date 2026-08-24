package cmd

// `send` is the irreversible one, so these tests are about what LEAVES the
// machine: the exact JMAP calls, in order, with the exact arguments — and, for
// every refusal, that NOTHING was sent.
//
// Every expected string is quoted from packages/cli/src/main.ts:568 cmdSend, not
// from the Go code, because the Go code is the thing under test.

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"io"
	"mime"
	"mime/multipart"
	"net/mail"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sendEnv(t *testing.T, f *mailFake) string {
	t.Helper()
	f.start(t)
	// A TTY-less, EMPTY stdin: readInput's implicit-stdin branch then behaves
	// the same in `go test` as it does under `sh -c` with no pipe.
	withStdin(t, "")
	return seedMailMirror(t, f.base, "bm_tok", "")
}

// THE choreography test. Four calls, in this order, with these arguments:
// Identity/get → Mailbox/get → Email/set (create the draft) → EmailSubmission/set
// (submit it, moving Drafts → Sent on success).
//
// The order is not a style choice: submitting before the draft exists gives the
// server nothing to relay, and moving the message to Sent BEFORE the relay
// accepts it would file a message that never left as sent.
func TestSend_JMAPCallSequence(t *testing.T) {
	f := newMailFake()
	out, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send",
		"--to", "a@b.com", "--subject", "hi", "--body", "line one")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}

	want := []string{"Identity/get", "Mailbox/get", "Email/set", "EmailSubmission/set", "Email/get"}
	if got := strings.Join(f.names(), ","); got != strings.Join(want, ",") {
		t.Fatalf("call sequence =\n  %s\nwant\n  %s\n(the trailing Email/get is the "+
			"best-effort mirror reconcile — main.ts:757's `sync`)", got, strings.Join(want, ","))
	}

	// The draft: the signature applied client-side, $draft + $seen set, and the
	// body carried in bodyValues for the server to build the MIME from.
	if got, want := f.argsOf("Email/set"), `{"accountId":"a_you","create":{"d":{`+
		`"mailboxIds":{"mb_drafts":true},"keywords":{"$draft":true,"$seen":true},`+
		`"from":[{"name":"You","email":"you@stub.test"}],"to":[{"email":"a@b.com"}],`+
		`"subject":"hi","bodyValues":{"t":{"value":"line one\n-- \nEric\nbullmoose\n"}},`+
		`"textBody":[{"partId":"t","type":"text/plain"}]}}}`; got != want {
		t.Errorf("Email/set args =\n%s\nwant\n%s", got, want)
	}

	// The submission: an EXPLICIT envelope (so bcc recipients, absent from the
	// MIME, still receive it) and the Drafts → Sent move conditional on success.
	if got, want := f.argsOf("EmailSubmission/set"), `{"accountId":"a_you","create":{"s":{`+
		`"emailId":"em_new_1","identityId":"id_1","envelope":{"mailFrom":{"email":"you@stub.test"},`+
		`"rcptTo":[{"email":"a@b.com"}]}}},"onSuccessUpdateEmail":{"#s":{`+
		`"mailboxIds/mb_drafts":null,"mailboxIds/mb_sent":true,"keywords/$draft":null}}}`; got != want {
		t.Errorf("EmailSubmission/set args =\n%s\nwant\n%s", got, want)
	}

	if out != "sent em_new_1 to a@b.com (submission es_2)\n" {
		t.Errorf("stdout = %q", out)
	}
}

// The gate. No destination → a usage error and, crucially, ZERO requests: the
// check sits above the first round trip (main.ts:589), so a mistyped invocation
// cannot leave a draft behind, let alone send.
func TestSend_NoRecipientSendsNothing(t *testing.T) {
	f := newMailFake()
	out, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send", "--subject", "hi", "--body", "x")

	if code != 2 {
		t.Errorf("code = %d, want 2 (usage)", code)
	}
	// The byte-identity pin retired with the Node burial (#317); the sentence
	// now names BOTH recipient sources (s40: frontmatter is one of them).
	if errOut != "error: usage: send requires --to (a flag, or a to: in the file's frontmatter)\n" {
		t.Errorf("stderr = %q, want the two-source sentence", errOut)
	}
	if out != "" {
		t.Errorf("nothing belongs on stdout: %q", out)
	}
	if n := len(f.names()); n != 0 {
		t.Fatalf("a send with no recipient made %d request(s): %v — it must cost ZERO, "+
			"or a refused invocation can still create a draft server-side", n, f.names())
	}
}

// An empty --to (`--to ""`, or a lone comma) is no recipient at all, not an
// empty-string recipient — splitAddresses drops the blanks (main.ts:767).
func TestSend_BlankRecipientIsNoRecipient(t *testing.T) {
	for _, arg := range []string{"", " ", ",", " , "} {
		f := newMailFake()
		_, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send",
			"--to", arg, "--subject", "hi", "--body", "x")
		if code != 2 || !strings.Contains(errOut, "send requires --to") {
			t.Errorf("--to %q: code=%d stderr=%q, want the usage refusal", arg, code, errOut)
		}
		if n := len(f.names()); n != 0 {
			t.Errorf("--to %q made %d request(s)", arg, n)
		}
	}
}

// A body with no source is refused BEFORE any request too — readBody runs above
// Identity/get (main.ts:596).
func TestSend_NoBodySendsNothing(t *testing.T) {
	f := newMailFake()
	_, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send", "--to", "a@b.com", "--subject", "hi")
	if code != 2 {
		t.Errorf("code = %d, want 2", code)
	}
	if errOut != "error: no body: pipe it on stdin, pass a path, or pass \"-\" for explicit stdin\n" {
		t.Errorf("stderr = %q, want io.ts:379's sentence", errOut)
	}
	if n := len(f.names()); n != 0 {
		t.Errorf("a bodyless send made %d request(s)", n)
	}
}

// --file is a body source; `--file -` is explicit stdin; an explicit --body beats
// both (main.ts:775 — "explicit flags beat implicit stdin").
func TestSend_BodySources(t *testing.T) {
	path := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(path, []byte("from a file"), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Run("--file reads the path", func(t *testing.T) {
		f := newMailFake()
		_, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send",
			"--to", "a@b.com", "--subject", "hi", "--file", path)
		if code != 0 {
			t.Fatalf("code=%d stderr=%s", code, errOut)
		}
		if !strings.Contains(f.argsOf("Email/set"), `"value":"from a file\n-- \nEric\nbullmoose\n"`) {
			t.Errorf("body did not come from --file: %s", f.argsOf("Email/set"))
		}
	})

	t.Run("--file - is explicit stdin", func(t *testing.T) {
		f := newMailFake()
		db := sendEnv(t, f)
		withStdin(t, "from stdin")
		if _, _, code := runCmd(t, runSend, db, "send",
			"--to", "a@b.com", "--subject", "hi", "--file", "-"); code != 0 {
			t.Fatalf("code = %d", code)
		}
		if !strings.Contains(f.argsOf("Email/set"), `"value":"from stdin\n-- \n`) {
			t.Errorf("`-` was not honoured: %s", f.argsOf("Email/set"))
		}
	})

	t.Run("--body beats piped stdin", func(t *testing.T) {
		f := newMailFake()
		db := sendEnv(t, f)
		withStdin(t, "piped")
		if _, _, code := runCmd(t, runSend, db, "send",
			"--to", "a@b.com", "--subject", "hi", "--body", "explicit"); code != 0 {
			t.Fatalf("code = %d", code)
		}
		args := f.argsOf("Email/set")
		if strings.Contains(args, "piped") || !strings.Contains(args, `"value":"explicit\n-- \n`) {
			t.Errorf("stdin overrode --body: %s", args)
		}
	})

	t.Run("an EMPTY --body is a body", func(t *testing.T) {
		// `opts.body !== undefined` tests presence, not truthiness (main.ts:778),
		// so `--body ""` must NOT fall through to stdin. The port does not add a
		// whitespace refusal the TypeScript does not have.
		f := newMailFake()
		db := sendEnv(t, f)
		withStdin(t, "piped")
		if _, _, code := runCmd(t, runSend, db, "send",
			"--to", "a@b.com", "--subject", "hi", "--body", ""); code != 0 {
			t.Fatalf("code = %d", code)
		}
		if got := f.argsOf("Email/set"); !strings.Contains(got, `"value":"\n-- \nEric\nbullmoose\n"`) {
			t.Errorf("an empty --body should send an empty body (plus the signature): %s", got)
		}
	})

	t.Run("a missing --file reads like Node's", func(t *testing.T) {
		f := newMailFake()
		_, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send",
			"--to", "a@b.com", "--subject", "hi", "--file", "/nonexistent/nope.txt")
		if code != 1 {
			t.Errorf("code = %d, want 1", code)
		}
		if errOut != "error: ENOENT: no such file or directory, open '/nonexistent/nope.txt'\n" {
			t.Errorf("stderr = %q, want readFileSync's sentence", errOut)
		}
		if n := len(f.names()); n != 0 {
			t.Errorf("an unreadable body made %d request(s)", n)
		}
	})
}

// Identity selection — main.ts:600. --identity matches an id OR an email; --from
// matches an email exactly; absent, the FIRST identity is used; and an explicit
// selector that matches nothing is an error, never a fallback.
func TestSend_IdentitySelection(t *testing.T) {
	cases := []struct {
		name     string
		flags    []string
		wantID   string
		wantFrom string
	}{
		{"default is the first identity", nil, "id_1", `"from":[{"name":"You","email":"you@stub.test"}]`},
		{"--identity by email", []string{"--identity", "alias@stub.test"}, "id_2", `"from":[{"email":"alias@stub.test"}]`},
		{"--identity by id", []string{"--identity", "id_2"}, "id_2", `"from":[{"email":"alias@stub.test"}]`},
		{"--from selects the identity", []string{"--from", "alias@stub.test"}, "id_2", `"from":[{"email":"alias@stub.test"}]`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newMailFake()
			argv := append([]string{"--to", "a@b.com", "--subject", "hi", "--body", "x"}, c.flags...)
			if _, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send", argv...); code != 0 {
				t.Fatalf("code=%d stderr=%s", code, errOut)
			}
			if got := f.argsOf("EmailSubmission/set"); !strings.Contains(got, `"identityId":"`+c.wantID+`"`) {
				t.Errorf("identityId: %s", got)
			}
			// A nameless identity must send NO `name` key at all (main.ts:706).
			if got := f.argsOf("Email/set"); !strings.Contains(got, c.wantFrom) {
				t.Errorf("from: %s, want %s", got, c.wantFrom)
			}
		})
	}

	t.Run("an unknown --identity is not found, and sends nothing", func(t *testing.T) {
		f := newMailFake()
		_, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send",
			"--to", "a@b.com", "--subject", "hi", "--body", "x", "--identity", "nope@x.test")
		if code != 3 {
			t.Errorf("code = %d, want 3 (notFound)", code)
		}
		if errOut != "error: identity nope@x.test not found; available: you@stub.test, alias@stub.test\n" {
			t.Errorf("stderr = %q", errOut)
		}
		if got := f.names(); len(got) != 1 || got[0] != "Identity/get" {
			t.Errorf("calls = %v — it must stop after the lookup that failed", got)
		}
	})
}

// --from selects the sending ACCOUNT as well as the identity, and an ambiguous
// one is refused rather than resolved by enumeration order (cli/009, main.ts:578).
func TestSend_AmbiguousFromRefused(t *testing.T) {
	f := newMailFake()
	f.start(t)
	path := seedMailMirror(t, f.base, "bm_tok",
		`[{"accountId":"a_you","address":"you@stub.test"},{"accountId":"a_work","address":"work@stub.test"}]`)
	withStdin(t, "")

	_, errOut, code := runCmd(t, runSend, path, "send",
		"--from", "stub.test", "--to", "a@b.com", "--subject", "hi", "--body", "x")
	if code != 2 {
		t.Errorf("code = %d, want 2 (usage)", code)
	}
	if errOut != "error: usage: --from \"stub.test\" matches 2 accounts; "+
		"name the sending account with --account\n" {
		t.Errorf("stderr = %q", errOut)
	}
	if n := len(f.names()); n != 0 {
		t.Errorf("an ambiguous sender made %d request(s) — nothing may be sent", n)
	}
}

// A --from that matches NO account is NOT an error at the account level: it may
// name an alias identity inside the default account (db.ts:181). The strict check
// is the identity lookup.
func TestSend_FromMayNameAnAliasIdentity(t *testing.T) {
	f := newMailFake()
	if _, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send",
		"--from", "alias@stub.test", "--to", "a@b.com", "--subject", "hi", "--body", "x"); code != 0 {
		t.Fatalf("code=%d stderr=%s — an alias --from must not be refused as an account", code, errOut)
	}
	if got := f.argsOf("EmailSubmission/set"); !strings.Contains(got, `"identityId":"id_2"`) {
		t.Errorf("the alias identity should have been selected: %s", got)
	}
}

// --json is one record, in main.ts:743's key order.
func TestSend_JSONShape(t *testing.T) {
	f := newMailFake()
	out, _, code := runCmd(t, runSend, sendEnv(t, f), "send",
		"--to", "a@b.com,c@d.com", "--cc", "e@f.com", "--bcc", "g@h.com",
		"--subject", "hi", "--body", "x", "--json")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	want := `{"emailId":"em_new_1","submissionId":"es_2","identity":"you@stub.test",` +
		`"to":["a@b.com","c@d.com","e@f.com","g@h.com"]}` + "\n"
	if out != want {
		t.Errorf("--json = %s want %s", out, want)
	}
	// cc/bcc ride on the DRAFT and on the envelope; bcc is what the explicit
	// envelope exists for.
	if got := f.argsOf("Email/set"); !strings.Contains(got, `"cc":[{"email":"e@f.com"}],"bcc":[{"email":"g@h.com"}]`) {
		t.Errorf("cc/bcc on the draft: %s", got)
	}
	if got := f.argsOf("EmailSubmission/set"); !strings.Contains(got,
		`"rcptTo":[{"email":"a@b.com"},{"email":"c@d.com"},{"email":"e@f.com"},{"email":"g@h.com"}]`) {
		t.Errorf("envelope rcptTo must carry every recipient incl. bcc: %s", got)
	}
}

// Without cc/bcc the keys are ABSENT, not empty arrays — `...(cc.length > 0 ?
// {cc} : {})` (main.ts:709).
func TestSend_NoCcMeansNoCcKey(t *testing.T) {
	f := newMailFake()
	runCmd(t, runSend, sendEnv(t, f), "send", "--to", "a@b.com", "--subject", "hi", "--body", "x")
	if got := f.argsOf("Email/set"); strings.Contains(got, `"cc"`) || strings.Contains(got, `"bcc"`) {
		t.Errorf("empty cc/bcc must not appear at all: %s", got)
	}
}

// ---- the governed-book / agent-principal refusal ---------------------------

// A METHOD-level refusal — the scope wall an agent-marked token hits
// (services/jmap/src/methods/common.ts:110). It must read as the server's own
// sentence with the exit code its TYPE maps to, not as a Go error dump.
func TestSend_MethodLevelRefusalIsLegible(t *testing.T) {
	f := newMailFake()
	f.refuseSubmission = "method"
	out, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send",
		"--to", "a@b.com", "--subject", "hi", "--body", "x")

	if code != 4 {
		t.Errorf("code = %d, want 4 (auth) — `forbidden` maps to 4, not a generic 1", code)
	}
	if errOut != "error: EmailSubmission/set → forbidden: token lacks the \"send\" scope\n" {
		t.Errorf("stderr = %q", errOut)
	}
	if out != "" {
		t.Errorf("a refused send must claim nothing on stdout: %q", out)
	}
	// The draft was created before the refusal, exactly as in TypeScript; what
	// matters is that NOTHING claims it was sent and the message stays in Drafts
	// (onSuccessUpdateEmail never fires).
	if !strings.Contains(strings.Join(f.names(), ","), "Email/set,EmailSubmission/set") {
		t.Errorf("calls = %v", f.names())
	}
}

// A PER-OBJECT refusal in notCreated — the shape submission.ts:150 turns every
// submitOne refusal into, and therefore the shape an outbound-bound (s10 T1)
// refusal takes if that gate ever moves into JMAP.
func TestSend_SetErrorRefusalIsLegible(t *testing.T) {
	f := newMailFake()
	f.refuseSubmission = "seterror"
	out, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send",
		"--to", "x@y.test", "--subject", "hi", "--body", "x")

	if code != 4 {
		t.Errorf("code = %d, want 4 — io.ts:429 failSetError maps the TYPE, per-object or not", code)
	}
	want := "error: submission failed: forbidden — recipient(s) not in the governing book: x@y.test\n"
	if errOut != want {
		t.Errorf("stderr = %q\nwant %q", errOut, want)
	}
	if out != "" {
		t.Errorf("a refused send must claim nothing on stdout: %q", out)
	}
}

// An account with no drafts/sent role cannot do the dance at all, and says so
// before creating anything (main.ts:632).
func TestSend_MissingRoleMailbox(t *testing.T) {
	f := newMailFake()
	f.mailboxes = `[{"id":"mb_inbox","name":"Inbox","role":"inbox"}]`
	_, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send",
		"--to", "a@b.com", "--subject", "hi", "--body", "x")
	if code != 3 {
		t.Errorf("code = %d, want 3", code)
	}
	if errOut != "error: account is missing a drafts/sent role mailbox\n" {
		t.Errorf("stderr = %q", errOut)
	}
	if got := strings.Join(f.names(), ","); got != "Identity/get,Mailbox/get" {
		t.Errorf("calls = %s — nothing may be created once the roles are missing", got)
	}
}

// The sent message lands in the local mirror without waiting for a sync, so
// `bullmoose log` shows it (main.ts:757's best-effort refresh, narrowed to the
// one confirmed id — see reconcileSent).
func TestSend_ReconcilesTheMirror(t *testing.T) {
	f := newMailFake()
	path := sendEnv(t, f)
	if _, errOut, code := runCmd(t, runSend, path, "send",
		"--to", "a@b.com", "--subject", "hi", "--body", "x"); code != 0 {
		t.Fatalf("code=%d stderr=%s", code, errOut)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var subject, mailbox string
	if err := db.QueryRow(`SELECT subject FROM emails WHERE id = 'em_new_1'`).Scan(&subject); err != nil {
		t.Fatalf("the sent message is not in the mirror: %v", err)
	}
	if subject != "hi" {
		t.Errorf("subject = %q", subject)
	}
	if err := db.QueryRow(
		`SELECT mailbox_id FROM email_mailboxes WHERE email_id = 'em_new_1'`).Scan(&mailbox); err != nil {
		t.Fatalf("mailbox membership not mirrored: %v", err)
	}
	if mailbox != "mb_sent" {
		t.Errorf("mailbox = %q, want mb_sent", mailbox)
	}
	// The FTS row is what `bullmoose search` reads; a mirror row without it
	// would be invisible to search but visible to log.
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM cli_fts WHERE email_id = 'em_new_1'`).Scan(&n); err != nil || n != 1 {
		t.Errorf("cli_fts rows = %d (err %v), want 1", n, err)
	}
}

// A reconcile failure is SILENT: the message really was sent, and failing the
// command afterwards would tell the user the opposite of the truth
// (main.ts:757's try/catch).
func TestSend_ReconcileFailureIsSilent(t *testing.T) {
	f := newMailFake()
	f.start(t)
	// A mirror with config but NO emails table: the reconcile cannot write.
	path := filepath.Join(t.TempDir(), "bare.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	for k, v := range map[string]string{"base": f.base, "token": "bm_tok", "accountId": "a_you"} {
		if _, err := db.Exec(`INSERT INTO config(key,value) VALUES(?,?)`, k, v); err != nil {
			t.Fatal(err)
		}
	}
	_ = db.Close()
	withStdin(t, "")

	out, errOut, code := runCmd(t, runSend, path, "send",
		"--to", "a@b.com", "--subject", "hi", "--body", "x")
	if code != 0 {
		t.Errorf("code = %d — the send succeeded; a mirror write failure must not fail it", code)
	}
	if errOut != "" {
		t.Errorf("stderr = %q, want silence", errOut)
	}
	if !strings.HasPrefix(out, "sent em_new_1 ") {
		t.Errorf("stdout = %q", out)
	}
}

// ---- the Markdown pipeline (send --expandMD html, s08 T6) -----------------

// The MD choreography: render → assets → BuildMime → upload → Email/import →
// EmailSubmission/set. Byte-identity with Node is deliberately not asserted
// for the rendered HTML (marked→goldmark, internal/markdown); what IS held
// exact is the protocol around it — the call order, the import shape, and the
// submission being identical to the plain path's.
func TestSend_ExpandMD_Choreography(t *testing.T) {
	f := newMailFake()
	dir := t.TempDir()
	img := filepath.Join(dir, "cat.png")
	if err := os.WriteFile(img, []byte{0x89, 'P', 'N', 'G'}, 0o644); err != nil {
		t.Fatal(err)
	}
	md := filepath.Join(dir, "note.md")
	if err := os.WriteFile(md, []byte("# Hi\n\n![c](./cat.png)\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	out, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send",
		"--to", "a@b.com", "--subject", "hi", "--file", md, "--expandMD", "html")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}

	// Email/set is ABSENT: the MD path imports a complete message instead.
	want := []string{"Identity/get", "Mailbox/get", "Email/import", "EmailSubmission/set", "Email/get"}
	if got := strings.Join(f.names(), ","); got != strings.Join(want, ",") {
		t.Fatalf("call sequence = %s, want %s", got, strings.Join(want, ","))
	}

	// Exactly ONE upload — the assembled message. The image is inline (small),
	// so it rides INSIDE the MIME, not as its own blob.
	if len(f.uploads) != 1 {
		t.Fatalf("uploads = %d, want 1 (the rfc822 blob; the inline image travels in it)", len(f.uploads))
	}
	up := f.uploads[0]
	if up.Type != "message/rfc822" {
		t.Errorf("upload content-type = %q", up.Type)
	}

	// The imported bytes PARSE BACK as the tree the pipeline promises:
	// related > alternative(text, html) > image/png with the cid.
	msg, err := mail.ReadMessage(bytes.NewReader(up.Body))
	if err != nil {
		t.Fatalf("the uploaded message does not parse: %v", err)
	}
	mt, params, err := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	if err != nil || mt != "multipart/related" {
		t.Fatalf("top-level type = %q (%v), want multipart/related", mt, err)
	}
	var kinds []string
	mr := multipart.NewReader(msg.Body, params["boundary"])
	for {
		p, err := mr.NextPart()
		if err != nil {
			break
		}
		k, _, _ := mime.ParseMediaType(p.Header.Get("Content-Type"))
		kinds = append(kinds, k)
	}
	if strings.Join(kinds, ",") != "multipart/alternative,image/png" {
		t.Errorf("related children = %v", kinds)
	}

	// The submission is the SAME shape as the plain path — emailId from the
	// import, explicit envelope, Drafts→Sent on success. That non-fork is the
	// point of returning only an id from createMarkdownDraft.
	if got := f.argsOf("EmailSubmission/set"); !strings.Contains(got, `"emailId":"em_new_1"`) ||
		!strings.Contains(got, `"mailboxIds/mb_drafts":null`) {
		t.Errorf("submission diverged from the plain path: %s", got)
	}

	// The chrome names the pipeline, exactly as main.ts:748 does.
	if !strings.Contains(out, "markdown→html, 1 inlined") {
		t.Errorf("stdout = %q", out)
	}
}

// Over --linkMax, the image is NOT carried: it is uploaded, shared, and the
// message references the expiring URL in BOTH bodies.
func TestSend_ExpandMD_LargeFileBecomesALink(t *testing.T) {
	f := newMailFake()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "big.png"), make([]byte, 300_000), 0o644); err != nil {
		t.Fatal(err)
	}
	md := filepath.Join(dir, "note.md")
	if err := os.WriteFile(md, []byte("![b](./big.png)\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 0.2 MiB cap puts the 300 KB image over the line.
	out, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send",
		"--to", "a@b.com", "--subject", "hi", "--file", md,
		"--expandMD", "html", "--linkMax", "0.2", "--linkTTL", "7")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}

	// TWO uploads — the shared image, then the message — and one share mint.
	if len(f.uploads) != 2 || len(f.shares) != 1 {
		t.Fatalf("uploads = %d, shares = %d; want 2 and 1", len(f.uploads), len(f.shares))
	}
	if f.uploads[0].Type != "image/png" || f.uploads[1].Type != "message/rfc822" {
		t.Errorf("upload order/types = %q, %q", f.uploads[0].Type, f.uploads[1].Type)
	}
	// The message carries the LINK, not the image. Both halves are asserted
	// on DECODED parts, because the bodies are base64 — a raw-bytes substring
	// check can never see the URL, and the first version of this assertion
	// did exactly that. (Fifth substring-for-structure mistake this session;
	// the tell never changes.)
	msg, err := mail.ReadMessage(bytes.NewReader(f.uploads[1].Body))
	if err != nil {
		t.Fatalf("uploaded message does not parse: %v", err)
	}
	mt, params, _ := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	if mt != "multipart/alternative" {
		t.Fatalf("top-level = %q, want multipart/alternative (no image part at all)", mt)
	}
	sawURL := false
	mr := multipart.NewReader(msg.Body, params["boundary"])
	for {
		part, err := mr.NextPart()
		if err != nil {
			break
		}
		enc, _ := io.ReadAll(part)
		dec, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(string(enc), "\r\n", ""))
		if err != nil {
			t.Fatalf("part is not decodable base64: %v", err)
		}
		if bytes.Contains(dec, []byte("https://links.stub.test/s/1")) {
			sawURL = true
		}
	}
	if !sawURL {
		t.Error("the share URL is in neither body")
	}
	if !strings.Contains(out, "1 linked (expires in 7d)") {
		t.Errorf("stdout = %q", out)
	}
}

// --expandMD with any value but html is refused before ANY request.
func TestSend_ExpandMD_UnknownModeRefused(t *testing.T) {
	f := newMailFake()
	_, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send",
		"--to", "a@b.com", "--subject", "hi", "--body", "x", "--expandMD", "pdf")
	if code == 0 {
		t.Fatal("an unknown mode must be refused")
	}
	if len(f.names()) != 0 {
		t.Fatalf("refusal must cost zero requests, got %v", f.names())
	}
	if !strings.Contains(errOut, "html") {
		t.Errorf("the error should name the accepted value: %q", errOut)
	}
}

// ── s40: frontmatter becomes the envelope ───────────────────────────────────

func sendMD(t *testing.T, content string) string {
	t.Helper()
	p := t.TempDir() + "/msg.md"
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSend_FrontmatterEnvelope_DryRun(t *testing.T) {
	// --dry-run shows the RESOLVED envelope and sends NOTHING — zero round
	// trips, which is why it can protect the invocation nobody double-checked.
	f := newMailFake()
	file := sendMD(t, "---\nto: grace@example.test\ncc: ops@example.test\nsubject: Project Elk kickoff\n---\n\nMonday works.\n")
	out, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send", "--file", file, "--dry-run")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %q", code, errOut)
	}
	for _, want := range []string{"dry run — nothing sent", "to:      grace@example.test", "cc:      ops@example.test", "subject: Project Elk kickoff"} {
		if !strings.Contains(out, want) {
			t.Errorf("dry-run missing %q in %q", want, out)
		}
	}
	if len(f.calls) != 0 {
		t.Errorf("dry run made %d call(s)", len(f.calls))
	}
}

func TestSend_FlagBeatsFile_SaidOutLoud(t *testing.T) {
	// Silent override sends the wrong subject; silent merge sends an
	// unnoticed bcc. The flag wins and the conflict is NAMED on stderr.
	f := newMailFake()
	file := sendMD(t, "---\nto: wrong@example.test\nsubject: Old subject\n---\nbody\n")
	out, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send",
		"--file", file, "--to", "right@example.test", "--subject", "New subject", "--dry-run")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %q", code, errOut)
	}
	if !strings.Contains(out, "to:      right@example.test") || strings.Contains(out, "wrong@example.test") {
		t.Errorf("flag did not beat file: %q", out)
	}
	if !strings.Contains(errOut, "note: --to beats the file's to: wrong@example.test") ||
		!strings.Contains(errOut, "note: --subject beats the file's subject: Old subject") {
		t.Errorf("conflicts not named: %q", errOut)
	}
}

func TestSend_FileRecipients_RefuseWithoutConsent(t *testing.T) {
	// The build-time decision, made: recipients that came from the FILE
	// confirm before sending. Non-interactive stdin answers no — a .md that
	// ARRIVED BY MAIL and got piped cannot address itself anywhere.
	f := newMailFake()
	file := sendMD(t, "---\nto: attacker@evil.example\nsubject: hi\n---\nbody\n")
	_, errOut, code := runCmd(t, runSend, sendEnv(t, f), "send", "--file", file)
	if code != 1 {
		t.Fatalf("code = %d, want 1 (refused), stderr = %q", code, errOut)
	}
	if !strings.Contains(errOut, "recipients came from the FILE") || !strings.Contains(errOut, "not sent") {
		t.Errorf("refusal not explained: %q", errOut)
	}
	if len(f.calls) != 0 {
		t.Errorf("refused send made %d call(s)", len(f.calls))
	}
}

func TestSend_UnknownKeyNamed(t *testing.T) {
	f := newMailFake()
	file := sendMD(t, "---\nsubjcet: oops\nto: a@b.test\nsubject: real\n---\nbody\n")
	_, errOut, _ := runCmd(t, runSend, sendEnv(t, f), "send", "--file", file, "--dry-run")
	if !strings.Contains(errOut, "note: frontmatter key ignored: subjcet") {
		t.Errorf("typo not named: %q", errOut)
	}
}

func TestSend_FromKeyGetsItsOwnSentence(t *testing.T) {
	// Eric, reviewing #345: "I thought FROM would be implied from the
	// principal actor logged into the CLI?" It is — and a file that tries to
	// say otherwise deserves a sentence about identity, not a typo warning.
	f := newMailFake()
	file := sendMD(t, "---\nfrom: attacker@evil.example\nto: a@b.test\nsubject: hi\n---\nbody\n")
	_, errOut, _ := runCmd(t, runSend, sendEnv(t, f), "send", "--file", file, "--dry-run")
	if !strings.Contains(errOut, "from: comes from your CLI identity, never from the file") {
		t.Errorf("identity sentence missing: %q", errOut)
	}
	if strings.Contains(errOut, "ignored: from") {
		t.Errorf("from lumped with typos: %q", errOut)
	}
}
