# @bullmoose/outbound

The `OutboundRelay` abstraction — how raw RFC 5322 bytes leave
Cloudflare (which cannot originate SMTP). Selected by the submit
worker's `RELAY` var:

- **SesRelay** (`ses`, default) — AWS SES v2 via SigV4-signed fetch
  (aws4fetch); full-fidelity raw MIME (`SendRawEmail` semantics).
  Region/credentials come from worker vars/secrets; the IAM runtime
  user needs only `ses:SendEmail` + `ses:SendRawEmail`.
- **CloudflareRelay** (`cloudflare`, experimental) — Cloudflare Email
  Service beta. Decomposes the MIME into structured fields, so
  fidelity caveats apply; useful for day-one sends without SES
  production access.
- **MockRelay** (`mock`) — local dev/e2e; records instead of sending.

One interface, so swapping providers is config, not code — the same
philosophy as the CLI's provider-migration story (local SQLite stays
authoritative).
