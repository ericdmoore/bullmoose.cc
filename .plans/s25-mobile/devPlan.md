# s25 — mobile: screens vs pickers (the quad on a phone)

> Kicked off 2026-08-18, the morning after s24 T0–T5 landed. Eric: the quad "uses real-estate
> poorly on mobile — the collection column wants to be smaller (and at the top)". This sprint
> SUPERSEDES s24 T6 (responsive) entirely. Search/Ask is renamed **Finder** here (Eric).

## The principle: hierarchy is a MAP, not a JOURNEY

The four panels are one hierarchy — Realm → Category → SubCategory → List-item → Detail — and on
desktop it renders as a spatial map. The mobile trap is walking that map as a NavStack (five
screens deep; every "check my approvals" is 3–4 taps down and back). Mobile mail apps that feel
fast (iOS Mail, Gmail) have the same hierarchy but you **land at the list and dwell**; the levels
above are **pickers you summon**, not screens you traverse:

```
SCREENS (the NavStack — exactly 2 deep):
  List ⇄ Detail                      ← the back button lives here, and ONLY here

PICKERS (summoned, never traversed):
  Realm tray        = Realm + Category MERGED (Eric's favourite: categories are
                      bounded and small, so the tray can carry them)
  Collection sheet  = Category + SubCategory MERGED (the tree, as a bottom sheet)
```

- **Land in the list.** `/mail` opens Inbox's list; `/approvals` opens Waiting-on-you. The
  default Category is pre-picked; zero taps to the thing you came for ("you arrive to decide" —
  s07, applied to small screens).
- **Within-realm switching** (Inbox→Sent, Waiting→Hold): tap the list's title → the **collection
  sheet** slides up from the bottom (the thumb zone) with the full tree — expandable nodes
  ("by agent ▸" → the agents), counts, and empties **greyed out with a visible reason** (the
  `sections.ts` planned-section idiom, extended to collection items — never a dead row).
- **Cross-realm jumps:** the **realm tray** — and it GROWS LEAF-NODES (Eric): each realm row
  expands its top collections inline (`Mail ▸ Inbox 12 · Drafts · Sent`, `Approvals ▸ Waiting 3 ·
  Hold 1`), so one tap reaches Mail→Sent from anywhere. This is the Gmail-drawer pattern; it is
  Eric's "merge Realm + Category" made real. Horizontal-scroll realm chips are REJECTED: realms
  are mode switches, not filters, and a scroll row hides half of nine.

The nine realms the tray carries: Approvals, Files, Calendar, Contacts, Mail, Agents, Activity
(s23), **Finder** (né Search/Ask), Settings. **Calendar stays the exception** (its "list" is the
time grid; it rides the tray, skips the sheet). Settings rides the tray, skips the sheet.

## The plumbing contract (acknowledged cost #1)

The tray is CHROME (ShellNav); collections live in the surface islands. For leaf-nodes the
surfaces must PUBLISH their collections — a small one-way contract, the `bm:search` spirit
reversed: on load, a surface writes `{realm, items:[{id,label,count,href}], at}` to a
`bm.collections.<realm>` localStorage key (and dispatches `bm:collections` for live update). The
tray renders what is published, greys what is stale/absent. v1 tray ships with plain realm rows;
leaf-nodes land the moment the contract does. Staleness is honest: counts carry `at` and the tray
may say "as of 9:12".

## Tasks

### T1 — platform foundation · *the unglamorous bugs first* — ✅ LANDED 2026-08-18 (#189)
`100vh` → `dvh` in the `frame="surface"` calc (the mobile-Safari dancing-toolbar bug),
`env(safe-area-inset-*)` for bottom chrome, a responsive audit of the five landed surfaces, and
the harness gains a PHONE profile (390×844, `mobile: true` via the existing
`Emulation.setDeviceMetricsOverride`) so every PR screenshots desktop AND phone.

### T2 — the tree model, one source three renderings — ✅ LANDED 2026-08-18 (#189)
`lib/shell/collections.ts` grows one level of nesting (`CollectionItem.children?`, expanded
state) plus `disabled?/reason?` (the planned-section idiom). Renderings: the desktop
CollectionColumn learns inline expand; the **collection sheet** (new, from
`navigation/command-palettes` + dialog markup, hand-rolled interactivity, class-swap animations —
CSP holds); the list header gains the tappable title that summons it.

### T3 — drill-in detail URLs, the native back button — ✅ LANDED 2026-08-18 (#194)
List→Detail becomes REAL NAVIGATION: `/mail?thread=…`, `/contacts?card=…`, `/approvals?p=…` as
links, read at mount. The browser back button just works — the make-or-break mobile gesture — and
every detail becomes deep-linkable. NOTE the invariant: the app makes exactly ONE history call
(tokenInUrl.test.ts) — this adds zero; MPA links are not history calls. Desktop keeps the
side-by-side panels (the param selects; the layout decides by width).

### T4 — the realm tray + leaf-nodes — ✅ LANDED 2026-08-18 (#194: `lib/shell/publish.ts` contract + RealmTray)
The mobile drawer becomes the tray: realm rows (from `sections.ts`) that expand published
collections inline (the T2 tree rendering again). Ships in two steps: tray with plain rows, then
leaf-nodes over the plumbing contract above.

### T5 — the contextual [New] as a FAB + search collapse — ✅ LANDED 2026-08-18 (#200: the FAB is CollectionColumn's own button relocated — one label source, no FAB where a realm has no [New]; clearance via scroll-container padding, not z-index. Finder's clearance line followed in #204.)
The standardized [New] becomes a floating action button (bottom-right, safe-area aware,
realm-contextual as always) on narrow screens; the top-bar search collapses to an icon that
expands full-width (the `bm:search` plumbing is untouched).

### T6 — swipe triage · *mail only, deliberately — stretch* — ✅ LANDED 2026-08-18 (#200: swipe reveals, never commits; axis decided once at 10px; the trailing click cancelled in the capture phase on the row shell so #194's anchors still tap through; real Undo via the recorded inverse patch.)
Swipe-to-archive/trash on mail rows. **REFUSED for Approvals**: a decision queue's ethos is
deliberateness, and a flick that fires a tier-2 send is the wrong affordance. Named here so it
does not creep in later.

## Sequencing

```
T1 foundation ── T2 tree+sheet ──┬── T3 detail URLs ── T4 tray(+leaves) ── T5 FAB/search ── T6 swipe
                                 └── (desktop inline-expand rides T2)
```

## Decisions
1. ~~NavStack depth?~~ **RESOLVED (Eric + this plan): screens are List⇄Detail only; Realm+Category
   merge into the tray, Category+SubCategory into the sheet.**
2. ~~Realm nav form?~~ **RESOLVED: the collapsible tray with leaf-nodes; horizontal scroll
   rejected; a 9-realm tab bar rejected.**
3. ~~Search/Ask name?~~ **RESOLVED: Finder.** (Rename lands with the nav copy in T4.)
4. **Sheet vs tray redundancy** — both can reach a sibling collection. Keep both (sheet = fast
   within-realm, tray = cross-realm) or sheet-only? *Recommendation: both; measure taps later.*
5. **Does Approvals' Due-soon view surface in the sheet's tree or as a chip?** *Recommendation:
   tree — chips died with Decision 2's spirit (one mechanism, not two).*

## References
- `.plans/s24-collection-column/devPlan.md` — the desktop quad this makes mobile; T6 superseded here
- `webmail/src/components/{ShellNav,CollectionColumn}.tsx`, `lib/shell/collections.ts`
- `webmail/referenceTemplates/tailwindcss.com/html/navigation/command-palettes/*`,
  `application-shells/*` — the seeds, per the s24 provenance rule
- `tokenInUrl.test.ts` — the one-history-call + no-navigating-form invariants T3/T5 must honour
