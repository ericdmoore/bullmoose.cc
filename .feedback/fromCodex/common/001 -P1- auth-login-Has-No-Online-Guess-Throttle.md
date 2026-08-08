# 001 -P1- `/auth/login` has no online guessing throttle

**Subsystem:** common (`services/jmap` auth) · **Severity:** HIGH (account security) · **Fix class:** CHANGE-CODE + UPDATE-DOC

## The defect

`services/jmap/src/authRoutes.ts:25-63` accepts a login email and client-derived `loginKey`, checks one SHA-256, and immediately mints a bearer token on success. The file even carries the unresolved TODO at `authRoutes.ts:22`:

```ts
* TODO: rate-limit /auth/login; device-code flow.
```

There is no per-principal, per-IP, or per-failure window state anywhere on this path. Unknown users and bad keys both return 401, which is good for enumeration, but not a throttle.

## Why it bites

The design intentionally moves PBKDF2 to the client so Workers only pay one cheap SHA-256 per attempt. That makes legitimate login fit the free CPU budget, but also makes online password/key guessing cheap for the server to process unless there is a separate rate limit.

This is the only password-to-token bootstrap path. A successful guess returns a long-lived `bm_...` token immediately (`authRoutes.ts:49-63`).

## Documentation drift

The docs emphasize client-side stretching and "password never transits", but do not document any online abuse control. `docs/architecture/agent-integration.md` mentions "rate-limited" responders, not login. The only place rate limiting appears for login is the TODO.

## Cross-references

This is independent of Claude issue 001 (`mail` scope) and 007 (`token create` defaults). Even after scope fixes, login still mints the first token.
