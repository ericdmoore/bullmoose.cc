package cmd

// repoint — the three validate-before-write gates ARE the command. Every
// refusal asserts the stored base is UNTOUCHED afterwards, because "nothing
// was changed" is the promise each error message makes.

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/discover"
	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// otherServer is a second JMAP-ish host repoint can be aimed at.
func otherServer(t *testing.T, status int, accounts string) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/jmap" {
			w.WriteHeader(404)
			return
		}
		if status != 200 {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":"nope"}`))
			return
		}
		w.Header().Set("content-type", "application/json")
		fmt.Fprintf(w, `{"username":"you@stub.test","accounts":%s,"primaryAccounts":{},"apiUrl":%q}`,
			accounts, srv.URL+"/jmap")
	}))
	t.Cleanup(srv.Close)
	return srv
}

func storedBase(t *testing.T, dbPath string) string {
	t.Helper()
	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	return store.GetConfig(db, "base")
}

func TestRepoint_MovesTheBaseAndKeepsTheToken(t *testing.T) {
	f := newMailFake()
	dbPath := sendEnv(t, f)
	dst := otherServer(t, 200, `{"a_you":{"name":"You"},"a_other":{"name":"Other"}}`)

	out, errOut, code := runCmd(t, runRepoint, dbPath, "repoint", "--base", dst.URL)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	if !strings.Contains(out, "repointed: ") || !strings.Contains(out, "-> "+dst.URL) {
		t.Errorf("stdout = %q", out)
	}
	if !strings.Contains(errOut, "token and account kept") {
		t.Errorf("stderr = %q", errOut)
	}
	if got := storedBase(t, dbPath); got != dst.URL {
		t.Errorf("stored base = %q, want %q", got, dst.URL)
	}
}

func TestRepoint_RejectedTokenWritesNothing(t *testing.T) {
	// Gate 2: a base that answers but refuses the token is a NEW LOGIN, said
	// in those words — and the old base survives, broken or not.
	f := newMailFake()
	dbPath := sendEnv(t, f)
	before := storedBase(t, dbPath)
	dst := otherServer(t, 401, "")

	_, errOut, code := runCmd(t, runRepoint, dbPath, "repoint", "--base", dst.URL)
	if code != 4 {
		t.Fatalf("code = %d, want 4 (auth)", code)
	}
	for _, want := range []string{"rejected this device's token", "Nothing was changed", "bullmoose login"} {
		if !strings.Contains(errOut, want) {
			t.Errorf("stderr %q missing %q", errOut, want)
		}
	}
	if got := storedBase(t, dbPath); got != before {
		t.Errorf("base moved on a refusal: %q -> %q", before, got)
	}
}

func TestRepoint_MissingAccountWritesNothing(t *testing.T) {
	// Gate 3: the device's bound account must exist there, and the refusal
	// names what the server DOES have.
	f := newMailFake()
	dbPath := sendEnv(t, f)
	before := storedBase(t, dbPath)
	dst := otherServer(t, 200, `{"a_stranger":{"name":"Not you"}}`)

	_, errOut, code := runCmd(t, runRepoint, dbPath, "repoint", "--base", dst.URL)
	if code == 0 {
		t.Fatal("must refuse a base without the bound account")
	}
	for _, want := range []string{"does not serve account a_you", "a_stranger", "Nothing was changed"} {
		if !strings.Contains(errOut, want) {
			t.Errorf("stderr %q missing %q", errOut, want)
		}
	}
	if got := storedBase(t, dbPath); got != before {
		t.Errorf("base moved on a refusal: %q -> %q", before, got)
	}
}

func TestRepoint_SameBaseIsANoOp(t *testing.T) {
	f := newMailFake()
	dbPath := sendEnv(t, f)
	before := storedBase(t, dbPath)

	_, errOut, code := runCmd(t, runRepoint, dbPath, "repoint", "--base", before)
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(errOut, "already pointed at") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestRepoint_FileBundleAndAutodiscover(t *testing.T) {
	// file:// bundle names the base.
	f := newMailFake()
	dbPath := sendEnv(t, f)
	dst := otherServer(t, 200, `{"a_you":{"name":"You"}}`)
	dir := t.TempDir()
	bundle := dir + "/boot.json"
	if err := writeFile(bundle, `{"base":"`+dst.URL+`"}`); err != nil {
		t.Fatal(err)
	}
	_, _, code := runCmd(t, runRepoint, dbPath, "repoint", "--base", "file://"+bundle)
	if code != 0 {
		t.Fatalf("bundle: code = %d", code)
	}
	if got := storedBase(t, dbPath); got != dst.URL {
		t.Errorf("stored = %q", got)
	}

	// A bundle with no base is a usage error, and nothing changes.
	f2 := newMailFake()
	dbPath2 := sendEnv(t, f2)
	empty := dir + "/empty.json"
	if err := writeFile(empty, `{}`); err != nil {
		t.Fatal(err)
	}
	before := storedBase(t, dbPath2)
	_, errOut, code := runCmd(t, runRepoint, dbPath2, "repoint", "--base", "file://"+empty)
	if code != 2 || !strings.Contains(errOut, "names no base") {
		t.Errorf("empty bundle: code=%d err=%q", code, errOut)
	}
	if storedBase(t, dbPath2) != before {
		t.Error("base moved on a refused bundle")
	}
}

func TestRepoint_BareFormAsksTheResolverWithTheStoredAddress(t *testing.T) {
	// The bare form is login's question asked TODAY: autodiscover from the
	// stored address. The resolver is injected — the first version of this
	// test ran the real ladder against the seed's fake domain and did DNS in a
	// unit test, the exact machine-dependence the local port documented.
	f := newMailFake()
	dbPath := sendEnv(t, f)
	dst := otherServer(t, 200, `{"a_you":{"name":"You"}}`)
	finder := &fakeFinder{result: discover.Result{Domain: "stub.test", Via: "fallback", Base: dst.URL}}

	run := func(s *bmio.Streams, argv []string) int {
		return runRepointWith(s, argv, discoverDeps{resolver: finder})
	}
	_, errOut, code := runCmd(t, run, dbPath, "repoint")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	if finder.asked == "" || !strings.Contains(finder.asked, "@") {
		t.Errorf("resolver asked with %q, want the stored address", finder.asked)
	}
	if !strings.Contains(errOut, "discovered "+dst.URL) {
		t.Errorf("the discovery must be said out loud: %q", errOut)
	}
	if got := storedBase(t, dbPath); got != dst.URL {
		t.Errorf("stored = %q", got)
	}
}
