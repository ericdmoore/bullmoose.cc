---
plan: s21-explorer
status: closed
closed_at: 2026-08-19
closing_pr: none        # docs-only; `.plans/**` lands direct on main. The build
                        # PR was #125; the archive move was 7759b31 (2026-08-19).
acceptance: partial     # the code is complete; the surface has never existed
residues: 3
reversals: 1
---

# s21 — closing notes

s21 set out to make the browser its own JMAP client: if a response carries
`_self`/`_links`/`_next`, a pretty-print extension is the entire app. It got
there — `services/jmap/src/explore/` is 2,745 lines across nine files, eight
JMAP types projected, ~80 tests, every emitted link fetched and required to
return what it claimed. What the plan could not know is that the *interesting*
work turned out to be the two things it treats as prerequisites. Obstacle 2 (a
browser will not send a bearer) forced a third credential type into a worker
that also serves `app.bullmoose.cc/api/`, and the discipline that made that
tolerable — one cookie-resolution point, GET-only, exact-Host match — is the
durable output of this section. The explorer itself is the test case. And it
has never been switched on: **this folder is the repo's canonical example of
merged ≠ reachable**, which is why the archive index singles it out and why
`_closingNotes.template.md` cites it by name.

s21 was `s20` until `d5fe120` (2026-08-15) resolved a numbering collision, which
is why PR #125 is titled "s20: the explorer" and why the folder's own readme
carries a status line dated *before* its design notes.

## Acceptance ledger

s21 shipped a `readme.md`, never a `devPlan.md`, so it has **no `Done-when`
clauses**. The nearest thing it owns is its four **Open questions** plus the
one hard rule it wrote in bold. Those are quoted verbatim below and treated as
the acceptance surface; anything else would be inventing criteria after the
fact.

| Done-when (verbatim) | verdict | evidence |
|---|---|---|
| "Its own host, or a path? **RESOLVED: `explore.bullmoose.cc`.**" | ✅ met (in config) | `services/jmap/wrangler.jsonc:104` — the route exists, commented; `infra/bootstrap.mjs:154` `EXPLORE_HOSTNAME = explore.bullmoose.cc`. #125 |
| "**cookie auth is accepted ONLY on the explore hostname, and ONLY for GET.** The worker must check the `Host` header before honouring a cookie" | ✅ met | `services/jmap/src/explore/cookie.ts:73-77` — `cookieAuthAllowed` returns false without `exploreHost`, false for non-GET, and compares `hostOnly(hostHeader)` to the configured host. Called once, at `services/jmap/src/index.ts:268`. #125 |
| "Always on, or opt-in per deployment? *Recommendation: a deploy-time flag, default OFF*" | ✅ met, **and exceeded** | built as *two* independent switches — commented route (`wrangler.jsonc:104`) and commented `OAUTH` binding (`:149`), plus `EXPLORE_HOST` as a secret gating the code (`services/jmap/src/index.ts:81,121`). See Deviations. |
| "Does it render HTML or JSON? **JSON only, per the ask**" | ⚠️ met with one declared exception | one 12-line sign-in page, `services/jmap/src/explore/index.ts:136-158`, which names this open question in its own comment and ships `default-src 'none'`. Everything else is JSON. |
| "**Cookie lifetime.** Minutes, not days." | ✅ met | `services/jmap/src/explore/cookie.ts:34` — `EXPLORE_COOKIE_TTL_SECONDS = 900`. 15 minutes. |
| "a facade calls the METHODS, never the store" (the s19 rule this plan adopts) | ✅ met | the projection reads through the JMAP method registry; #125's structural test scans every worker file and asserts nothing outside `src/explore/` reads a cookie at all |
| Implied by the whole design: the explorer is reachable and gives s02 "its **first real client**" | ❌ unmet | `explore.bullmoose.cc` does not resolve — `dig +short` returns nothing, `curl` fails to resolve (probe, 2026-08-19). Carried forward. |

## Carried forward

| what | why it did not ship | owner |
|---|---|---|
| The explorer has never been switched on. Route commented (`services/jmap/wrangler.jsonc:104`), `OAUTH` service binding commented (`:149`), `EXPLORE_HOST` unset, no DNS record, no OAuth client registered. | Turning it on is four deliberate operator steps behind `node infra/bootstrap.mjs explorer` — a DNS record, a config edit that must be committed, one `POST /register`, four `secret put`s — and nobody has decided to take them. That is the design working, not failing; but a decision deferred forever is indistinguishable from a decision made. | **`#223`** (label `residue`) — an operator decision, not engineering work; the runbook is `infra/bootstrap.mjs:1126` and the comment block at `services/jmap/wrangler.jsonc:70-104` |
| Not one line of `src/explore/` has run against a live host. Every one of its ~80 tests is a harness test. | The surface it needs does not exist (row above), so there is nothing to point at. `infra/bootstrap.mjs:1256-1258` deliberately reports `explorer off … skipped` rather than failing — correct for a doctor, but it means the absence never nags. | **`#223`** — same thread, blocked on the row above |
| s02 still has no first-party OAuth client. The readme's argument that the explorer "gives `s02` its **first real client** — one you control, on a surface where a mistake is visible immediately" is unrealised. | Same cause: `EXPLORE_CLIENT_ID` is never registered until the bootstrap step runs. s02 archived with its edges proven against third-party clients instead, which was the thing this plan wanted to avoid. | **`#223`** — same thread, same cause |

## Reachability

- **Deployed?** Yes, in the sense that matters least. `src/explore/` is imported by `services/jmap/src/index.ts` and therefore ships inside the jmap worker bundle on every deploy. The jmap worker is live: `https://app.bullmoose.cc/.well-known/jmap` → **401** (probe, 2026-08-19).
- **Migration applied?** **None needed, and none should be added.** The cookie is a stateless HMAC, PKCE state rides the existing `ROUTES` KV with a 600 s TTL, and the projection reads D1 through the method registry. `services/jmap/wrangler.jsonc:98-101` and `infra/bootstrap.mjs:147-151` both say so unprompted, which is the right place for that sentence.
- **Switched on?** **No — three times over.** (1) route commented, `services/jmap/wrangler.jsonc:104`; (2) `OAUTH` service binding commented, `:149`; (3) `EXPLORE_HOST` is an unset *secret*, so `isExploreHost` is false for every request and no cookie is read anywhere (`services/jmap/src/index.ts:121`, `explore/cookie.ts:90-93`). `docs/architecture/system-map.md:135-141` names the same three and adds a fourth: DNS is a proxied `AAAA` to `100::` rather than a CNAME, specifically so a missing route has no origin to fall through to.
- **Verified live?** **Not verified — and not verifiable today.** `dig +short explore.bullmoose.cc` returns nothing and `curl https://explore.bullmoose.cc/` fails to resolve (probe by this note's author, 2026-08-19, from `alpaca`). The dependency it was built on *is* live: `https://auth.bullmoose.cc/.well-known/oauth-authorization-server` → **200** (same probe).

## Authority-surface delta

The largest in the section, and the reason the code reads the way it does.

- **A third credential type.** Before s21 the app accepted exactly one: a bearer. s21 adds `bm_explore`, an HMAC-signed cookie (`explore/cookie.ts:36`), `HttpOnly; Secure; SameSite=Strict`, `Max-Age=900` (`:160-161`).
- **A new refusal, and it is the load-bearing one.** `cookieAuthAllowed(host, method, exploreHost)` (`explore/cookie.ts:73-77`) is consulted at exactly one place — `services/jmap/src/index.ts:268`, after bearer — and refuses unless the request is a GET arriving with the explore Host. Without it, a cookie-authenticated path would exist on the API origin and `POST /api/jmap` would become CSRF-able: a debugging convenience traded for a write primitive. #125 pinned it behaviourally (a destroy attempt with a row count proving nothing changed) *and* structurally (a directory scan asserting no worker file outside `src/explore/` reads a cookie).
- **Scopes narrowed on mint, not on use.** The cookie carries `["read"]` verbatim whatever the grant said (`explore/oauth.ts:52,233`) and the access token is discarded rather than stored — nothing in the cookie is replayable anywhere. Account reach is re-derived from D1 per request, so a revoked grant stops working immediately.
- **A refusal that pre-empts a policy breach.** `?access_token=` / `?token=` are rejected with 400 on the explore host **before** authentication (`explore/index.ts:86`), so the surface cannot become the counterexample to `webmail/src/lib/app/tokenInUrl.test.ts`.
- **Net effect while `EXPLORE_HOST` is unset: zero.** Every one of the above is gated on a secret nobody has set.

## Deviations from `devPlan.md` / `arch.md`

- **Two switches, not one.** The plan pulled against itself: open question 2 asked for "a deploy-time flag, default OFF" while open question 1 argued the host should "simply not exist… rather than trusting a flag inside a worker that serves the product." #125 built **both** rather than picking, on the reasoning that a flag alone means the product worker trusts a flag and a route alone means the code is live and one config mistake from serving. This is the deviation that produced the whole "off three times over" property.
- **One page of HTML.** Open question 3 said JSON only. There is a sign-in page (`explore/index.ts:136-158`) because a 401 with no door is not a surface a human can enter. It is a heading, two sentences and a link, under `default-src 'none'`, and its own comment restates the plan's rule: "If this ever grows a second page it has become an app, and the argument for the whole unit weakens."
- **A pre-registered OAuth client, not per-request DCR.** Not contemplated by the plan. Registering per cold start would mint a fresh client id every deploy with a tail nobody can enumerate or revoke, so `bootstrap.mjs` registers once and refuses to register again while `EXPLORE_CLIENT_ID` is set.
- **Four honest 404s/notes instead of four inventions.** `Thread` gets no list (JMAP defines no `Thread/query`, so `GET /Thread` 404s pointing at `Email._links.thread`); `AddressBook`/`Calendar` say so in `_meta.note` rather than faking paging (`explore/types.ts:146,155`); `blobId` gets no `_links` entry, because the bytes live on the origin this cookie is *refused* on and a link there would break the "every link resolves" invariant.

## Reversals

- **s21 reverses its own recommendation from four paragraphs earlier.** The readme leans "path first" in prose and then resolves open question 1 the other way: `explore.bullmoose.cc` gets its own host, for origin isolation of the credential, host-only cookie scoping by construction, and the ability to simply not exist. The plan says so in its own voice — *"I had leaned 'path first' above and was wrong"* — which is the reason it is recorded here rather than quietly edited out.
- No decision from any other section was overturned.

## Absorbed / donated

- **Absorbed from `s19-transports`:** the facade rule — *a facade calls the METHODS, never the store*. s21 is its second proof after `jmapBridge.ts`; the read-only projection reads nothing directly out of `mailstore`.
- **Absorbed from `s02-mcp-facade`:** the deployed authorization server. s21 is written against it as an ordinary OAuth client. The debt is one-way and still unpaid — see the third residue.
- **Absorbed from `sVOL 025`:** the argument *against* a second surface. s21 restates it as a table and shows why a read-only projection lands on the other side of it: no schema language, no mutation vocabulary, no new authorization, and links rendered from ids the payloads already carry.
- **Donated:** one finding, to `s02`. #125 noticed `OAUTH_SCOPES` excludes `files` with a comment claiming the realm is unbuilt — stale, since `FileNode/*` ships and gates on `read`. Recorded in #125's body; s02 is archived, so this note is now its other home.
- Nothing of s21's own work was finished by another section.

## What grew stale during the build

- **The folder's own status line is out of order with itself.** `readme.md:3` says "SHIPPED and deployed, deliberately OFF (#125, 2026-08-14 — note that predates this file's own 'design' date)". The design notes were committed `66ebecc`/`3c36bc4` on 2026-08-14 and #125 merged 2026-08-15T04:28Z; the readme was then rewritten in place. Read it as a build note, exactly as it asks.
- **"SHIPPED and deployed" is the sentence to be careful with.** True of the *bundle*, false of the *surface*. An unqualified "deployed" in a status line is how a section ends up looking finished from the index while resolving to NXDOMAIN.
- **"no route, no DNS, `EXPLORE_HOST` unset" understates it by one.** The `OAUTH` service binding is also commented (`wrangler.jsonc:149`), so even an uncommented route with the secret set would not complete a sign-in.
- **The section number in the code is right; the number in PR #125 is not.** #125 is titled "s20: the explorer" because the renumber (`d5fe120`) landed the day after. `services/jmap/src/explore/*` and `infra/bootstrap.mjs:1126` both say s21.

## Traps for the next section

- **"Merged" and "reachable" are different claims, and only one of them is free to check.** s21 is code-complete, test-rich, reviewed, and resolves to nothing. Before writing "shipped" in a status line, run the probe: `dig +short <host>` costs a second and is the difference between a landing note and a guess.
- **A doctor that stays quiet about an intentional absence trains you to stop looking.** `infra/bootstrap.mjs:1250-1258` is right to print `explorer off … skipped` instead of failing — an always-red check gets ignored within a week. But nothing else nags either, and four days became five. If OFF is a valid state, the *decision* to stay off needs a home; the tooling will not remind you.
- **When a plan contradicts itself, build both sides before you arbitrate.** #125 found open questions 1 and 2 pulling against each other and shipped the route switch *and* the code switch. Neither alone suffices, and the discovery came from implementing rather than from re-reading.
- **A second door onto the same resources is a second door onto the same authority.** The only thing that made a cookie tolerable in a worker that serves the API was reducing it to one predicate, called from one place, tested on both axes independently — #125 verified that by deleting each half separately and confirming the *other* axis's tests correctly stayed green. Coverage that cannot fail one axis at a time is not coverage of two axes.
