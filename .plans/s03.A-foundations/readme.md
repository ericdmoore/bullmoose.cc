# s03.A — Foundations: provenance & tombstones

> **Status: SHIPPED (T1 + T2), with one known hole.** Provenance on all seven realms and grant tombstones are live. Acceptance #1 does NOT hold for CardDAV/CalDAV: `services/anglebrackets/src/dav.ts` never calls `storeFor()`, so DAV writes land NULL provenance (`.feedback/…/common/033`).

> **Slice of the s03 web-access arc.** Shared design context lives in
> [`../s03-webAccess/readme.md`](../s03-webAccess/readme.md) (the thinking) and
> [`../s03-webAccess/arch.md`](../s03-webAccess/arch.md) (the system architecture).
> This slice is scoped, standalone, and **gates every other s03 slice.**

## Status — ✅ SHIPPED (T1 + T2)

Both tasks landed. Nothing user-visible, as designed.

- **T1 provenance** — `last_writer_{principal,binding,invocation}` on all seven
  mutable data-plane tables (`emails, mailboxes, address_books, contact_cards,
calendars, calendar_events, file_nodes`), stamped in the **shared
  `packages/mailstore` write path** (every insert + primary update, plus the
  email flag/move path), never per JMAP method. `storeFor(ctx)` supplies the
  writer; `RequestContext.agent` carries binding/invocation when an agent acts.
- **T2 tombstones** — `grants.revoked_at` + a `grant_lifecycle` log. Resolution
  filters `revoked_at IS NULL` in `@bullmoose/auth-core` `verifyBearer`;
  `authorizeAccount` is **untouched** (additive, resolution-layer only). Provision
  `revokeGrant` now soft-deletes + logs; `createGrant` logs `created`. The
  tenant-teardown cascade keeps its hard DELETE (no history to keep).
- **Migration (E3)** — no framework; the exact operator ALTER list (21 provenance
  columns + `grants.revoked_at` + `grant_lifecycle`) is documented as comments in
  `packages/mailstore/sql/{data-plane,control-plane}.sql` and as a runbook in
  `docs/DEPLOY.md §1`. All columns NULLable → safe on existing rows.
- **Tests** — 933 pass (was 900): `packages/mailstore/src/provenance.test.ts`
  (26, all seven realms × owner/agent/system), `principal.test.ts` (+3 grant
  tombstone resolution), `adminLifecycle.test.ts` (+4 revoke→tombstone +
  lifecycle). Bite-proven: reverting the source alone fails 20/90. Typecheck
  clean, `@bullmoose/cli smoke` green.

## Why this exists, and why it's first

Two data-model changes that are **cheap now and impossible retroactively**. Every month
they're deferred is a month of records that can never be attributed and authorizations
that can never be reconstructed.

1. **Cross-realm provenance.** `grant_audit` only fires on _delegated_ access
   (`requireAccount` writes it when `access.granted`), so an agent acting on **its own**
   account logs nothing. "Emily's agent scrambled Emily's VendorsBook" produces zero
   rows — exactly where you'd look first. `$agent` gives mail provenance; contacts,
   calendar, and files have no equivalent.
2. **Grant tombstones.** "Who _could_ have done this last Tuesday?" is unanswerable
   from today's `grants` table if a row was hard-deleted — and a grant that existed but
   was never exercised leaves no trace in `grant_audit` at all.

## What it ships

**Nothing user-visible.** This is a pure enabler. Its value is that s03.D's forensic
console can answer real questions, and that the data written from s03.B onward is
attributable.

## Why it's its own slice

Small in task count, **large in blast radius** — it touches every mutable record in
every realm and the shared write path in two workers. Bundled into a feature diff it
would hide inside a bigger review. It deserves its own gate.

## Depends on

Nothing. Start here.

## Blocks

All of s03.B–E. Any slice that writes data should land _after_ this one, or its writes
are unattributable forever.

## Acceptance

1. Every `*/set` across mail, contacts, and calendar records a `lastWriter`.
2. An agent-authored write is attributable to its binding **and** invocation.
3. Revoking a grant removes access but preserves the row; a point-in-time query returns
   the historical authorization set.
4. `authorizeAccount` behaviour is unchanged — the s01 test suite stays green.
5. `npm test` green, `npm run typecheck` clean.

## Out of scope

The console screens that _consume_ this (s03.E) · the ACL/`shareWith` model · anything
user-facing.
