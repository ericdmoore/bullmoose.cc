# s38 — Addressing · *agents get their own namespace*

> **Status: DESIGN — the decision is made, the migration is not.** Written
> 2026-08-22 from the #273 conversation: *"With a naming convention then the
> address spaces become easier to manage."*
>
> **Execution plan (2026-08-24), awaiting Eric's go.** Step 1 (onboard the
> subdomain) is not a pure runbook step — it hits one code gap and one live
> unknown, in that order:
>
> 1. **CODE FIRST: `addDomain` assumes domain == zone.** Its first act is
>    `/zones?name=${domain}` (provision/index.ts), so `agents.bullmoose.cc`
>    422s today ("zone not on account"). The fix is a suffix-walk zone
>    resolution (strip leading labels until a zone matches — the account is
>    derived the same way `cloud plan` derives it) and writing the
>    subdomain's DNS records (MX/SPF at `agents.<zone>`, DKIM CNAMEs for the
>    SES identity `agents.bullmoose.cc`) into the PARENT zone, which the
>    zone-scoped DNS API supports as-is. Testable against fakes; a normal PR.
> 2. **THEN THE LIVE UNKNOWN: Email Routing on a subdomain.** Cloudflare's
>    zone-level Email Routing enable writes apex MX; whether the
>    rules/catch-all engine accepts `*@agents.bullmoose.cc` destinations (and
>    what API surface enables subdomain routing on this plan) is a fact to
>    OBSERVE, not assume. The probe is cheap and honest: run the patched
>    `admin domain add agents.bullmoose.cc`, read each receipted step, and
>    `cloud doctor --zone` after. If CF's routing declines subdomain
>    addresses on this plan, the fallback is SES inbound for the agent
>    subdomain only — a bigger decision, brought back here before building.
> 3. **Then the runbook as written below**: new agents provision on
>    `agents.`; existing apex agents dual-route (step 2 below); nothing
>    retires without a reason.
>
> OQ2 (test personas' namespace) and OQ4 (#273 closes as obsolete) ride the
> same PR's close-out.

## The decision

**Agents live on their own subdomain.** `analyst@agents.bullmoose.cc`, not
`analyst@bullmoose.cc`.

Not an underscore prefix, not a reserved-word list on a shared namespace.

## Why — and it is not anti-phishing

The argument that carries this is **address-space management**, which is
unglamorous and real:

- **Collision becomes impossible rather than forbidden.** A human picks from
  one namespace and an agent lives in another, so there is nothing to contend
  for. That is strictly better than [[#273]]'s denylist, which is a rule
  somebody has to remember to enforce at every door where an address is chosen.
- **The check that could not bite goes away.** #273 stalled because the only
  callers of `createAccount` are operator-plane, and the system provisions
  `bouncer@` through that same function — so a denylist would need a bypass
  every current caller uses. A namespace split needs no gate at all.
- **Per-subdomain DKIM/DMARC.** Agent mail can be signed and aligned
  separately from human mail, which is a lever [[s33-assurance-ladder]] can
  read: "this came from the agent plane" becomes a *cryptographic* fact rather
  than a string convention.
- **"Is this an agent?" becomes machine-checkable** from the domain alone —
  useful to the boundary (`services/ingest`), to the outbound gate, and to any
  future routing decision, without parsing local-parts against a list.
- **Offboarding and per-tenant isolation** get simpler: retire or scope a whole
  namespace instead of auditing names one at a time. A BYO-domain install
  (s32/s33) gets `agents.customer.com` for free.

**The schema already allows it.** `domains` is keyed on a plain string
(`domain TEXT PRIMARY KEY`), so a subdomain is another row and another
onboarding run — no migration to the control plane, and subdomains are already
the house convention (`app.`, `auth.`, `mcp.`, `explore.`, `dl.`).

## What it does NOT solve, and saying so plainly

**Nobody is stopped from being duped by this.** People do not parse strings —
the same lesson SiteKey taught (users do not notice what is missing, and do not
scrutinise what is present). `hr@agents.company.com` versus
`hr@agents-company.com` is not a distinction anyone catches at 3am, and
[[s33-assurance-ladder]]'s hole #2 makes it sharper: the agent's mail is
*authentic*, DMARC-passing and correctly branded, so there is nothing wrong
with the address to notice.

**Disclosure is a CONTENT problem**, and half of it already ships:
`Auto-Submitted: auto-replied` / `auto-generated` are stamped on agent outbound
(`services/agent/src/proposals.ts`, `ledger.ts`). That is the machine-readable
half, and it is what stops loops.

The missing half is human-readable — the agent introducing itself, in the body,
in its own voice. Which suits the chief-of-staff framing better than a sigil
would: **a good chief of staff introduces themselves; they do not rely on you
reading their name badge.**

## Rejected: the underscore prefix

`_hr@bullmoose.cc` was considered and refused on three grounds, the third
decisive:

1. Leading underscores are legal per RFC 5321 but **mangled or rejected** by
   enough real-world MTAs and address validators to be a permanent tax.
2. `_` already carries meaning in DNS (`_dmarc`, `_domainkey`); overloading the
   sigil invites confusion in exactly the records this system configures.
3. **It hands the attacker the better address.** If the real one is `_hr@`,
   then an impostor sending from plain `hr@` looks MORE canonical to anyone who
   has not memorised the rule. Every prefix scheme has this property.

## The hard part: migration

Agents are on the apex today — `allen@`, `editor@`, `analyst@`, `cj@`,
`hermes@` — in live threads, with live routing, and with correspondents who
have the current address. The apex is also a muddle: humans (`eric@`), agents,
and test personas (`emily@`, `mallory@`) share it.

**Do not do a hard cut.** Breaking a live thread to tidy a namespace is a bad
trade, and there is no `DELETE /accounts` to walk it back.

Proposed shape, in order:

1. **Onboard the subdomain** and provision NEW agents there. Costs nothing and
   stops the problem growing.
2. **Dual-route the existing agents** — the apex address keeps delivering,
   the subdomain address becomes canonical for anything newly minted. Existing
   threads never notice.
3. **Retire apex agent addresses only if a reason appears.** "Tidiness" is not
   one. The existing uniqueness check already stops a human claiming a
   local-part an agent holds, so the muddle is untidy rather than unsafe.

## Open questions

1. ~~**Which subdomain?**~~ **RESOLVED 2026-08-22: `agents.`** — Eric,
   "agents dot is also my preferred name". `ai.` ages badly and `staff.`, while
   the most product-honest, reads oddly for `bouncer@`, which is infrastructure
   rather than staff.
2. **Do test personas get a third namespace?** `emily@` and `mallory@` are
   fixtures living on the production apex. Separate question, same smell.
3. **Does the boundary treat the agent subdomain specially on INBOUND?** It
   could — but a subdomain is trivially spoofable in a `From:` header by an
   outsider, so any such rule must key on DMARC alignment, never the string.
4. **What happens to `#273`?** It should close as obsolete once step 1 lands,
   with the registry half (role addresses have no single declaration) either
   done or explicitly dropped.

## Related

- [[#273]] — the denylist this retires
- [[s33-assurance-ladder]] — per-subdomain alignment as an assurance signal;
  the sign-up flow's "address decision, made once"
- [[s32-agent-market]] — BYO-domain installs inherit the split
