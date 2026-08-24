package cmd

import (
	"errors"
	"os"
	"strings"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/cloud"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// Connecting the admin plane WITHOUT retyping it.
//
// The provision worker is reachable at exactly one address —
// `https://bullmoose-provision.<subdomain>.workers.dev` — and the subdomain is
// account-visible fact the Cloudflare API will state on request. So a URL a
// human types is a URL a human can mistype, for no benefit: the installer
// already derives this one, and until now handed it back as text to copy.
//
// The copied TOKEN was the worse half. `cloud install` MINTS the admin token
// and printed it for the operator to paste back — a freshly made secret taking
// a trip through scrollback, shell history and (often) a paste buffer. What
// you minted, you can write down.

// provisionWorker is the script name the installer deploys; the URL is
// entirely determined by it plus the account's workers.dev subdomain.
const provisionWorker = "bullmoose-provision"

// provisionURLFor asks Cloudflare for the account's workers.dev subdomain and
// composes the provision URL. It is the same lookup `cloud install` does for
// its receipt — one derivation, used by both, so the two can never disagree
// about where the admin plane lives.
func provisionURLFor(accountID string) (string, error) {
	cf := cloud.NewCF(os.Getenv("CLOUDFLARE_API_BASE_URL"), os.Getenv("CLOUDFLARE_API_TOKEN"), nil)
	sub, err := cf.WorkersSubdomain(accountID)
	if err != nil {
		return "", err
	}
	if sub == "" {
		// Not an error to paper over: the admin plane is workers.dev-only by
		// design, and an account with no subdomain has nowhere to host it.
		return "", errors.New("this account has no workers.dev subdomain — claim one in the Cloudflare dashboard (Workers → your subdomain)")
	}
	return "https://" + provisionWorker + "." + sub + ".workers.dev", nil
}

// connectAdminPlane writes the pair `admin init` would have written. Used by
// the installer's offer, so a receipt can say "nothing to copy" truthfully.
//
// ⚠️ It writes to the DEVICE MIRROR, which is a real file in a real home
// directory. A test that lets this reach the default path rewrites the
// developer's own admin config with fixture values — which happened once,
// during this change, and is why `cloudInstallDB` exists and why the tests
// point BULLMOOSE_DB at a temp dir.
func connectAdminPlane(dbPath, adminURL, token string) error {
	// Init, not Open: `cloud install` may be the FIRST bullmoose command a
	// machine ever runs, so the mirror and its config table may not exist
	// yet. Open would fail on the missing table and the offer would look
	// broken when the truth is "nothing here yet".
	db, err := store.Init(dbPath)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	if err := store.SetConfig(db, "adminUrl", strings.TrimRight(adminURL, "/")); err != nil {
		return err
	}
	return store.SetConfig(db, "adminToken", token)
}
