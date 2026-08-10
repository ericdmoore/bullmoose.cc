# s07 — `app.bullmoose.cc`: dev plan

> Ordered build for [`readme.md`](./readme.md): eight sections on one origin, over realms
> that mostly already work. Most of this is **surfacing**, not building — 41 of the
> server's 48 JMAP methods are currently unreachable from a browser.
>
> **Guiding constraint:** never ship a section that renders convincingly against data it
> cannot actually reach. `s03.E` is the cautionary case — two complete screens, 128 tests,
> and four of five endpoints unserved, so it only fully renders under `?demo=1`. Every task
> here states which server routes must be live *before* the screen counts as done.

---

## Three refinements to the proposal

### 1. The token must never enter a URL

The sketch was: a front page where you paste a token, which form-redirects to
`/mail?token=…`. **Don't do the redirect.** A credential in a query string lands in browser
history, in the `Referer` header of every outbound link, in any access log along the path,
and in whatever the user copies out of the address bar. OAuth 2.1 discourages it explicitly,
and it would be a *new* leak — today you only get a token in a URL if you deliberately put
it there.

The fix costs nothing and keeps the UX identical. The login page is client-side already:
take the pasted token, write `localStorage`, then `location.assign("/mail")`. The token
never appears in a URL at any point.

Keep `?token=` as a dev affordance, but on read, `history.replaceState` it away immediately
so it does not survive into history. `webmail/src/lib/app/client.ts:46-63` reads it today
and does not strip it.

This is explicitly an **interim** front door. It is honest for a single operator and it is
not a login system — see T7.

### 2. Astro multi-page, not a client-routed SPA

"Mount the SPA" is the one structural thing I would change. Eight Astro pages, one
`client:only` island each, beats one client-routed bundle:

- **Deep links work with no router.** `/calendar` is a real URL that returns a real
  document. No history shimming, no scroll restoration, no 404-on-refresh.
- **You do not ship calendar code to someone reading mail.** Eight islands means eight
  bundles; a single SPA means everyone downloads everything.
- **The CSP story already works this way.** `astro.config.mjs` emits per-build sha256
  hashes (7 script, 2 style, identical across both current pages). Hand-writing that policy
  once already broke hydration so the page rendered empty *while `astro build` and the whole
  suite reported success* — see `s03.C/devPlan.md:69-74`. Do not re-open that.

The "app" feel comes from the islands being interactive and the chrome being shared, not
from client-side routing. Shared nav is an Astro layout.

### 3. The agent score needs a decomposition — and a column that does not exist

The proposal was a single score, roughly `approved / total tokens`. Two problems.

**It has no denominator today.** `agent_invocations` (`data-plane.sql:202-216`) records
`status`, `context_json`, `result_json`, `note` and three timestamps — and **no tokens, no
cost, no model**. Nothing anywhere records what an invocation cost.
`spend_facts` is unrelated: that is Allen the Analyst extracting spend from *receipt emails*
(`services/agent/src/ledger.ts:5-14`), not agent token spend. So the score requires schema
work that appears in no plan. T5 adds it.

**One number answers two questions badly.** `approved / tokens` conflates *did the human
want this* with *how expensive was it*, and it degenerates: an agent that proposes nothing
scores perfectly, and one that proposes 100 trivial things at 99% approval beats one that
proposes 3 hard things at 67%. Three numbers, shown together:

| number | question it answers |
|---|---|
| **acceptance rate** = approved ÷ proposed | is its judgment aligned with mine? |
| **cost of declined work** = spend on rejected proposals | *the waste number* — the one to make prominent, since it is the money already gone |
| **cost per approved action** = total spend ÷ approved | is it efficient at the things I do want? |

**On "$ generated or saved":** the system cannot compute this, and it should not pretend
to. The honest version is an **optional value estimate the human attaches at approval
time**, aggregated and always labelled as human-supplied. A number the machine guessed and a
number you asserted must never render the same way — that is the same discipline
`s03.E`'s caveats already apply to the access log.

---

## Tasks (in dependency order)

### T1 — The origin, the layout, and the interim door · *foundation*

**Files:** `webmail/wrangler.jsonc` (new), `webmail/astro.config.mjs`,
`webmail/src/layouts/App.astro` (new), `webmail/src/pages/index.astro`,
`webmail/src/lib/app/client.ts`, `.github/workflows/deploy-app.yml` (new), `docs/DEPLOY.md`.

- **`app.bullmoose.cc`.** The webmail is currently deployed by **nothing** — `deploy.yml`
  ships `src/` (the marketing site) to Pages project `bullmoose`, and `webmail/` has no
  deploy config and no `DEPLOY.md` entry. Add a Pages project and a workflow.
- **Write the domain map down before it collides.** Five hostnames are now in play across
  three plans:

  | host | serves | status |
  |---|---|---|
  | `bullmoose.cc` | marketing site (`src/`) | live |
  | `dav.bullmoose.cc` | `anglebrackets` (CalDAV/CardDAV) | live |
  | `app.bullmoose.cc` | this section | **new** |
  | `mcp.bullmoose.cc` | MCP façade | `s02` T1 |
  | `auth.bullmoose.cc` | OAuth AS | `s02` T3 |

- **A shared layout** with the eight-section nav, one island per page.
- **Tighten `connect-src`.** It is `'self' https: wss:` today — fine for one page talking to
  one API, too broad once the origin is public. Narrow to the JMAP worker's origin plus the
  WS endpoint.
- **The interim door** per refinement 1: paste-a-token, `localStorage`, `location.assign`.
  No token in any URL, ever. Strip `?token=` via `replaceState` on read.
- ⚠️ **Decide the no-token behaviour deliberately.** Today `client.ts:49-57` silently falls
  back to **demo data** when no token is present. On a public origin that means a stranger
  at `app.bullmoose.cc` sees a convincing mailbox full of fake mail. Demo mode must become
  opt-in (`?demo=1` only) and the bare no-token case must render the door.

**Done when:** `app.bullmoose.cc/mail` serves the existing client against a real token; a
first-time visitor gets the token form and not demo data; the token appears in no URL,
no history entry, and no log.

### T2 — `/settings` · *cheapest real section, and unblocked*

**Files:** `webmail/src/pages/settings.astro`, `webmail/src/lib/settings/`.

sVOL **`024`**, graded **E1**. Its stated blocker was `006 Identity/set`, which shipped —
the unit file's claim that `grep -r "Identity/set"` returns zero hits is stale
(`services/jmap/src/methods/identity.ts:167` registers it).

- `Identity/get` + `Identity/set` — display name, reply-to, bcc, signatures.
- `VacationResponse/get` + `/set`.
- ⚠️ `VacationResponse.htmlBody` is permanently `null` server-side — keep the editor
  plain-text rather than building a rich one that silently discards its output.
- Sign-out. `signOut()` exists at `client.ts:65` and **is called from nowhere** — there is
  no sign-out UI at all today.

**Server routes needed:** none. All four methods are live.

### T3 — `/contacts` and `/calendar` · *the biggest gap on the grid*

**Files:** `webmail/src/pages/contacts.astro`, `calendar.astro`, `webmail/src/lib/contacts/`,
`webmail/src/lib/calendar/`.

sVOL **`022`**. Seventeen live server methods with no browser path: `AddressBook/*` (3),
`ContactCard/*` (5), `Calendar/*` (3), `CalendarEvent/*` (6, including `getOccurrences`).
Both realms have full CRUD on **JMAP and DAV** already.

- Contacts: book list, card list, search, create/edit/delete, group membership.
- Calendar: month/week/day, event CRUD, recurrence via `getOccurrences` — do **not**
  re-expand RRULEs client-side; `calendar-core` has 100 tests against python-dateutil as
  the oracle and the browser must not become a second implementation.
- **Regrade.** `022` is marked E4, justified by "`ls webmail` fails; `tsconfig.json:33`
  excludes a path that has never existed." That is obsolete — the shell exists. The unit
  itself concedes it would be **E2** now. Fold that.

**Server routes needed:** none.

### T4 — `/approvals` and `/agents` · *the part with no prior art*

**Files:** `webmail/src/pages/approvals.astro`, `agents.astro`, plus `s03.D` T1 server work.

**Same data, two ontologies** — which is the proposal's own "collection view" idea applied
honestly:

- **`/approvals`** — the cross-agent queue, ordered by urgency. The daily driver.
- **`/agents/<id>`** — the per-agent dossier: pending, upcoming queue, historical
  approved/declined, and the three numbers from refinement 3.

This is **not new design work.** `ActionProposal` is fully specified in
`.plans/s03.D-coexistence/arch.md:19-36` — `status pending | approved | rejected | held |
expired`, `decision { by, reason, note }`, `rationale` always present, `evidence[]`, and
`tier` for reversibility. `grant-request` deliberately shares the queue, so an agent asking
for permission and an agent proposing a reply are one review surface. It is designed and
built nowhere.

⚠️ **`/agents` cannot ship on the existing console as-is.** `s03.E` needs four routes that
do not exist: `/console/agents`, `/console/agents/{id}`, `/console/accounts/{id}/resources`,
`/console/resources/{c}/{id}`. They are a browser-reachable projection of sVOL `015`'s
introspection queries, which today sit behind `x-internal-token` on the agent worker.

**Server routes needed:** `s03.D` T1 (`ActionProposal` collection + producer) **and** the
four `/console/*` routes. This is the task with the most server work behind it — sequence it
accordingly.

### T5 — Invocation cost, so the score can exist · *schema*

**Files:** `packages/mailstore/sql/data-plane.sql`, `infra/migrations.mjs`,
`services/agent/src/`.

Add to `agent_invocations`: `model TEXT`, `tokens_in INTEGER`, `tokens_out INTEGER`,
`cost_usd REAL`. Nullable — historical rows keep NULL and must render as *not recorded*,
never as zero. A zero would make every past invocation look free.

- Register in `infra/migrations.mjs` with an executable check, so a database missing the
  columns is caught by `bootstrap migrate` rather than by a dashboard quietly reading NULL.
- **Optional human value estimate** at approval time, stored on the proposal, aggregated and
  always labelled as human-asserted.

**Done when:** the three numbers compute from real rows; an agent with no recorded cost
renders "not recorded" rather than a flattering zero.

### T6 — `/search` · *cross-realm, and honest about what it can reach*

**Files:** `webmail/src/pages/search.astro`, `services/jmap/`, `services/agent/src/mcp.ts`.

Worth building, and worth starting as a **stub that names its own limits** rather than a
fake universal search.

The realms are not equally searchable, and shipping without saying so would repeat the bug
`common/004` just fixed — a search box whose scope note was quietly false:

| realm | today |
|---|---|
| mail | **FTS5**, indexed, ~0.4 ms at 0.1% selectivity |
| contacts | full-scan `LIKE` — `queryContactCards`, the exact pattern just removed from mail |
| calendar | full-scan `LIKE` — `queryCalendarEvents` |
| files | **nothing** — no search path at all |

- Ship `/search` fanning out to `Email/query` + `ContactCard/query` + `CalendarEvent/query`,
  with per-realm results and a visible scope note stating which realms are indexed and which
  are scanned. Reuse the honesty-note pattern already in `AppShell.tsx:577-579`.
- **Then give contacts and calendar the same FTS5 treatment mail got.** A 50K-card account
  is the case that bites, and it was flagged when `common/004` landed.
- **The MCP angle is the strongest argument for this.** The tool surface today has separate
  `email_query`, `contacts_search` and `calendar_query_events`; a model asking "what do I
  know about Dana" must know to call three. One `search` tool spanning realms is a better
  primitive, and it makes `/search` and the MCP tool the same query planner rather than two.

**Done when:** one query returns results from three realms; the scope note names what is
indexed vs scanned; the MCP `search` tool and the page share a code path.

### T7 — Real login, folded into `s02` · *retire the interim door*

**Files:** `webmail/src/lib/app/`, `services/oauth/` (from `s02` T3).

The paste-a-token door is interim by design. The real one is the OAuth AS being built in
`s02` T3 so claude.ai can connect — **the same front door**. Building a bespoke webmail
login and an AS for MCP would be building it twice.

- The webmail becomes a public OAuth client (PKCE S256, no secret), redirecting to
  `auth.bullmoose.cc`.
- Short-lived access token in memory + refresh, replacing a permanent `bm_` token in
  `localStorage`. Note that `bm_` tokens today **never expire** — neither self-service mint
  site writes `expires_at`.
- ⚠️ **Sharing has no home yet.** Grants are created by `POST /grants` on provision, behind a
  single deployment-wide `ADMIN_TOKEN`. `s03.E` renders grants **read-only**. For the
  "multi-player" half of the Drive analogy to be true at all, creating and revoking a share
  needs a UI and a non-admin route. Not scoped here — flagged because it is the largest
  unclaimed piece of the premise.

**Done when:** a user logs in without ever seeing a token; the interim door is deleted.

---

## Sequencing

```
T1 origin + door ──┬─→ T2 /settings ────────────────┐
                   ├─→ T3 /contacts /calendar ──────┤
                   ├─→ T6 /search (stub → indexed) ─┼─→ T7 real login
                   └─→ T5 invocation cost ──→ T4 /approvals /agents
```

- **T2 and T3 need no server work at all.** They are the fastest path to the app feeling
  like a product, and both are pure surfacing.
- **T4 has the most behind it** — `s03.D` T1 *and* four `/console/*` routes. Do not start
  the screens before the routes; that is exactly how `s03.E` ended up demo-only.
- **T5 before T4**, or the agent dossier ships with three numbers it cannot compute.
- `/files` is deliberately absent from this plan's tasks: it is `s03.C` T3, blocked on
  `s03.B` T3 (unstarted), and `.feedback` `common/030` (FileNode copy OOM) is open. Ship the
  nav item disabled with a reason rather than a section that 500s.

## Decisions needed

1. **Is `app.bullmoose.cc` public, or Tailscale-only to start?** A mail client on a public
   hostname is a different risk posture than one on the tailnet. *Recommendation: public,
   but only after T7 — the interim door should not face the internet.*
2. **Does `/agents` show other people's agents on shared accounts?** The grant model allows
   it; the console currently answers per-account. *Recommendation: yes, and label whose it
   is — hiding it would make the access log the only place to find out.*
3. **Is the value estimate per-proposal or per-agent-per-period?** *Recommendation:
   per-proposal, optional, aggregated up — a per-period number invites invention.*
4. **Does `/search` search *other people's* shared realms?** *Recommendation: no, not in the
   first cut. Cross-account search is a permissions surface of its own.*
