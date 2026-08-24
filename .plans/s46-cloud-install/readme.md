# s46 — cloud install · *one binary, one token, your domain*

> **Status: BUILT — T1–T6 shipped 2026-08-23, six PRs, one open proof.**
> T1 [#330](https://github.com/ericdmoore/bullmoose.cc/pull/330) stack
> publishing (`release-stack.yml` → dl.bullmoose.cc/stack, maiden
> `stack/v0.1.0` live) + T2a [#331](https://github.com/ericdmoore/bullmoose.cc/pull/331)
> manifest secrets story. T2 [#332](https://github.com/ericdmoore/bullmoose.cc/pull/332)
> `cloud plan` (probe + pure plan, refusals first, 403s name the scope).
> T3 [#333](https://github.com/ericdmoore/bullmoose.cc/pull/333) `cloud
> install` (one honest yes; binding-graph order; ids from the account;
> resumable by construction). T4 [#334](https://github.com/ericdmoore/bullmoose.cc/pull/334)
> the mail BRIDGE — the path itself is provision's `addDomain` via `admin
> domain add` (building it twice would drift), so T4 = workers.dev
> reconciliation, the `admin init` hand-off, and read-only `cloud doctor`.
> T5+T6 [#335](https://github.com/ericdmoore/bullmoose.cc/pull/335):
> secrets NEVER rotate on re-run (the vault-orphaning T3 bug, killed),
> our-shaped DNS reuses (shapes verified against production: Worker custom
> domains are proxied `AAAA 100::`), Pages home + the one npx webmail
> command, `cloud update` (= install, reconcile makes it true), and
> docs/install-cloud.md.
>
> **Open: the risk-register live proof.** "Works on Eric's account" is
> unfalsified until `cloud install` runs on a second account / spare zone
> end to end (delivered message in, DKIM-aligned out). Needs a token only
> Eric can mint; everything up to that gate is live-smoked read-only.
>
> Originally DESIGN, decided 2026-08-23 (Eric), sequenced after s37,
> written the day the question crystallised: *"if you download the CLI and
> have a CF token(s) — you can get bullmoose-setup on your own domain?"*
> The answer was NO by exactly one layer. The layer now exists; the design
> below is preserved as written.

## The boundary, stated as a table

| you have | you can do today |
|---|---|
| the CLI binary (dl.bullmoose.cc) | full mail client, agents, operator admin — against an EXISTING deployment |
| + admin credentials to a provision worker | stand up tenants, domains, accounts, agents — `admin`'s six-verb onboarding |
| + only a CF token and a domain | **nothing** — there is no deployment to administer; the workers, D1 schema, R2 buckets and mail routing only come into existence via THIS repo's CI with THIS repo's secrets |

The CLI is a complete OPERATOR of a bullmoose cloud. s46 makes it a CREATOR
of one: `bullmoose cloud install` ends exactly where `admin init` begins.

## The skeleton already exists (the week of 2026-08-22 built it by accident)

- **dl.bullmoose.cc** — the R2 bucket + publish pipelines (s08 T7, popcorn).
  Worker BUNDLES are one more artifact class: CI already builds them to
  deploy them; publishing them to `stack/<version>/` with a checksummed
  manifest is a small step, and `cloud install` downloads instead of builds —
  no Node, no checkout, the same move that freed the CLI itself.
- **infra/ migrations** — the D1 schema as ordered .sql, already drift-tested.
- **CF-API muscle in Go** — the admin/provision clients; the release pipeline
  drives R2 via the same token model the installer will hold.
- **The consent model, twice proven** — `local setup`'s ladder (probe → plan
  → one honest yes → verify) and popcorn's planner (plan/apply split,
  refusals ABOVE prompts, `your flag > what runs > the template`). The cloud
  installer is the third instance of the same shape, not a new philosophy.

## The shape

`bullmoose cloud install --zone <domain>` with a CF token in the environment:

1. **PROBE** (read-only): token permissions enumerated against what the plan
   needs; zone ownership; anything bullmoose-shaped already present.
2. **PLAN** (printed whole): every resource by name — D1 database + the
   migrations to apply, R2 buckets, each worker with its bindings and routes,
   DNS records, the secrets to MINT LOCALLY. Idempotent by construction: a
   re-run reconciles, so a half-applied install is a resumable state, not a
   broken one.
3. **ONE YES** — or `--yes` typed deliberately. Refusals sit above the
   prompt: the installer NEVER destroys (no uninstall verb in v1; deletion is
   a documented manual act), and never overwrites a resource it did not make.
4. **APPLY → VERIFY → HAND OFF**: end state is a printed `admin init --url …
   --token …` and the six onboarding verbs that already exist.

`bullmoose cloud update` is the same machinery pointed at a newer
`stack/<version>/` — the fullmonty of the cloud half.

## The genuinely hard part, named now: mail arrival

Workers, D1 and R2 are API calls. EMAIL is not:

- **Inbound** needs MX records and CF Email Routing (or an SES inbound path)
  wired to the ingest worker. Records the zone token can write; enablement
  and verification steps it cannot always skip.
- **Outbound** needs a sending provider (SES today — the region/keys in
  .env) with its own signup, sandbox exit, and DKIM/SPF/DMARC story.
  BYO-provider is config the installer accepts and VERIFIES, never an
  account it conjures.

The installer's honesty bar: it WALKS these steps and verifies each
(delivered test message in, DKIM-aligned test message out) rather than
printing "done" over an unverified mail path. A mail product that installs
but cannot receive mail installed nothing.

## Secrets custody

Everything minted (admin token, vault master key, signing keys) is generated
LOCALLY and lands only in the user's CF account and their CLI config. The
project sees nothing — that is the point of the section.

## Order of work (rough Ts, to be firmed when reached)

- **T1** publish `stack/<version>/` bundles + manifest from CI (checksummed,
  latest-last, the popcorn layout).
- **T2** probe + plan, pure and read-only — testable like popcorn's
  plan_test.go, no account needed.
- **T3** apply, core resources (D1 + DDL, R2, workers/bindings/routes).
- **T4** the mail path: DNS writes, routing walk, in/out verification.
- **T5** hand-off + the quickstart doc (three commands from zero to inbox).
- **T6** `cloud update`.

## Risks, named

- **"Works on Eric's account."** The existing deploys have only ever run
  against one account; assumptions hide there. Test on a second CF account
  EARLY (T3), not at the end.
- **Token-scope UX.** The exact permission set the token needs is the first
  thing a stranger hits; document it as a copy-pasteable custom-token recipe
  and make the probe's "your token lacks X" errors name the scope, not the
  HTTP code.
- **CF API churn.** Pin against the API versions the release pipeline
  already exercises; the manifest carries the API expectations of its
  version.
- **Scope discipline.** The installer provisions the STACK; it does not grow
  tenant-management features (admin owns those) or a DNS manager. One layer.

## Related

- [[s37-your-own-box]] — the visibility join this follows; both serve the
  same claim ("you own the hardware and the data"), from opposite ends
- [[s08-go-cli]] — dl.bullmoose.cc and the one-binary premise
- packages/popcorn/deploy — the plan/apply consent model this reuses
- `bullmoose admin` — the hand-off target; s46 ends where its six verbs begin
