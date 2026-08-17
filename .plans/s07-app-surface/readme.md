# s07 — `app.bullmoose.cc`: one surface over every realm

> **Status: T0–T6 SHIPPED and deployed; T7 (OAuth login) not started.** Ten pages and eleven lib directories under `webmail/`, deployed to `app.bullmoose.cc` on every push to main — this is the only surface in the repo CI ships automatically. Remaining: T7, the `/agents` dossier, and the three-number score. ⚠️ Decision 1 below ("public, but only after T7 — the interim door should not face the internet") was REVERSED in practice: the paste-a-token door is the live front door today. `/files` is also no longer excluded — s03.B T3 landed.
> console), which shipped two disconnected pages. This is the section that makes them one
> product.

## The shape

A single origin, `app.bullmoose.cc`, with seven top-level sections:

```
/mail        /calendar     /contacts     /files
/agents      /approvals    /search       /settings
```

Each section is a **collection view** — the same idea (a set of things you can filter,
select and act on) rendered through the ontology its realm actually has. Mail has folders
and threads; calendar has time; files have a tree; contacts have groups; approvals have a
queue. The consistency is in the interaction model, not in forcing one layout onto
everything.

## What it is, and what it is not

The working analogy is **"Google Drive, but multi-player-first and with agents."** That is
right about two things and misleading about a third.

**Right:** collection views over heterogeneous nouns, and sharing as a first-class
primitive rather than an afterthought. The grant model is already account→account with
optional collection scoping (`grants.collection` / `collection_id`), which is much closer
to Drive's sharing than to a mail ACL.

**Right:** the realms genuinely are separate nouns with separate JMAP methods — Contacts
and Calendar have full CRUD on JMAP _and_ DAV today. The collection-view abstraction is
what stops eight nouns feeling like eight bolted-on apps. (This is the Nextcloud failure
mode worth avoiding: every app technically present, none of them feeling like the same
product.)

**Misleading:** Drive has no notion of _an actor that proposes work you approve_. That is
the novel thing here, and it is the part with no prior art to copy. `/approvals` is not a
Drive feature with a new name — it is the reason this product is different, and it should
get design attention proportional to that rather than being treated as a notifications
panel.

## Relationship to existing sections

| this section             | absorbs / depends on                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `/mail`                  | **`s03.C` T1–T2, shipped.** Move, don't rebuild.                                                       |
| `/files`                 | `s03.C` T3 ⛔ blocked on `s03.B` T3 (attachment sidestep, unstarted)                                   |
| `/contacts`, `/calendar` | sVOL **`022`** — server side complete on JMAP _and_ DAV; no screen exists                              |
| `/settings`              | sVOL **`024`** — E1, and its stated blocker (`006 Identity/set`) already shipped                       |
| `/agents`                | **`s03.E`, shipped client-side** — but 4 of its 5 endpoints are unserved                               |
| `/approvals`             | **`s03.D` T1–T5, unstarted.** `ActionProposal` is fully designed in `s03.D/arch.md` and built nowhere. |
| `/search`                | `common/004` gave mail FTS5; contacts and calendar are still full-scan `LIKE`                          |
| the login                | converges with **`s02` T3** — the OAuth AS being built for MCP is the same front door                  |

## References

- `.plans/s03.C-webmail-floor/` — the shell, `JmapClient`, the sanitizer, 374 tests
- `.plans/s03.D-coexistence/arch.md` §1 — the `ActionProposal` read model, already specified
- `.plans/s03.E-console/` — the two agent screens, and the `/console/*` routes they need
- `.plans/sVOL-CapSurNoun/_index.md` — the noun × surface grid; the WebUI column is this
- `.plans/s02-mcp-facade/devPlan.md` T3 — the authorization server this borrows
