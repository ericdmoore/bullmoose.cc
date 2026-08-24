package cmd

// Fleet mode + the persistent loop (s43 step 6). The properties are the s43
// clauses: authority is DISCOVERED from a fresh session and revocation is
// live in both halves; the capability vector rides the claim verbatim;
// channels follow the served set; and shutdown is graceful — the one named
// divergence, observed end to end.

import (
	"context"
	"encoding/json"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/ws/wstest"
)

// grantedAccounts is a session accounts map: two agent-granted accounts and
// one (the login's own mail) WITHOUT the agent capability — the shape
// buildSession serves a runtime principal.
const grantedAccounts = `{` +
	`"a_you":{"name":"You","isPersonal":true,"accountCapabilities":{"urn:ietf:params:jmap:mail":{}}},` +
	`"a_h":{"name":"Hermes","isPersonal":false,"accountCapabilities":{"urn:ietf:params:jmap:mail":{},"urn:bullmoose:params:jmap:agent":{}}},` +
	`"a_a":{"name":"Allen","isPersonal":false,"accountCapabilities":{"urn:ietf:params:jmap:mail":{},"urn:bullmoose:params:jmap:agent":{}}}}`

const fleetJSON = `{"capabilities":{"vision":false,"contextTokens":32000,"tools":false},` +
	`"bindings":{` +
	`"hermes-responder":{"persona":"You are Hermes.","model":{"provider":"mock"}},` +
	`"allen-analyst":{"persona":"You are Allen.","model":{"provider":"mock"}}}}`

func TestDiscoverAgentAccounts(t *testing.T) {
	f := newMailFake()
	f.sessionAccounts = grantedAccounts
	dbPath := sendEnv(t, f)
	_ = dbPath
	client := jmap.NewSessionClient(f.base, "bm_tok")

	got, err := discoverAgentAccounts(context.Background(), client)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, len(got))
	for i, a := range got {
		ids[i] = a.AccountID
	}
	// The login's own mail account carries no agent capability: NOT served.
	if strings.Join(ids, ",") != "a_h,a_a" {
		t.Fatalf("served = %v — the grants ARE the served set", ids)
	}

	// FRESHNESS is the point: the session is re-fetched per discovery, so a
	// revocation between two calls on the SAME client is seen. A cached
	// session would pass every other assertion and still be wrong.
	f.mu.Lock()
	f.sessionAccounts = strings.Replace(grantedAccounts,
		`"a_a":{"name":"Allen","isPersonal":false,"accountCapabilities":{"urn:ietf:params:jmap:mail":{},"urn:bullmoose:params:jmap:agent":{}}}`,
		`"a_a":{"name":"Allen","isPersonal":false,"accountCapabilities":{"urn:ietf:params:jmap:mail":{}}}`, 1)
	f.mu.Unlock()
	got2, err := discoverAgentAccounts(context.Background(), client)
	if err != nil {
		t.Fatal(err)
	}
	if len(got2) != 1 || got2[0].AccountID != "a_h" {
		t.Fatalf("a revoked grant must drop on the NEXT discovery: %v", got2)
	}

	// An account with NO capabilities object at all (older server) is
	// admitted; the per-account drain refusal is the backstop.
	f.mu.Lock()
	f.sessionAccounts = `{"a_old":{"name":"Old","isPersonal":true}}`
	f.mu.Unlock()
	got3, _ := discoverAgentAccounts(context.Background(), client)
	if len(got3) != 1 || got3[0].AccountID != "a_old" {
		t.Fatalf("absent capabilities must admit: %v", got3)
	}
}

func TestAgentServe_FleetOnceDiscoversFromGrants(t *testing.T) {
	f := newMailFake()
	f.sessionAccounts = grantedAccounts
	dbPath := sendEnv(t, f)
	fleetPath := serveConfig(t, fleetJSON)

	_, errOut, code := runCmd(t, runAgent, dbPath, "agent", "serve", "--fleet", fleetPath, "--once")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	// Both granted accounts drained — two queries, with THEIR account ids.
	var queried []string
	for _, c := range f.calls {
		if c.Name == "AgentInvocation/query" {
			var q struct {
				AccountID string `json:"accountId"`
			}
			_ = json.Unmarshal(c.Args, &q)
			queried = append(queried, q.AccountID)
		}
	}
	if strings.Join(queried, ",") != "a_h,a_a" {
		t.Fatalf("queried = %v", queried)
	}
	for _, want := range []string{
		"Hermes: serving (granted)",
		"Allen: serving (granted)",
		"serving 2 binding(s) [allen-analyst, hermes-responder] over 2 account(s)",
		// The vector is the FILE's declarations plus the host's PROVEN facts
		// (s45's menu, s44's sandbox flavor) — so the assertion is on what the
		// file said, which must survive the merge unchanged.
		`"vision":false`,
	} {
		if !strings.Contains(errOut, want) {
			t.Errorf("stderr missing %q\n%s", want, errOut)
		}
	}
}

func TestAgentServe_LiveRevocationDropsOneAccountOnly(t *testing.T) {
	// a_h's grant is gone (the server refuses its drain); a_a keeps working —
	// dropped mid-drain, other bindings unaffected.
	f := newMailFake()
	f.sessionAccounts = grantedAccounts
	f.refuseQueryFor = map[string]string{"a_h": "forbidden"}
	dbPath := sendEnv(t, f)

	_, errOut, code := runCmd(t, runAgent, dbPath, "agent", "serve", "--fleet", serveConfig(t, fleetJSON), "--once")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	if !strings.Contains(errOut, "Hermes: claim authority revoked — dropped (other bindings unaffected)") {
		t.Errorf("stderr = %q", errOut)
	}
	// The OTHER account's drain still ran.
	found := false
	for _, c := range f.calls {
		if c.Name == "AgentInvocation/query" && strings.Contains(string(c.Args), "a_a") {
			found = true
		}
	}
	if !found {
		t.Error("one revocation must not stop the other accounts' drains")
	}
}

func TestAgentServe_CapabilityVectorRidesTheClaim(t *testing.T) {
	f := newMailFake()
	f.sessionAccounts = grantedAccounts
	f.invocationIDs = `["inv_1"]`
	f.invocationList = `[{"id":"inv_1","emailId":"em_7","bindingName":"hermes-responder","status":"pending","requires":null}]`
	f.addEmail("em_7", `{"id":"em_7","from":[{"name":"Pat","email":"pat@ext.test"}],"subject":"Hi",`+
		`"bodyValues":{"1":{"value":"b"}},"textBody":[{"partId":"1","type":"text/plain"}]}`)
	dbPath := sendEnv(t, f)

	_, errOut, code := runCmd(t, runAgent, dbPath, "agent", "serve", "--fleet", serveConfig(t, fleetJSON), "--once")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	// The claim DECLARES the vector, verbatim from the file.
	var claim struct {
		Claimant struct {
			IsFree       bool            `json:"isFree"`
			Capabilities json.RawMessage `json:"capabilities"`
		} `json:"claimant"`
	}
	for _, c := range f.calls {
		if c.Name == "AgentInvocation/set" && strings.Contains(string(c.Args), "running") {
			_ = json.Unmarshal(c.Args, &claim)
			break
		}
	}
	// The file's declarations ride UNCHANGED; probed facts (the model menu,
	// the sandbox flavor) may join them — a declaration is the file plus
	// what the host can prove, never one silently replacing the other.
	caps := string(claim.Claimant.Capabilities)
	fileDeclared := strings.Contains(caps, `"vision":false`) &&
		strings.Contains(caps, `"contextTokens":32000`) &&
		strings.Contains(caps, `"tools":false`)
	if !claim.Claimant.IsFree || !fileDeclared {
		t.Errorf("claimant = isFree %v caps %s — the file's declarations must survive the merge",
			claim.Claimant.IsFree, claim.Claimant.Capabilities)
	}
}

func TestAgentServe_NarrowingSkipsBeyondThisHost(t *testing.T) {
	f := newMailFake()
	f.sessionAccounts = grantedAccounts
	f.invocationIDs = `["inv_1"]`
	f.invocationList = `[{"id":"inv_1","emailId":"em_7","bindingName":"hermes-responder","status":"pending","requires":{"vision":true}}]`
	dbPath := sendEnv(t, f)

	_, errOut, code := runCmd(t, runAgent, dbPath, "agent", "serve", "--fleet", serveConfig(t, fleetJSON), "--once")
	if code != 0 {
		t.Fatal(code)
	}
	if !strings.Contains(errOut, `inv_1 requires {"vision":true} — beyond this host, leaving it`) {
		t.Errorf("stderr = %q", errOut)
	}
	for _, c := range f.calls {
		if c.Name == "AgentInvocation/set" {
			t.Fatal("a skip is a preference — no claim may be burned")
		}
	}
}

// ── the persistent loop, end to end ─────────────────────────────────────────

// safeBuf is a writer a *bmio.Streams can share across the loop's goroutines
// (the watch tests' pattern).
type safeBuf struct {
	mu   sync.Mutex
	data []byte
}

func (b *safeBuf) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, p...)
	return len(p), nil
}

func (b *safeBuf) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.data)
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestAgentServePersistent_ChannelsTickAndShutdown(t *testing.T) {
	f := newMailFake()
	f.sessionAccounts = `{"a_h":{"name":"Hermes","accountCapabilities":{"urn:bullmoose:params:jmap:agent":{}}}}`
	f.wsConns = make(chan *wstest.Conn, 4)
	dbPath := sendEnv(t, f)
	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	settings, err := store.RequireSettings(db)
	if err != nil {
		t.Fatal(err)
	}
	client := jmap.NewSessionClient(settings.Base, settings.Token)
	fleet, err := loadFleetConfig(serveConfig(t, fleetJSON))
	if err != nil {
		t.Fatal(err)
	}

	var out, errOut safeBuf
	s := bmio.NewTo(&out, &errOut)
	tick := make(chan time.Time)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan int, 1)
	go func() {
		done <- agentServePersistent(ctx, s, client, settings, fleet, "fleet:2", true, serveLoopDeps{
			tick:       tick,
			jitter:     func() float64 { return 0.5 },
			backoffMin: 5 * time.Millisecond,
			backoffMax: 20 * time.Millisecond,
		})
	}()

	recvConn := func(what string) *wstest.Conn {
		select {
		case c := <-f.wsConns:
			return c
		case <-time.After(10 * time.Second):
			t.Fatalf("timed out waiting for %s", what)
			return nil
		}
	}

	// One channel per served account, carrying the account and the token in
	// the query — the shape the WS door authenticates.
	conn1 := recvConn("the first channel")
	// The server-side socket must outlive its last use: *net.TCPConn carries
	// a runtime finalizer that closes the fd, so a COLLECTED conn would FIN
	// the channel mid-test and the reconnect would masquerade as a bug (it
	// did: EOF → re-dial → a duplicate drain, only under GC pressure).
	defer runtime.KeepAlive(conn1)
	q := conn1.Request.URL.Query()
	if q.Get("accountId") != "a_h" || q.Get("access_token") != "bm_tok" {
		t.Fatalf("upgrade query = %v", conn1.Request.URL.RawQuery)
	}

	// A StateChange kicks a drain: seed a pending invocation, push the frame,
	// and watch the claim→draft→done choreography arrive.
	f.mu.Lock()
	f.invocationIDs = `["inv_1"]`
	f.invocationList = `[{"id":"inv_1","emailId":"em_7","bindingName":"hermes-responder","status":"pending","requires":null}]`
	f.mu.Unlock()
	f.addEmail("em_7", `{"id":"em_7","from":[{"name":"Pat","email":"pat@ext.test"}],"subject":"Hi",`+
		`"bodyValues":{"1":{"value":"b"}},"textBody":[{"partId":"1","type":"text/plain"}]}`)
	if err := conn1.WriteText(`{"@type":"StateChange","changed":{}}`); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the push-kicked drain to complete the invocation", func() bool {
		for _, name := range f.names() {
			if name == "Email/set" {
				return true
			}
		}
		return false
	})

	// A tick re-discovers: mint a second grant, fire the tick, and the new
	// account's channel dials — no restart.
	f.mu.Lock()
	f.invocationIDs = ""
	f.sessionAccounts = `{"a_h":{"name":"Hermes","accountCapabilities":{"urn:bullmoose:params:jmap:agent":{}}},` +
		`"a_a":{"name":"Allen","accountCapabilities":{"urn:bullmoose:params:jmap:agent":{}}}}`
	f.mu.Unlock()
	select {
	case tick <- time.Time{}:
	case <-time.After(10 * time.Second):
		t.Fatal("the loop stopped selecting on the tick")
	}
	conn2 := recvConn("the new grant's channel")
	defer runtime.KeepAlive(conn2)
	if conn2.Request.URL.Query().Get("accountId") != "a_a" {
		t.Fatalf("second channel = %v\nchrome so far:\n%s", conn2.Request.URL.RawQuery, errOut.String())
	}

	// Graceful shutdown: cancel, and the loop closes its channels and says
	// what it did. (The in-flight guarantee is structural — drains run on an
	// uncancellable context on the loop goroutine — and the drain above
	// already proved a full pipeline completes.)
	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("exit = %d", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the loop did not shut down")
	}
	chrome := errOut.String()
	for _, want := range []string{
		"Hermes: serving (granted)",
		"Hermes: connected",
		"Allen: serving (granted)",
		"shutting down — in-flight work completed, channels closed",
	} {
		if !strings.Contains(chrome, want) {
			t.Errorf("stderr missing %q\n%s", want, chrome)
		}
	}
}

func TestServeWSURL(t *testing.T) {
	got := serveWSURL("https://mail.example.test", "bm_x", "a_1")
	if !strings.HasPrefix(got, "wss://mail.example.test/api/ws?") ||
		!strings.Contains(got, "accountId=a_1") || !strings.Contains(got, "access_token=bm_x") {
		t.Errorf("url = %q", got)
	}
	if !strings.HasPrefix(serveWSURL("http://local.test", "t", "a"), "ws://") {
		t.Error("http must map to ws")
	}
}
