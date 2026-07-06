# Infra — bootstrap runbook

Resources are created once with `wrangler`, then their ids pasted into each
service's `wrangler.jsonc` (search for `REPLACE_AFTER_`).

## 1. Cloudflare resources

```sh
# D1 — data-plane shard 0 (control plane shares it for the MVP)
npx wrangler d1 create bullmoose-mail-shard0
npx wrangler d1 execute bullmoose-mail-shard0 --file packages/mailstore/sql/data-plane.sql
npx wrangler d1 execute bullmoose-mail-shard0 --file packages/mailstore/sql/control-plane.sql

# R2 — raw message + attachment blobs
npx wrangler r2 bucket create bullmoose-mail-blobs

# KV — route table hot copy + suppression list
npx wrangler kv namespace create ROUTES
```

Paste the returned `database_id` / KV `id` into all four
`services/*/wrangler.jsonc` files.

## 2. Deploy order

Binding graph: `jmap` binds `submit` as a service (SUBMIT), and `ingest`
binds jmap's `AccountDO` cross-script — so:

```sh
npm run -w services/submit deploy      # 1. no dependencies
npm run -w services/jmap deploy        # 2. declares AccountDO; binds SUBMIT
npm run -w services/ingest deploy      # 3. binds AccountDO from jmap
npm run -w services/provision deploy   # 4. admin/control plane only
```

## 3. Secrets

```sh
# jmap worker
npx wrangler secret put DEV_BEARER_TOKEN -c services/jmap/wrangler.jsonc
npx wrangler secret put INTERNAL_TOKEN   -c services/jmap/wrangler.jsonc

# submit worker (IAM user scoped to ses:SendRawEmail ONLY; INTERNAL_TOKEN
# must match jmap's)
npx wrangler secret put SES_ACCESS_KEY_ID     -c services/submit/wrangler.jsonc
npx wrangler secret put SES_SECRET_ACCESS_KEY -c services/submit/wrangler.jsonc
npx wrangler secret put INTERNAL_TOKEN        -c services/submit/wrangler.jsonc

# provision worker (CF token: Zone:Edit + Email Routing:Edit + DNS:Edit;
# SES IAM user additionally needs identity-management permissions)
npx wrangler secret put ADMIN_TOKEN           -c services/provision/wrangler.jsonc
npx wrangler secret put CF_API_TOKEN          -c services/provision/wrangler.jsonc
npx wrangler secret put SES_ACCESS_KEY_ID     -c services/provision/wrangler.jsonc
npx wrangler secret put SES_SECRET_ACCESS_KEY -c services/provision/wrangler.jsonc
```

## 4. Onboarding a domain + account (via the provision worker)

```sh
ADMIN=... PROV=https://bullmoose-provision.<account>.workers.dev

# one-time tenant
curl -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"tenantId":"t_bullmoose","name":"Bullmoose"}' $PROV/tenants

# wire a domain: Email Routing + catch-all → ingest, SES identity,
# DKIM CNAMEs, MAIL FROM, DMARC. Idempotent — re-run after fixing failures.
curl -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"tenantId":"t_bullmoose","domain":"example.com"}' $PROV/domains

# poll until DKIM verifies; flips the domain to active
curl -H "Authorization: Bearer $ADMIN" $PROV/domains/example.com

# create a mailbox (account + identity + route + KV + role mailboxes)
curl -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"tenantId":"t_bullmoose","domain":"example.com","localpart":"eric","displayName":"Eric"}' \
  $PROV/accounts
```

Remaining manual AWS step: an SES **configuration set** with an SNS topic
and HTTPS subscription pointed at
`https://bullmoose-submit.<account>.workers.dev/webhooks/ses`
(bounce/complaint suppression). Also request SES production access early.

## 5. Smoke test

```sh
TOKEN=... BASE=https://bullmoose-jmap.<account>.workers.dev
ACCT=t_dev__a_local

# session
curl -H "Authorization: Bearer $TOKEN" $BASE/.well-known/jmap

# Core/echo
curl -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"using":["urn:ietf:params:jmap:core"],"methodCalls":[["Core/echo",{"hello":true},"c0"]]}' \
  $BASE/api/jmap

# inbox listing: query newest 20, then fetch metadata via back-reference
curl -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],
  "methodCalls":[
    ["Email/query",{"accountId":"'$ACCT'","limit":20},"q"],
    ["Email/get",{"accountId":"'$ACCT'",
      "#ids":{"resultOf":"q","name":"Email/query","path":"/ids"}},"g"]
  ]}' $BASE/api/jmap

# mark an email read
curl -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],
  "methodCalls":[
    ["Email/set",{"accountId":"'$ACCT'","update":{"<emailId>":{"keywords/$seen":true}}},"s"]
  ]}' $BASE/api/jmap
```
