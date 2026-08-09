# The Bureau — dev plan

> Decomposes [`bureau.md`](./bureau.md) into ordered, buildable tasks. `bureau.md`
> had **zero tasks** (`_context.md` §6); this is the spine. Rationale for the
> order and the three open-question calls live in [`arch.md`](./arch.md).
>
> **Legend:** ✅ built here (sVOL 020) · ⬚ todo · 🔬 spike (investigate, don't assume).

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

## T2 — Mint ≠ authorize: the grant split ⬚

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

**Depends on:** T1 (a `credRef` and `kind` to grant a verb against).

---

## T3 — The Bureau runtime: Class A `fetch` + destination binding ⬚

Discharges **§3** (Class A, the proxy-completing verb), **§4** (`bureau.fetch`),
**§6** (destination binding as the *enforced* primary control), **invariants 1–6, 8**.
**This is the load-bearing task** — the one verb that "covers every static-bearer /
API-key service that will ever exist" (§3), and the first place anything is actually
*enforced*.

Resolving **open question 1** (where the Bureau runs) is a prerequisite — see
`arch.md`. On every call the runtime, in order:

1. **Authorizes** `(principal, credRef, verb)` against T2's grants, else refuse.
2. **Gates the verb by kind** (§4.1): `fetch` is legal for `api-key`/`oauth-refresh`/
   `aws-sigv4`; a verb outside the kind's set is refused.
3. **Binds the destination** (§6): parse the request URL, compare **scheme+host+port**
   exactly against the credential's `allow` (wildcards only as an explicit suffix),
   **fail closed** when there is no allowlist, and **drop the credential across any
   redirect that changes origin** — never `startsWith`, never substring.
4. Injects the credential **as a header only** (invariant 8), per the stored
   `--header` recipe — caller never names the secret.
5. Returns **only the result**; the value never enters caller, model, transcript, log.

**Done when:** an agent calls `bureau.fetch(request, credRef)` and reaches its
allowlisted host with the credential injected server-side; a request to any other
origin, a cross-origin redirect, an ungranted verb, or a credential with no
allowlist are each refused; the caller receives a response and never the credential.

**Depends on:** T1 (kind + allow + header), T2 (authorization).

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

**Done when:** a spike has either (a) demonstrated a Worker sending through SES with
**no** long-lived AWS secret at rest, or (b) recorded why that is not achievable
today and closed the question — either outcome unblocks the plan.

**Depends on:** nothing structurally; informed by T5 (the baseline it hopes to retire).

---

## Order at a glance

```
T1 mint-time contract ✅ ──▶ T2 grant split ──▶ T3 runtime + fetch + binding ──▶ T4 redaction ──▶ T5 Class B verbs
                        └──▶ T6 AAD re-scope (deferred, independent)
                             T7 SES federation (spike, informs whether T5's sign_sigv4 is ever load-bearing)
```

Climb the ladder bottom-up: record the contract (T1) → decide who may use it (T2) →
enforce it on the wire (T3) → clean the egress (T4) → add the narrow Class-B oracles
(T5). T6 and T7 hang off the side — one a deferred migration, one a spike.
