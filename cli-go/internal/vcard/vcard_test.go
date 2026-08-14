package vcard

// The vCard ⇄ JSContact codec, tested the way packages/cli/src/contacts.test.ts
// tests its TypeScript twin — same fixture, same assertions — so a drift between
// the two implementations shows up as a red test on one side rather than as two
// clients that disagree about a user's address book.
//
// The round trip is the load-bearing one: s05 T2's done-when is
// `import → export → import` with no drift, which is the cheapest correctness
// test available for a codec nobody wants to re-derive.

import (
	"strings"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jsobj"
)

const sample = "BEGIN:VCARD\r\n" +
	"VERSION:3.0\r\n" +
	"FN:Ada Lovelace\r\n" +
	"N:Lovelace;Ada;;;\r\n" +
	"NICKNAME:Countess\r\n" +
	"ORG:Analytical Engines;R&D\r\n" +
	"TITLE:Mathematician\r\n" +
	"EMAIL;TYPE=WORK:ada@example.com\r\n" +
	"TEL;TYPE=CELL:+15550100\r\n" +
	"CATEGORIES:pioneers,math\r\n" +
	"UID:urn:uuid:ada-1\r\n" +
	"END:VCARD\r\n"

func first(t *testing.T, text string) *Card {
	t.Helper()
	parsed := ParseVCF(text)
	if len(parsed.Cards) == 0 {
		t.Fatalf("no cards parsed from %q", text)
	}
	return parsed.Cards[0]
}

func TestSerializeEmitsTheMandatoryLines(t *testing.T) {
	card := jsobj.New()
	_ = card.Set("@type", "Card")
	_ = card.Set("uid", "u-1")
	name := jsobj.New()
	_ = name.Set("full", "Grace Hopper")
	_ = card.Set("name", name)

	vcf := Serialize(card)
	if !strings.HasPrefix(vcf, "BEGIN:VCARD\r\n") {
		t.Errorf("missing BEGIN: %q", vcf)
	}
	for _, want := range []string{"VERSION:3.0", "FN:Grace Hopper", "UID:u-1"} {
		if !strings.Contains(vcf, want) {
			t.Errorf("missing %q in %q", want, vcf)
		}
	}
	if !strings.HasSuffix(strings.TrimRight(vcf, "\r\n"), "END:VCARD") {
		t.Errorf("missing END: %q", vcf)
	}
}

func TestSerializeSynthesisesFNFromTheOrganization(t *testing.T) {
	card := jsobj.New()
	_ = card.Set("uid", "u-2")
	orgs := jsobj.New()
	org := jsobj.New()
	_ = org.Set("name", "Bell Labs")
	_ = orgs.Set("o1", org)
	_ = card.Set("organizations", orgs)
	if got := Serialize(card); !strings.Contains(got, "FN:Bell Labs") {
		t.Errorf("want the org as FN, got %q", got)
	}
}

func TestSerializeEscapesTheSeparators(t *testing.T) {
	card := jsobj.New()
	_ = card.Set("uid", "u-3")
	name := jsobj.New()
	_ = name.Set("full", "Doe; John, Jr.")
	_ = card.Set("name", name)
	if got := Serialize(card); !strings.Contains(got, `FN:Doe\; John\, Jr.`) {
		t.Errorf("want the structured separators escaped, got %q", got)
	}
}

// TestRoundTripPreservesIdentifyingContent is s05 T2's done-when.
func TestRoundTripPreservesIdentifyingContent(t *testing.T) {
	second := first(t, Serialize(first(t, sample)))

	if got := second.StrOr("uid", ""); got != "urn:uuid:ada-1" {
		t.Errorf("uid = %q", got)
	}
	if got := second.Obj("name").StrOr("full", ""); got != "Ada Lovelace" {
		t.Errorf("name.full = %q", got)
	}
	if got := firstOf(second, "emails", "address"); got != "ada@example.com" {
		t.Errorf("email = %q", got)
	}
	if got := firstOf(second, "phones", "number"); got != "+15550100" {
		t.Errorf("phone = %q", got)
	}
	if got := firstOf(second, "organizations", "name"); got != "Analytical Engines" {
		t.Errorf("org = %q", got)
	}
	keys := second.Obj("keywords").Keys()
	if len(keys) != 2 || !hasKey(keys, "pioneers") || !hasKey(keys, "math") {
		t.Errorf("keywords = %v, want pioneers + math", keys)
	}
	// The TEL feature survives as a vCard TYPE=CELL, which is the one mapping
	// that is NOT just the feature name upper-cased.
	if got := Serialize(second); !strings.Contains(got, "TEL;TYPE=CELL") {
		t.Errorf("mobile must re-emit as TYPE=CELL: %q", got)
	}
}

// TestRoundTripIsStable — a second export equals the first, which is the
// property that makes `export | import | export` a no-op rather than a slow
// drift.
func TestRoundTripIsStable(t *testing.T) {
	once := Serialize(first(t, sample))
	twice := Serialize(first(t, once))
	if once != twice {
		t.Errorf("export is not idempotent:\n%q\n%q", once, twice)
	}
}

// TestLosslessTail — a property with no JSContact mapping survives in
// `vCardProps` and comes back out verbatim, which is what "lossless" means here.
func TestLosslessTail(t *testing.T) {
	card := first(t, "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:X\r\nUID:u\r\n"+
		"X-CUSTOM;PARAM=1:kept value\r\nEND:VCARD\r\n")
	if !card.Has("vCardProps") {
		t.Fatalf("an unmapped property must be preserved: %v", card.Keys())
	}
	out := Serialize(card)
	if !strings.Contains(out, "X-CUSTOM;PARAM=1:kept value") {
		t.Errorf("the preserved property must be re-emitted verbatim: %q", out)
	}
}

// TestDeterministicUID — a card with no UID gets a content-derived one, so
// re-importing the same file is idempotent (import dedups on uid).
func TestDeterministicUID(t *testing.T) {
	const noUID = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:No Uid\r\nEMAIL:nouid@example.com\r\nEND:VCARD\r\n"
	a := first(t, noUID).StrOr("uid", "")
	b := first(t, noUID).StrOr("uid", "")
	if a == "" || a != b {
		t.Errorf("uid = %q / %q, want a stable derived urn", a, b)
	}
	if !strings.HasPrefix(a, "urn:bullmoose:vcf:") {
		t.Errorf("uid = %q, want the bullmoose urn prefix", a)
	}
	if len(strings.TrimPrefix(a, "urn:bullmoose:vcf:")) != 24 {
		t.Errorf("uid = %q, want 24 hex characters (the TypeScript's slice)", a)
	}
	// A DIFFERENT card must not collide.
	other := first(t, "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Other\r\nEND:VCARD\r\n").StrOr("uid", "")
	if other == a {
		t.Errorf("two different cards derived the same uid: %q", a)
	}
}

// TestKeyOrderIsTheTypeScripts — the card's key order reaches the wire and the
// terminal (`contacts show` prints it indented), so it is part of the contract.
func TestKeyOrderIsTheTypeScripts(t *testing.T) {
	card := first(t, sample)
	got := strings.Join(card.Keys(), ",")
	// Verified against packages/cli/dist/vcard.js on the same fixture: `name` is
	// created by FN (line 3) and `uid` by UID (line 11), so name comes first.
	want := "@type,version,name,uid,emails,phones,nicknames,organizations,titles,keywords"
	if got != want {
		t.Errorf("key order =\n  %s\nwant\n  %s", got, want)
	}
}

func TestAppleLabelGroupsSurvive(t *testing.T) {
	card := first(t, "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:X\r\nUID:u\r\n"+
		"item1.EMAIL:home@example.com\r\nitem1.X-ABLabel:_$!<Home>!$_\r\nEND:VCARD\r\n")
	if got := firstOf(card, "emails", "label"); got != "Home" {
		t.Errorf("label = %q, want the unwrapped Apple form", got)
	}
	out := Serialize(card)
	if !strings.Contains(out, "item1.EMAIL") || !strings.Contains(out, "item1.X-ABLABEL:Home") {
		t.Errorf("the label group must be re-minted: %q", out)
	}
}

func TestQuotedPrintableContinuation(t *testing.T) {
	card := first(t, "BEGIN:VCARD\r\nVERSION:2.1\r\nUID:u\r\n"+
		"FN;ENCODING=QUOTED-PRINTABLE:Andr=\r\n=C3=A9\r\nEND:VCARD\r\n")
	if got := card.Obj("name").StrOr("full", ""); got != "André" {
		t.Errorf("full = %q, want the decoded value", got)
	}
}

func TestFoldingIsByOctet(t *testing.T) {
	card := jsobj.New()
	_ = card.Set("uid", "u")
	name := jsobj.New()
	_ = name.Set("full", strings.Repeat("a", 200))
	_ = card.Set("name", name)
	out := Serialize(card)
	for _, line := range strings.Split(out, "\r\n") {
		if len(line) > 75 {
			t.Errorf("line exceeds 75 octets (%d): %q", len(line), line)
		}
	}
	// Unfolding it must give the original back.
	if got := first(t, out).Obj("name").StrOr("full", ""); got != strings.Repeat("a", 200) {
		t.Errorf("folding is not reversible: %q", got)
	}
}

func TestWarningsAreReported(t *testing.T) {
	parsed := ParseVCF("BEGIN:VCARD\r\nVERSION:3.0\r\nUID:u\r\n")
	if len(parsed.Warnings) == 0 {
		t.Error("an unterminated card must warn")
	}
	found := false
	for _, w := range parsed.Warnings {
		if strings.Contains(w, "missing END:VCARD") {
			found = true
		}
	}
	if !found {
		t.Errorf("warnings = %v", parsed.Warnings)
	}
}

func firstOf(card *Card, collection, key string) string {
	for _, v := range card.Obj(collection).Values() {
		return v.StrOr(key, "")
	}
	return ""
}

func hasKey(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
