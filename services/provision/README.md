# bullmoose-provision

Multi-domain onboarding, fully API-driven — Cloudflare is both DNS and
compute, so wiring domain #50 is the same call as domain #1. Fronted by
`bullmoose admin` (single `ADMIN_TOKEN` bearer; treat it as root).

## Admin API

- `POST/GET /tenants`
- `POST /domains` — the whole wiring run, each step reported ✓/✗:
  find zone → enable Email Routing → catch-all → ingest → SES
  CreateEmailIdentity → 3 DKIM CNAMEs → MAIL FROM
  (`bounce.<domain>` + MX/SPF) → DMARC → `_jmap._tcp` SRV (target =
  `JMAP_HOST` var, enabling `bullmoose login <email>` autodiscovery).
  Idempotent — re-run after fixing a failed step.
- `GET /domains/{domain}` — re-checks SES/DKIM verification, flips the
  domain `active`
- `POST/GET /accounts` — mailbox provisioning (default mailboxes, KV
  route, identity; optional `principalEmail` attach for multi-inbox
  logins); domain validation → clean 422
- `POST /principals/password` — stores the client-side-stretched
  loginKey
- `POST/GET/DELETE /tokens` — mint/list/revoke bearer tokens
- `POST/GET /agent-bindings` — agent mailbox bindings incl.
  `config_json` (pipeline, persona, model aliases, digest targets — see
  `docs/agents/README.md`); `slaSeconds` auto-arms a watchdog responder

Secrets: `ADMIN_TOKEN`, `CF_API_TOKEN` (zone DNS + Email Routing edit),
SES *deploy* key pair (`ses:CreateEmailIdentity`, `GetEmailIdentity`,
`PutEmailIdentityMailFromAttributes`).
