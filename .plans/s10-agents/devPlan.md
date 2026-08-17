# s10 — the Agents area: dev plan

> **Status: T1+T2+T3 LANDED** (PRs #88, #89 — 2026-08-12). Deltas from the build, folded in:
> - **Agent identity is a sticky `"agent"` marker scope**, not `allowedBookIds` grants: the
>   governing book usually lives on the agent's *own* account where it is the owner, so
>   grant-scoping cannot express "not writable by its owner-agent". The marker grants nothing
>   (`hasScope` fail-closed), survives self-service re-mints, and is the chokepoint's writer
>   signal. Cross-language contract change; conformance regenerated (additive).
> - **Typed-core promotion deferred**: only `recipients_book_id` is a typed column;
>   `allowedSenders`/`replyMode` stay in `config_json` for now.
> - The MCP **self-write rule is broader than "its own book"**: a bearer cannot be mapped to
>   one binding over MCP, so writes touching ANY binding's governing book are refused pre-store
>   (also closes the unflipped-write_policy misconfiguration).
> - `AddressBook/set` cannot set or see `write_policy` — governing books are marked via
>   provisioning (`setAddressBookWritePolicy` / seed). Wire exposure is T5's console work.
> - T3's amendments live in a dedicated append-only `amendments_json` (same discipline as
>   editedPayload, separate field); the expiry pause banks the remainder in
>   `expires_remaining_ms` so the sweep can never lapse a waiting proposal.
> - The CJ gate landed as beneficiary-binding inequality; the finer "which books CJ may
>   widen is itself a narrow grant" remains future work (T5 console should render it).
> - **Known hardening gap**: the jmap actionProposal reply-draft egress executor does not
>   re-check the governing book (mitigated: the agent worker refuses to *propose* to
>   out-of-book recipients, so the pipeline cannot mint an approvable out-of-bound proposal).
>   Gate the executor too — small task, belongs with T5.
> - **Follow-up named**: Go CLI `approvals` needs the `needs-info <id> --question` verb +
>   `info-requested` vocabulary (additive to the contract suite).
> - **Deploy**: 3 new deploy-blocker migrations; every send-capable binding needs its
>   governing book seeded (analyst@ stops sending until seeded — fail-closed by design);
>   agent tokens need a marker re-mint (unmarked legacy agent tokens are the one fail-open
>   edge until re-minted).

> Ordered build for [`readme.md`](./readme.md): the agent **configuration** surface (CLI +
> WebUI) and the two controls it depends on. Activity (queue/dossier/score) is linked, not
> rebuilt — it lives in `/approvals` (s07 T4) and the `s03.E` console.
>
> **Guiding constraint:** the config surface must never offer a control that does not enforce.
> The reason T1 comes before any CRUD is that a "who it responds to" field with no backing
> store is a lie the moment it renders — and for a *social* agent that lie is a
> confused-deputy hole, not a cosmetic one.

---

## Tasks (in dependency order)

### T1 — `allowedRecipients` as a **governed contact book** · *the bound, and the one chokepoint*

**Files:** `packages/mailstore/sql/data-plane.sql` + `infra/migrations.mjs` (the flag), the
contacts store layer (the chokepoint), `services/agent/src/index.ts` (send enforcement),
`services/agent/src/models.ts` (config type), `webmail/src/lib/console/perAgent.ts`.

`allowedRecipients` is **an address book**, not a config array — it inherits CRUD across JMAP,
CardDAV, CLI, MCP and WebUI, and stays inspectable in any CardDAV client. Groups give it
expressiveness a flat list cannot ("the family group"). Three things, none of them UI:

- **The governing book is not writable by the agent it governs.** Otherwise the agent
  self-issues send authority: `photos@` legitimately holds `contacts` scope, calls
  `contacts_create_card` (`mcpNouns.ts:459`), and has widened its own reach. Control and
  controlled must not be the same writable object. Cleanest form: the agent gets **no** access
  to its governing book — the send path resolves it server-side, so a compromised agent cannot
  even enumerate its own reach. Expressible today via collection-scoped grants —
  `allowedBookIds` (`packages/auth-core/src/principal.ts:345`) already narrows contacts access
  to specific `collectionId`s. **No new grant machinery.**
- **One chokepoint, in the store — not per-protocol.** A book governed by approval but writable
  over CardDAV is not governed. Today's write paths are JMAP `ContactCard/set`, CardDAV
  `PUT`/`DELETE`, the CLI, and MCP `contacts_create_card`; four checks means the *fifth*
  protocol added later silently bypasses the bound. Mark the book and enforce **once**, at the
  store layer every path funnels through. A test must assert each known path is refused.
- **The mark is a per-book `writePolicy`, not a boolean** — three levels, one chokepoint:
  - `open` — direct writes under ordinary grants (an agent's own working books; today's
    behavior).
  - `propose` — *agent* writes flow through the queue as `create-contact` proposals (the kind
    already in the arch enum); humans write directly. Default for **human-owned** books: CJ or
    `crm@` may curate Eric's contacts, but as reviewable proposals, with approve-after-edit
    giving the labeled correction s03.D already banks.
  - `governed` — the full bound: the governed agent cannot write it at all, widening is a
    `grant-request` (T3), every change chains (T2). Forced for allowlist books.
  - **Governed is viral through reference.** If a governing book (or its allowlist) references
    a group in a human book — "photos@ may email the *family* group" — that group is now part
    of the control surface: adding a member widens an agent. Reference by a governing book
    escalates the referenced book/group's effective policy to `governed`, automatically. The
    alternative is the silent-widening hole T1 already forbids for nesting.
- **Fail-closed, exact-match.** Unbound ⇒ **cannot send**, matching the Bureau's invariant 5
  (`services/bureau/src/binding.ts` — refuse when no allowlist, never default-allow); no book
  ⇒ cannot send, *never* "unrestricted". `allowedSenders` (inbound) is enforced at
  `index.ts:209`; this is its outbound twin. The lookup is **normalized exact equality, never
  `LIKE`** — contact search is a full-scan `LIKE` today, which is fine for search and
  catastrophic for an allowlist (`bob@evil.com` matching a sloppy pattern for `bob@good.com`).
  Plus-tags do **not** auto-match (`bob+x@` ≠ `bob@`). Group nesting is forbidden in a
  governing book, or the expansion is computed and displayed — otherwise adding one member to
  a nested group silently widens an agent without touching its allowlist.

Also here: **the typed config core.** Promote `allowedSenders`, `replyMode`, `enabled` out of
the untyped `config_json` blob into typed columns the console reads and the runtime enforces
uniformly (`allowedRecipients` is now a book reference, not a column); leave the
agent-specific remainder (`persona`, `modelAliases`, `digestTargets`, `pipeline`) in the blob,
shown read-only. `s07` decision 7, resolved. Migration with an executable check.

**Done when:** an agent with no governing book is refused on send (mirroring the Bureau's
fail-closed tests); the agent cannot write its own governing book **over any of the four
paths**; an exact-match test rejects a near-miss address; the console renders the outbound
bound beside the inbound one; the typed core round-trips through the migration test.

### T2 — The provenance chain · *append-only, and the why comes from the proposal*

**Files:** `packages/mailstore/sql/control-plane.sql` + `infra/migrations.mjs`, the T1
chokepoint (emit the event).

`contact_cards` already carries `last_writer_{principal,binding,invocation}` — but that is the
**most recent** write, not a chain, and it answers the wrong question. The attack shape is
widen → send → narrow; `last_writer_*` shows only the narrowing. Audit here must be
append-only, on the `grant_lifecycle` model (`control-plane.sql:197` — `(grant_id, event, at,
actor)`, no FK, history outlives the row).

- An **append-only lifecycle log for governing-book membership**: one row per add/remove, with
  `actor`. **Deletion is an event** — an unlogged remove puts a hole in the chain exactly where
  someone would want one.
- **`via_proposal_id` carries the why.** Do *not* add a free-text `reason` column — it fills
  with "updating contacts" and is worthless. If widening must flow through a proposal (T3),
  the proposal **is** the why: rationale, evidence, approver, timestamp, and the edit-diff if
  it was corrected on the way through. One link field inherits all of it, and cannot be faked
  because it is the actual authorization record.
- **Backfill the same gap in `grant_lifecycle`.** It records `actor` but never *why* — the
  identical hole, one realm over. Same column, general win, do both.
- **Actor is attributed, not collapsed.** A human approval and CJ's automated one must be
  distinguishable in the chain (see T3), or the audit cannot tell judgment from automation.
- **The book folds from the log — assert it.** For a *governing* book, membership is fully
  determined by the chain: added→removed→added-back is three events, and the current book is
  the fold. We do not flip to literal event sourcing (the book stays the store; the chokepoint
  writes card + chain row in **one atomic batch**, which is what kills the dual-write desync),
  but the fold is the **reconciliation invariant**: replaying the chain must reproduce the
  book's membership exactly. Divergence = a bug or a bypassed write path — either way an
  alarm, not a log line. Cheap enough to run in CI and on a schedule.
- **No compaction — the cancelled pairs are the crown jewels.** The tempting compaction is
  exactly wrong: an add+remove that "cancels out" contributes nothing to current state, but it
  is the *record of a window in which the agent could send* — the widen→send→narrow attack's
  entire footprint. Compacting by does-it-affect-current-state is the attacker's deletion
  policy. The only legitimate axis is **time**: a retention horizon with a signed membership
  snapshot at the boundary, and none of that until scale demands it — allowlist churn is
  human-scale (events/week), so the log stays trivially small for years.

**Done when:** every add *and* remove on a governing book appends a row; the row links the
authorizing proposal; a test proves a widen-then-narrow sequence is fully reconstructable after
the fact; the fold-reconciliation invariant runs and a deliberately-bypassed write trips it;
`grant_lifecycle` gained the same link.

### T3 — Widening is a `grant-request` proposal · *the agent asks; it does not take*

**Files:** `services/jmap/src/methods/actionProposal.ts` (the existing `grant-request` branch),
the T1 chokepoint (accept an approved proposal as authorization).

T1 says the agent cannot write its governing book. T3 is how it **asks** — and the queue
already accepts the shape. `grant-request` is a live proposal kind (`actionProposal.ts:481`),
whose comment already describes this pattern: *"the decision is recorded here; no local write"*
— provision watches approved grant-requests and mints. An allowlist widening is a
grant-request; the "minting" is a contact write through the T1 chokepoint.

- The agent proposes *"let me email X, because Y"*; a human approves in `/approvals`. Rationale
  and evidence are already required fields — which is precisely what makes T2's `why` free.
- **`needsInfo` is the third option, and grant-request is where it earns its keep**
  (`decline-taxonomy.md`): a widening met with *"why do you need X?"* instead of a fatigued
  approve or an obstructive decline. The answer appends to the rationale; a
  challenged-then-approved grant carries the strongest why the T2 chain can hold. Least
  privilege survives contact with a busy queue *because* this verb exists.
- **CJ may hold bounded approval authority** (the orchestration idea: granting a privilege =
  adding a contact). Two rules make that safe rather than a hole moved one hop: CJ's approvals
  are recorded **as CJ**, never indistinguishable from a human's; and **CJ may not approve a
  widening for itself.** Which books CJ may widen is itself a narrow, audited grant, and the
  console must render it as *"CJ can widen photos@'s reach"* — not as "CJ has contacts write."
- **Row 1 has an actor too.** `agents create --kind photos` (T4) seeds a governing book; the
  human running `create` is the actor on that first row. No `system` actor, no implicit trust
  at the bootstrap.

**Done when:** an agent denied a direct write can obtain the same change via an approved
proposal; the resulting contact carries `via_proposal_id`; CJ cannot approve its own widening;
a seeded book's first row names the human who ran `create`.

### T4 — `bullmoose agents` · *the CLI config surface* — Go-native

**Files:** `cli-go/internal/cmd/agents.go` (+ tests), reusing the JMAP client from the
`approvals` command.

- `list` — bindings, human table + `--json`, showing enabled/replyMode/the two allowlists at a
  glance.
- `show <name>` — the config core + the read-only remainder, clearly separated. **Activity is
  a pointer, not a panel:** print "for activity: `bullmoose approvals --agent <name>`". Do not
  reimplement the dossier in the CLI.
- `edit <name>` — set the typed core only (`--reply-mode`, `--allow-sender`, `--allow-recipient`,
  `--enabled`). Refuse to blind-edit the blob; if a caller wants to change `persona`, that is a
  named flag or it is out of scope. Never write an `allowedRecipients` that is empty-but-present
  in a way that reads as "send anywhere" — empty means fail-closed.
- `create --kind <analyst|photos|newsletters|custom>` — provisioning-from-a-kind. The kind
  seeds the config core and the blob; `custom` is the blank case and must still set a
  fail-closed outbound bound. If create must mint an identity/scopes, that is a provision-worker
  call — surface it, do not fake it.
- `remove <name>` — `disable` by default (sets `enabled=0`, reversible); `--destroy` tombstones
  the binding and says what happens to its outstanding proposals.

Go-native, no Node counterpart (like `approvals`) — the contract suite stays 61/0 (additive),
and `agents` gets its own Go tests against a fake JMAP server.

**Done when:** the five verbs drive a fake server; `edit` cannot set an unbounded recipient
list; `create --kind photos` produces a fail-closed binding; `remove` defaults to reversible.

### T5 — `/agents/<id>` config panel · *the WebUI config surface*

**Files:** `webmail/src/pages/agents.astro` / the existing console island,
`webmail/src/lib/agents/` (new, config logic), `webmail/src/lib/console/` (compose, don't fork).

- The per-agent page gains a **config panel** beside the existing activity/permissions view
  (`perAgent.ts`). Two panels, labelled *what it is* vs *what it's doing* — not two pages.
- Edit the typed core with the same fail-closed discipline as T4; the remainder read-only.
- **The "who it responds to" row now has a backing field** (T1), so it can finally be an
  editable control rather than a warning about its absence.
- ListView / Create(from kind) / Disable-Remove, mirroring T4's semantics so the two surfaces
  agree.
- **The governing book is a link, not an embedded editor.** "Who it may email" opens the book
  in `/contacts` — that is the point of making it a book. Widening from here files a T3
  proposal; it does not write directly, even for a human operator, so the chain (T2) stays
  complete no matter which surface initiated it.

⚠️ **`/agents` live mode is separately blocked**, and this task does not unblock it: the
console reads `/console/*`, four routes that are *requested, not served* (s03.E rough edge).
Until they are served the config panel is drivable via `?demo=1` only. Serving those four
routes is a small server task worth doing first or alongside — it lights up the whole existing
console, not just this panel.

**Done when:** the config panel edits the typed core in `?demo=1`; the outbound-bound control
writes a real field; the plain-client floor (no agent capability) hides it without a dead
region.

### T6 — The agent score · *depends on s07 T5, flagged not owned*

The dossier's score (acceptance rate, **cost-of-declined**, cost-per-approved, `provider` not
`modelName`) is designed in `s07` §"Edit is the load-bearing verb" and T5. It needs the
`agent_invocations` cost columns (`tokenCount`/`costAmt`/`provider`) that **s07 T5 owns** —
they do not exist yet, so the dossier shows no score today. s10 does not build the score; it
is named here so the agent area's completeness is not overstated. When s07 T5 lands, the score
renders in the activity panel this section built the frame for.

### T7 — Proposals must reach the human they wait on · *found live, 2026-08-13*

**The bug**, observed on the first real end-to-end run: EditorEmily produced a `reply-draft`
proposal, it was real and `pending` — and `/approvals` told Eric **"Nothing is waiting on
you."** Every layer was individually correct. The invocation ran on Emily's binding, the
proposal was written to the account owning that binding, and the UI refused to show another
principal's data. The *composition* is what fails.

```
eric@bullmoose.cc   → account …850b74f3 → principal p_03f2bbe3
editor@bullmoose.cc → account …ca58ac53 → principal p_9e016b64   ← the proposal lives here
grants between them → none
```

Agents are separate principals **by design** (agent mailboxes, pattern B). So a
single-account approvals queue can *never* show a human their agents' work: the queue is
human-scoped by intent and account-scoped by implementation, and those do not match.

Two halves, and they are not alternatives:

- **Provisioning must mint a supervisory grant.** Creating an agent should, by default, let
  its owner see what it proposes. `POST /agent-bindings` and `POST /bouncer` currently mint
  an agent account with **no grant back to the operator** — so every new agent is born
  invisible. The grant is the right model (not a special case): supervising an agent is a
  capability, visible and revocable like any other.
- **`/approvals` must query every reachable account**, not just the logged-in one — owned
  *and* granted. The Go CLI's `approvals` has the same defect.

**Done when:** a freshly provisioned agent's first proposal appears in its owner's
`/approvals` and `bullmoose approvals` without a manual grant; revoking the supervisory
grant removes it; another tenant's proposals never appear.

---

## Sequencing

```
T1 governed book + chokepoint ──→ T2 provenance chain ──→ T3 widening-by-proposal
   (the bound, enforced once)      (append-only + why)      (how the agent asks)
                    │                                              │
                    └──────────────┬───────────────────────────────┘
                                   ├─→ T4 CLI agents
                                   └─→ T5 WebUI config panel
                                          (also wants /console/* served — separate)
s07 T5 invocation cost ───────────────→ T6 score renders (not owned here)
```

**T1 is non-negotiably first.** Everything after it offers to edit controls; T1 is what makes
those controls real. Building the CRUD first would ship a form with a field that writes
nowhere.

**T1 → T2 → T3 is one arc, not three features.** T1 takes the write away from the agent; T3
gives it a way to ask; T2 is the record that asking produced. Landing T1 without T3 leaves a
bound with no legitimate path to widen — correct but unusable. Landing T3 without T2 approves
changes nobody can later reconstruct. Ship the arc.

## Decisions needed

1. **Does `create` mint an identity, or only a binding?** A real `analyst@` needs an address;
   a lightweight in-account agent may not. *Recommendation: `--kind` decides — `analyst`/`photos`
   provision an identity via the provision worker; `custom` is binding-only until the operator
   adds an address.*
2. **Do governing books hold domains, or only addresses?** `photos@`'s invitees are individual
   addresses; a newsletter agent might want a whole domain — but a contact card is an address,
   and `*.host` is not a contact. *Recommendation: addresses only in the book (it is a real
   address book, and a domain wildcard in a CardDAV client is a lie); if a domain bound is ever
   genuinely needed, it is a separate typed field on the binding parsed like the Bureau's
   allowlist — not a fake contact. Do not build it until an agent needs it.*
3. **Does `remove --destroy` cascade to proposals, or orphan-and-tombstone?** *Recommendation:
   tombstone the binding, keep the proposals (they are audit), and render them under a "removed
   agent" heading rather than deleting history — the same stance grant revocation takes.*
4. **Does a human operator editing the book directly also file a proposal (T3), or write
   through?** Write-through is more convenient and puts a hole in the chain. *Recommendation:
   the human writes directly (they are the authority — requiring self-approval is theater), but
   the T2 row is still appended with the human as `actor` and a null `via_proposal_id`. The
   chain stays complete; the "why" is simply absent for human edits, which is honest. Agents
   never write through — that is the whole bound.*
5. **A human-originated request ("add Bob") — does the agent's resulting write still queue?**
   Eric emails `crm@` asking for a contact; a round-trip back through `/approvals` for a thing
   he just asked for is friction. But "the human asked" arriving *by email* is the classic
   injection vector — a message that merely looks like the owner. *Recommendation: still file
   the proposal (one write path, the chokepoint stays single), but **auto-approve** when the
   directive came from the book's owner over an authenticated channel (DKIM-aligned +
   `allowedSenders`), recording `via_proposal_id` as usual with the request's message-id as
   evidence. Unauthenticated or third-party requests queue normally. On a `governed` book,
   auto-approve is off, full stop.*

## Out of scope

- **The activity dossier itself** — `/approvals` and the `s03.E` console own it; s10 links.
- **The score** — s07 T5 (T4 above names the dependency).
- **Serving `/console/*`** — a server task that unblocks the *existing* console; flagged in T3,
  not owned here.
