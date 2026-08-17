# s03 — Web Access: architecture

> **What this is.** The structure behind [`readme.md`](./readme.md)'s thinking, and the
> reasoning for why [`devPlan.md`](./devPlan.md) is sequenced the way it is. Where the
> readme asks _what should exist_, this says _what we build, on what, and why that
> shape_.
>
> **Status legend:** **[live]** — exists today, `file:line` cited. **[proposed]** — this design.

---

## 1. What already exists — the honest baseline

s03 is much less greenfield than it looks. Before designing anything:

| Capability                                               | State                                                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JMAP mail / contacts / calendar                          | **[live]** — `Email/*`, `Mailbox/*`, `Thread/get`, `EmailSubmission/*`, `Identity/get`, `VacationResponse/*`, `AddressBook/*`, `ContactCard/*`, `Calendar/*`, `CalendarEvent/*` |
| **Blob upload** (RFC 8620 §6.1)                          | **[live]** `POST /api/upload/{accountId}` (`services/jmap/src/index.ts:75-79`), advertised as `uploadUrl` (`session.ts:82`)                                                     |
| **Blob download**                                        | **[live]** `GET /api/download/{accountId}/{blobId}/{name}` (`index.ts:69-73`)                                                                                                   |
| **Expiring public links for a blob**                     | **[live]** `POST /api/share/{accountId}/{blobId}` `{name, type?, ttlSeconds?}` (`index.ts:81-86`)                                                                               |
| Blob storage in R2                                       | **[live]** `mail/{tenant}/{account}/blobs/{blobId}` (`mailstore:256`)                                                                                                           |
| Non-mail realm already using blobs                       | **[live]** contact photos ⇄ R2 per RFC 9610 (`mailstore:1771-1806`)                                                                                                             |
| Push channel                                             | **[live]** `/api/ws` → AccountDO                                                                                                                                                |
| Agent state machine, claim, SLA, `grant_audit`, `$agent` | **[live]** (see readme §3c)                                                                                                                                                     |

> **Correction to `readme.md` §4.** The readme says sharing a file link outward "pulls
> forward" the multi-principal ACL epic. That is **wrong for the common case** —
> expiring public blob links already ship. What the ACL epic actually gates is
> _named-principal_ sharing (`shareWith`), not "send someone a link." See §3.4.

**Consequence for sequencing:** the Files realm needs a **metadata layer**, not a
storage layer. Bytes, upload, download, and public links are done.

---

## 2. Realm model

Four realms, each a JMAP capability. Three exist; one is new.

| Realm                   | Capability                          | Status              |
| ----------------------- | ----------------------------------- | ------------------- |
| Mail                    | `urn:ietf:params:jmap:mail`         | **[live]**          |
| Contacts                | `urn:ietf:params:jmap:contacts`     | **[live]**          |
| Calendar                | `urn:ietf:params:jmap:calendars`    | **[live]**          |
| **Files**               | **`urn:ietf:params:jmap:filenode`** | **[proposed]** — §3 |
| **Agent collaboration** | **`urn:bullmoose:agent`** (vendor)  | **[proposed]** — §4 |

The split is deliberate and follows `serverless-jmap.md` §19: **standardized realms get
standard capabilities** (any conforming client benefits); **the co-existence layer is a
vendor capability** (only our webmail and our agents speak it). That's what lets
webmail be a competent plain client _and_ a multiplayer one without contorting either.

---

## 3. Files — conform to the draft

### 3.1 Decision: implement `draft-ietf-jmap-filenode`

The research question from readme §4 is resolved: **the standard exists.**
[`draft-ietf-jmap-filenode-14`](https://datatracker.ietf.org/doc/draft-ietf-jmap-filenode/)
is an active JMAP WG Internet-Draft, intended status **Proposed Standard**, last updated
2026-05-15, capability `urn:ietf:params:jmap:filenode`. It is also what Stalwart
implements and what Bulwark consumes.

**Conform rather than invent**, because:

- A vendor `urn:bullmoose:files` would be a private dialect no client could ever speak — and Files is the one realm where third-party clients (Bulwark, future JMAP clients) are plausibly useful.
- The draft's model is a good one: a FileNode is an **inode**, which is exactly the shape needed.
- It makes our own conformance probe (readme §10) meaningful for Files too.

**The risk, stated plainly:** draft-14 is **not an RFC**. It has iterated 14 times, expires 2026-11-16, and carries a "create real-world clients to test this" TODO. So: implement the draft, **pin the version we target**, and expect churn. Mitigation in §3.5.

### 3.2 The object

```
FileNode {
  id            Id          (immutable, server-set)
  parentId      Id|null     (null = top level)
  name          String      (unique among siblings)
  nodeType      String      "file" | "directory" | "symlink"   (immutable)
  blobId        Id|null     (required for files; null otherwise)
  size          UInt|null   (files only)
  type          String|null (IANA media type; files only)
  created/modified/accessed/changed   UTCDate
  executable    Boolean
  isSubscribed  Boolean
  myRights      FilesRights (server-set)
  shareWith     Id[FilesRights]|null    ← DEFERRED, see §3.4
  role          String|null ("root" | "home" | "trash" | …)
}
FilesRights { mayRead, mayAddChildren, mayRename, mayDelete, mayModifyContent, mayShare }
```

Methods: `FileNode/get` (+`fetchParents`), `/set` (+`onDestroyRemoveChildren`,
`onExists`, `compareCaseInsensitively`), `/query` (depth-based recursion),
`/changes`, `/queryChanges`, `/copy`.

### 3.3 Mapping onto our substrate

- **Metadata → D1** (`file_nodes` in the data plane): the inode tree. Sibling-name
  uniqueness is a DB constraint, not application logic.
- **Content → R2**, reusing the existing blob path and `Mailstore` put/get. **No new
  storage code.**
- **Change tracking → AccountDO**, exactly like every other collection: `commitChanges`
  with `collection: "FileNode"` gives `/changes` + push for free.
- **Blob GC hazard.** The draft is explicit: _"A blob referenced by a FileNode MUST NOT
  be expired or garbage collected while the FileNode exists."_ Upload blobs today are
  transient-by-intent; a referenced blob becomes **pinned**. This is the one
  non-obvious storage change and it must land _with_ the schema, not after.

### 3.4 Sharing: three tiers, only two in s03

| Tier            | Mechanism                                                      | s03?               |
| --------------- | -------------------------------------------------------------- | ------------------ |
| Private         | owner-only, `myRights` from ownership                          | ✅                 |
| **Link-shared** | existing expiring public blob link (`/api/share/…`) **[live]** | ✅ — already built |
| Named-principal | draft's `shareWith` + `FilesRights`, hierarchical inheritance  | ❌ → ACL epic      |

`shareWith` is a genuine **multi-principal ACL** — the Phase-6 "teams" work
`serverless-jmap.md` flags, and it partly overlaps our `grants` model. Implementing
FileNode **minus `shareWith`** gets Files-for-me plus send-a-link, which is the entire
attachment-sidestep use case. `myRights` is still returned (owner rights); `shareWith`
returns `null`. That is a conforming subset, not a fork.

### 3.5 Draft-churn mitigation

Keep FileNode handling behind the same method-registry indirection every other
collection uses, pin the targeted draft version in a constant, and **don't leak
FileNode shapes into the webmail's own types** — the client talks to a thin Files
adapter. When draft-15 lands, the blast radius is one module.

### 3.6 The attachment sidestep — the flow that justifies the realm

**Outbound** (the motivating case):

```
compose → attach 400 MB
  → POST /api/upload/{account}          [live]  → blobId
  → FileNode/set create {file, blobId}  [new]   → node in /Sent Files
  → POST /api/share/{account}/{blobId}  [live]  → expiring URL
  → body gets the link; message carries no attachment
```

Every step but one already exists.

**Inbound** (symmetry, nearly free): ingest already writes attachments to R2. Add a
rule — _attachment ≥ N bytes → create a FileNode under `role:"home"`/Attachments,
keep the link in the message_ — and Files is populated on day one instead of being an
empty drive.

---

## 4. The agent-collaboration layer — `urn:bullmoose:agent`

The co-existence machinery that no standard covers. One vendor capability, four objects.

### 4.1 `ActionProposal` — the approval queue

**Decision (readme §9.3): a projection over `agent_invocations`, not a new store.** The
state machine, claim semantics, and SLA already exist **[live]**; duplicating them into
a second table would create two sources of truth about "what is the agent doing." So
`ActionProposal` is a _read model_ over invocations plus a proposal payload, exposed as
a first-class JMAP collection (`state` + `/changes` + `ifInState`) so webmail syncs it
like any other.

```
ActionProposal {
  id, accountId
  agent          (binding name — Allen, Emily)
  kind           "reply-draft" | "unsubscribe" | "create-event" | "start-thread"
                 | "create-contact" | "organize-files" | "grant-request"
  tier           1 | 2 | 3                      ← reversibility, §4.3
  subject        { realm, objectId }            ← what it acts on
  payload        (kind-specific: draft blobId, event JSON, grant request…)
  rationale      String                          ← the "why", always present
  evidence       [{ realm, objectId, note }]     ← what it looked at
  status         pending | approved | rejected | held | expired
  createdAt, decidedAt, holdUntil
  decision       { by, reason, note }            ← the no-thanks signal, §4.4
}
```

`grant-request` sitting in the same queue as `reply-draft` is deliberate: an agent
asking for a permission and an agent proposing a reply are the same interaction — _what,
why, approve/deny_ — and unifying them means one review surface, not two
(readme §6, `mcp-auth.md` §11d).

### 4.2 `Provenance` — cross-realm, and a design-now item

readme §7.2: `grant_audit` only fires on **delegated** access, so an agent acting on
its own account logs nothing. `$agent` gives mail provenance; contacts/calendar/files
have no equivalent.

**Design:** every mutable record in every realm carries `lastWriter` (principal +
optional binding + invocation id). Not a log — a **column**, so the per-resource
forensic view is one query rather than a reconstruction. The audit log answers _who
did_; the grants answer _who could_; this answers _who actually touched this record_.

Cheap now, impossible retroactively — which is why it is **T1** in the dev plan, ahead
of every feature.

### 4.3 Reversibility tiers drive behaviour, not just labels

Tier is a property of `kind`, and it decides what the system may do:

| Tier           | On approve                                     | May graduate?                          |
| -------------- | ---------------------------------------------- | -------------------------------------- |
| 1 reversible   | apply immediately, keep an undo handle         | ✅                                     |
| 2 retractable  | enter **hold tray** (`holdUntil`), then commit | ✅ (into the tray, never straight out) |
| 3 irreversible | human click only, every time                   | ❌ **never**                           |

Enforcement is the existing scope lattice — `send` is withheld from agents, so tier-3
egress _cannot_ be auto-committed even if a policy bug said otherwise
(`mcp-auth.md` §12 step 10). **Policy is the UI's opinion; the capability wall is the
guarantee.**

### 4.4 `Policy` — promote repetition to policy

The autonomy dial, `autoGrant` templates, and ingest rules are three faces of one
thing: a per-`kind` (optionally per-subject) rule that says _auto-approve within these
bounds_. s03 **records and applies** decisions and surfaces the "want this automatic?"
prompt; **s04 owns the governance semantics** (budgets, gatekeepers) — see §6.

Rejections capture `{ wrongContent | wrongAction | notNow }` + optional note. `notNow`
must **not** count against the agent — it's a snooze, and conflating it with a real
rejection would poison both the training signal and the dial.

### 4.5 Ownership & collision

The primitive already exists: the optimistic `pending → running` claim **[live]**. Expose
`assignee` + `claimedAt` on the thread projection so webmail can render _"Allen is
drafting"_. No new mechanism — just surfacing one.

---

## 5. The brief (Today / Tomorrow)

A **server-computed artifact**, not a client-side aggregation. Computed on a schedule
(the agent worker already has `scheduled` **[live]**), stored, then rendered twice:

```
brief(accountId, day) ──┬── JMAP object → webmail renders natively
                        └── MIME digest  → Allen mails it (fallback renderer)
```

Rationale: if webmail assembled it client-side, the mailed version would drift and the
two would disagree. One artifact, two renderers. The email is a **point-in-time
snapshot** and must say so (`asOf`); the UI is live.

---

## 6. Boundaries — what s03 is _not_

| Concern                                                | Owner                     |
| ------------------------------------------------------ | ------------------------- |
| Governance semantics: gatekeepers, budgets, ACL policy | **s04**                   |
| Public MCP façade, OAuth 2.1 / CIMD                    | **s02**                   |
| Named-principal file sharing (`shareWith`)             | ACL / "teams" epic        |
| Bulwark conformance probe                              | its own work (readme §10) |

**The agent console is the boundary object.** s03 builds the _screens_ (per-agent
"can Allen do that?", per-resource "who could have?"), reading a model s04 defines. The
line: **s03 renders and requests; s04 decides and enforces.** If s03 finds itself
inventing budget semantics, it has crossed into s04.

---

## 7. Client architecture

**Astro + Preact** (`@astrojs/preact` is already a dependency; the doc's "Preact/Fresh"
note in `serverless-jmap.md:223` is stale — Fresh is gone).

- **Astro shell, Preact islands.** The app is authenticated and interactive, so it's an
  SPA-in-an-island rather than a static site — but static Astro for login/marketing
  edges keeps the bundle honest.
- **One JMAP client module**, shared by every surface, holding: session, `using[]`
  capability negotiation, batched `methodCalls`, and `/changes`-based sync driven by the
  existing `/api/ws` push **[live]**. Per `devPrinciples.md`, it is **injected** into
  components so tests pass a fake and need no network.
- **Bulk = server-side.** Query-filter-batch over 5k items cannot round-trip; it needs
  an `urn:bullmoose:agent` method that applies an action to a _query_, with a
  count-preview before commit (readme §6).
- **Graceful degradation inside our own client:** every surface that depends on
  `urn:bullmoose:agent` checks the session capability and hides cleanly, so the same
  build works against a bullmoose that hasn't deployed the agent layer.

---

## 8. Invariants (testable, mirroring `mcp-auth.md` §16)

1. **A tier-3 proposal is never auto-committed** — not by policy, not by bulk action. Provable: agents lack `send`.
2. **Every mutation records a `lastWriter`.** No realm writes without provenance.
3. **A revoked grant is tombstoned, never deleted** — point-in-time authorization stays reconstructable.
4. **A blob referenced by a FileNode is never GC'd** (draft requirement).
5. **`notNow` never decrements an agent's autonomy signal.**
6. **The webmail is usable with `urn:bullmoose:agent` absent** — the plain-client floor.
7. **No secret transits the site backend** — credential forms POST directly to the agent worker's vault (`mcp-auth.md` §9).

---

## 9. Open decisions

- **D1 — Agent reasoning presentation.** Recommend **structured** (`rationale` +
  `evidence[]` on `ActionProposal`, rendered in a context sidebar) rather than a
  synthetic threaded comment. Structured survives bulk views and drives the sidebar;
  a fake comment only reads well in one place, and we're no longer bound to old clients.
- **D2 — FileNode draft version to pin.** Recommend targeting **-14** and revisiting at
  RFC.
- **D3 — Where `Policy` lives** — s03 table read by s04, or s04-owned from the start?
  Recommend **s04-owned**, with s03 writing through a narrow interface, to avoid a
  migration when s04 lands.
