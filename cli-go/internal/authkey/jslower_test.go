package authkey

import (
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
	"unicode"
)

// TestJsToLowerDiffersFromStringsToLower is the negative control: if
// strings.ToLower agreed with JavaScript on these inputs, jslower.go would be
// dead weight and deleting it would break nothing. Each case below is one Go
// would get wrong.
func TestJsToLowerDiffersFromStringsToLower(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		// The vector's case, and the one arch.md §5 says is "verified, not
		// hypothetical": U+0130 → "i" + U+0307, not a bare "i".
		{"İrem@Bullmoose.CC", "i̇rem@bullmoose.cc"},
		// Final_Sigma: the last sigma of a word is ς. Go lower-cases both to σ.
		{"ΟΔΥΣΣΕΥΣ@x.cc", "οδυσσευς@x.cc"},
		{"ΣΣ", "σς"},
	} {
		if got := jsToLower(c.in); got != c.want {
			t.Errorf("jsToLower(%q) = %q, want %q", c.in, got, c.want)
		}
		if strings.ToLower(c.in) == c.want {
			t.Errorf("strings.ToLower already agrees with JS on %q — this case no longer "+
				"defends anything; find one that does or drop it", c.in)
		}
	}
}

// TestJsToLowerFinalSigmaConditions pins the CONDITION, not just the letter.
// A port that always emits ς for a trailing sigma passes the case above and
// fails half of these.
func TestJsToLowerFinalSigmaConditions(t *testing.T) {
	for _, c := range []struct{ in, want, why string }{
		{"Σ", "σ", "no preceding cased character — not final"},
		{"ΑΣ", "ας", "preceded by cased, followed by nothing — final"},
		{"ΣΑ", "σα", "followed by a cased character — not final"},
		{"ΑΣ́", "ας́", "a following COMBINING ACUTE is case-ignorable — still final"},
		{"ΑΣ@b", "ας@b", "'@' is neither cased nor case-ignorable — final"},
		{"Α'Σ", "α'ς", "the apostrophe between is case-ignorable — the preceding Α still counts"},
	} {
		if got := jsToLower(c.in); got != c.want {
			t.Errorf("jsToLower(%q) = %q, want %q (%s)", c.in, got, c.want, c.why)
		}
	}
}

// TestJsToLowerAgreesWithNode is the differential: every BMP code point plus a
// sample of astral ones, lower-cased by this Go function and by the JavaScript
// this port must agree with, compared byte for byte.
//
// It exists because the conformance vector deliberately carries only "the
// mistakes somebody makes once" (vectors.ts), so it cannot notice a code point
// nobody thought of. Skipped when node is absent; node is present wherever the
// contract suite runs, which is everywhere this matters.
//
// ⚠️ FOUND BY THIS TEST, and the reason it does not assert plain equality: the
// two runtimes ship DIFFERENT UNICODE VERSIONS. Go 1.26's tables are Unicode
// 15.0.0; node 24's ICU is 17.0. ~40 code points added since 15.0 (U+1C89,
// U+A7CB…U+A7DC, …) therefore lower-case in JS and pass through unchanged in Go.
// That is not a porting mistake and no amount of care in jslower.go fixes it —
// it is a data-version skew, and golang.org/x/text would only move which version
// is stale.
//
// So the assertion is the BOUNDARY rather than equality: every divergence must be
// a code point Go's tables have no case data for at all. Anything else is a real
// bug in this port. The residual risk is a login address containing a letter
// added to Unicode after Go's tables — for which the derived salt would differ
// and login would fail like a wrong password. It is logged, bounded, and it
// closes by itself when Go's tables catch up.
func TestJsToLowerAgreesWithNode(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not on PATH — the JS side of the differential is unavailable")
	}

	var inputs []string
	for r := rune(1); r <= 0xFFFF; r++ {
		if r >= 0xD800 && r <= 0xDFFF {
			continue // lone surrogates are not text on either side
		}
		inputs = append(inputs, string(r))
	}
	// Astral samples: cased scripts with real case mappings (Deseret, Osage,
	// Warang Citi, Medefaidrin, Adlam).
	for _, block := range [][2]rune{{0x10400, 0x1044F}, {0x104B0, 0x104FB}, {0x118A0, 0x118DF},
		{0x16E40, 0x16E7F}, {0x1E900, 0x1E943}} {
		for r := block[0]; r <= block[1]; r++ {
			inputs = append(inputs, string(r))
		}
	}
	// Multi-character contexts, where the context-sensitive rule lives.
	for _, r := range []rune{'a', 'Α', 'Σ', '1', '@', '.', '\'', 0x0301, ' '} {
		inputs = append(inputs, "Σ"+string(r), string(r)+"Σ", "Α"+string(r)+"Σ", "İ"+string(r))
	}

	payload, err := json.Marshal(inputs)
	if err != nil {
		t.Fatal(err)
	}
	// Read the input from stdin: 65k strings is far past any argv limit.
	// setEncoding("utf8") matters — without it a chunk boundary splits a
	// multi-byte sequence and two arbitrary code points come back as U+FFFD,
	// which reads exactly like a porting bug.
	cmd := exec.Command(node, "-e",
		`process.stdin.setEncoding("utf8");let s="";`+
			`process.stdin.on("data",c=>s+=c).on("end",()=>`+
			`process.stdout.write(JSON.stringify(JSON.parse(s).map(x=>x.toLowerCase()))))`)
	cmd.Stdin = strings.NewReader(string(payload))
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("node: %v", err)
	}
	var want []string
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatalf("decoding node's answer: %v", err)
	}
	if len(want) != len(inputs) {
		t.Fatalf("node returned %d results for %d inputs", len(want), len(inputs))
	}

	skew := 0
	for i, in := range inputs {
		got := jsToLower(in)
		if got == want[i] {
			continue
		}
		if unknownToGosTables(in) {
			skew++
			continue
		}
		t.Errorf("jsToLower(%+q) = %+q, node says %+q — and Go's tables DO know this "+
			"character, so this is a porting bug, not the Unicode-version skew", in, got, want[i])
	}
	t.Logf("agreed on %d of %d inputs; %d diverged only because Go's tables are Unicode %s "+
		"and node's are newer", len(inputs)-skew, len(inputs), skew, unicode.Version)
	// A skew of ZERO would mean the two runtimes now agree everywhere and this
	// allowance can be tightened to plain equality; a huge one would mean the
	// comparison has broken open. Neither is a failure, both are worth seeing.
	if skew > 200 {
		t.Errorf("%d divergences is too many to be version skew alone — check the comparison itself", skew)
	}
}

// unknownToGosTables reports whether Go has no case data at all for any rune of
// s: ToLower and ToUpper both leave it alone. That is the signature of a code
// point added to Unicode after Go's tables were generated.
func unknownToGosTables(s string) bool {
	for _, r := range s {
		if unicode.ToLower(r) != r || unicode.ToUpper(r) != r {
			return false
		}
	}
	return true
}
