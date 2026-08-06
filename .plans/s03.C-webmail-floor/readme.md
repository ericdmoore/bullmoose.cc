# s03.C — Webmail floor: a mail client worth using

> **Slice of the s03 web-access arc.** Shared context:
> [`../s03-webAccess/readme.md`](../s03-webAccess/readme.md) ·
> [`../s03-webAccess/arch.md`](../s03-webAccess/arch.md) §7.

## Why this exists

Before webmail can be *multiplayer*, it has to be **a mail client**. This slice builds
the floor: Gmail-grade single-player mail, with **zero agent features**.

Two reasons that ordering is deliberate:

1. **Everything later renders inside it.** The approval queue, the brief, and the
   console are all surfaces within this shell. Building them first would mean building
   them twice.
2. **It de-risks the biggest unknown.** A real mail UI — list virtualization, thread
   rendering, compose, search, sync — is the largest piece of net-new work in the whole
   arc. Better to find out early.

It also satisfies the arc's stated floor: *a user who ignores every agent feature should
still have a good mail client.*

## What it ships

A usable daily-driver webmail: mailbox list, threads, compose/reply/forward, search,
attachments (with s03.B's link path), keyboard-first triage — plus the Files browser.

## Depends on

**s03.A** (provenance) · **s03.B** (Files, for the browser and the attachment path)

## Blocks

s03.D (co-existence surfaces render in this shell) · s03.E (console screens likewise)

## Design constraints carried from the arc

- **Astro + Preact.** `@astrojs/preact` is already a dependency; the `serverless-jmap.md:223`
  note about "Preact/Fresh" is stale — Fresh is gone.
- **One injected JMAP client module.** Per `.plans/devPrinciples.md`: clients are passed
  in, so tests use a fake and need no network.
- **Capability-gated by construction.** Every surface that will later depend on
  `urn:bullmoose:agent` checks the session capability and hides cleanly. That's what
  makes the same build work against a bullmoose without the agent layer — and it must be
  designed in from the start, not retrofitted in s03.D.

## Acceptance

1. A person can run a full day of mail in it without reaching for another client.
2. It works against a bullmoose with **no** `urn:bullmoose:agent` capability, with
   nothing broken or visibly missing.
3. Sync is push-driven (`/api/ws` → `/changes`), not polling.
4. The test suite passes a fake JMAP client — **no network in tests**.
5. `npm test` green, `npm run typecheck` clean.

## Out of scope

Approval queue, brief, ownership/collision indicators, agent console (**s03.D/E**) ·
mobile-native clients · offline/local-first caching · IMAP bridge.
