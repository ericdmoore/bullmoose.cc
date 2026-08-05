# bullmoose-submit

The outbound exit. Cloudflare can't originate SMTP, so every send —
EmailSubmission/set, armed responders, agent replies/digests — funnels
here and leaves through a relay (`@bullmoose/outbound`):

- `POST /internal/submit` — worker→worker only (shared
  `INTERNAL_TOKEN`); body = `{accountId, tenantId, blobId, envelope}`.
  Checks the KV suppression list per recipient, streams the blob from
  R2, relays via `RELAY` = `ses` (default; SigV4 to SES v2, us-west-2)
  | `cloudflare` (Email Service beta) | `mock` (dev)
- `POST /webhooks/ses` — SES→SNS event webhook; bounces/complaints
  populate `suppress:{email}` keys in KV

Deliberately has **no** AccountDO binding: jmap binds this worker as a
service (SUBMIT), so a DO binding back to bullmoose-jmap would make the
two deployments circular. State commits happen in the callers.

SES sandbox note: until production access is granted, recipients must
be verified identities. Secrets: SES runtime key pair
(`ses:SendEmail`/`SendRawEmail` only), `INTERNAL_TOKEN`.
