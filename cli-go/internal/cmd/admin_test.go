package cmd

// admin — the operator plane. The tests concentrate on the three things whose
// failure is expensive: the --yes gate on irreversible verbs, the two paths a
// secret can travel (BYOK key, password), and the token-create stdout split.

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

type adminFake struct {
	mu    sync.Mutex
	calls []struct{ Method, Path, Body string }
	reply map[string]string // "METHOD path-prefix" → body
	// status, when non-zero, is what EVERY request answers — the
	// operator-plane-unreachable fixture (s43 step 2).
	status int
	srv    *httptest.Server
}

func newAdminFake(t *testing.T) *adminFake {
	t.Helper()
	v := &adminFake{reply: map[string]string{}}
	v.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		v.mu.Lock()
		v.calls = append(v.calls, struct{ Method, Path, Body string }{r.Method, r.URL.RequestURI(), string(b)})
		reply := "{}"
		for key, body := range v.reply {
			method, prefix, _ := strings.Cut(key, " ")
			if r.Method == method && strings.HasPrefix(r.URL.Path, prefix) {
				reply = body
			}
		}
		status := v.status
		v.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		if status != 0 {
			w.WriteHeader(status)
		}
		_, _ = w.Write([]byte(reply))
	}))
	t.Cleanup(v.srv.Close)
	return v
}

func adminEnv(t *testing.T, v *adminFake) string {
	t.Helper()
	f := newMailFake()
	dbPath := sendEnv(t, f)
	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, kv := range [][2]string{{"adminUrl", v.srv.URL}, {"adminToken", "admin_tok"}} {
		if err := store.SetConfig(db, kv[0], kv[1]); err != nil {
			t.Fatal(err)
		}
	}
	return dbPath
}

func TestAdmin_IrreversibleVerbsDemandYes(t *testing.T) {
	// The gate sits BEFORE any request, and --dry-run is exempt — a preview
	// that demands the confirmation flag is a preview nobody uses.
	for _, tc := range [][]string{
		{"tenant", "delete", "t_x"},
		{"domain", "delete", "d.test"},
		{"account", "delete", "a_1"},
		{"agent", "unbind", "b_1"},
	} {
		v := newAdminFake(t)
		_, errOut, code := runCmd(t, runAdmin, adminEnv(t, v), "admin", tc...)
		if code != 2 {
			t.Errorf("%v: code = %d, want 2", tc, code)
		}
		if len(v.calls) != 0 {
			t.Errorf("%v: the refusal must cost zero requests, got %+v", tc, v.calls)
		}
		if !strings.Contains(errOut, "cannot be undone") || !strings.Contains(errOut, "--yes") {
			t.Errorf("%v: stderr = %q", tc, errOut)
		}

		// --dry-run previews without --yes and still sends nothing.
		v2 := newAdminFake(t)
		_, dryErr, dryCode := runCmd(t, runAdmin, adminEnv(t, v2), "admin", append(tc, "--dry-run")...)
		if dryCode != 0 || len(v2.calls) != 0 {
			t.Errorf("%v --dry-run: code=%d calls=%+v", tc, dryCode, v2.calls)
		}
		if !strings.Contains(dryErr, "dry run") {
			t.Errorf("%v --dry-run: stderr = %q", tc, dryErr)
		}
	}
}

func TestAdmin_KillSwitchNeedsNothing(t *testing.T) {
	// The reversible direction must stay easy — mid-incident friction on
	// `disable` defeats the point of a kill switch.
	v := newAdminFake(t)
	v.reply["POST /agent-bindings/b_1/disable"] = `{"name":"editor","accountId":"a_you","pendingInvocations":2,"note":"2 invocations held"}`
	out, errOut, code := runCmd(t, runAdmin, adminEnv(t, v), "admin", "agent", "disable", "b_1")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	if !strings.Contains(out, "is now DISABLED") {
		t.Errorf("stdout = %q", out)
	}
	// Held work is surfaced, and the way back is named.
	if !strings.Contains(errOut, "2 invocations held") || !strings.Contains(errOut, "agent enable b_1") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestAdmin_ByokKeyNeverRidesArgv(t *testing.T) {
	// --key-env names a VARIABLE. The key travels: env → request body, and
	// appears in neither output stream.
	v := newAdminFake(t)
	v.reply["POST /provider-keys"] = `{"rotated":false,"credRef":"cred_1","provider":"openrouter","allow":"https://openrouter.ai","bindings":[]}`
	t.Setenv("BM_TEST_PROVIDER_KEY", "sk-or-SECRET")
	out, errOut, code := runCmd(t, runAdmin, adminEnv(t, v), "admin", "byok", "seal", "eric@b.test",
		"--key-env", "BM_TEST_PROVIDER_KEY")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	if !strings.Contains(v.calls[0].Body, "sk-or-SECRET") {
		t.Error("the key never reached the API")
	}
	if strings.Contains(out, "sk-or-SECRET") || strings.Contains(errOut, "sk-or-SECRET") {
		t.Error("THE PROVIDER KEY WAS PRINTED")
	}

	// An EMPTY named variable is a refusal that teaches, before any request.
	v2 := newAdminFake(t)
	_, errOut2, code2 := runCmd(t, runAdmin, adminEnv(t, v2), "admin", "byok", "seal", "eric@b.test",
		"--key-env", "BM_UNSET_VAR")
	if code2 != 2 || len(v2.calls) != 0 {
		t.Errorf("empty env: code=%d calls=%+v", code2, v2.calls)
	}
	if !strings.Contains(errOut2, "names a variable, not a key") {
		t.Errorf("stderr = %q", errOut2)
	}
}

func TestAdmin_PasswordIsDerivedClientSide(t *testing.T) {
	// The server sees the derived login key, never the password.
	v := newAdminFake(t)
	t.Setenv("BULLMOOSE_PASSWORD", "hunter2-plaintext")
	_, _, code := runCmd(t, runAdmin, adminEnv(t, v), "admin", "password", "eric@b.test")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if len(v.calls) != 1 || v.calls[0].Path != "/principals/password" {
		t.Fatalf("calls = %+v", v.calls)
	}
	if strings.Contains(v.calls[0].Body, "hunter2-plaintext") {
		t.Error("THE RAW PASSWORD WENT OVER THE WIRE")
	}
	if !strings.Contains(v.calls[0].Body, "loginKey") {
		t.Errorf("body = %s", v.calls[0].Body)
	}
}

func TestAdmin_TokenCreateSplitsSecretFromChrome(t *testing.T) {
	// `T=$(bullmoose admin token create …)` must capture the token ALONE.
	v := newAdminFake(t)
	v.reply["POST /tokens"] = `{"token":"bm_MINTED","tokenId":"tk_9"}`
	out, errOut, code := runCmd(t, runAdmin, adminEnv(t, v), "admin", "token", "create", "cj@b.test",
		"--name", "cj-laptop", "--scopes", "read,draft")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	if out != "bm_MINTED\n" {
		t.Errorf("stdout must be the secret alone: %q", out)
	}
	if !strings.Contains(errOut, "minted tk_9") || !strings.Contains(errOut, "shown once") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestAdmin_TokenCreateRequiresScopes(t *testing.T) {
	// The operator vocabulary is the only one with `admin`, and a silent
	// ["mail"] default is worst exactly here.
	v := newAdminFake(t)
	_, errOut, code := runCmd(t, runAdmin, adminEnv(t, v), "admin", "token", "create", "cj@b.test", "--name", "x")
	if code != 2 || len(v.calls) != 0 {
		t.Fatalf("code=%d calls=%+v", code, v.calls)
	}
	if !strings.Contains(errOut, "--scopes is required") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestAdmin_NotConfiguredNamesTheFix(t *testing.T) {
	f := newMailFake()
	_, errOut, code := runCmd(t, runAdmin, sendEnv(t, f), "admin", "tenant", "list")
	if code != 2 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(errOut, "admin init --url") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestAdmin_AccountCreateIdempotencyIsLegible(t *testing.T) {
	// common/024: a retry ADOPTS. Printing "created" unconditionally told an
	// operator a second account had been built.
	v := newAdminFake(t)
	v.reply["POST /accounts"] = `{"accountId":"a_9","address":"g@d.test","created":false}`
	out, _, code := runCmd(t, runAdmin, adminEnv(t, v), "admin", "account", "create", "g@d.test", "--tenant", "t_1")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(out, "already exists") || !strings.Contains(out, "nothing was created") {
		t.Errorf("stdout = %q", out)
	}
}

var _ = bmio.ExitFail // keep the import if assertions above change

// TestAdmin_VerbChoreography drives every remaining verb through the fake and
// pins the request each one makes — method, path, and the body fragments that
// carry the arguments. This is the s42 bar for the uniform CRUD surface: what
// the SERVER sees is exact; the human rendering is asserted loosely.
func TestAdmin_VerbChoreography(t *testing.T) {
	cases := []struct {
		name       string
		argv       []string
		env        map[string]string // fake replies, "METHOD path" → body
		wantMethod string
		wantPath   string
		wantInBody []string
		wantOut    string
	}{
		{"tenant create", []string{"tenant", "create", "t_home", "--name", "Home"},
			nil, "POST", "/tenants", []string{`"tenantId":"t_home"`, `"name":"Home"`}, "tenant t_home created"},
		{"tenant create defaults name to id", []string{"tenant", "create", "t_x"},
			nil, "POST", "/tenants", []string{`"name":"t_x"`}, ""},
		{"tenant list", []string{"tenant", "list"},
			map[string]string{"GET /tenants": `{"tenants":[{"id":"t_1","status":"active","name":"Home"}]}`},
			"GET", "/tenants", nil, "t_1  active  Home"},
		{"tenant rename", []string{"tenant", "rename", "t_1", "--name", "New"},
			nil, "PATCH", "/tenants/t_1", []string{`"name":"New"`}, `renamed to "New"`},
		{"tenant delete with yes", []string{"tenant", "delete", "t_1", "--yes"},
			nil, "DELETE", "/tenants/t_1", nil, "tenant t_1 deleted"},
		{"domain add", []string{"domain", "add", "d.test", "--tenant", "t_1"},
			map[string]string{"POST /domains": `{"ok":true,"steps":[{"step":"dns","ok":true}]}`},
			"POST", "/domains", []string{`"domain":"d.test"`}, "✓ dns"},
		{"domain status", []string{"domain", "status", "d.test"},
			map[string]string{"GET /domains/d.test": `{"status":"active","verifiedForSending":true,"dkimStatus":"ok"}`},
			"GET", "/domains/d.test", nil, "sending verified: true"},
		{"domain suspend", []string{"domain", "suspend", "d.test"},
			map[string]string{"PATCH /domains/d.test": `{"previousStatus":"active","steps":[]}`},
			"PATCH", "/domains/d.test", []string{`"status":"suspended"`}, ""},
		{"domain resume", []string{"domain", "resume", "d.test"},
			map[string]string{"PATCH /domains/d.test": `{"previousStatus":"suspended","steps":[]}`},
			"PATCH", "/domains/d.test", []string{`"status":"active"`}, ""},
		// "d.test deleted" is CHROME (stderr, as in Node); the table checks
		// records, so this row pins only the request.
		{"domain delete with yes", []string{"domain", "delete", "d.test", "--yes"},
			map[string]string{"DELETE /domains/d.test": `{"ok":true,"steps":[]}`},
			"DELETE", "/domains/d.test", nil, ""},
		{"account rename", []string{"account", "rename", "a_1", "--name", "Grace"},
			nil, "PATCH", "/accounts/a_1", []string{`"displayName":"Grace"`}, ""},
		{"account delete with yes", []string{"account", "delete", "a_1", "--yes"},
			map[string]string{"DELETE /accounts/a_1": `{"deleted":true,"addresses":["g@d.test"],"steps":[],"retained":["mail in shard0"]}`},
			"DELETE", "/accounts/a_1", nil, "account a_1 deleted (g@d.test)"},
		{"account list narrows by tenant", []string{"account", "list", "--tenant", "t_1", "--include-deleted"},
			map[string]string{"GET /accounts": `{"accounts":[]}`},
			"GET", "/accounts?includeDeleted=1&tenant=t_1", nil, ""},
		{"extractor on", []string{"extractor", "on", "g@d.test", "--model", "m1", "--budget", "2000000"},
			map[string]string{"POST /extractor": `{"created":true,"accountId":"a_1","bindingId":"b_1","model":"m1"}`},
			"POST", "/extractor", []string{`"model":"m1"`, `"budgetMicros":2000000`}, "extractor provisioned"},
		{"agent bind", []string{"agent", "bind", "g@d.test", "--name", "editor", "--allow", "a@b.test, c@d.test", "--reply-mode", "draft"},
			map[string]string{"POST /agent-bindings": `{"bindingId":"b_2","watchdog":false}`},
			"POST", "/agent-bindings", []string{`"allowedSenders":["a@b.test","c@d.test"]`, `"replyMode":"draft"`}, "binding b_2"},
		{"agent list", []string{"agent", "list", "g@d.test"},
			map[string]string{"GET /agent-bindings": `{"bindings":[{"id":"b_1","name":"editor","trigger_on":"mailbox-delivery","sla_seconds":300,"enabled":1}]}`},
			"GET", "/agent-bindings?email=g%40d.test", nil, "sla=300  enabled"},
		{"grant create", []string{"grant", "create", "cj@d.test", "eric@d.test", "--scopes", "read,draft"},
			map[string]string{"POST /grants": `{"grantId":"gr_1"}`},
			"POST", "/grants", []string{`"granteeEmail":"cj@d.test"`, `"scopes":["read","draft"]`}, "(whole account)"},
		{"grant list", []string{"grant", "list"},
			map[string]string{"GET /grants": `{"grants":[{"id":"gr_1","grantee_email":"cj@d.test","target_email":"e@d.test","scopes":"[\"read\"]"}]}`},
			"GET", "/grants", nil, "cj@d.test → e@d.test  [read]"},
		{"grant revoke", []string{"grant", "revoke", "gr_1"},
			map[string]string{"DELETE /grants/gr_1": `{"revoked":true}`},
			"DELETE", "/grants/gr_1", nil, "revoked gr_1"},
		{"token list", []string{"token", "list"},
			map[string]string{"GET /tokens": `{"tokens":[{"id":"tk_1","login_email":"e@d.test","scopes":"[\"read\"]","name":"laptop"}]}`},
			"GET", "/tokens", nil, "tk_1  e@d.test  [read]  laptop"},
		{"token revoke", []string{"token", "revoke", "tk_1"},
			map[string]string{"DELETE /tokens/tk_1": `{"revoked":true}`},
			"DELETE", "/tokens/tk_1", nil, "revoked tk_1"},
		{"agent unbind with yes", []string{"agent", "unbind", "b_1", "--yes"},
			map[string]string{"DELETE /agent-bindings/b_1": `{"name":"editor","steps":[]}`},
			"DELETE", "/agent-bindings/b_1", nil, "removed"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := newAdminFake(t)
			for k, b := range tc.env {
				v.reply[k] = b
			}
			out, errOut, code := runCmd(t, runAdmin, adminEnv(t, v), "admin", tc.argv...)
			if code != 0 {
				t.Fatalf("code = %d, stderr = %s", code, errOut)
			}
			if len(v.calls) != 1 {
				t.Fatalf("calls = %+v, want exactly one", v.calls)
			}
			call := v.calls[0]
			if call.Method != tc.wantMethod || call.Path != tc.wantPath {
				t.Errorf("request = %s %s, want %s %s", call.Method, call.Path, tc.wantMethod, tc.wantPath)
			}
			for _, frag := range tc.wantInBody {
				if !strings.Contains(call.Body, frag) {
					t.Errorf("body %s missing %s", call.Body, frag)
				}
			}
			if tc.wantOut != "" && !strings.Contains(out, tc.wantOut) {
				t.Errorf("stdout %q missing %q", out, tc.wantOut)
			}
		})
	}
}

func TestAdmin_UnknownCommandListsWhatExists(t *testing.T) {
	// The usage text is derived, not hand-written — admin.ts's own history:
	// the hand-written version answered `grnat create` with "grants do not
	// exist" while grant verbs were live twenty lines above it.
	v := newAdminFake(t)
	_, errOut, code := runCmd(t, runAdmin, adminEnv(t, v), "admin", "grnat", "create")
	if code != 2 {
		t.Fatalf("code = %d", code)
	}
	for _, want := range []string{"unknown admin command: grnat create", "grant create|list|revoke"} {
		if !strings.Contains(errOut, want) {
			t.Errorf("stderr %q missing %q", errOut, want)
		}
	}
}
