# Playbook: onboarding a second human

Goal: take one person who is **not the operator** from "does not exist" to
"reads their own mail in the browser and sees their first extraction." Two
columns, and the split is the whole point: what the **operator** does once with
the admin token, and what the **new person** does themselves.

Placeholders: operator `you@example.com`, new person `partner@example.com`,
tenant `t_home`, domain `example.com`. Everything is `$0` on Cloudflare's free
tier except the extraction pass, which is a **capped** paid pipeline (§5).

> **There is no self-signup, and that is a posture, not a gap.** Every account
> on a bullmoose deployment exists because somebody holding `ADMIN_TOKEN`
> decided it should. What this playbook is trying to shorten is the *distance*
> between that decision and a working human — not remove the decision.

---

## 0. Before you start (operator, once per deployment)

The platform is deployed ([`../DEPLOY.md`](../DEPLOY.md)) and your CLI is
pointed at the provisioning plane:

```sh
bullmoose admin init --url https://bullmoose-provision.<acct>.workers.dev --token "$ADMIN_TOKEN"
bullmoose admin tenant create t_home --name "Home"      # once per household/org
bullmoose admin domain add example.com --tenant t_home  # once per domain
bullmoose admin domain status example.com               # poll until active
```

`t_home` is a slug you choose — a namespace, not a secret. `domain add` wires
Email Routing, the catch-all into the ingest worker, the SES identity, DKIM,
MAIL FROM, DMARC and the `_jmap._tcp` autodiscovery record in one call, and
reports every step ✓/✗. It is idempotent: fix a failure and re-run.

**The domain must be a zone on the deployment's own Cloudflare account.** There
is no path today for a person to bring a domain the operator does not control —
`addDomain` starts by looking the zone up and returns 422 if it is not there.
A second human on a domain of their own means the operator adds that zone first.

---

## 1. Create the person (operator, ~30 seconds)

```sh
bullmoose admin account create partner@example.com --tenant t_home --name "Partner"
bullmoose admin password partner@example.com          # prompts, not echoed
```

`account create` mints the principal, the account, its primary identity, the
delivery route (D1 row **and** the ingest KV key) and six standard mailboxes, so
their first `Mailbox/get` is not empty. It is idempotent — a retry adopts and
answers `created: false` rather than building a second account.

> ⚠️ **You are choosing their password, and today they cannot change it.**
> There is no self-service password-change route: `POST /principals/password`
> on the provisioning plane is the only writer, and it is admin-gated. Treat the
> value as a **bootstrap credential**, not a secret you share:
>
> - generate a random one, hand it over out of band, and expect to rotate it
>   with the same command whenever they ask;
> - or skip the password entirely and hand them a **device token** instead
>   (`bullmoose admin token create partner@example.com --name "partner-laptop"
>   --scopes mail`), which they paste into the web app's *Advanced* door. That
>   avoids you ever knowing a password — at the cost of the hosted sign-in
>   page and of `bullmoose login`, both of which need one.
>
> This is the sharpest piece of friction in the whole path. It is recorded
> rather than worked around, because the fix is a new self-service route on
> `services/jmap`'s auth plane, not a documentation choice.

---

## 2. They sign in (the new person, in a browser)

Send them exactly this:

> Go to **https://app.bullmoose.cc**, click sign in, and enter
> `partner@example.com` and the password you were given.

That is the whole instruction, and it is the rung-0 path: **the web app is the
product.** No terminal, no token, nothing to install. Under the hood the app
runs an ordinary authorization-code + PKCE flow against
`https://auth.bullmoose.cc` (the password is stretched in their browser and
never transits), then exchanges the resulting access token for a 30-day session
credential the mail API understands.

Two artifacts appear afterwards, each separately revocable: an OAuth grant
("bullmoose webmail" under connected apps) and a session token named
`webmail session` in `bullmoose token list`. Revoking one does not revoke the
other.

**A self-hosted deployment on another origin** uses the same page's *Advanced:
use a device token* door instead — hosted sign-in can only redirect back to
origins it knows.

### If they prefer a terminal (optional, rung 2)

```sh
bullmoose login partner@example.com
```

No `--base`: the server is autodiscovered from the address (RFC 8620 §2.2 —
the `_jmap._tcp` SRV record, then `https://example.com/.well-known/jmap`). If
neither rung answers on their domain, `--base https://app.bullmoose.cc` is the
override, and `bullmoose repoint` fixes a stored base later without a new
credential.

---

## 3. Mail actually arrives (both, ~2 minutes)

```sh
# them, or you:
send anything to partner@example.com from an outside address
```

It should land in their Inbox within a couple of seconds. If it does not, the
delivery route is the thing to check — see *Runbook: an address already routes
somewhere* in [`../DEPLOY.md`](../DEPLOY.md).

Outbound is worth one check too, because it is the half that silently degrades:
have them reply, and confirm the received copy shows SPF/DKIM/DMARC pass
(in Gmail: "show original").

---

## 4. Give them staff (operator, one command)

An account with no agent is a mailbox. The extraction pass is the smallest
thing that makes bullmoose *itself* on day one — it reads delivered mail and
writes commitment/decision/task annotations back onto the same account. It
sends nothing, so it needs no supervisory grant and no governing book.

```sh
bullmoose admin extractor on partner@example.com
```

What that gives them, without any further tuning:

| | default | change it with |
|---|---|---|
| model | `openrouter/minimax/minimax-m3` | `--provider` / `--model` |
| **monthly cap** | **$2.00** (`2000000` µUSD) | `--budget <micro-USD>`; `0` refuses every paid claim |
| history floor | the binding's birth — it never reprocesses the archive | a tier-1 approval (`--request-floor` on `bullmoose agent backfill`) |
| frontier arms | none | `--explore <host>/<model>` (repeatable; turns exploration on at 0.2) |

The cap is the reason this is safe to hand to someone else: the claim gate
refuses paid work past it, pending invocations wait as a durable cursor, and the
overage ask surfaces in their approvals queue rather than on your bill.

`--dry-run` first if the account already has an extractor — re-running is the
sanctioned model-swap path, and it also sets `enabled = 1`, so it would
un-pull a kill switch somebody pulled deliberately.

> **On putting a free `workers-ai` route on the menu.** Tempting as a day-one
> default, and it does not mean what it looks like. On *backfill* rows it is
> the scout half of scouts-then-troops — a free sweep, with the paid pass only
> on what the scout flags. On ordinary delivered mail there is no scout branch:
> the menu is ranked by price, `workers-ai` is priced 0 by policy, so the free
> route becomes the **primary** extractor and the paid model becomes its
> fallback. Choose it deliberately with `--provider workers-ai --model …`, not
> by adding it beside a paid one and expecting a safety net.

### The first extraction (the smoke test)

Mail them a commitment-shaped sentence with **no deadline cue** — *"I'll get you
the numbers, promise."* A sentence with a deadline stamps `due_at` and the paid
drain will correctly sit on it until near due, which looks like nothing
happening. The cloud runtime's cron claims pending work every 5 minutes.

They will see the annotation in the margin of that message at
https://app.bullmoose.cc/mail/ , and the agent itself — model, budget spent vs
remaining, work ledger, recent invocations with their real cost — under
**Agents**.

Newsletters never spend: the human-originated gate and the pipeline's own
`List-Unsubscribe` skip both run before any model call.

---

## 5. Optional: their own provider key (BYOK)

If they have their own OpenRouter account, sealing their key means **their**
provider-side policy applies to their agents' traffic — their privacy
redaction, their guardrails, their route and model allowlists, their spend cap,
their usage log. Nothing in bullmoose implements, mirrors or reads any of that;
it applies because the request authenticates as them.

**They can do this themselves, from the browser** — Settings → Agents, at
https://app.bullmoose.cc/settings/ — *if their session carries the `vault`
scope. A hosted-sign-in session does not.* That is deliberate: sealing a key is
custody of a secret, and the consent screen excludes the credential realm
(`auth.bullmoose.cc`'s published `scopes_supported` has no `vault`, and no
account-to-account share can confer it either). So the honest options are:

```sh
# them, in a terminal — `login` is the ONLY self-service way to WIDEN scope,
# because `token create` can only ever narrow the token it is called with:
bullmoose login partner@example.com --scopes mail,vault
bullmoose token create --name "webmail (vault)" --scopes mail,vault
# …then paste that token into the web app's Advanced door and use Settings → Agents.
```

```sh
# or you, on their behalf, in one call — seal + grant + attach:
OR_KEY=... bullmoose admin byok seal partner@example.com --key-env OR_KEY
```

There is no `--key` flag and there must never be one: a key in argv is in the
shell history, in `ps`, and in whatever log echoed the command. It arrives by
env-var **reference** or hidden prompt.

Either way the key is **write-only**. It crosses one service binding on the way
in and is sealed under a master key that lives on the Bureau worker and nowhere
else. No route returns it — not to the agent worker, not to the provisioning
plane, not to the person who set it. Re-running the same call **rotates** it in
place: same handle, same grant, same attachment, new ciphertext.

Two consequences worth telling them about up front:

- **it can only be spent where it was sealed for.** The destination allowlist is
  re-parsed on every call, so a key sealed for `https://openrouter.ai` cannot be
  spent anywhere else no matter what a compromised prompt talks an agent into
  composing;
- **failures are loud, never silent.** A missing, revoked, expired or
  destination-refused credential makes the invocation fail with the reason on
  the row. It never falls back to the platform key — that would run their mail
  through an account whose guardrails are not theirs.

---

## 6. Optional: sharing (operator)

Contacts, calendars and address books are shared with a **grant**, and grants
are still operator-minted. See [`family-sharing.md`](family-sharing.md) for the
whole shape; the short version:

```sh
bullmoose admin grant create partner@example.com you@example.com --scopes read,contacts
bullmoose admin grant list you@example.com
bullmoose admin grant revoke <grantId>
```

Effective rights are `token ∩ grant`, always, and every access through a grant
is audited.

---

## What still requires you, and why

Worth reading before you promise anybody self-service. Each of these is a place
the person is blocked on the operator, with the reason it is that way:

| They cannot… | Because | Deliberate? |
|---|---|---|
| create their own account | no self-signup route exists; account creation is `ADMIN_TOKEN`-gated | **yes** — v1 posture |
| change their own password | the only writer is `POST /principals/password` on the provisioning plane | **no** — needs a self-service route |
| seal a provider key from a hosted-sign-in session | `vault` is not an OAuth scope and is not grantable: custody does not delegate | **yes** — but the *ladder* to a `vault` token is undocumented friction (§5) |
| set their own agent's budget or model from the CLI | the CLI's `agent budget --set` / `model --set` still use the operator plane, although a session-reachable door now exists | **no** — the CLI has not adopted it yet |
| mint a share/grant | grants have no non-admin route and no UI | **no** — flagged as the largest unclaimed piece of the multi-player premise |
| bring a domain the operator does not control | `domain add` requires the zone on the deployment's Cloudflare account | **yes** for now |

Everything in the "no" column is tracked work, not a design position. Nothing in
either column should be worked around by widening a scope: if smooth conflicts
with safe here, the friction is the correct answer and belongs in this table.

---

## Troubleshooting

- **`bullmoose login` autodiscovers the wrong host.** Autodiscovery's rungs are
  SRV → SRV-over-DoH → `https://<domain>/.well-known/jmap`, and **rung 1
  short-circuits** — a record that resolves is believed. If `domain add` planted
  an SRV pointing at a host that has since stopped answering, login fails on a
  domain that would have worked with no record at all. Check the target against
  the deployment's `JMAP_HOST` var, and repair a stored base with
  `bullmoose repoint --base https://app.bullmoose.cc`.
- **Signed in, but the agent panel is empty.** The extractor is provisioned per
  account and per spend decision — §4 is not automatic.
- **The extractor is on and nothing is annotated.** Check, in order: the message
  is human-originated (newsletters are skipped before any model call), it
  arrived *after* the binding was created (the history floor is its birth), the
  sentence carries no deadline cue (a `due_at` defers the claim), and the
  binding is enabled and inside its budget — all four are visible in
  `bullmoose agent show extractor`.
- **BYOK sealed, and the agent goes quiet.** A binding naming a credential that
  does not resolve refuses rather than spending the platform key. The status is
  on both Settings → Agents and the agent's own dossier, deliberately, because
  "quiet" and "refusing" look identical from outside.
