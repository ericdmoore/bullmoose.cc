# s03.C — Webmail floor: architecture

> Slice-specific structure. System-wide architecture lives in
> [`../s03-webAccess/arch.md`](../s03-webAccess/arch.md) §7.

## 1. Shape: Astro shell, Preact islands

The app is authenticated and highly interactive, so the mail surfaces are an
**SPA-in-an-island** rather than page-per-route Astro. Static Astro still earns its keep
on the login/marketing edges, which keeps the authenticated bundle honest.

Rationale for not going full SPA framework: the marketing site is already Astro, the
deploy path (Pages) is proven, and `@astrojs/preact` is already a dependency. Reuse beats
novelty here — per `.plans/devPrinciples.md`, _leverage what exists when it makes sense_.

## 2. The JMAP client module — the one load-bearing abstraction

A single module owns **all** protocol contact:

```
JmapClient {
  session()                     // + capability negotiation for `using[]`
  request(methodCalls[])        // batched; back-references supported
  sync(collection, sinceState)  // /changes-driven
  upload(blob) / download(blobId)
}
```

Three properties it must have:

- **Injected, never imported as a singleton.** Components receive it. Tests pass a fake
  and touch no network (`devPrinciples.md`). This is the difference between a testable
  client and one that needs a live server.
- **Batching by default.** JMAP's whole point is one round trip for many calls; a client
  that fires per-component requests throws that away.
- **Capability-aware.** `using[]` is computed from the live session, so a surface whose
  capability is absent never sends a request that would 400.

## 3. Sync: push, not poll

```
/api/ws (AccountDO)  ──StateChange──▶  client  ──▶  Foo/changes(sinceState)  ──▶  patch store
```

Both halves already exist server-side **[live]**. The client keeps a per-collection
`state` and reconciles on push, falling back to a periodic `/changes` sweep if the socket
drops (the CLI's `watch` already models this reconnect-with-backoff behaviour).

**Not building:** an offline-first local mirror. That's a real design (mujmap/notmuch
territory) and a different project — the server is the source of truth here.

## 4. Surface inventory (this slice)

| Surface       | Notes                                                                |
| ------------- | -------------------------------------------------------------------- |
| Mailbox list  | roles, unread counts, `Mailbox/query`                                |
| Thread list   | virtualized; `Email/query` + `queryChanges`                          |
| Thread view   | message rendering, HTML sanitization, quoted-text collapsing         |
| Compose       | reply/forward, drafts, attachments → s03.B link path for large files |
| Search        | server-side `Email/query` with a `text` filter                       |
| Files browser | tree nav, upload (drag/drop + folder), move/rename/delete, copy-link |

**HTML sanitization is a security surface, not a rendering detail.** Untrusted sender
HTML in an authenticated origin is the classic webmail XSS vector; it needs a strict
sanitizer plus CSP, and remote-content blocking by default (tracking pixels).

## 5. Capability gating — designed in, not retrofitted

Every future agent surface is behind one check:

```
if (session.capabilities["urn:bullmoose:agent"]) { …render… }
```

Doing this from the first commit is what makes the s03.D work additive rather than a
rewrite, and it's what keeps the "works as a plain client" invariant honest
(`../s03-webAccess/arch.md` §8.6).

## 6. Invariants this slice adds

1. No component imports a JMAP client directly — it is always injected.
2. No test performs network I/O.
3. Sender HTML is sanitized before render; remote content is blocked by default.
4. With `urn:bullmoose:agent` absent, no surface errors, 400s, or renders an empty shell.
5. Requests are batched — a thread open is one round trip, not N.
