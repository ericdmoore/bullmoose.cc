# s31 — Rules: the three-rung ladder · *filtering as staff work, with the manual override intact*

> **Status: DESIGN — resolved in conversation (Eric, 2026-08-19), nothing built.**
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
nothing unresolved; an open question is the needsInfo cycle back to the
bouncer. Same proposal/decision/provenance rows either way — the venue moves,
the ledger does not.

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
