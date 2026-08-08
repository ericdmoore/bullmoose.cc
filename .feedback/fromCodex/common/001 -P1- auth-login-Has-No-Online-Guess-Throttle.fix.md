# FIX - 001 -P1- `/auth/login` has no online guessing throttle

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
