package cmd

// `blobs` is a PORTED command (packages/cli/src/blobs.ts cmdBlobs), so every
// expectation below is what the TypeScript prints for the same fixture — down to
// the size formatting, which is where a naive port diverges silently.

import (
	"strings"
	"testing"
)

// The listing fixture. Its key order is deliberately NOT blobId-first, and it
// carries a property the CLI does not model, because `blobs list --json` emits
// `{accountId, ...b}` — the SERVER's object with one key prepended.
const blobFixture = `{"accountId":"a_you","blobs":[` +
	`{"uploaded":"2026-01-01T00:00:00.000Z","size":4096,"blobId":"b_0","refs":2},` +
	`{"uploaded":"2026-02-02T00:00:00.000Z","size":12288,"blobId":"b_2","refs":0},` +
	`{"uploaded":"2026-03-03T00:00:00.000Z","size":8192,"blobId":"b_1","refs":1}` +
	`],"totalSize":24576}`

func blobsEnv(t *testing.T, f *mailFake) string {
	t.Helper()
	if f.blobList == "" {
		f.blobList = blobFixture
	}
	// The two refusals smoke/server.mjs:457 serves, so a test here and the
	// contract suite measure the same server.
	f.blobRefusals["b_0"] = restRefusal{409, `{"type":"blobInUse","error":"blob in use by em_000"}`}
	f.blobRefusals["b_boom"] = restRefusal{500, `{"error":"storage unavailable"}`}
	f.start(t)
	return seedMailMirror(t, f.base, "bm_tok", "")
}

// ---- list --------------------------------------------------------------------

// The human listing: largest first (the storage-bill question), the size
// right-aligned in 9 columns, and the upload DATE only.
func TestBlobs_ListHuman(t *testing.T) {
	f := newMailFake()
	out, errOut, code := runCmd(t, runBlobs, blobsEnv(t, f), "blobs", "list")
	if code != 0 {
		t.Fatalf("code = %d (%s)", code, errOut)
	}
	want := "  b_2      12 KB  2026-02-02\n" +
		"  b_1     8.0 KB  2026-03-03\n" +
		"  b_0     4.0 KB  2026-01-01\n"
	if out != want {
		t.Errorf("stdout =\n%q\nwant\n%q", out, want)
	}
	// The totals are a SUMMARY, and a summary is chrome — stderr, with the
	// leading blank line the TypeScript writes.
	if errOut != "\n  3 object(s), 24 KB total\n" {
		t.Errorf("stderr = %q", errOut)
	}
	if got, want := f.rest[0].Method+" "+f.rest[0].Path, "GET /api/blobs/a_you"; got != want {
		t.Errorf("request = %q, want %q", got, want)
	}
}

// --json streams the collection and preserves the server's key order, with
// accountId FIRST. A map[string]any would sort these and every line would differ.
func TestBlobs_ListJSONPreservesServerKeyOrder(t *testing.T) {
	f := newMailFake()
	out, errOut, code := runCmd(t, runBlobs, blobsEnv(t, f), "blobs", "list", "--json")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	want := `{"accountId":"a_you","uploaded":"2026-02-02T00:00:00.000Z","size":12288,"blobId":"b_2","refs":0}` + "\n" +
		`{"accountId":"a_you","uploaded":"2026-03-03T00:00:00.000Z","size":8192,"blobId":"b_1","refs":1}` + "\n" +
		`{"accountId":"a_you","uploaded":"2026-01-01T00:00:00.000Z","size":4096,"blobId":"b_0","refs":2}` + "\n"
	if out != want {
		t.Errorf("--json =\n%s\nwant\n%s", out, want)
	}
	if errOut != "3 object(s), 24 KB total\n" {
		t.Errorf("stderr = %q — the summary is chrome even under --json", errOut)
	}
}

// --ids is the SERVER's order, not the sorted one (blobs.ts:44 maps the unsorted
// array), and prints nothing else.
func TestBlobs_ListIDs(t *testing.T) {
	f := newMailFake()
	out, errOut, code := runCmd(t, runBlobs, blobsEnv(t, f), "blobs", "list", "--ids", "--json")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if out != "b_0\nb_2\nb_1\n" {
		t.Errorf("--ids = %q, want the listing order", out)
	}
	if errOut != "" {
		t.Errorf("--ids prints bare identifiers and NOTHING else; stderr = %q", errOut)
	}
}

// An empty account says so plainly, and still reports its totals.
func TestBlobs_ListEmpty(t *testing.T) {
	f := newMailFake()
	f.blobList = `{"accountId":"a_you","blobs":[],"totalSize":0}`
	out, errOut, code := runCmd(t, runBlobs, blobsEnv(t, f), "blobs", "list")
	if code != 0 || out != "  (no blobs)\n" {
		t.Errorf("code=%d out=%q", code, out)
	}
	if errOut != "\n  0 object(s), 0 B total\n" {
		t.Errorf("stderr = %q", errOut)
	}
}

// A cursor means the listing is partial, and saying so is the difference between
// "you have 3 objects" and "here are the first 3".
func TestBlobs_ListPaginated(t *testing.T) {
	f := newMailFake()
	f.blobList = `{"accountId":"a_you","blobs":[{"blobId":"b_0","size":10,"uploaded":"2026-01-01T00:00:00.000Z"}],` +
		`"totalSize":10,"cursor":"page2"}`
	_, errOut, _ := runCmd(t, runBlobs, blobsEnv(t, f), "blobs", "list")
	if !strings.HasSuffix(errOut, "  (more — listing is paginated)\n") {
		t.Errorf("stderr = %q", errOut)
	}
	_, errOut, _ = runCmd(t, runBlobs, blobsEnv(t, f), "blobs", "list", "--json")
	if !strings.HasSuffix(errOut, "(more — listing is paginated)\n") {
		t.Errorf("--json stderr = %q", errOut)
	}
}

// ---- rm ----------------------------------------------------------------------

func TestBlobs_Remove(t *testing.T) {
	f := newMailFake()
	out, _, code := runCmd(t, runBlobs, blobsEnv(t, f), "blobs", "rm", "b_1")
	if code != 0 || out != "deleted b_1\n" {
		t.Errorf("code=%d out=%q", code, out)
	}
	if got, want := f.rest[0].Method+" "+f.rest[0].Path, "DELETE /api/blobs/a_you/b_1"; got != want {
		t.Errorf("request = %q, want %q", got, want)
	}
}

// --json re-emits the SERVER's object verbatim (blobs.ts:68 `emitJson(res)`), so
// a field the CLI does not model survives and the key order is the server's.
func TestBlobs_RemoveJSONIsTheServersObject(t *testing.T) {
	f := newMailFake()
	out, _, code := runCmd(t, runBlobs, blobsEnv(t, f), "blobs", "rm", "b_1", "--json")
	if code != 0 || out != `{"blobId":"b_1","deleted":true}`+"\n" {
		t.Errorf("code=%d out=%q", code, out)
	}
}

// Invariant 4: the rehearsal costs ZERO requests.
func TestBlobs_RemoveDryRun(t *testing.T) {
	f := newMailFake()
	out, errOut, code := runCmd(t, runBlobs, blobsEnv(t, f), "blobs", "rm", "b_1", "--dry-run")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if errOut != "dry run: would delete blob b_1; nothing was written\n" {
		t.Errorf("stderr = %q", errOut)
	}
	if out != "" {
		t.Errorf("the rehearsal is chrome: %q", out)
	}
	if len(f.rest) != 0 {
		t.Errorf("a dry run must send NO request; got %v", f.rest)
	}

	out, _, _ = runCmd(t, runBlobs, blobsEnv(t, f), "blobs", "rm", "b_1", "--dry-run", "--json")
	if out != `{"dryRun":true,"blobId":"b_1"}`+"\n" {
		t.Errorf("--json = %q", out)
	}
}

// ---- refusals ----------------------------------------------------------------

func TestBlobs_MissingArgumentsCostNothing(t *testing.T) {
	cases := []struct {
		argv []string
		want string
	}{
		{[]string{"blobs"}, "error: usage: unknown blobs subcommand: (none) (list|rm)\n"},
		{[]string{"blobs", "nope"}, "error: usage: unknown blobs subcommand: nope (list|rm)\n"},
		{[]string{"blobs", "rm"}, "error: usage: bullmoose blobs rm <blobId> [--account <sel>] [--dry-run]\n"},
	}
	for _, c := range cases {
		f := newMailFake()
		out, errOut, code := runCmd(t, runBlobs, blobsEnv(t, f), c.argv[0], c.argv[1:]...)
		if code != 2 {
			t.Errorf("%v → code %d, want 2 (usage)", c.argv, code)
		}
		if errOut != c.want {
			t.Errorf("%v → stderr %q, want %q", c.argv, errOut, c.want)
		}
		if out != "" || len(f.rest) != 0 {
			t.Errorf("%v cost %d request(s); a refusal must cost ZERO", c.argv, len(f.rest))
		}
	}
}

// The §1.5 table over a NON-JMAP endpoint, which is the interesting half: the
// reason word is in no JMAP vocabulary, so the HTTP STATUS has to decide — 409 is
// exit 5, 500 is exit 1, and the server's sentence survives in both.
func TestBlobs_RefusalsMapToExitCodes(t *testing.T) {
	for _, c := range []struct {
		blobID string
		code   int
		reason string
	}{
		{"b_0", 5, "blob in use by em_000"},
		{"b_boom", 1, "storage unavailable"},
	} {
		f := newMailFake()
		out, errOut, code := runCmd(t, runBlobs, blobsEnv(t, f), "blobs", "rm", c.blobID)
		if code != c.code {
			t.Errorf("%s → code %d, want %d", c.blobID, code, c.code)
		}
		if !strings.Contains(errOut, c.reason) {
			t.Errorf("%s → stderr %q, want the server's reason %q", c.blobID, errOut, c.reason)
		}
		if !strings.HasPrefix(errOut, "error: blobs rm failed: HTTP ") {
			t.Errorf("%s → stderr %q, want jmap.ts:270's message shape", c.blobID, errOut)
		}
		if out != "" {
			t.Errorf("%s → stdout %q", c.blobID, out)
		}
	}
}

// A rejected token is exit 4 on a command that actually reaches the server
// (contract.mjs:245) — `mailboxes` reads the mirror and would never notice.
func TestBlobs_RejectedToken(t *testing.T) {
	f := newMailFake()
	f.httpStatus = 401
	_, errOut, code := runCmd(t, runBlobs, blobsEnv(t, f), "blobs", "list")
	if code != 4 {
		t.Errorf("code = %d, want 4 (auth)", code)
	}
	if !strings.Contains(errOut, "HTTP 401") {
		t.Errorf("stderr = %q", errOut)
	}
}

// cli/009 through `blobs`: a single-account command, so an ambiguous selector is
// refused before any request.
func TestBlobs_AmbiguousAccountRefused(t *testing.T) {
	f := newMailFake()
	f.blobList = blobFixture
	f.start(t)
	db := seedMailMirror(t, f.base, "bm_tok",
		`[{"accountId":"a_you","address":"you@stub.test"},{"accountId":"a_work","address":"work@stub.test"}]`)
	out, errOut, code := runCmd(t, runBlobs, db, "blobs", "list", "--account", "stub.test")
	if code != 2 {
		t.Errorf("code = %d, want 2", code)
	}
	if !strings.HasPrefix(errOut, "error: usage: --account \"stub.test\" matches 2 accounts") {
		t.Errorf("stderr = %q", errOut)
	}
	if out != "" || len(f.rest) != 0 {
		t.Errorf("an unresolvable account costs ZERO requests; got %d", len(f.rest))
	}
}

// The account reaches the URL — a selector picks WHOSE blobs are listed.
func TestBlobs_AccountReachesThePath(t *testing.T) {
	f := newMailFake()
	f.blobList = blobFixture
	f.start(t)
	db := seedMailMirror(t, f.base, "bm_tok",
		`[{"accountId":"a_you","address":"you@stub.test"},{"accountId":"a work/2","address":"work@stub.test"}]`)
	if _, errOut, code := runCmd(t, runBlobs, db, "blobs", "list", "--account", "work@stub.test"); code != 0 {
		t.Fatalf("code = %d (%s)", code, errOut)
	}
	// encodeURIComponent, not net/url: the space is %20 and the slash %2F.
	if got, want := f.rest[0].Path, "/api/blobs/a%20work%2F2"; got != want {
		t.Errorf("path = %q, want %q", got, want)
	}
}

// ---- formatSize --------------------------------------------------------------

// blobs.ts:166, including the case Go gets wrong by default: toFixed(1) rounds a
// TIE up (1.25 → "1.3"), where strconv.FormatFloat rounds to even ("1.2").
func TestFormatSize(t *testing.T) {
	for _, c := range []struct {
		bytes float64
		want  string
	}{
		{0, "0 B"},
		{1, "1 B"},
		{1023, "1023 B"},
		{1024, "1.0 KB"},
		{1280, "1.3 KB"}, // the tie: exactly 1.25 KB
		{1536, "1.5 KB"},
		{4096, "4.0 KB"},
		{10240, "10 KB"},
		{24576, "24 KB"},
		{1048576, "1.0 MB"},
		{5_000_000, "4.8 MB"},
		{1073741824, "1.0 GB"},
		{1099511627776, "1.0 TB"},
		{1125899906842624, "1024 TB"}, // capped at TB rather than inventing PB
	} {
		if got := formatSize(c.bytes); got != c.want {
			t.Errorf("formatSize(%v) = %q, want %q", c.bytes, got, c.want)
		}
	}
}

// A listing with no totalSize is `formatSize(undefined)` in JavaScript, which is
// "NaN KB" — a comforting "0 B" would hide a broken server.
func TestBlobs_MissingTotalSize(t *testing.T) {
	f := newMailFake()
	f.blobList = `{"accountId":"a_you","blobs":[{"blobId":"b_0","size":10,"uploaded":"2026-01-01T00:00:00.000Z"}]}`
	_, errOut, code := runCmd(t, runBlobs, blobsEnv(t, f), "blobs", "list")
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(errOut, "NaN KB total") {
		t.Errorf("stderr = %q, want JavaScript's NaN", errOut)
	}
}
