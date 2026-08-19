---
plan: s25-mobile
status: closed
closed_at: 2026-08-19
closing_pr: none        # docs-only; `.plans/**` lands direct on main. The build
                        # PRs were #189, #194, #200, with #204 and #205 as fixes.
acceptance: partial     # all six tasks landed; two clauses inside them did not
residues: 2
reversals: 2
---

# s25 — closing notes

s25 opened the morning after s24's quad landed, on one observation from Eric —
the collection column "uses real-estate poorly on mobile" — and turned it into a
principle the whole app now obeys: **hierarchy is a MAP, not a JOURNEY.** The
five-level tree stays exactly as it is; what changes is that only two of its
levels are *screens* (List ⇄ Detail) and the rest are *pickers you summon*. That
reframing is the sprint's actual output. It is why there is a bottom sheet and a
realm tray instead of a NavStack, why the back button works without a single new
history call, and why nothing here added a screen.

All six tasks landed inside one day — #189 (T1+T2), #194 (T3+T4), #200 (T5+T6) —
with two follow-ups the next hour: #204 added the Finder's FAB clearance that
#200 had flagged and left in another agent's file, and #205 fixed a duplicate
create affordance that only existed at one viewport. What the plan could not know
is that its own acknowledged cost — the publish contract — would be the part that
stopped one step short: the plumbing is built, tested and honest about staleness,
and only three surfaces ever plugged into it.

## Acceptance ledger

s25's tasks are stated as prose with landing notes, not `Done when:` blocks. The
clauses below are quoted verbatim from the task bodies and from the plumbing
contract section.

| Done-when (verbatim) | verdict | evidence |
|---|---|---|
| T1: "`100vh` → `dvh` in the `frame="surface"` calc (the mobile-Safari dancing-toolbar bug)" | ✅ met | `webmail/src/layouts/AppTw.astro:80` — `h-[calc(100dvh-4rem)]`; `webmail/src/styles/webmail.css:1115-1117` gives `.help-card` the same with a `vh` fallback. Live: `100dvh` present in the served `app.bullmoose.cc/mail/` document (probe, 2026-08-19). #189 |
| T1: "`env(safe-area-inset-*)` for bottom chrome" | ✅ met | viewport meta gains `viewport-fit=cover` (`AppTw.astro:89`, and confirmed in the served document); `CollectionSheet.tsx:101` pads `pb-[env(safe-area-inset-bottom)]`; `lib/ui/classes.ts:125` does the same for the FAB. #189 |
| T1: "a responsive audit of the five landed surfaces" | ✅ met | #189 audits Mail, Contacts, Approvals, Agents and Activity at 390 px with a per-surface findings table, fixing egregious overflow and naming the rest as T3–T4 material. (Note the five are not the five you might guess: **Files was not audited**, which is why sVOL `021`'s visual-confirmation residue survives.) |
| T1: "the harness gains a PHONE profile (390×844, `mobile: true` via the existing `Emulation.setDeviceMetricsOverride`) so every PR screenshots desktop AND phone" | ❌ unmet | `infra/shots.mjs:73` still declares one viewport, `{ width: 1440, height: 900 }`; there is no `setDeviceMetricsOverride` call anywhere in the repo. #189 says so plainly: "The phone screenshot profile for the harness is handled outside this repo (per the task split)." Carried forward. |
| T2: "`lib/shell/collections.ts` grows one level of nesting (`CollectionItem.children?`, expanded state) plus `disabled?/reason?`" | ✅ met | `webmail/src/lib/shell/collections.ts:32` (`children?`), `:39` (`disabled?`), `:41` (`reason?`), with `toggleExpansion` pure alongside. #189 |
| T2: "the desktop CollectionColumn learns inline expand; the **collection sheet** (new …); the list header gains the tappable title that summons it" | ✅ met | `CollectionColumn.tsx:74` `narrow?: "stack" \| "hidden"`; `webmail/src/components/CollectionSheet.tsx` (hand-rolled, class-swap animation, no `@headlessui`); summoned from the list title, e.g. `ApprovalsQueue.tsx:237-240`. #189 |
| T3: "`/mail?thread=…`, `/contacts?card=…`, `/approvals?p=…` as links, read at mount" | ✅ met | `AppShell.tsx:484` `urlParam("thread")`, `ContactsApp.tsx:121` `urlParam("card")`, `ApprovalsQueue.tsx:188` `urlParam("p")`, plus `ActivityApp.tsx:60` `urlParam("a")` — one more than the task named. #194 |
| T3: "the app makes exactly ONE history call (tokenInUrl.test.ts) — this adds zero" | ✅ met | #194: nothing new calls `location.assign`, `pushState`, or writes `location.href`; the `tokenInUrl` sweep passes unchanged over the grown surface. MPA anchors are not history calls. |
| T4: "on load, a surface writes `{realm, items:[{id,label,count,href}], at}` to a `bm.collections.<realm>` localStorage key (and dispatches `bm:collections`)" | ✅ met | `webmail/src/lib/shell/publish.ts:57` `publishCollections`, `:44` `COLLECTIONS_EVENT`; `readPublished` validates hrefs as same-origin paths so a poisoned localStorage cannot turn the tray into an off-origin launcher. #194 |
| T4: "The tray renders what is published, greys what is stale/absent" + "counts carry `at` and the tray may say 'as of 9:12'" | ✅ met | `RealmTray` at `ShellNav.tsx:285`, fed at `:467`; `publish.ts:47` `STALE_AFTER_MS = 10 * 60 * 1000`; stale counts render muted with the wall clock spelled out. #194 |
| T4: "each realm row expands its top collections inline … so one tap reaches Mail→Sent from anywhere" | ❌ unmet for most realms | only three surfaces publish: `AppShell.tsx:215` (mail), `ApprovalsQueue.tsx:263` (approvals), `ContactsApp.tsx:208` (contacts). **3 of the 8 realms in `sections.ts` at the time of this sprint; 3 of 11 today.** Everything else renders a plain row with no leaf-nodes. Carried forward. |
| T5: "The standardized [New] becomes a floating action button (bottom-right, safe-area aware, realm-contextual) on narrow screens" | ✅ met | `webmail/src/components/CreateFab.tsx:45`; `lib/ui/classes.ts:122-131` — fixed bottom-right, `mb-[env(safe-area-inset-bottom)]`, `lg:hidden`. Rendered from `CollectionColumn.tsx:319` off the column's own `newLabel`/`onNew`/`newDisabled`, so the verb and the permission verdict cannot drift. #200 |
| T5: "the top-bar search collapses to an icon that expands full-width (the `bm:search` plumbing is untouched)" | ✅ met | `ShellNav.tsx:772-830` — the trigger below `lg`, the field expanding in place, an X to return (phones have no Escape). Same `<form>`, same `id="bm-global-search"`, same `bm:search` event. #200 |
| T5 (implied, and the reason for two follow-ups): one create affordance per viewport | ✅ met, **after two fixes** | #200 shipped the FAB `lg:hidden` but left the column's header button visible below `lg`, so a phone showed both; `#205` added `max-lg:hidden` to the header button and renders the realm title there instead (`CollectionColumn.tsx:332,339`). `#204` added the `FAB_CLEARANCE_PX` line to `search.astro` (`:333`) that #200 had flagged and left alone. |
| T6: "Swipe-to-archive/trash on mail rows." | ✅ met | `webmail/src/lib/ui/swipe.ts` (pure; axis decided once at `AXIS_SLOP = 10`, `:42`), consumed by `ThreadListView.tsx:10-15`; real Undo via the recorded inverse patch, `webmail/src/lib/mail/undo.ts:32`. #200 |
| T6: "**REFUSED for Approvals**: a decision queue's ethos is deliberateness, and a flick that fires a tier-2 send is the wrong affordance." | ✅ met (as a refusal) | `ApprovalsQueue.tsx` contains no occurrence of `swipe`. The refusal is named in the plan so it cannot creep back in as an oversight. |

## Carried forward

| what | why it did not ship | owner |
|---|---|---|
| **The realm tray is 3/8 wired.** Only Mail, Approvals and Contacts call `publishCollections` (`AppShell.tsx:215`, `ApprovalsQueue.tsx:263`, `ContactsApp.tsx:208`). Notes, Activity, Agents, Finder and Files publish nothing, so their tray rows have no leaf-nodes; Goals, added later, makes it 3 of 11 today. | The plan calls this out as "acknowledged cost #1" and sequences it honestly — "v1 tray ships with plain realm rows; leaf-nodes land the moment the contract does" — but the contract landing and every surface adopting it are two different events, and only the first happened. `publish.ts` treats absence as legitimate ("a realm that never published renders as a plain row — absence is not an error"), which is good behaviour and also the reason nothing complains. **This is the sprint's headline gap and it is recorded nowhere else.** | **`#226`** (label `residue`) |
| **The 390×844 PHONE screenshot profile never landed in this repo.** `infra/shots.mjs:73` is desktop-only. | Split out of #189 to another lane ("handled outside this repo, per the task split") and never came back. The cost is exactly the class of bug #205 turned out to be: a defect that exists only in the relationship between two components at one viewport, invisible to every unit test and to a 1440×900 screenshot. #205 was found by a human on a real phone profile, not by the harness. | **`#226`** (label `residue`) — track with s24 harness residue **`#225`** |

## Reachability

- **Deployed?** Yes — the app plane. `https://app.bullmoose.cc/mail` → 308 → `/mail/` → **200** (probe, 2026-08-19).
- **Migration applied?** **None needed.** s25 touched no schema, no method, no worker — `webmail/src/**`, page `<style>` blocks, and `AppTw.astro`'s viewport meta. Its one piece of state is `localStorage`, which is per-browser and disposable by design: `publishCollections` fails soft in private mode, and a mis-shaped or hand-edited record is validated item-by-item with bad rows dropped rather than blanking the tray (`publish.ts:75-…`).
- **Switched on?** Yes, unconditionally — there are no flags. Everything is a Tailwind breakpoint: the FAB is `lg:hidden` (`lib/ui/classes.ts:130`), the header [New] is `max-lg:hidden` (`CollectionColumn.tsx:332`), the search trigger and the tray flip at the same line. **The `lg` breakpoint is this sprint's only switch**, and #205 is what happens when the two halves of one rule are set on different components in different PRs.
- **Verified live?** **Partly, and honestly.** Independently verified by this note against production: the served `/mail/` document carries `100dvh`, `viewport-fit=cover`, `safe-area-inset` and the `72px` FAB clearance padding (probe, 2026-08-19) — so T1 and T5's clearance rule are demonstrably live. **Not verified**: the tray, the sheet, the FAB and swipe all render inside `client:only` islands and are absent from the served HTML; confirming them needs a real browser at 390 px, which is precisely the harness capability that did not ship. #205's landing note records a human doing that pass once, on a real 390×844 profile, the day it merged.

## Authority-surface delta

**None.** No scope, method, route or capability. Three notes on walls that were *held*, since a mobile sprint is where they are most tempting to move:

- **The one-history-call invariant survived a navigation redesign.** T3 turned List→Detail into real navigation without adding a single history call, because MPA anchors are not history calls (#194). `webmail/src/lib/app/tokenInUrl.test.ts` passes unchanged over every grown surface.
- **The publish contract carries an authorization-shaped guard even though it carries no authority.** `readPublished` requires each `href` to be a same-origin path — never `//…`, never `javascript:`, never an absolute URL — so a poisoned `localStorage` cannot turn the chrome into an off-origin launcher (`publish.ts:26-30`). Treating browser-local storage as untrusted input is the right instinct and is cheap here.
- **CSP held throughout.** Sheet and tray animate by class swap; no inline `style`, no navigating form, no new inline script.

## Deviations from `devPlan.md` / `arch.md`

- **The tray's rows are anchors, not the `CollectionTree` component.** The plan says the tray renders "the T2 tree rendering again". #194 deliberately did **not** reuse `CollectionTree`: its rows are `onSelect` buttons, and the tray's rows must be literal `<a href>` so navigation stays MPA and stays inside the token sweep's literal-path rule. The idiom is shared (`toggleExpansion` is reused pure); the component is not.
- **Activity got a detail param the task never asked for.** `ActivityApp.tsx:60` reads `?a=`, listed in #194 as "param only, per the task split" — the links themselves live elsewhere.
- **Mail's keyboard triage deliberately does not use the new URLs.** j/k + Enter stays in-page via `openThread(threadId)`, because a full reload mid-triage would be wrong. The URL is the *click* path only. Documented at both ends in #194 and worth knowing before "fixing" the inconsistency.
- **T5 arrived in three PRs, not one.** #200 shipped it, #204 completed the Finder's clearance line, #205 fixed the duplicate affordance. Both follow-ups were caused by file ownership during a parallel fleet run rather than by the design — see *Traps*.
- **Decisions 4 and 5 were resolved by the build and never written down.** 4 ("Sheet vs tray redundancy — keep both, or sheet-only?") shipped as **both**, per its own recommendation; the "measure taps later" half was never done and has no consequence attached, so it is a preference rather than an open thread. 5 ("Does Approvals' Due-soon view surface in the sheet's tree or as a chip?") shipped as **tree** — `ApprovalsQueue.tsx:215` puts `due-soon` in a `Views` group inside the same collection model the sheet renders. Both read as open in the plan and are closed in the code, which is the drift sVOL's post-mortem named.
- **The plan's "nine realms the tray carries" was already off by two when written.** It lists Approvals, Files, Calendar, Contacts, Mail, Agents, Activity, Finder, Settings; `sections.ts` at commit `7e6f43b` held eight (no Activity), and holds eleven today (Activity, Notes, Goals). The tray reads `sections.ts`, so it has always carried whatever is there — the roster in the prose is the thing that drifts.

## Reversals

- **s24 T6 is superseded outright**, by name: "This sprint SUPERSEDES s24 T6 (responsive) entirely." The narrow-screen answer is not a drawer version of the desktop column; it is a different mechanism — a summoned sheet with zero stack depth. Do not restore a CollectionColumn drawer as a missing feature.
- **Two mobile-nav patterns are rejected on the record** (Decision 2): horizontal-scroll realm chips, because "realms are mode switches, not filters, and a scroll row hides half of nine"; and a 9-realm tab bar. Both are the obvious thing to reach for; both were considered and refused.
- **Search/Ask is renamed Finder** (Decision 3), Eric's call. The section id stays `search` (`sections.ts:192`) with the label `Finder` — so a grep for the old name still hits, and that is deliberate rather than an unfinished rename.

## Absorbed / donated

- **Absorbed from s24, and finished for it: T6.** s24's T6 (responsive) was closed here by **#189**, via `CollectionColumn`'s `narrow` prop and the new `CollectionSheet`. s24's devPlan carries the matching note ("✅ LANDED via s25 T2 (#189)") and s24's closing note records the donation from the other side. Recorded in both files, per the archive rule.
- **Absorbed from s24 more broadly:** the entire substrate — `CollectionColumn`, `lib/shell/collections.ts`, the `components/ui` + `components/icons` library, the standardized [New] button, and the `bm:search` bar that T5 collapses. The FAB is not a new affordance: it renders from `CollectionColumn`'s own props (`CollectionColumn.tsx:319`) precisely so "one label source, no FAB where a realm has no [New]" holds by construction.
- **Absorbed from s07:** the `sections.ts` planned-section idiom (disabled with a visible reason), extended in T2 to collection items so the sheet never shows a dead row.
- **Absorbed from `webmail/referenceTemplates/tailwindcss.com/`:** `navigation/command-palettes/*` and the dialog markup seeded the sheet; interactivity hand-rolled, per the standing rule.
- **Received from other lanes, after the fact:** **#204** (Finder's FAB clearance, landed alongside unrelated BYOK work) and **#205** (one create affordance per viewport). Neither is an s25 PR by title; both are s25 work, and this is their only record inside the plan.
- **Donated onward:** the `dvh` / safe-area / `viewport-fit=cover` foundation and the `FAB_CLEARANCE_PX` idiom (`lib/ui/classes.ts:142`) are now the app-wide baseline, inherited by every surface added since without a line of its own.

## What grew stale during the build

- **"v1 tray ships with plain realm rows; leaf-nodes land the moment the contract does" reads as a sequencing note and became the finished state.** The contract landed the same day. Five realms' leaf-nodes did not, and nothing in the plan says so.
- **The plan's realm roster.** Nine named; eight existed at the time; eleven exist now. Notes and Goals were never in the prose and have been in the tray since they shipped.
- **"the harness gains a PHONE profile" is the one clause in this plan that reads as done and is not.** It sits inside a T1 marked ✅ LANDED, which is exactly how an unmet clause disappears — the task is green, the sentence inside it is false, and only #189's body records the split.
- **`ShellNav.tsx:377-407`, cited by s24's T6 as the drawer to mirror, no longer means what it did** — this sprint rewrote that region into the tray.
- **The s24 devPlan reference in "References" now points into `.plans/_archived/`.** Both plans moved on 2026-08-19 (`7759b31`).

## Traps for the next section

- **A one-way contract is two pieces of work, and only the first one is visible.** Building `publish.ts` felt like completing T4; wiring eight surfaces to it is the other half, and because absence is handled gracefully — plain rows, no error, no warning — the unfinished half produces no signal at all. If you build a contract, count the adopters in the acceptance clause, not the contract.
- **Set both halves of a responsive rule in the same change.** #200 put `lg:hidden` on the FAB and left the column's header button unqualified; the result was two create buttons on a phone, with every test green. `hidden`/`visible` rules are relational; write them as a pair or you will find the other half by screenshot.
- **Never use a bare `hidden` against a bare `flex`.** Two unvariant display utilities resolve by Tailwind's source order, not by the order you typed them. #200 verified its own variants against the *built* stylesheet rather than the source — the only check that actually answers the question.
- **A parallel fleet run leaves single-line residues at file boundaries.** Both #204 and #205 exist because a one-line fix belonged to a file another agent held that hour. Flagging it in the PR body worked — but only because someone read the PR body. If a change is blocked purely by file ownership, it needs a home outside the prose.
- **A screenshot harness that only knows one viewport is a harness that certifies desktop.** The bug it would have caught shipped, and a human on a real phone found it hours later.
