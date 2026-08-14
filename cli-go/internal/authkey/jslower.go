package authkey

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// jsToLower is `String.prototype.toLowerCase`, which is NOT `strings.ToLower`.
//
// ⚠️ arch.md §5 flags this as the Go-specific divergence to read before porting
// login, and conformance/login-key.json carries a case for it
// (`unicode-email-turkish-dotted-i`) that is red until the port matches. The
// login salt lower-cases the email address, so a naive port derives a DIFFERENT
// key for such an address and login fails looking exactly like a wrong password.
//
// Two families of difference, both real:
//
//	full case mapping   `strings.ToLower("İ")` (U+0130) yields a bare "i";
//	                    ECMA-262 §22.1.3.29 uses the Unicode Default Case
//	                    Conversion, whose FULL mapping yields "i" + U+0307. It is
//	                    the one unconditional multi-character lowercase mapping in
//	                    SpecialCasing.txt, and it is in the vector.
//	Final_Sigma         "ΟΔΥΣΣΕΥΣ".toLowerCase() ends in ς (U+03C2), not σ —
//	                    a context-sensitive rule Go's simple mapping has no
//	                    notion of. Not in the vector (the generator's cases are
//	                    the mistakes people actually make), so jslower_test.go
//	                    pins it against node directly.
//
// Deliberately NOT pulled in: golang.org/x/text/cases, which implements all of
// this. It is a large dependency (megabytes of tables) for one lower-casing of
// one email address, in a module whose go.mod justifies each of its two deps
// individually. The locale-tailored mappings x/text also carries (Turkish,
// Lithuanian) would be WRONG here anyway: `toLowerCase` is locale-independent,
// and only `toLocaleLowerCase` applies them.
func jsToLower(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i, r := range s {
		switch r {
		case 0x0130: // LATIN CAPITAL LETTER I WITH DOT ABOVE
			b.WriteRune('i')
			b.WriteRune(0x0307) // COMBINING DOT ABOVE
		case 0x03A3: // GREEK CAPITAL LETTER SIGMA
			if isFinalSigma(s, i) {
				b.WriteRune(0x03C2) // ς
			} else {
				b.WriteRune(0x03C3) // σ
			}
		default:
			b.WriteRune(unicode.ToLower(r))
		}
	}
	return b.String()
}

// isFinalSigma implements SpecialCasing.txt's Final_Sigma condition for the
// sigma at byte offset i: it is preceded by a cased character (ignoring any
// case-ignorable characters in between) and NOT followed by one on the same
// terms. "ΑΣ" → "ας"; "ΣΣ" → "σς"; a lone "Σ" → "σ".
func isFinalSigma(s string, i int) bool {
	return casedBefore(s[:i]) && !casedAfter(s[i+len("Σ"):])
}

func casedBefore(before string) bool {
	for len(before) > 0 {
		r, size := utf8.DecodeLastRuneInString(before)
		if !isCaseIgnorable(r) {
			return isCased(r)
		}
		before = before[:len(before)-size]
	}
	return false
}

func casedAfter(after string) bool {
	for _, r := range after {
		if isCaseIgnorable(r) {
			continue
		}
		return isCased(r)
	}
	return false
}

// isCased is UCD `Cased`: Lowercase ∪ Uppercase ∪ Lt, where Lowercase is
// Ll ∪ Other_Lowercase and Uppercase is Lu ∪ Other_Uppercase.
func isCased(r rune) bool {
	return unicode.Is(unicode.Ll, r) || unicode.Is(unicode.Lu, r) || unicode.Is(unicode.Lt, r) ||
		unicode.Is(unicode.Other_Lowercase, r) || unicode.Is(unicode.Other_Uppercase, r)
}

// isCaseIgnorable is UCD `Case_Ignorable`: general categories Mn, Me, Cf, Lm and
// Sk, plus the three Word_Break classes MidLetter, MidNumLet and Single_Quote —
// which Go has no table for, so they are listed. (This is why "ΑΣ'" and "ΑΣ."
// still lower-case to a FINAL sigma: an apostrophe or a full stop does not end
// the word for this rule.)
func isCaseIgnorable(r rune) bool {
	switch r {
	case '\'', // Single_Quote
		':', 0x00B7, 0x0387, 0x05F4, 0x2027, 0xFE13, 0xFE55, 0xFF1A, // MidLetter
		'.', 0x2018, 0x2019, 0x2024, 0xFE52, 0xFF07, 0xFF0E: // MidNumLet
		return true
	}
	return unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Me, r) ||
		unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Lm, r) || unicode.Is(unicode.Sk, r)
}
