# Agent handoff — 2026-08-26

Written at the end of a long session, for whoever picks this up next (agent or
human). Everything below was verified against the live account or the repo at
the time of writing, not recalled. Where something is unverified, it says so.

---

## 1. Read this first: three things need a human

None of these are blocked on engineering. They need a credential or a decision
that an agent should not take unilaterally.

### a. `dl.bullmoose.cc/cli/install.sh` is **404 right now**

PR #380 merged. `README.md` and `docs/install-cli.md` now tell people to run:

```sh
curl -fsSL https://dl.bullmoose.cc/cli/install.sh | sh
```

**That URL does not exist yet.** `release-cli.yml` only mirrors to R2 on tags
matching `cli-go/v*`, so the installer is published on the **next CLI release
tag**, not on merge to main. Until then the documented one-liner 404s.

Fix: cut a `cli-go/v*` tag (the workflow does the rest), or accept the gap
knowingly. Verified 404 on 2026-08-26.

### b. Two dead Cloudflare Pages projects still exist

`bullmoose-app` and `bullmoose` serve nothing — the app, previews and the
marketing site all moved to R2 + workers (#368/#369/#371/#375/#377). Deleting
them needs the **Pages-scoped token**, which exists only as the repo secret
`BULLMOOSE_SITE_DEPLOY_TOKEN`. An agent cannot reach it.

Dashboard: Workers & Pages → project → Settings → Delete, twice. Then
`Cloudflare Pages: Edit` can be dropped from that token — nothing else uses it.

No urgency: nothing serves from either, and there are **no `*.pages.dev` CNAMEs
left in the zone**, so the subdomain-takeover risk is already defused.
Tracked in **#371**.

### c. PR #383 needs two repo secrets before it can go green

It adds a post-deploy delivery check that needs:

- `BULLMOOSE_SMOKE_TOKEN` — an account token that may send and read its own mail
- `BULLMOOSE_SMOKE_ADDRESS` — that account's address

**Use a dedicated smoke account, never a real mailbox** — the check creates and
destroys messages. Deliberately not minted by an agent: it is a production
account plus a credential.

---

## 2. What happened this session

### The incident (resolved)

**Inbound mail bounced for ~14 hours** on 2026-08-24/25. Root cause: a
`deploy-mail` run shipped s33 code whose queries name `ceremonies` and
`emails.assurance_json` against a shard that had neither. The agent's 5-minute
cron threw from 18:05; ingest threw on every inbound message from 21:30, so
Cloudflare Email Routing bounced. It surfaced because Eric received a bounce —
nothing else reported it.

Fixed: migrations applied, verified against live D1. **A test email delivered
successfully** with `assurance_json` populated — the first row ever written
with that column. Mail is confirmed working, not inferred.

The part worth remembering: **the repo predicted this outage in prose.**
`emails-assurance-json` carried `blocks: "deploy"`, and `migrations.test.ts`
pinned it with the sentence *"ingest against an un-migrated shard fails EVERY
delivery"* — written before it happened. No deploy path read that field. A
marker nothing enforces is worse than no marker: in review the list looks like
a safety mechanism.

### Cloudflare Pages is entirely gone

Chased from "why is there an `npx` in the install receipt". Three static hosts
now, sharing one `serve.ts` and one uploader:

| worker | serves |
|---|---|
| `webhost` | `app.bullmoose.cc` (the webmail, from R2) |
| `webpreview` | `<pr>-preview.bullmoose.cc` (per-PR previews) |
| `sitehost` | `bullmoose.cc` (marketing + guides) |

Two findings worth keeping:

- **Preview hostnames must be `<n>-preview`, not `preview-<n>`.** Cloudflare
  refuses any route whose hostname wildcard is not leading (API code 10022),
  and `<n>.preview.<zone>` is a multi-level wildcard that free Universal SSL
  does not cover. Exactly one shape survives both constraints.
- **The apex was answering `200` with the homepage for every nonexistent URL**
  for months (Pages SPA-falls-back when a build has no `404.html`). That is why
  `/.well-known/jmap` returned a webpage to JMAP clients doing RFC 8620 §2.2
  autodiscovery. `sitehost` 404s honestly and the site now ships a real 404.

`_redirects` / `_headers` are kept as the interface — compiled by
`bullmoose cloud site push` at **push time**, so a typo is a failed deploy with
a file and line rather than a silent runtime change. Unsupported syntax is
**refused, never skipped**.

---

## 3. Current state

**Everything green and verified live** (2026-08-26):

| | |
|---|---|
| `app.bullmoose.cc/api/session` | 401 (jmap alive) |
| `bullmoose.cc/` | 200 |
| `bullmoose.cc/nope` | 404 (the fix) |
| Inbound mail | delivering |
| Worker exceptions, post-deploy | none |

**Merged this session:** #368, #370, #374, #377, #380, #382.

**Open:** **#383** only — all checks pass, needs the secrets in §1c.

**Open issues of ours:** #371 (Pages teardown, see §1b). Older residue: #337,
#338, #339, #351, #352, #353, #243.

---

## 4. Guards added — what they do and do not cover

Two complementary things, and the distinction matters:

**`bootstrap.mjs blockers`** (merged, #382) — refuses to deploy when a
migration marked `blocks: "deploy"` is unapplied. Runs in `deploy-mail.yml`
before the first worker, and inside `deploy()` so `bootstrap.mjs deploy` cannot
route around it. An unreadable check is a **refusal, not a pass** (a false
refusal costs one re-run; a false pass costs every delivery until a human
notices). Verified in CI on the deploy that followed.

**`tools/smoke-mail.mjs`** (PR #383) — sends a message to itself after the
workers ship and waits for it to arrive. Token-only: no browser, no passkey, no
human.

The gate only catches failures somebody **predicted and remembered to tag**.
The smoke test predicts nothing — it just notices mail is broken. Keep both;
they fail for different reasons.

**All 12 workers now have `observability` enabled** and it is deployed. Before
this, not one mail worker emitted logs, which is why 14 hours of failure had to
be reconstructed from `wrangler tail` plus a GraphQL analytics query.

---

## 5. Decisions taken (do not silently reverse)

- **E2E stays token-only. The tea ceremony stays human.** A CDP
  virtual-authenticator harness was built, found a real bug, and was then
  **deleted on purpose** — the ceremony is a human ritual by design.
- **`residentKey: "required"`** on passkey registration (in #383). Not a
  ceremony change: `assertionOptions` sends `allowCredentials: []` for **login**
  too, so a non-discoverable credential locks someone out entirely. Pinned by a
  unit test; verified by reverting the fix and watching it fail.
- **No test-only bypass in security paths.** When the origin check made local
  testing awkward, the answer was to make the browser resolve the real hostname
  — not to make the expected origin configurable. Nothing test-shaped ships.
- **The webmail upload has one implementation** (`cli-go/internal/cloud/webmail.go`),
  with three front doors. CI calls the CLI rather than re-looping
  `wrangler r2 object put` in bash, because the rules (content types, key
  escaping, the `index.html` requirement) would drift.

---

## 6. Local environment notes

- **The main checkout is on branch `type-aware-lint`** (Eric's in-progress
  work). Do not disturb it. Worktrees:
  `.claude/worktrees/cli-install` (on `ceremony-e2e`, #383) and
  `.claude/worktrees/merge-ta`.
- **Never use bare `git stash`** — the stash stack is shared across worktrees
  and other sessions may pop it.
- `CF_API_TOKEN` lives in `/Users/alpaca/Web/bullmoose.cc/.env`. It has D1, R2,
  Workers and DNS, but **not Pages** (hence §1b) and not
  `Zone > Email Routing > Read` (so `cloud doctor` shows one ✗ that is a token
  gap, not a mail gap).
- **Browser E2E needs the sandbox off** — Chromium hangs on a Mach bootstrap
  denial otherwise.
- `npm run typecheck` at the root **excludes webmail**; use
  `npm run -w webmail typecheck` for that workspace.
- Local dev: `infra/localDev.sh --seed`. Schemas live at
  `packages/mailstore/sql/{control-plane,data-plane}.sql` — **not** `schema/`.
- Ritual before any commit: `npm run fmt && npm run lint && npm run typecheck &&
  npm test`, plus `gofmt`/`go vet`/`go test ./...` in `cli-go/`.

---

## 7. Suggested next steps

1. Set the two secrets, merge **#383** (§1c).
2. Cut a `cli-go/v*` tag so the documented installer URL stops 404ing (§1a).
3. Delete the two Pages projects, narrow the token, close **#371** (§1b).
4. Optional follow-up noted in #383: a `create()` failure currently surfaces the
   raw browser string *"The operation either timed out or was not allowed"*,
   which tells nobody they need a device that can store passkeys. Correct
   behaviour, unkind delivery.
