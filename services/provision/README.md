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
  logins); domain validation → clean 422. **Idempotent**: the address is
  unique as a *delivery route* (`routes` is `PRIMARY KEY (domain,
  localpart)`), so a repeat call returns the existing account
  (`created: false`) and a call for an address routing anywhere else is a
  `409` that changes nothing — see the DEPLOY.md runbook
- `POST /principals/password` — stores the client-side-stretched
  loginKey
- `POST/GET/DELETE /tokens` — mint/list/revoke bearer tokens
- `POST/GET /agent-bindings` — agent mailbox bindings incl.
  `config_json` (pipeline, persona, model aliases, digest targets — see
  `docs/agents/README.md`); `slaSeconds` auto-arms a watchdog responder
- `POST /agent-bindings/{id}/{disable|enable}` — the kill switch, two
  explicit verbs rather than one `PATCH {enabled}` so the dangerous
  direction is unambiguous in the audit log
- `PATCH/DELETE /agent-bindings/{id}`, `GET /agent-bindings/{id}/lifecycle`
- `POST /agent-bindings/{id}/supervisor` — the supervisory grant, after
  the fact; refuses rather than guessing when ownership is ambiguous
- `POST /agent-bindings/{id}/backfill` — mint pending invocations over the
  archive, newest-first, bounded below by the history floor;
  `POST …/floor-request` mints the tier-1 approval that moves that floor
- `POST/GET/DELETE /grants` — cross-account delegation
  (effective rights = `token ∩ grant`)
- `POST/GET/DELETE /bureau-grants` — `(principal, credRef, verb)` grants
  over the Bureau's credential vault; mint ≠ authorize
- `POST /extractor` — turn the extraction pass on for ONE human account
  (`bullmoose admin extractor on`). A binding on the account's own
  mailbox: it reads what is delivered and writes Annotations, and sends
  nothing. Re-run to SWAP the model in place — `config_json` is
  deliberately immutable on PATCH, so this is the sanctioned path. Ships
  CAPPED ($2.00/month default; `budgetMicros` overrides, `0` refuses every
  paid claim)
- `POST /provider-keys` — BYOK (`bullmoose admin byok seal`): seal a
  tenant's own model-provider key in the Bureau, grant `fetch` on it, and
  attach the ref to their bindings, in one call. The key crosses the
  BUREAU binding once and no route anywhere returns it. Re-post to
  rotate. The session-reachable equivalent is `ProviderCredential/set` on
  `services/jmap` (scope `vault`)
- `POST /bouncer` — mint the tenant's `bouncer@` account + reply-only
  binding for ONE domain. Explicit per tenant; nothing is auto-provisioned
- `POST /remind` — same shape, for the mail-native Watches door

Secrets: `ADMIN_TOKEN`, `CF_API_TOKEN` (zone DNS + Email Routing edit),
SES *deploy* key pair (`ses:CreateEmailIdentity`, `GetEmailIdentity`,
`PutEmailIdentityMailFromAttributes`), and `INTERNAL_TOKEN` — shared with
the Bureau's `/internal/*` surface. Without the latter (or without the
`BUREAU` service binding) `POST /provider-keys` answers 501 and every
other verb here is unaffected.

Vars: `SES_REGION`, `INGEST_WORKER_NAME`, and `JMAP_HOST` — the SRV target
planted as `_jmap._tcp.<domain>`. ⚠️ It must name a host that ANSWERS
`/.well-known/jmap`: the client's rungs are SRV → SRV-over-DoH →
`https://<domain>/.well-known/jmap` and **rung 1 short-circuits**, so a
stale value does not degrade to the fallback, it pre-empts it. Unset the
var to skip the record entirely.

Onboarding a person end to end (operator column and theirs):
`docs/playbooks/onboarding-a-second-human.md`.
