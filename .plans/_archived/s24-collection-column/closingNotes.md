---
plan: s24-collection-column
status: closed
closed_at: 2026-08-19
closing_pr: none        # docs-only; `.plans/**` lands direct on main. The build
                        # PRs were #171–#177; T6 closed via s25's #189.
acceptance: partial     # T0–T5 met; T6 met by another section; three clauses short
residues: 4
reversals: 2
---

# s24 — closing notes

s24 was pitched as a quad-panel shell and its own devPlan corrects that in the
first heading: **this is a consolidation, not an invention.** The fourth panel
already existed three times — `MailboxSidebar`, Contacts' `<aside class="sidebar">`,
and Approvals' stacked `HeaderGroup`s inside the header column — built three
different ways, agreeing on nothing. The sprint's real product is that there is
now one of them. What the devPlan could not know is which half would pay off.
The library (T0) was written as scaffolding for the quad; it is the piece that
outlived the sprint — `components/icons`, `components/ui` and `lib/ui` are what
five later realms compose, including three (Activity, Notes, Finder) that did not
exist when the plan named its seven. The quad itself needed a second sprint to be
usable on a phone, and got one the next morning.

Landed overnight 2026-08-17→18 as six squash merges, #171–#177, each visually
verified against production with a real session by the shipper. T6 never shipped
here and was not meant to: s25 superseded it, and #189 closed it.

## Acceptance ledger

T0 and T1 carry explicit **Done when** clauses; T2–T6 are stated as task
sentences, quoted verbatim below and marked as such rather than paraphrased into
criteria they never had.

| Done-when (verbatim) | verdict | evidence |
|---|---|---|
| T0: "the shell's inline `<svg>`s are replaced by `icons/*` components" | ✅ met | `webmail/src/components/icons/` — 23 glyph components + `base.tsx` + `index.ts`; `ShellNav.tsx` imports them (`MagnifyingGlassIcon` at `:804`, `XMarkIcon` at `:827`). #171 |
| T0: "a `CollectionColumn` can be assembled from `<Column>`/`<ListRow>`/icons" | ✅ met | `webmail/src/components/ui/` ships `Column.tsx`, `ListContainer.tsx`, `Button.tsx`, `IconButton.tsx`, `Badge.tsx`, `Avatar.tsx`, `SurfaceFrame.tsx`. #171 |
| T0: "every primitive has a pure class-logic test + a render-to-string test, all in plain Node" | ✅ met | `webmail/src/lib/ui/classes.ts` + `classes.test.ts` (pure); `components/ui/ui.test.tsx` and `components/icons/icons.test.tsx` (render-to-string); `preact-render-to-string` added at `webmail/package.json:21`. No jsdom. #171 |
| T1: "a surface can render `<CollectionColumn items={…} selectedId={…} onSelect={…}/>` and get a consistent, collapsible, keyboard-navigable picker" | ✅ met | `webmail/src/components/CollectionColumn.tsx:263`; selection model in `webmail/src/lib/shell/collections.ts`; arrow-key traversal at `CollectionColumn.tsx:306-311` via pure `stepSelection`. #172 |
| T2: "Swap that hand-rolled aside for `<CollectionColumn>` fed by the address books it already loads." | ✅ met | `webmail/src/components/ContactsApp.tsx:4,594` — the `<aside class="sidebar">` is gone. #173 |
| T3: "Replace `MailboxSidebar.tsx` with `<CollectionColumn>` fed by the mailbox tree." | ✅ met | `webmail/src/components/AppShell.tsx:40,800`; `MailboxSidebar.tsx` deleted in `ed84e1a`. #174 |
| T3: "**Drop the inline `style={{paddingLeft}}` tree indent** … it is the one live CSP-boundary violation" | ✅ met (the drop) / ⚠️ the *claim* was wrong | the file and its inline style are gone (`ed84e1a`). But it was never "the one" — see *What grew stale*. |
| T4: "Pull the stacked `HeaderGroup`s OUT of the header column into a `<CollectionColumn>` — but only the LIVE states" | ✅ met | `webmail/src/components/ApprovalsQueue.tsx:203-207,421` — Waiting on you / on the agent / Hold tray. #176 |
| T4: "**Also removes today's muted `Decided` HeaderGroup** from the live queue." | ✅ met | no `Decided` group remains; `ApprovalsQueue.tsx:190-192` states the reason at the source. #176 |
| T4: "under the three live states sit the saved views (Due soon, High cost, by agent, by realm; Decision 7)" | ❌ unmet (1 of 4) | `ApprovalsQueue.tsx:215` ships **only** `due-soon`; its own comment says "plus the first saved view". Carried forward. |
| T5: "One search input in `ShellNav`'s header that reads the active section and filters THAT realm's collection — placeholder, scope and syntax all keyed off the nav icon." | ✅ met, mechanism deviated | `ShellNav.tsx:76-97` (`SEARCHABLE`, per-realm placeholder + hint), `:800` dispatches `bm:search`. It never navigates — see Deviations. #177 |
| T5: "one contextual filter, **uniform across realms** (Ask included)" | ❌ unmet | `SEARCHABLE` covers 5 of the 11 realms in `webmail/src/lib/app/sections.ts` — mail, contacts, agents, notes, search. Approvals, Calendar, Activity, Goals, Files, Settings render no bar. #177's own body calls this "progressive absorption". Carried forward. |
| T5: "It absorbs the per-surface bars (`AppShell.tsx:549`, `SearchApp.tsx:142`, `ContactsApp.tsx` topbar), which then retire." | ✅ met | all three retired in #177; the mail topbar row survives only for the capability-gated Agents seam |
| T6: "On mobile the CollectionColumn collapses to a drawer/toggle … The four-column desktop layout degrades to a navigable stack." | ✅ met — **by s25** | `CollectionColumn.tsx:74` `narrow?: "stack" \| "hidden"`; `CollectionSheet.tsx` is the summoned picker. s25 T2, #189. See *Absorbed / donated*. |
| "**Agents, Files, Settings** are cheap follow-on adoptions once T0+T1 exist" | ⚠️ partial | Agents adopted (`AgentsApp.tsx:5,319`), and so did three realms the plan never named — Activity (`ActivityApp.tsx:18,223`), Notes (`NotesApp.tsx:22,292`), Finder (`FinderApp.tsx:32,361`). **Files and Settings did not**: `FilesApp.tsx` and `SettingsPanel.tsx` contain no reference to it. Carried forward. |

## Carried forward

| what | why it did not ship | owner |
|---|---|---|
| **Files and Settings never adopted `CollectionColumn`.** `FilesApp.tsx` still runs its own `.files-panes` picker; `SettingsPanel.tsx` has no collection column at all. | They were correctly scoped as follow-ons, not tasks — the sprint built the library and proved it on Contacts, Mail and Approvals. Four other realms then adopted it unprompted, which is the library paying off; these two simply never had a sprint pass through them. The cost of leaving them is that the consolidation is still 6-of-8, so "consistent" is not yet true of the app. | **`#225`** (label `residue`) |
| **T5's bar is uniform in mechanism, not in coverage** — 5 realms of 11 have one. | #177 chose progressive absorption over a bar that filters nothing: "no bar yet — progressive absorption, not a dead input". Defensible per realm, but the plan's own claim was *uniform everywhere*, and a rule with six exceptions is not the rule the plan sold. | **`#225`** (label `residue`) |
| **Three of Approvals' four saved views** — High cost, by agent, by realm. | T4 shipped the lifecycle (the load-bearing half of Decision 7) and one view. The other three each need a facet the row data does not carry cheaply; nothing decided against them. | **`#225`** (label `residue`) |
| **The mail LIST pane renders "Loading…" under the screenshot harness even with `?demo=1`**, while the same store path passes in Node. | s24 recorded it as "one open observation, NOT from this work (bisect-proven to pre-date it by 4+ days)" and asked for "one real-browser check" that nobody has done. Inherited, unresolved, and **not re-verified by this note** — it needs a browser, not a grep. It is the reason a screenshot pass can look green and prove nothing. | **`#225`** (label `residue`) — track with s25 phone-profile residue **`#226`** |

## Reachability

- **Deployed?** Yes — `webmail` is on the app plane and `https://app.bullmoose.cc/mail` serves (308 → `/mail/` → **200**, probe 2026-08-19).
- **Migration applied?** **None needed.** s24 touched no schema, no method, no worker: `webmail/src/components/**`, `webmail/src/lib/**`, page `<style>` blocks and `webmail.css` tokens only.
- **Switched on?** Yes, unconditionally — there is no flag. Every surface renders its `CollectionColumn` on load; the top-bar filter appears wherever `SEARCHABLE` has an entry and nowhere else, which is the only "switch" in the sprint and it is a source-level one.
- **Verified live?** **Partly, and not by this note.** Each of #171–#177 states it was visually verified against production with a real session — that is the shipper's claim, recorded here as such. What this note verified independently: the production `/mail/` document is served and carries the layout markers this arc's successor added (`100dvh`, `viewport-fit=cover`, the `72px` FAB clearance). s24's own chrome — the column, the bar — renders inside a `client:only` island and is **not** present in the served HTML, so it could not be confirmed from outside a browser.

## Authority-surface delta

**None.** s24 added no scope, no method, no route, no capability and moved no wall. Two adjacent notes, because they are easy to mistake for one:

- T5's bar **never navigates**. It dispatches a `bm:search` CustomEvent (`ShellNav.tsx:800`) rather than submitting, because a GET form serializes every named field into the query string — the exact shape `webmail/src/lib/app/tokenInUrl.test.ts` exists to refuse, and the generated CSP ships `form-action 'none'` besides (`webmail/astro.config.mjs:67`). That is an existing wall honoured, not a new one.
- T3 removed an inline `style` prop rather than adding one, keeping the class-swap discipline that lets `style-src` stay without `'unsafe-inline'`.

## Deviations from `devPlan.md` / `arch.md`

- **The bar filters by event, not by form.** The plan wrote T5 as "one search input … that reads the active section and filters THAT realm's collection", implicitly a form. The s07 T1 token invariant made a submitting form impossible, so #177 built a CustomEvent the active island consumes — and its own body argues the constraint improved the design: "the bar filters **where you stand**; going cross-realm is what the Search **realm** is for." Recorded because a reader of the devPlan would otherwise expect a `<form action>` that does not and must not exist.
- **T3b was not in the plan.** An unplanned visual-polish PR (#175) landed between T3 and T4: real Heroicons for mailbox roles because the text dingbats rendered as tofu, and `self-stretch` so columns fill the frame. Both defects were invisible to every test and visible in the first screenshot.
- **The realm roster the library actually serves is not the roster the plan named.** The IA names seven quad realms and calls out Agents/Files/Settings as the cheap follow-ons. What happened: Agents adopted, Files and Settings did not, and Activity, Notes and Finder — none of them in the plan — did. The library generalised further and less predictably than its own spec.
- **Approvals' `?c=` deep-link is s25's, layered onto T4's collection.** `ApprovalsQueue.tsx:195-198` validates `?c=` against the known collection ids so a mistyped tray link degrades to the default. Reading T4 alone will not explain that code.

## Reversals

- **s07 T4's four-status Approvals queue is deliberately overturned.** `Decided` is removed from the live queue (Decision 7, #176). Do not restore it as a bug: the principle is *the active UI shows what is LIVE; history is a realm, not a section*, and the retrospective belongs to **s23 Activity**. `ApprovalsQueue.tsx:190-192` and `:418` both carry the reason at the point of the code, so a future reader hits it before the diff does.
- **The per-surface search bars are overturned, not merely moved.** `AppShell`'s topbar form, `SearchApp`'s header form and `ContactsApp`'s topbar are gone by design (#177). A surface that grows its own bar again is re-opening a settled decision, not filling a gap.
- **Decision 2 forecloses a "search everything" box.** It was rejected on the record: cross-realm *finding* is Finder's job, its own realm, not a mode of the bar.

## Absorbed / donated

- **Donated to s25 — and finished there.** **T6 (responsive) was closed by s25's PR #189**, via `CollectionTree`'s `narrow` prop (`CollectionColumn.tsx:74`) and the new `CollectionSheet.tsx`. s25's devPlan states the takeover in its own header — "This sprint SUPERSEDES s24 T6 (responsive) entirely" — and s24's T6 heading was updated to point back ("✅ LANDED via s25 T2 (#189)"). Recorded in both files, per the archive rule; without it s24 reads incomplete forever and s25 gets no credit for finishing someone else's task.
- **Also donated to s25:** the whole substrate. `CollectionColumn`, `lib/shell/collections.ts`, the `ui`/`icons` library and the standardized [New] button are what s25 T2/T5 re-render as a bottom sheet and a FAB. `CreateFab.tsx` takes `CollectionColumn`'s own `newLabel`/`onNew`/`newDisabled` props precisely so the verb cannot drift between the two — one label source, not two.
- **Absorbed from s07** (`#166`/`#167`/`#168`): the shell this sprint was specced against — `ShellNav.tsx`, `AppTw.astro`, the `frame` knob, and the token invariant that reshaped T5.
- **Absorbed from `webmail/referenceTemplates/tailwindcss.com/`**: markup and Tailwind classes for every piece, per the standing provenance rule, with interactivity hand-rolled in Preact because `@headlessui/react` sets inline `style` attributes and would force `'unsafe-inline'` into `style-src`.
- **Absorbed from s23 and s20 as forward references**: Activity as the home for decided history, and Finder (né Ask) as a realm the bar treats like any other.

## What grew stale during the build

- **"the one live CSP-boundary violation" was not one.** T3 says `MailboxSidebar.tsx:35`'s inline indent was the single instance. `webmail/src/components/CalendarView.tsx` — shipped `ee503fc`, 2026-08-10, seven days earlier — carries five `style={{…}}` props (`:406,541,575,591,601`) and s24 left them untouched. Calendar is s24's declared exception realm, so they were never in scope; the claim was simply narrower than its wording. (These are Preact object-style props on a `client:only` island, so they are set through CSSOM rather than emitted as `style` attributes; **this note did not establish that they are blocked at runtime**, only that the "one violation" count was wrong.)
- **The devPlan's "Remaining: T6 … and the follow-on realm adoptions (Files, Settings, Agents)" was true for about eighteen hours.** T6 closed the next morning (#189) and Agents adopted in s26. Files and Settings are the part that stayed true, which is why they are the residue above rather than a footnote.
- **`ContactsApp.tsx:562` / `ApprovalsQueue.tsx:334` / `ApprovalsQueue.tsx:345-370` / `ShellNav.tsx:507-604`, cited in the plan, are all stale line numbers** — every one of those files was rewritten by the sprint that cited them. sVOL's post-mortem made exactly this point about `_index.md:NN` references; s24 reproduced it within one sprint of it being written down.
- **`AppTw.astro:75-76`'s `h-[calc(100vh-4rem)]`, which T5 was warned to mind, is now `100dvh`** (`AppTw.astro:80`, s25 T1). The warning survives in the plan text; the code it points at does not.

## Traps for the next section

- **A test suite that passes per-component can still miss the bug.** #205 is the cleanest instance in the repo: every assertion about the column's [New] button passed, every assertion about the FAB passed, and a phone showed both. The defect existed only in the *relationship* between two components at one viewport, which no unit test frames. If a change has a responsive dimension, the screenshot step is not decoration.
- **Build the library first and it will get used somewhere you did not plan.** T0 was justified as scaffolding for T1–T5 and its actual return is four unplanned adoptions. The corollary: name the follow-ons in the plan anyway — the two that got named and skipped (Files, Settings) are visible as a residue, whereas an unnamed one is invisible.
- **Cite section numbers, not line numbers, in a file you expect to grow.** Every `file:line` in this devPlan pointing into a file the sprint itself rewrote is now wrong. It costs nothing at write time and it is unrecoverable later.
- **When a security invariant blocks the obvious implementation, check whether it is improving the design before routing around it.** The token invariant made T5's form impossible and produced a better bar. The reflex to reach for an exception is usually the more expensive path.
