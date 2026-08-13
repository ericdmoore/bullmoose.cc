# s12 — the boundary: bouncer@, the sieve, and the lobby

> **Status: design stub** (2026-08-13 discussion; full design in
> [`../s11-scheduling/jobs-and-facets.md`](../s11-scheduling/jobs-and-facets.md) §6, which
> this section owns the *build* of). bouncer@ is promoted from the motivating-examples
> candidate list to the **fourth agent kind** (joining analyst / photos / newsletters) —
> uniquely shaped, because it sees ~every inbound message and sits on the hot path.

## What bouncer@ is

The boundary layer as an *agent*: deterministic mail-sieve first, model judgment only on
the ambiguous middle, facet-stamping for everything it admits. Ingest stays mechanical
(parse, dedup, store); bouncer is the named identity for enqueue-time **judgment**.

```
SMTP → ingest (mechanical: parse, dedup, store, mechanical facets)
     → bouncer (deterministic sieve → hard accept/reject; mid-band → model classify)
     → stamps judged facets (sender class, privacy ∨ floor, due_at, effort prior)
     → the LOBBY: pending invocations, visible to eligible claimants (s11 gate)
```

## The five design commitments (from the discussion)

1. **Deterministic first, model only on the mid-band.** Sieve rules are fast, auditable,
   and immune to prompt injection by construction — a rule cannot be talked out of its
   decision. The model sees only ambiguous mail, and its output is a classification enum,
   never a free action. p50 latency stays flat; mid-band mail may sit briefly in a
   screening state.
2. **Sender-classification first, message-rescue second.** Spam is a *sender* problem
   before it is a message problem. Sender classes are **address books** (known-good /
   blocked), inheriting CRUD on every protocol, CardDAV inspectability, `write_policy`,
   and the s10 membership **chain** — a reclassification is a logged, attributed event.
   Message-by-message rescue ("show me, let me pick the non-spam one") stays available as
   the quarantine-view escape hatch, deliberately secondary.
3. **The quarantine log is an append-only chain.** "Did I get mail from X in the last N
   days? Did you shunt it?" is an audit query over shunt events `(event, sender, reason,
   at)`. "Pass that sender through" is a **human-originated directive** → the s10
   decision-5 pattern verbatim: authenticated owner directive, applied with provenance,
   the chain row citing the directive.
4. **Bouncer stamps the judged facets** (s11 T6): sender class, privacy, `due_at`
   extraction (s11 T1 — deterministic patterns), effort prior. Facet-stamping is admission
   work, and admission is what a doorman is for.
5. **The floor rule bounds the doorman's power.** Privacy stamps compose max-wise against
   each binding's declared floor — a stamp may raise, never lower. A compromised bouncer
   can delay or over-tighten (annoying, visible), but structurally cannot leak downward.
   The doorman decides who gets in and how urgently — never what anyone inside may do.

## Relationship to screener@

`motivatingExamples.md` lists _screener@_ (HEY-style first-contact gate) and notes the
overlap. Resolution: **same agent.** First-contact screening is the `unknown` sender-class
path of commitment 2 — the human's approve-once verdict is a reclassification into the
known-good book, chained like any other membership event.

## No new primitives

Books for sets (sender classes), chains for history (quarantine log, membership log),
proposals for authority (mid-band actions that touch anything beyond move/hold). bouncer@
is assembled entirely from machinery that already shipped in s10 — which is the argument
that the design has found its bones.

## References

- `../s11-scheduling/jobs-and-facets.md` §6 — facet authorship, the floor rule, the lobby
- `../s10-agents/devPlan.md` T1–T3 (landed) — books, write_policy, chains, decision 5
- `docs/agents/motivatingExamples.md` — the original bouncer@/screener@ candidates
- `../s11-scheduling/devPlan.md` T6 — the facet columns this stamps
