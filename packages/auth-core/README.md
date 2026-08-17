# @bullmoose/auth-core

Tokens and login-key crypto. No I/O — pure functions the jmap and
provision workers call.

- **Bearer tokens** (GitHub-PAT style): `mintToken` → `bm_<id>_<secret>`,
  SHA-256 hash-at-rest, `parseToken` / `verifyTokenSecret`. Shown once,
  revocable individually. These double as **app passwords** for
  HTTP Basic (Mailtemi, popcorn): username + `bm_…` as the password.
- **Scopes** — a flat set, **not** a lattice (`<` would imply an ordering the
  code does not have — common/027):
  - **`read`** — the base "see it" capability.
  - **mail verbs** (independent; none implies another): `annotate`, `draft`,
    `move`, `send`, `delete`. `mail` is a bundle of exactly `read` + these five.
  - **realms** (independent; one never implies another): `contacts`,
    `calendar`, `vault`, `files`. **Not** covered by `mail` — a mail token does
    not open the vault.
  - **control plane**: `admin` — implies nothing, and nothing implies it.
  - **The one implication**: any write implies `read` — you cannot change what
    you cannot see. Every mail verb, `mail`, and every realm scope satisfies
    `read`. It stops there: `delete` does not imply `send` (`send` stays its own
    capability, since mailing a stranger is irreversible), and `send` implies
    only `read` — never `move`/`delete`/`annotate`.

  `hasScope` / `scopesWithin` (a token can only mint tokens ⊆ its own
  scopes, so `login --scopes` is the only way to _widen_). Unknown scope
  strings are denied unless held verbatim.

- **Login keys** (client-side stretching): `deriveLoginKey` =
  PBKDF2-SHA256, 600k iterations (OWASP), salt =
  SHA-256(`"bullmoose-login-v1:" + lowercase(email)`). The server (and
  the wire) only ever see the derived key and do ONE SHA-256 — that's
  what fits auth inside the Workers free plan's 10ms CPU cap. The
  credentials table carries `pw_algo` for a future argon2id migration.

Threat-model notes live in `docs/architecture/serverless-jmap.md`.
