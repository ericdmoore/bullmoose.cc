# ✅ FIX - 001 -P1- `/auth/login` has no online guessing throttle

## Proposal

Add a small login-attempt gate before password verification. Use D1 if you want durability and auditability, or KV if you want a minimal first cut. The key should include at least:

- normalized login email
- client IP when available (`cf-connecting-ip`)
- a short rolling window

Recommended first implementation:

1. Add `auth_login_attempts` to the control-plane schema: `bucket`, `email`, `ip`, `failures`, `first_at`, `last_at`, `locked_until`.
2. In `handleLogin`, check both `email` and `ip` windows before doing `hashLoginKey`.
3. On failed auth, increment both counters and return the same 401 body until the threshold flips to 429.
4. On success, clear the email+IP counters.

## Bread-crumbs for the implementer

- Entry point: `services/jmap/src/authRoutes.ts:25`.
- Keep unknown-user and wrong-key responses indistinguishable; only rate-limit metadata may differ by status.
- Add tests around a fake DB shell if possible. Cases: under threshold, threshold hit, lock expiry, success clears failures.
- Document the policy in `services/jmap/README.md` and the auth section of `docs/architecture/README.md`.

## Suggested limits

Start conservative and configurable: 5 failures per email per 15 minutes, 20 failures per IP per 15 minutes, lock for 15 minutes. Admin reset can come later.

---

## ✅ Implemented — and where the proposal above was wrong

Shipped as `services/jmap/src/loginThrottle.ts` + the gate in `handleLogin`, with tests in
`services/jmap/src/authRoutes.test.ts`. The limits above were kept verbatim. Two of the four
recommended steps were **not** followed, deliberately:

1. **Step 3 contradicts step 2's own constraint.** "Return the same 401 body until the threshold
   flips to 429" makes the status code depend on the _email_ window. Since the email window is the
   one that trips first (5 vs 20), an attacker gets 429 on an email they have hammered and 401 on
   one they have not — the transition itself is an enumeration signal, and it undoes the uniform-401
   property the issue text correctly praises. Implemented instead: **only the IP window may change
   the status code** (429, keyed on the caller, identical for every email); the email window returns
   the ordinary 401 while silently refusing to verify. Corollary the proposal missed: **failures
   must be counted for unknown principals too**, otherwise the IP window trips only on real accounts
   and becomes the oracle by itself.

2. **Step 1's D1 table was not created.** One D1 write per failed login lets an unauthenticated
   attacker drive control-plane writes against the same database that serves mail — a self-inflicted
   DoS, and this repo has no migration framework to walk it back. The counters live in the existing
   `ROUTES` KV namespace under `login:` keys: no new binding, no `infra/bootstrap.mjs` change, and it
   works on every already-deployed environment. (A second KV namespace would also have been
   clobbered by `bootstrap.mjs:149`, which rewrites only the first `"id"` after `"kv_namespaces"` —
   the hazard filed as infra issue 013.) No `auth_login_attempts` table exists; if an audit trail is
   wanted later it should be sampled/asynchronous, not one synchronous write per guess.

Also worth recording:

- The gate runs **before** the credentials `SELECT` and before `hashLoginKey` — the tests assert on
  call counts, not status codes, because a status assertion passes with the ordering reversed.
- A window starts at its first failure and is **never** extended, so a third party cannot hold a
  victim's login shut indefinitely. The blast radius of a tripped email window is _token minting_;
  existing bearer tokens keep working, so nobody loses access to their mail.
- KV is eventually consistent (~60s edge cache, ~1 write/s per key), so these windows bound the
  guess rate rather than counting exactly. Documented in `loginThrottle.ts`; the upgrade path is a
  Durable Object or the native rate-limiting binding behind the same `beginLoginAttempt` interface.
- Still open, filed separately: on success `authRoutes.ts` returns the token _plus_ a full
  enumeration of the principal's accounts, tenant ids and addresses, and the token defaults to
  `["mail"]` (Claude issue 001). The throttle bounds how many guesses reach that payload; it does not
  shrink it.
