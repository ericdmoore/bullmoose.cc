// Package authkey is the CLIENT half of bullmoose's password handling: the one
// function that turns (email, password) into the value that travels.
//
// ── The property being protected ───────────────────────────────────────────
//
// The server never sees the password (arch.md §5.1). Stretching happens here, in
// this process; `/auth/login` receives only the derived key, stores only a hash
// of it, and a compromised server or an accidental log line therefore never
// observes plaintext. That is worth the same on any plan, which is why arch.md
// §5.1 corrects itself: the Workers CPU cap was the weaker argument and is no
// longer binding, the no-plaintext property is the one that survives.
//
// ── Why the algorithm is not a Go choice ───────────────────────────────────
//
// PBKDF2-SHA256/600k is a CROSS-CLIENT CONTRACT, not a per-client preference.
// Go could do argon2id natively; a browser cannot without shipping WASM. Ship
// both and one password yields two different keys depending on which client the
// user typed it into — login succeeds in one and silently fails in the other.
// devPlan.md's out-of-scope list says it plainly: changing deriveLoginKey is
// free and shouldn't be done.
//
// So this file is a port, and conformance/login-key.json (generated from the
// live TypeScript by conformance/vectors.ts) is its oracle. A divergence here
// does not look like a bug: it looks like the user typing the wrong password.
package authkey

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/hex"
)

// The three parameters, mirroring packages/auth-core/src/index.ts:315-320 and
// pinned by conformance/login-key.json's `iterations`, `keyBits` and
// `saltLabel` fields — loginkey_test.go asserts the constants against the
// vector's header, not just the keys, because a port that matches today's golden
// keys but not the parameters passes now and diverges the moment the vector is
// regenerated (auth-core:317 says exactly this).
const (
	// SaltLabel is auth-core's LOGIN_SALT_LABEL.
	SaltLabel = "bullmoose-login-v1:"
	// Iterations is auth-core's LOGIN_KEY_ITERATIONS — ~200-400ms of local CPU
	// by design: an offline cracker pays it per guess.
	Iterations = 600_000
	// KeyBytes is 256 bits, the deriveBits length in auth-core:342.
	KeyBytes = 32
)

// DeriveLoginKey is auth-core's deriveLoginKey (index.ts:327):
//
//	salt     = SHA-256("bullmoose-login-v1:" + lowercase(email))
//	loginKey = hex(PBKDF2-HMAC-SHA256(password, salt, 600_000, 256 bits))
//
// `lowercase` is JavaScript's, not Go's — see jsToLower. That single word is the
// difference between a working login and a "wrong password" that is not one.
func DeriveLoginKey(email, password string) (string, error) {
	key, err := pbkdf2.Key(sha256.New, password, LoginSalt(email), Iterations, KeyBytes)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(key), nil
}

// LoginSalt is the raw salt bytes for an address — auth-core's loginSaltHex
// (index.ts:354) before hex encoding. Exported because the vector records
// `saltHex` per case, so the test can localise a mismatch to the salt (an email
// normalisation bug) rather than to the stretch (a PBKDF2 bug).
func LoginSalt(email string) []byte {
	sum := sha256.Sum256([]byte(SaltLabel + jsToLower(email)))
	return sum[:]
}
