# s20 — agent-native UX: verbs first, nouns when they earn it

> **Status: design** (2026-08-14). Distilled from Eric's `.backlog/conceptual-reorg/`
> bombshell — four docs asking the first-principles question: *"HOW IS AGENT-FIRST EMAIL
> DIFFERENT from GMAIL?"* — plus the review that followed. This readme records what was
> adopted, what was rejected, and why; [`devPlan.md`](./devPlan.md) is the ordered build.
>
> **The finding that frames everything: this is not a pivot.** The reorg re-derives the
> product's own thesis — decision-first, not storage-first — and most of the machinery it
> calls for already exists: the Proposals queue is `ActionProposal` (s03.D T1, landed), the
> Needs Attention view is the s07 T0 home view, the Watch primitive is `.backlog/reminders.md`
> + s11 `due_at` + the SLA armed responder, the authority envelope is the floor rule +
> privacy pins + governed books, the trust ladder is s03.D T5's repetition→policy, and
> "connections" is the Bureau. The docs are best read as the *why* behind work already queued.
>
> **The Gmail-feel diagnosis, corrected.** The webmail feels like Gmail because the
> approvals queue is empty — the UI renders the agent layer faithfully; the agent layer
> isn't producing artifacts yet (only s03.D T1 landed; few agents propose). A "Needs
> Attention" queue with nothing in it *is* an inbox. The fix is supply, not ontology.

## The governing rule: conservative nouns, radical verbs

The conceptual-reorg readme's own coda overrules its first eight sections, and this plan
adopts the coda: **keep familiar nouns (Inbox · Message · Thread · Person · Files), radically
expand the verbs (Ask · Watch · Delegate · Follow up · Bring-X-in · Approve), and let new
nouns emerge only where repeated agent behavior proves them necessary.**

Why this is the safe direction: traditional software needs nouns because the human operates
the state machine; agentic software hides state behind intent. Shipping a new concept
("Situation") from a design meeting is the Google Wave failure mode. Letting "Waiting"
become a noun *after* users keep saying "remind me if they don't answer" is discovery.

One noun is admitted immediately because it has already earned its place three times over
(remind@, the SLA responder, s11 overdue escalation): the **Watch** —
`condition + deadline + action + escalation`. A star is a human telling their future self
"something about this is important"; a Watch is a contract the system can actually execute.

## Adopted principles (from the conceptual-reorg docs)

1. **The agent consumes the firehose; the human gets exceptions.** Notifications say
   *"2 things need you"*, never *"17 new emails"*. Unread stops mattering.
2. **Uncertainty is first-class.** *"We chose Capri. I don't know why"* beats a
   compulsively-completed model. Extracted facts carry `explicit | implicit | unknown`
   provenance and evidence refs, and the system may ask *"Worth remembering why?"* —
   institutional memory as an offer, not a form.
3. **Extracted views, not stores.** Waiting-on, Commitments, Decisions are *read models*
   over mail — the `ActionProposal` pattern (a side-table view, never a second source of
   truth). A wrong extraction is corrected by the human, and the correction FEEDS the
   extractor, riding the same loop as quarantine rescues → Bayes.
4. **Compose keeps the editor; intent becomes the front door.** "What do you want to
   happen?" routes through the existing proposal machinery; prose is the precision tool.
5. **Task ≠ Commitment ≠ Obligation** — could-be-done vs. said-I'd-do-it vs.
   externally-imposed. Valuable *internally* even if Obligation never becomes user-facing.

## Rejected / deferred, and why (recorded so it is not re-litigated)

- **"Situation"/"Thread" as a shipped durable object — deferred as a CONTAINER, resolved
  as a CONTRACT** (Eric, 2026-08-14, and devPlan T6). The container version — a folder of
  related stuff — stays deferred; it is about-ness, the storage-first instinct. What ships
  instead is the **Goal**: the docs' own Delegation primitive (goal / may / may-not /
  escalate-when / done-when) decomposing into an approvable workflow over the s11 T7 jobs
  DAG, with checkpoints that thin by class as trust grows. Done-ness, not about-ness.
  Whatever else emerges, it is **not "Thread"** — that collides with fifteen years of user
  vocabulary and this codebase's own (`ThreadListView`, `fix/indexer-threads`).
- **The Gmail-connector wedge — out of scope, and the tension is recorded.** The vs-Google
  doc argues the wedge is "the agent-native client for the email you already have"; the
  monetization doc says don't host email first. Bullmoose already IS the host — transport
  is sunk cost at ~$0/mo, which is precisely why it can skip the wedge debate. A connector
  mode would be a company-sized decision, not a sprint.
- **Monetization tiers — premature**, with one exception already decided de facto: the repo
  is public under LICENSE, so "what is open" is answered. The doc's best boundary —
  **intelligence is open, agency is hosted** — is already this architecture: the s11
  scheduler's sit-free / escalate-near-due split is the open/hosted line, in code.
- **Firehose economics — a named risk, not yet a task.** Every synthesis, extraction, and
  Watch evaluation is inference spend, and this plan multiplies load. s11 T5 ($/work) is
  deferred pending cost history; S-D must ship with per-extraction cost recording so that
  history exists. "Agent actions: 184/500" is the right consumer surface when tiers come.
- **Marketing copy — good hooks, two fixes needed before use.** The developer copy's
  "Email is a log" framing is strong. The mom copy must lose "more hours than you have
  discipline" (reads as blame; the reader's problem is load) and BOTH copies need the trust
  beat — a product asking to read everything you've ever received cannot omit "private,"
  "yours," "self-hosted."

## The layer picture this plan builds toward

```
Human layer:          exceptions, decisions, commitments, relationships
Agent layer:          proposals, watches, delegations          ← s20 + s03.D build here
Communication layer:  conversations, messages, attachments     ← exists (s03.C, s07)
Transport layer:      SMTP, JMAP, headers, folders             ← exists (core)
```

Traditional webmail exposes the bottom two layers and makes the human mentally construct
the top two. The inversion is the product. The traditional mailbox survives one level
down — sometimes you really do want to inspect the filesystem.

## References

- `.backlog/conceptual-reorg/` — the four source docs (readme, vs-google, monetization, copy)
- `../s03.D-coexistence/devPlan.md` — T2–T5: the supply side this plan is gated on
- `../s07-app-surface/devPlan.md` — T0 home view: where the exception surface lives
- `../s11-scheduling/devPlan.md` — due_at, the watchdogs, the free/paid claim split
- `../s17-chief-of-staff/readme.md` — CJ: the delegation contract's natural first holder
- `../s18-notes/readme.md` — the Note entity T4's agent-commentary is built on; its
  mention→invocation mechanic makes a margin reply a delegation surface
- `docs/architecture/mcp-auth.md` §6 — the authorization model Ask rides on
