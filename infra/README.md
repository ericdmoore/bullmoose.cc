# Infra — bootstrap runbook

Resources are created once with `wrangler`, then their ids pasted into each
service's `wrangler.jsonc` (search for `REPLACE_AFTER_`).

## 1. Cloudflare resources

```sh
# D1 — data-plane shard 0 (control plane can share it for the MVP)
npx wrangler d1 create bullmoose-mail-shard0
npx wrangler d1 execute bullmoose-mail-shard0 --file packages/mailstore/sql/data-plane.sql
npx wrangler d1 execute bullmoose-mail-shard0 --file packages/mailstore/sql/control-plane.sql

# R2 — raw message + attachment blobs
npx wrangler r2 bucket create bullmoose-mail-blobs

# KV — route table hot copy + suppression list
npx wrangler kv namespace create ROUTES
```

Paste the returned `database_id` / KV `id` into all three
`services/*/wrangler.jsonc` files.

## 2. Deploy order

`bullmoose-jmap` declares the `AccountDO` Durable Object; `ingest` and
`submit` bind it via `script_name`, so **deploy jmap first**:

```sh
npm run -w services/jmap deploy
npm run -w services/ingest deploy
npm run -w services/submit deploy
```

## 3. Secrets

```sh
# dev auth for the jmap worker (until services/auth exists)
npx wrangler secret put DEV_BEARER_TOKEN -c services/jmap/wrangler.jsonc

# outbound relay (IAM user scoped to ses:SendRawEmail ONLY)
npx wrangler secret put SES_ACCESS_KEY_ID     -c services/submit/wrangler.jsonc
npx wrangler secret put SES_SECRET_ACCESS_KEY -c services/submit/wrangler.jsonc
npx wrangler secret put INTERNAL_TOKEN        -c services/submit/wrangler.jsonc
```

## 4. Per-domain wiring (manual until services/provision exists)

For each hosted domain (see `docs/architecture/serverless-jmap.md` §8):

1. Cloudflare zone: enable Email Routing, catch-all route → `bullmoose-ingest`.
2. SES: `CreateEmailIdentity`, add the 3 DKIM CNAMEs + MAIL FROM records to
   the zone, wait for verification.
3. Add `DMARC` TXT.
4. Seed KV routes, e.g.:

   ```sh
   npx wrangler kv key put --binding ROUTES "route:example.com:eric" \
     '{"kind":"mailbox","accountId":"t_dev__a_local","tenantId":"t_dev"}'
   ```

5. SES configuration set → SNS topic → HTTPS subscription pointed at
   `https://bullmoose-submit.<account>.workers.dev/webhooks/ses`.

## 5. Smoke test

```sh
TOKEN=... BASE=https://bullmoose-jmap.<account>.workers.dev

# session
curl -H "Authorization: Bearer $TOKEN" $BASE/.well-known/jmap

# Core/echo
curl -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"using":["urn:ietf:params:jmap:core"],"methodCalls":[["Core/echo",{"hello":true},"c0"]]}' \
  $BASE/api/jmap

# Mailbox/get
curl -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],"methodCalls":[["Mailbox/get",{"accountId":"t_dev__a_local","ids":null},"c0"]]}' \
  $BASE/api/jmap
```
