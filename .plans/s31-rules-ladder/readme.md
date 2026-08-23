# s31 — Rules: the three-rung ladder · *filtering as staff work, with the manual override intact*

> **Status: DESIGN — resolved in conversation (Eric, 2026-08-19; rung 2
> grounded 2026-08-22), nothing built.**
> Born the night BoogieMail's Rules screen said *"This account's mail server does
> not support mail-filtering rules"* — which was honest, and wrong to leave true.

## Where this came from

Boogie probed for `urn:ietf:params:jmap:sieve` (RFC 9661) and rendered the empty
state. We in fact HAVE sieve machinery — the `sieve_rules` table ships in the
migrations and the bouncer uses it internally — but no JMAP surface exposes it.

The first design instinct was a refusal: expose `SieveScript/get` read-only and
have `/set` refuse with "rules are staff-managed — ask the bouncer." Eric caught
the overreach: that is the anti-star principle curdling into a star of its own.
The s20 T2 rule governs here too — *prose is the escape hatch and the precision
tool, and removing it would be ideology*. Hand-written sieve is the power tool.
Nobody takes away the power tool to enforce agent purity.

## The ladder

**Rung 1 — sleeves up.** `SieveScript/set` (RFC 9661) accepts direct writes from
a human session. Scope-gated (decide the honest scope in the build; an
agent-marked token is refused here and routed through rung 2 — an agent editing
the rulebook without a proposal is exactly what the marker exists to prevent).
Provenance records *authored-by-hand*.

**Rung 2 — iterate with the bouncer.** The DEFAULT on-ramp, per the anti-star
principle: language ("quarantine anything from this sender") or a verb on a
message you are reading ("handle these like this"). The bouncer composes the
SieveScript — in its own supported dialect, so it cannot write a rule the
engine cannot run — and the composition lands as a **tier-2 proposal**, because
a standing filter is *standing authority*: it changes how future mail is
handled while you are not looking. The s20 T6 (#216) rule applies to the script
itself: **redlining the sieve in place IS the approval** when the edit leaves
nothing unresolved. The needsInfo-cycle question is now answered — see "Rung
2, grounded" below: Retry-with-nudge supersedes rather than edits. Same
proposal/decision/provenance rows either way — the venue moves, the ledger
does not.

**Rung 3 — auto.** Graduated standing authority, the s20 T6 checkpoint
pattern: once the human GRANTS the class, bouncer-composed rule changes
auto-apply. The grant is rendered visibly (the goal-view precedent — which
classes are manual vs auto), and it is revocable. It is **given, never
accrued**: silently-widening autonomy stays the one failure the whole product
exists to prevent.

**Climbing:** everything starts at rung 2. Repetition earns OFFERS — this is
s03.D T5's missing repetition detector ("you've archived this sender five
times; shall I file them automatically?"), the agent-offered twin of the
language on-ramp, compiling through the same bouncer→sieve→proposal machinery.
Rung 3 is a deliberate handover, prompted at most by an offer.

## Rung 2, grounded — two intents, one machine (Eric, 2026-08-22)

The rung-2 story, told concretely. You tell the bouncer "this email was
garbage, don't want to see it again." Two shapes of intent arrive:

- **General** — *"I don't like this."* The bouncer authors a BROAD rule.
- **Specific** — *"this thing from sender X is noisy, what if we ___."* The
  bouncer authors a NARROW rule.

**The mechanics are identical, and that is the design.** The two intents
differ only in what the composed rule QUANTIFIES OVER — the breadth lives
inside the rule, not in the pipeline that carries it. Which is also why the
button collapses into the same machinery: `[mark junk]` is intent arriving
pre-parsed. One composer, one proposal, one verb row, three on-ramps
(language, a message verb, the button):

```
intent → bouncer composes (its own dialect) → proposal
       → [ Accept | Edit | Retry (with nudge) | Decline ]
       → verify → apply
```

Note the product statement hiding in the button: `[mark junk]` here is a
RULE-AUTHORING act, not a one-off label. "File this one message" is triage
and already exists; "never again" is STANDING AUTHORITY, which is exactly why
it rides the proposal machinery rather than a keystroke.

### The verb row maps onto machinery that already exists

- **Accept** = approve — `ActionProposal/set`, a ledger row.
- **Edit** = the s20 T6 rule already cited above: redlining the sieve in place
  IS the approval when the edit leaves nothing unresolved.
- **Decline** = reject, and the taxonomy fits without stretching: a mis-clicked
  `[mark junk]` is `unintendedInvocation` (teaches the composer NOTHING — the
  reason that reason exists); a bad rule is `wrongContent` (trains
  composition); "should not have offered" is `wrongAction` (trains selection).
- **Retry (with nudge)** — the genuinely new verb, and it ANSWERS this plan's
  open question about "the needsInfo cycle back to the bouncer." It is
  needsInfo INVERTED: needsInfo asks the proposer to justify what it already
  composed; retry hands the proposer new information and asks for a NEW
  composition. And under the decision-immutability model (a proposal is a
  thing that happened; decisions append, never edit): **a retry supersedes** —
  the old proposal is tombstoned as answered, a new one is minted carrying the
  nudge. Nothing is rewritten in place.

### The one real difference between the intents: evidence

Specific intent has a message in hand. General intent has no exemplar. That
changes what VERIFY means:

- **Specific:** run the composed rule against the triggering message (it must
  catch it — a rule that misses its own exemplar failed composition), then
  backtest the archive and report the BLAST RADIUS: *"this would have moved
  47 messages last month — 3 of them you replied to."*
- **General:** the backtest is the ONLY evidence there is, which makes it more
  important, not less. Breadth is where filters go wrong, and the false
  positive is mail you never see. A broad rule proposed without a blast-radius
  report is asking for assent, not approval.

The blast-radius line belongs IN the proposal's rationale, not in a detail
view — it is the difference between an informed Accept and a rubber stamp.

### The verified-generation loop (2026-08-22) — rung 2's machinery, and shared

Eric, pressing on the one-shot problem: *"there is no guarantee that bouncer
makes valid SieveScript Rule on a one-shot. If we have a multiple turn there
can be a verification step."* Right problem, and the answer is sharper than a
model verification turn — the guarantee is STRUCTURAL, in three layers:

1. **The model never emits Sieve.** It emits the dialect (`SieveRule` JSON),
   schema-validated. `compileSieve` produces the RFC 5228 text
   deterministically, with tests pinning the compiled text against
   `sieveVerdict`'s actual behaviour. A model cannot produce an invalid
   script — only an invalid JSON blob, which dies at the schema.
2. **The engine is the verifier**, not a second model call. Exemplar check +
   blast-radius backtest (above) are the engine running the real rule over
   real mail. The engine cannot be wrong about what the engine does.
3. **NEW — the retry-with-transcript loop.** When the schema rejects, or the
   composed rule misses its own exemplar, the harness retries the model call
   with the error appended — bounded (2 retries), each turn cost-stamped on
   the SAME invocation, all before any proposal exists. This is multi-turn in
   the harness-owned sense: the harness constructs every turn's input, the
   model holds no authority between turns, and an injected email still has
   nothing to call. Distinct from the human's Retry(nudge), which supersedes
   a minted proposal; this loop runs silently inside composition. Exhausted
   retries fail the invocation honestly — the button reports the failure, no
   proposal is minted, nothing "best-effort" lands in the ruleset.

The loop is SHARED machinery, built here with its first consumer. Extract's
parser deliberately degrades to `[]` (a missed note costs little); a
generator whose output must SATISFY a schema gets the loop instead — the
distinction is whether failure costs an annotation or a wrong artifact.
Second consumer extracts it into the harness proper; do not build it
speculatively general. Related: `.plans/s44-tool-loop` places this as tier 2
of three (step → verified generation → model-driven tools).

### The popover lifecycle — mint at compose, (X) closes (Eric, 2026-08-22)

The button flow has an escape hatch the queue never had: the popover's (X).
Decided:

**Compose mints the proposal** — a real record, real cost stamped on its
invocation, the popover a second UI over the same row. The two surfaces
cannot disagree because there is only one state.

**(X) closes the proposal, immediately and terminally.** Not "leave it
pending to expire" — closed. Three consequences, each load-bearing:

- **The close is NOT a decline.** It is closed-as-unanswered: no reason, no
  training signal, nothing the composer learns. A mis-click ends as SILENCE,
  which is the honest ending — the annotation posture arriving here (closed,
  never deleted; the non-judgment is the record). This is also why the button
  surface rarely needs `unintendedInvocation`: that reason exists because a
  human was FORCED to record a decision to clear an item, and the (X) removes
  the forcing. The reason stays in the enum for surfaces without an escape
  hatch and for any mis-click proposal met later in the queue.
- **Composed-then-closed is directly countable** — a status to query, not an
  inference from expiry timing. The button being too easy to graze shows up
  as a number, sibling to the manual-+Cal and unintendedInvocation rates.
- **No queue debris.** Nothing pends, nothing waits out a TTL.

⚠️ **A closed proposal must never tombstone a future ask.** Extraction's
re-offer suppression treats ANY prior status as "do not ask again" — correct
there, because those offers are UNSOLICITED. Button-initiated composition is
SOLICITED: the human clicked. A mis-click-then-(X) on Tuesday must not block
a deliberate [mark junk] on the same sender Thursday. Opposite rules for
opposite directions of initiative, and the build must not share the dedup
path between them.

Build note: the terminal state wants to be DISTINCT (a `closed`/`dismissed`
status) rather than an overload of `expired` — the metric above needs to
tell a timeout from an explicit (X), and inferring it from timestamp
arithmetic is the fragile version. The cost is the usual five mirrors
(server enum, webmail types, demo, cli-go, and any learning allow-list);
budget for them.

### One precision that keeps approval honest

"The bouncer takes that as approval" must never be literal. The bouncer does
not INTERPRET approval — *"sure, let's add that"* lands as
`ActionProposal/set { approve }`, a ledger row, whichever surface carried it
(button, margin, mail reply through the edit-is-approval parse). A composer
judging its own approval is the exact failure the CJ-cannot-self-approve gate
exists to prevent; the venue moves, the ledger does not.

And the dialect constraint carries the s36 validated-output posture: the
bouncer composes in its OWN supported dialect, so it structurally cannot
write a rule the engine cannot run. Verification checks the rule's EFFECTS
(the backtest); the dialect makes its FORM safe by construction.

## The read side

`SieveScript/get` exposes the live compiled script — one store, one vocabulary:
hand-written rules, negotiated rules, and the bouncer's own operational rules
distinguished by **provenance, not by surface**. Any standards client's Rules
screen (Boogie's included) becomes a truthful rendering of the shared rulebook.
Advertise the capability only when `/get` is real; the session document does
not speculate (lesson of #230/#238: the spec's word beats our theory of it).

## Siblings and lineage

- **s03.D T5** — this IS its missing policy-write interface; the repetition
  detector lands here. Cross-link on build; record the closure in both files.
- **s20 T6 (#216)** — edit-is-approval and checkpoint graduation, reused not
  reinvented.
- **RFC 9007 Quota/get** — the small sibling found the same night ("this mail
  server doesn't report storage usage"). Blob sizes are derivable; pure polish;
  fold into this section's build or land it as a warm-up task.

## Open questions for the build

1. Which sieve subset does our engine actually run, and does RFC 9661 require
   advertising extensions honestly (`sieveExtensions` in the capability)?
2. Coexistence: are the bouncer's operational rules (quarantine machinery) in
   the same script a client sees, or a separate protected region? (Leaning:
   same store, protected by provenance — a hand edit cannot silently disable a
   boundary rule without the diff saying so.)
3. The scope for `/set` rung-1 writes (`annotate` is wrong; likely `send`-class
   authority or a considered new answer — argue it in the PR).
4. Where rung-2 conversations live: the compose→intent pipeline (s20 T3), a
   message verb (s20 T2), a rules@ door (remind@ precedent), or all three.
