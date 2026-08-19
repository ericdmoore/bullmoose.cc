# 010 -E2-I1- Blob lifecycle — enumerate, delete, revoke share

| | |
|---|---|
| **Kind** | capability |
| **Effort** | **E2** — routes in `services/jmap/src/index.ts`, two methods on `Mailstore`, CLI verbs in `packages/cli`. New KV namespace binding, **no D1 migration** — see *What to build* §2 |
| **Impact** | **I1** — human-verifiable (revoke a link, it stops working), unlocks nothing on its own |
| **Owner** | `sVOL` |
| **Depends on** | — |
| **Related** | `011` / `s03.B` T1 owns **blob pinning + GC**; this unit must not build that |
| **Status** | ✅ **shipped** — KV (§2 option a), so the unit held at **E2**. 42 tests. |

## What shipped, and the decision behind it

**KV, not a `shares` table. The unit stays E2.**

The fork in §2 was decided on the lifetime argument, not the effort grade. A
share record is useful for exactly as long as its link is valid; `expirationTtl`
reaps it at that instant. Three consequences follow that a D1 table does not
get for free:

1. **Growth is bounded without maintenance.** At most `SHARE_MAX_TTL` (90 days)
   of records can be live, whatever the mint rate — a record cannot outlive the
   link it describes. Done-when #6 ("an expired link's record disappears on its
   own — no sweeper, no cron") is not a feature that was built; it is the
   storage engine's default. Under (b) it is a cron job this repo has nowhere
   to put.
2. **No migration, so no cliff.** `readme.md`'s E3 anchor is the migration, and
   this repo has no framework for one (`tools/README.md:10-11`).
3. **The public route stays off D1.** `GET /share/*` is the only route in this
   worker an anonymous internet client can reach. Option (b) puts a mail-database
   read on the hot path of an unauthenticated request; KV does not.

Open Question #2 worried that "the cheaper option preserves my effort grade" is
a suspicious reason to prefer a design. Agreed — so the tie-break was (1) and
(3), both of which point the same way independently of cost, and the counter-
argument from `admin.ts:18` is answered rather than ignored: that line is now
corrected in place, because the join it anticipated is a *reporting* need that
`s03.B` can serve from `file_nodes` when it exists, not a revocation need.

**Four things the unit did not anticipate, all decided here:**

- **A separate KV namespace is not available.** §2(a) says "bind a **separate**
  namespace". `infra/bootstrap.mjs`'s `wireText` (`:160`) rewrites only the
  FIRST `"id"` after `"kv_namespaces"` — the regex is deliberately non-global —
  so a second binding deploys with an unwired id. `services/jmap/wrangler.jsonc`
  says this in a comment. Records therefore live in `ROUTES` under a `share:`
  prefix, exactly as the `login:` throttle windows already do. Prefix isolation
  is the mechanism this repo has; namespace isolation is not.
- **Deny-by-default, not a revocation list.** A tombstone list would be
  cheaper and would tolerate KV loss more gracefully, but it cannot answer
  "what links are live?" — which is half this unit, and Done-when #2 outright.
  Fail-closed also means losing a KV key is not equivalent to un-revoking.
- **Open Question #5 resolved as FLUSH.** `shareId` is inside the signed
  payload, so every pre-existing link 403s. Taken deliberately: the state this
  unit exists to end is that nobody knows what is out there, and every
  surviving old link is one more record that can never be enumerated or
  revoked. A transition window would have preserved precisely the population
  we cannot account for.
- **Delete kept, per Open Question #3, but narrowed.** Explicit single-blob
  delete only, refusing on any reference. No sweep — `s03.B` T1 still owns
  pinning, and a sweep built now would delete FileNode-backed blobs the moment
  Files ships.

⚠️ **`s03.B` interaction, unchanged and still live.** `s03.B` T3 makes this
path the *standard* attachment route. A `FileNode` destroy that leaves a live
share URL is a data leak, and nothing in this unit prevents that: `011` must
call the revoke path (or `liveSharesForBlob`) on destroy. `handleBlobDelete`
refuses while a live share exists, which turns the silent leak into a visible
409 — but only for callers that go through blob delete. `FileNode/set
{destroy}` will not, unless `011` wires it.

### Where to look

| | |
|---|---|
| Record model + KV ops, with the decision written where it is executed | `services/jmap/src/shares.ts` |
| Routes, signature change, download gate | `services/jmap/src/index.ts` |
| `listBlobs` / `headBlob` / `blobReferences` / `deleteBlob` | `packages/mailstore/src/index.ts` |
| `bullmoose blobs list\|rm`, `bullmoose share list\|revoke` | `packages/cli/src/blobs.ts` |
| 33 worker tests + 9 CLI render tests | `services/jmap/src/shares.test.ts`, `packages/cli/src/blobs.test.ts` |
| Break-glass runbook (Done-when #7) | `docs/DEPLOY.md` § *Runbook: revoking share links* |

**The tests were verified to catch the gap**: with `services/jmap/src/index.ts`
and `packages/mailstore/src/index.ts` reverted to their pre-unit state (the
test files and `shares.ts` left in place, so the failures are behavioural
rather than import errors), **33 of 33** worker tests fail; restored, **420/420**
pass repo-wide against a 378 baseline. Five of them initially passed while
reverted, because the worker's catch-all 404 is indistinguishable from a real
"unknown account" by status alone — they now assert the response body, which
is the same lesson `packages/test-fakes/src/d1.ts`'s header records about
catch-all fakes, in HTTP form.

### Line numbers in "What exists today", re-verified

The unit predates several commits and every `services/jmap/src/index.ts`
citation below had drifted by one line (the file grew a comment above the
share routes); `Mailstore`'s had drifted by ~61. Corrected: `putBlob` was
`:1836`, now `:1897`; `getBlob` was `:1843`, now `:1904`. The route table's
`:36/:70/:76/:83` read `:37/:71/:77/:84`, and `handleShareCreate` `:190` read
`:191`. All are now stale again in the other direction — this unit moved them
itself — which is the argument for citing symbols rather than lines.

## Cells covered

**None in §1's grid.** The blob plane has no noun: `FileNode` is the noun-to-be and is `----`
on every surface, owned by `s03.B` via `011`. What exists underneath is attachment-blob
plumbing (`_context.md` §2 footnote 12).

This unit covers the two entries `_index.md` §4 lists outside the grid:

> `Blob delete / share revoke` → `010`

Like `001`, it occupies no cell and gates none. Unlike `001`, it does not block anything
either — which is the honest content of its `I1`.

## Why these grades

**E2.** Three small route handlers alongside four that already exist in a 268-line file, two
methods on `Mailstore` beside the two blob methods it already has, and CLI verbs. The one
piece of real design is share revocation, which is genuinely hard *only* because the current
scheme is stateless (§2). No new service. **No D1 migration** if §2's KV design is taken; a
`shares` table instead makes this E3.

**I1, and the honest reading of both factors:**

- *Human-verifiable* — yes, and crisply. Send a big-file link to yourself, open it in a
  browser, run `bullmoose share revoke <id>`, reload, get a 403. A non-engineer can do the
  whole loop.
- *Unlocks nothing* — no unit names this as a dependency. `011` names it, but as a *warning*,
  not an edge: `011:62-65` says a destroyed FileNode's minted share URL *"stays valid until
  `exp` with no kill switch… That is unit `010`, and it becomes a data-leak path once Files
  exists rather than merely untidy."* `011`'s own **Depends on** line is `s03.A` only. So the
  relationship is de-risking, not unblocking, and `I1` is correct.

**But this is the one unit in the volume with a real security edge**, and the impact rubric
does not have an axis for that. `I1` describes its position in the dependency graph accurately
and describes its urgency badly. Say so out loud rather than inflating the grade — see Open
Questions #1.

## What exists today

**Four blob routes on the jmap worker** (`services/jmap/src/index.ts`):

| route | line | handler | gate |
|---|---|---|---|
| `GET /share/{tenant}/{account}/{blob}/{name}?exp&sig` | `:36` | `handleShareDownload` `:220` | **none** — HMAC + expiry only, checked *before* `authenticate` at `:45` |
| `GET /api/download/{accountId}/{blobId}` | `:70` | `handleDownload` `:122` | `principalHasScope(principal, "read")` `:71` |
| `POST /api/upload/{accountId}` | `:76` | `handleUpload` `:141` | `"draft"` `:77` |
| `POST /api/share/{accountId}/{blobId}` | `:83` | `handleShareCreate` `:190` | `"draft"` `:84` |

**`Mailstore` exposes exactly two blob operations**, both at the bottom of a 1,912-line file:

```ts
async putBlob(tenantId, accountId, raw): Promise<string>   // :1836
async getBlob(tenantId, accountId, blobId)                 // :1843
```

`putBlob` is content-addressed — `b_${hex(SHA-256(raw))}` (`:1837-1838`) — under the key
`mail/${tenantId}/${accountId}/blobs/${blobId}` (`blobKey`, `:256-257`). The R2 binding is
`private blobs: R2Bucket` (`:287`), so **no caller can reach `.list()` or `.delete()` even by
accident**. `grep -rn 'blobs.delete\|blobs.list\|BLOBS.delete\|BLOBS.list'` across
`packages` and `services` returns nothing.

So there is **no enumeration, no delete, and no revocation**:

1. **No enumeration.** Nothing can answer "what blobs does this account hold, and how big are
   they?" — not the CLI, not JMAP, not an operator. R2 charges for storage nobody can see.
2. **No delete.** `destroyEmail` (`packages/mailstore/src/index.ts:643-655`) deletes the D1
   rows and leaves the object, with a source comment saying exactly why:
   *"Blob is retained in R2 for now — content-hash blobs may be shared; garbage collection is
   a separate sweep (TODO)"* (`:644-645`). Content addressing means two identical attachments
   in two messages are **one object**, so naive delete is a correctness bug, not just a policy
   choice.
3. **No revocation, and the scheme structurally forbids it.** `shareSignature`
   (`:170-188`) HMAC-SHA256s the payload `` `${tenantId}:${accountId}:${blobId}:${name}:${exp}` ``
   (`:185`) under `SHARE_SIGNING_KEY`. `handleShareCreate` (`:190-218`) verifies the blob
   exists (`:207-209`), computes `exp` (`:211`) and returns a URL (`:213-215`).
   `handleShareDownload` (`:220-247`) recomputes the signature from the **path**, compares it
   in constant time (`:231`, `timingSafeEqualHex:249-254`), rejects past-`exp` with 410 (`:232`)
   and streams the object.

   **Nothing is written down at mint time.** No row, no key, no log line. The system does not
   know the link exists. There is nothing to revoke *and nothing to enumerate*, and a leaked
   URL is valid for up to `SHARE_MAX_TTL` = **90 days** (`:168`), default 30 (`:167`).

**This is not a hypothetical path — it is the send path.** `packages/cli/src/main.ts:407-408`
already mints share links during a normal markdown send: assets over `--link-max` (default 4 MB,
`:400`) are uploaded and linked (`client.upload` / `client.createShareLink`,
`packages/cli/src/jmap.ts:68-100`), with a TTL from `--link-ttl` (default 30 days, `:401`).
Every big attachment anyone has ever sent is already a live, unrevocable URL.

**And it gets worse with use.** `s03.B` T3 (`s03.B-files/devPlan.md:57-60`) makes this the
*standard* attachment path — *"Outbound: upload → `FileNode/set` → `/api/share` → link in body.
Four of five steps already exist"* — plus an inbound rule that files large attachments the same
way. Every send after that lands one more permanent URL.

**Two structural notes:**

- `handleShareDownload` takes `tenantId`/`accountId` from the **path**, not from a session, and
  the HMAC is the only thing binding them. That is sound — but it means the download path has
  no account context to consult, which constrains where revocation state can live (§2).
- Minting is gated on `draft` scope (`:84`). ⚠️ `common/001` (P1, open): a `mail`-scoped token
  satisfies `draft`, and `mail` is the mint default
  (`services/provision/src/index.ts:467`). **Any token can mint a 90-day public URL to any blob
  in an account it can reach.**

## What to build

Three things. Do them in this order — §2 is the one that matters.

### 1. Enumeration

`Mailstore.listBlobs(tenantId, accountId, cursor?)` over
`this.blobs.list({ prefix: blobKey(tenantId, accountId, "") })` — the key layout at `:256-257`
makes per-account prefix listing free. Return `{blobId, size, uploaded}` plus R2's cursor.

Expose as `GET /api/blobs/{accountId}` (scope `read`, mirroring `:71`) and
`bullmoose blobs list --account …`. This is the cheapest useful thing in the unit: it is the
only way anyone will ever find out what is actually stored.

### 2. Share revocation — the design decision

**Revocation requires state at mint time.** A stateless HMAC cannot be un-signed. Note that
this is also what makes enumeration of *shares* impossible today, so both problems have one
answer: record something when a link is minted.

Minimal record: `{ shareId, accountId, blobId, name, exp, createdAt, revokedAt? }`, with
`shareId` added to the URL and to the signed payload at `:185`.

Where to put it:

- **(a) KV, keyed `share:{accountId}:{shareId}`, with `expirationTtl` = the link's remaining
  life. ← recommended.** `list({prefix})` gives enumeration; `delete`/overwrite gives
  revocation; **KV's TTL reaps the record exactly when the link dies**, which is precisely the
  lifecycle we want and which a D1 table would need a sweeper to imitate. The jmap worker
  already binds a KV namespace (`ROUTES`, `services/jmap/src/index.ts:17`), so the pattern and
  the wrangler plumbing exist — but bind a **separate** namespace; route resolution and share
  state should not share a keyspace. No D1 change, so **this is what keeps the unit E2**.
- **(b) A `shares` D1 table.** Strongly consistent, joinable, queryable. This is what
  `packages/cli/src/admin.ts:18` already anticipates — the designed-not-built entry reads
  `○ share  list | revoke expiring links  (needs the shares table)`. It costs a **migration**
  (no framework — `tools/README.md:10-11`), so **E3**, and it puts a D1 read on the hot path of
  every public download.
- **(c) Rotate `SHARE_SIGNING_KEY`.** Kills every link for every account at once. Free, brutal,
  **already possible today**. Not a design — but it is the current break-glass and it should be
  written into a runbook in this unit regardless of which option ships, because right now
  nobody knows it is the answer.

⚠️ **KV is eventually consistent.** A revocation may take up to ~60s to be visible at every
edge. For a kill switch on a leaked link that is probably acceptable and it is certainly better
than "never" — but it must be stated in the CLI output (*"revoked; may take up to a minute to
take effect everywhere"*) rather than discovered. This is the honest cost of (a) over (b), and
Open Questions #2 argues the other side.

Wire it into `handleShareDownload` after the signature check (`:231`) and before the R2 read
(`:235`): unknown or revoked `shareId` → **403**, same shape as the bad-signature path, so a
probe cannot distinguish revoked from forged.

Surface: `POST /api/share/{accountId}/{shareId}/revoke`, `GET /api/shares/{accountId}`,
and `bullmoose share list | revoke <id>` — filling in `admin.ts:18`'s `○`.

### 3. Blob delete — narrowly, and not the GC sweep

`Mailstore.deleteBlob(tenantId, accountId, blobId)` → `DELETE /api/blobs/{accountId}/{blobId}`,
scope `delete`.

**It must refcount before deleting.** Content addressing (`:1837-1838`) means the object may
back several messages. References live in `emails.attachments_json`
(`packages/mailstore/sql/data-plane.sql:34`) — *"JSON `AttachmentMeta[]`"* — plus `emails.blob_id`
for the raw RFC 5322 bytes. So the check is a `blob_id` equality scan **and** a JSON scan over
the account's emails: no index, O(messages). Acceptable for an explicit single-blob delete;
unacceptable as a sweep, which is the next point.

🚧 **Do not build the GC sweep here.** `s03.B` T1 owns blob pinning — *"a blob referenced by a
live FileNode must survive GC. Lands with the schema"* (`s03.B-files/devPlan.md:15-17`). A GC
pass built now would have no concept of pinning and would delete FileNode-backed blobs the
moment Files ships. Explicit delete only; leave the sweep to the unit that owns the pin.

Also: an active share record for a blob should **block** its delete (or revoke the share as
part of it). Today's `handleShareDownload` returns `410 gone` when the object is missing
(`:236`), which is at least honest — but choosing that outcome silently is worse than
refusing.

## Done when

1. A person mints a share link (`bullmoose send` with a large attachment already does it,
   `main.ts:407-408`), opens it in a browser and sees the file; runs
   `bullmoose share revoke <id>`; reloads and gets a refusal. **That loop, in a browser, is the
   whole point of the unit** and needs no engineer.
2. `bullmoose share list` shows every live link for the account with its expiry — including the
   ones minted by `send`, not just ones minted deliberately.
3. `bullmoose blobs list` reports objects and sizes that reconcile with the R2 dashboard for
   that account prefix.
4. A revoked link and a forged signature return **the same status and body**, so the endpoint
   is not an oracle for which share ids exist.
5. Deleting a blob that still backs a message is **refused**, and the message's attachment
   still downloads afterwards. This is the assertion that catches a missing refcount; a delete
   that "worked" proves nothing.
6. An expired link's record disappears on its own — no sweeper, no cron.
7. The runbook documents `SHARE_SIGNING_KEY` rotation as the account-wide break-glass, with its
   blast radius (every link, every account) stated.

## Bread-crumbs

- The whole blob surface is `services/jmap/src/index.ts:165-254` — 90 lines, one HMAC helper,
  two handlers, one constant-time compare. It is small and readable; read it whole before
  changing it.
- `SHARE_SIGNING_KEY` is **optional** in `Env` (`:24`). Both share handlers return **501
  `"sharing not configured"`** when it is unset (`:196`, `:221`). New routes must do the same,
  or a deployment without the key gets a 500 instead of a clear answer.
- `handleShareCreate` clamps TTL to `[60, SHARE_MAX_TTL]` (`:204`) and strips `/` from the
  filename (`:203`). `handleShareDownload` sets `content-disposition: inline` for images and
  PDFs (`:239`) — so a leaked link to an image renders in the browser rather than downloading,
  which is worth knowing when reasoning about the leak.
- `getBlob` is called **twice** per share flow: once at mint to verify existence (`:208`) and
  once at download (`:235`). The mint-time call fetches the body when a `head` would do — a
  one-line efficiency fix worth taking while in the file.
- CLI client methods to extend, not duplicate: `upload` `packages/cli/src/jmap.ts:68-82`,
  `createShareLink` `:85-100`, `downloadBlob` `:102+` (which resolves through the session's
  `downloadUrl` template rather than hardcoding the path — do the same for new routes).
- `packages/cli/src/sync.ts:300,372-378` already downloads blobs to disk under `--blobs`; a
  `blobs list` verb should agree with what that writes.
- `_index.md` §4 maps this unit to two entries; `011:62-65` is the only other file that names
  it. Nothing else in `.plans` mentions share revocation — I grepped.
- Tests: `services/jmap` has **zero** test files (`_context.md` §5). The HMAC helpers
  (`shareSignature:170`, `timingSafeEqualHex:249`) are pure and trivially testable, and a
  revocation test needs a fake KV, not a fake D1 — so `002` is **not** a dependency of this
  unit.

## Open questions / where this could be wrong

1. **`I1` is right by the rubric and wrong by the stomach.** The rubric's axes are *unlocks*
   and *human-verifiable*; there is no *risk* axis, so a live data-exposure path with no kill
   switch grades identically to a missing convenience command. I did not inflate the grade —
   `011` names this as a warning, not a dependency, so *unlocks* is genuinely false — but if
   this volume ever gets a third axis, this is the unit that motivates it. Meanwhile the
   sequencing is what needs to change, not the letter: `_index.md` §3 puts `010` in **wave 4,
   "cheap cleanup, any time"**, and I think that is wrong. The break-glass in §2(c) costs
   nothing and should be documented this week regardless of when the rest ships.

2. **KV vs a `shares` table is a real fork and I may have picked the wrong side.** I chose KV
   to hold the unit at E2 and to get TTL-based reaping for free, and I am aware that
   "the cheaper option preserves my effort grade" is a suspicious reason to prefer a design.
   The counter-arguments are strong: `admin.ts:18` says *"needs the shares table"*, so the
   original intent was D1; eventual consistency on a **security** control is an uncomfortable
   property; and a table joins against `emails`/`file_nodes` for the reporting `s03.B` will
   want. If the reviewer picks D1, this is **E3** and should be built in the same migration
   pass as `008`'s tombstones and `s03.A` T2's `revoked_at`.

3. **`s03.B` T1 may subsume the delete half entirely.** T1 lands `file_nodes` *and* blob
   pinning together (`devPlan.md:15-17`), which means it must define blob reachability anyway
   — and once it has, `deleteBlob` is a trivial consequence of it rather than its own work.
   A reasonable position: build only enumeration + revocation here, and let delete arrive with
   the pin. That would make this unit smaller and strictly better-ordered. I kept delete in
   because "no delete" is one of the two things the ledger entry names, but I think the
   reviewer may be right to strip it.

4. **The refcount is O(messages) with a JSON scan and I have not measured it.**
   `emails.attachments_json` (`data-plane.sql:34`) has no index and no extracted `blob_id`
   column, so a reference check reads every email row for the account (the raw-message
   reference is cheap — `emails.blob_id` is a plain column, `data-plane.sql:21` — but the
   attachment references are not). Fine for an interactive single delete on a small mailbox; I
   do not know where it stops being fine, and D1 caps bound parameters at 100 per query in
   production (`packages/mailstore/src/index.ts:259-262`), which suggests chunking is already a
   live concern in this codebase.

5. **Adding `shareId` to the signed payload breaks every existing link.** `shareSignature:185`
   would change shape, so links minted before the change fail verification. That is arguably
   *desirable* — it is a one-time revoke-all — but it is a user-visible break and this unit
   should decide it deliberately: either accept both payload shapes during a transition window,
   or announce it as the intended flush. I lean **flush**, on the grounds that not knowing what
   is out there is the actual problem.

6. **I did not verify that R2 `list()` on a Workers binding paginates the way I assume**, nor
   what `truncated`/`cursor` cost against a large prefix. The enumeration design in §1 is read
   from the key layout at `:256-257`, not from a tested call.

7. **Nothing was run.** No upload, no share mint, no download. Every claim is read from source
   at the working tree. `_context.md` footnote 12 (`:120-123`) cites `:76`, `:70`, `:83` and
   `:190`; all four match exactly — no drift in this file, unlike `007` and `008`.
