# `bullmoose-bureau` — the Bureau

> *You can only compute with what you have.*

The one worker that holds the credential vault's master key. Everything else in
the platform can name a credential; only this worker can use one.

Design: [`.plans/s04-AgentOS/bureau.md`](../../.plans/s04-AgentOS/bureau.md).
The two ratified calls behind its existence:
[`arch.md`](../../.plans/s04-AgentOS/arch.md) open questions 1 and 1b.

## Why it is its own worker

`VAULT_MASTER_KEY` is bound here and **nowhere else**. It was *moved* out of
`services/agent`, not copied.

Embedded in the agent worker, the key would be **ambient**: the same address
space runs every MCP tool and — from sVOL `014` — reads untrusted email, so
security would rest on no code path ever reaching for something that is sitting
right there. Allow-unless-forbidden. Isolated, there is no code path to the key
because the key is not in that environment.

The argument that this forces either a second copy of the key or a plaintext hop
is recorded in `arch.md` as a mistake worth remembering. Both are false, and for
the same reason — they conflate the key with the vault. §1's contract is that a
**name** goes in and a **result** comes back; the secret never crosses.

## What it is not

- **Not a token issuer.** It *verifies* callers with `verifyBearer` and never
  mints anything. Adding a token-issuing route here would route around the two
  kill switches (`008`'s `agent_bindings.enabled`, `s03.A`'s
  `grants.revoked_at`) that the whole authentication model is built to inherit.
- **Not publicly routed.** Reachable only over the `BUREAU` service binding on
  `services/agent`.
- **Not a generic executor.** The rejected `exec(code)` design (bureau.md §2)
  failed because it had no closed set of things it could do. The verb vocabulary
  is closed, small, and typed to the credential's kind.

## Surface

| route | auth | what |
|---|---|---|
| `POST /internal/bureau/seal` | `x-internal-token` | seal-on-mint / rotate; writes `enc_json` |
| `POST /internal/bureau/verify` | `x-internal-token` | decrypt-and-discard health check → `{ok}` |
| `POST /bureau/use` | `Bearer` (invocation token) | authenticate → authorize `(principal, credRef, verb)` → audit → **run the verb** |

```jsonc
// POST /bureau/use            Authorization: Bearer <invocation token>
{ "verb": "fetch", "credRef": "stripe",
  "request": { "url": "https://api.stripe.com/v1/charges",
               "method": "POST", "headers": {…}, "body": "amount=100" } }

// → 200
{ "ok": true, "status": 200, "headers": {…}, "body": "…",
  "bodyEncoding": "text", "redirects": 0 }
```

Note what the caller does **not** send: the header name, the destination
allowlist, or any transform. Those are properties of the credential, read from
its mint-time contract (bureau.md §2, §5). A caller that names the injected
header is refused rather than quietly overridden.

**Class A `fetch` is live (T3).** Per call, in order: the verb is gated by the
credential's `kind` (§4.1); the URL is parsed and matched against the
credential's `--allow` on **scheme + host + port exactly** — wildcards only as an
explicit `*.suffix`, never `startsWith`, never substring — with **no allowlist
meaning unusable** (invariant 5); the credential is unsealed only once all of
that has passed, injected as a **header** (invariant 8), and the caller gets back
only the result.

Redirects use `redirect: "manual"` and **any origin change ends the call**
(invariant 4). Not "follow it without the header": that would turn the Bureau
into a relay fetching attacker-chosen URLs on an agent's behalf. Same-origin hops
are followed, re-checking the allowlist each time.

**Class B verbs** (`sign_sigv4`, `oauth_token`, `hmac_sha256`) still answer
**501** — but from *behind* the kind gate, so an unimplemented verb pointed at
the wrong kind is a 403 and not a 501. They are **T5**.

**Egress redaction is not here yet** (§7, **T4**). §7 ranks it explicitly *below*
destination binding — redaction stops accidents, binding stops adversaries — so
it is the piece that may arrive second. The seam is wired:
`fetchVerb.ts`'s `EgressFilter` receives the response text plus the exact values
the request injected.

## Bindings, and the ones it deliberately lacks

`DB` (control plane) and `VAULT_MASTER_KEY`. No R2, no KV, no Durable Object, no
Workers AI, no `SUBMIT`. Every binding this worker does not have is a capability
that an attacker who reaches it does not inherit.

## Authorization

Two records, both of which must say yes:

1. **The token** — `verifyBearer` on the invocation's own bearer (sVOL `007`,
   `mcp-auth.md` §15.2). The service binding proves which *worker* is calling;
   only the token proves which *agent*. `travel@` and `editor@` share one worker
   and one binding, so without this a prompt-injected `editor@` would inherit
   `travel@`'s capabilities.
2. **The grant** — a `bureau_grants` row over `(principal, credRef, verb)`,
   matched exactly. Minting a credential authorizes nobody; granting a verb on it
   does. Revoke tombstones the row, so the capability stops resolving on the next
   call while the history survives.

Every attempted use — allowed or refused — writes one `grant_audit` row
(invariant 6), with `method = bureau:<verb>:<credRef>` and `grant_id = none`
when nothing authorized it.

## Operating

```sh
npx wrangler secret put VAULT_MASTER_KEY -c services/bureau/wrangler.jsonc
npx wrangler secret put INTERNAL_TOKEN   -c services/bureau/wrangler.jsonc
```

Deploy **before** `services/agent`, which binds it. On an existing deployment the
key must be moved rather than regenerated — a fresh random value cannot open rows
already sealed. See [`docs/DEPLOY.md`](../../docs/DEPLOY.md) §2.
