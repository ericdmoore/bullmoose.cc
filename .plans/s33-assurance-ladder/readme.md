# s33 — the assurance ladder · *how do we know who is asking, and how sure are we?*

> **Status: DESIGN; the CREDENTIAL RULE is resolved (2026-08-21) — see below.**
> From the 2026-08-19/20 conversation about `hr@` answering a
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

## Day one — what a second human actually needs

> Eric, 2026-08-20, answering "who is the second human and what do they need on
> day one." Recorded because every strategy in `.plans/s32-agent-market` assumes
> strangers can arrive, and today they cannot: the operator sets the password and
> therefore knows it (#213). This section is the concrete shape of arriving.

### The external address is the trust anchor — and it dissolves the bootstrap paradox

The hard problem above is that a first passkey needs an out-of-band anchor: you
cannot email a link to prove control of the mailbox you are trying not to trust.
**An external address is a different channel**, so the circle breaks:

```
admin provisions the account
  → one-time enrollment link to her PERSONAL address (verified by click)
  → she registers a passkey (and a second one, below)
  → she now holds a credential the operator never knew
```

That single move closes the onboarding blocker AND the tier-3 disclosure gate.

### Recovery is the weakest link, so design it first

**An account is only as strong as its weakest recovery path.** If "forgot
password" mails a reset to her personal address, then that address *is* the
master key to everything — including the 401(k) disclosure the passkey ceremony
exists to protect. Attackers go at recovery precisely because it is the path
nobody hardens.

| rung | mechanism | posture |
|---|---|---|
| primary | **two passkeys** (phone + laptop), both enrolled day one while she is already in the flow | redundancy without a weaker factor |
| org default | **admin-requested reset** — a human in the loop, audited | the company answer |
| last resort | external-address recovery that **notifies and delays**, never silently resets | the solo/family answer |

Enrolling the second passkey during onboarding is the cheap move that avoids the
expensive one later; a single authenticator guarantees a recovery event.

### Defaults, not decisions

"The admin decides her grants" makes the admin a bottleneck and guarantees drift
between hires. Day one should be **pick a role → get a grant pack**; deviations
go through the approval funnel. The admin approves exceptions, not authors policy
per person. (This is the IdP-group→pack idea from the s32 conversation, minus the
IdP — the directory is an accelerant, never the wedge.)

### Requesting more, and the risk axis that matters

A human can always ask for privileges; the ask lands in the **existing approval
funnel** as a proposal — no new mechanism. Where an agent helps is *scoping* the
request, and the sharp axis is **self versus other**:

| shape | example | who decides |
|---|---|---|
| self · read | "my own 401(k) balance" | **tier-3 step-up, no human approval** — otherwise the 3am promise dies in a queue |
| other · read | "Bob's compensation band" | human approval, always |
| any · mutate | "change my direct deposit" | human approval + step-up |

Self-access-read flowing on step-up alone is the whole point: the ceremony proves
possession, and a queue would defeat the use case that justified building this.

### What else day one needs

- **She must see what the agents see of her.** *"Which agents can read my mail,
  and what have they done in my name?"* — unanswerable today for a non-operator.
  s03.E's console already computes exactly this and has never had this audience.
  Without it, "you control the blast radius" is a claim she cannot check.
- **She must be TOLD they read it, before she discovers it.** An extractor and a
  bouncer will process her mail. In a company that is an employment and privacy
  question; in a family it is a trust question. Stating it at enrollment is both
  decent and differentiating — the ownership story made verifiable.
- **A way to leave.** Offboarding is the twin of onboarding and holds the real
  risk: revoke grants, decide what happens to her mail and drafts, decide what
  happens to agent work done in her name, and ensure **the audit trail survives
  her departure**. An account is only as safe as its deletion story.
- **Something to work with.** A new mailbox has no history, so the extractor
  extracts nothing and watches watch nothing — the product looks inert for a
  week. Import is not only the monetizable complement s32 notes; it is a
  FUNCTIONAL prerequisite for any agent to demonstrate value.
- **A first conversation.** The most on-brand day one is a message from `help@`
  that teaches the pattern *by being the pattern* — a correspondent, not a tour.
- **An address decision, made once.** Local-part, whether it can change, aliases.
  Small, early, and quietly hard to reverse.

### Open questions

1. Is the enrollment link single-use and short-lived (it should be), and what
   happens when it expires — self-serve re-request, or admin re-issue?
2. Does the external address stay on file after enrollment? It is recovery
   surface forever if so; deleting it removes the last-resort rung.
3. Family vs company defaults: the same product, two different recovery
   postures. One setting, or two install profiles?
4. Who tells her about agent processing — the enrollment page, `help@`'s first
   message, or both? (Both, probably; the page is the record, the message is the
   explanation.)

## Credentials: what may exist, and what each may authorize

> Resolved in conversation, Eric, 2026-08-21. Supersedes the assumption elsewhere
> in this note that a password sits underneath the ladder.

### No passwords

Eric: *"I think when we ever make a form to create new human accounts — the
account can't be fully completed without a passkey."*

Taken further, and deliberately: **there is no account password at all.** The
payoff above — *"'the operator knows your password' evaporates because there is
no password"* — only lands if the password is absent rather than optional. A
password kept "for now" is the rung that reintroduces everything the passkey
removes: phishable, resettable, operator-knowable, and permanent once shipped.

**This is already viable end to end.** `bullmoose init --token` configures a
client *"from an existing token (no password login)"*, and `token create` mints
scoped device credentials. So the path is passkey ceremony → mint token →
`init`, with no password anywhere. Legacy clients (POP3/SMTP through popcorn)
authenticate with `bm_` tokens and never see a ceremony.

### The rule

> **Two WebAuthn authenticators are required to complete an account. Any ONE
> satisfies a ceremony.**

Two, because *"a single authenticator guarantees a recovery event"* — enrol the
phone and the laptop while she is already in the flow. Any one, because
requiring 2-of-2 per ceremony is the treadmill open question 4 warns about and
would kill the 3am use case that justified building this.

Note that a U2F/YubiKey-style security key **is** a WebAuthn authenticator, not
a separate factor type. "Passkey + security key" is two authenticators of the
same kind, which is exactly what this rule asks for.

### Additive credentials, capped below tier 3

| credential | origin-bound | may authorize | may count toward the required two |
|---|---|---|---|
| passkey / security key | ✅ | up to **tier 3** | ✅ |
| SSH key | ❌ | up to **tier 2** — CLI session, mint a token | ❌ |
| TOTP | ❌ | up to **tier 2** | ❌ |

**SSH keys** are a device credential, not a step-up factor: no origin binding,
no user presence, and usually unencrypted on disk. Paste the public key
GitHub-style, prove possession, mint a token — genuinely useful for a headless
box with no browser. Never sufficient for a disclosure.

**TOTP is permitted but capped**, which is a change from this note's earlier
"naive OTP does not" framing — that framing was right about the risk and wrong
to imply exclusion is the only response.

The reason TOTP cannot reach tier 3 is NOT that users share codes. It is the
real-time relay: a proxy page takes the code and replays it to the real server
inside its window. The user typed it into what she believed was the login form,
which is what she is supposed to do — her judgement was never engaged.
Commodity kits (Evilginx, Modlishka, EvilProxy) make this the dominant MFA
bypass, and s33's hole #2 supplies the perfect delivery vehicle: an authentic,
DMARC-passing link from the company's own address.

WebAuthn defeats that structurally rather than educationally — the assertion is
computed over the RP ID, so a signature produced for a lookalike origin is
arithmetically worthless at the real one.

Capping rather than excluding prices the risk correctly: if a relay defeats her
TOTP, the attacker holds a **tier-2 session that cannot disclose her 401(k)**.

### Why the accessibility objection does not bite

Eric, reasonably: an old OS or browser without WebAuthn would lock someone out.

It does not, because **WebAuthn is needed at CEREMONY time, not at USE time.**
Mail clients and the CLI authenticate with tokens and never touch it; the
webmail needs a modern browser regardless (a Preact SPA behind a generated
hash-based CSP). So the shape is: complete the ceremony once on any modern
device — a phone is fine — then use whatever client you like, indefinitely,
with a token. Someone with no modern device at all is the admin-reset rung.

### Considered and rejected: per-account visual entropy (SiteKey)

Eric raised the bank pattern — a per-account image or colour proving you are on
the real page. **Recorded as rejected so it is not re-proposed**, on two
grounds:

1. **A proxy does not copy the page, it FETCHES it.** An AiTM relay takes the
   username, asks our server for that account's image, and renders it. Any
   entropy shown *before* authentication is entropy served to whoever asks —
   and it makes the endpoint an enumeration oracle besides.
2. **Users do not notice its absence.** Schechter et al., *The Emperor's New
   Security Indicators* (IEEE S&P 2007): with the image removed entirely, ~92%
   of participants entered their password anyway. Any indicator whose security
   depends on a human noticing something MISSING fails in the field. Banks have
   since retired it.

**The half worth keeping is the telemetry**, and Eric's own framing was the
right one: *"which would hopefully let us see the IP traffic, etc, and shut it
off?"* If a relay must fetch from our origin to impersonate us, our origin sees
the relay — and no picture is required to get that signal. Watch the auth
endpoint for relay-shaped traffic (a datacenter ASN fetching a ceremony that
claims to be a residential phone; one account initiating from two network paths
seconds apart) and be able to kill a ceremony in flight. Detection, server-side,
with the human out of the loop — which is precisely where SiteKey died.

Per-account entropy that DOES work is already in this note: the described-act
page. "Approve **hr@** disclosing **your 401(k) balance**…" is a claim whose
content can be checked, not an ornament whose absence must be noticed.

## Sign-up: the order, and why it is that order

Eric's sketch, reordered on two principles — **cheap before expensive**, and
**prove the channel before relying on it**. Nothing irreversible lands before
the passkey exists.

```
1. Name + requested address      availability + a RESERVED denylist (below)
2. External address → VERIFY NOW the trust anchor; everything downstream
                                 inherits it, so it cannot come after payment
3. Passkey ×2                    the account is NOT complete until this
4. Disclosure: what agents read  before any mail exists to read
5. Import                        or the product is inert for a week
6. Payment                       after first value, not before it
```

**Payment cannot precede import.** This note already says a new mailbox gives
the extractor nothing to extract; charging a card before the product can
demonstrate itself is a churn machine.

### 🔴 Reserved local-parts are not enforced anywhere today

There is no denylist in `services/provision` or `packages/auth-core`. A
self-serve address picker without one lets someone claim `postmaster@` or
`abuse@` (RFC 2142), and — worse here — **the agent role addresses**:
`help@`, `analyst@`, `bouncer@`, `hr@`, `editor@`, `remind@`, `corey@`. A human
holding `bouncer@` receives the boundary agent's mail. This must land before
any self-serve signup ships; filed separately.

### BYO-install is a different flow, not step 6 of this one

The sketch also collected two Cloudflare tokens. That is not sign-up — it is
**provisioning an install on the customer's own Cloudflare account**, which is
a different product with a different support burden, and this note's open
question 3 already records the consequence: a BYO origin means a different RP
ID, so passkeys do not port between installs.

It also deserves its own consent screen because of what it is: **a long-lived
Cloudflare token that can create Workers, D1 and R2 is effectively
account-admin** — the highest-value secret in the whole flow, well above the
card. That is a Bureau asset by definition ("we hold a secret you must never
see") and must not sit in a form field beside anything else.

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
