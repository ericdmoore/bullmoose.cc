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
   **The cascade** (Eric's sketch, 2026-08-13, formalized): cost-ordered, each stage
   emitting **ACCEPT** (skip remaining rejection stages, go to stamping), **REJECT**
   (quarantine + chain, naming the firing stage), or **CONTINUE** (next stage). The gray
   zone *is* the escalation channel; each stage sees only the survivors of the last:

   1. **Sender sets first** (commitment 2, made literal): known-good → **ACCEPT**
      fast-path; blocked → **REJECT**. A **bloom filter** (in worker memory, loaded at
      cold start) fronts the union of ALL blocked tiers: `ABS_NO` → CONTINUE for free
      (blooms have no false negatives), `POSSIBLY_YES` → exact check against the owning
      tier. The bloom is a *derived index*, rebuilt when any source changes — each tier
      stays canonical for its entries; no shadow blocklist store may emerge.
      **Stage-1 rejects should exit at the SMTP edge**: ingest already runs inside a CF
      Email Routing handler with `message.setReject()` (`ingest/src/index.ts:62`) — a
      5xx costs us no storage at all and makes retry the sender's problem.
   2. **Envelope auth**: SPF/DKIM/DMARC alignment (cheap; the inbound edge already
      computes most of it) — hard-fail → REJECT; the result feeds the Bayes prior.
   3. **Sieve rules**: PASS → CONTINUE, FAIL → REJECT (rule id recorded as the reason).
   4. **Bayesian filter — two thresholds, not one**: score ≥ `T_reject` → REJECT
      (`reason: bayes@score`); ≤ `T_clean` → CONTINUE-as-clean; **between → the
      mid-band** that escalates. One threshold makes a binary gate; two make a cascade.
      Trained per-account, and the quarantine **rescues are its labeled corrections** —
      the escape hatch feeds the filter.
   5. **Deterministic facet stamping** (the s11 T6 pass: due_at, requires, mechanical
      metadata) — clean mail **enters the lobby** here.
   6. **LLM, mid-band only**: stamps *estimated* facets (`sender_class` for unknowns,
      `effort_prior`) as classification enums — never a free action; the floor rule
      applies.

   Every mid-band or personal-tier REJECT is a quarantine-chain event whose reason names
   the firing stage — "why was this shunted?" is always answerable by stage name, no
   archaeology. The industrial tier gets **counters, not chains** (below).

   ### "Blocked" is three tiers — different owners, different audit, one bloom

   Eric's refinement (2026-08-13): a bad-actor domain list exists to **minimize the
   computation budget spent on the hostile internet** — and that goal is incompatible
   with treating it as a contact book. So the blocked concept splits by what the entry
   *is*, and audit fidelity is proportional to decision value:

   | tier | what | owner | writes | audit |
   |---|---|---|---|---|
   | **industrial denylist** | bad-actor **domains** — spam farms, the background radiation; possibly thousands, feed-sourced | the **operator** (config/feed artifact — *not* a book, nothing social about it, nobody wants 5k junk domains rendered in CardDAV) | feed refresh + the **graduation loop** (below) | **per-domain daily counters**, never per-message chain rows — an attacker must not be able to make us pay D1 writes per spam |
   | **tenant-wide blocked book** | house-level sender blocks ("nobody here deals with X") | **bouncer@'s account** — its working book | human directive or proposal; graduation-policy auto-writes allowed, always chained | membership chain |
   | **personal blocked book** | *this human's* blocks ("never that recruiter again") | **the account it protects** — Dad's blocks do not touch Mom's mail | owner writes directly; agents **propose** (`write_policy: propose`); bouncer holds a collection-scoped **read grant** (the `allowedBookIds` machinery) | membership chain |

   Why bouncer may hold more autonomy here than `photos@` ever gets over
   `allowedRecipients`: block lists are **deny-only**, so the worst failure is
   over-blocking — visible in quarantine, rescuable, chained. An availability bruise,
   never a security breach. The failure direction is what earns the autonomy.

   **The graduation loop — the cascade optimizes its own cost.** A domain repeatedly
   rejected by the *expensive* stages (N Bayes/sieve rejects, no rescues) graduates
   **downward** into the industrial denylist, so its future mail costs nanoseconds
   instead of Bayes compute. Repetition→policy, applied to spam: repeat offenders pay
   less and less of our attention. Graduations are policy-authorized automatic writes,
   recorded with their evidence (`graduated: 20×bayes@0.99, 0 rescues`); a quarantine
   rescue of a graduated domain demotes it back out and resets the counter — the human
   correction always wins.

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
