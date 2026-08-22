package cmd

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// identity — s42: choreography exact, refusals free, the signature-source
// rule intact (--text/--html name FILES, a bare invocation reads a pipe).

func TestIdentity_ListRenders(t *testing.T) {
	f := newMailFake()
	out, _, code := runCmd(t, runIdentity, sendEnv(t, f), "identity")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if got := strings.Join(f.names(), ","); got != "Identity/get" {
		t.Fatalf("calls = %s", got)
	}
	// The fixture's id_1 has a name and a text signature; the marks column
	// says so. id_2 is bare.
	if !strings.Contains(out, "id_1\tYou <you@stub.test>\t") || !strings.Contains(out, "sig") {
		t.Errorf("stdout = %q", out)
	}
	if !strings.Contains(out, "id_2\talias@stub.test") {
		t.Errorf("stdout = %q", out)
	}
}

func TestIdentity_ShowResolvesByEmailCaseInsensitively(t *testing.T) {
	f := newMailFake()
	out, _, code := runCmd(t, runIdentity, sendEnv(t, f), "identity", "show", "ALIAS@stub.test")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(out, "id_2") {
		t.Errorf("stdout = %q", out)
	}
}

func TestIdentity_SignatureFromExplicitFile(t *testing.T) {
	f := newMailFake()
	dir := t.TempDir()
	sig := dir + "/sig.txt"
	if err := writeFile(sig, "Eric\nbullmoose\n"); err != nil {
		t.Fatal(err)
	}
	_, _, code := runCmd(t, runIdentity, sendEnv(t, f), "identity", "signature", "id_1", "--text", sig)
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	args := f.argsOf("Identity/set")
	if !strings.Contains(args, `"textSignature":"Eric\nbullmoose\n"`) {
		t.Errorf("set args = %s", args)
	}
}

func TestIdentity_ClearWinsAndClearsBoth(t *testing.T) {
	// Clearing only one signature leaves a multipart/alternative send signing
	// half of itself — the rule the TypeScript encoded and this keeps.
	f := newMailFake()
	_, _, code := runCmd(t, runIdentity, sendEnv(t, f), "identity", "signature", "id_1", "--clear")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	args := f.argsOf("Identity/set")
	if !strings.Contains(args, `"textSignature":""`) || !strings.Contains(args, `"htmlSignature":""`) {
		t.Errorf("clear must empty BOTH: %s", args)
	}
}

func TestIdentity_AddCreates(t *testing.T) {
	f := newMailFake()
	out, _, code := runCmd(t, runIdentity, sendEnv(t, f), "identity", "add", "new@stub.test",
		"--name", "New", "--reply-to", "replies@stub.test")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	args := f.argsOf("Identity/set")
	for _, want := range []string{`"email":"new@stub.test"`, `"name":"New"`, `"replyTo":[{"email":"replies@stub.test"}]`} {
		if !strings.Contains(args, want) {
			t.Errorf("create args %s missing %s", args, want)
		}
	}
	if !strings.Contains(out, "added new@stub.test") {
		t.Errorf("stdout = %q", out)
	}
}

func TestIdentity_RefusalsCostZeroRequests(t *testing.T) {
	for _, extra := range [][]string{
		{"destroy"},   // unknown subcommand
		{"show"},      // missing arg
		{"signature"}, // missing arg
		{"add"},       // missing arg
		{"rm"},        // missing arg
	} {
		f := newMailFake()
		_, _, code := runCmd(t, runIdentity, sendEnv(t, f), "identity", extra...)
		if code != 2 {
			t.Errorf("%v: code = %d, want 2", extra, code)
		}
		if len(f.names()) != 0 {
			t.Errorf("%v: refusal must cost zero requests, got %v", extra, f.names())
		}
	}
}

func TestIdentity_RmDryRunDestroysNothing(t *testing.T) {
	f := newMailFake()
	_, errOut, code := runCmd(t, runIdentity, sendEnv(t, f), "identity", "rm", "id_2", "--dry-run")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if got := strings.Join(f.names(), ","); got != "Identity/get" {
		t.Fatalf("dry-run must only read, got %s", got)
	}
	if !strings.Contains(errOut, "would remove alias@stub.test") {
		t.Errorf("stderr = %q", errOut)
	}
}

func writeFile(path, content string) error {
	return os.WriteFile(path, []byte(content), 0o644)
}

func TestIdentity_JSONAndIDsModes(t *testing.T) {
	f := newMailFake()
	// list --ids
	out, _, code := runCmd(t, runIdentity, sendEnv(t, f), "identity", "list", "--ids")
	if code != 0 || out != "id_1\nid_2\n" {
		t.Errorf("ids: code=%d out=%q", code, out)
	}
	// list --json re-emits the server objects verbatim, one per line
	f2 := newMailFake()
	out, _, _ = runCmd(t, runIdentity, sendEnv(t, f2), "identity", "list", "--json")
	if !strings.Contains(out, `"id":"id_1"`) || !strings.Contains(out, "\n") {
		t.Errorf("json: %q", out)
	}
	// rm --json reports id+email+state
	f3 := newMailFake()
	out, _, code = runCmd(t, runIdentity, sendEnv(t, f3), "identity", "rm", "id_2", "--json")
	if code != 0 || !strings.Contains(out, `"email":"alias@stub.test"`) || !strings.Contains(out, `"state":"idstate-2"`) {
		t.Errorf("rm json: code=%d out=%q", code, out)
	}
	// signature --ids
	f4 := newMailFake()
	out, _, code = runCmd(t, runIdentity, sendEnv(t, f4), "identity", "signature", "id_1", "--clear", "--ids")
	if code != 0 || out != "id_1\n" {
		t.Errorf("sig ids: code=%d out=%q", code, out)
	}
}

func TestIdentity_SignatureFromHTMLOnly(t *testing.T) {
	// --html alone must NOT touch the text signature — and must not read stdin.
	f := newMailFake()
	dir := t.TempDir()
	html := dir + "/sig.html"
	if err := writeFile(html, "<b>Eric</b>"); err != nil {
		t.Fatal(err)
	}
	_, _, code := runCmd(t, runIdentity, sendEnv(t, f), "identity", "signature", "id_1", "--html", html)
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	// Decoded, not substring-matched: Go escapes `<` as \u003c in JSON, which
	// is the SAME value on the wire — asserting on the bytes would fail a
	// correct request. (The recurring lesson, applied preemptively for once.)
	args := f.argsOf("Identity/set")
	var call struct {
		Update map[string]map[string]string `json:"update"`
	}
	if err := json.Unmarshal([]byte(args), &call); err != nil {
		t.Fatalf("unparseable args: %v", err)
	}
	patch := call.Update["id_1"]
	if patch["htmlSignature"] != "<b>Eric</b>" {
		t.Errorf("htmlSignature = %q", patch["htmlSignature"])
	}
	if _, has := patch["textSignature"]; has {
		t.Errorf("--html alone must not touch textSignature: %s", args)
	}
}

func TestIdentity_ShowUnknownIsNotFound(t *testing.T) {
	f := newMailFake()
	_, errOut, code := runCmd(t, runIdentity, sendEnv(t, f), "identity", "show", "nobody@x.test")
	if code == 0 {
		t.Fatal("unknown identity must fail")
	}
	if !strings.Contains(errOut, "no identity matches") {
		t.Errorf("stderr = %q", errOut)
	}
}
