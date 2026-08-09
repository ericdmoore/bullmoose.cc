# s03.C — Webmail floor: dev plan

> Scope: [`readme.md`](./readme.md) · structure: [`arch.md`](./arch.md).
> **Depends on s03.A** (provenance) and **s03.B** (Files).

---

## Status — updated 2026-08-09

| Task | State | Notes |
|---|---|---|
| **T1 — App shell + injected JmapClient** | ✅ **done** | `webmail/` workspace (Astro + Preact); `astro build` clean → static `dist/index.html` + island bundle. `JmapClient` (`FetchJmapClient`) + `FakeJmapClient` live and unit-tested (37 tests). |
| **T2 — Mail surfaces** | ⏸ **deferred** | Placeholder route only; no mailbox/thread/compose/search yet. `sanitize.ts` scaffolded fail-closed, not wired. |
| **T3 — Files browser** | ⏸ **deferred** | Needs s03.B's `FileNode` (partly built). |
| **T4 — Capability gate + plain-client proof** | ✅ **built into T1** | `hasAgentCapability` gate + `computeUsing` capability-awareness; tested against a capability-less session. |

**T1 delivered:**
- `webmail/` added to root `package.json` workspaces; typecheck chained
  (`npm run -w webmail typecheck`); vitest `test.include` picks up
  `webmail/**/*.test.ts`. The `vitest.config.ts` `resolve.alias` block was left
  **untouched** (its removal would silently resolve worker tests to the wrong
  worktree checkout).
- `webmail/src/lib/jmap/`: `JmapClient` interface + `FetchJmapClient` (session
  bootstrap, capability-aware batched `request`, back-referenced `queryThenGet`,
  `/changes` cursor `sync`, blob up/download, WS push `watch`) and
  `FakeJmapClient` (same interface, in-memory, local back-ref resolution) — the
  substrate T2/T3 develop against.
- Tests: session resolution, a batched back-reference run through jmap-core's
  **real** `dispatch`, the `/changes` cursor advancing, and the
  capability-less-session gate. Bite-verified (removing the capability guard
  fails the plain-client test).

**Wire-shape note:** the gate URN is `urn:bullmoose:params:jmap:agent` (what the
live server advertises — `packages/jmap-core` `AGENT_CAP`), not the arch's
shorthand `urn:bullmoose:agent` (arch.md §5). See `webmail/src/lib/jmap/capabilities.ts`.

**sVOL-CapSurNoun delta (not yet folded — do not edit `_context.md`/`_verify.sh`):**
the WebUI column stays `----` for every noun. The Astro+Preact shell now exists
and builds, but it renders **no** nouns yet (placeholder route only). Trap 4
("`tsconfig.json` excludes a `webmail/` dir that has never existed") is resolved:
`webmail/` now exists as a real workspace.

---

## T1 — App shell + injected JMAP client

**Blocks:** new `webmail/` workspace (the path `tsconfig.json` already excludes) ·
Pages deploy.

- Astro shell + Preact island mount; auth (bearer, session bootstrap); routing.
- The `JmapClient` module: session + `using[]` negotiation, batched `methodCalls`,
  `/changes` sync driven by `/api/ws` **[live]**, blob upload/download.
- Injected everywhere; a `FakeJmapClient` for tests lands *with* it.

**Done when:** login → session → mailbox list works against a fake in unit tests **and**
against `wrangler dev` by hand. Test suite performs no network I/O.

---

## T2 — Mail surfaces

- Mailbox list · virtualized thread list · thread view (sanitized HTML, quote collapsing,
  remote content blocked) · compose/reply/forward with drafts · server-side search.
- Keyboard-first triage (archive/label/next without the mouse).

**Done when:** a full day of real mail is workable in it; a thread open is one batched
round trip; sanitization is unit-tested against known XSS payloads.

---

## T3 — Files browser

- Tree navigation, upload (drag/drop + folder), move/rename/delete, copy-link via the
  existing `/api/share` endpoint **[live]**.
- Large-attachment compose path wired to s03.B's sidestep.

**Done when:** Files is usable standalone and round-trips with s03.B; a >25 MB attach
in compose silently becomes a link.

---

## T4 — Capability gating + plain-client proof

- The `urn:bullmoose:agent` gate helper, applied at every future-agent seam.
- A test (and a manual run) against a session **without** the agent capability.

**Done when:** with the capability absent, nothing errors, 400s, or renders a dead
region. This is invariant §8.6 of the arc's architecture, and it is cheapest to prove
now while there is nothing to hide.

---

## Sequencing

```
s03.A + s03.B ─▶ T1 shell/client ─▶ T2 mail ─▶ T3 files UI ─▶ T4 gating proof
```

T4 is listed last but should be **built into T1** — it's called out separately so it gets
verified, not so it gets deferred.

## Verification

Per `.claude` project practice: drive the real app, don't just pass tests. A green run
here means *opening it and doing a day of mail*, including a large attachment send and a
Files round trip.

## Risk

**This is the largest slice.** A mail UI is a lot of surface — virtualization, HTML
rendering, compose semantics, sync reconciliation. Two mitigations: (1) the JMAP client
module is the only piece that must be right early, since everything else is replaceable
UI; (2) ship T1+T2 as a usable read/reply client before polishing.
