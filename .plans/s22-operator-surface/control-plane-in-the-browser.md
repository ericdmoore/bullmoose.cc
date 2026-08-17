# Control-plane operations in the browser — grants and credentials

**Status: design, not built.** Eric, 2026-08-16.

Two things currently reachable only from the CLI, and whether they belong in
`/settings`. They share a theme: both are **control-plane** operations, and the
control plane is deliberately not reachable from the mail surface. Neither is a
simple "add a page" — each moves a boundary, and the two move it different
amounts.

`/settings` already exists and is done (s07 T2 — `Identity`, `VacationResponse`).
It is the natural home for the first of these and the _link target_ for the
second.

---

## 1. Grants

### What exists today

`buildSession` (`services/jmap/src/session.ts`) already reports grant-reached
accounts with `isPersonal: false`, `isReadOnly`, and per-account `mayDecide` /
`mayApproveIrreversible`. Its header states the pattern worth following:

> _"the SERVER answers it, with the same `authorizeAccount` call the method gate
> itself runs — one decision function, two readers, no second policy layer to
> drift. A client that renders a decide button per row has no way to know…
> and guessing produces exactly the dishonesty this repo refuses: **a button
> that fails at the round trip.**"_

Grant records themselves — who, what scopes, when, expiring, via which proposal
— are exposed on **no** surface a browser can reach. `bullmoose admin grant list`
is the only reader.

### The gap that matters most

The session answers **"what can I reach?"** It says nothing about **"who can
reach me?"**

For a settings page that second question is the headline — it is the reason
people open a permissions screen at all — and it is currently unanswerable
without the admin CLI.

### Three operations, three different answers

| operation                                          | verdict                  | why                                                                                                                                           |
| -------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **read** — grants on my account, and grants I hold | **yes**                  | it is my own ACL; needs a surface, not new authority                                                                                          |
| **revoke** — where I am the target                 | **yes**                  | narrowing, fail-closed, already tombstoned and logged in `grant_lifecycle`. The tier-1 shape: safe because being wrong costs access, not data |
| **create**                                         | **no — stays CLI/admin** | the widening direction, and it would drag the control plane onto the mail surface                                                             |

That last one is the boundary worth keeping: `bullmoose-provision` has **no
public route**, and the thing that decides who may read whose mail is not
reachable from the thing that reads mail.

### Where it lives

Two options; the first is cheaper and probably right.

**Extend `/console/*`** — already on the jmap worker as _"the agent console's
read interface"_, same-origin with the app for the same reasons `/api/*` is. A
grants read needs no new capability URN and no JMAP type.

**Or a vendor JMAP type.** `urn:bullmoose:params:jmap:agent` already carries
`AgentInvocation` and `ActionProposal`, so `Grant` would fit the precedent —
cleaner conceptually, more work, and it makes grants part of the JMAP contract,
which is a larger commitment than a console read.

Either way the gate is the same `authorizeAccount` the session already calls.

### Show the provenance

`grant_lifecycle` records the actor and `via_proposal_id`. A row reading
_"partner@ can read your contacts — granted by you, 3 March"_ is a different
fact from _"…granted via a proposal CJ made"_, and the difference is exactly the
material a human should be judging rather than a system classifying.

---

## 2. Bureau credentials

### The human problem

How does a secret get **into** the vault safely. Today: the CLI.

```
creds set <name> --kind <kind> --allow <origin> [--secret <s> | --secret-env VAR]
```

with the default being a **hidden prompt — "never argv"**, because `--secret` is
visible in `ps aux` and shell history.

### What the architecture already guarantees

From `services/agent/src/vault.ts`:

> _"a plaintext secret goes IN once, at mint and at rotate, on its way to being
> sealed. Nothing comes back… The agent worker therefore **cannot** unseal a
> credential: not by rule, by [construction]."_

The plaintext's whole life is: input → one HTTPS request → the agent worker (in
transit only) → the `BUREAU` service binding → sealed under a key only bureau
holds. **That server-side path is identical whether the client is a CLI or a
browser.** Nothing about a browser changes the sealing, the key custody, or the
one-way property.

### What genuinely changes in a browser

Exactly two things:

1. **The DOM is a shared surface.** Extensions with host permissions can read
   form fields; a terminal has no extensions.
2. **The page's script supply chain.** Any script on the origin can read the
   input. The webmail app is Astro + Preact with a build pipeline and an npm
   tree — a far larger surface than a compiled binary.

Clipboard and password managers are a wash; people paste API keys into terminals
too.

### Therefore: serve the entry page from a WORKER, not the Pages bundle

The precedent already exists and is trusted with something more sensitive.
`services/oauth/src/consent.ts` returns its own `Response` under:

```
default-src 'none'; script-src 'self'; style-src 'unsafe-inline';
form-action 'self'; frame-ancestors 'none'; base-uri 'none'
```

No bundler, no npm tree, no third-party anything — the whole page is one file
readable top to bottom. And that page already handles a **password** this way,
running PBKDF2 in the browser so the raw value never posts. If that is trusted
for a login password, a scoped API key is a smaller ask.

**So:** `creds set` becomes available in the browser, but the form itself is
served by a worker at its own path with the consent-page CSP — _not_ a Preact
component inside the mail app. `/settings` **links** to it; it does not embed it.

`--secret-env` stays CLI-only. It exists for automation and has no browser
analogue worth building.

### Security is comparative

Someone who will not install a CLI still has to get a key into the vault. Absent
a browser path, what actually happens is the key lands in a config file, a note,
or an email — all strictly worse than a strict-CSP page over HTTPS that seals on
arrival. The alternative to a good browser path is not "no browser path"; it is
a worse channel.

---

## What this is not

Neither of these is a new capability. Both are **existing control-plane
operations getting a second client**, and in both cases the server-side
authorization is unchanged — `authorizeAccount` for grants, the bureau seal for
credentials. The work is surface, not policy.

The one place policy _does_ move: revoking a grant from settings means a browser
session can narrow an ACL. That is the safe direction, but it should still leave
a `grant_lifecycle` row naming the actor, exactly as the admin path does.
