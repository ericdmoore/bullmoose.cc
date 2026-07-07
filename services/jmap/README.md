# bullmoose-jmap

The client-facing worker — the JMAP server proper. Public at
`https://jmap.bullmoose.cc` (Workers custom domain) and
`bullmoose-jmap.eric-d-moore.workers.dev` (the `_jmap._tcp` SRV target;
kept on workers.dev because Cloudflare rewrites SRV targets that point
at proxied hostnames).

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

Declares `AccountDO` (migrations here); binds SUBMIT for sends.
Secrets: `INTERNAL_TOKEN`, `SHARE_SIGNING_KEY`. Never set
`DEV_BEARER_TOKEN` in production.
