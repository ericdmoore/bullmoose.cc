# The Bureau — architecture notes

> Companion to [`devPlan.md`](./devPlan.md): **why** the tasks are ordered as they
> are, and a firm resolution of [`bureau.md`](./bureau.md) §13's three open questions.
> `bureau.md` is the design; this decides the calls it left open.

---

## Why this task order

`bureau.md` §10 frames the whole thing as a ladder — *a closed set of operations over
a key you cannot extract.* The tasks climb it, and the ordering is forced by three
dependencies, not by preference:

1. **You cannot enforce a field you never minted.** The verb gate (§4.1) keys off
   `kind`; destination binding (§6) keys off `allow`. Both are meaningless until a
   credential *carries* them — so the mint-time contract (**T1**, sVOL 020) is first,
   and is exactly the piece that is fully decided and independent of every open
   question. It records; it does not enforce.

2. **You cannot authorize a call without an authorization model.** The Bureau's first
   act on any verb is to check `(principal, credRef, verb)` (§5.1). That grant model
   (**T2**) is data + admin surface with no runtime of its own, so it slots between the
   contract and the runtime that consumes it.

3. **Enforcement is one chokepoint, built once, then reused.** The runtime (**T3**) is
   where authz, verb-gating, destination binding and header injection first actually
   *bite* — and it is built around the single Class-A `fetch` verb because that verb
   "covers every static-bearer / API-key service that will ever exist" (§3). Egress
   redaction (**T4**) is a filter on *that* runtime's response path, so it follows T3.
   The Class-B verbs (**T5** — `sign_sigv4`, `oauth_token`, `hmac_sha256`) are added
   last among the core work because each simply reuses T3's authz+binding and T4's
   redaction; adding them earlier would mean building those guarantees twice.

Two tasks hang off the side rather than on the spine:

- **T6 (AAD re-scoping, §9)** is deferred and sequenced late *on purpose*: it re-seals
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

> *Its own Worker, or inside the agent worker (which already holds
> `VAULT_MASTER_KEY`)?* (`bureau.md` §13.1)

**Recommendation: run it INSIDE the agent worker, as an internal chokepoint module —
not a separate Worker.** `bureau.md` was "leaning separate"; I am recommending against
that lean, and the reason is a security invariant, not convenience.

The crown jewel is `VAULT_MASTER_KEY`, and the credentials + the decrypt path
(`openVaultSecret`, `sealSecret`) **already live in the agent worker**. The Bureau's
whole job — proxy, sign, derive, redact — operates on *decrypted* secrets, so it must
run where it can decrypt. A separate Worker forces one of two bad trades:

- **Give the separate Worker its own copy of the master key** → there are now **two
  copies** of the one secret whose leak is catastrophic. `bureau.md` §13.1 names this
  cost directly ("a second copy of the master key"). It doubles the blast radius of
  the single worst leak in the system.
- **Have it call the agent worker to decrypt** → the *plaintext secret* now crosses a
  worker boundary on every call, which is precisely the thing invariant 1 exists to
  prevent ("no caller … ever holds a credential value"). A hop that carries plaintext
  is strictly worse than no hop.

The chokepoint and audit-boundary cleanliness that motivated "separate" is achievable
**in-process**: make the Bureau the *only* code path that may call `openVaultSecret`,
enforced by module boundary and lint ("enforce by wiring, not rule", `mcp-auth.md` §8),
and route every use through the existing `grant_audit` sink (invariant 6). You get the
chokepoint without duplicating the key or moving plaintext.

The hinge `bureau.md` itself identified — *"whether anything besides the agent runtime
ever calls it"* — resolves cleanly: **today, nothing does.** Only agent pipelines need
credentialed egress. The moment a second consumer appears (say the jmap worker wants
Class-A `fetch`), **that** is the trigger to extract the Bureau into its own Worker —
and at that point you move the master key *out* of the agent worker and *into* the
Bureau, preserving the single-copy property rather than breaking it.

**Does it need the user?** Recommendation is firm and technically grounded, but this
is a **security-boundary decision** that contradicts the design doc's stated lean, so
**flag it for user ratification.** The user may hold a constraint I cannot see — a
compliance/audit requirement for process isolation, or a near-term plan for a non-agent
caller — either of which would flip the answer to "separate, and accept the second key
copy deliberately." Absent such a constraint, build same-worker.

---

## Open question 2 — Class A: response streaming, or buffer-and-scan?

> *Does Class A need response streaming, or is buffer-and-scan (§7) acceptable for all
> realistic agent traffic?* (`bureau.md` §13.2)

**Recommendation: buffer-and-scan for text-ish responses; stream-through with
header-only inspection for binary/large. This is decidable now — no user needed.**

The two are not really in tension once you follow the redaction requirement (§7/T4) to
its conclusion. Redaction **cannot** work on a stream you have already forwarded: to
scrub a secret that straddles a chunk boundary, or one an endpoint split "one character
per response," you must hold enough of the body to see it whole. Forward-then-scan is
not redaction. So on the path that carries injected values, **buffering is not a
performance choice — it is a correctness requirement.**

And it costs nothing the consumer would have used, because **the sink that matters is
the model's context** (§7), and an agent tool call consumes its result as a *complete
value* (a JSON/text tool result), not as a stream it renders incrementally. Realistic
agent traffic is bounded API JSON — small, text-ish — where a full buffer-and-scan is
cheap and invisible.

The one real exception is **large binary** (file downloads): you cannot meaningfully
scan a blob for text secrets, and buffering it would break large responses. §7 already
carves this out — *"stream binary through with header inspection only."* A verbatim
credential appearing inside a binary body is astronomically unlikely, and header
inspection covers the realistic leak (a reflected auth header).

So the answer to the literal question — *does Class A **need** streaming?* — is **no,
not on the redacted text path**, where buffer-and-scan is both sufficient and required.
Streaming exists only for the binary pass-through, where there is nothing to scan.
Follow-up detail, not a blocker: set a max-buffer cap on the text path and, above it,
either refuse or fall back to header-only pass-through with a logged warning — decide
that when T4 is built.

---

## Open question 3 — Federation feasibility for SES

> *Needs a real investigation before it's planned work.* (`bureau.md` §13.3, §10)

**Verdict: zero-secret-at-rest federation (rung 1) is NOT cleanly achievable today —
keep it a spike, not a milestone (T7). Rung 2 — trade the SES key for a signing/cert
key — IS achievable now, and is a real improvement, but it is not the "fewer secrets"
endgame.** This is `bureau.md`'s own warning cashed out: *clean in principle, fiddly
in practice.* Investigation done (light web research, AWS + Cloudflare docs).

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
*deploy* path (`workers-sdk` discussion #11434, open). To feed step 1, the Worker would
have to **self-sign the JWT and host its own JWKS** — which means holding a signing
private key (this is exactly what community projects like `cf-access-workers-oidc` do,
key in KV). That signing key **is itself a secret at rest.** IAM Roles Anywhere is no
escape: it authenticates with an X.509 client cert and signs `CreateSession` at the
application layer with the cert's **private key** — another secret at rest, and an
awkward fit since the Workers mTLS binding presents a cert in the TLS handshake but does
not expose the key for the app-layer signature Roles Anywhere needs.

Mapped to the §10 ladder:

| Rung | For SES from Workers, today | |
|---|---|---|
| **1** — no secret at rest | ✗ **not reachable** | needs Cloudflare to ship a native per-Worker OIDC issuer + JWKS |
| **2** — trade for a signing/cert key | ✓ reachable as planned work | self-issued JWT → `AssumeRoleWithWebIdentity` → 1-hour SES creds; smaller blast radius, short-lived, but still one stored key |
| **3** — vault-stored `aws-sigv4` key + `sign_sigv4` | ✓ today's baseline (T5) | the fallback the plan already assumes |

**Recommendation for the plan:**
1. **Do not promise rung-1 federation.** Keep T7 a **time-boxed spike**, not scheduled
   work — its "done when" is *either* a Worker sending through SES with no long-lived
   AWS secret, *or* a written record that Cloudflare can't yet issue the token. Both
   close the question.
2. **Keep T5's `sign_sigv4` over a vault-stored `aws-sigv4` credential as the baseline**
   — that is what the Bureau plans for anyway, and it is unaffected by this verdict.
3. If a security win is wanted before Cloudflare closes the gap, **rung 2 is the move**:
   self-issued OIDC → `AssumeRoleWithWebIdentity` → **STS session policy** (§5.2 rung 1
   enforcement — the intersection of role + per-call policy, AWS-enforced, minutes-long).
   You still store one signing key, but the SES *capability* becomes short-lived and
   provider-narrowed. File this as the concrete rung-2 option; do not commit it blind.
4. **Watch `workers-sdk` #11434 / the "JWT OIDC in Workers" request.** The day Cloudflare
   ships native Workers OIDC, T7 flips from spike to clean planned work — the AWS half is
   already done.

**Does it need the user?** No decision is needed to *proceed* — the recommendation is
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
