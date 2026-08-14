# s18 — private notes, mentions, and how a mention federates

> **Status: design stub** (2026-08-13 bedtime sidebar). Eric: private notes whose
> **address-mentions generate invocations** — *"largely UI work for humans"* — and then the
> real question: **can a mention federate**, to a hey.com user or, better, to another
> bullmoose instance on someone else's Cloudflare account and domain?

## 1. A Note is its own entity, not metadata on an Email

The discriminator: does the thing have its own lifecycle and query needs? A note **fails
four core mail concepts** — no recipients, no threading, no envelope/submission, and mail is
**immutable once sent** while a note is edited forever — and **needs two mail lacks**:
mentions and inline editing. Four misses plus two gaps is a different noun.

The tempting shortcut is "a draft that is never sent" (drafts are already mutable,
recipient-less and synced). It leaks: notes would appear in **Drafts in Apple Mail**, and the
only fix is a custom mailbox role — precisely the mistake `s12` spent a day undoing with the
invented `quarantine` role. Do not buy that lesson twice.

So: `Note/*` under the existing `urn:bullmoose:params:jmap:agent` capability (or a sibling
vendor URN). No new plane, no new auth model — the extension seam `ActionProposal` and
`AgentInvocation` already ride.

## 2. The mention is a TRIGGER, not a storage question

`agent_bindings.trigger_on` is already a vocabulary — `action-button | mailbox-delivery |
rule-hook | schedule`. **`mention` is the fifth**, and that is true regardless of where notes
live. It is also what makes this agentic rather than a text box.

Two constraints, cheap now and painful later:

- **Store mentions structured, never re-scraped.** Parse `@name@domain` once at write time
  into a mentioned-principal reference. A trigger that re-parses prose at fire time
  re-interprets on every edit and produces fragility nobody can debug.
- **Fire once per (note, mention) pair**, or every autosave re-invokes the agent. Same
  idempotence discipline as `s11` T9's period marker and `s12`'s screening marker — the
  third instance of this pattern, which makes it a house rule rather than a coincidence.

## 3. Federation: mentions travel as EMAIL, because that is the protocol we already speak

**JMAP is client-server only** — the same structural fact as RFC 7395 (XMPP over WebSocket is
C2S; Matrix needed a separate server-server API). There is no JMAP federation and there will
not be one. bullmoose therefore has exactly one federation protocol, and it is the one the
product is built on: **SMTP**.

| far end | what happens |
|---|---|
| **same instance** (`@allen@bullmoose.cc`) | no wire protocol — resolve the principal, fire the invocation directly |
| **another bullmoose** (`@alice@othermoose.cc`) | mail carrying a structured header (`X-Bullmoose-Mention: <note-ref>` + a share link, the `s12` outbound-stamping pattern). The receiver materialises a **first-class mention** — the remote agent can be triggered, the remote UI can render it as a mention rather than a message |
| **hey.com / Gmail** | an ordinary email: "Eric mentioned you", with a link. Header ignored, nothing breaks |

**Authentication is already solved: DKIM.** Outbound mail is signed today, and a mention
arriving DKIM-aligned on `bullmoose.cc` is authenticated federation using machinery that
shipped years ago — the same trust model `s12` stage 2 applies to the topmost
`Authentication-Results`. No new PKI, no instance registry, no shared secret.

Note the shape: **richness degrades by what the far end understands**, exactly like a JMAP
capability a client does not declare. Extension without breakage, again.

## 4. The hard question is access, not transport

Mentioning `alice@othercorp.com` in a *private* note: may she read it? Both defaults are
wrong — silence is useless, and auto-sharing means a private document leaves the instance
because someone typed an `@`.

**Recommendation: the mention carries a share link whose scope is an explicit authoring
decision**, stated in the UI *before* sending ("mentioning Alice will let her read this
note"). Informed consent at write time, not a policy buried in settings. Federation is the
moment private stops being private and it should feel like one.

**And when an AGENT mentions an external address, that is egress — so it hits the governing
book** (`s10` T1), unchanged. An agent cannot `@`-mention its way past its allowlist.

## Open questions

1. **Does a note live inline or as a blob?** Small notes inline; large ones want the FileNode
   path. *Recommendation: inline first — a note that needs R2 is a document, and documents
   already have a home (`/files`).*
2. **Do mentions of a GROUP expand?** Same transitive-widening hazard as `s10` T1's nested
   groups. *Recommendation: forbid group mentions until the expansion is displayed.*
3. **What does the remote instance do with an unknown note-ref?** *Recommendation: render the
   mention, let the share link 404 honestly; never synthesise content.*

## References

- `docs/architecture/agent-integration.md` — `trigger_on` vocabulary; §4 grants
- `.plans/s12-boundary/outbound-stamping.md` — the header-carries-a-pointer pattern
- `.plans/s10-agents/devPlan.md` T1 — the governing book that bounds agent egress
- `packages/jmap-core/src/capabilities.ts` — the vendor capability a `Note/*` type rides
