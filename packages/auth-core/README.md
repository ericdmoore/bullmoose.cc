# @bullmoose/auth-core

Tokens and login-key crypto. No I/O — pure functions the jmap and
provision workers call.

- **Bearer tokens** (GitHub-PAT style): `mintToken` → `bm_<id>_<secret>`,
  SHA-256 hash-at-rest, `parseToken` / `verifyTokenSecret`. Shown once,
  revocable individually. These double as **app passwords** for
  HTTP Basic (Mailtemi, popcorn): username + `bm_…` as the password.
- **Scopes**: `read < annotate < draft < move < send < delete`, with
  `mail` as the superset; `hasScope` / `scopesWithin` (a token can only
  mint tokens ⊆ its own scopes).
- **Login keys** (client-side stretching): `deriveLoginKey` =
  PBKDF2-SHA256, 600k iterations (OWASP), salt =
  SHA-256(`"bullmoose-login-v1:" + lowercase(email)`). The server (and
  the wire) only ever see the derived key and do ONE SHA-256 — that's
  what fits auth inside the Workers free plan's 10ms CPU cap. The
  credentials table carries `pw_algo` for a future argon2id migration.

Threat-model notes live in `docs/architecture/serverless-jmap.md`.
