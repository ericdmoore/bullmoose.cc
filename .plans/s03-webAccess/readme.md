# s03 — Web Access: humans + agents co-existing in an inbox

> **What this is.** The thinking behind bullmoose's web surface: what data realms
> humans and agents share, which audience gets which tool, and what affordances make
> both productive. This is the *design conversation*, not a build plan — `arch.md` and
> `devPlan.md` come after this is reacted to (see §9, and the s04 dependency in §8).
>
> **Status legend** (per `mcp-auth.md`): **[live]** — exists today, `file:line` cited.
> **[proposed]** — design, not built.
>
> See also `.plans/devPrinciples.md` — pure core, effects in the shell, injected
> clients, ample fast tests.

---

## 1. The framing question

> *What are the data realms we can build for humans + agents to co-exist in an inbox?*
> — Email · Contacts · Calendars · Files
>
> *What design affordances would be needed for both to be productive?*

Behind it, the goal that motivates everything here: **a world where mail is triaged by
helpers before you have to deal with it at all.**

---

## 2. The audience split

| Audience | Surface | Why |
|---|---|---|
| **Humans** | **webmail** (Astro + Preact) | GUI, judgment, approval, exception-handling |
| **Agents** | **MCP + CLI** | agents drive text protocols far better than GUIs |
| **Power-user (you)** | **CLI**, also | `bullmoose admin …`; and per `mcp-auth.md` §9 the CLI is deliberately the *human* path for raw secrets — plaintext must not detour through a web tier |

**The CLI is dual-audience**, not agent-only. Worth naming so its ergonomics don't get
under-invested.

**Webmail is human-*first*, but not agent-*naive*.** Agents write into the human's
data — `$agent`-keyworded drafts (`services/agent/src/index.ts:298` **[live]**),
invocations, digests, classifications. So webmail's job isn't only "read mail"; it's
**"see and steer what the helpers did."**

**Webmail must also be a competent plain client.** Gmail-grade single-player mail is
the floor; the novel surfaces are additive. A user who ignores every agent feature
should still have a good mail client.

**But we do not hitch the new surfaces to old clients.** Standard clients (himalaya,
Apple Mail, Bulwark) get standard JMAP and that is a complete, honest product. New
surfaces use new parts — per the `serverless-jmap.md` §19 boundary: *boolean → keyword;
structured → vendor capability, visible only to clients that speak it.* The approval
queue is therefore a **first-class structured collection** (its own `state` +
`/changes` + optimistic concurrency, like the rules-ruleset design), not keywords
contorted for backward compatibility.

---

## 3. Prior art

### 3a. Bulwark — a client, not a server

The reference in the original stub (<https://bulwarkmail.org/#deploy>) needs a
correction that changes what we can take from it:

> *"Stalwart is the server: it stores mail, speaks SMTP, runs spam, holds auth.
> **Bulwark is the JMAP client** you point your browser at."*

So there is **nothing server-side to port** — Bulwark owns no storage. **bullmoose
occupies Stalwart's seat**, not Bulwark's. And Bulwark is Stalwart-coupled (FileNode,
Sieve/ManageSieve, `STALWART_FEATURES` admin extras), Next.js 16 SSR, and AGPL-3.0.

**Verdict: don't port or fork.** Take its *realm decomposition* (mail + calendar +
contacts + files, one login, one settings store) as the map. Running it unmodified as
a **JMAP conformance probe** is separately valuable — see §10.

### 3b. Shared inboxes — the human² precedent

Support desks solved "many hands, one mailbox" two decades ago. Plain email has **no
state and no ownership**; every shared-inbox product exists to add exactly those. That
is also what an agent-shared inbox needs — the problem doesn't care whether the other
player is a person or a process.

| Support-desk primitive | Solves (human²) | Human+agent analog |
|---|---|---|
| Assignment / ownership | two people don't both reply | who owns this thread — me, Allen, Emily, nobody |
| **Collision detection** | duplicate work | **"Allen is drafting"** |
| **Internal comments** | discuss without emailing the customer | the agent's reasoning / citations — side-channel |
| Status (open/pending/closed) | email has none | `pending → running → done → failed` |
| Views / queues | work lists | the Approval Queue |
| SLA + escalation | nothing rots silently | pickup SLA, armed responder |
| Saved replies / macros | consistency | agent personas + templates |
| Handoff / reassign | escalate to a specialist | agent → human escalation; human → agent delegation |
| @mention to summon | pull someone in | invoke an agent on a thread (`agent-integration.md` §C) |
| Audit log | accountability | `grant_audit`, `$agent` |

**Specific ideas worth raiding:**

- **Front** — internal comments rendered *inline in the thread timeline*; **shared
  drafts with approval** (our approval queue, already shipped by someone else).
- **Missive** — **live co-drafting**. Interesting inversion for agents: not "agent
  hands you a finished draft" but "you're both editing one buffer."
- **Help Scout** — the **context sidebar**: what the agent gathered and why, beside
  the message.
- **HEY** — **The Screener** (first-time senders queue for approve/deny before they
  reach you) — the purest "triaged before I deal with it"; and realms-by-kind
  (Imbox / Feed / Paper Trail).
- **Google Inbox** (dead, most-copied) — **Highlights**: surface the key fact without
  opening the mail. Direct ancestor of Today/Tomorrow.
- **Intercom Fin** — the **handoff protocol** (AI answers, escalates *with context*).
- **Zendesk** — rules/macros/triggers; matches our "deterministic → rules, judgment →
  agent" split.

The industry converged on the same shape we're proposing: agents that classify, draft,
and **stage everything for human review before send** — approval queues are now
standard practice rather than the exception.

### 3c. We already built the support-desk core — under different names  [live]

| Support-desk concept | Where it already lives |
|---|---|
| Ticket state machine | `agent_invocations.status` — pending/running/done/failed |
| **Claim / collision detection** | optimistic `UPDATE … SET status='running' WHERE status='pending'` (`services/agent/src/index.ts:116-122`) — first claimer wins, others back off |
| SLA watchdog | AccountDO alarm + armed responder (`services/agent/src/index.ts:20-24`) |
| Pickup SLA metric | `agent-integration.md:224` |
| Audit | `grant_audit` written on every delegated call (`services/jmap/src/methods/common.ts`) |
| Provenance | `$agent` keyword on agent-authored mail |

**Webmail is largely surfacing a model that already exists**, not inventing one.

---

## 4. The realms

| Realm | JMAP today | Notes |
|---|---|---|
| **Email** | ✅ `Email/*`, `Mailbox/*`, `Thread/get`, `EmailSubmission/*`, `Identity/get`, `VacationResponse/*` **[live]** | strong |
| **Contacts** | ✅ `AddressBook/*`, `ContactCard/*` **[live]** | strong |
| **Calendar** | ✅ `Calendar/*`, `CalendarEvent/*` **[live]** | strong |
| **Files** | ❌ nothing **[proposed]** | the one net-new capability |

**Files is in scope**, and the motivating rationale is the sharpest in the plan:
**side-stepping attachment size limits.** Big file → Files realm → send a *link*, not
an attachment. That clears SMTP's practical ~25 MB ceiling and is equally valuable to
both audiences (you attaching a video; Allen attaching a generated chart or extracted
CSV).

Two consequences:

- **Inbound symmetry is nearly free.** Attachments already land in R2 as blobs
  (`Mailstore.putBlob` **[live]**), so *"promote attachment ≥ N to a Files node, keep a
  link in the message"* makes Files useful on day one instead of an empty drive.
- **Link-sharing already ships.** ~~Sending a file link outside bullmoose pulls forward
  the ACL epic~~ — **corrected**: `POST /api/share/{accountId}/{blobId}` already mints
  expiring public links (`services/jmap/src/index.ts:81-86` **[live]**). What the
  Phase-6 ACL epic actually gates is *named-principal* sharing (the draft's
  `shareWith`), not "send someone a link." See `arch.md` §3.4.

✅ **Research item — resolved.** A standard exists:
[`draft-ietf-jmap-filenode-14`](https://datatracker.ietf.org/doc/draft-ietf-jmap-filenode/)
(JMAP WG, intended Proposed Standard, capability `urn:ietf:params:jmap:filenode`) — the
same thing Stalwart implements and Bulwark consumes. **Decision: conform, don't invent**
(`arch.md` §3.1). Caveat: it is a draft, not an RFC — pin the targeted version and
expect churn.

---

## 5. The surfaces

1. **Ahead for Today / Ahead for Tomorrow** — calendar × important mail, meshed;
   Google Inbox "Highlights" lineage.
2. **Approval Queue** — drafted replies · unsubscribes · events to create · threads to
   start · contacts to create · file organization · **permission requests** (§8).
3. **Thread view** — ownership, collision ("Allen is drafting"), agent reasoning,
   context sidebar.
4. **Agent console** — bindings, MCP credential *references*, A2A grants, audit
   (both views, §6).
5. **Files** — the attachment sidestep.
6. **Plain-inbox fallback** — competent single-player mail throughout.

### The brief, and Allen as fallback renderer

The daily brief is a **server-computed artifact**; webmail renders it natively, and
**email is the universal fallback renderer** for clients that can't show the native
section — that's Allen's digest. Email is the standard part, so it's the perfect
degradation channel.

Consequence: the brief must **not** be assembled client-side in webmail, or the mailed
version drifts from the rendered one. One artifact, two renderers. They differ in one
honest way — the emailed brief is a point-in-time snapshot ("as of 06:00"); the UI is
live. Stamp it.

### The Approval Queue's failure mode

**If 40 items/day land there, we moved the work instead of removing it.** Everything
in §6 exists to make the queue shrink itself.

---

## 6. Principles we landed on

### Promote repetition to policy — *the through-line*

The same shape appears three times, and it's the mechanism by which every queue in the
product empties:

| Repetition | Promoted to |
|---|---|
| approve the same unsubscribe 20× | raise the **autonomy dial** for that action class |
| approve the same A2A request 3× | write an **`autoGrant` template** (`mcp-auth.md` §11d) |
| bulk-apply the same filter | create an **ingest rule** |

Triage isn't magic — it's accumulated, codified preference.

### Graduation eligibility = reversibility

"Undo" mostly doesn't exist in email. The honest taxonomy:

| Tier | Actions | What's available |
|---|---|---|
| **1. Reversible** | move, label, classify, create contact, file organize, event *without* invites | **real undo** — local state |
| **2. Retractable pre-commit** | send reply, start thread, event *with* invites | **not undo — a hold window.** Gmail's "undo send" is a delay buffer |
| **3. Irreversible** | anything that left the building; data an agent already read | remediation only — revoking a grant stops *future* access, it can't un-read |

→ Tier 1 may graduate. Tier 2 may graduate **into a visible hold tray** ("going out in
5 min") where an item can still be yanked — this composes with bulk approve. **Tier 3
never graduates.**

The enforcement mechanism is **capability withholding + hold windows**, not undo — and
it already exists: the scope lattice withholds `send`, elevation stays human
(`mcp-auth.md` §12, step 10).

### Capture the no-thanks signal

A rejected item is the highest-signal training data in the system (stronger than
`ai-surface.md`'s "moving a message out of a bucket is a labeled example"). Capture
the rejection **and its rationale**, distinguishing:

- **wrong content** → trains the drafter
- **wrong action** → trains the classifier
- **right but not now** → a snooze; must *not* count against the agent

Canned reasons + optional free text. Pure free text is unusable as signal; pure canned
loses the nuance.

### Bulk means query-filter-batch, not checkboxes

Selecting *by query* has real consequences: **server-side execution** (5,000 items
can't round-trip — likely a vendor "apply action to query results" method), **preview
before commit** ("this affects 1,247 messages"), tier-aware handling (undoable / held /
refused), and it's **where a rule should be born** ("want this automatic from now on?").

### Both console views, because they answer different questions

| Question | View | Mode |
|---|---|---|
| *"Can Allen even do that?"* | **per-agent** | authorization — forward-looking |
| *"Who could have messed up VendorsBook?"* | **per-resource** | forensic — backward-looking |

The forensic view is itself two queries: **who *could*** (the authorization set) and
**who *did*** (`grant_audit`). Show them together — the gap is the finding. A wide
"could" with a narrow "did" means over-permissioning; a "did" with no matching "could"
means something is broken.

### Show effective permissions, not raw scopes

`hasScope` treats `mail` as a superset of everything except `admin`
(`auth-core:50-53`). A chip labeled "mail" reads as innocuous while granting `send` and
`delete`. Render what it *allows*. Likewise surface dangerous **combinations** —
`send` + external MCP + WebFetch is an exfiltration path (`mcp-auth.md` §8) even though
each part looks fine alone.

---

## 7. Design-now items — cheap now, impossible retroactively

Not build-now. But both become unrecoverable after months of writes:

1. **Revoke should tombstone, not delete.** "Who could have done this last Tuesday"
   can't be answered from today's grants table if a row was hard-deleted — and a grant
   that existed but was never exercised leaves no trace in `grant_audit` at all.
2. **Provenance must be cross-realm.** `grant_audit` only fires on *delegated* access
   (`requireAccount` writes it when `access.granted`), so an agent acting on **its own**
   account logs nothing — "Emily's agent scrambled Emily's VendorsBook" produces zero
   rows, exactly where you'd look first. `$agent` gives mail provenance; contacts,
   calendar, and files need the equivalent *"who/what last wrote this."*

---

## 8. Dependencies & boundaries

- **s04 (AgentOS) owns the governance model.** Its readme already lists *Gatekeeper ·
  Budget Constraints · ACLs (People Accessing Agents, Agents Accessing Tools/Data)* —
  which **is** the agent console's subject matter. **s03 designs the human chrome over
  an s04 model**; it must not re-derive the policy semantics, or s03 quietly becomes
  AgentOS. Budgets-per-agent are s04, though the spend ledger + pricing cache already
  make them cheap when we get there.
- **s02 (MCP façade)** is the agent-side surface for non-bullmoose clients. Orthogonal,
  but the OAuth work there is what a browser-based third-party would need.
- **`mcp-auth.md` §9** already specifies the credential admin plane — reuse it rather
  than re-deciding. The binding constraint: **a secrets form must POST directly to the
  agent worker's `/vault/credentials`**, never through the site backend. OAuth flows
  are the WebUI's *best* case (nothing sensitive typed); raw API keys are the one flow
  that bounces to the CLI.
- **`serverless-jmap.md:223`** already planned `/webmail — SPA JMAP client`, and
  `tsconfig.json` already excludes a `webmail/` dir that doesn't exist. Stack note: the
  doc says "reuse Preact/Fresh" — **Fresh is stale**; the site is Astro, and
  `@astrojs/preact` is already a dependency. **Astro + Preact.**

---

## 9. Open decisions

1. **Agent reasoning: threaded internal comment (Front-style) or structured metadata in
   a panel?** Now that new surfaces aren't bound to old clients, structured is more
   attractive than it first appeared.
2. **Files: conform to a JMAP draft, or design a vendor capability?** Blocked on the
   §4 research item.
3. **Where does the approval queue's *collection* live** — a new JMAP collection under
   `urn:bullmoose:…`, or a projection over `agent_invocations`? (It smells like the
   latter with a vendor-capability read surface.)
4. **How much of the agent console is s03 vs s04** (§8) — needs a line drawn before
   `arch.md`.

## 10. Out of scope

- **Bulwark conformance probe** — running Bulwark unmodified against our JMAP endpoint
  to harvest a real gap list. Valuable, judgment-heavy, and **its own section of
  work** — not a prerequisite for designing this.
- Public file sharing (the multi-principal ACL epic) — Files *for me* first.
- Anything requiring the s04 governance model to be built rather than merely specified.

---

## References

- Prior art: <https://bulwarkmail.org/#deploy> · <https://github.com/bulwarkmail/webmail> (AGPL-3.0)
- Shared inbox: [Missive](https://missiveapp.com/blog/shared-inbox) · [Help Scout](https://www.helpscout.com/inbox/) · [AI email assistants, 2026](https://missiveapp.com/blog/ai-email-assistant)
- Internal: `mcp-auth.md` (§8 injection, §9 admin plane, §11d A2A, §12 worked example) ·
  `agent-integration.md` (§C UI actions) · `serverless-jmap.md` (§19 keyword-vs-capability,
  §223 webmail) · `ai-surface.md` (labeled examples) · `.plans/devPrinciples.md` ·
  `.plans/s04-AgentOS/readme.md`
