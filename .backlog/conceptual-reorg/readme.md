> **Status: reviewed and distilled into [`.plans/s20-agent-native-ux/`](../../.plans/s20-agent-native-ux/readme.md)**
> (2026-08-14). The plan records what was adopted (the coda's conservative-nouns rule,
> Watches, uncertainty-first extracted views, intent compose, Ask), what was deferred
> (Situations as a shipped noun, the Gmail-connector wedge, monetization tiers), and the
> review's key finding: most of this machinery already exists — the Gmail-feel is an empty
> approvals queue, so the first fix is supply (s03.D T2–T5), not ontology. These four docs
> stay as the source thinking.

The fundamental noun shift is:

> Message → Sythesize "The Situation" → A Desired Outcome → Agent Work → Human Approval

That leads to some pretty significant UX changes.

1. Inbox → Needs Attention Queue

“Inbox” is an implementation artifact: these messages arrived and haven’t been filed yet.

An agent-native system should instead answer:

What needs me?

So the primary view might contain things like:

- Decision required — “Sergio offered these two licensing structures.”
- Approval required — “I drafted a response and need permission to send it.”
- Waiting — “Structural engineer hasn’t replied in 4 business days.”
- FYI — summarized and automatically cleared after reading.
- Handled — agent completed it according to policy.
- Potential problem — “Contractor’s new estimate is 31% above the previous quote.”

The agent should be consuming the firehose. The human gets the exceptions.

That makes Unread dramatically less important. Whether you’ve visually rendered the email is almost meaningless.

⸻

2. Threads → Situations

Email threading is a weak proxy for what humans actually care about.

Imagine:

> “Attic Conversion”

That situation could contain:

- 3 email threads
- structural engineer PDF
- contractor estimate
- wife’s forwarded email
- calendar appointment
- permit correspondence
- previous decisions
- notes from a phone call

The situation becomes the durable object.

Email is merely one event stream feeding it.

This may be the biggest architectural/UX departure I’d make.

Threads
├── people (currently contacts) + new person
├── messages (currently mail) what was prior called a thread is now a "conversation"
├── files (exisitng), document storage, attachments, scratch pad for agents,
├── commitments (new)
├── decisions (new)
├── tasks (new)
├── calendar(existing)
├── ask(search) - chat interface: goal is find witihn my data someting im looking for or answer a question from my data.
├── agents (existing)
├── connections (MCP connections to the outside - would hold OAuth tokens etc)
└── agent-log (new)

⸻

3. Compose → Intent

The giant blank email composer is basically saying:

“Okay human, manufacture some language.”

That’s increasingly silly.

Instead:

> What do you want to happen?

You might type:

> Get Sergio’s thoughts on whether he’d be comfortable with me selling assembled Cripdeq boards. Explain that I want to support the project financially but can’t make a major commitment yet.

Then the agent should determine:

> recipients → context → appropriate tone → necessary questions → draft → send policy

There should absolutely still be a text editor. But writing prose becomes an escape hatch / precision tool, rather than the fundamental interaction.

⸻

4. Reply / Reply All / Forward → Actions

These are transport-level verbs.

Agent-native verbs would be closer to:

_Answer · Ask · Clarify · Decline · Accept · Schedule · Delegate · Introduce · Follow up · Negotiate · Pay · File · Investigate_

“Forward” is particularly interesting.

Instead of:

> Forward → Caroline → “FYI”

you might say:

> Bring Caroline into this.

The agent determines whether that means forwarding one message, summarizing the whole situation, CC’ing her on the next response, or starting a clean thread.

⸻

5. Search → Ask / Investigate

Traditional:

> from:sergio after:2026/01/01 cripdeq

Agentic:

> What did Sergio originally say about commercial use of Cripdeq?

Or:

> Have I ever promised Sergio a specific percentage of sales?

Or even:

> Figure out whether anything I’ve told Sergio conflicts with what I’m proposing now.

That’s no longer information retrieval. It’s research over personal communication history.

And I’d explicitly expose an Investigate action where the agent can traverse mail, attachments, calendar, contacts, and perhaps the web and return a cited answer.

⸻

6. Folders / Labels → Projects, People, Commitments

Folders are another artifact of storing messages.

I’d expect automatic durable views around nouns that actually matter:

**People**
Everything involving Sergio, regardless of threads.

**Projects**
Cripdeq / Tensr / Kramer / house addition.

**Commitments**
Things I said I would do.

**Waiting on**
Things somebody else said they would do.

**Decisions**
Things decided, including why.

That last one could become extraordinarily valuable.

Six months later:

> Why did we decide not to use vendor X?

And the system reconstructs the decision from seven emails rather than making you find them.

Decision lifecycle might be Something like:

> Proposed → Detected → Accepted → Active → Superseded

Maybe think of this akin to hermes deciding to add stuff to a MD file.. perhasp even to `MEMORY.md`

or maybe decisions are more stuctured:

```ts
intercface IDecision {
  statement: string
  supersedes: string?
  rationale:
    status: explicit | implicit | unknown
    evidence: RefUri[]
}

```

Be reluctant even to persist an inferred rationale as fact. Better:

Why: Not stated
Recent conversation discussed ferry logistics and hotel prices.

That’s epistemically clean.

And now the agent has a reason to occasionally ask:

> Worth remembering why?

or showing its empty in a UI

That phrase may even be better UX than “Add rationale?” because that’s what the system is actually offering: institutional/personal memory.

## then on Commitments:

Obligation vs Commitment vs Task

Task

Something that could/should be done.

> “Research Capri hotels.”

No one necessarily expects it.

Commitment

An actor has created an expectation that they will do something.

> “I’ll book the hotel tonight.”

The expectation arose from communication or an explicit undertaking.

Obligation

Something external requires action.

> “Property tax payment due Jan 31.”

The county doesn’t care whether you committed to paying it. 😄

That distinction could be valuable internally even if Obligation never appears as a consumer-facing noun.

And then there is a fascinating transition:

> “We should book the hotel.”

**Task: Book hotel.**

> “I’ll book it tonight.”

The agent has just observed the Task become a Commitment.

Then:

> “Booked. Confirmation attached.”

Commitment fulfilled.

And the booking itself may instantiate new future obligations:

> Cancellation deadline: Oct 12
> Remaining balance due: Nov 1

Those aren’t things anybody said they’d do. They’re conditions imposed by the reservation.

So the agent isn’t merely extracting todos.

It’s building a modest model of:

> What has been decided?
> What should happen?
> Who is expected to make it happen?
> By when?
> What are we waiting for?
> What actually happened?

And that feels much closer to the fundamental substrate underneath an agent-native email system than a sophisticated Inbox Zero.

One more design instinct follows from your rationale question: uncertainty needs to be first-class. The system should be perfectly comfortable knowing:

> We chose Capri.
> I don’t know why.

That’s much more trustworthy than an agent that compulsively completes every field in its internal model.

⸻

7. Flag / Star → Follow-up Contract

A star is basically a human telling their future self:

“Uh… something about this is important.”

Terrible abstraction.

Instead:

Wait for Sergio to respond. If he hasn’t responded by Wednesday, draft a friendly follow-up.

Now you’ve created a small agent contract.

This produces a major new noun:

**Watch**

A Watch has:

**condition + deadline + action + escalation**

For example:

> Watch this shipment. Tell me only if it won’t arrive before Friday.

That replaces enormous amounts of inbox checking.

⸻

8. Archive → Resolved

Archive exists because Gmail needed an answer to “where should the bytes go?”

Users don’t really care.

The meaningful state is:

> Is this situation active?

So I’d probably have:

_Active → Waiting → Resolved → Reopened_

Messages themselves don’t really need lifecycle states.

Situations do.

⸻

9. Drafts → Proposed Actions

This is another subtle but important change.

A draft currently means _unsent text._

Agentically, the useful object is:

> Something the system proposes doing on my behalf.

That might be:

Send this response
Schedule Tuesday at 2:00
Send these three attachments
Decline the proposal
Follow up next Thursday
Introduce Bob to Susan

So I’d have something like a Proposals queue.

That becomes the human/agent trust boundary.

Early on, the agent proposes everything.

As trust develops:

“You can autonomously schedule meetings with my direct reports during open work hours.”

Now those proposals can execute automatically.

⸻

10. Notifications → Exceptions

This one could radically reduce email’s psychological burden.

Agents shouldn’t notify you that things happened.

They should notify you that **something happened which changes what you should do.**

Compare:

> 🔴 17 new emails

with:

> 2 things need you

> Vendor increased price 18%.
> Grace’s tournament conflicts with your Saturday flight.

That’s the product.

⸻

And then I’d add one completely new primitive: Delegations

Imagine selecting a situation and saying:

> Handle this.

But “handle” opens a little contract:

**Goal:** Get three structural engineers willing to evaluate the attic.

**Agent may:** email, follow up, answer basic questions, share house plans.

**Agent may not:** agree to fees over $750 or schedule anything before 9 AM.

**Escalate when:** someone requests engineering documents we don’t have.

**Done when:** three viable options are ready for me to compare.

Now email isn’t really the application anymore.

It is the communications substrate through which an agent operates.

⸻

And this suggests a radically different top-level navigation than Gmail.

Instead of:

**Inbox | Starred | Snoozed | Sent | Drafts | Labels**

I’d seriously experiment with something like:

**Now | Work | Waiting | People | Decisions | Done**

With a persistent command surface:

> What do you want to happen?

And perhaps a small Agent Activity area showing what the system is currently doing on your behalf.

The interesting design constraint is that I wouldn’t eliminate the traditional mailbox. I’d put it one level down as something like Mail → All Messages, because sometimes you really do want to inspect the raw transport layer.

It’s analogous to files on a computer: agents may make ~/Documents much less important, but occasionally you absolutely need to see the filesystem.

So the hierarchy becomes:

**Human layer:** outcomes, decisions, commitments, relationships, exceptions
↓
**Agent layer:** tasks, watches, delegations, proposals
↓
**Communication layer:** conversations, messages, attachments
↓
**Transport layer:** SMTP, addresses, headers, folders

Traditional webmail basically exposes the bottom two layers and makes the human mentally construct everything above them.

Agent-native webmail should invert that stack.

---

…but the user can still click Inbox → email from Bob.

And right beside Bob’s message the system quietly knows:

> This belongs to your attic project.
> You’re waiting for Bob to provide the load calculation.
> He promised it by August 12.
> It’s now overdue.
> You previously told him your budget was $750.
> Follow up?

That’s enormously agentic without asking Eric to learn what a **Situation** is.

So I’d use a **“conservative nouns, radical verbs”** rule:

This is probably the strongest refinement I’d make to the original sketch.

Keep familiar nouns:

> Inbox · Peoople · Message · Thread · Person · Files ·

But radically expand what the user can do:

> Ask · Summarize · Find · Compare · Decide · Watch · Wait · Follow up · Schedule · Delegate · Handle · Approve

Then allow new nouns to emerge only where repeated agent behavior proves they’re necessary.

For instance, after users repeatedly say:

> “Remind me if they don’t answer.”

you eventually discover that Waiting deserves to be a top-level noun.

That’s much safer than sitting in a product-design meeting and deciding that humanity needs to understand a new concept called a Situation.

And there’s a deeper principle hiding here:

> A successful agent UX probably introduces fewer new abstractions, not more.

Traditional software needs nouns because the human is operating the state machine. Agentic software can hide much of that state machine behind intent.

That’s almost the exact opposite design philosophy from Google Wave — and probably the lesson worth taking from it.
