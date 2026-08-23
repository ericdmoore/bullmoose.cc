// Package scopes is `--scopes` parsing for the two commands that mint a
// credential — `login` and `token create`.
//
// It mirrors packages/cli/src/scopes.ts, which itself mirrors the vocabulary in
// @bullmoose/auth-core. That is one mirror more than anybody wants, and it is
// the pre-existing condition arch.md §2 measures: the CLI already could not
// import the workspace TypeScript at runtime, so Go does not fork shared code —
// it changes the language of a fork that already existed.
//
// What is NEW here is that the copy is checked. conformance/scopes.json (T1) is
// generated from the live auth-core, and scopes_test.go compares this
// vocabulary against it in BOTH directions, which is strictly better than the
// regex-over-source check packages/cli/src/scopes.test.ts still runs.
//
// The server validates all of this again — it must, the CLI is not the only
// client. Doing it here too is for the error message: a typo'd scope should cost
// a local exit 2 naming the vocabulary, not an HTTP 400 after a round trip, and
// for `token create` the mistake it most needs to catch is saying nothing at all
// (scopes.ts:8, `.feedback` cli/007).
package scopes

import (
	"errors"
	"strings"
)

// Mail are the mail verbs. `mail` is the bundle of exactly these (scopes.ts:17).
var Mail = []string{"read", "annotate", "draft", "move", "send", "delete"}

// Realm are the realm scopes — independent of the mail verbs and NOT covered by
// `mail` (scopes.ts:21).
var Realm = []string{"contacts", "calendar", "vault", "files"}

// SelfService is what `bullmoose login` and `bullmoose token create` may ask for
// — no `admin` (scopes.ts:26). `agent` is the agent-runtime MARKER: it grants
// nothing and only narrows.
var SelfService = concat(Mail, Realm, []string{"rules", "mail", "agent"})

// Token is TOKEN_SCOPES — SelfService plus `admin`, the operator vocabulary.
// An earlier note here said this was "deliberately NOT mirrored" because
// `admin token create` was unported; that premise expired when s42 ported it,
// which is exactly why the note said an unused constant drifts — it was never
// added until its user arrived.
var Token = concat(SelfService, []string{"admin"})

// Suggestions are printed whenever `--scopes` is missing or wrong (scopes.ts:37).
// `token create` exists to make a NARROW credential for one device; a user who
// has to be told the flag is required should get a usable answer in the same
// breath, or they will reach for the widest thing that works.
var Suggestions = []struct{ Scopes, Use string }{
	{"read", "backup / search / read-only sync"},
	{"read,move", "POP3 or IMAP-style fetch (popcorn)"},
	{"read,draft,send", "a desktop or phone mail client"},
	{"mail", "all six mail verbs; no contacts/calendar/vault"},
	{"mail,contacts,calendar", "a full device (JMAP + CardDAV + CalDAV)"},
	{"mail,rules", "a mail client that also edits filtering rules (Boogie)"},
}

// ParseFlag parses a `--scopes a,b,c` flag — scopes.ts:61 parseScopeFlag.
//
// `raw` is nil when the flag was ABSENT, which is not the same as `--scopes ""`;
// the caller must preserve that distinction (args.go records presence) or the
// cli/007 refusal disappears.
//
//	required=true   an omitted flag is an error. This is the cli/007 fix: it is
//	                what stops `token create` minting the widest credential the
//	                self-service API can express for the shortest command.
//	required=false  `login` only, because it is the bootstrap — an omitted flag
//	                returns nil scopes, meaning "let the server default", which
//	                is what keeps a user with no token able to get one.
//
// An explicitly EMPTY value is always an error, whether required or not:
// `--scopes ""` is a typo, and both "the server default" and "a token that can
// do nothing" are worse guesses than saying so.
func ParseFlag(raw *string, allowed []string, required bool) ([]string, error) {
	if raw == nil {
		if !required {
			return nil, nil
		}
		return nil, errors.New("--scopes is required.\n" + Help(allowed))
	}
	var parts []string
	for _, p := range strings.Split(*raw, ",") {
		if t := strings.TrimSpace(p); t != "" {
			parts = append(parts, t)
		}
	}
	if len(parts) == 0 {
		return nil, errors.New("--scopes was given but empty.\n" + Help(allowed))
	}
	var bad, out []string
	seen := map[string]bool{}
	for _, s := range parts {
		if !contains(allowed, s) {
			if !contains(bad, s) {
				bad = append(bad, s)
			}
			continue
		}
		if seen[s] {
			continue // `read,read` is not two scopes
		}
		seen[s] = true
		out = append(out, s)
	}
	if len(bad) > 0 {
		return nil, errors.New("unknown scope(s): " + strings.Join(bad, ", ") + "\n" + Help(allowed))
	}
	return out, nil
}

// Help is the vocabulary + suggestions block shared by every `--scopes` error —
// scopes.ts:96 scopeHelp, byte for byte including the 24-column padding.
func Help(allowed []string) string {
	lines := []string{"valid scopes: " + strings.Join(allowed, ", "), "common choices:"}
	for _, s := range Suggestions {
		if allowedAll(strings.Split(s.Scopes, ","), allowed) {
			lines = append(lines, "  --scopes "+pad(s.Scopes, 24)+" "+s.Use)
		}
	}
	return strings.Join(lines, "\n")
}

// pad is JavaScript's String.prototype.padEnd: pad to width, never truncate.
func pad(s string, width int) string {
	if len(s) >= width {
		return s
	}
	return s + strings.Repeat(" ", width-len(s))
}

func allowedAll(want, allowed []string) bool {
	for _, w := range want {
		if !contains(allowed, w) {
			return false
		}
	}
	return true
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

func concat(lists ...[]string) []string {
	var out []string
	for _, l := range lists {
		out = append(out, l...)
	}
	return out
}
