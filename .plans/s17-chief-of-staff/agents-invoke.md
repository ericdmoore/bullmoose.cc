# `agents:invoke` — the blocker, and Eric's answer to it

**Status: deferred, with a promising resolution not yet built.**
Written 2026-08-15 after a design pass stopped rather than implementing.

## Why the design pass stopped

`packages/scheduling/src/attenuation.ts:271` refuses a cross-binding child:
_"a child runs under its parent's binding — cross-binding delegation is
`agents:invoke`, deferred."_ Three of the four things blocking it have landed —
#132 (envelope real at use time), #138 (the fold covers **every** binding the
chain crosses), #143/#146 (per-invocation tokens). The arithmetic is ready.

The design pass still stopped, on one sentence:

> **Cross-binding delegation intersects capability and substitutes identity, and
> the fold only knows about capability.**

`NodeAuthority` has three axes — tools, credentials, budget — and #138 folds all
three correctly across crossed bindings. But a binding is more than those three,
and everything else is keyed on the **acting row's** `binding_id` with no term in
the fold:

| per-binding control                                 | where                                                                       | cross-binding effect                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| governing book (`recipients_book_id`)               | `services/agent/src/outbound.ts:30` binds `job.binding_id`, never the chain | **A sends to B's recipients**                                     |
| `privacyFloor`                                      | stamped at ingest, from the acting binding                                  | a child on B carries A's privacy class, possibly below B's floor  |
| monthly cap                                         | `claimGate.ts` keys `inv.binding_id`                                        | **A spends B's month**, and can exhaust it, starving B's own work |
| persona / model / `allowedSenders` / accountability | `config_json`, resolved from the acting row                                 | A's work runs as, and is attributed to, B                         |

The sharpest form: **whose governing book bounds a cross-binding send?**

- **B's** → A reaches addresses its own book forbids, by handing work to someone
  whose book allows them. No book changed, so `binding_lifecycle` logged nothing.
  That is the self-grant shape one level up — authority laundering by delegation.
- **A ∩ B** → provably safe and the fold already computes it, but delegation can
  then never _lend_ a specialist's reach. "Route this to hermes because hermes
  talks to the board" becomes impossible, which may be the entire point.

Both answers change what a shipped, separately-administered control means.

## Eric's answer: make delegation respond-only

> _"I wonder if delegation needs to be reply-respond only?"_

This dissolves the question rather than answering it, and **the machinery already
exists**. #147 shipped the respond-only rule — _solicitation is authorization_ —
and `services/agent/src/index.ts:768` states its four independent
authorizations, of which the load-bearing one here is:

> _2. the reply targets exactly `[sender]` — the person who asked_

The same file already uses `job_id` as the discriminator, and reaches the
opposite conclusion for delegated work today:

> _"A JOB NODE reaching this pipeline was created by a planner, not by inbound
> mail from an allowlisted human: nobody asked it anything, so nothing
> pre-authorized its reply."_

**If a delegated node may only reply to the original requester, the recipient is
not chosen by either binding — it is fixed by the inbound message.** `the-board@`
becomes reachable only if the-board@ wrote in first, at which point they
solicited it. No book has to bound the send, because no new address is
reachable, so the A∩B-versus-B fork never has to be resolved.

That is a better outcome than either horn.

### What it does not fix

Respond-only bounds **the recipient set**. It leaves the other two substitutions
untouched: a delegated node still spends **B's monthly budget** and carries
**B's privacy floor**. Those need their own answers.

And it is a real narrowing: delegation could never _initiate_. No delegated
scheduled report, no "introduce me to X." That may be exactly the constraint
worth having — but it should be chosen, not discovered later.

### Open, if this is pursued

1. **Propose or egress?** Today a job node always proposes. Respond-only could
   mean (a) delegation stays proposal-only but is _additionally_ constrained to
   replies, or (b) a delegated reply to the original requester egresses directly
   like any other solicited reply. (a) is strictly safer; (b) is what makes the
   feature feel fast. They are different decisions.
2. **Can the reply add recipients?** If a delegated reply may cc or reply-all,
   the hole reopens immediately. The existing rule's _"exactly `[sender]`"_ is
   what makes this safe, and it must stay exact.
3. **Budget and privacy floor** still need folding or a policy.

## Two write-path defects that only appear once the refusal lifts

Found during the design pass; both are latent today because the identity rule
hides them.

- `services/agent/src/jobs.ts:397` writes `parent.binding_name` for every child
  unconditionally. A cross-binding row would carry A's _name_ over B's _id_ — a
  denormalization lie every progress and audit surface reads.
- `expandPlan` never checks that the child's binding exists or is enabled.
  `startJob` does (`jobs.ts:145,151`); `expandPlan` inherited the check for free
  from the identity rule. Lifting the rule silently drops the 008 kill switch at
  the create path.

## Also worth knowing

- **Cross-_account_ delegation — CJ's actual use case — is not buildable today.**
  `delegationChain`, `expandPlan`, `insertChildren` and `jobs` are `account_id`
  -scoped in every query, and `principalForInvocation` deliberately drops
  grant-reached accounts. So un-deferring cross-_binding_ ships the less useful
  half.
- **`startJob` has no production caller.** The whole Job harness is exercised
  only by tests, so `agents:invoke` would be a second unbuilt feature stacked on
  a first.
- **`.plans/s17-chief-of-staff/readme.md:37`** — _"Un-defer `agents:invoke` —
  safe because of (1): a delegation is just a child node under a parent's
  ceiling"_ — is false as written. A child on another binding is also under a
  different book, a different privacy floor and a different month's budget. That
  step needs restating before it is scheduled.

## Recommendation

Keep `attenuateChild`'s refusal until the respond-only shape is decided and the
budget/privacy questions have answers. When it is relaxed, the honest change is
not deleting the check — it is extending the fold to every per-binding control
the chain crosses, adding reciprocal `mayInvoke`/`invocableBy` allowlists on the
operator plane, and fixing the two write-path defects above.
