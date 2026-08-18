# bullmoose-jmap

The client-facing worker — the JMAP server proper. Public at
**`https://app.bullmoose.cc`**, which is the only address this repo
configures: five Worker `routes` in `wrangler.jsonc` claim the API paths
on a hostname Pages otherwise serves, so app and API share one origin and
no browser request crosses an origin boundary.

Two other names have answered for this worker and neither is that:

- `https://jmap.bullmoose.cc` — a Workers custom domain attached out of
  band. It still answers (401 on `/.well-known/jmap`, 2026-08-18), but no
  `wrangler.jsonc` here declares it, so a fresh deploy of this repo does
  not create it. Prefer `app.bullmoose.cc` in anything durable.
- `bullmoose-jmap.eric-d-moore.workers.dev` — **dead.** It 404s on every
  path including the session resource. It was the `_jmap._tcp` SRV target,
  kept on workers.dev because Cloudflare cannot serve an SRV pointing at a
  proxied hostname; that record was retired on 2026-08-13 and autodiscovery
  now runs on the RFC 8620 §2.2 well-known rung instead. `services/provision`
  still names it in `JMAP_HOST` — see docs/DEPLOY.md §6.1.

## Surface

- `GET /.well-known/jmap` — session resource (RFC 8620 §2)
- `POST /api/jmap` — batched method calls; implemented:
  Mailbox/get·query·changes·queryChanges, Email/get·query·set·import·
  changes, Thread/get, Identity/get, EmailSubmission/set (with
  `onSuccessUpdateEmail` back-refs), VacationResponse/get·set (facade
  over the responders table), AgentInvocation/query·get·set·changes
  (vendor capability; optimistic pending→running claims)
- `POST /auth/login` — password login (client-side-stretched loginKey
  only) mints the first bearer token; `/auth/tokens` — self-service
  list/mint-within-scopes/revoke
- Blob `GET /api/download/...`, `POST /api/upload/...`, and
  `POST /api/share/...` → expiring HMAC public links under `/share/*`
- `GET /api/ws` — push, proxied straight to the account's Durable Object
  (`access_token` query param for clients that can't set headers)

Auth: Bearer `bm_…` tokens, or **HTTP Basic where the password is a
token** (app-password pattern for Mailtemi/popcorn/etc). Uniform 401s.

### Login throttle

`/auth/login` is the one password-to-token path and server-side
verification is one SHA-256 by design, so it is rate-limited *before*
the credential lookup and the hash (`src/loginThrottle.ts`):

| window | limit | effect when tripped |
|---|---|---|
| login email | 5 failures / 15 min | stops verifying — **still the ordinary 401** |
| client IP (`cf-connecting-ip`) | 20 failures / 15 min | `429` + `Retry-After` |

Only the IP window may change the status code. The email window stays
silent because a 429-on-real-email next to a 401-on-typo would be an
account-existence oracle, and this endpoint's uniform 401 is deliberate.
Every non-success counts against both windows — including unknown
emails, or the IP window would trip only on accounts that exist and
become that oracle itself. A window starts at its first failure and is
never extended, so nobody can hold a login shut by hammering it; a
successful login clears both.

Counters live in the existing `ROUTES` KV namespace under `login:` keys
— no new binding, nothing to provision, and no D1 write per failed
guess (an unauthenticated attacker must not be able to drive
control-plane writes). KV is eventually consistent, so the windows are a
bound rather than an exact ledger; if that stops being enough the
upgrade is a Durable Object or Cloudflare's rate-limiting binding behind
the same `beginLoginAttempt` interface. Note the throttle bounds *token
minting only* — existing bearer tokens are unaffected, so a locked
window never costs anyone access to their mail.

Declares `AccountDO` (migrations here); binds SUBMIT for sends.
Secrets: `INTERNAL_TOKEN`, `SHARE_SIGNING_KEY`. Never set
`DEV_BEARER_TOKEN` in production.
