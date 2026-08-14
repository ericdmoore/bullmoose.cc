package cmd

// `token` against a fake /auth/tokens. The load-bearing assertion is the FIRST
// one: a missing --scopes is refused with the server never contacted. Asserting
// "the server saw nothing" rather than "it printed an error" is what makes the
// test about the invariant (cli/007: the shortest command must not mint the
// widest credential) rather than about a string — a refusal that still sent the
// request would be a refusal in name only, and would mint on any server that
// ever regressed the same default.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// ---- fake /auth server -----------------------------------------------------

type authCall struct {
	method, path string
	body         map[string]any
}

type authFake struct {
	mu    sync.Mutex
	calls []authCall
	// status/body override the default answer for the next request, so the
	// refusal paths (401, an HTML 404) are drivable.
	status      int
	body        string
	contentType string
	// revoked is what DELETE reports.
	revoked bool
}

func newAuthFake() *authFake { return &authFake{revoked: true} }

func (f *authFake) start(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(srv.Close)
	return srv
}

func (f *authFake) seen() []authCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]authCall(nil), f.calls...)
}

func (f *authFake) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.calls = append(f.calls, authCall{method: r.Method, path: r.URL.Path, body: body})

	if f.status != 0 {
		ct := f.contentType
		if ct == "" {
			ct = "application/json"
		}
		w.Header().Set("content-type", ct)
		w.WriteHeader(f.status)
		_, _ = w.Write([]byte(f.body))
		return
	}
	w.Header().Set("content-type", "application/json")
	switch {
	// `login` shares this fake: it is the same worker and the same four routes
	// (services/jmap/src/authRoutes.ts), and sharing it means one place records
	// what the CLI sent — which is what the "no password on the wire" assertion
	// in login_test.go reads.
	case r.Method == http.MethodPost && r.URL.Path == "/auth/login":
		_, _ = w.Write([]byte(loginResponse))
	// The session resource, unauthenticated: a 401 is discovery's YES
	// (discover.ts:99 — "JMAP server present, auth required, expected").
	case r.Method == http.MethodGet && r.URL.Path == "/.well-known/jmap":
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
	case r.Method == http.MethodPost && r.URL.Path == "/auth/tokens":
		scopes, _ := body["scopes"].([]any)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tokenId": "tk_new", "token": "bm_minted_secret", "scopes": scopes,
		})
	case r.Method == http.MethodGet && r.URL.Path == "/auth/tokens":
		// `expires_at` is a field the server selects and the CLI's own row type
		// never names — it is here so the --json case can prove rows are
		// re-emitted VERBATIM rather than round-tripped through a struct.
		_, _ = w.Write([]byte(`{"tokens":[` +
			`{"id":"tk_1","name":"laptop","scopes":"[\"read\"]","created_at":0,"expires_at":null,"last_used_at":null},` +
			`{"id":"tk_2","name":"phone","scopes":"[\"read\",\"send\"]","created_at":0,"expires_at":null,"last_used_at":1767225600000}` +
			`]}`))
	case r.Method == http.MethodDelete:
		_ = json.NewEncoder(w).Encode(map[string]any{"revoked": f.revoked})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// runTok runs `token …` against a mirror seeded for srv, with captured streams.
func runTok(t *testing.T, dbPath string, args ...string) (out, errOut string, code int) {
	t.Helper()
	var o, e strings.Builder
	s := bmio.NewTo(&o, &e)
	argv := append([]string{"token"}, args...)
	argv = append(argv, "--db", dbPath)
	code = runToken(s, argv)
	return o.String(), e.String(), code
}

// ---- the refusal -----------------------------------------------------------

// TestTokenCreateWithoutScopesRefusesAndSendsNothing is cli/007 end to end: the
// seam test (cli007_test.go) proves the resolver refuses; this proves the COMMAND
// refuses, before the network, with the exit code a script branches on.
func TestTokenCreateWithoutScopesRefusesAndSendsNothing(t *testing.T) {
	fake := newAuthFake()
	srv := fake.start(t)
	db := seedMirror(t, srv.URL, "bm_token", "t_x__a_y")

	out, errOut, code := runTok(t, db, "create", "--name", "ci")
	if code != int(bmio.ExitUsage) {
		t.Errorf("exit code = %d, want %d (usage)", code, bmio.ExitUsage)
	}
	if len(fake.seen()) != 0 {
		t.Errorf("the server was contacted %d time(s); a missing --scopes must be refused "+
			"locally, or a server that regressed the wide default would mint one", len(fake.seen()))
	}
	if out != "" {
		t.Errorf("stdout must stay empty on a refusal, got %q", out)
	}
	for _, want := range []string{"--scopes is required.", "valid scopes:", "common choices:",
		"usage: bullmoose token create"} {
		if !strings.Contains(errOut, want) {
			t.Errorf("the refusal should contain %q:\n%s", want, errOut)
		}
	}
	// The exact regression: never substitute the widest credential.
	if strings.Contains(errOut, "defaulting") || strings.Contains(out, "bm_minted_secret") {
		t.Errorf("a scope was substituted for the missing flag:\n%s%s", out, errOut)
	}
}

// TestTokenCreateWithEmptyScopesRefuses: `--scopes ""` is a typo, not a request
// for a token that can do nothing (scopes.ts:57). Also zero requests.
func TestTokenCreateWithEmptyScopesRefuses(t *testing.T) {
	fake := newAuthFake()
	srv := fake.start(t)
	db := seedMirror(t, srv.URL, "bm_token", "t_x__a_y")

	_, errOut, code := runTok(t, db, "create", "--scopes", "")
	if code != int(bmio.ExitUsage) {
		t.Errorf("exit code = %d, want 2", code)
	}
	if len(fake.seen()) != 0 {
		t.Errorf("an empty --scopes reached the server: %v", fake.seen())
	}
	if !strings.Contains(errOut, "--scopes was given but empty.") {
		t.Errorf("the message should distinguish empty from absent:\n%s", errOut)
	}
}

// TestTokenCreateUnknownScopeRefusesLocally — a typo'd scope should cost a local
// exit 2 naming the vocabulary, not an HTTP 400 after a round trip (scopes.ts:9).
func TestTokenCreateUnknownScopeRefusesLocally(t *testing.T) {
	fake := newAuthFake()
	srv := fake.start(t)
	db := seedMirror(t, srv.URL, "bm_token", "t_x__a_y")

	_, errOut, code := runTok(t, db, "create", "--scopes", "read,reed")
	if code != int(bmio.ExitUsage) || len(fake.seen()) != 0 {
		t.Errorf("code=%d calls=%d, want 2 and no request", code, len(fake.seen()))
	}
	if !strings.Contains(errOut, "unknown scope(s): reed") {
		t.Errorf("the offender should be named:\n%s", errOut)
	}
	// `admin` is not self-service, and the refusal must come from here rather
	// than from a 403 (a password can never mint a control-plane token).
	if _, _, code := runTok(t, db, "create", "--scopes", "admin"); code != int(bmio.ExitUsage) {
		t.Errorf("`--scopes admin` exit = %d, want 2", code)
	}
}

// ---- the happy paths -------------------------------------------------------

// TestTokenCreatePutsTheSecretAloneOnStdout is contract.mjs:158 as a Go test: the
// captured token is the whole of stdout, and everything else is chrome. This is
// the §1.1 case that makes `T=$(bullmoose token create …)` work.
func TestTokenCreatePutsTheSecretAloneOnStdout(t *testing.T) {
	fake := newAuthFake()
	srv := fake.start(t)
	db := seedMirror(t, srv.URL, "bm_token", "t_x__a_y")

	out, errOut, code := runTok(t, db, "create", "--name", "ci", "--scopes", "read")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if out != "bm_minted_secret\n" {
		t.Errorf("stdout = %q, want the secret and nothing else", out)
	}
	if !strings.Contains(errOut, "created tk_new [read]") || !strings.Contains(errOut, "shown once") {
		t.Errorf("the chrome belongs on stderr and must still be shown:\n%s", errOut)
	}
	calls := fake.seen()
	if len(calls) != 1 || calls[0].method != http.MethodPost || calls[0].path != "/auth/tokens" {
		t.Fatalf("calls = %+v, want one POST /auth/tokens", calls)
	}
	if got := calls[0].body["name"]; got != "ci" {
		t.Errorf("name sent = %v, want ci", got)
	}
	if got, _ := json.Marshal(calls[0].body["scopes"]); string(got) != `["read"]` {
		t.Errorf("scopes sent = %s, want [\"read\"]", got)
	}
}

func TestTokenCreateJSON(t *testing.T) {
	fake := newAuthFake()
	srv := fake.start(t)
	db := seedMirror(t, srv.URL, "bm_token", "t_x__a_y")

	out, errOut, code := runTok(t, db, "create", "--scopes", "read,draft", "--json")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	// Key order is tokens.ts:174's, and one complete value on one line (§1.3).
	if got := strings.TrimRight(out, "\n"); got != `{"tokenId":"tk_new","token":"bm_minted_secret","scopes":["read","draft"]}` {
		t.Errorf("json = %s", got)
	}
	// The name the server defaults to when the flag is absent (tokens.ts:164).
	if got := fake.seen()[0].body["name"]; got != "token" {
		t.Errorf("default name = %v, want token", got)
	}
}

// TestTokenListRoundTrips covers the three renderings, and pins the one that
// would silently lose data: --json re-emits the SERVER's row, so a field the CLI
// never names still reaches `jq`.
func TestTokenListRoundTrips(t *testing.T) {
	fake := newAuthFake()
	srv := fake.start(t)
	db := seedMirror(t, srv.URL, "bm_token", "t_x__a_y")

	out, errOut, code := runTok(t, db, "list")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d lines, want 2:\n%s", len(lines), out)
	}
	if lines[0] != "tk_1  read                  last-used=never  laptop" {
		t.Errorf("row 0 = %q", lines[0])
	}
	// last_used_at is milliseconds → the DATE, not the instant (tokens.ts:205).
	if lines[1] != "tk_2  read,send             last-used=2026-01-01  phone" {
		t.Errorf("row 1 = %q", lines[1])
	}

	out, _, _ = runTok(t, db, "list", "--json")
	if !strings.Contains(out, `"expires_at":null`) {
		t.Errorf("--json must re-emit the server's row verbatim, including fields this CLI "+
			"does not name; got:\n%s", out)
	}
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		var one map[string]any
		if err := json.Unmarshal([]byte(line), &one); err != nil {
			t.Errorf("each line must be one complete JSON value: %v", err)
		}
	}

	out, _, _ = runTok(t, db, "list", "--ids")
	if out != "tk_1\ntk_2\n" {
		t.Errorf("--ids = %q, want bare ids for xargs", out)
	}
}

func TestTokenListEmptyWritesNothingToStdout(t *testing.T) {
	fake := newAuthFake()
	fake.status, fake.body = 200, `{"tokens":[]}`
	srv := fake.start(t)
	db := seedMirror(t, srv.URL, "bm_token", "t_x__a_y")

	out, errOut, code := runTok(t, db, "list")
	if code != 0 || out != "" {
		t.Errorf("code=%d stdout=%q — an empty result set writes nothing to stdout (§1.1)", code, out)
	}
	if !strings.Contains(errOut, "(no tokens)") {
		t.Errorf("the empty note belongs on stderr: %q", errOut)
	}
}

func TestTokenRevoke(t *testing.T) {
	fake := newAuthFake()
	srv := fake.start(t)
	db := seedMirror(t, srv.URL, "bm_token", "t_x__a_y")

	out, errOut, code := runTok(t, db, "revoke", "tk_1")
	if code != 0 || out != "revoked tk_1\n" {
		t.Errorf("code=%d out=%q errOut=%q", code, out, errOut)
	}
	calls := fake.seen()
	if len(calls) != 1 || calls[0].method != http.MethodDelete || calls[0].path != "/auth/tokens/tk_1" {
		t.Errorf("calls = %+v, want DELETE /auth/tokens/tk_1", calls)
	}

	// An id that is not this principal's is a NOTE and exit 0, so `revoke` stays
	// idempotent in a script (tokens.ts:229).
	fake.revoked = false
	out, errOut, code = runTok(t, db, "revoke", "tk_gone")
	if code != 0 || out != "" {
		t.Errorf("code=%d out=%q, want 0 and no record", code, out)
	}
	if !strings.Contains(errOut, "tk_gone not found (or not yours)") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestTokenRevokeDryRunSendsNothing(t *testing.T) {
	fake := newAuthFake()
	srv := fake.start(t)
	db := seedMirror(t, srv.URL, "bm_token", "t_x__a_y")

	out, errOut, code := runTok(t, db, "revoke", "tk_1", "--dry-run", "--json")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if len(fake.seen()) != 0 {
		t.Errorf("--dry-run reached the server: %v", fake.seen())
	}
	if !strings.Contains(errOut, "dry run: would revoke token tk_1") {
		t.Errorf("stderr = %q", errOut)
	}
	if strings.TrimRight(out, "\n") != `{"dryRun":true,"tokenId":"tk_1"}` {
		t.Errorf("stdout = %q", out)
	}
}

func TestTokenRevokeWithoutIDIsUsage(t *testing.T) {
	fake := newAuthFake()
	srv := fake.start(t)
	db := seedMirror(t, srv.URL, "bm_token", "t_x__a_y")

	_, errOut, code := runTok(t, db, "revoke")
	if code != int(bmio.ExitUsage) {
		t.Errorf("exit = %d, want 2", code)
	}
	if !strings.Contains(errOut, "usage: bullmoose token revoke <tokenId>") {
		t.Errorf("stderr = %q", errOut)
	}
	if len(fake.seen()) != 0 {
		t.Errorf("a missing id reached the server: %v", fake.seen())
	}
}

func TestTokenUnknownVerbIsUsage(t *testing.T) {
	fake := newAuthFake()
	srv := fake.start(t)
	db := seedMirror(t, srv.URL, "bm_token", "t_x__a_y")
	for _, argv := range [][]string{{}, {"mint"}} {
		_, errOut, code := runTok(t, db, argv...)
		if code != int(bmio.ExitUsage) {
			t.Errorf("%v: exit = %d, want 2", argv, code)
		}
		if !strings.Contains(errOut, tokenUsage) {
			t.Errorf("%v: stderr = %q", argv, errOut)
		}
	}
}

// ---- refusals from the server ---------------------------------------------

// TestTokenServerRefusalsMapToExitCodes: the §1.5 table applied to a non-JMAP
// endpoint (io.ts:144 exitCodeForHttpStatus).
func TestTokenServerRefusalsMapToExitCodes(t *testing.T) {
	for _, c := range []struct {
		status int
		want   bmio.ExitCode
	}{
		{401, bmio.ExitAuth},
		{403, bmio.ExitAuth},
		{404, bmio.ExitNotFound},
		{400, bmio.ExitUsage},
		{500, bmio.ExitFail},
	} {
		fake := newAuthFake()
		fake.status, fake.body = c.status, `{"error":"nope"}`
		srv := fake.start(t)
		db := seedMirror(t, srv.URL, "bm_token", "t_x__a_y")
		_, errOut, code := runTok(t, db, "create", "--scopes", "read")
		if code != int(c.want) {
			t.Errorf("HTTP %d → exit %d, want %d", c.status, code, c.want)
		}
		if !strings.Contains(errOut, `{"error":"nope"}`) {
			t.Errorf("HTTP %d: the server's own words should survive: %q", c.status, errOut)
		}
	}
}

// TestTokenHtmlRefusalIsNotDumped: a domain that is not a bullmoose server
// answers with a page. The CLI must describe it, not paste it — the same failure
// internal/discover's probe exists to catch, one layer down.
func TestTokenHtmlRefusalIsNotDumped(t *testing.T) {
	fake := newAuthFake()
	fake.status = 404
	fake.contentType = "text/html; charset=utf-8"
	fake.body = "<!doctype html><html><body>" + strings.Repeat("nothing here ", 500) + "</body></html>"
	srv := fake.start(t)
	db := seedMirror(t, srv.URL, "bm_token", "t_x__a_y")

	_, errOut, code := runTok(t, db, "create", "--scopes", "read")
	if code != int(bmio.ExitNotFound) {
		t.Errorf("exit = %d, want 3", code)
	}
	if strings.Contains(errOut, "<html") || len(errOut) > 400 {
		t.Errorf("the page was dumped into stderr (%d bytes):\n%.200s…", len(errOut), errOut)
	}
	if !strings.Contains(errOut, "text/html") || !strings.Contains(errOut, "bullmoose server") {
		t.Errorf("the refusal should say what came back instead:\n%s", errOut)
	}
}

// TestTokenOnAnUnconfiguredMirrorSaysSo — main.ts:273 resolves settings before
// the verb, so the first thing an unconfigured machine hears is how to configure
// itself, not which verbs `token` has.
func TestTokenOnAnUnconfiguredMirrorSaysSo(t *testing.T) {
	_, errOut, code := runTok(t, t.TempDir()+"/absent.db", "list")
	if code != int(bmio.ExitUsage) {
		t.Errorf("exit = %d, want 2", code)
	}
	if !strings.Contains(errOut, "not configured — run: bullmoose login") {
		t.Errorf("stderr = %q", errOut)
	}
}
