package cmd

// The @local ladder port (s08 T6). These drive a REAL http server rather than a
// live model host, so they are deterministic — the machine running them need
// not have Ollama, and a developer's own LiteLLM cannot make them pass.
//
// The properties are the ones the TypeScript's behaviour actually turns on, and
// each is one I got wrong in the first draft and only caught by diffing against
// Node:
//
//   - the emitted line is `id.padEnd(40) + " " + name + "  " + base`, and the
//     order is the SOURCE order — I sorted, which looked tidier and was wrong;
//   - only up-and-unkeyed hosts contribute models;
//   - a dead host in the SWEEP is a quiet skip, but a dead host named by
//     --host is an error, because you asked about that one;
//   - the summary is ONE stderr line however long the ladder gets.

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

func modelsServer(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestNormalizeHostBase(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"http://localhost:4000", "http://localhost:4000"},
		{"http://localhost:4000/", "http://localhost:4000"},
		{"http://localhost:4000///", "http://localhost:4000"},
		{"  https://h.test/v1  ", "https://h.test"},
		{"https://h.test/v1/", "https://h.test"},
	} {
		got, err := normalizeHostBase(tc.in)
		if err != nil {
			t.Fatalf("normalizeHostBase(%q): %v", tc.in, err)
		}
		if got != tc.want {
			t.Errorf("normalizeHostBase(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	// A bare host is refused rather than guessed at: assuming http:// would
	// silently send a key over cleartext for someone who meant https.
	if _, err := normalizeHostBase("localhost:4000"); err == nil {
		t.Error("a scheme-less host must be refused, not assumed")
	}
}

func TestProbeHostClassifiesTheAnswer(t *testing.T) {
	ctx := context.Background()
	client := &http.Client{}
	to := 2 * time.Second

	t.Run("a model list is up with models", func(t *testing.T) {
		srv := modelsServer(t, 200, `{"data":[{"id":"a"},{"id":"b"}]}`)
		f := probeHost(ctx, client, LadderHost{Name: "x", Base: srv.URL}, "", to)
		if !f.Up || f.AuthRequired {
			t.Fatalf("want up and unkeyed, got %+v", f)
		}
		if strings.Join(f.Models, ",") != "a,b" {
			t.Errorf("models = %v, want source order [a b]", f.Models)
		}
	})

	t.Run("401 and 403 are UP, not down", func(t *testing.T) {
		// The distinction the ladder turns on: something IS running here, so
		// `local setup` must not offer to install a rival runtime beside it.
		for _, code := range []int{401, 403} {
			srv := modelsServer(t, code, `{}`)
			f := probeHost(ctx, client, LadderHost{Name: "x", Base: srv.URL}, "", to)
			if !f.Up || !f.AuthRequired {
				t.Errorf("HTTP %d: want up+authRequired, got %+v", code, f)
			}
		}
	})

	t.Run("a non-OpenAI answer is down, with the reason", func(t *testing.T) {
		srv := modelsServer(t, 500, `nope`)
		f := probeHost(ctx, client, LadderHost{Name: "x", Base: srv.URL}, "", to)
		if f.Up {
			t.Error("HTTP 500 must not count as up")
		}
		if !strings.Contains(f.Detail, "HTTP 500") {
			t.Errorf("detail should name the status, got %q", f.Detail)
		}
	})

	t.Run("a dead host is a FINDING, never an error", func(t *testing.T) {
		// The whole reason probeHost has no error return: the ladder sweeps
		// four ports and most machines answer on none of them.
		f := probeHost(ctx, client, LadderHost{Name: "x", Base: "http://127.0.0.1:1"}, "", 300*time.Millisecond)
		if f.Up || f.Detail == "" {
			t.Errorf("want a down finding carrying a reason, got %+v", f)
		}
	})

	t.Run("the key rides in a header, and only when present", func(t *testing.T) {
		var seen string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			seen = r.Header.Get("Authorization")
			_, _ = w.Write([]byte(`{"data":[]}`))
		}))
		t.Cleanup(srv.Close)
		probeHost(ctx, client, LadderHost{Name: "x", Base: srv.URL}, "", to)
		if seen != "" {
			t.Errorf("no key should mean no Authorization header, got %q", seen)
		}
		probeHost(ctx, client, LadderHost{Name: "x", Base: srv.URL}, "sk-test", to)
		if seen != "Bearer sk-test" {
			t.Errorf("Authorization = %q, want Bearer sk-test", seen)
		}
	})
}

func TestProbeLadderPreservesOrder(t *testing.T) {
	// The probes run concurrently, but the RESULT order must be the ladder's,
	// because decideSetup reads it as preference. A map or a completion-ordered
	// append would pass a "did we probe everything" test and silently make the
	// first-host-wins rule depend on which port answered fastest.
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(120 * time.Millisecond)
		_, _ = w.Write([]byte(`{"data":[{"id":"slow"}]}`))
	}))
	t.Cleanup(slow.Close)
	fast := modelsServer(t, 200, `{"data":[{"id":"fast"}]}`)

	got := probeLadder(context.Background(), &http.Client{},
		[]LadderHost{{Name: "slow", Base: slow.URL}, {Name: "fast", Base: fast.URL}},
		nil, 2*time.Second)

	if len(got) != 2 || got[0].Name != "slow" || got[1].Name != "fast" {
		t.Fatalf("order not preserved: %+v", got)
	}
}

func TestDecideSetup(t *testing.T) {
	open := HostFinding{Name: "ollama", Up: true}
	keyed := HostFinding{Name: "litellm", Up: true, AuthRequired: true}
	down := HostFinding{Name: "vllm"}

	t.Run("the FIRST open host wins — probe order is preference order", func(t *testing.T) {
		second := HostFinding{Name: "vllm", Up: true}
		d := decideSetup([]HostFinding{down, open, second})
		if d.Kind != "connect" || d.Finding.Name != "ollama" {
			t.Fatalf("want connect to ollama, got %+v", d)
		}
	})

	t.Run("an open host beats a keyed one wherever it sits", func(t *testing.T) {
		d := decideSetup([]HostFinding{keyed, open})
		if d.Kind != "connect" {
			t.Fatalf("an answering host must beat one demanding a key, got %+v", d)
		}
	})

	t.Run("a keyed host still blocks the install offer", func(t *testing.T) {
		// "Something is running here" is enough. Installing a second runtime
		// beside it is the outcome the ladder exists to avoid.
		d := decideSetup([]HostFinding{down, keyed})
		if d.Kind != "needs-key" {
			t.Fatalf("want needs-key, got %+v", d)
		}
	})

	t.Run("only a SILENT sweep reaches the offer", func(t *testing.T) {
		d := decideSetup([]HostFinding{down, down})
		if d.Kind != "offer-install" {
			t.Fatalf("want offer-install, got %+v", d)
		}
	})
}

func TestInstallPlanIsPerPlatform(t *testing.T) {
	// The plan is printed VERBATIM before consent is asked for, so it is part
	// of the consent: agreeing to "install Ollama" is not agreeing to whatever
	// a script decides that means on this OS.
	for _, tc := range []struct{ platform, wantFirst string }{
		{"darwin", "brew"},
		{"windows", "winget"},
		{"linux", "sh"},
		{"freebsd", "sh"}, // the fallback is the official installer, not a refusal
	} {
		p := installPlan(tc.platform)
		if len(p.Steps) == 0 || p.Steps[0].Argv[0] != tc.wantFirst {
			t.Errorf("installPlan(%q) first step = %v, want %s", tc.platform, p.Steps, tc.wantFirst)
		}
		if p.Starter != StarterModel || p.Base != "http://localhost:11434" {
			t.Errorf("installPlan(%q) starter/base drifted: %+v", tc.platform, p)
		}
		for _, st := range p.Steps {
			if st.Why == "" {
				t.Errorf("installPlan(%q): a step with no reason cannot be consented to: %v", tc.platform, st.Argv)
			}
		}
	}
}

func TestSetupDoesNotOfferWhenSomethingIsRunning(t *testing.T) {
	// The rule the ladder exists for: never install a second runtime beside a
	// working one. Both an OPEN host and a KEYED host must reach the offer
	// zero times — a keyed host is still "something is running here".
	//
	// `exec` and `confirm` fail the test if reached at all, which is stronger
	// than asserting on output: it proves the install path was not merely
	// declined but never entered.
	for _, tc := range []struct {
		name     string
		status   int
		body     string
		wantExit int
	}{
		{"an open host connects", 200, `{"data":[{"id":"m"}]}`, 0},
		{"a keyed host refuses, and does not install", 401, `{}`, 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := modelsServer(t, tc.status, tc.body)
			dbPath := filepath.Join(t.TempDir(), "mail.db")
			db, err := store.Init(dbPath)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = db.Close() })
			var out, errOut bytes.Buffer
			s := bmio.NewTo(&out, &errOut)

			deps := setupDeps{
				exec: func(argv []string) int {
					t.Fatalf("exec must not be reached when a host is running: %v", argv)
					return 1
				},
				confirm: func(string) bool {
					t.Fatal("consent must not be ASKED when a host is running")
					return false
				},
				platform: "linux",
				// Empty, not nil: the sweep must see ONLY the saved host below.
				ladder: []LadderHost{},
			}
			// Point the saved-host rung at the test server so the sweep finds it
			// without depending on the developer's own machine.
			if err := saveHost(db, srv.URL, ""); err != nil {
				t.Fatal(err)
			}
			if got := localSetup(s, db, args{}, deps); got != tc.wantExit {
				t.Errorf("exit = %d, want %d", got, tc.wantExit)
			}
		})
	}
}
