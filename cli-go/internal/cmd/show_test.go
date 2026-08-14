package cmd

// `show` is a PORTED command (main.ts:1106), so every expectation below is what
// the TypeScript prints for the same fixture — including the --json object, which
// is the MIRROR ROW and not the server's Email.

import (
	"database/sql"
	"strings"
	"testing"
)

// showBody is what the server answers `show`'s Email/get with: the body only,
// because the metadata comes from the mirror.
const showBody = `{"bodyValues":{"t":{"value":"body of message 0"}},` +
	`"textBody":[{"partId":"t","type":"text/plain"}]}`

// seedShowRow writes one full mirror row — every column db.ts's schema declares,
// which is exactly what `SELECT *` emits under --json.
func seedShowRow(t *testing.T, path, accountID, id string) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(
		`INSERT INTO emails (id, account_id, blob_id, thread_id, message_id, in_reply_to,
		   subject, from_json, to_json, cc_json, bcc_json, preview, size, received_at,
		   has_attachment, attachments_json)
		 VALUES (?, ?, 'b_0', 'th_0', '<0@stub.test>', NULL,
		   'message number 0',
		   '[{"name":"Sender Zero","email":"s0@stub.test"}]',
		   '[{"name":null,"email":"you@stub.test"}]', '[]', '[]',
		   'preview of message 0', 1024, 1767268800000, 0, '[]')`, id, accountID); err != nil {
		t.Fatal(err)
	}
}

func showEnv(t *testing.T, f *mailFake) string {
	t.Helper()
	f.start(t)
	path := seedMailMirror(t, f.base, "bm_tok", "")
	seedShowRow(t, path, "a_you", "em_000")
	return path
}

// The human shape — From/Subject/Date and the body, and NO To/Cc lines: `show` is
// not `read`, and main.ts:1164 prints three headers.
func TestShow_HumanShape(t *testing.T) {
	f := newMailFake()
	f.addEmail("em_000", showBody)
	out, errOut, code := runCmd(t, runShow, showEnv(t, f), "show", "em_000")
	want := "From:    Sender Zero <s0@stub.test>\n" +
		"Subject: message number 0\n" +
		"Date:    2026-01-01T12:00:00.000Z\n" +
		"\n" +
		"body of message 0\n"
	if out != want {
		t.Errorf("stdout =\n%q\nwant\n%q", out, want)
	}
	if code != 0 || errOut != "" {
		t.Errorf("code=%d stderr=%q, want 0 and silence", code, errOut)
	}
	if strings.Contains(out, "To:") || strings.Contains(out, "Cc:") {
		t.Error("main.ts:1164 prints From/Subject/Date only — the port must not add headers")
	}
}

// The request `show` sends: the BODY properties only (main.ts:1146), against the
// account the MIRROR says owns the id.
func TestShow_RequestShape(t *testing.T) {
	f := newMailFake()
	f.addEmail("em_000", showBody)
	if _, _, code := runCmd(t, runShow, showEnv(t, f), "show", "em_000"); code != 0 {
		t.Fatalf("code = %d", code)
	}
	if got, want := strings.Join(f.names(), ","), "Email/get"; got != want {
		t.Errorf("calls = %s, want %s — the metadata comes from the mirror", got, want)
	}
	if got, want := f.argsOf("Email/get"),
		`{"accountId":"a_you","ids":["em_000"],"properties":["bodyValues","textBody"],`+
			`"fetchTextBodyValues":true}`; got != want {
		t.Errorf("Email/get args = %s\nwant %s", got, want)
	}
}

// --json is `{...row, body}`: EVERY mirror column, in COLUMN order, with `body`
// appended. This is the key-order assertion — a map[string]any would sort these
// alphabetically and put account_id first.
func TestShow_JSONIsTheRowInColumnOrder(t *testing.T) {
	f := newMailFake()
	f.addEmail("em_000", showBody)
	out, _, code := runCmd(t, runShow, showEnv(t, f), "show", "em_000", "--json")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	want := `{"id":"em_000","account_id":"a_you","blob_id":"b_0","thread_id":"th_0",` +
		`"message_id":"<0@stub.test>","in_reply_to":null,"subject":"message number 0",` +
		`"from_json":"[{\"name\":\"Sender Zero\",\"email\":\"s0@stub.test\"}]",` +
		`"to_json":"[{\"name\":null,\"email\":\"you@stub.test\"}]","cc_json":"[]","bcc_json":"[]",` +
		`"preview":"preview of message 0","size":1024,"received_at":1767268800000,` +
		`"has_attachment":0,"attachments_json":"[]","last_writer_principal":null,` +
		`"last_writer_binding":null,"last_writer_invocation":null,"body":"body of message 0"}` + "\n"
	if out != want {
		t.Errorf("--json =\n%s\nwant\n%s", out, want)
	}
	if strings.Count(out, "\n") != 1 {
		t.Errorf("§1.3: exactly ONE object on ONE line, got %q", out)
	}
}

// The mirror's JSON columns are TEXT, so they re-emit as strings — node:sqlite
// hands JavaScript a string and `{...row}` never parses it. A port that helpfully
// decoded from_json would emit a different object.
func TestShow_JSONColumnsStayStrings(t *testing.T) {
	f := newMailFake()
	f.addEmail("em_000", showBody)
	out, _, _ := runCmd(t, runShow, showEnv(t, f), "show", "em_000", "--json")
	if !strings.Contains(out, `"from_json":"[{`) {
		t.Errorf("from_json must stay a STRING column:\n%s", out)
	}
}

// --ids outranks --json and prints the id it was asked for (§1.8).
func TestShow_IDsOutranksJSON(t *testing.T) {
	f := newMailFake()
	f.addEmail("em_000", showBody)
	out, _, code := runCmd(t, runShow, showEnv(t, f), "show", "em_000", "--ids", "--json")
	if out != "em_000\n" || code != 0 {
		t.Errorf("--ids = %q (code %d)", out, code)
	}
}

// No id is a USAGE error (exit 2) at ZERO requests — the check sits above the
// account resolution and the client (main.ts:1108).
func TestShow_MissingIDCostsNothing(t *testing.T) {
	f := newMailFake()
	out, errOut, code := runCmd(t, runShow, showEnv(t, f), "show")
	if code != 2 {
		t.Errorf("code = %d, want 2", code)
	}
	if errOut != "error: usage: bullmoose show <emailId> [--json]\n" {
		t.Errorf("stderr = %q", errOut)
	}
	if out != "" || len(f.calls) != 0 {
		t.Errorf("a missing argument costs ZERO requests; got %d and stdout %q", len(f.calls), out)
	}
}

// An id the mirror does not hold is NOT FOUND, and it never reaches the server:
// `show` reads the mirror, so the refusal is local and costs nothing.
func TestShow_UnknownIDCostsNothing(t *testing.T) {
	f := newMailFake()
	_, errOut, code := runCmd(t, runShow, showEnv(t, f), "show", "em_nope")
	if code != 3 {
		t.Errorf("code = %d, want 3 (notFound)", code)
	}
	if errOut != "error: em_nope not in local db (run: bullmoose sync)\n" {
		t.Errorf("stderr = %q", errOut)
	}
	if len(f.calls) != 0 {
		t.Errorf("a mirror miss costs ZERO requests; got %d", len(f.calls))
	}
}

// cli/009 §A: an id that exists in ANOTHER account gets its own sentence, because
// "not in local db (run: bullmoose sync)" would simply be false — the fix that
// made `show` resolve the way `log` fans out.
func TestShow_IDInAnotherAccount(t *testing.T) {
	f := newMailFake()
	f.start(t)
	path := seedMailMirror(t, f.base, "bm_tok",
		`[{"accountId":"a_you","address":"you@stub.test"},{"accountId":"a_work","address":"work@stub.test"}]`)
	seedShowRow(t, path, "a_work", "em_work")

	_, errOut, code := runCmd(t, runShow, path, "show", "em_work", "--account", "you@stub.test")
	if code != 3 {
		t.Errorf("code = %d, want 3", code)
	}
	want := "error: em_work belongs to work@stub.test, which --account \"you@stub.test\" did not select\n"
	if errOut != want {
		t.Errorf("stderr = %q\nwant %q", errOut, want)
	}
	if len(f.calls) != 0 {
		t.Errorf("the refusal is local; got %d request(s)", len(f.calls))
	}
}

// Without a selector `show` spans EVERY account (selectAccounts, not pickAccount),
// so an id from a non-default account reads back — and binds to ITS account.
func TestShow_FansOutAcrossAccounts(t *testing.T) {
	f := newMailFake()
	f.addEmail("em_work", showBody)
	f.start(t)
	path := seedMailMirror(t, f.base, "bm_tok",
		`[{"accountId":"a_you","address":"you@stub.test"},{"accountId":"a_work","address":"work@stub.test"}]`)
	seedShowRow(t, path, "a_work", "em_work")

	out, errOut, code := runCmd(t, runShow, path, "show", "em_work")
	if code != 0 {
		t.Fatalf("code = %d (%s)", code, errOut)
	}
	if !strings.Contains(out, "body of message 0") {
		t.Errorf("stdout = %q", out)
	}
	if got := f.argsOf("Email/get"); !strings.Contains(got, `"accountId":"a_work"`) {
		t.Errorf("the body must be fetched from the OWNING account: %s", got)
	}
}

// A selector that matches nothing is NOT FOUND with db.ts:174's sentence — and,
// unlike the single-account commands, an AMBIGUOUS one is fine here: `show` fans
// out, so several accounts is a set rather than a refusal.
func TestShow_AccountSelector(t *testing.T) {
	f := newMailFake()
	f.addEmail("em_000", showBody)
	f.start(t)
	path := seedMailMirror(t, f.base, "bm_tok",
		`[{"accountId":"a_you","address":"you@stub.test"},{"accountId":"a_work","address":"work@stub.test"}]`)
	seedShowRow(t, path, "a_you", "em_000")

	_, errOut, code := runCmd(t, runShow, path, "show", "em_000", "--account", "nope")
	if code != 3 {
		t.Errorf("no match → code %d, want 3", code)
	}
	if errOut != "error: no account matches \"nope\"; have: you@stub.test, work@stub.test\n" {
		t.Errorf("stderr = %q", errOut)
	}

	if _, errOut, code := runCmd(t, runShow, path, "show", "em_000", "--account", "stub.test"); code != 0 {
		t.Errorf("an ambiguous selector is a SET for a fan-out command: code %d (%s)", code, errOut)
	}
}

// The mirror knows the message, the server no longer serves it: main.ts:1149
// reads `list[0]` optionally, so the headers still print with the placeholder
// body rather than a refusal.
func TestShow_BodyMissingFromServer(t *testing.T) {
	f := newMailFake() // no addEmail: Email/get answers an empty list
	out, _, code := runCmd(t, runShow, showEnv(t, f), "show", "em_000")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if !strings.HasSuffix(out, "\n(no text body)\n") {
		t.Errorf("stdout = %q, want the placeholder body", out)
	}
}

// A server refusal is rendered legibly with the §1.5 code — 403 → exit 4.
func TestShow_ServerRefusal(t *testing.T) {
	f := newMailFake()
	f.httpStatus = 403
	out, errOut, code := runCmd(t, runShow, showEnv(t, f), "show", "em_000")
	if code != 4 {
		t.Errorf("code = %d, want 4 (auth)", code)
	}
	if !strings.HasPrefix(errOut, "error: JMAP request failed: HTTP 403") {
		t.Errorf("stderr = %q", errOut)
	}
	if out != "" {
		t.Errorf("nothing belongs on stdout: %q", out)
	}
}
