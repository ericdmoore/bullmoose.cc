# bullmoose.cc
My hat is still in the ring

## Mail platform

A serverless JMAP mail server (multi-domain) is being built in this repo:
Cloudflare Workers + Durable Objects + D1 + R2 for the mailstore and sync,
AWS SES for outbound. Design doc: [`docs/architecture/serverless-jmap.md`](docs/architecture/serverless-jmap.md).

```
packages/jmap-core    JMAP wire types, errors, method dispatch (RFC 8620)
packages/account-do   per-account Durable Object: state, changelog, WS push
packages/mailstore    D1 schemas + data access, R2 blob keyspace
packages/mime         minimal RFC 5322 builder for drafts
packages/outbound     OutboundRelay adapter (SES via SigV4 fetch)
packages/cli          `bullmoose` — JMAP sync client with a local SQLite
                      message log (same schema as the server data plane)
services/jmap         JMAP endpoint: session, Email/Mailbox/Thread/Identity/
                      EmailSubmission methods, upload/download, ws push
services/ingest       Email Routing target: parse → R2/D1 → state bump
services/submit       outbound relay (SES) + bounce/complaint webhook
services/provision    multi-domain onboarding: CF zone/DNS + SES identity
infra/                bootstrap runbook (D1/R2/KV creation, deploy order)
tools/                end-to-end test suites (run against wrangler dev)
src/                  the existing bullmoose.cc Fresh site (unchanged)
```

Dev: `npm install && npm run typecheck`, then `npm run dev:jmap`.
Deploy: see [`docs/DEPLOY.md`](docs/DEPLOY.md).

### Roadmap

1. **Deploy** — first light: real inbound at bullmoose.cc (`docs/DEPLOY.md`)
2. **SRV autodiscovery** — `bullmoose init eric@moore.coffee` (RFC 8620 §2.2)
3. **Multi-account CLI** — one session, many inboxes, batched sync
4. **Armed-responder policies + agent harness** — vacation/watchdog/follow-up
   as one primitive; `urn:bullmoose:agent` collections + `packages/agent-harness`
   (see `docs/architecture/agent-integration.md`)
