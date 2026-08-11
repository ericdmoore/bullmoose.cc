# s07 — `app.bullmoose.cc`: dev plan

> Ordered build for [`readme.md`](./readme.md): eight sections on one origin, over realms
> that mostly already work. Most of this is **surfacing**, not building — 41 of the
> server's 48 JMAP methods are currently unreachable from a browser.
>
> **Guiding constraint:** never ship a section that renders convincingly against data it
> cannot actually reach. `s03.E` is the cautionary case — two complete screens, 128 tests,
> and four of five endpoints unserved, so it only fully renders under `?demo=1`. Every task
> here states which server routes must be live *before* the screen counts as done.

---

## ⚠️ What this is NOT — read before designing any screen

**This is a collaboration space for people and agents.** It is not "Google Drive with
agents," and the Drive analogy is load-bearing in the wrong direction.

Drive is **storage-centric and passive**: here are your things, go browse them. You arrive to
*find* something. This product is **decision-centric and temporal**: here is what is about to
happen and what needs you. You arrive to *decide* something.

Reaching for the familiar shape imports Drive's home page, its nav ordering, and its
assumption that the user is a librarian. Drive has no notion of an actor that proposes work
you approve — which is the entire novel thing here.

**The test, applied to any proposed feature:** does this make sense on its own, or only
because Drive has it? The second answer is the signal to stop.

**The concrete consequences, all of which fall out of this and none of which are cosmetic:**

- **Home is a view, not a section.** `/` is *Looking Ahead* + *Waiting Approvals* — see T0.
  The eight nouns are where you drill down, never where you land.
- **Nav order is a claim about what this is.** Put `/mail` first and you have built a mail
  client with extras.
- **The queue is co-authoring, not a gate.** *Approve / Edit / Decline*, and **Edit is the
  one that matters** — see T4.
- **Sharing is a first-class verb**, not a per-object menu item. It is currently unbuilt
  (T7) and it is the largest unclaimed piece of the premise.

---

## Three refinements to the proposal

### 1. The token must never enter a URL

The sketch was: a front page where you paste a token, which form-redirects to
`/mail?token=…`. **Don't do the redirect.** A credential in a query string lands in browser
history, in the `Referer` header of every outbound link, in any access log along the path,
and in whatever the user copies out of the address bar. OAuth 2.1 discourages it explicitly,
and it would be a *new* leak — today you only get a token in a URL if you deliberately put
it there.

The fix costs nothing and keeps the UX identical. The login page is client-side already:
take the pasted token, write `localStorage`, then `location.assign("/mail")`. The token
never appears in a URL at any point.

Keep `?token=` as a dev affordance, but on read, `history.replaceState` it away immediately
so it does not survive into history. `webmail/src/lib/app/client.ts:46-63` reads it today
and does not strip it.

This is explicitly an **interim** front door. It is honest for a single operator and it is
not a login system — see T7.

### 2. Astro multi-page, not a client-routed SPA

"Mount the SPA" is the one structural thing I would change. Eight Astro pages, one
`client:only` island each, beats one client-routed bundle:

- **Deep links work with no router.** `/calendar` is a real URL that returns a real
  document. No history shimming, no scroll restoration, no 404-on-refresh.
- **You do not ship calendar code to someone reading mail.** Eight islands means eight
  bundles; a single SPA means everyone downloads everything.
- **The CSP story already works this way.** `astro.config.mjs` emits per-build sha256
  hashes (7 script, 2 style, identical across both current pages). Hand-writing that policy
  once already broke hydration so the page rendered empty *while `astro build` and the whole
  suite reported success* — see `s03.C/devPlan.md:69-74`. Do not re-open that.

The "app" feel comes from the islands being interactive and the chrome being shared, not
from client-side routing. Shared nav is an Astro layout.

### 3. The agent score needs a decomposition — and a column that does not exist

The proposal was a single score, roughly `approved / total tokens`. Two problems.

**It has no denominator today.** `agent_invocations` (`data-plane.sql:202-216`) records
`status`, `context_json`, `result_json`, `note` and three timestamps — and **no tokens, no
cost, no model**. Nothing anywhere records what an invocation cost.
`spend_facts` is unrelated: that is Allen the Analyst extracting spend from *receipt emails*
(`services/agent/src/ledger.ts:5-14`), not agent token spend. So the score requires schema
work that appears in no plan. T5 adds it.

**One number answers two questions badly.** `approved / tokens` conflates *did the human
want this* with *how expensive was it*, and it degenerates: an agent that proposes nothing
scores perfectly, and one that proposes 100 trivial things at 99% approval beats one that
proposes 3 hard things at 67%. Three numbers, shown together:

| number | question it answers |
|---|---|
| **acceptance rate** = approved ÷ proposed | is its judgment aligned with mine? |
| **cost of declined work** = spend on rejected proposals | *the waste number* — the one to make prominent, since it is the money already gone |
| **cost per approved action** = total spend ÷ approved | is it efficient at the things I do want? |

**On "$ generated or saved":** the system cannot compute this, and it should not pretend
to. The honest version is an **optional value estimate the human attaches at approval
time**, aggregated and always labelled as human-supplied. A number the machine guessed and a
number you asserted must never render the same way — that is the same discipline
`s03.E`'s caveats already apply to the access log.

### 4. Search everything — but the index tiers, not the API

Searching attachment bodies is the right ambition and it is also the first feature that
genuinely cannot be free. Message-body FTS5 costs ~0.6 KB/message and moved the single-shard
ceiling from ~300K to ~200K. Attachment text is a different order: one 20-page PDF carries
more text than a hundred emails, and extracting it means PDF/DOCX/XLSX parsing — and for
scans, OCR — which is CPU-bound work that a request-scoped Worker is the wrong shape for.

So the tiering is real, and it lands exactly where the `$0/mo` line already is:

| tier | index | infra |
|---|---|---|
| **free** | subject, sender, recipients, message body | D1 + FTS5, serverless, already built |
| **premium, opt-in** | + attachment text, OCR, possibly embeddings | always-on: extraction queue + durable worker or Containers |

**The constraint that makes this work: the premium tier is an INDEX, not a different API.**
`/search` and the MCP `search` tool must have one shape whether or not the extra index
exists — the same query, the same result envelope, with coverage *declared* in the response
rather than implied by which endpoint you called. If upgrading changes the API, every
consumer has to learn about tiers, and the MCP tool would need two versions.

That means the scope note from T6 is not cosmetic — it is the tier boundary made visible:

```
searched: mail bodies (indexed) · contacts, calendar (scanned)
not searched: attachment contents — requires the extraction index
```

- **Opt-in and budgetary, never automatic.** Turning it on provisions billable always-on
  infra, so it belongs to the same consent-and-ledger machinery as agent spend, not to a
  settings checkbox that silently starts a meter.
- **This is where sharding by year earns its keep.** Extraction is a per-object one-time
  cost; storage is forever. Recent years in the rich index, cold years body-only, is a much
  better default than all-or-nothing.
- The free tier must never *degrade* when the premium one is off. Today's mail search stays
  exactly as it is.

---

## Tasks (in dependency order)

### T0 — The home view · *the thing that makes this not a file manager*

**Files:** `webmail/src/pages/index.astro`, `webmail/src/lib/home/`.

`/` is **not** a section and **not** a dashboard of counts. Two stacks:

- **Waiting Approvals** — the queue, newest-urgent first, each row acting inline:
  **Approve · Edit · Decline**. Two subtle marks per row, and they are opposites:
  - **waited for** — how long this has sat on *you*. Grows. Shames the human.
  - **expires in** — how long it has left. Shrinks. Shames the clock.
- **Looking Ahead** — the next horizon across realms: today's events, things due, holds
  about to commit, proposals about to expire.

⚠️ **`expires in` has nothing to compute from today.** `ActionProposal` carries
`status: expired` but no `expiresAt` (`s03.D/arch.md:29-30`). And do **not** reach for
`holdUntil` — that is a different clock entirely: the tier-2 *post-approval* retraction
window (`arch.md:47`), a window in which an approved action can still be pulled back.
Conflating "how long until I lose the chance to decide" with "how long until my decision
becomes irreversible" would be a genuine bug. T4 adds `expiresAt`.

**Done when:** a first-time visitor with mail, a calendar and one agent sees what needs them
today without clicking anything, and nothing on this page is a file browser.

### T1 — The origin, the layout, and the interim door · ✅ **DONE**, except the hostname (moved to T7)

**Files:** `webmail/wrangler.jsonc` (new), `webmail/astro.config.mjs`,
`webmail/src/layouts/App.astro` (new), `webmail/src/pages/index.astro`,
`webmail/src/lib/app/client.ts`, `.github/workflows/deploy-app.yml` (new), `docs/DEPLOY.md`.

- **`app.bullmoose.cc`.** The webmail is deployed by **nothing** — `deploy.yml` ships `src/`
  (the marketing site) to Pages project `bullmoose`, and `webmail/` has no deploy config and
  no `DEPLOY.md` entry.
  ⚠️ **This bullet used to say "add a Pages project and a workflow", which contradicts
  Decision 1** ("public, but only after T7 — the interim door should not face the internet").
  Decision 1 wins: **T1 builds no deploy config.** The Pages project lands with T7, when
  there is a real login to put behind it.
- **Write the domain map down before it collides.** Five hostnames are now in play across
  three plans:

  | host | serves | status |
  |---|---|---|
  | `bullmoose.cc` | marketing site (`src/`) | live |
  | `dav.bullmoose.cc` | `anglebrackets` (CalDAV/CardDAV) | live |
  | `app.bullmoose.cc` | this section | **new** |
  | `mcp.bullmoose.cc` | MCP façade | `s02` T1 |
  | `auth.bullmoose.cc` | OAuth AS | `s02` T3 |

- **A shared layout** with the eight-section nav, one island per page.
- ~~**Tighten `connect-src`.**~~ ⚠️ **NOT DONE, and cannot be done as written.** The
  instruction assumed a fixed API origin. It is runtime-configurable — `?api=`, the door's
  advanced field, and a stored `bullmoose.apiBase`, with `defaultBase()` falling back to the
  page origin — so a build-time literal breaks every non-default deployment. This needs a
  decision (drop the affordance, or accept the broad policy), not an edit.
- **The interim door** per refinement 1: paste-a-token, `localStorage`, `location.assign`.
  No token in any URL, ever. Strip `?token=` via `replaceState` on read.
- ⚠️ **Decide the no-token behaviour deliberately.** Today `client.ts:49-57` silently falls
  back to **demo data** when no token is present. On a public origin that means a stranger
  at `app.bullmoose.cc` sees a convincing mailbox full of fake mail. Demo mode must become
  opt-in (`?demo=1` only) and the bare no-token case must render the door.

**Done when:** ~~`app.bullmoose.cc/mail` serves~~ the client is reachable at `/mail` against a
real token; a first-time visitor gets the token form and not demo data; the token appears in
no URL, no history entry, and no log. (The hostname moves to T7 per the correction above.)

⚠️ **A static nav cannot honour the agent-capability gate** (`arch.md` §8.6). `/agents` shows
for a session lacking `urn:bullmoose:params:jmap:agent`, because only the browser knows after
`session()`. `AppShell`'s gated seam — repointed to `/agents` — remains the surface that
tells the truth. T4 needs to decide: hydrate the nav, or accept the gate only inside the page.

### T2 — `/settings` · ✅ **DONE** (was: cheapest real section, and unblocked)

**Files:** `webmail/src/pages/settings.astro`, `webmail/src/lib/settings/`.

sVOL **`024`**, graded **E1**. Its stated blocker was `006 Identity/set`, which shipped —
the unit file's claim that `grep -r "Identity/set"` returns zero hits is stale
(`services/jmap/src/methods/identity.ts:167` registers it).

- `Identity/get` + `Identity/set` — display name, reply-to, bcc, signatures.
- `VacationResponse/get` + `/set`.
- ⚠️ `VacationResponse.htmlBody` is permanently `null` server-side — keep the editor
  plain-text rather than building a rich one that silently discards its output.
- ~~Sign-out~~ — **done in T1**: `SessionBar.tsx` calls `signOut()`, wiring it for the first
  time since it was written. `/settings` deliberately does not duplicate the control.

**Server routes needed:** none. All four methods are live.

> **Where `/settings` goes next: the vacation responder is the send invariant's one existing
> exception, and that is the whole design problem.**
>
> Agents have no send tool, and that is an invariant rather than an omission
> (`emailTools.ts:68-90`). But a vacation responder **already sends without a human click** —
> it is automated outbound mail by definition. It is safe today for exactly one reason: the
> content is a fixed string the human wrote in advance. **The human pre-approved a *string*.**
> Model-generated content means pre-approving a ***policy***, which is a categorically
> different act, and the human is by definition unavailable to supervise it.
>
> The three risks are not equally hard, and two of them should not be the model's job at all:
>
> | risk | difficulty | control |
> |---|---|---|
> | perfunctory vs substantive | **cheap to get wrong** — failure is a missing or needless reply | this is the part that actually wants a model |
> | leaking private info | expensive | **structural, and mechanically checkable** |
> | committing on the human's behalf | expensive | **structural — remove the slot** |
>
> - **Leaking:** constrain the reply so its factual content is a **subset of the incoming
>   message**. The model may quote back what the sender said and nothing from the mailbox.
>   That is checkable rather than judged — verify no substantive token appears outside
>   *(incoming message ∪ fixed template)*. Same shape as the Bureau's egress filter, one realm
>   over.
> - **Committing:** the model fills exactly **one** slot — *the questions I understand you to
>   be asking*. The expectation sentence ("she will get to it, slower than usual") stays
>   human-written and fixed. Never give the model a slot a commitment could fit in.
> - **Prefer quotation to paraphrase.** *"You asked: ‹quote›"* delivers most of the value of
>   *"I understand you to be asking ‹paraphrase›"* at a fraction of the risk. A confidently
>   wrong summary of someone's question is worse than saying nothing at all.
>
> **The mechanism is already built, and it is better than a naive auto-reply.** `responders`
> (`data-plane.sql:157-173`) is `respond(template, wait, cancelIf, suppression)` — armed at
> delivery, fired by the AccountDO alarm, with `wait_seconds`, `cancel_if`
> (`'never' | 'invocation-active'`) and `suppress_seconds` (once per sender per window).
> Ingest already gates on `autoResponseEligible` for RFC 3834 — never auto-respond to
> auto-submitted mail, bounces or list traffic (`services/ingest/src/index.ts:300-311`).
>
> **The delay is a safety feature, not politeness.** Arm, wait, cancel if the human answers
> first from their phone. `cancel_if` wants a `'human-replied'` value; today it only knows
> `'invocation-active'`.
>
> And this is the concrete case that makes the missing outbound bound real: a responder that
> generates its own content and replies to arbitrary senders is precisely why an agent needs
> `allowedRecipients` (T4, decision 5).

### T3 — `/contacts` and `/calendar` · ✅ **DONE** (was: the biggest gap on the grid)

**Files:** `webmail/src/pages/contacts.astro`, `calendar.astro`, `webmail/src/lib/contacts/`,
`webmail/src/lib/calendar/`.

sVOL **`022`**. Seventeen live server methods with no browser path: `AddressBook/*` (3),
`ContactCard/*` (5), `Calendar/*` (3), `CalendarEvent/*` (6, including `getOccurrences`).
Both realms have full CRUD on **JMAP and DAV** already.

- Contacts: book list, card list, search, create/edit/delete, group membership.
- Calendar: month/week/day, event CRUD, recurrence via `getOccurrences` — do **not**
  re-expand RRULEs client-side; `calendar-core` has 100 tests against python-dateutil as
  the oracle and the browser must not become a second implementation.
- **Regrade.** `022` is marked E4, justified by "`ls webmail` fails; `tsconfig.json:33`
  excludes a path that has never existed." That is obsolete — the shell exists. The unit
  itself concedes it would be **E2** now. Fold that.

**Server routes needed:** none.

### T4 — `/approvals` and `/agents` · *the part with no prior art*

**Files:** `webmail/src/pages/approvals.astro`, `agents.astro`, plus `s03.D` T1 server work.

**Same data, two ontologies** — which is the proposal's own "collection view" idea applied
honestly:

- **`/approvals`** — the cross-agent queue, ordered by urgency. The daily driver.
- **`/agents/<id>`** — the per-agent dossier: pending, upcoming queue, historical
  approved/declined, and the three numbers from refinement 3.

**The `reply-draft` kind already half-exists, and drafts are its legacy transport.**

The motivating case — *an agent drafts replies to things I should respond to* — is already
the shipped architecture at the MCP layer: `email_create_draft` exists with scope `draft`
(`services/agent/src/emailTools.ts:577-579`), and there is deliberately **no send tool**,
asserted over the whole `TOOLS` table (`mcpTools.test.ts:124-128`). *Agent drafts, human
sends* is an invariant, not a gap. What is missing is the review surface and the signal.

And the verbs are isomorphic — which is why a draft is the cleanest thing to shim into an
old-world client:

| draft | proposal |
|---|---|
| edit before sending | amend |
| send | approve |
| delete | decline |

**But the mapping leaks in two places, and both lose exactly the signal worth having:**

1. **A deleted draft leaves no trace.** "I deleted it" and "I never saw it" are
   indistinguishable — so *decline*, the outcome that most tells you the agent misread the
   job, evaporates silently.
2. **A draft edited in place overwrites itself.** The diff is gone unless the agent's
   original was kept somewhere else.

**So the proposal is the source of truth and the draft is a projection**, never the reverse.
`ActionProposal.payload` holds the agent's version; the draft in the mailbox is a copy;
the diff is computed at send time against the retained original. That is what lets someone
edit in Apple Mail on a phone and still have the system learn from it — the client does not
have to know anything.

**Keep them out of the human's Drafts.** A folder that mixes half-finished human thoughts
with agent output serves neither. A child mailbox under Drafts plus a keyword degrades
gracefully in both directions: old clients see an ordinary subfolder (universally supported),
new clients filter on the keyword, and nobody's abandoned thoughts get lost among proposals.

**Backwards compatibility is a digest, and the pattern already exists.** A periodic summary —
*N threads drafted*, then per thread: datetime, subject, to, first ~100 characters — is
exactly the shape `analyst@` already ships (`services/agent/src/ledger.ts`: receipts in,
digest out to configured targets). Reuse it. Include **expires in** per row, or the digest
goes stale the moment something ages out.

> On calling this an RL loop: worth being precise, because it changes what to build. Nobody
> is fine-tuning a frontier model from one mailbox. The near-term value is **prompt-time
> context** — *"here are the last N edits this human made to your drafts"* is a strong
> steering signal available immediately, with no training pipeline at all. Retaining the
> diffs is what makes either option possible, so retention is the requirement; training is
> not.

**Edit is the load-bearing verb, and the data model has no room for it.**

Approve/Decline is a gate — the shape you build when the agent is a subordinate. *Edit* is
collaboration: the human amends the proposal and then approves the amended thing. That is the
difference between this and a file manager with a notifications tray, and it is worth the
extra design.

`ActionProposal.status` is `pending | approved | rejected | held | expired`
(`s03.D/arch.md:29`) — there is **no amended state and no record of what changed**. Adding
Edit means:

- the `payload` becomes co-authorable, not just readable;
- the proposal records that a human modified it, and ideally a diff;
- **three outcomes replace two.**

That last one changes the score from refinement 3, and it matters more than it looks:

| outcome | what it says about the agent |
|---|---|
| approved clean | it understood the job |
| **approved after edit** | it was directionally right and mechanically wrong — *the most informative signal in the system* |
| declined | it misread the job |

**Acceptance rate as originally framed hides the middle row entirely** by counting an edited
approval as a win. An agent whose every proposal needs rewriting is not performing like one
whose proposals ship untouched, and the edit diff is the highest-signal feedback the system
will ever collect — it is a human saying *exactly* what "right" looked like. Track it as its
own rate; do not fold it into approvals.

⚠️ **Also add `expiresAt`** (see T0). `status: expired` exists with no field that produces
it, so nothing can currently expire and nothing can show a countdown.

**`/agents/<id>` must also show how the agent is CONFIGURED**, not just what it has done.
Three questions, and they have three different answers today:

| question | state |
|---|---|
| **what can it read / edit / do?** | ✅ modelled and rendered — `s03.E`'s scope expansion through the real `hasScope`, plus grants and credential references |
| **who can talk to it?** | ⚠️ **enforced but invisible.** `config.allowedSenders` gates inbound at `services/agent/src/index.ts:209-211` (`skipped: <sender> not in allowedSenders`) — and the console renders `replyMode` but never `allowedSenders` |
| **who will it respond to?** | ❌ **not bounded at all.** There is no `allowedRecipients`, no outbound address allowlist, nothing anywhere in `services/` or `packages/` |

That third row is the finding. **Inbound has a gate; outbound has none.** For `analyst@` it
does not bite — `digestTargets` is a fixed operator-written map. For a *social* agent it is
the whole problem: `docs/agents/motivatingExamples.md:82-111` describes `photos@` as
CC-invited into event folders, receiving images from arbitrary external senders, joining
*another account's* `photos@`, and syndicating outward to pixelfed/bluesky — with
`Required: []`, i.e. no standing permissions, it just waits for mail.

An agent whose whole job is emailing many people, with no bound on who it may email, is the
confused-deputy shape. **This is the same control the Bureau already built, in a different
realm:** `services/bureau/src/binding.ts` binds a credential to the origins it may reach, and
refuses when unbound (invariant 5, fail closed). An agent that sends mail needs the
equivalent for addresses — and by the same reasoning, unbound should mean *cannot send*,
not *may send anywhere*.

**`config_json` is also the wrong home for this.** It is an untyped blob with no schema and
no validation; `digestTargets` is an `analyst@`-specific key sharing a namespace with every
other agent's settings. `photos@` would add event folders, invited addresses and syndication
targets to the same bag. The per-agent shape genuinely varies — which argues for a small
typed core (`allowedSenders`, `allowedRecipients`, `replyMode`, `enabled`) that the console
renders and enforces uniformly, plus an agent-specific remainder the console shows read-only
rather than pretending to understand.

This is **not new design work.** `ActionProposal` is fully specified in
`.plans/s03.D-coexistence/arch.md:19-36` — `status pending | approved | rejected | held |
expired`, `decision { by, reason, note }`, `rationale` always present, `evidence[]`, and
`tier` for reversibility. `grant-request` deliberately shares the queue, so an agent asking
for permission and an agent proposing a reply are one review surface. It is designed, and its DATA LAYER is now BUILT (s03.D T1): the ActionProposal
collection, expiresAt, and the edit-diff retention all exist. What remains for s07 is the
SURFACE — the queue, the dossier, and the score.

⚠️ **`/agents` cannot ship on the existing console as-is.** `s03.E` needs four routes that
do not exist: `/console/agents`, `/console/agents/{id}`, `/console/accounts/{id}/resources`,
`/console/resources/{c}/{id}`. They are a browser-reachable projection of sVOL `015`'s
introspection queries, which today sit behind `x-internal-token` on the agent worker.

**Server routes needed:** `s03.D` T1 (`ActionProposal` collection + producer) **and** the
four `/console/*` routes. This is the task with the most server work behind it — sequence it
accordingly.

### T5 — Invocation cost, so the score can exist · *schema*

**Files:** `packages/mailstore/sql/data-plane.sql`, `infra/migrations.mjs`,
`services/agent/src/`.

Add to `agent_invocations`: `provider TEXT`, `model TEXT`, `tokens_in INTEGER`,
`tokens_out INTEGER`, `cost_usd REAL`. Nullable — historical rows keep NULL and must render
as *not recorded*, never as zero. A zero would make every past invocation look free.

**What the approval queue shows: `tokenCount`, `costAmt`, `provider`. Deliberately NOT
`modelName`.**

The line is *whose business is it*. **Model choice is the agent's craft; provider is the
operator's procurement.** You are paying, so where compute is bought is legitimately yours;
which model the agent reached for is its own business, and putting it on every row invites
exactly the wrong second-guessing — approving work because it came from a model you like
rather than because the work is right.

`modelName` still gets stored (debugging an agent producing garbage needs it) and still gets
shown — on `/agents/<id>` as *what this agent is configured to use*. That is a property of
the agent, not of the decision in front of you.

Provider is already first-class, so this is surfacing rather than modelling:
`ModelCandidate.provider` (`services/agent/src/models.ts:29`), and the `@<source>/<vendor>/<model>`
alias convention where the source segment *is* "where it runs and who pays" — `@local/`
free, `@cf/`, `@crof/`.

⚠️ **The price-arbitrage machinery exists and is currently inverted.** `rankByPrice` ranks
candidates by blended models.dev pricing, but `.feedback` `018` (**still open**) found that
a `workers-ai` candidate can never be priced — its model id can never equal
`provider/model`, so it resolves to `Infinity` and **sorts last**. In a mixed alias the paid
route is tried first and the free route becomes the fallback, exactly inverted. Surfacing
`provider` in the UI makes that visible; fixing `018` makes it true. Do `018` first, or the
console will faithfully display a broken preference.

- Register in `infra/migrations.mjs` with an executable check, so a database missing the
  columns is caught by `bootstrap migrate` rather than by a dashboard quietly reading NULL.
- **Optional human value estimate** at approval time, stored on the proposal, aggregated and
  always labelled as human-asserted.

**Done when:** the three numbers compute from real rows; an agent with no recorded cost
renders "not recorded" rather than a flattering zero.

### T6 — `/search` · *cross-realm, and honest about what it can reach*

**Files:** `webmail/src/pages/search.astro`, `services/jmap/`, `services/agent/src/mcp.ts`.

Worth building, and worth starting as a **stub that names its own limits** rather than a
fake universal search.

The realms are not equally searchable, and shipping without saying so would repeat the bug
`common/004` just fixed — a search box whose scope note was quietly false:

| realm | today |
|---|---|
| mail | **FTS5**, indexed, ~0.4 ms at 0.1% selectivity |
| contacts | full-scan `LIKE` — `queryContactCards`, the exact pattern just removed from mail |
| calendar | full-scan `LIKE` — `queryCalendarEvents` |
| files | **nothing** — no search path at all |

- Ship `/search` fanning out to `Email/query` + `ContactCard/query` + `CalendarEvent/query`,
  with per-realm results and a visible scope note stating which realms are indexed and which
  are scanned. Reuse the honesty-note pattern already in `AppShell.tsx:577-579`.
- **Then give contacts and calendar the same FTS5 treatment mail got.** A 50K-card account
  is the case that bites, and it was flagged when `common/004` landed.
- **The MCP angle is the strongest argument for this.** The tool surface today has separate
  `email_query`, `contacts_search` and `calendar_query_events`; a model asking "what do I
  know about Dana" must know to call three. One `search` tool spanning realms is a better
  primitive, and it makes `/search` and the MCP tool the same query planner rather than two.

**Done when:** one query returns results from three realms; the scope note names what is
indexed vs scanned **and what is not searched at all**; the MCP `search` tool and the page
share a code path; the response envelope declares its own coverage, so adding the attachment
index later changes the data and not the shape.

### T7 — Real login, folded into `s02` · *retire the interim door*

**Files:** `webmail/src/lib/app/`, `services/oauth/` (from `s02` T3).

The paste-a-token door is interim by design. The real one is the OAuth AS being built in
`s02` T3 so claude.ai can connect — **the same front door**. Building a bespoke webmail
login and an AS for MCP would be building it twice.

- The webmail becomes a public OAuth client (PKCE S256, no secret), redirecting to
  `auth.bullmoose.cc`.
- Short-lived access token in memory + refresh, replacing a permanent `bm_` token in
  `localStorage`. Note that `bm_` tokens today **never expire** — neither self-service mint
  site writes `expires_at`.
- ⚠️ **Sharing has no home yet.** Grants are created by `POST /grants` on provision, behind a
  single deployment-wide `ADMIN_TOKEN`. `s03.E` renders grants **read-only**. For the
  "multi-player" half of the Drive analogy to be true at all, creating and revoking a share
  needs a UI and a non-admin route. Not scoped here — flagged because it is the largest
  unclaimed piece of the premise.

**Done when:** a user logs in without ever seeing a token; the interim door is deleted.

---

## Sequencing

```
T0 home view  ─────── depends on T4's data; ships LAST but is designed FIRST,
                      because it is what the sections are arranged around

T1 origin + door ──┬─→ T2 /settings ────────────────┐
                   ├─→ T3 /contacts /calendar ──────┤
                   ├─→ T6 /search (stub → indexed) ─┼─→ T7 real login
                   └─→ T5 invocation cost ──→ T4 /approvals /agents
```

- **T2 and T3 need no server work at all.** They are the fastest path to the app feeling
  like a product, and both are pure surfacing.
- **T4 has the most behind it** — `s03.D` T1 *and* four `/console/*` routes. Do not start
  the screens before the routes; that is exactly how `s03.E` ended up demo-only.
- **T5 before T4**, or the agent dossier ships with three numbers it cannot compute. And
  `.feedback` `018` before T5, or the console faithfully renders an inverted price
  preference.
- **T0 ships last and is designed first.** It cannot render until T4 produces proposals, but
  every other section is arranged around it — start by drawing the home view, then build
  inward. Building the sections first and bolting a home page on afterwards is precisely how
  this ends up as a file manager with a notifications tray.
- `/files` is deliberately absent from this plan's tasks: it is `s03.C` T3, blocked on
  `s03.B` T3 (unstarted), and `.feedback` `common/030` (FileNode copy OOM) is open. Ship the
  nav item disabled with a reason rather than a section that 500s.

## Decisions needed

1. **Is `app.bullmoose.cc` public, or Tailscale-only to start?** A mail client on a public
   hostname is a different risk posture than one on the tailnet. *Recommendation: public,
   but only after T7 — the interim door should not face the internet.*
2. **Does `/agents` show other people's agents on shared accounts?** The grant model allows
   it; the console currently answers per-account. *Recommendation: yes, and label whose it
   is — hiding it would make the access log the only place to find out.*
3. **Is the value estimate per-proposal or per-agent-per-period?** *Recommendation:
   per-proposal, optional, aggregated up — a per-period number invites invention.*
4. **Does `/search` search *other people's* shared realms?** *Recommendation: no, not in the
   first cut. Cross-account search is a permissions surface of its own.*
5. **Does an agent with no `allowedRecipients` send freely, or not at all?** The Bureau
   answered the same question with fail-closed (invariant 5). *Recommendation: match it —
   unbound means cannot send. It is the safer default and the inconsistency of having two
   answers to one question is worse than either answer.*
6. **Where does attachment extraction run?** Containers, a queue plus a durable consumer, or
   an external service. *Recommendation: defer until someone actually wants it — the tiering
   decision above is what needs to be true now, and it holds regardless of which one wins.*
7. **Does the typed agent-config core get its own columns, or stay in `config_json`?**
   *Recommendation: columns for the four the console enforces (`allowedSenders`,
   `allowedRecipients`, `replyMode`, `enabled`), blob for the agent-specific remainder —
   otherwise the console is parsing untyped JSON to decide what to warn about.*
