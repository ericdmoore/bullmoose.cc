package cmd

// `bullmoose local` and `bullmoose models` (s08 T6), a port of
// packages/cli/src/local.ts — the @local onboarding ladder and the model sweep.
//
// Ported together because they are the same probe wearing two hats: `models`
// REPORTS what each host serves, `local setup` DECIDES what to do about it.
// Splitting them across two binaries would have meant two implementations of
// the ladder, and the ladder's ORDER is the product decision (probe order is
// preference order), not an implementation detail.
//
// ## What is native here, and what deliberately is not
//
// The probe, the decision table and the install PLAN are native. The managed
// install itself — running brew/winget/the official installer, pulling a
// starter model — is not: it is the one path that mutates the machine, it is
// consent-gated in the TypeScript, and a port that got the consent prompt
// subtly wrong would install software nobody agreed to. `local setup` without
// a host answering therefore still delegates, and registry.go leaves that
// invocation's flags out of the owned set so it delegates WHOLE.
//
// Everything up to the offer is native, which is every invocation on a machine
// that already runs a model host — the common case, and the one `models` and
// s37's device report need.
//
// ## Why a dead host is a finding, not an error
//
// The ladder sweeps four ports and most machines answer on none of them. If a
// closed port were an error the common case would be four errors and a
// non-zero exit, so `probeHost` never returns one: it returns a finding with
// `up: false` and the reason in `detail`. `models --host` is the exception the
// TypeScript makes and this keeps — you named ONE host, so its silence is a
// failure rather than a fact about the fleet.

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// LadderHost is one rung: a human label and an ORIGIN. `/v1/models` is
// appended at probe time rather than stored, so a saved host and a ladder host
// are the same shape.
type LadderHost struct {
	Name string
	Base string
}

// Ladder is the rung-1 sweep, in the order the plan fixes. The order is the
// preference order — `decideSetup` takes the FIRST host that answers — so this
// slice is a product decision and not a lookup table.
var Ladder = []LadderHost{
	{Name: "litellm", Base: "http://localhost:4000"},
	{Name: "ollama", Base: "http://localhost:11434"},
	{Name: "vllm", Base: "http://localhost:8000"},
	{Name: "llama.cpp", Base: "http://localhost:8080"},
}

// StarterModel is the managed install's pull: small enough to be "a coffee's
// worth of download", capable enough to be worth having.
const StarterModel = "llama3.2:3b"

// Config keys in the CLI's sqlite config table (the admin.ts setConfig pattern).
const (
	LocalHostKey    = "localHost"
	LocalHostKeyEnv = "localHostKeyEnv"
)

// HostFinding is what a probe learned. `Up` and `AuthRequired` are separate
// because they answer different questions: something is listening, versus it
// will talk to us. A keyed host is UP — the ladder must not install a second
// runtime beside one that is already running.
type HostFinding struct {
	Name         string   `json:"name"`
	Base         string   `json:"base"`
	Up           bool     `json:"up"`
	AuthRequired bool     `json:"authRequired"`
	Models       []string `json:"models"`
	Detail       string   `json:"detail,omitempty"`
}

// normalizeHostBase is local.ts:66. Trailing slashes go, `http(s)://` is
// required, and a trailing `/v1` is stripped because people paste the API base
// rather than the origin — and `<base>/v1/models` would then ask for
// `/v1/v1/models` and 404 in a way that reads as "the host is broken".
func normalizeHostBase(raw string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if !strings.HasPrefix(trimmed, "http://") && !strings.HasPrefix(trimmed, "https://") {
		return "", fmt.Errorf("--host must be an http(s) URL, got: %s", raw)
	}
	return strings.TrimSuffix(trimmed, "/v1"), nil
}

// probeHost GETs `<base>/v1/models` and classifies the answer. It NEVER
// returns an error: a dead host is a finding.
func probeHost(ctx context.Context, client *http.Client, host LadderHost, apiKey string, timeout time.Duration) HostFinding {
	f := HostFinding{Name: host.Name, Base: host.Base, Models: []string{}}

	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, host.Base+"/v1/models", nil)
	if err != nil {
		f.Detail = err.Error()
		return f
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	res, err := client.Do(req)
	if err != nil {
		f.Detail = err.Error()
		return f
	}
	defer res.Body.Close()

	// Up-but-keyed. Listening, and it will not talk to us without a key —
	// which is enough to stop the ladder offering to install a rival runtime.
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		f.Up = true
		f.AuthRequired = true
		return f
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		f.Detail = fmt.Sprintf("HTTP %d — not an OpenAI-compatible /v1/models", res.StatusCode)
		return f
	}

	var body struct {
		Data []struct {
			ID any `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		f.Detail = err.Error()
		return f
	}
	f.Up = true
	for _, m := range body.Data {
		if id, ok := m.ID.(string); ok && id != "" {
			f.Models = append(f.Models, id)
		}
	}
	return f
}

// probeLadder probes in ORDER and preserves it. The TypeScript runs these
// concurrently and awaits them all; concurrency is fine, but the RESULT order
// must be the ladder's, because `decideSetup` reads it as preference.
func probeLadder(ctx context.Context, client *http.Client, hosts []LadderHost, keyFor func(LadderHost) string, timeout time.Duration) []HostFinding {
	out := make([]HostFinding, len(hosts))
	done := make(chan struct{}, len(hosts))
	for i, h := range hosts {
		go func(i int, h LadderHost) {
			key := ""
			if keyFor != nil {
				key = keyFor(h)
			}
			out[i] = probeHost(ctx, client, h, key, timeout)
			done <- struct{}{}
		}(i, h)
	}
	for range hosts {
		<-done
	}
	return out
}

// SetupDecision is rung 1's verdict.
type SetupDecision struct {
	Kind    string // "connect" | "needs-key" | "offer-install"
	Finding HostFinding
}

// decideSetup is local.ts:117, and the ordering is the whole rule: the FIRST
// host answering with a model list wins, because probe order is preference
// order. A host that answers but wants a key still counts as "something is
// running here" — only a SILENT sweep reaches the offer to install.
func decideSetup(findings []HostFinding) SetupDecision {
	for _, f := range findings {
		if f.Up && !f.AuthRequired {
			return SetupDecision{Kind: "connect", Finding: f}
		}
	}
	for _, f := range findings {
		if f.Up && f.AuthRequired {
			return SetupDecision{Kind: "needs-key", Finding: f}
		}
	}
	return SetupDecision{Kind: "offer-install"}
}

// emitModels is local.ts:200. ONLY hosts that are up and unkeyed contribute
// models — a keyed host is "something is running" for the ladder's purposes
// but serves nothing we can enumerate.
//
// The column widths are the TypeScript's and are load-bearing for the contract
// suite: `id.padEnd(40)`, one space, the host name, TWO spaces, the base.
// Source order, NOT sorted — the ladder is an order.
func emitModels(s *bmio.Streams, findings []HostFinding, jsonOut, idsOut bool) error {
	var up []HostFinding
	for _, f := range findings {
		if f.Up && !f.AuthRequired {
			up = append(up, f)
		}
	}
	if idsOut {
		var ids []string
		for _, f := range up {
			ids = append(ids, f.Models...)
		}
		s.EmitIDs(ids)
		return nil
	}
	if jsonOut {
		rows := []any{}
		for _, f := range up {
			for _, id := range f.Models {
				rows = append(rows, map[string]string{"host": f.Name, "base": f.Base, "id": id})
			}
		}
		return s.EmitNDJSON(rows)
	}
	for _, f := range up {
		for _, id := range f.Models {
			s.Out(fmt.Sprintf("%-40s %s  %s", id, f.Name, f.Base))
		}
	}
	return nil
}

// summarize is local.ts:214 — ONE stderr line for the whole sweep, so the
// commentary cannot be mistaken for records however long the ladder gets.
func summarize(s *bmio.Streams, findings []HostFinding) {
	parts := make([]string, 0, len(findings))
	for _, f := range findings {
		switch {
		case f.Up && f.AuthRequired:
			parts = append(parts, f.Name+" up (needs a key)")
		case f.Up:
			parts = append(parts, fmt.Sprintf("%s up (%d model%s)", f.Name, len(f.Models), plural(len(f.Models))))
		default:
			parts = append(parts, f.Name+" down")
		}
	}
	s.Note(fmt.Sprintf("probed %d host%s: %s", len(findings), plural(len(findings)), strings.Join(parts, ", ")))
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// InstallStep is one command the offer would run, printed VERBATIM before any
// consent is asked for. Printing the plan is not decoration: consent to "install
// Ollama" is not consent to whatever a script decides that means.
type InstallStep struct {
	Argv []string
	Why  string
}

// InstallPlan is local.ts:138. Only ever Ollama — the simplest single binary.
type InstallPlan struct {
	Runtime string
	Steps   []InstallStep
	Starter string
	Base    string
}

func installPlan(platform string) InstallPlan {
	var steps []InstallStep
	switch platform {
	case "darwin":
		steps = []InstallStep{
			{Argv: []string{"brew", "install", "ollama"}, Why: "install the Ollama runtime (Homebrew)"},
			{Argv: []string{"brew", "services", "start", "ollama"}, Why: "start it as a background service"},
		}
	case "windows":
		steps = []InstallStep{
			{Argv: []string{"winget", "install", "-e", "--id", "Ollama.Ollama"}, Why: "install the Ollama runtime (winget)"},
		}
	default:
		steps = []InstallStep{
			{Argv: []string{"sh", "-c", "curl -fsSL https://ollama.com/install.sh | sh"}, Why: "install the Ollama runtime (official installer)"},
		}
	}
	return InstallPlan{Runtime: "ollama", Steps: steps, Starter: StarterModel, Base: "http://localhost:11434"}
}

// setupDeps is everything effectful in `local setup`, injected so the ladder is
// testable end to end without touching the machine — the TypeScript's SetupDeps.
//
// `confirm` MUST default to false. This is the one function in the CLI whose
// bug installs software on someone's computer, so the safe answer is the one
// that happens when anything is unclear: an unreadable stdin, an empty line, a
// closed pipe.
type setupDeps struct {
	exec     func(argv []string) int
	confirm  func(question string) bool
	sleep    func(d time.Duration)
	waitFor  time.Duration
	platform string
	// ladder overrides the default sweep. Production leaves it nil; a test sets
	// it so the sweep cannot reach the DEVELOPER'S OWN machine — which it
	// otherwise does, and did: the first version of the keyed-host test passed
	// locally by connecting to a real Ollama on :11434 instead of exercising
	// the branch it names.
	ladder []LadderHost
}

func saveHost(db *sql.DB, base, keyEnv string) error {
	if err := store.SetConfig(db, LocalHostKey, base); err != nil {
		return err
	}
	return store.SetConfig(db, LocalHostKeyEnv, keyEnv)
}

// resolveKeyEnv turns a NAME into a value, refusing an empty one. The flag
// names a reference; a key that is not there is a mistake worth stopping on
// rather than silently probing unauthenticated.
func resolveKeyEnv(s *bmio.Streams, keyEnv string) (string, bool) {
	if keyEnv == "" {
		return "", true
	}
	v := os.Getenv(keyEnv)
	if v == "" {
		s.Note("--key-env " + keyEnv + ": that environment variable is empty (the flag names a reference, not a key)")
		return "", false
	}
	return v, true
}

// runLocal is `bullmoose local` — local.ts:262 cmdLocal.
func runLocal(s *bmio.Streams, argv []string) int {
	a := parse(argv)
	// at(1), NOT at(0): Positionals[0] is the command name (args.go:236).
	// This read at(0) from the port until s37 T1b's tests became the first
	// thing ever to drive runLocal end-to-end — every direct invocation of
	// `local setup`/`local connect` had fallen to the usage line since the
	// port, invisibly, because the unit tests called the verbs directly and
	// no contract case could run them (they need a live model host).
	verb := a.at(1)

	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		s.Note("bullmoose: " + err.Error())
		return 1
	}
	defer db.Close()

	switch verb {
	case "connect":
		return localConnect(s, db, a)
	case "setup":
		return localSetup(s, db, a, setupDeps{
			exec:     execToStderr(s),
			confirm:  defaultConfirm(s, a.Yes),
			platform: runtime.GOOS,
		})
	default:
		s.Note("usage: bullmoose local setup [--yes] | connect --host <url> [--key-env <NAME>]")
		return 2
	}
}

// localConnect is rung 2: point at ANY OpenAI-compatible endpoint.
func localConnect(s *bmio.Streams, db *sql.DB, a args) int {
	if a.Host == "" {
		s.Note("usage: bullmoose local connect --host <url> [--key-env <NAME>]")
		return 2
	}
	base, err := normalizeHostBase(a.Host)
	if err != nil {
		s.Note("bullmoose: " + err.Error())
		return 2
	}
	key, ok := resolveKeyEnv(s, a.KeyEnv)
	if !ok {
		return 2
	}

	f := probeHost(context.Background(), &http.Client{}, LadderHost{Name: "host", Base: base}, key, 2500*time.Millisecond)
	if f.AuthRequired {
		s.Note(base + " answers but requires a key — pass --key-env <NAME> (an env reference; the key is never stored)")
		return 4
	}
	if !f.Up {
		detail := f.Detail
		if detail == "" {
			detail = "no answer at /v1/models"
		}
		s.Note(base + ": " + detail)
		return 1
	}
	if a.DryRun {
		s.Note(fmt.Sprintf("dry run: would save %s as the @local host (%d models); nothing written", base, len(f.Models)))
		if a.JSON {
			return emitOr(s, s.EmitNDJSON([]any{map[string]any{"dryRun": true, "base": base, "models": len(f.Models)}}))
		}
		return 0
	}
	if err := saveHost(db, base, a.KeyEnv); err != nil {
		s.Note("bullmoose: " + err.Error())
		return 1
	}
	if err := emitModels(s, []HostFinding{f}, a.JSON, a.IDs); err != nil {
		s.Note("bullmoose: " + err.Error())
		return 1
	}
	s.Note(fmt.Sprintf("connected: %s is the @local host (%d models) — saved", base, len(f.Models)))
	reportDevice(db, localReport(base, f.Models)) // s37 T1b, best-effort
	return 0
}

// localSetup is rung 1: probe first, connect if anything answers, and only
// then OFFER. The order is the product decision — nothing installs beside a
// runtime that is already running.
func localSetup(s *bmio.Streams, db *sql.DB, a args, deps setupDeps) int {
	ctx := context.Background()
	client := &http.Client{}
	to := 2500 * time.Millisecond

	savedBase := store.GetConfig(db, LocalHostKey)
	savedKeyEnv := store.GetConfig(db, LocalHostKeyEnv)

	hosts := []LadderHost{}
	if savedBase != "" {
		hosts = append(hosts, LadderHost{Name: "@local (saved)", Base: savedBase})
	}
	rungs := deps.ladder
	if rungs == nil {
		rungs = Ladder
	}
	for _, h := range rungs {
		dup := false
		for _, x := range hosts {
			if x.Base == h.Base {
				dup = true
				break
			}
		}
		if !dup {
			hosts = append(hosts, h)
		}
	}

	s.Note("probing for a local model host (LiteLLM :4000 → Ollama :11434 → vLLM :8000 → llama.cpp :8080)…")
	findings := probeLadder(ctx, client, hosts, func(h LadderHost) string {
		if savedBase != "" && h.Base == savedBase {
			return os.Getenv(savedKeyEnv)
		}
		return ""
	}, to)
	summarize(s, findings)

	switch d := decideSetup(findings); d.Kind {
	case "connect":
		f := d.Finding
		keyEnv := ""
		if savedBase != "" && f.Base == savedBase {
			keyEnv = savedKeyEnv
		}
		if err := saveHost(db, f.Base, keyEnv); err != nil {
			s.Note("bullmoose: " + err.Error())
			return 1
		}
		if err := emitModels(s, []HostFinding{f}, a.JSON, a.IDs); err != nil {
			s.Note("bullmoose: " + err.Error())
			return 1
		}
		s.Note(fmt.Sprintf("connected: %s at %s (%d models) — saved as the @local host. Nothing to install.",
			f.Name, f.Base, len(f.Models)))
		reportDevice(db, localReport(f.Base, f.Models)) // s37 T1b, best-effort
		return 0

	case "needs-key":
		f := d.Finding
		s.Note(fmt.Sprintf("%s is running at %s but wants a key — not installing a second runtime beside it.", f.Name, f.Base))
		s.Note("Connect it instead:  bullmoose local connect --host " + f.Base + " --key-env <NAME>")
		return 4
	}

	// Nothing answered → the OFFER. Print exactly what would run, THEN ask.
	plan := installPlan(deps.platform)
	s.Note("")
	s.Note("No local model host found. I can install Ollama — one program, and a")
	s.Note(fmt.Sprintf("starter model (%s, ~a coffee's worth of download). It would run:", plan.Starter))
	s.Note("")
	for _, st := range plan.Steps {
		s.Note("  $ " + strings.Join(st.Argv, " ") + "    # " + st.Why)
	}
	s.Note("  $ ollama pull " + plan.Starter + "    # fetch the starter model")
	s.Note("")

	if !deps.confirm("proceed with the install? [y/N] ") {
		s.Note("nothing installed. The cloud staff keeps working without @local;")
		s.Note("re-run `bullmoose local setup` any time, or `--yes` to pre-approve.")
		return 0
	}

	for _, st := range plan.Steps {
		s.Note("running: " + strings.Join(st.Argv, " "))
		if code := deps.exec(st.Argv); code != 0 {
			s.Note(fmt.Sprintf("%q exited %d — install incomplete, nothing connected", strings.Join(st.Argv, " "), code))
			return 1
		}
	}

	sleep := deps.sleep
	if sleep == nil {
		sleep = time.Sleep
	}
	wait := deps.waitFor
	if wait == 0 {
		wait = 120 * time.Second
	}
	deadline := time.Now().Add(wait)
	ready := probeHost(ctx, client, LadderHost{Name: plan.Runtime, Base: plan.Base}, "", to)
	for !ready.Up && time.Now().Before(deadline) {
		sleep(2 * time.Second)
		ready = probeHost(ctx, client, LadderHost{Name: plan.Runtime, Base: plan.Base}, "", to)
	}
	if !ready.Up {
		s.Note(fmt.Sprintf("%s installed but %s never answered — start it, then: bullmoose local connect --host %s",
			plan.Runtime, plan.Base, plan.Base))
		return 1
	}

	s.Note("pulling starter model " + plan.Starter + "…")
	if code := deps.exec([]string{"ollama", "pull", plan.Starter}); code != 0 {
		s.Note(fmt.Sprintf("%q exited %d", "ollama pull "+plan.Starter, code))
		return 1
	}

	f := probeHost(ctx, client, LadderHost{Name: plan.Runtime, Base: plan.Base}, "", to)
	if err := saveHost(db, plan.Base, ""); err != nil {
		s.Note("bullmoose: " + err.Error())
		return 1
	}
	if err := emitModels(s, []HostFinding{f}, a.JSON, a.IDs); err != nil {
		s.Note("bullmoose: " + err.Error())
		return 1
	}
	s.Note(fmt.Sprintf("connected: %s at %s (%d models) — saved as the @local host",
		plan.Runtime, plan.Base, len(f.Models)))
	reportDevice(db, localReport(plan.Base, f.Models)) // s37 T1b, best-effort
	return 0
}

func emitOr(s *bmio.Streams, err error) int {
	if err != nil {
		s.Note("bullmoose: " + err.Error())
		return 1
	}
	return 0
}

// execToStderr runs one command with its chrome on stderr, so an install's
// output cannot be mistaken for records on stdout.
func execToStderr(s *bmio.Streams) func([]string) int {
	return func(argv []string) int {
		if len(argv) == 0 {
			return 1
		}
		c := exec.Command(argv[0], argv[1:]...)
		c.Stdout = os.Stderr
		c.Stderr = os.Stderr
		if err := c.Run(); err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				return ee.ExitCode()
			}
			return 1
		}
		return 0
	}
}

// defaultConfirm is the consent gate, and it FAILS CLOSED.
//
// --yes is consent given ahead of time and is honoured. Otherwise the answer
// must be an explicit y/yes: an empty line, EOF, a closed stdin or anything
// else is NO. This is the one prompt in the CLI whose wrong answer installs
// software, so silence must never read as agreement.
func defaultConfirm(s *bmio.Streams, yes bool) func(string) bool {
	return func(question string) bool {
		if yes {
			return true
		}
		s.NoteRaw(question)
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && line == "" {
			return false
		}
		switch strings.ToLower(strings.TrimSpace(line)) {
		case "y", "yes":
			return true
		default:
			return false
		}
	}
}

// runModels is `bullmoose models` — local.ts:227 cmdModels.
func runModels(s *bmio.Streams, argv []string) int {
	a := parse(argv)

	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		s.Note("bullmoose: " + err.Error())
		return 1
	}
	defer db.Close()
	savedBase := store.GetConfig(db, LocalHostKey)
	savedKeyEnv := store.GetConfig(db, LocalHostKeyEnv)

	client := &http.Client{}
	ctx := context.Background()
	timeout := 2500 * time.Millisecond

	// Explicit host: you asked about THIS one, so a dead host is an answer you
	// need to hear — an error, unlike the ladder's quiet skips.
	if a.Host != "" {
		base, err := normalizeHostBase(a.Host)
		if err != nil {
			s.Note("bullmoose: " + err.Error())
			return 2
		}
		keyEnv := a.KeyEnv
		if keyEnv == "" && savedBase == base {
			keyEnv = savedKeyEnv
		}
		f := probeHost(ctx, client, LadderHost{Name: "host", Base: base}, os.Getenv(keyEnv), timeout)
		if f.AuthRequired {
			s.Note(base + " answers but requires a key — retry with --key-env <NAME>")
			return 4
		}
		if !f.Up {
			detail := f.Detail
			if detail == "" {
				detail = "no answer"
			}
			s.Note(base + ": " + detail)
			return 1
		}
		if err := emitModels(s, []HostFinding{f}, a.JSON, a.IDs); err != nil {
			s.Note("bullmoose: " + err.Error())
			return 1
		}
		s.Note(fmt.Sprintf("%s: %d model(s)", base, len(f.Models)))
		return 0
	}

	// The sweep: the SAVED host first — it is the one you actually use — then
	// the ladder's defaults, deduped by base.
	hosts := []LadderHost{}
	if savedBase != "" {
		hosts = append(hosts, LadderHost{Name: "@local (saved)", Base: savedBase})
	}
	for _, h := range Ladder {
		dup := false
		for _, x := range hosts {
			if x.Base == h.Base {
				dup = true
				break
			}
		}
		if !dup {
			hosts = append(hosts, h)
		}
	}

	findings := probeLadder(ctx, client, hosts, func(h LadderHost) string {
		if savedBase != "" && h.Base == savedBase {
			return os.Getenv(savedKeyEnv)
		}
		return ""
	}, timeout)

	if err := emitModels(s, findings, a.JSON, a.IDs); err != nil {
		s.Note("bullmoose: " + err.Error())
		return 1
	}
	summarize(s, findings)
	anyUp := false
	for _, f := range findings {
		if f.Up {
			anyUp = true
			break
		}
	}
	if !anyUp {
		s.Note("no local model host found — `bullmoose local setup` can install one (with your consent)")
	}
	return 0
}
