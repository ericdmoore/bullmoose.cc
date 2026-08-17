# 021 -E4-I3- Email + Files over WebUI

|                |                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Kind**       | projection                                                                                                                                                                                             |
| **Effort**     | **E4** — a new `webmail/` workspace on a stack that does not exist                                                                                                                                     |
| **Impact**     | **I3** — unlocks _and_ human-verifiable                                                                                                                                                                |
| **Owner**      | **`s03.C`** — `.plans/s03.C-webmail-floor/{readme,arch,devPlan}.md`                                                                                                                                    |
| **Depends on** | `s03.A` (provenance) · `s03.B` = unit **`011`** (the `FileNode` noun)                                                                                                                                  |
| **Status**     | **✅ done** (closed 2026-08-13) — pointer only; `s03.C` built it. `webmail/src/pages/{mail,files}.astro` over `webmail/src/lib/{mail,files}/`. ⚠️ Visual confirmation still owed — see `_index.md` ¹⁰. |

## Cells covered

`Email × CRUD × WebUI` · `FileNode × CRUD × WebUI`

## Owner — read there, not here

`s03.C` is fully specified. Its four tasks map onto these cells directly:

| Task                                     | Where           | Cells                                   |
| ---------------------------------------- | --------------- | --------------------------------------- |
| **T1** app shell + injected `JmapClient` | `devPlan.md:8`  | none — the prerequisite for all of them |
| **T2** mail surfaces                     | `devPlan.md:23` | `Email × CRUD`                          |
| **T3** Files browser                     | `devPlan.md:34` | `FileNode × CRUD`                       |
| **T4** capability gating proof           | `devPlan.md:45` | none — an invariant, `arch.md:69-77`    |

The load-bearing decision is one injected JMAP client module owning all protocol contact
(`arch.md:16-38`) — batched, capability-aware, never a singleton. Everything else is
replaceable UI, which `s03.C` says itself (`devPlan.md:74-76`).

## Why these grades

**E4** by the anchor: no `webmail/` workspace exists. `tsconfig.json:33` excludes a
`webmail` path that has never been created (`ls webmail` fails); the only web tree is the
Astro marketing site. **Ref correction:** `_context.md:27` cites `tsconfig.json:38`; the
exclude line is **`:33`**.

**I3.** _Unlocks_ — `022`, `023`, `024` all name it, and `s03.C/readme.md:35` declares it
blocks `s03.D` and `s03.E`. _Human-verifiable_ — the acceptance test is literally "run a
full day of mail in it" (`readme.md:49`).

## What `sVOL` adds

Three things not in `s03.C`'s own docs:

1. **The surface inventory has six rows and none is Contacts or Calendar** —
   `arch.md:54-61`. `grep -ri "contact\|calendar" .plans/s03.C-webmail-floor/` returns
   exactly **one** hit, `arch.md:18`, and it is the unrelated phrase _"A single module owns
   all protocol contact"_. The parent arc declares four realms — Email · Contacts ·
   Calendars · Files (`.plans/s03-webAccess/readme.md:19`) — and this slice builds two.
   **That gap is unit `022`**, which nobody owned before this ledger. The missing settings
   screen is `024`.
2. **`arch.md:57` plans the virtualized thread list on `Email/query` + `queryChanges`** —
   but `Email/queryChanges` is an always-throw stub (`email.ts:54`), matching the
   advertised `canCalculateChanges: false` (`email.ts:206`). T2 must build the re-query
   fallback or land unit `026`. See `026` for why the fallback is the better answer.
3. **T3 is a UI over a noun that does not exist** — `grep -r "file_nodes\|FileNode"`
   returns nothing. `011`/`s03.B` is a hard prerequisite. The blob plumbing beneath it is
   live: `/api/download` (`services/jmap/src/index.ts:70`), `/api/upload` (`:76`),
   `/api/share` (`:83`), `/api/ws` (`:89`).

## Open questions / where this could be wrong

1. **E4 is a floor, not an estimate.** `s03.C` calls itself "the largest slice"
   (`devPlan.md:73`), yet it, `022`, `023`, and `011` all carry the same grade while
   differing by an order of magnitude. The rubric loses resolution where the work is
   biggest.
2. **The `s03.A` dependency may be softer than stated.** A plain mail client renders fine
   without provenance columns. T1+T2 _could_ ship ahead of `s03.A` — at the cost of the
   retrofit `s03.A` exists to avoid (`s03.A/readme.md:17-18`).
