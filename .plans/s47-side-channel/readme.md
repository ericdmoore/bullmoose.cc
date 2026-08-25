# s47 — the side channel · *a faster clock beside the slow one, and what it can hand you*

> **Status: DESIGN, from the 2026-08-24 conversation. Nothing built.**
> Two halves that arrived together and interlock, but build independently:
> **A** — chat as an approval venue (Slack/Discord), and the identity question
> that turns out to be the interesting part. **B** — artifacts: a page an
> agent authors once that renders per viewer, through the capability wall
> that already exists.

## Where this came from

Eric: *"It would be nice to mimic the ergonomics of a sales call where there
is a side channel text that accompanies the call."*

The analogy is exact, and it names the real cost. Email's approval loop is
paced by whenever the human next opens a queue; the thing being approved is
often time-sensitive in a way the approval is not. A side channel is not a
second conversation — it is **a faster clock running beside a slower one**.

---

# A · Chat as an approval venue

## The ledger already makes this safe

Every decision is `ActionProposal/set` — one row, one state, whichever
surface carried it. So a chat approve is a VENUE, not a second system, and
the guard that made the webmail popover safe (terminal states stay terminal;
a stale approve earns a clear refusal) already protects a chat button
pressed twice, or pressed after the margin already decided. Built once for
the margin, paid again here for free.

## Addressing: the channel, not the DM (Eric, 2026-08-24)

The first instinct is a DM per agent — chat with CJ, chat with Allen. Eric
retracted it in favour of **one general channel where agents are addressed
by name**, and the reason it is right is deeper than ergonomics:

**bullmoose agents are ALREADY addressed.** `cj@`, `allen@`, `bouncer@` —
an `@allen` mention IS a `To:` line on a faster transport. This is s38's
addressing scheme doing double duty, so "who am I chatting with" has the
same answer as "who did I email". No second identity model.

And the DM-per-agent shape has a real failure Eric named: *"I'm not sure
that I want to remember who I was chatting with."* A DM room makes you
decide WHO CAN HELP before you have said what you need — filing before
speaking, the anti-star principle wearing a different hat. In a channel you
say the thing and the mention routes it.

**Addressable ≠ conversational.** Every agent has an identity; only some
have a door that answers. `bouncer@` and `remind@` have mail-native doors
today; the extractor has none — it runs on delivery and takes no requests.
`@extractor what do you think?` must answer honestly ("I read what arrives;
I do not take requests") rather than inventing a conversation. That
distinction is also what stops the channel becoming a place where any agent
can be talked into anything.

## Identity: amortize the ceremony, never skip it

Eric's intuition — *private messaging → private info → less tea ceremony* —
is half right, and the wrong half is the dangerous one. A DM is private FROM
OTHER USERS; it is not AUTHENTICATED AS YOU. Its binding is to a
Slack/Discord account: controllable by a workspace admin, takeable over, and
not your mail principal.

The good version survives whole: **pay the ceremony once, not per message.**

### The first-mention ceremony (Eric's, and it is the best part)

The first time someone mentions `@cj`, she replies with a ceremony link that
binds their chat ID to a bullmoose principal. The trigger is the point: a
mention PROVES intent in a way a settings checkbox never does, and the
enrollment happens inside the flow that needed it. Mostly wiring parts that
exist — the enrollment link (#297: fragment-carried token, atomic consume,
already-enrolled refuses) and `ceremonyAsk.ts`.

**Each side proves its own half**, which is stronger than most chat
integrations manage:

- the token is minted FOR the chat ID that did the mentioning, and carries it;
- the browser flow proves the BULLMOOSE side by requiring a real session;
- the binding is written only where both land. Neither half is taken on the
  other's word.

Build these in from the first commit:

- **DM the link, never post it in channel.** The token binding means a
  stolen link cannot enroll someone else, but it should not be lying around.
- **Answer strangers identically.** A warm greeting for enrolled users and a
  "who are you?" for others is an EXISTENCE ORACLE for who is enrolled. Same
  reply until the binding exists.
- **Chat identity inherits the platform's trust model.** Workspace admins
  can read or export DMs on some plans. Good enough for tier-1 and reads;
  **tier-3 egress still asks for its own moment**, regardless of venue. A fat
  thumb on a phone notification is the most expensive tap in the product.
- **Listable and revocable** beside device tokens: leaving a workspace must
  be answerable in one command.

## Workspace: integrate, and say what that means

A dedicated workspace is a place you must remember to visit — the DM problem
one level up, when the whole value is being where the human already is. So:
the existing workspace, which is also the native bot shape on both
platforms.

The real question underneath is **data residency**, and it is a decision to
surface at install rather than bury: posting mail content into a workspace
means its owner and its vendor can see it. A family Discord is fine; an
employer's Slack is a corp-controlled space with retention and eDiscovery,
and personal mail summaries do not belong there.

Which suggests the tiering, conveniently matching the build order:
**notify anywhere, decide only where linked.** A low-trust workspace gets
contentless pings ("3 proposals waiting" + a link); a linked one gets the
rationale and the blast-radius line inline.

## And it closes the Hermes question

Hermes uniquely holds the Discord surface (the Sycamoore guild). The right
end-state was always *a bullmoose transport door, not a second brain*
(s09/s19). An approval channel IS that door: Discord gets a real job INSIDE
the governed system instead of a parallel one outside it.

---

# B · Artifacts — one link, N renderings

Eric's example: in a group chat, `@hr` answers "which benefit package makes
sense?" with a link to a page showing YOUR breakeven line, given YOUR role
and YOUR projected spend — the same link for everyone, different data per
viewer.

## The lens, not the gate

If the artifact held the access logic ("if viewer is Eric, show Eric's
numbers"), every artifact would be agent-authored security code and a
separate audit. It does not have to. The artifact ASKS for "my role, my
options, my projected spend"; the **viewer's own session** executes those
asks against the same method registry, through the same `requireAccount`
gates every client faces. One link, N renderings, and the difference is
enforced by the capability wall that already exists.

The consequence worth savouring: **the `@hr` agent that authored the page
never sees anyone's numbers.** It wrote a question; each person's own
credentials answered it. Personalised output without centralising the data.

Precedent, twice: webmail IS this (static files on R2 + a session that
fetches per-user data), and the explorer is the same trick with less UI — a
facade that calls the METHODS, never the store.

## An SPA, not a vocabulary (Eric's correction, 2026-08-24, and he is right)

The first draft of this section proposed a declarative artifact spec — the
sieve-dialect instinct, third application. Eric: *"in this example the
artifact was effectively a single page application. No vocabulary needed."*

The correction holds, and the reason the pattern does not transfer is worth
recording: the sieve dialect and the sandbox image constrain the model
because its output ACTS ON THE SHARED SYSTEM — a rule that files everyone's
mail, code that runs against data on a host. An artifact runs in ONE
VIEWER'S BROWSER WITH THAT VIEWER'S OWN AUTHORITY, so its blast radius is
exactly "what that person could already do by hand". It adds no capability.
A vocabulary would buy nothing and cost all the expressiveness.

So the controls move from WHAT IT MAY SAY to WHERE IT RUNS — headers, not
grammars:

- **A separate origin.** `artifacts.bullmoose.cc`, never `app.` — the
  artifact cannot reach webmail's session, and the address bar visibly says
  "this is not the mail app". That is also the anti-phishing line:
  credentials are typed only on the real origin, via an ordinary OAuth
  redirect.
- **`connect-src` pinned to the API origin.** The one that matters most. An
  SPA that can fetch your compensation record AND POST it anywhere is an
  exfiltration primitive; one that can only talk to bullmoose is a lens.
  The same posture as the sandbox's `--network=none`, as a CSP directive
  instead of a container flag.

With those two, an agent-authored artifact is a third-party app on a
platform that already hosts third-party apps — the OAuth-app shape MCP
clients already use, pointed at a page an agent wrote.

## The residual: artifacts are DURABLE

Unlike a chat message, an artifact keeps rendering fresh data every time it
is opened, long after the conversation that produced it. So it wants the
ordinary furniture — an owner, a listing, an expiry or a revoke — for the
same reason share links do. Not a blocker; the thing that would otherwise
accumulate quietly.

---

# C · Whose budget? — attribution in a shared room (Eric, 2026-08-24)

*"Attributing billing & budgets are perhaps the annoying or hard part. Users
might author a BudgetShareProposal — where users can split the cost 50/50 or
chip in $5 right now."*

It belongs here, and the reason is sharper than "money is annoying": **the
side channel is the first venue where work happens in a SHARED context.**
Every invocation until now belongs to one account's binding with one budget —
a mailbox is a room of one. A group channel asks an agent to do something
for a ROOM, and that is what makes "whose budget" a live question.

## Artifacts mostly pay for themselves

B's lens design already answers attribution for artifacts: each render runs
on the VIEWER'S OWN SESSION, so the cost lands on the viewer. `@hr` pays once
to author; ten colleagues each pay for their own render. A second dividend
from "lens, not gate" — no sharing mechanism required.

## Chat: requester-pays, which the ceremony makes computable

Today cost follows the BINDING, so whoever hosts `@cj` pays for everyone's
use of her — fine for a mailbox, wrong for a room. Once a mention is bound
to a principal (A2), **requester-pays** becomes computable: the person who
asked has an identity to charge. That is a better default than host-pays and
needs NO new proposal type. Build it before anything fancier.

## The machinery already exists, and further along than expected

`agent_budget_overages` (data-plane.sql) carries `approved_by` — "the
deciding principal" — and its PRIMARY KEY includes `proposal_id`. So N rows
per (account, binding, period), each with its own approver and amount,
summed by the same `budgetExhaustedSql` the claim gate already runs.
**"Three people chipped in" is representable today.** A BudgetShareProposal
is largely the shipped `budget-overrun` shape with the approver being
someone other than the owner.

## The two shapes are different animals

| | shape | treatment |
|---|---|---|
| **"chip in $5 now"** | discrete, bounded, one period | one overage row, one approver, done |
| **"split 50/50 ongoing"** | STANDING AUTHORITY — it changes what happens to your money while you are not looking | the rules-ladder treatment: tier-2 hold tray, visible, and REVOCABLE |

The second is the s31 lesson arriving in a second domain: a standing
commitment is not a bigger one-off, it is a different kind of thing.

## The line: excellent at attribution, honest about settlement

The platform can say with precision whose work cost what, and who committed
to cover it. Whether $5 actually MOVES between two humans is a payments
problem, and s36 already set the rule: **payment ends at a prepared,
reviewable handoff, never a transfer.** A BudgetShareProposal allocates
HEADROOM, not dollars. Anything else and the product is a payment processor
that also reads mail.

---

## Order of work

**A1 — notify only.** Proposals and their rationale pushed to a configured
channel, no decisions, no identity. Useful on day one and forces ZERO
identity decisions while the shape is lived with.

**A2 — the first-mention ceremony.** The binding, both halves proven,
DM-delivered, strangers answered identically, listable and revocable.

**A3 — decide in channel.** Approve/decline/close carried by the chat
surface into `ActionProposal/set`. Tier-3 still asks for its own moment.

**B1 — the artifact object.** A FileNode-backed page with a stable URL, an
owner, and a revoke, served from a separate origin with the two headers.

**B2 — the first artifact.** `@hr`-shaped: an agent-authored page whose data
comes entirely from the viewer's own session.

**C1 — requester-pays**, once A2 supplies the identity. No new proposal
type; the cheapest correct answer, and it may be the only one a household
ever needs.

**C2 — the chip-in.** A `budget-share` proposal writing an overage row for
somebody else's binding — the shipped shape, a different approver.

**C3 — the standing split**, only if C2's evidence shows one-offs are being
re-approved over and over. Standing authority, hold tray, revocable.

A, B and C are independently buildable; the `@hr` story is what happens when
all three exist.

## Open questions

1. Does an UNENROLLED mention get a useful answer at all? (Leaning: public
   facts only — "here is what I do" — with anything account-specific behind
   the link.)
2. Is the binding **per-workspace or global**? (Leaning per-workspace: safer,
   and it matches how people separate work from home — at the cost of
   enrolling twice if you use two.)
3. Slack and Discord both, or one first? (Discord has the standing guild;
   Slack has the workplace story s28 points at.)
4. Does requester-pays need a FLOOR for the unenrolled? Someone who mentions
   `@cj` before enrolling has no budget to charge — host-pays for a bounded
   first taste, or refuse until enrolled? (Leaning: a small free allowance,
   because "prove who you are before I answer at all" is a poor first
   impression, and the ceremony reply itself costs nothing.)

## Related

- [[s33-assurance-ladder]] — the prerequisite: who is asking, and how sure
  are we. The ceremony is its machinery.
- [[s38-addressing]] — the addressing scheme the channel reuses wholesale.
- [[s09-messaging]] / [[s19-transports]] — one ledger, many venues; this is
  a venue.
- [[s03.B-files]] — where an artifact lives.
- [[s27-usage-and-spending]] — the ledger C reports into; this section adds
  the SHARED-ROOM case it did not have to answer before.
- [[s44-tool-loop]] — the artifact is a lens the loop could author.
