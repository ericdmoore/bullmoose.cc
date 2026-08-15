# s21 — the explorer: navigable JSON without an app

> **Status: design** (2026-08-15). Eric, after declining a GraphQL facade:
> *"I'm open to a JMAP explorer — I tend to require that of my JSON APIs anyway. HAL style
> `_links`, `_meta`, `_self`, `_next` so the JSON APIs are clickable/navigable with just a
> pretty-print extension."*
>
> The instinct is the good one: **if responses carry links, the browser IS the explorer.**
> No app to build, no schema to maintain, no client software at all. But two structural
> obstacles sit between here and there, and the second one turns out to connect this to
> `auth.bullmoose.cc`.

## Obstacle 1 — JMAP has no URLs to click

HAL works because REST resources *are* URLs. **JMAP is one POST endpoint**: `/api/` takes an
array of `[method, args, callId]` triples and returns an array of results. There is no
`GET /Email/abc123` to link to, by design — batching and back-references (`#ref`) are what
JMAP offers instead of navigation, and they serve a different purpose (round-trip economy,
not discovery).

So `_links` cannot simply be added to JMAP responses: there is nowhere for them to point.

**What this actually implies: a read-only GET projection.** `GET /explore/Email/{id}` →
the object JMAP would return, plus `_self`, `_links` and `_next`. That is a second surface,
which `sVOL 025` rejected for GraphQL — but it is a *far* smaller one, and the difference is
worth being precise about:

| | GraphQL facade (wontfix) | this |
|---|---|---|
| schema language to keep in sync | yes, forever | none |
| mutation vocabulary | yes | **read-only** |
| new authorization | no (s19) | no (s19) |
| worst failure | a write under the wrong authority | a **leak** |
| link data | invented | **already in the payloads** |

That last row is the crux: an `Email` already carries `threadId`, `mailboxIds`, `blobId`;
a `FileNode` carries `parentId`. `_links` is a *rendering* of ids that already exist, not
new information. `_next` is JMAP's own `position`/`limit` paging, re-expressed.

## Obstacle 2 — a browser will not send your bearer token

Navigating to a URL sends **no `Authorization` header**. And a token in the URL is not an
option here: it is forbidden by policy and pinned by `webmail/src/lib/app/tokenInUrl.test.ts`
(referenced from three components), because a credential in a URL lands in browser history,
in referrers, and on anyone's shoulder.

The one sanctioned exception proves the rule: `watch` and `agent serve` put `access_token` in
the **WebSocket** query string (`watch.ts:311`, `agent.ts:346`) *because the browser
WebSocket API cannot set headers*. That is a documented concession to a protocol limitation,
not a precedent to widen.

So browser-native navigation needs a third auth mode: **a short-lived, narrowly-scoped
cookie.**

## Which means your two ideas are one idea

`auth.bullmoose.cc` is not a separate feature that happens to sit nearby — **it is the piece
that makes the explorer possible.** The flow:

1. Land on the explorer. No cookie → a "sign in" button.
2. The button opens the OAuth dialog at `auth.bullmoose.cc` (`s02`, deployed — the
   `bullmoose-oauth` worker is live and taking traffic).
3. On success the dialog sets an `HttpOnly; Secure; SameSite=Strict` cookie, **scoped to the
   explore path**, short-lived, carrying *read scopes only*.
4. Every link is now an ordinary browser navigation. The pretty-printer does the rest.

And it gives `s02` its **first real client** — one you control, on a surface where a
mistake is visible immediately. That is a much better way to prove an OAuth flow than
discovering its edges against claude.ai.

## The rule that keeps it honest

From `s19-transports`: **a facade calls the METHODS, never the store.** The explorer is
another door onto the same resources; if it reads `mailstore` directly it bypasses the
account and scope gates the methods enforce, and becomes the one transport with its own
holes. `jmapBridge.ts` is the existing proof this is workable — MCP already does exactly
this.

Read-only is doing real work here too: the blast radius of a bug is a **leak**, never a
write. That is what makes a cookie-authenticated surface tolerable at all.

## Open questions

1. ~~Its own host, or a path?~~ **RESOLVED: `explore.bullmoose.cc`.** (Eric asked directly;
   I had leaned "path first" above and was wrong — working the cookie through settles it.)

   **Why the separate host wins, and it is not aesthetics:**

   - **Origin isolation of the credential.** `app.bullmoose.cc` keeps a device token in
     `localStorage` and renders **email HTML** — attacker-controlled content by definition.
     Same-origin means a bug in either surface reaches the other's credential. A separate
     host means an explorer bug cannot touch the app's token, and an app XSS cannot ride the
     explorer's cookie.
   - **The cookie is host-only by construction.** A cookie set on `.bullmoose.cc` to be
     shared between hosts would also be sent to the marketing apex and everything else —
     exactly wrong for a read-everything credential. Set on `explore.bullmoose.cc` it goes
     nowhere else, with no `Path` gymnastics to get wrong.
   - **It can simply not exist.** A hostname is a route and a DNS record: a deployment that
     does not want an explorer omits both, rather than trusting a flag inside a worker that
     serves the product.
   - **It is legible.** The URL says "this is a debugging surface, not the product."

   **The auth flow works the same either way**, which is what makes this a free choice:
   `auth.bullmoose.cc` cannot set a cookie for another host, so it never does. It issues an
   authorization code, the **explorer redeems it and sets its own** host-only cookie — the
   ordinary OAuth shape, with the explorer as an ordinary client.

   ⚠️ **The rule that must not be missed if the explorer is served by the jmap worker**
   (attractive, since that is where the method registry lives): **cookie auth is accepted
   ONLY on the explore hostname, and ONLY for GET.** The worker must check the `Host` header
   before honouring a cookie, not merely rely on the browser's host-only scoping. Otherwise
   a cookie-authenticated path exists on the API origin and the JMAP endpoint becomes
   CSRF-able — trading a debugging convenience for a write primitive. Bearer stays the only
   credential `app.bullmoose.cc/api/` accepts.
2. **Always on, or opt-in per deployment?** A read-only mirror of everything is a real
   surface. *Recommendation: a deploy-time flag, default OFF, so a tenant that never wants
   it never serves it.*
3. **Does it render HTML or JSON?** JSON only, per the ask — the whole point is that a
   pretty-print extension is the entire client. *If it ever renders HTML it has become an
   app, and the argument for building it weakens.*
4. **Cookie lifetime.** Minutes, not days. It is a debugging session, and a long-lived
   cookie on a read-everything surface is the thing that would make this a bad idea.

## References

- `.plans/s19-transports/readme.md` — resources not transports; the facade-calls-methods rule
- `.plans/sVOL-CapSurNoun/archived/025 …` — why the GraphQL facade was declined, and how this differs
- `webmail/src/lib/app/tokenInUrl.test.ts` — the policy this must not break
- `packages/cli/src/watch.ts:311` — the WebSocket exception, and why it is one
- `.plans/s02-mcp-facade/` — the authorization server this depends on, already deployed
