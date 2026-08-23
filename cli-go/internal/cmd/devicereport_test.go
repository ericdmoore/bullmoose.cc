package cmd

// The s37 T1b reporter. Three properties carry the whole design: the report
// rides a successful connect with what the ladder actually found; an old
// server (unknownMethod) is a shrug, never an error; and a logged-out
// machine files nothing and fails nothing.

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// connectEnv seeds a logged-in mirror pointed at the mailFake, and returns a
// separate models host for --host to probe.
func connectEnv(t *testing.T, f *mailFake) (dbPath string, modelsBase string) {
	t.Helper()
	dbPath = sendEnv(t, f)
	srv := modelsServer(t, 200, `{"data":[{"id":"llama3:8b"},{"id":"nomic-embed-text"}]}`)
	return dbPath, srv.URL
}

func TestLocalConnect_FilesTheReport(t *testing.T) {
	f := newMailFake()
	dbPath, modelsBase := connectEnv(t, f)
	_, errOut, code := runCmd(t, runLocal, dbPath, "local", "connect", "--host", modelsBase)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	// The report rode along: host, the ladder's model ids (embedding models
	// included, as bare ids — the sweep cannot tell kinds), source local.
	raw := f.argsOf("DeviceReport/set")
	if raw == "" {
		t.Fatalf("no DeviceReport/set filed; calls = %v", f.names())
	}
	var set struct {
		AccountID string `json:"accountId"`
		Update    struct {
			Self struct {
				Host   string   `json:"host"`
				Models []string `json:"models"`
				Source string   `json:"source"`
			} `json:"self"`
		} `json:"update"`
	}
	if err := json.Unmarshal([]byte(raw), &set); err != nil {
		t.Fatal(err)
	}
	if set.AccountID != "a_you" || set.Update.Self.Host != modelsBase || set.Update.Self.Source != "local" {
		t.Errorf("report = %+v", set.Update.Self)
	}
	if strings.Join(set.Update.Self.Models, ",") != "llama3:8b,nomic-embed-text" {
		t.Errorf("models = %v — the ladder's list, in source order", set.Update.Self.Models)
	}
}

func TestLocalConnect_OldServerIsAShrug(t *testing.T) {
	// unknownMethod = "server predates s37". The connect must succeed with
	// identical chrome — the report is a courtesy, not a precondition.
	f := newMailFake()
	f.refuseDeviceReport = "unknownMethod"
	dbPath, modelsBase := connectEnv(t, f)
	_, errOut, code := runCmd(t, runLocal, dbPath, "local", "connect", "--host", modelsBase)
	if code != 0 {
		t.Fatalf("an old server failed the connect: %d — %s", code, errOut)
	}
	if !strings.Contains(errOut, "is the @local host") {
		t.Errorf("chrome changed: %q", errOut)
	}
	if strings.Contains(strings.ToLower(errOut), "devicereport") || strings.Contains(errOut, "unknownMethod") {
		t.Errorf("the shrug leaked into the chrome: %q", errOut)
	}
}

func TestReportDevice_LoggedOutFilesNothing(t *testing.T) {
	// `local` deliberately works sessionless; with no settings there is
	// nobody to tell, and reportDevice must be a silent no-op rather than an
	// error a connect would surface.
	dbPath := t.TempDir() + "/mail.db"
	db, err := store.Init(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	reportDevice(db, localReport("http://localhost:11434", []string{"m"})) // must not panic or hang
}

func TestDaemonReport_Shape(t *testing.T) {
	// The resident daemon is a device; --once (the cron/test drain) is not,
	// which is also what keeps every --once choreography table exact. The
	// wire path is covered by the connect test above; this pins the SHAPE:
	// source serve, and the capability vector verbatim from fleet.json.
	withCaps, err := loadFleetConfig(serveConfig(t, fleetJSON))
	if err != nil {
		t.Fatal(err)
	}
	r := daemonReport(withCaps)
	if r["source"] != "serve" {
		t.Errorf("source = %v", r["source"])
	}
	caps, ok := r["capabilities"].(json.RawMessage)
	if !ok || string(caps) != `{"vision":false,"contextTokens":32000,"tools":false}` {
		t.Errorf("capabilities must ride verbatim from fleet.json: %v", r["capabilities"])
	}

	bare := &serveFleetConfig{Bindings: withCaps.Bindings}
	if _, has := daemonReport(bare)["capabilities"]; has {
		t.Error("no declared vector must mean no capabilities key — absence is honest")
	}
}
