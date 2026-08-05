# Services

The deployed workers — six stateless Cloudflare Workers around one stateful
actor (the `AccountDO`, declared by `bullmoose-jmap`). Each composes the
reusable [`packages/`](../packages/README.md); each row links to that
service's own README. For *why* it's wired this way, see
[`docs/architecture/`](../docs/architecture/README.md).

| worker | role |
|---|---|
| [`bullmoose-jmap`](jmap/README.md) | the JMAP server — mail/contacts/calendar methods, auth, blob up/download, push; **declares `AccountDO`** |
| [`bullmoose-ingest`](ingest/README.md) | Email Routing target: parse inbound → R2/D1 → state bump; pokes the agent runtime |
| [`bullmoose-submit`](submit/README.md) | outbound relay (SES) + bounce/complaint webhooks |
| [`bullmoose-provision`](provision/README.md) | onboarding admin API: zones, DNS, SES identities, accounts, grants |
| [`bullmoose-agent`](agent/README.md) | agent runtime (reply/ledger), credential vault, read-only analytics MCP |
| [`bullmoose-anglebrackets`](anglebrackets/README.md) | CardDAV + CalDAV over the same core, at `dav.<domain>` |

## Deploy order = the binding graph

`submit` has no deps; `jmap` declares the `AccountDO` and binds `SUBMIT`;
everything after binds the DO (or submit) cross-script — so the sequence is
**submit → jmap → ingest → provision → agent → anglebrackets**. That order
is codified in [`infra/bootstrap.mjs`](../infra/bootstrap.mjs) (the `deploy`
phase) and narrated in [`docs/DEPLOY.md`](../docs/DEPLOY.md) §2.
