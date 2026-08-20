# s33 — the assurance ladder · *how do we know who is asking, and how sure are we?*

> **Status: DESIGN.** From the 2026-08-19/20 conversation about `hr@` answering a
> benefits question at 3am. Nothing built. This is a **prerequisite** for any
> `role@` that answers a question *about a person* — and, by coincidence worth
> noticing, the same work that lets a second human exist at all (s26 T5 / #213).

## The question

An agent mailbox receives: *"What's my 401(k) balance?"* — signed only by a `From:`
header. Before it answers, something has to establish **who is asking and how
strongly we know it**. Get this wrong and the failure is not an annoying bug; it is
the one that ends the company.

## What DMARC actually gives us

A DMARC pass means **alignment**: the `From:` header domain matches a domain that
independently passed SPF (envelope) or DKIM (`d=`). With **DKIM alignment** that is a
strong, cryptographic claim — *this message, these headers, this body, signed by the
domain it claims*.

**Prefer DKIM alignment and record which mechanism aligned.** SPF authenticates only
the envelope and breaks under forwarding; DKIM survives relays and covers integrity.
A pass that aligned only via SPF is a materially weaker fact, and collapsing the two
into one boolean throws that away.

### The three holes

1. **A compromised account passes DMARC perfectly.** If Alice's mailbox is phished,
   the attacker's mail *is* Alice's mail, cryptographically. This is the dominant
   threat here and DMARC is structurally blind to it.
2. **Lookalike domains pass their own DMARC.** `cornpany.com` aligns fine. With a
   directory lookup this fails closed at tier 2 (the address simply isn't a known
   employee), so the agent is not fooled — **but the agent can still be used as the
   phishing instrument**: a `role@` that replies to unknown senders with "click here
   to verify" emits authentic, DMARC-passing, correctly-branded challenge links from
   the company's real address. Passkeys defuse this (below); naive OTP does not.
3. **DKIM has no replay protection.** A validly signed message can be captured and
   re-sent. Bind decisions to recency and a per-request nonce, never to "the
   signature verifies."

**So: DMARC authenticates the DOMAIN, never the HUMAN.** Necessary; nowhere near
sufficient to disclose someone's salary.

## What we already do — and the gap

`services/ingest/src/boundary.ts` `stage2EnvelopeAuth` is already correct: it reads
only the **topmost** `Authentication-Results` header (RFC 8601 §1.6 — our edge
prepends, so a forged header can only sit below and is never consulted) and rejects
on an explicit `dmarc=fail`. Conservative by construction.

**But it is purely a reject signal.** On a pass we `CONTINUE` and record *nothing* —
the aligned mechanism, the signing domain, the verdict itself are all discarded, and
they are unrecoverable later because they live in the raw blob rather than a
queryable column.

**Slice one is therefore: stop throwing away the positive.** House rule applies —
do not store a boolean `verified`; store the structured fact, where **absent means
"not known", not "not authentic"**, exactly as a NULL cost means "not recorded"
rather than "free":

```jsonc
{ "dmarc": "pass", "aligned": "dkim", "d": "company.com", "at": 1787200000000 }
```

## The ladder

| tier | what is actually known | safe to do |
|---|---|---|
| **0 — claim** | a `From:` string, nothing more | public facts: handbook, holiday calendar, how to reach a human |
| **1 — domain** | DMARC pass, DKIM-aligned | non-personal facts: policy, plan documents, deadlines |
| **2 — identity** | tier 1 **+** the address resolves in the directory (IdP/SCIM import) | acknowledge a person exists; route work; still **not** proof it is them |
| **3 — possession** | an out-of-band ceremony completed on a registered authenticator | personal data, anything mutating, anything irreversible |

**Tier 2 is where most systems stop and where breaches happen.** Anything about
*your* salary, *your* balance, *your* dependents requires tier 3.

## The challenge service

Eric's framing, and it is the right one: the phone tree where you key a PIN and the
human agent sees only **PASS | FAIL**. That is the Bureau's own invariant — *ask,
receive a verdict, never hold the secret* — applied to identity instead of
credentials. Not a new architecture; a second verb on an existing shape.

An agent that needs tier 3 replies with a link. The human completes a **passkey**
ceremony. The service mints a narrow, short-lived capability back to the agent. The
agent never sees the authenticator, only what it is now allowed to do.

### Why passkeys, not SMS

WebAuthn is the only common factor that survives hole #1. The private key lives in
the device's secure enclave and never traverses the mailbox, so a fully-compromised
inbox still cannot produce an assertion. SMS falls to SIM swap and relay; a
nonce-in-a-reply proves control of the mailbox, which is precisely what is
compromised.

### Where it lives: `auth.bullmoose.cc` (`services/oauth`) — NOT the Bureau

1. It is already the identity plane (`/authorize`, `/token`, `/register`,
   `/webmail/session`). Registration and assertion are the same job.
2. **WebAuthn is origin-bound**: the RP ID *is* the security boundary and must be a
   stable dedicated origin. `auth.bullmoose.cc` already is one.
3. **A passkey is not a Bureau asset.** Bureau's invariant is "we hold a secret you
   must never see." A passkey record is a public key, a counter, an AAGUID — nothing
   to seal. Putting it there overloads a component defined by holding secrets.
4. **Blast radius.** A public-facing challenge UI must not live in the worker that
   holds `VAULT_MASTER_KEY`. Bureau deploys first because it is the crown jewel;
   keep it boring.

The minting half is Bureau-*shaped* — narrow, expiring, grant-like — but the AS
already mints scoped credentials and should mint these.

### Transaction signing, not authentication

**The challenge page must state what it authorizes.** Not "confirm your identity" —
a click-through means nothing:

> Approve: **hr@company.com** disclosing **your 401(k) balance** in reply to a
> message sent from **alice@company.com** at **3:04 AM**. Expires in 5 minutes.

Without this, an attacker social-engineers Alice into completing a ceremony for a
request she never made ("IT needs you to re-verify"). With it, the passkey stops
being authentication and becomes **approval of a described act** — the same
principle the approvals queue already runs on.

**Corollary:** a PASS authorizes disclosure *into that thread*, and the answer goes
to the **enrolled** address — never to an arbitrary reply-to that a compromised
session may have set.

### What the token binds — and what it must not

Bind: the message id · the account · a single-use nonce · a short TTL (minutes) ·
**the specific disclosure category**. Consume on use.

**Do not bind IP.** Phones roam constantly (cellular↔wifi handoff, carrier NAT,
VPNs), so IP binding manufactures false failures at the moment of peak frustration
and buys nothing the nonce and TTL do not already provide.

## The hard part: enrollment bootstrap

Alice's *first* passkey needs an out-of-band trust anchor. You cannot email a link to
prove control of the email you are trying not to trust.

**And this is the same problem #213 already found**: there is no self-service
credential path for a new human — the operator sets the password and therefore knows
it. So **passkey enrollment can be the missing onboarding step**: the operator
provisions the account and issues a one-time enrollment link; Alice registers a
passkey; from then on she has a login *and* a step-up factor, and "the operator knows
your password" evaporates because there is no password.

One mechanism closes the market's onboarding blocker and the HR agent's disclosure
gate. That coincidence is the strongest argument for building this next.

## Slices

1. **Record the positive assurance** (`services/ingest`, `packages/mailstore`): keep
   the DMARC verdict, aligned mechanism and signing domain as a structured fact on
   the message; absent ≠ unauthentic. No behaviour change, no new refusals.
2. **Passkey enrollment** on `auth.bullmoose.cc`: register/list/revoke, one-time
   enrollment link, RP ID pinned. Doubles as the onboarding credential path.
3. **The challenge + mint**: a described-act page, ceremony, narrow single-use token.
4. **Agent-side consumption**: a `role@` asks for tier 3, receives PASS|FAIL plus the
   scoped token, discloses into the thread, to the enrolled address.
5. **Directory import (tier 2)** — only when a buyer with an IdP appears; CSV or SCIM.
   Bootstrapping the grant graph, never the wedge (see s32).

## Open questions

1. **Assurance storage shape** — a column on the message row, an annotation, or a
   header we re-derive on read? (Leaning: a column; annotations are commentary, this
   is provenance.)
2. **Who declares a disclosure category?** The agent at ask-time, or a policy the
   operator writes once per `role@`? A category the agent invents is a category no
   one reviewed.
3. **BYO-domain RP ID.** A customer install on their own domain has its own origin,
   so enrollment is per-install and passkeys do not port between installs. Affects
   the s32 market story; needs stating before anyone promises portability.
4. **Tier-3 TTL and re-ask cadence** — per act, per thread, or per session-with-idle?
   Too short is a ceremony treadmill; too long recreates the standing session the
   passkey was meant to avoid.
5. **What happens on FAIL** — silence, a bland refusal, or a notice to the *enrolled*
   address that someone asked? (Leaning: bland refusal to the asker, notice to the
   enrolled human — failed step-up is a signal the real person should see.)

## References

`services/ingest/src/boundary.ts` (stage 2, the topmost-header trust model) ·
`.plans/s12-boundary` (the inbound trust boundary this extends) ·
`.plans/_archived/s03.E-console` + `.plans/s04-AgentOS` (Bureau, grants, the
ask-don't-hold invariant) · `services/oauth` (the AS this belongs in) ·
`docs/playbooks/onboarding-a-second-human.md` (#213, the credential gap) ·
`.plans/s32-agent-market` (why this is a prerequisite, not a feature).
