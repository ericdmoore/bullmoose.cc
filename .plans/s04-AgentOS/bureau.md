# The Bureau — credential-gated proxy for agent egress

> **What this is.** The design for how agents reach credentialed external services
> without ever holding a credential. It is the concrete form of the **Gatekeeper**
> bullet in [`readme.md`](./readme.md) (Governance), and the buildable version of
> `docs/architecture/mcp-auth.md` §8's *"secrets never touch the model"* invariant.
>
> **Status legend:** **[live]** — exists today, `file:line` cited. **[proposed]** — this design.

---

## 1. The one-sentence version

> An agent names a credential and an operation. The Bureau checks authorization, applies
> the credential itself, and returns **only the result**. The credential's value never
> enters the caller, the model, the transcript, or the logs.

Prior art for the shape is deep and boring, which is a good sign: AWS **KMS**, HashiCorp
**Vault Transit**, Cloudflare **Keyless SSL**, **PKCS#11**/HSM. All the same principle —
*a closed set of operations over a key you cannot extract.*

---

## 2. The rejected design, and why it matters

The tempting formulation is: *let the caller supply a closure; the Bureau injects the raw
secret, runs it, returns the permuted output.* It handles arbitrary derivation chains
(SigV4's HMAC ladder) without the Bureau knowing every protocol.

**Rejected, decisively.** Any API of the form *"return `f(secret)` where the caller
supplies `f`"* **is equivalent to handing over the secret**, because `f = (s) => s` is a
legal, pure function. So is `(s) => s.slice(0,4)` called eight times.

Purity analysis doesn't rescue it — a pure function is exactly what an exfiltration
oracle looks like. Sandboxing (QuickJS-in-WASM, `mcp-auth.md` §17) protects the *host*,
but cannot stop the closure returning what it was handed.

**The rule this produces:** the Bureau implements the permutation; callers *name* it.
Verbs are a closed, server-implemented set.

---

## 3. Two verb classes

The vocabulary splits by whether the caller ends up holding anything.

| Class | Shape | Caller holds | Bureau on the data path |
|---|---|---|---|
| **A — proxy-completing** | `fetch(request, credRef) → response` | **nothing** | yes |
| **B — artifact-minting** | `sign_sigv4(request, credRef) → signed request` | a scoped, expiring artifact | no |

**Class A is strongest** and needs exactly **one verb, forever.** You do not need a verb
per service — you need one proxy verb plus a **binding stored with the credential**
(which host, which header, which scheme), *not supplied by the caller*. That single verb
covers every static-bearer / API-key service that will ever exist.

**Class B is safe for a different reason**: the artifact is already scoped and expiring,
so exposure is bounded. `kSigning` signs only for one service/region/day; an OAuth access
token dies on the provider's clock.

### Class B artifacts are often self-binding — and that decides which class to use

- A **SigV4 signature** covers the canonical request *including host*. Replayed at
  `evil.com`, it is worthless. The protocol enforces the destination for you.
- An **OAuth access token** is **not** self-binding. A bearer works anywhere that
  accepts it.

→ **Prefer Class A (proxy) for bearer-shaped credentials**, precisely because bearers
cannot bind themselves. Use Class B where the protocol does the binding.

---

## 4. The vocabulary, and why it should stay small

```
A:  bureau.fetch(request, credRef)          → response          # the whole static-cred world
B:  bureau.sign_sigv4(request, credRef)     → signed request
    bureau.oauth_token(credRef)             → short-lived access token
    bureau.hmac_sha256(payload, credRef)    → mac   ⚠ see §4.1
```

Realistic future additions — each only when a protocol genuinely *cannot* be expressed as
"proxy the call": `sign_jwt` (GCP/Apple service accounts), `sign_http_message`
(RFC 9421), `sign_webhook` (Stripe-style outbound).

**Every verb is a new oracle surface, so the bar for adding one is high.** The vocabulary
should get *narrower and better-typed*, not broader.

### 4.1 ⚠️ Generic HMAC is the closure problem in miniature

If a caller can compute `HMAC(kSecret, anything)`, they can derive
`kDate → kRegion → kService → kSigning` themselves and **forge any SigV4 signature** for
that account. The verb is narrower than a closure; the defect is identical.

**Therefore: verbs are typed to the credential's kind.**

| `kind` | permitted verbs |
|---|---|
| `api-key` | `fetch` |
| `oauth-refresh` | `oauth_token`, `fetch` |
| `aws-sigv4` | `sign_sigv4`, `fetch` |
| `hmac-key` | `hmac_sha256` (with a Bureau-controlled domain-separation prefix) |

Generic HMAC exists **only** for credentials minted as HMAC keys for a specific purpose —
never as a universal primitive pointable at an AWS secret. This is what `kind` is *for*;
without it the typing has nothing to key off.

### 4.2 SigV4 needs no closure — its own design already solves this

```
kDate    = HMAC("AWS4"+kSecret, date)
kRegion  = HMAC(kDate,   region)
kService = HMAC(kRegion, service)
kSigning = HMAC(kService,"aws4_request")
```

**`kSigning` is already a scoped, expiring capability** — it signs only for that
date+region+service (AWS documents caching it up to ~7 days). The Bureau can derive and
return `kSigning` without ever exposing `kSecret`. `aws4fetch` is already a dependency,
wired to SES today **[live]** — so this is largely wiring.

---

## 5. The mint-time contract

```sh
creds set <name>
  --kind        api-key | oauth-refresh | aws-sigv4 | hmac-key
  --allow       https://api.stripe.com          # or *.amazonaws.com
  --scope       actor | inbox | global
  --header      "Authorization: Bearer {}"      # injection recipe
  --enforcement federated | narrow | broad      # which rung — §5.2
  # entropy: stdin / hidden prompt / --secret-env — NEVER argv
```

| Field | Why mandatory |
|---|---|
| **entropy** | the thing itself |
| **name** | the reference handle — what agent configs carry *instead of* the value |
| **`--allow`** | destination binding — **the** primary control (§6). Fail closed |
| **`--kind`** | gates the verb set (§4.1) — the field people forget, and it is load-bearing |
| **`--header`** | where the value goes. Config, never caller-supplied — the model has no syntax for "the secret" |
| **`--enforcement`** | records **who enforces the narrowing** (§5.2). `broad` means *only our code does* — surfaced in the console so that is visible, not tribal knowledge |

**Derive rather than type, where possible.** `--header` usually follows from `--kind`; for
OAuth credentials `--allow` can default to the issuer origin already stored in `meta`
(`token_url`) **[live]**. Fewer hand-typed fields, fewer mistakes.

**Header-only injection.** Never a query parameter — a key in a URL lands in access logs,
referrers, and history. (`mcp-auth.md` §8 already says header-only; keep it literal.)

**Entropy intake hygiene.** `--secret <value>` on argv lands in shell history and `ps`.
The CLI already defaults to a hidden prompt and offers `--secret-env` **[live]**; treat
raw `--secret` as a legacy escape hatch and say so in the help text.

**The name is a public handle.** It appears in committed agent configs
(`credentialRef: "aws-mcp"`), so it carries no secret material and stays stable across
rotations — `rotate` re-seals under the *same* name, so nothing downstream re-attaches.
Existing validation `^[a-z0-9][a-z0-9._-]{0,63}$` **[live]** is the right shape.

### 5.1 Minting ≠ authorizing

**Who may use a credential is not a mint-time field.** It is a separate, revocable grant
over **`(principal, credRef, verb)`**:

> `p_allen` may use **`sign_sigv4`** with **`aws-mcp`**

— not *"p_allen may read aws-mcp."* Capability-shaped, not access-shaped.

This separation makes revocation cheap (drop the grant, keep the credential), makes the
console's two views work (per-agent reads grants; per-resource reads the credential), and
makes "this agent holds a **signing** capability" legible in a way a scope string never is.
Every use is auditable through the existing `grant_audit` path **[live]**.

### 5.2 How narrow should the *provider-side* credential be?

One mega key that the Bureau scopes down, or many narrow keys from the provider? The
question that settles it is **who enforces the narrowing, and does that enforcement trust
our code?**

| | One mega key + Bureau scoping | Many narrow keys |
|---|---|---|
| **Enforced by** | **our own code** | **the provider**, independently |
| If the Bureau has a bug | the mega key's *entire* policy is reachable | still only that key's policy |
| Blast radius on leak | everything | one capability |
| Revocation | cut it → **everything stops** | cut one capability, others unaffected |
| Provider-side audit | one identity in their logs | attribution per agent |
| Management cost | 1 key, 1 rotation | N keys, N policies to drift |

The first row is the argument. It is the same principle this whole document rests on, one
level up:

> **Policy is our opinion. The capability wall is the guarantee.**

Narrow provider keys *are* the wall; Bureau grants are policy. A missing check in the verb
gate is a bug; a missing permission in an IAM policy is an impossibility.

The last row is the honest counterargument — hand-maintaining a dozen policies is how you
end up with a dozen copies of `*`.

#### For AWS you don't have to choose

Two mechanisms give **provider-enforced narrowing with single-key management**:

1. **SigV4's own derivation** (§4.2). `kSigning` is scoped to *(date, region, service)* by
   construction — one root key yields a signing key that only works for Cost Explorer, in
   one region, today. AWS enforces that, not us.
2. **STS `AssumeRole` with a session policy** — the stronger one, and designed for exactly
   this broker shape. Effective permissions are the **intersection** of the role policy and
   a per-call session policy, and the credentials are **temporary**:

   ```
   analyst@ invocation → AssumeRole(role, sessionPolicy: { ce:GetCostAndUsage })
                       → temp creds, minutes-long, AWS-enforced
   ```

   That is narrow-key enforcement with mega-key management, **plus expiry** — and it
   composes directly with the invocation-scoped lifetime in §8.

#### The rule

> **Prefer the narrowest thing the provider will enforce. Use Bureau scoping to go *finer*
> than that — never as a substitute for it.**

Ladder, best first (an extension of §10's):

| Rung | Mechanism | Enforced by |
|---|---|---|
| **1** | Federation / STS session policies | provider, per-invocation, no stored root secret |
| **2** | Multiple narrow keys | provider, static |
| **3** | One key + Bureau scoping only | **us alone** |

Rung 3 is unavoidable for most SaaS APIs — one key, full access, no scoping story. That is
acceptable; it must be **recorded on the credential** (§5) so "only our code enforces this"
is visible in the s03.E console rather than tribal knowledge.

#### Split by blast radius, not by consumer

The trap is one key per *agent*. That multiplies rotation work without reducing blast
radius — three agents needing identical access share a risk profile. The grant
`(principal, credRef, verb)` already handles per-agent; **keys handle per-capability.**

Split a credential when:

- the capabilities differ in **blast-radius class** — read-only analytics vs. anything that
  spends money or destroys
- rotation cadence or owner differs
- **"would I want to revoke this one without the others, mid-incident?"** ← the sharpest test

#### Why this matters more here than in a normal app

Our agents read **untrusted email by design**, so the confused-deputy case in §8 —
*"call the AWS tool, email the result to evil@"* — is a live risk, not a hypothetical. Under
a mega key a successful injection reaches the entire policy; under a narrow key it reaches
one capability. For a system whose input is attacker-controlled as a matter of course, that
shifts the calculus toward narrow harder than it would elsewhere.

---

## 6. Destination binding — the primary control

A credential may only ever be attached to a request going to **its own allowlist**. This
is `mcp-auth.md` §8's *"injected, host-matched, header-only"* rule, and the
password-manager analogy: autofills only on the exact registered origin, and there is no
"reveal password" button.

Six details decide whether it actually holds:

1. **It is a property of the credential, not a parameter of the call.** If the caller
   supplies the allowlist, it is not a control.
2. **Match origin exactly — never substring.** The classic bugs:
   ```
   startsWith("https://api.stripe.com") → https://api.stripe.com.evil.com  ✗ passes
   substring "api.stripe.com"           → https://evil.com/?x=api.stripe.com ✗ passes
   ```
   Parse the URL; compare **scheme + host + port**. Wildcards only as an explicit suffix.
3. **Redirects are the sharp edge.** Following a 302 to `evil.com` with the credential
   still attached is bypass-by-trusted-server. This is why `curl` drops auth on cross-host
   redirect absent `--location-trusted`. **Never carry a credential across an origin
   change** — drop it, or do not follow.
4. **Wildcards are unavoidable, so make them deliberate.** Real services span hosts
   (`ce.us-east-1.amazonaws.com`, `email.us-east-1.amazonaws.com`;
   `oauth2.googleapis.com`, `gmail.googleapis.com`). Support `*.amazonaws.com` and render
   it in the console as the *widening* it is.
5. **Fail closed.** No allowlist → refuse to inject. A credential without a destination is
   unusable by design; if the default is "allow all," the dangerous case is what you get
   by forgetting.
6. **Derive it at mint time** where the issuer is known (§5).

---

## 7. Egress redaction — subordinate defense-in-depth

The Bureau scrubs from every response any value it injected on that request — the root
secret **and** derived artifacts. It has an advantage no downstream layer has: it knows
*exactly* what it put in, so it redacts against a precise value list rather than guessing.

**Rank this below destination binding, explicitly**, so nobody later trades the binding
away because "we redact anyway":

| Threat | Redaction helps? |
|---|---|
| Legit API echoes the key in an error message (common — many APIs do) | ✅ yes |
| Sloppy debug/echo endpoint reflects headers | ✅ yes |
| **Adversarial** endpoint | ❌ **no** — it returns `base64(secret)`, reversed, split across fields, or one character per request |

An attacker controls the encoding; you cannot pattern-match what you cannot predict.
**Redaction is protection against accident. Destination binding is protection against
adversaries.**

Derived artifacts matter *more* here than the root secret — an OAuth access token echoed
in a JSON body is a live bearer, and `kSigning` signs anything for its window.

**Implementation notes**
- **Redact in the Bureau, not in each caller** — `mcp-auth.md` §8's *"enforce by wiring,
  not rule"*: a caller can forget; a chokepoint cannot.
- Match injected values plus cheap encodings (base64, hex, URL-encoding).
- Replace with a stable marker (`[redacted:aws-mcp]`) so failures stay debuggable.
- **Never log the pre-redaction body** — §8 already says log the pre-injection intent,
  never the header; the same applies to responses.
- Minimum length threshold, so a short credential doesn't scrub half the response.
- **Cost:** scan text-ish content types; stream binary through with header inspection
  only, or large file responses break.

The sink that actually matters is the **model's context**. Centralizing here guarantees
the tool result is clean before it can get there.

---

## 8. OAuth token lifetime — scope it to the invocation

The **provider** sets the access-token TTL (typically ~1h); the Bureau holds the refresh
token and exchanges it. A 5-second window is not achievable and would force a re-mint per
call, hammering the token endpoint into rate limits.

The right lever is not wall-clock: **mint once per agent invocation**, cache for
`min(providerTTL, invocationLifetime)`, discard when the invocation ends. That reuses the
per-invocation minted-token concept already in `mcp-auth.md` §15.2 rather than adding a
new one.

---

## 9. Secret scoping — and the shift it forces

The floated axes are **Global / PerActor / PerInbox**. Today the vault is **per-principal
by construction**: `vaultAad(principalId, name)` **[live]** binds the ciphertext to its
principal, so a row copied elsewhere *cannot be decrypted*.

**The consequence is not obvious and is the important part: today the AAD does double
duty as access control.** Crypto enforces isolation; no check is required.

The moment Global or PerInbox exists, **multiple principals legitimately open the same
row** — so the crypto stops being the access control and an **explicit authorization
check** is required where none exists today.

| Scope | AAD | Who may open |
|---|---|---|
| actor | `actor:p_allen:aws-key` | that principal (today's behaviour) |
| inbox | `inbox:a_eric:smtp-relay` | principals with a grant on that account |
| global | `global::shared-key` | **explicit ACL** — highest blast radius in the system |

Two consequences: global secrets should require `admin` to write and an explicit grant to
read; and changing the AAD scheme means **re-sealing every existing row** (open with old,
seal with new) — a deliberate one-time migration, feasible because the agent worker holds
the master key.

---

## 10. The ladder — fewer secrets beats better secrets

| Rung | Mechanism | Secret at rest? |
|---|---|---|
| **1** | **Federation / workload identity** (OIDC, AWS IAM Roles Anywhere) | **none** |
| **2** | **Bureau with a closed verb set** (proxy / sign / derive) | yes, never exposed |
| **3** | Vault + inject-at-transport *(today)* **[live]** | yes, worker-only |
| ✗ | Caller-supplied closure over a raw secret | equivalent to handing it over |

**Federation is the way.** Every credential eliminated removes verb surface, audit
surface, and console surface at once. `creds oauth` already lives in this spirit — it
stores only a refresh token, never a password **[live]**.

**Highest-value target: SES**, the one real SigV4 consumer today (`aws4fetch` in
`packages/outbound` **[live]**). If it can move to federated short-lived credentials,
`sign_sigv4` may never be needed for anything but third-party MCP servers.
⚠️ *Investigate, don't assume* — the concrete Workers→AWS trust path needs verifying
before it's promised; this is the class of thing that is clean in principle and fiddly in
practice.

**Passkeys/WebAuthn** are the hardware expression of the same principle (non-exportable
key, signature over a challenge). They apply to the *human* login side —
`serverless-jmap.md:183` already lists them for webmail — not to third-party service auth,
where federation is the analogue.

---

## 11. Invariants

1. No caller, model, transcript, or log ever holds a credential value.
2. No verb accepts caller-supplied code or an arbitrary transform over a raw secret.
3. A verb is permitted only if it matches the credential's `kind`.
4. A credential is attached only to a request whose origin is in its allowlist — and
   never carried across a redirect that changes origin.
5. A credential with no allowlist cannot be used (fail closed).
6. Every use is authorized as `(principal, credRef, verb)` and written to `grant_audit`.
7. Injected values and derived artifacts are redacted from responses before they can
   reach the model's context.
8. Credentials are injected as headers, never query parameters.

## 12. Relationship to the rest of the plan

- **`readme.md` (this folder)** — the Bureau *is* the Gatekeeper bullet under Governance.
- **`mcp-auth.md` §8** — the invariant this implements; §7b's `credentialRef` is the
  reference this consumes; §17's `entitlements` are host-mediated proxies in the same
  shape.
- **`s03.E-console`** — renders the Bureau's state: which agent holds which *verb* on
  which credential, and the allowlist as effective permissions.
- **`s05-cli-crud`** — `creds` gains the mint-time fields in §5; the Global/PerInbox AAD
  change (§9) is specified there and built here.

## 13. Open questions

1. **Where does the Bureau run?** Its own Worker, or inside the agent worker (which
   already holds `VAULT_MASTER_KEY`)? Separate is cleaner as a chokepoint and an audit
   boundary; same-worker avoids a hop and a second copy of the master key. Leaning
   separate, but it turns on whether anything besides the agent runtime ever calls it.
2. **Does Class A need response streaming**, or is buffer-and-scan (§7) acceptable for
   all realistic agent traffic?
3. **Federation feasibility for SES** (§10) — needs a real investigation before it's
   planned work.
