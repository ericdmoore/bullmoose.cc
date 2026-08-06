# s03 — Web Access: dev plan

> System blocks and ordered work for [`arch.md`](./arch.md). Rationale for the ordering
> lives in `arch.md`; this is *what gets built, in what order, and how we know it works*.
>
> **Scale note.** s03 is materially bigger than s01 — four phases, not four tasks. It is
> written so each phase is independently shippable and each leaves the product working.

---

## System blocks

```
┌─ webmail (Astro + Preact) ─────────────────────────────────────┐
│  shell · jmap client module (injected) · sync via /changes+ws   │
│  ┌ mail ┐ ┌ files ┐ ┌ brief ┐ ┌ approvals ┐ ┌ console ┐        │
└───┼──────────┼────────┼────────┼──────────────┼────────────────┘
    │          │        │        │              │
┌───▼──────────▼────────▼────────▼──────────────▼────────────────┐
│  JMAP worker                                                    │
│  mail/contacts/calendar [live] · FileNode [new] · agent [new]    │
└───┬──────────┬──────────────────────┬──────────────────────────┘
    │          │                      │
┌───▼───┐ ┌────▼─────┐ ┌──────────────▼──────────┐ ┌────────────┐
│  D1   │ │    R2    │ │  AccountDO (state/push) │ │agent worker│
│ +prov │ │ blobs    │ │  +FileNode +Proposal    │ │ +brief cron│
└───────┘ └──────────┘ └─────────────────────────┘ └────────────┘
```

Blocks marked **[live]** in `arch.md` §1 are reused unchanged: blob upload/download,
expiring public links, R2 paths, push channel, agent state machine.

---

## Phase 0 — Design-now foundations *(must precede feature writes)*

Retrofitting either of these after months of data is impossible, which is why they lead.

### T1 — Cross-realm provenance
**Blocks:** D1 data plane, all `*/set` methods.
Add `last_writer_principal`, `last_writer_binding`, `last_writer_invocation` to every
mutable record (emails, mailboxes, cards, address books, events, calendars — and
FileNode when it lands). Populate in the shared write path, not per-method.

**Done when:** every `*/set` writes provenance; a fake-DB unit test asserts an
agent-authored write records its binding; the per-resource query ("who touched this
card?") returns a row without joining `grant_audit`.

### T2 — Grant tombstones
**Blocks:** control plane, `provision` revoke path.
Soft-delete grants (`revoked_at`) and log lifecycle events. Grant resolution ignores
tombstoned rows; forensics can still reconstruct "who could have, last Tuesday."

**Done when:** revoking removes access but the row survives; a point-in-time query
returns the historical authorization set. `authorizeAccount` behaviour unchanged
(existing s01 tests stay green).

---

## Phase 1 — Files realm

Self-contained, standards-backed, and the highest user-visible value per unit of work
(the attachment sidestep). Independent of the webmail client — testable via CLI/curl.

### T3 — `file_nodes` schema + blob pinning
Inode table (parent, name, nodeType, blobId, size, type, timestamps, executable, role),
sibling-name uniqueness as a DB constraint. **Blob pinning**: a blob referenced by a
FileNode must survive GC (`arch.md` §3.3) — lands *with* the schema.

**Done when:** tree CRUD holds at the DB level; a pinned blob is not collectable;
cycle/`parentId` integrity enforced.

### T4 — `FileNode/*` JMAP methods
`get` (+`fetchParents`), `set` (+`onDestroyRemoveChildren`, `onExists`,
`compareCaseInsensitively`), `query` (depth recursion), `changes`, `queryChanges`,
`copy`. Advertise `urn:ietf:params:jmap:filenode`. `shareWith` returns `null`;
`myRights` = owner rights (`arch.md` §3.4). Commit changes to AccountDO so `/changes`
and push work like every other collection.

**Done when:** a conformance suite drives create-dir → upload → attach blob → move →
rename → copy → delete-with-children; `/changes` reflects each; capability appears in
the session only when enabled.

### T5 — Attachment sidestep (both directions)
- **Outbound:** compose helper — upload → `FileNode/set` → `/api/share` → link in body.
- **Inbound:** ingest rule — attachment ≥ N bytes → FileNode under the Attachments
  role, link retained in the message.

**Done when:** a >25 MB send produces a message with a working expiring link and no
attachment; a large inbound attachment appears in Files with its message cross-linked.

---

## Phase 2 — Webmail shell + the plain-client floor

Nothing agent-flavoured yet. The goal is a mail client good enough to use daily —
`readme.md` §2's floor — because every later surface renders inside it.

### T6 — App shell + injected JMAP client
Astro shell, Preact islands, auth (bearer; session bootstrap), and **one JMAP client
module**: `using[]` negotiation, batched `methodCalls`, `/changes` sync driven by the
existing `/api/ws` push. Injected per `devPrinciples.md` so tests pass a fake.

**Done when:** login → session → mailbox list against a fake client in unit tests, and
against `wrangler dev` manually. No network in the test suite.

### T7 — Mail surfaces
Mailbox list, thread list, thread view, compose/reply/forward, search, attachments
(with T5's link path). Keyboard-first triage.

**Done when:** a person can run a day of mail in it. Capability-gated agent bits absent
and nothing broken (`arch.md` §8.6).

### T8 — Files browser
Tree navigation, upload (drag/drop + folder), preview, move/rename/delete, "copy link"
via the existing share endpoint.

**Done when:** Files is usable standalone and round-trips with T5.

---

## Phase 3 — The co-existence layer

Where the product stops being a webmail and becomes multiplayer.

### T9 — `urn:bullmoose:agent` capability + `ActionProposal`
The read model over `agent_invocations` (`arch.md` §4.1) exposed as a JMAP collection
with `state`/`/changes`/`ifInState`: `kind`, `tier`, `subject`, `payload`, `rationale`,
`evidence[]`, `status`, `holdUntil`, `decision`. Producers: the agent worker emits
proposals instead of (or alongside) direct writes.

**Done when:** an agent run yields a `pending` proposal with rationale + evidence;
approving a tier-1 applies it; a tier-3 cannot be applied without a human action;
`/changes` drives push.

### T10 — Approval queue UI + bulk
Queue with grouping, per-item *why*, approve/reject/snooze, **hold tray** for tier-2,
and query-filter-batch with count-preview. Rejection captures
`{wrongContent|wrongAction|notNow}` + note.

**Done when:** 40 queued items are dispatchable in a couple of gestures; a held item is
yankable before commit; `notNow` records as a snooze and does not decrement the agent's
signal.

### T11 — Thread ownership & collision
Surface `assignee`/`claimedAt` from the existing claim **[live]** — "Allen is drafting",
"handled by Emily, awaiting you" — plus human→agent invoke on a thread
(`agent-integration.md` §C).

**Done when:** a claimed thread shows its holder live; invoking an agent from the UI
creates an invocation.

### T12 — The brief
Server-computed `brief(accountId, day)` on the agent worker's existing `scheduled`
**[live]**, stored with `asOf`, rendered twice: JMAP object → Today/Tomorrow UI; MIME →
Allen's digest.

**Done when:** both renderings come from one artifact and agree; the mailed copy is
stamped `asOf`; disabling the UI still leaves the email working.

### T13 — "Promote repetition to policy" prompt
Detect repetition (N approvals of one `kind`/subject, or a bulk filter application) and
offer the promotion: autonomy dial ▸ `autoGrant` template ▸ ingest rule. **s03 writes
through a narrow interface; s04 owns the semantics** (`arch.md` §D3).

**Done when:** the prompt fires on a real repetition; accepting writes policy via the
interface; tier-3 kinds are never offered.

---

## Phase 4 — Agent console *(s04-dependent)*

### T14 — Per-agent view — *"Can Allen even do that?"*
Bindings, MCP credential **references** (never values), A2A grants, spend, recent
actions. **Effective** permissions rendered, not raw scope strings (`mail` is a
superset — `auth-core:50-53`), plus dangerous-combination warnings (`mcp-auth.md` §8).
Credential entry POSTs **directly to the agent worker's vault**, never via the site
backend (`mcp-auth.md` §9).

### T15 — Per-resource view — *"Who could have messed up VendorsBook?"*
Side-by-side **who *could*** (authorization set, point-in-time via T2) and **who *did***
(`grant_audit` + T1 provenance). The gap between them is the finding.

**Done when (both):** the two questions are answerable in one screen each; no secret
ever transits the site backend; the views read an s04-defined model rather than
re-deriving policy.

---

## Sequencing

```
T1 provenance ─┐
T2 tombstones ─┴─▶ (everything; must precede feature writes)

T3 schema ─▶ T4 FileNode/* ─▶ T5 sidestep ─┐
T6 shell ─▶ T7 mail ─▶ T8 files UI ────────┤
                                            ├─▶ T9 ActionProposal ─▶ T10 queue
                                            │                     ├─▶ T11 ownership
                                            │                     ├─▶ T12 brief
                                            │                     └─▶ T13 promotion
                                            └─▶ T14/T15 console  (needs s04 model)
```

- **Phase 0 first** — non-negotiable; retrofit is impossible.
- **Files before webmail** — standards-backed, testable without a UI, and delivers the
  attachment win on its own.
- **Plain client before agent surfaces** — the floor has to exist before things are
  layered on it, and it de-risks the biggest unknown (a real mail UI).
- **Console last** — it is the only piece gated on another plan.

## Acceptance for s03 overall

1. Files conforms to the pinned FileNode draft (minus `shareWith`) and the attachment sidestep works both ways.
2. Webmail is a competent single-player mail client **without** the agent capability.
3. With it, the approval queue makes a day's agent output dispatchable in a few gestures.
4. Every invariant in `arch.md` §8 holds and is tested.
5. `npm test` green; `npm run typecheck` clean; coverage on new modules ≥ the s01 bar.

## Out of scope

Named-principal file sharing (`shareWith` / ACL epic) · public MCP façade + OAuth (s02) ·
governance semantics: budgets, gatekeepers, policy engine (s04) · Bulwark conformance
probe (own work) · IMAP bridge.
