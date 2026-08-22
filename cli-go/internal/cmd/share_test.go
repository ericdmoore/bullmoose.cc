package cmd

// `share` — the first s42 port, so these tests document the NEW bar: the REST
// choreography and refusal costs are exact; the rendering is asserted through
// its own documented properties (live first, state word leftmost) rather than
// against Node's bytes.

import (
	"strings"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
)

func TestShare_ListChoreography(t *testing.T) {
	f := newMailFake()
	f.shareListing = `{"accountId":"a_you","shares":[` +
		`{"shareId":"sh_old","name":"old.pdf","live":false,"createdAt":"2026-07-01T00:00:00Z","expiresAt":"2026-07-31T00:00:00Z","revokedAt":"2026-07-02T00:00:00Z"},` +
		`{"shareId":"sh_live","name":"notes.pdf","live":true,"createdAt":"2026-08-01T00:00:00Z","expiresAt":"2026-09-01T00:00:00Z"}]}`
	out, errOut, code := runCmd(t, runShare, sendEnv(t, f), "share", "list")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	// One GET, no JMAP methods at all.
	if len(f.rest) != 1 || f.rest[0].Method != "GET" || !strings.Contains(f.rest[0].Path, "/api/shares/a_you") {
		t.Fatalf("rest = %+v", f.rest)
	}
	if len(f.names()) != 0 {
		t.Fatalf("share list must not touch JMAP, got %v", f.names())
	}
	// The documented rendering properties, not Node's bytes: live first, the
	// state word leftmost, dates as dates.
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if !strings.Contains(lines[0], "live") || !strings.Contains(lines[0], "sh_live") {
		t.Errorf("live links must sort first: %q", lines[0])
	}
	if !strings.Contains(lines[1], "revoked") || !strings.Contains(lines[1], "expires 2026-07-31") {
		t.Errorf("second line = %q", lines[1])
	}
	if !strings.Contains(errOut, "1 live, 1 revoked or expired") {
		t.Errorf("summary = %q", errOut)
	}
}

func TestShare_RevokePrintsTheServersNote(t *testing.T) {
	// The note carries the eventual-consistency fact (KV, ~60s). Swallowing it
	// is how a human concludes a working revoke failed.
	f := newMailFake()
	out, errOut, code := runCmd(t, runShare, sendEnv(t, f), "share", "revoke", "sh_1")
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, errOut)
	}
	if len(f.rest) != 1 || f.rest[0].Method != "POST" || !strings.HasSuffix(f.rest[0].Path, "/sh_1/revoke") {
		t.Fatalf("rest = %+v", f.rest)
	}
	if !strings.Contains(out, "revoked sh_1") {
		t.Errorf("stdout = %q", out)
	}
	if !strings.Contains(errOut, "edges may serve it") {
		t.Errorf("the server's note must be shown verbatim: %q", errOut)
	}
}

func TestShare_RefusalsCostZeroRequests(t *testing.T) {
	for _, extra := range [][]string{
		{},          // no subcommand
		{"destroy"}, // unknown subcommand
		{"revoke"},  // revoke with no id
	} {
		f := newMailFake()
		_, _, code := runCmd(t, runShare, sendEnv(t, f), "share", extra...)
		if code != 2 {
			t.Errorf("%v: code = %d, want 2", extra, code)
		}
		if len(f.rest) != 0 || len(f.names()) != 0 {
			t.Errorf("%v: refusal must cost zero requests (rest=%v jmap=%v)", extra, f.rest, f.names())
		}
	}
}

func TestShare_DryRunRevokesNothing(t *testing.T) {
	f := newMailFake()
	_, errOut, code := runCmd(t, runShare, sendEnv(t, f), "share", "revoke", "sh_1", "--dry-run")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if len(f.rest) != 0 {
		t.Fatalf("dry run must not POST, got %+v", f.rest)
	}
	if !strings.Contains(errOut, "the link still resolves") {
		t.Errorf("stderr = %q", errOut)
	}
}

func TestRenderShares_TheDocumentedSort(t *testing.T) {
	// Live before dead; within a rank, newest created first.
	got := renderShares([]jmap.ShareEntry{
		{ShareID: "a", Name: "a", Live: false, CreatedAt: "2026-08-10T00:00:00Z", ExpiresAt: "2026-09-01T00:00:00Z"},
		{ShareID: "b", Name: "b", Live: true, CreatedAt: "2026-08-01T00:00:00Z", ExpiresAt: "2026-09-01T00:00:00Z"},
		{ShareID: "c", Name: "c", Live: true, CreatedAt: "2026-08-05T00:00:00Z", ExpiresAt: "2026-09-01T00:00:00Z"},
	})
	lines := strings.Split(got, "\n")
	order := []string{"c", "b", "a"}
	for i, id := range order {
		if !strings.Contains(lines[i], "  "+id+"  ") {
			t.Errorf("line %d = %q, want share %q", i, lines[i], id)
		}
	}
	if renderShares(nil) != "  (no share links)" {
		t.Errorf("empty = %q", renderShares(nil))
	}
	// The s42 divergence: a malformed timestamp renders as itself, not as its
	// first ten bytes.
	m := renderShares([]jmap.ShareEntry{{ShareID: "x", Name: "x", Live: true, CreatedAt: "1", ExpiresAt: "not-a-date"}})
	if !strings.Contains(m, "expires not-a-date") {
		t.Errorf("malformed date should render as itself: %q", m)
	}
}
