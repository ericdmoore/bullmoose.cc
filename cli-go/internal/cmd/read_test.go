package cmd

// `read` is a PORTED command, so these tests are written against main.ts:959's
// behaviour rather than against the Go code: every expected string below is what
// the TypeScript prints for the same fixture.

import (
	"database/sql"
	"strings"
	"testing"
)

// oneEmail is the fixture most cases read. The key order is the server's, and
// --json must re-emit it unchanged; `<there>` and `&` are in the subject because
// JSON.stringify does NOT escape them and Go's encoder does by default.
const oneEmail = `{"id":"em_000","from":[{"name":"Sender Zero","email":"s0@stub.test"}],` +
	`"to":[{"name":null,"email":"you@stub.test"}],"cc":[{"name":"Carbon","email":"c@stub.test"}],` +
	`"subject":"hello <there> & co","receivedAt":"2026-01-01T12:00:00.000Z",` +
	`"bodyValues":{"t":{"value":"body zero"}},"textBody":[{"partId":"t","type":"text/plain"}]}`

func readEnv(t *testing.T, f *mailFake) string {
	t.Helper()
	f.start(t)
	return seedMailMirror(t, f.base, "bm_tok", "")
}

// The human shape, line for line — main.ts:1019-1027.
func TestRead_HumanShape(t *testing.T) {
	f := newMailFake()
	f.addEmail("em_000", oneEmail)
	out, errOut, code := runCmd(t, runRead, readEnv(t, f), "read", "em_000")

	want := "From:    Sender Zero <s0@stub.test>\n" +
		"To:      you@stub.test\n" +
		"Cc:      Carbon <c@stub.test>\n" +
		"Subject: hello <there> & co\n" +
		"Date:    2026-01-01T12:00:00.000Z\n" +
		"\n" +
		"body zero\n"
	if out != want {
		t.Errorf("stdout =\n%q\nwant\n%q", out, want)
	}
	if code != 0 || errOut != "" {
		t.Errorf("code=%d stderr=%q, want 0 and silence", code, errOut)
	}
}

// A nameless address prints bare, and a null cc prints NO Cc line at all
// (main.ts:1021 — the header is conditional, not empty).
func TestRead_NoCcLine(t *testing.T) {
	f := newMailFake()
	f.addEmail("em_001", `{"id":"em_001","from":[{"name":null,"email":"s@stub.test"}],`+
		`"to":[{"name":"","email":"you@stub.test"}],"cc":null,"subject":null,`+
		`"receivedAt":"2026-01-02T00:00:00.000Z","bodyValues":{},"textBody":[]}`)
	out, _, _ := runCmd(t, runRead, readEnv(t, f), "read", "em_001")

	if strings.Contains(out, "Cc:") {
		t.Errorf("a null cc must print no Cc line:\n%s", out)
	}
	if !strings.HasPrefix(out, "From:    s@stub.test\nTo:      you@stub.test\n") {
		t.Errorf("nameless addresses print bare:\n%q", out)
	}
	// `String(subject ?? "")` — a null subject is an EMPTY header, not "null".
	if !strings.Contains(out, "Subject: \n") {
		t.Errorf("a null subject prints as empty:\n%q", out)
	}
	// No bodyValues at all → the placeholder, not a blank body.
	if !strings.HasSuffix(out, "\n(no text body)\n") {
		t.Errorf("empty bodyValues should read `(no text body)`:\n%q", out)
	}
}

// --json is ONE object on ONE line: the server's keys in the server's order,
// bodyValues dropped, `body` appended (main.ts:1016).
func TestRead_JSONShape(t *testing.T) {
	f := newMailFake()
	f.addEmail("em_000", oneEmail)
	out, _, code := runCmd(t, runRead, readEnv(t, f), "read", "em_000", "--json")

	want := `{"id":"em_000","from":[{"name":"Sender Zero","email":"s0@stub.test"}],` +
		`"to":[{"name":null,"email":"you@stub.test"}],"cc":[{"name":"Carbon","email":"c@stub.test"}],` +
		`"subject":"hello <there> & co","receivedAt":"2026-01-01T12:00:00.000Z",` +
		`"textBody":[{"partId":"t","type":"text/plain"}],"body":"body zero"}` + "\n"
	if out != want {
		t.Errorf("--json =\n%s\nwant\n%s", out, want)
	}
	if code != 0 {
		t.Errorf("code = %d", code)
	}
	// The two failure modes a naive port has here, called out so a regression
	// names itself rather than showing up as a diff.
	if strings.Contains(out, "bodyValues") {
		t.Error("bodyValues must be dropped — `bodyValues: undefined` is omitted by JSON.stringify")
	}
	if strings.Contains(out, `\u003c`) || strings.Contains(out, `\u0026`) {
		t.Error("Go escapes < > & to \\uXXXX by default; JSON.stringify does not — SetEscapeHTML(false)")
	}
}

// --ids is the xargs shape and outranks --json (§1.8, main.ts:1013).
func TestRead_IDsOutranksJSON(t *testing.T) {
	f := newMailFake()
	f.addEmail("em_000", oneEmail)
	out, _, code := runCmd(t, runRead, readEnv(t, f), "read", "em_000", "--ids", "--json")
	if out != "em_000\n" || code != 0 {
		t.Errorf("--ids = %q (code %d), want a bare id", out, code)
	}
}

// An id the server does not have is NOT FOUND — exit 3, io.ts's EXIT table.
func TestRead_UnknownID(t *testing.T) {
	f := newMailFake()
	f.addEmail("em_000", oneEmail)
	out, errOut, code := runCmd(t, runRead, readEnv(t, f), "read", "em_nope")
	if code != 3 {
		t.Errorf("code = %d, want 3 (notFound)", code)
	}
	if errOut != "error: em_nope not found\n" {
		t.Errorf("stderr = %q", errOut)
	}
	if out != "" {
		t.Errorf("nothing belongs on stdout: %q", out)
	}
}

// No access: the server refuses the whole request at the transport level, and
// io.ts:144's taxonomy makes a 403 exit 4 — not a generic 1.
func TestRead_NoAccess(t *testing.T) {
	f := newMailFake()
	f.httpStatus = 403
	f.addEmail("em_000", oneEmail)
	out, errOut, code := runCmd(t, runRead, readEnv(t, f), "read", "em_000")
	if code != 4 {
		t.Errorf("code = %d, want 4 (auth)", code)
	}
	if !strings.HasPrefix(errOut, "error: JMAP request failed: HTTP 403") {
		t.Errorf("stderr = %q, want the server's refusal verbatim", errOut)
	}
	if out != "" {
		t.Errorf("nothing belongs on stdout: %q", out)
	}
}

// An empty mailbox is NOT FOUND with its own sentence — a `read` that printed
// nothing and exited 0 would be indistinguishable from a message with no body.
func TestRead_EmptyMailbox(t *testing.T) {
	f := newMailFake()
	f.emptyMailbox = true
	_, errOut, code := runCmd(t, runRead, readEnv(t, f), "read")
	if code != 3 || errOut != "error: mailbox is empty — nothing to read\n" {
		t.Errorf("empty mailbox: code=%d stderr=%q, want 3 and main.ts:984's sentence", code, errOut)
	}
}

// With no id, `read` asks the server for the newest message — Email/query with
// receivedAt DESC and limit 1, THEN Email/get. Queried live so it works on a
// mirror that has never synced (main.ts:978).
func TestRead_NewestWhenNoID(t *testing.T) {
	f := newMailFake()
	f.addEmail("em_000", oneEmail)
	out, _, code := runCmd(t, runRead, readEnv(t, f), "read")
	if code != 0 || !strings.Contains(out, "body zero") {
		t.Fatalf("code=%d out=%q", code, out)
	}
	if got, want := strings.Join(f.names(), ","), "Email/query,Email/get"; got != want {
		t.Errorf("call sequence = %s, want %s", got, want)
	}
	if got := f.argsOf("Email/query"); got !=
		`{"accountId":"a_you","sort":[{"property":"receivedAt","isAscending":false}],"limit":1}` {
		t.Errorf("Email/query args = %s", got)
	}
	if got := f.argsOf("Email/get"); got != `{"accountId":"a_you","ids":["em_000"],`+
		`"properties":["id","from","to","cc","subject","receivedAt","bodyValues","textBody"],`+
		`"fetchTextBodyValues":true}` {
		t.Errorf("Email/get args = %s", got)
	}
}

// A message WITH attachments. `read` does not request `attachments` and renders
// no attachment list — that is main.ts:1000's property set, and the human view
// has no such section. What must hold is that whatever the server DOES return
// survives into --json untouched, and that the human view is unchanged by it.
func TestRead_Attachments(t *testing.T) {
	f := newMailFake()
	f.addEmail("em_att", `{"id":"em_att","from":[{"name":null,"email":"s@stub.test"}],`+
		`"to":[],"cc":null,"subject":"invoice","receivedAt":"2026-03-03T00:00:00.000Z",`+
		`"hasAttachment":true,`+
		`"attachments":[{"partId":"2","blobId":"b_att","type":"application/pdf","name":"invoice.pdf","size":1024}],`+
		`"bodyValues":{"t":{"value":"see attached"}},"textBody":[{"partId":"t","type":"text/plain"}]}`)
	db := readEnv(t, f)

	out, _, code := runCmd(t, runRead, db, "read", "em_att", "--json")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(out, `"attachments":[{"partId":"2","blobId":"b_att","type":"application/pdf","name":"invoice.pdf","size":1024}]`) {
		t.Errorf("the attachment metadata must pass through verbatim:\n%s", out)
	}
	if !strings.HasSuffix(out, `"body":"see attached"}`+"\n") {
		t.Errorf("body still lands last:\n%s", out)
	}

	human, _, _ := runCmd(t, runRead, db, "read", "em_att")
	if strings.Contains(human, "invoice.pdf") {
		t.Errorf("main.ts:1019's human view lists no attachments; the port must not add one:\n%s", human)
	}
	if !strings.HasSuffix(human, "\nsee attached\n") {
		t.Errorf("human view = %q", human)
	}
}

// --raw fetches the blob through the SESSION's downloadUrl template and writes
// the bytes with no framing of its own (main.ts:986).
func TestRead_Raw(t *testing.T) {
	f := newMailFake()
	f.addEmail("em_000", `{"id":"em_000","blobId":"b_zero"}`)
	out, _, code := runCmd(t, runRead, readEnv(t, f), "read", "em_000", "--raw")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if out != "Subject: raw\r\n\r\nraw body\r\n" {
		t.Errorf("raw output = %q — no newline may be added", out)
	}
	if len(f.downloads) != 1 || f.downloads[0] != "/dl/a_you/b_zero/blob/application%2Foctet-stream" {
		t.Errorf("download path = %v; the template's four substitutions must match "+
			"encodeURIComponent, so the media type's slash is %%2F", f.downloads)
	}
	// It must NOT have fetched the body: --raw short-circuits above it.
	if got := f.argsOf("Email/get"); !strings.Contains(got, `"properties":["blobId"]`) {
		t.Errorf("--raw asks for blobId only, got %s", got)
	}
}

// An id that the MIRROR says belongs to another account is read from THAT
// account — but only when no --account was given (main.ts:969).
func TestRead_OwnerLookupFromMirror(t *testing.T) {
	f := newMailFake()
	f.addEmail("em_other", oneEmail)
	path := seedMailMirror(t, "", "bm_tok",
		`[{"accountId":"a_you","address":"you@stub.test"},{"accountId":"a_work","address":"work@stub.test"}]`)
	f.start(t)
	rewriteBase(t, path, f.base)
	insertMirrorRow(t, path, "a_work", "em_other")

	if _, _, code := runCmd(t, runRead, path, "read", "em_other"); code != 0 {
		t.Fatalf("code = %d", code)
	}
	if got := f.argsOf("Email/get"); !strings.Contains(got, `"accountId":"a_work"`) {
		t.Errorf("the mirror's owner must win over the default account: %s", got)
	}

	// With an explicit --account the selector wins, so the flag is not a
	// suggestion.
	f.reset()
	if _, _, code := runCmd(t, runRead, path, "read", "em_other", "--account", "you@stub.test"); code != 0 {
		t.Fatalf("code = %d", code)
	}
	if got := f.argsOf("Email/get"); !strings.Contains(got, `"accountId":"a_you"`) {
		t.Errorf("--account must win over the mirror lookup: %s", got)
	}
}

// cli/009 through `read`: an ambiguous selector is refused with db.ts:225's
// sentence and exit 2, never resolved to the first match.
func TestRead_AmbiguousAccountRefused(t *testing.T) {
	f := newMailFake()
	f.addEmail("em_000", oneEmail)
	f.start(t)
	path := seedMailMirror(t, f.base, "bm_tok",
		`[{"accountId":"a_you","address":"you@stub.test"},{"accountId":"a_work","address":"work@stub.test"}]`)

	out, errOut, code := runCmd(t, runRead, path, "read", "em_000", "--account", "stub.test")
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

// ---- helpers ---------------------------------------------------------------

func rewriteBase(t *testing.T, path, base string) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`UPDATE config SET value = ? WHERE key = 'base'`, base); err != nil {
		t.Fatal(err)
	}
}

func insertMirrorRow(t *testing.T, path, accountID, emailID string) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(
		`INSERT INTO emails (id, account_id, blob_id, thread_id, size, received_at)
		 VALUES (?, ?, 'b', 'th', 1, 0)`, emailID, accountID); err != nil {
		t.Fatal(err)
	}
}
