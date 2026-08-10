# The Bureau — dev plan

> Decomposes [`bureau.md`](./bureau.md) into ordered, buildable tasks. `bureau.md`
> had **zero tasks** (`_context.md` §6); this is the spine. Rationale for the
> order and the three open-question calls live in [`arch.md`](./arch.md).
>
> **Legend:** ✅ built · ⬚ todo · 🔬 spike (investigate, don't assume).
>
> **Built so far:** T1 (sVOL 020) · T3a + T2 · **T3 (2026-08-09)** — the key is moved,
> the grant model exists, and the Class A `fetch` runtime enforces the kind gate and
> the destination binding on the wire. **The Bureau now applies a credential and
> returns only the result**, which is `bureau.md` §1's whole sentence. What remains is
> subordinate (T4 redaction, ranked *below* binding by §7) or additive (T5's Class B
> verbs).

The whole design is one ladder (`bureau.md` §10): *a closed set of operations over
a key you cannot extract.* The tasks climb it. Each `T` cites the `bureau.md`
sections it discharges and a single **done when** — the observable that says it is
finished, not a description of the work.

---

## T1 — Mint-time contract ✅ (sVOL 020, this worktree)

Discharges **§5** (mint-time fields), **§4.1** (verb↔kind typing), part of **§6**
(destination binding *recorded*, not yet enforced).

The foundation, and deliberately first: nothing downstream can enforce `--kind` or
`--allow` if they were never minted (sVOL 020's "unlocks"), and the s03.E console
reads them. This task records intent; it does **not** enforce — there is no proxy
yet (that is T3).

- Vault `PUT /vault/credentials` accepts all four kinds (`api-key`, `oauth-refresh`,
  **`aws-sigv4`**, **`hmac-key`**) and the §5 fields `--allow` / `--header` /
  `--scope` / `--enforcement`, riding in `meta_json` (stays **E2**, no migration).
- `--scope` accepts only `actor`; `inbox`/`global` are refused with a "not yet"
  (the §9 AAD change is deferred).
- `--enforcement` defaults to `broad` and is surfaced (console-visible, §5.2).
- `POST …/rotate` re-seals a new secret under the same name; `creds show`/`list`
  return metadata only — **never** the secret (invariant 1).
- CLI `creds set --kind --allow --header [--scope] [--enforcement]`, `creds show`,
  `creds rotate`; `set` fails closed without `--allow` (§6, invariant 5).

**Done when:** a credential of each of the four kinds mints with its §5 contract,
the fields read back via `creds show` (secret never returned), and `rotate`
re-seals — all under test, with the tests proven to bite. *(Met: `vault.test.ts`,
18 tests; suite 900→918; smoke 61/0.)*

---

## T2 — Mint ≠ authorize: the grant split ✅

Discharges **§5.1**. Who may *use* a credential is not a mint-time field — it is a
separate, revocable grant over **`(principal, credRef, verb)`** ("`p_allen` may use
`sign_sigv4` with `aws-mcp`"), capability-shaped, not access-shaped.

- A grant record keyed on `(principal, credRef, verb)`, written/revoked through an
  admin surface, separate from the credential row so revocation drops the grant and
  keeps the credential.
- Every use writes to the existing `grant_audit` path **[live]** (invariant 6).
- Feeds the console's two views: per-agent reads grants, per-resource reads the
  credential (§12, s03.E).

**Done when:** an admin can grant and revoke `(principal, credRef, verb)`
independently of the credential; a revoked grant denies the verb while the
credential and its other grants survive; every attempted use is in `grant_audit`.
*(Met: `services/bureau/src/grants.test.ts`, 18 tests, proven to bite.)*

**Depends on:** T1 (a `credRef` and `kind` to grant a verb against).

### As built

- **Its own table, `bureau_grants`** — not `grants`. The tombstone *contract* is
  reused; the table is not. `grants` is account→account
  (`grantee_account_id` → `target_account_id` + JMAP scopes + collection) and
  `verifyBearer` JOINs it to `accounts` on every authenticated request. A Bureau
  grant has no target account and no scope list. Overloading it would have meant a
  nullable `target_account_id` on a `NOT NULL REFERENCES` column and teaching a hot
  authentication join to skip a row shape it must never resolve — a live auth path
  made conditional to save one table.
- **Revoke = tombstone** (`bureau_grants.revoked_at`), matching `s03.A` exactly:
  `resolveBureauGrant` filters `revoked_at IS NULL`, so the capability stops
  resolving on the next call while the row survives. Transitions are logged to the
  **existing `grant_lifecycle`** table — it has no FK by design ("history outlives
  the grant"), and `bg_`-prefixed ids keep the two grant families distinguishable
  in one forensic log.
- **Re-granting a revoked tuple reinstates it** (`revoked_at = NULL` + a fresh
  `created` event) rather than silently no-opping the way `POST /grants`'
  `ON CONFLICT DO NOTHING` does. A tombstone must not make a capability
  ungrantable forever; the history is in `grant_lifecycle` either way.
- **Admin surface on `services/provision`** (`POST`/`GET`/`DELETE
  /bureau-grants`), beside the existing grant verbs and under the same
  `ADMIN_TOKEN`. It refuses an unknown verb, an unknown principal, and an unknown
  `credRef` — a typo would otherwise mint a grant that authorizes nothing and
  looks live in the console forever.
- **Audit:** the existing `grant_audit` path, one row per *attempted* use,
  `method = bureau:<verb>:<credRef>`, `grant_id = 'none'` on a refusal. Refusals
  are audited deliberately — an agent probing for capabilities it was never
  granted is the row a success-only log would drop.

---

## T3a — Extract the Bureau Worker; move the master key ✅ — prerequisite of T3

Falls out of open question 1's resolution (`arch.md`). Structural only — no new verbs, no
behaviour change for the vault API's callers.

- Create `services/bureau` (a Worker). Bind **`VAULT_MASTER_KEY` to it and remove that
  binding from `services/agent`** — the key is *moved*, never copied. That single fact is
  what makes "you can only compute with what you have" true rather than aspirational: after
  this, the agent worker *cannot* unseal a credential, by platform, not by rule.
- **Split `services/agent/src/vault.ts`.** The metadata/reference layer (list, names,
  `meta_json`, the `creds` HTTP surface) stays; **all master-key crypto — `sealSecret`,
  `openVaultSecret` — moves to the Bureau.** Seal-on-mint moves too, or the agent worker
  still needs the key. One key, one home, zero crypto in the agent worker.
- Add a `BUREAU` service binding on `services/agent`. Update `infra/bootstrap.mjs`'s
  `DEPLOY_ORDER` and `docs/DEPLOY.md` — **the Bureau must deploy before `agent`**, which
  binds it (same class of dependency as `agent` before `ingest`; see `infra/011`).
- Caller authentication is `verifyBearer` on the invocation token (T3 step 0), so the Bureau
  needs the control-plane `DB` binding.

**Done when:** `grep VAULT_MASTER_KEY services/agent` returns nothing; minting and using a
credential both still work end to end; deploying `agent` without `bureau` fails loudly
rather than at runtime. *(Met: `services/bureau/src/vault.test.ts` 10 tests +
`services/agent/src/vault.test.ts` 21, proven to bite. The grep is clean over all
non-test source and config; `vault.test.ts` names the binding because it is the file
that asserts its absence — and runs that sweep over the whole `src/` directory, so a
future file cannot quietly reintroduce it.)*

**Depends on:** T1. **Blocks:** T3.

### As built

- **`services/bureau`**, a Worker with two bindings and nothing else: `DB` and
  `VAULT_MASTER_KEY`. No R2, KV, DO, AI or `SUBMIT` — every binding it lacks is a
  capability an attacker reaching it does not inherit.
- **The split.** `services/agent/src/vault.ts` kept names, kinds, `meta_json`, the §5
  mint-time validation and the whole `creds` HTTP surface. `sealSecret`,
  `openSecret`, `vaultAad`, seal-on-mint and `openVaultSecret` (now
  `openCredential`) moved. Sharper than the plan required: **the Bureau also writes
  the row**, so `enc_json` is touched by exactly one worker.
  `/internal/vault/verify` stayed on the agent as a pure proxy, so
  `tools/e2e-grants.mjs` and operator muscle memory keep working.
- **Fail closed.** If the Bureau refuses a seal the agent answers 502 and writes no
  row — a credential that was never sealed must not appear in `creds list`.
- **Deploy order** is now `submit → jmap → bureau → agent → ingest → provision →
  anglebrackets`, in `infra/bootstrap.mjs` `DEPLOY_ORDER`, `docs/DEPLOY.md` §2,
  `.github/workflows/deploy-mail.yml` and `services/README.md` (whose stale
  agent-after-ingest order was corrected in passing).
- **Operator action on an existing deployment:** the key must be *moved*, not
  regenerated — a fresh value cannot open rows already sealed. Runbook in
  `docs/DEPLOY.md` §2.

---

## T3 — The Bureau runtime: Class A `fetch` + destination binding ✅

Discharges **§3** (Class A, the proxy-completing verb), **§4** (`bureau.fetch`),
**§6** (destination binding as the *enforced* primary control), **invariants 1–6, 8**.
**This is the load-bearing task** — the one verb that "covers every static-bearer /
API-key service that will ever exist" (§3), and the first place anything is actually
*enforced*.

**Open question 1 is RESOLVED** (`arch.md`, ratified 2026-08-09): the Bureau is its **own
Worker**, `VAULT_MASTER_KEY` bound only to it, and callers authenticate with an **opaque
per-invocation bearer token verified by `verifyBearer`** — not a JWT, because issuer and
verifier are the same service and a JWT would route around the `008` / `s03.A` revocation
controls. That makes **T3a a prerequisite of T3.**

On every call the runtime, in order:

0. ✅ **Verifies the caller** — `verifyBearer` on the presented invocation token, so identity
   is *authenticated*, never self-asserted in the body. This is what stops a prompt-injected
   `editor@` (sVOL `014` reads untrusted email) from exercising `travel@`'s grant: the
   service binding proves which *worker*; only the token proves which *agent*.
   *(Built in T3a — `services/bureau/src/grants.ts` `authorizeUse`.)*
1. ✅ **Authorizes** `(principal, credRef, verb)` against T2's grants, else refuse.
   *(Built in T2, with the `grant_audit` write of invariant 6.)*
2. ✅ **Gates the verb by kind** (§4.1): `fetch` is legal for `api-key`/`oauth-refresh`/
   `aws-sigv4`; a verb outside the kind's set is refused.
3. ✅ **Binds the destination** (§6): parse the request URL, compare **scheme+host+port**
   exactly against the credential's `allow` (wildcards only as an explicit suffix),
   **fail closed** when there is no allowlist, and **drop the credential across any
   redirect that changes origin** — never `startsWith`, never substring.
4. ✅ Injects the credential **as a header only** (invariant 8), per the stored
   `--header` recipe — caller never names the secret.
5. ✅ Returns **only the result**; the value never enters caller, model, transcript, log.

**Done when:** an agent calls `bureau.fetch(request, credRef)` and reaches its
allowlisted host with the credential injected server-side; a request to any other
origin, a cross-origin redirect, an ungranted verb, or a credential with no
allowlist are each refused; the caller receives a response and never the credential.
*(Met: `services/bureau/src/binding.test.ts` 27 + `fetchVerb.test.ts` 35, driven
through the real worker with a really-sealed credential, a really-minted bearer and a
recording fake upstream. Proven to bite — see "Proven to bite" below.)*

**Depends on:** T1 (kind + allow + header), T3a (the Worker + the key), T2 (authorization).

### As built

- **Two modules, split along the pure/effectful line** (`devPrinciples.md`).
  `services/bureau/src/binding.ts` is the whole decision — the §4.1 kind table, the
  §6 allowlist parser and matcher, the `--header` recipe — with no I/O and no
  secret, so §6's adversarial cases are unit tests that run in microseconds.
  `services/bureau/src/fetchVerb.ts` is the shell that unseals, injects and sends.
- **The kind gate lives in `handleUse`, not in the verb.** It is a property of the
  *vocabulary*, so a Class B verb added in T5 inherits it by arriving after it. The
  remaining 501 is now reached only from *behind* the gate.
- **Nothing is unsealed until the request is known to be legal.** Destination,
  allowlist, kind and recipe are all decided while the worker holds nothing;
  `openCredential` is called on the line before injection. Every refusal costs a
  decryption that never happened, and the secret's lifetime is the shortest window
  in which the work can be done.
- **The allowlist is re-parsed at enforcement time**, not trusted in the canonical
  form `services/agent`'s mint path wrote. A row can outlive the validation that
  produced it — older mint path, operator edit, restored backup — and the
  guarantee has to hold regardless of how the row got there.
- **One malformed allowlist entry poisons the whole list.** Skipping it would
  silently narrow a policy nobody re-read; refusing makes an operator's typo a
  visible failure at first use.
- **Redirects: `redirect: "manual"`, and any origin change ends the call.** Not
  "follow it without the header" — that would make the Bureau a general-purpose
  relay fetching attacker-chosen URLs on an agent's behalf, which is a different
  hole in the same wall. This is the strict reading of invariant 4: a hop to
  another *allowlisted* origin is refused too. The allowlist is re-checked on
  every hop even though a same-origin hop cannot fail it, because a control that
  holds by argument is one refactor away from not holding at all.
- **The caller supplies a URL, a method, headers and a body — and no policy.**
  Naming the injected header is *refused*, not stripped. `allow` / `header` fields
  smuggled into the request body are inert (§2).
- **`set-cookie` is dropped on the way out**: a session cookie minted for the
  Bureau by an allowlisted host is a bearer-shaped artifact the caller was never
  granted.
- **Result envelope** `{ok, status, headers, body, bodyEncoding, redirects}`.
  Text-ish content types come back as text (what T4 will scan); everything else is
  base64 and passes through with header inspection only, per §7. An upstream 402
  is reported as a *result*, not adopted as a Bureau refusal.

**Proven to bite.** Reverting only the source drops `binding.test.ts` and
`fetchVerb.test.ts` entirely (3 of 4 bureau files fail). Seven targeted mutations,
each reverted after: exact host → `startsWith` (3 fail) · wildcard suffix →
`includes` (3) · `redirect:"manual"` → `"follow"` (1) · fail-closed → fail-open on a
missing allowlist (2) · kind gate always permits (6) · also inject as a query
parameter (3) · origin-change refusal removed (3).

---

## T4 — Egress redaction ⬚

Discharges **§7**, **invariant 7**. A chokepoint in T3's response path — enforced by
wiring, not by asking each caller (§7, `mcp-auth.md` §8).

- Scrub from every response every value the Bureau injected on that request — root
  secret **and** derived artifacts — matching cheap encodings (base64/hex/URL) above
  a minimum length, replacing with a stable marker (`[redacted:<name>]`).
- Scan text-ish content types; stream binary through with header inspection only.
- **Never log the pre-redaction body.**
- Ranked **below** destination binding, explicitly (§7): redaction stops accidents;
  binding stops adversaries. It must not be sold as a substitute for T3.

**Done when:** an injected value echoed by a (cooperative) endpoint is replaced by
its marker before the response leaves the Bureau; binary passes through untouched;
no pre-redaction body is logged. *(Adversarial echo is out of scope by design — §7.)*

**Depends on:** T3 (the response path to filter).

**Where to start:** T3 left the seam wired. `services/bureau/src/fetchVerb.ts` exports
`EgressFilter = (text, injected) => text` and `runFetchVerb` takes it as an option,
defaulting to a passthrough; `renderResult` is the ONE place a Bureau result crosses
back to a caller, and it already receives the exact list of values the request put on
the wire — so T4 replaces the default and changes nothing else. The text/binary split
is already made there (`bodyEncoding`), so "scan text-ish, pass binary through" needs
no new branch. `fetchVerb.test.ts`'s *"hands the egress filter the exact value that
was injected"* drives that seam end to end today.

---

## T5 — Class B verbs: `sign_sigv4`, `oauth_token`, `hmac_sha256` ⬚

Discharges the rest of **§4**, **§4.2**, **§8**, **invariants 2–3**. Class B mints a
scoped, expiring artifact (§3) instead of proxying; each is added **only** because
its protocol cannot be expressed as "proxy the call," and each is typed to its kind.

- **`sign_sigv4`** (`aws-sigv4`) — derive and return `kSigning`, already a scoped
  capability (date+region+service, §4.2); `aws4fetch` is a live dependency, so this
  is largely wiring.
- **`oauth_token`** (`oauth-refresh`) — exchange the held refresh token; cache for
  `min(providerTTL, invocationLifetime)`, discard when the invocation ends (§8,
  reusing `mcp-auth.md` §15.2), **not** a wall-clock window.
- **`hmac_sha256`** (`hmac-key` only) — with a **Bureau-controlled domain-separation
  prefix**; never pointable at an AWS secret (§4.1 — generic HMAC over an AWS key
  forges any SigV4 signature).

**Done when:** each verb is callable only for its matching kind, returns a scoped/
expiring artifact (never the root secret), and reuses T2 authz + T4 redaction; a
verb/kind mismatch is refused (invariant 3).

**Depends on:** T3 (runtime, authz, binding), T4 (redaction).

---

## T6 — Secret scoping: the AAD shift (§9) ⬚ — DEFERRED

Discharges **§9**. Today `vaultAad(principalId, name)` makes the crypto *itself* the
access control — a row copied elsewhere cannot be decrypted, so no check is needed.
The moment `global`/`inbox` scope exists, multiple principals legitimately open one
row, so the crypto stops being access control and an **explicit authorization check
is required where none exists today** — the non-obvious, important consequence.

- New AAD scheme (`actor:` / `inbox:` / `global:`), an explicit ACL for `global`
  (admin to write, grant to read — highest blast radius in the system).
- A **one-time re-seal migration**: open every row with the old AAD, seal with the
  new — feasible because the agent worker holds the master key.
- T1 already accepts `--scope` and refuses `inbox`/`global` with "not yet"; this task
  is what flips them on.

**Done when:** `inbox`/`global` credentials mint and open under an explicit ACL, the
existing rows are re-sealed under the new AAD in one migration, and an unauthorized
principal is denied by the new check (not merely by decryption failure).

**Depends on:** T1 (the `--scope` flag stub). Independent of T3–T5; sequenced late so
the re-seal runs once, after the schema of a credential row has settled.

---

## T7 — Federation for SES (§10) 🔬 — SPIKE, not a milestone

Discharges **§10**. *"Federation is the way"* — every credential eliminated removes
verb, audit, and console surface at once. SES is the one real SigV4 consumer today
(`aws4fetch` in `packages/outbound` **[live]**); if it moves to federated short-lived
credentials, `sign_sigv4` (T5) may never be needed for anything but third-party MCP.

⚠️ **Investigate, don't assume** (§10, §13.3). The concrete Workers→AWS trust path
must be *verified* before it is promised — see `arch.md`'s open-question-3 verdict.
Time-box a spike; do not schedule it as committed work until the spike returns green.

**Open question 1's resolution changes this materially.** The spike stalled on *"Workers
issues no AWS-federatable OIDC token."* That was framed as a platform gap; it is really a
missing component we can supply. **An isolated Bureau holding a signing key and publishing a
JWKS at a well-known URL *is* an OIDC provider** — the one place a JWT is correct, because
the verifier (AWS) cannot call us and must verify offline:

```
Bureau self-signs a short-lived JWT  ->  sts:AssumeRoleWithWebIdentity
AWS verifies against the published JWKS  ->  temporary STS credentials  ->  SES
```

That reaches §10's top rung: **no long-lived AWS secret at rest** — only a signing key that
never leaves the Bureau and which, unlike an SES key, grants nothing on its own. It is an
honest *rung*, not rung zero: a signing key is still a secret at rest, but it is one secret,
in one Worker, exchangeable for narrowly-scoped short-lived creds via an STS session policy.

Prerequisite: the JWKS must be publicly reachable and stably hosted — a route on the Bureau
(or the marketing site) plus a key-rotation story. **That** is the real spike now, not "is
federation possible."

**Done when:** a spike has either (a) demonstrated a Worker sending through SES with **no**
long-lived AWS secret at rest, or (b) recorded why that is not achievable today and closed
the question — either outcome unblocks the plan.

**Depends on:** T3a (the Bureau Worker that would host the signing key + JWKS route);
informed by T5 (the baseline it hopes to retire).

---

## Order at a glance

```
T1 mint-time contract ✅ ──▶ T3a extract Bureau ✅ ──▶ T2 grant split ✅ ──▶ T3 runtime + fetch + binding ✅ ──▶ T4 redaction ──▶ T5 Class B verbs
                        └──▶ T6 AAD re-scope (deferred, independent)
                             T7 SES federation (spike, informs whether T5's sign_sigv4 is ever load-bearing)
```

Climb the ladder bottom-up: record the contract (T1) → decide who may use it (T2) →
enforce it on the wire (T3) → clean the egress (T4) → add the narrow Class-B oracles
(T5). T6 and T7 hang off the side — one a deferred migration, one a spike.
