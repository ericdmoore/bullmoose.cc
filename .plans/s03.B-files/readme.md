# s03.B — Files: the fourth realm

> **Status: T1–T3 SHIPPED (inbound).** Schema, `FileNode/*` and the inbound sidestep are live. Missing: the OUTBOUND sidestep — acceptance #3 is unmet. ⚠️ Its stated blocker is gone: `Email/set create` carries attachments as of #133.

> **Slice of the s03 web-access arc.** Shared context:
> [`../s03-webAccess/readme.md`](../s03-webAccess/readme.md) ·
> [`../s03-webAccess/arch.md`](../s03-webAccess/arch.md) §3.

## Why this exists

**Side-stepping attachment size limits.** Big file → Files realm → send a _link_, not an
attachment. That clears SMTP's practical ~25 MB ceiling and is equally valuable to both
audiences: you attaching a video, Allen attaching a generated chart or extracted CSV.

Files is also the fourth data realm humans and agents share (mail, contacts, calendar
being live), so it completes the surface the whole arc is about.

## The two findings that shape this slice

1. **A standard exists — conform, don't invent.**
   [`draft-ietf-jmap-filenode-14`](https://datatracker.ietf.org/doc/draft-ietf-jmap-filenode/)
   is an active JMAP WG draft (intended Proposed Standard, `urn:ietf:params:jmap:filenode`)
   — the same thing Stalwart implements and Bulwark consumes. A private
   `urn:bullmoose:files` dialect would be one no client could ever speak.
2. **We need a metadata layer, not a storage layer.** Blob upload, download, R2 paths,
   expiring public links, and a non-mail realm already using blobs (contact photos, RFC 9610) are all **live**. The attachment sidestep is five steps and four already exist.

## What it ships

The attachment sidestep, end to end — **without any UI**. Drivable by CLI/curl, which
makes it independently testable and independently valuable.

## Depends on

**s03.A** (provenance — `file_nodes` should carry it from birth rather than be
retrofitted).

## Blocks

s03.C's Files browser (UI over this). Nothing else.

## Acceptance

1. `FileNode/{get,set,query,changes,queryChanges,copy}` conform to the pinned draft,
   advertised as `urn:ietf:params:jmap:filenode`.
2. A blob referenced by a FileNode is never garbage-collected.
3. A >25 MB send produces a message with a working expiring link and no attachment.
4. A large inbound attachment appears in Files, cross-linked to its message.
5. `npm test` green, `npm run typecheck` clean, coverage on new modules ≥ the s01 bar.

## Out of scope

- **`shareWith` / named-principal sharing** → the multi-principal ACL ("teams") epic.
  Link-sharing already ships and covers the motivating use case.
- The Files **browser UI** → s03.C.
- Previews/thumbnails, versioning, full-text indexing of file contents.
