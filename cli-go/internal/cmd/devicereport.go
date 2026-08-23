package cmd

// The s37 T1b reporter — the write half of "the machine you run it on,
// visible from the app". `local setup`/`connect` file what the ladder found;
// the daemon files its capability vector on start. The server half
// (DeviceReport/set, T1a) binds the row to the authenticated token, so this
// side sends no identity at all — being the caller IS the identity.
//
// BEST-EFFORT BY DESIGN, three ways:
//
//   - not logged in → nothing to tell, silent skip. `local` deliberately
//     works sessionless, and a report is a courtesy to settings, not a
//     precondition of connecting.
//   - an older server answers unknownMethod → a shrug, not an error (the
//     DefaultCase rule: feature-detect by calling).
//   - any other failure → also silent. A reporter must never fail the
//     command it rides on — the same rule the dossier's floor enrichment
//     follows. The settings surface renders absence honestly ("never
//     reported"), which is the correct outcome of a lost report.

import (
	"context"
	"database/sql"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// reportDevice files the self-description and tells nobody how it went.
func reportDevice(db *sql.DB, report map[string]any) {
	settings, err := store.RequireSettings(db)
	if err != nil || settings.Base == "" || settings.Token == "" {
		return // not logged in — nobody to tell
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	client := jmap.NewSessionClient(settings.Base, settings.Token)
	_, _ = client.One(ctx, "DeviceReport/set", map[string]any{
		"accountId": settings.AccountID,
		"update":    map[string]any{"self": report},
	}, jmap.MailUsing)
}

// localReport is the shape the ladder files: the host it saved and the models
// that host listed, as bare ids — the /v1/models sweep cannot tell a chat
// model from an embedding model, and claiming a kind it does not know would
// be the wrong-label failure s37 decision 4 exists to avoid. A reporter that
// learns kinds later may send {id, kind} entries; the server already accepts
// both spellings.
func localReport(host string, models []string) map[string]any {
	report := map[string]any{"source": "local", "host": host}
	if len(models) > 0 {
		report["models"] = models
	}
	return report
}
