package markdown

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, dir, name string, n int) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, make([]byte, n), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// noShare fails the test if reached: most cases must never upload anything,
// and asserting that by NOT REACHING the uploader is stronger than checking a
// count afterwards.
func noShare(t *testing.T) ShareFn {
	return func(name, _ string, _ []byte) (string, error) {
		t.Fatalf("share must not be called for %q", name)
		return "", nil
	}
}

func TestSmallImageBecomesCID(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "cat.png", 10)

	got, err := ProcessAssets("![c](./cat.png)", `<p><img src="./cat.png" alt="c" /></p>`, dir, 1024, noShare(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Inline) != 1 || got.Inline[0].Type != "image/png" {
		t.Fatalf("inline = %+v", got.Inline)
	}
	// cid:, never data: — Gmail and Outlook strip data URLs, so an image
	// inlined that way silently disappears for most recipients.
	if !strings.Contains(got.HTML, "src=\"cid:") || strings.Contains(got.HTML, "data:") {
		t.Errorf("html = %q", got.HTML)
	}
	if strings.Contains(got.HTML, "./cat.png") {
		t.Errorf("the local path survived into the message: %q", got.HTML)
	}
}

func TestLargeImageIsSharedAndRewrittenInBOTHBodies(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "big.png", 4096)

	got, err := ProcessAssets("![b](./big.png)", `<p><img src="./big.png" /></p>`, dir, 1024,
		func(name, mt string, c []byte) (string, error) { return "https://x.test/s/1", nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Inline) != 0 || len(got.Linked) != 1 {
		t.Fatalf("inline=%d linked=%d, want 0 and 1", len(got.Inline), len(got.Linked))
	}
	if !strings.Contains(got.HTML, "https://x.test/s/1") {
		t.Errorf("html not rewritten: %q", got.HTML)
	}
	// The TEXT part too. A plain-text reader must not be left holding a path
	// that only means something on the sender's machine.
	if !strings.Contains(got.Text, "https://x.test/s/1") || strings.Contains(got.Text, "./big.png") {
		t.Errorf("text not rewritten: %q", got.Text)
	}
}

func TestSmallLinkBecomesAnAttachmentAndTheAnchorIsAnnotated(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "notes.pdf", 10)

	got, err := ProcessAssets("[the notes](./notes.pdf)",
		`<p><a href="./notes.pdf">the notes</a></p>`, dir, 1024, noShare(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Attachments) != 1 || got.Attachments[0].Type != "application/pdf" {
		t.Fatalf("attachments = %+v", got.Attachments)
	}
	// Mail cannot hyperlink to a part of itself. Leaving the href would ship a
	// link into the SENDER'S filesystem — dead for the recipient, and on a bad
	// day pointing at something real on theirs.
	if strings.Contains(got.HTML, `href="./notes.pdf"`) {
		t.Errorf("the anchor still points at the sender's disk: %q", got.HTML)
	}
	if !strings.Contains(got.HTML, "[attached: notes.pdf]") || !strings.Contains(got.HTML, "the notes") {
		t.Errorf("want the link text kept and annotated: %q", got.HTML)
	}
}

func TestTheSameFileLinkedTwiceIsCarriedOnce(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "notes.pdf", 10)
	html := `<p><a href="./notes.pdf">one</a> and <a href="./notes.pdf">two</a></p>`

	got, err := ProcessAssets("md", html, dir, 1024, noShare(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Attachments) != 1 {
		t.Errorf("attachments = %d, want the file carried once", len(got.Attachments))
	}
	if strings.Count(got.HTML, "[attached: notes.pdf]") != 2 {
		t.Errorf("both anchors should still be annotated: %q", got.HTML)
	}
}

func TestRemoteReferencesArePassedThrough(t *testing.T) {
	// Not ours to load, and reaching for them would turn rendering into an
	// outbound network call from a body someone else may have written.
	dir := t.TempDir()
	html := `<p><img src="https://x.test/a.png" /><a href="mailto:a@b.com">m</a>` +
		`<a href="#anchor">f</a><img src="//cdn.test/b.png" /><img src="cid:already" /></p>`

	got, err := ProcessAssets("md", html, dir, 1024, noShare(t))
	if err != nil {
		t.Fatal(err)
	}
	if got.HTML != html {
		t.Errorf("remote refs were touched:\n want %q\n got  %q", html, got.HTML)
	}
	if len(got.Warnings) != 0 {
		t.Errorf("remote refs must not warn: %v", got.Warnings)
	}
}

func TestAMissingFileWarnsAndStillSends(t *testing.T) {
	// Refusing would let a typo'd image path block a message the human already
	// wrote. Mail is not a build.
	got, err := ProcessAssets("md", `<p><img src="./gone.png" /></p>`, t.TempDir(), 1024, noShare(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Warnings) != 1 || !strings.Contains(got.Warnings[0], "gone.png") {
		t.Fatalf("warnings = %v", got.Warnings)
	}
	if !strings.Contains(got.HTML, "./gone.png") {
		t.Errorf("the reference should be left exactly as written: %q", got.HTML)
	}
}

func TestPercentEncodedNamesResolve(t *testing.T) {
	// The renderer percent-encodes spaces, and `my%20cat.png` is not a file.
	dir := t.TempDir()
	write(t, dir, "my cat.png", 10)

	got, err := ProcessAssets("md", `<p><img src="./my%20cat.png" /></p>`, dir, 1024, noShare(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Inline) != 1 {
		t.Fatalf("inline = %+v, warnings = %v", got.Inline, got.Warnings)
	}
	if got.Inline[0].Name != "my cat.png" {
		t.Errorf("name = %q", got.Inline[0].Name)
	}
}

func TestUnknownExtensionIsOctetStreamNotAGuess(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "thing.xyzzy", 10)
	got, err := ProcessAssets("md", `<p><a href="./thing.xyzzy">t</a></p>`, dir, 1024, noShare(t))
	if err != nil {
		t.Fatal(err)
	}
	// A fixed table, not content sniffing: a mislabelled part is a silent
	// rendering bug, an unknown one is visibly unknown.
	if got.Attachments[0].Type != "application/octet-stream" {
		t.Errorf("type = %q", got.Attachments[0].Type)
	}
}

func TestCIDsAreUnique(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "a.png", 10)
	write(t, dir, "b.png", 10)
	got, err := ProcessAssets("md", `<img src="./a.png" /><img src="./b.png" />`, dir, 1024, noShare(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Inline) != 2 || got.Inline[0].CID == got.Inline[1].CID {
		t.Fatalf("cids must differ: %+v", got.Inline)
	}
}
