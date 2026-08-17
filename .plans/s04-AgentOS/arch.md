# The Bureau — architecture notes

> Companion to [`devPlan.md`](./devPlan.md): **why** the tasks are ordered as they
> are, and a firm resolution of [`bureau.md`](./bureau.md) §13's three open questions.
> `bureau.md` is the design; this decides the calls it left open.

---

## Why this task order

`bureau.md` §10 frames the whole thing as a ladder — _a closed set of operations over
a key you cannot extract._ The tasks climb it, and the ordering is forced by three
dependencies, not by preference:

1. **You cannot enforce a field you never minted.** The verb gate (§4.1) keys off
   `kind`; destination binding (§6) keys off `allow`. Both are meaningless until a
   credential _carries_ them — so the mint-time contract (**T1**, sVOL 020) is first,
   and is exactly the piece that is fully decided and independent of every open
   question. It records; it does not enforce.

2. **You cannot authorize a call without an authorization model.** The Bureau's first
   act on any verb is to check `(principal, credRef, verb)` (§5.1). That grant model
   (**T2**) is data + admin surface with no runtime of its own, so it slots between the
   contract and the runtime that consumes it.

3. **Enforcement is one chokepoint, built once, then reused.** The runtime (**T3**) is
   where authz, verb-gating, destination binding and header injection first actually
   _bite_ — and it is built around the single Class-A `fetch` verb because that verb
   "covers every static-bearer / API-key service that will ever exist" (§3). Egress
   redaction (**T4**) is a filter on _that_ runtime's response path, so it follows T3.
   The Class-B verbs (**T5** — `sign_sigv4`, `oauth_token`, `hmac_sha256`) are added
   last among the core work because each simply reuses T3's authz+binding and T4's
   redaction; adding them earlier would mean building those guarantees twice.

Two tasks hang off the side rather than on the spine:

- **T6 (AAD re-scoping, §9)** is deferred and sequenced late _on purpose_: it re-seals
  **every** credential row under a new AAD, so it should run once, after a row's shape
  has settled — not in the middle of T1–T5. T1 already accepts `--scope` and refuses
  the non-`actor` values, so nothing blocks on it.
- **T7 (SES federation, §10)** is a **spike, not a milestone** — see open question 3.
  Its result decides whether T5's `sign_sigv4` is ever load-bearing beyond third-party
  MCP, which is why it is tracked but not scheduled as committed work.

The through-line: **policy is our opinion, the capability wall is the guarantee**
(§5.2). Every task that moves enforcement from "our code checks" toward "the protocol
or the provider makes it impossible" is climbing the ladder; the order is just the
rungs in sequence.

---

## Open question 1 — Where does the Bureau run?

> _Its own Worker, or inside the agent worker (which already holds
> `VAULT_MASTER_KEY`)?_ (`bureau.md` §13.1)

## ✅ RESOLVED — isolated Worker. Ratified by the user, 2026-08-09.

**The Bureau is its own Cloudflare Worker.** `VAULT_MASTER_KEY` is bound **only** to it.
The agent worker never holds the key and therefore cannot unseal a credential — not by
discipline, by the platform.

The governing principle, in the user's words:

> _You can only compute with what you have. WebFetch, bullmoose MCP, etc. Anything else
> needs the Bureau._

That is the object-capability model, and isolation is what makes it true rather than
aspirational. Embedded, the master key is **ambient** in the agent worker: every MCP tool
and every future code path shares its address space, so security degrades to "remember not
to reach for it" — allow-unless-forbidden. Isolated, there is no code path to the key
because the key is not in that environment.

### The argument for embedded was wrong, and here is precisely how

An earlier revision of this section recommended embedding, on the grounds that a separate
Worker forces either _a second copy of the master key_ or _plaintext crossing a boundary_.
**Both are false**, and they fail for the same reason: they conflate the key with the vault.

- **No second copy.** The key lives in exactly one Worker — the Bureau. It is _moved_, not
  duplicated. `services/agent` gives it up.
- **No plaintext crossing.** §1's own contract is _"the Bureau applies the credential
  itself, and returns only the result."_ A **name** (`credRef` + verb) goes in; a **result**
  (an HTTP response, a signature) comes back. The secret never leaves.

Recorded rather than deleted, because the mistake is instructive: it argued a _security_
invariant from an assumption about _plumbing_. Isolation is the faithful implementation of
what §1 and §3 already say the Bureau does.

### What this costs (honestly)

A same-colo service-binding hop (sub-millisecond), one more Worker in the deploy graph, and
one real refactor: **the seal-on-mint path moves too.** `services/agent/src/vault.ts`
splits — the metadata/reference layer stays in the agent worker; all `VAULT_MASTER_KEY`
crypto (`sealSecret`, `openVaultSecret`) moves to the Bureau. One key, one home, zero
crypto in the agent worker. Tracked as **T3a**.

---

## Open question 1b — how does the Bureau know _which agent_ is calling?

Isolation stops the agent worker from reading the key. It does **not** answer this: all
agents (`travel@`, `editor@`, `receipts@`) run inside the same agent worker and call the
Bureau over the same service binding. Every call looks identical — _"a request from the
agent worker."_ The binding proves which **worker**, never which **agent**.

That gap is live, not theoretical: sVOL `014` is the unit where an agent reads _untrusted
email content_. A prompt-injected `editor@` calling `fetch(credRef: "aws-mcp")` must be
refused, and a self-asserted principal id in the request body is exactly the antipattern
this session removed from MCP.

### Resolution: **inward = opaque token · outward = JWT**

The test that decides it every time: **who has to verify, and can they call the issuer?**

**Inward (agent → Bureau): an opaque, per-invocation bearer token.**

Do **not** mint a new token type. The invocation already has an identity (sVOL `007` built
the create path; `mcp-auth.md` §15.2 specifies per-invocation tokens). It presents that
token on every Bureau call; the Bureau verifies with **`verifyBearer`** — the same function
every other surface uses.

A JWT here would be actively worse. Its value is offline verification by a third party;
when issuer and verifier are the same service it buys nothing — and it **costs
revocability**. A JWT is valid until it expires. This system now has two kill switches
(sVOL `008`'s `agent_bindings.enabled`, `s03.A`'s `grants.revoked_at`), and both work by
making a token _stop resolving on the next check_. A self-contained JWT routes around both:
flip the kill switch, and the agent keeps acting until expiry.

Using `verifyBearer` means Bureau authorization **inherits every revocation control already
built** — `revoked_at IS NULL`, `deleted_at IS NULL`, the disabled-binding gate — for free.
Cost: one D1 lookup per Bureau call, which is noise beside the outbound network request the
call is about to make, and it is what makes revocation instant.

**Outward (Bureau → AWS / third party): a JWT is exactly right.**

Here the verifier **cannot call us**. `AssumeRoleWithWebIdentity` requires an OIDC token
AWS validates offline against a published key. That is textbook JWT — and it is the unlock
for open question 3, which stalled on _"Workers issues no federatable OIDC token."_ An
isolated Bureau holding a private signing key and publishing a JWKS **is** an OIDC provider.

The two keypairs point opposite ways, which is the easiest thing to confuse:

|                                       | who holds private | who verifies                   |
| ------------------------------------- | ----------------- | ------------------------------ |
| agent proving identity to Bureau (v2) | the **agent**     | the Bureau (holds public only) |
| Bureau proving identity to AWS        | the **Bureau**    | AWS (public via JWKS)          |

### End-to-end shape

```
invocation starts  ->  gets its token            (existing machinery, 007 / §15.2)
agent -> Bureau    :  "fetch, credRef 42" + token   <- opaque, revocable, verifyBearer
Bureau             :  verifyBearer -> grant(principal, credRef, verb)? -> unseal -> call
Bureau -> AWS      :  self-signed JWT -> STS -> temp creds   <- JWT, offline verification
Bureau -> agent    :  the response only. Never the credential.
```

### Deferred to v2: request signing

Per-invocation **signatures** (agent holds an ephemeral private key, Bureau holds the public
half, the signature covers verb + destination + credRef) defend against **token replay** — a
leaked token could otherwise be reused for a different action. Real, but second-order, and it
needs a lifecycle design (where an ephemeral private key lives inside a shared worker) that
should not block the proxy. **Not built now**; noted so the request shape can accommodate it
later without a rewrite.

---

## Open question 2 — Class A: response streaming, or buffer-and-scan?

> _Does Class A need response streaming, or is buffer-and-scan (§7) acceptable for all
> realistic agent traffic?_ (`bureau.md` §13.2)

**Recommendation: buffer-and-scan for text-ish responses; stream-through with
header-only inspection for binary/large. This is decidable now — no user needed.**

The two are not really in tension once you follow the redaction requirement (§7/T4) to
its conclusion. Redaction **cannot** work on a stream you have already forwarded: to
scrub a secret that straddles a chunk boundary, or one an endpoint split "one character
per response," you must hold enough of the body to see it whole. Forward-then-scan is
not redaction. So on the path that carries injected values, **buffering is not a
performance choice — it is a correctness requirement.**

And it costs nothing the consumer would have used, because **the sink that matters is
the model's context** (§7), and an agent tool call consumes its result as a _complete
value_ (a JSON/text tool result), not as a stream it renders incrementally. Realistic
agent traffic is bounded API JSON — small, text-ish — where a full buffer-and-scan is
cheap and invisible.

The one real exception is **large binary** (file downloads): you cannot meaningfully
scan a blob for text secrets, and buffering it would break large responses. §7 already
carves this out — _"stream binary through with header inspection only."_ A verbatim
credential appearing inside a binary body is astronomically unlikely, and header
inspection covers the realistic leak (a reflected auth header).

So the answer to the literal question — _does Class A **need** streaming?_ — is **no,
not on the redacted text path**, where buffer-and-scan is both sufficient and required.
Streaming exists only for the binary pass-through, where there is nothing to scan.
Follow-up detail, not a blocker: set a max-buffer cap on the text path and, above it,
either refuse or fall back to header-only pass-through with a logged warning — decide
that when T4 is built.

---

## Open question 3 — Federation feasibility for SES

> _Needs a real investigation before it's planned work._ (`bureau.md` §13.3, §10)

**Verdict: zero-secret-at-rest federation (rung 1) is NOT cleanly achievable today —
keep it a spike, not a milestone (T7). Rung 2 — trade the SES key for a signing/cert
key — IS achievable now, and is a real improvement, but it is not the "fewer secrets"
endgame.** This is `bureau.md`'s own warning cashed out: _clean in principle, fiddly
in practice._ Investigation done (light web research, AWS + Cloudflare docs).

**Everything on the AWS side is ready.** You can register an arbitrary external OIDC
provider as an IAM OIDC identity provider (AWS trusts JWTs from its published `jwks_uri`
against a pinned `aud`/`sub`), and `AssumeRoleWithWebIdentity` returns temporary creds
**without any base AWS credential** — the caller presents only the OIDC token, a role
ARN, and a session name. SES is an ordinary SigV4 service, so temp creds work unchanged:
sign as today with the temporary key and add `X-Amz-Security-Token` — a header
`aws4fetch` (already wired) supports via `sessionToken`. So step 1 (federate) and step
3 (call SES) are both solved.

**The single blocker is on the Cloudflare side: the OIDC-token-issuance gap.** Workers
has **no first-class, runtime-issued, AWS-federatable workload identity** — there is no
managed per-Worker OIDC issuer + JWKS the way GitHub Actions mints tokens for
`AssumeRoleWithWebIdentity`. Native OIDC is still an open feature request even for the
_deploy_ path (`workers-sdk` discussion #11434, open). To feed step 1, the Worker would
have to **self-sign the JWT and host its own JWKS** — which means holding a signing
private key (this is exactly what community projects like `cf-access-workers-oidc` do,
key in KV). That signing key **is itself a secret at rest.** IAM Roles Anywhere is no
escape: it authenticates with an X.509 client cert and signs `CreateSession` at the
application layer with the cert's **private key** — another secret at rest, and an
awkward fit since the Workers mTLS binding presents a cert in the TLS handshake but does
not expose the key for the app-layer signature Roles Anywhere needs.

Mapped to the §10 ladder:

| Rung                                                | For SES from Workers, today |                                                                                                                               |
| --------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **1** — no secret at rest                           | ✗ **not reachable**         | needs Cloudflare to ship a native per-Worker OIDC issuer + JWKS                                                               |
| **2** — trade for a signing/cert key                | ✓ reachable as planned work | self-issued JWT → `AssumeRoleWithWebIdentity` → 1-hour SES creds; smaller blast radius, short-lived, but still one stored key |
| **3** — vault-stored `aws-sigv4` key + `sign_sigv4` | ✓ today's baseline (T5)     | the fallback the plan already assumes                                                                                         |

**Recommendation for the plan:**

1. **Do not promise rung-1 federation.** Keep T7 a **time-boxed spike**, not scheduled
   work — its "done when" is _either_ a Worker sending through SES with no long-lived
   AWS secret, _or_ a written record that Cloudflare can't yet issue the token. Both
   close the question.
2. **Keep T5's `sign_sigv4` over a vault-stored `aws-sigv4` credential as the baseline**
   — that is what the Bureau plans for anyway, and it is unaffected by this verdict.
3. If a security win is wanted before Cloudflare closes the gap, **rung 2 is the move**:
   self-issued OIDC → `AssumeRoleWithWebIdentity` → **STS session policy** (§5.2 rung 1
   enforcement — the intersection of role + per-call policy, AWS-enforced, minutes-long).
   You still store one signing key, but the SES _capability_ becomes short-lived and
   provider-narrowed. File this as the concrete rung-2 option; do not commit it blind.
4. **Watch `workers-sdk` #11434 / the "JWT OIDC in Workers" request.** The day Cloudflare
   ships native Workers OIDC, T7 flips from spike to clean planned work — the AWS half is
   already done.

**Does it need the user?** No decision is needed to _proceed_ — the recommendation is
"keep the baseline, spike the rest," which changes nothing committed. Surface the verdict
so the user knows rung 1 is a platform-gap away, not a design choice, and can weigh the
rung-2 trade if they want short-lived SES creds sooner.

---

### Sources (open question 3)

- AWS — Create OIDC identity providers: <https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html>
- AWS — `AssumeRoleWithWebIdentity` (no base credential required): <https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html>
- AWS — Using temporary credentials (`X-Amz-Security-Token` for SES/SigV4): <https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_use-resources.html>
- Cloudflare — Workers OIDC issuance still an open request: <https://github.com/cloudflare/workers-sdk/discussions/11434> · <https://community.cloudflare.com/t/jwt-oidc-token-in-workers/783167>
- Self-issued OIDC-in-Workers stores a signing key: <https://github.com/eidam/cf-access-workers-oidc>
- Cloudflare — Workers mTLS binding (presents cert, does not expose key): <https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/>
- AWS — IAM Roles Anywhere (X.509 private-key app-layer signing): <https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/iam-roles-anywhere-private-ca.html>
