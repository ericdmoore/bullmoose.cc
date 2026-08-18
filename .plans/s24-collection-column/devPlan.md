# s24 — the Collection column (the fourth panel), and the global search bar

> Eric, reading contacts + mail + approvals together: "these need a quadruple-panel shell —
> `NavSidebar → CollectionColumn → HeaderColumn → DetailPanel`", and "search should get bumped up
> to the top-most bar." Spec written 2026-08-17 against the shell the s07 rewrite just landed
> (`ShellNav.tsx`, `AppTw.astro`, PRs #166/#167/#168).

## The insight: this is a CONSOLIDATION, not an invention

The fourth panel already exists — **three times, built three different ways** — and no two agree:

| Surface | Its CollectionColumn today | HeaderColumn | Detail |
|---|---|---|---|
| **Mail** (`AppShell.tsx`) | `MailboxSidebar` — `.sidebar`, the folder tree | `.content` view-swap (list) | `.content` (thread) |
| **Contacts** (`ContactsApp.tsx:562`) | `<aside class="sidebar">` — `.book-list`, the address books | `.card-list` | `.card-detail` |
| **Approvals** (`ApprovalsQueue.tsx:334`) | *none* — the four status groups are stacked **inside** the header column | `.apq-panes` col A (`HeaderGroup`s) | col B |
| **Files** (`FilesApp.tsx`) | `.files-panes` picker | list | detail |

The shell itself (`AppTw.astro:101-111`) provides **exactly one column — the nav rail** — and a single `<slot>`; every surface hand-rolls the rest inside its own island. So Eric's four-panel shell is really: **take the collection-picker that each surface already has, and make it one shared, consistent thing** — then add the one piece genuinely missing everywhere, a global search bar.

## The shape

```
┌─────────┬──────────────┬───────────────┬──────────────────┐
│ Nav     │ Collection   │ Header        │ Detail           │
│ rail    │ (NEW/shared) │ (list)        │ (panel)          │
│ =shell  │              │               │                  │
│ chrome  │  what subset │  items in it  │  the selected    │
│         │  am I in?    │               │  item            │
└─────────┴──────────────┴───────────────┴──────────────────┘
   ShellNav   CollectionColumn   HeaderColumn      DetailPanel
```

| Surface | CollectionColumn holds |
|---|---|
| **Mail** | Inbox / folders / tags / saved searches |
| **Contacts** | All contacts / address books / groups |
| **Approvals** | Waiting on you / on the agent / Hold tray / Decided (today's `HeaderGroup`s, promoted out) |
| **Files** | folders / roots |
| **Calendar** | calendars (when it grows one) |

## The architecture decision — a shared component, not a shell-hoisted column

**Recommendation: a shared `<CollectionColumn>` component that each surface renders as its FIRST
interior column, fed by that surface's own collection data. NOT a column hoisted into `AppTw.astro`
chrome.** Reasoning, and it is the load-bearing decision:

- **Data locality.** Each island already fetches its own collections (Mail folders, Contacts books,
  Approvals proposals). A shell-level column would need every surface to *report* its collections up
  across the island boundary — a cross-island contract for no visual gain.
- **Incremental + parallel-safe.** The s07 surfaces deliberately keep their layout CSS in per-page
  `<style is:global>` blocks "so this section can land without touching a file a parallel task is
  editing" (`contacts.astro`, `approvals.astro`). A shared *component* honours that — convert one
  surface at a time; a shell-level *refactor* is a big-bang that collides with whoever owns the shell.
- **It still produces the four-column visual.** The rail is column one (shell chrome); the surface
  owns columns 2–4. That is exactly today's chrome/interior boundary (`AppTw.astro:34-41`), unchanged.

The consistency Eric wants comes from **one component + shared tokens**, not from one DOM location.

## The global search bar

There is **no global search today** — Mail, Contacts, and the `/search` surface each hand-roll their
own `.topbar > .search` form, and `ShellNav`'s header (`ShellNav.tsx:507-604`) holds only the avatar
menu. That header is the home:

- **One search input in the ShellNav header, on every surface**, submitting to the existing `/search`
  cross-realm fanout (`SearchApp.tsx` already deep-links `?q=`). This retires the redundant
  per-surface cross-realm bars (`AppShell.tsx:549`, `SearchApp.tsx:142`, `ContactsApp.tsx` topbar).
- **Scoped power-syntax stays in-surface.** Mail's `from:/to:/is:unread` filter is a different verb —
  *filter this list*, not *find across everything* — so it stays as an in-surface control (a filter
  on the header column, or in the CollectionColumn). v1: the global bar is for cross-realm FIND;
  scoped filtering does not move. (Decision 2.)
- **Watch the header height.** `AppTw.astro:75-76` hardcodes `h-16` / `4rem`; the `frame="surface"`
  calc (`h-[calc(100vh-4rem)]`) depends on it. A taller bar updates both.

## Tasks

### T1 — the shared `<CollectionColumn>` component · *the substrate*

**Files:** `webmail/src/components/CollectionColumn.tsx` (new), a pure `lib/shell/collections.ts`
(the selection model — active item, counts), CSS tokens in `webmail.css` (shared, not per-page, since
this one IS shared).

A Preact component taking `items: CollectionItem[]` (`{id, label, count?, icon?, tone?}`), a
`selectedId`, and `onSelect`. Collapsible and width-resizable **via discrete class-swap, never inline
`style`** — the CSP carries no `'unsafe-inline'` in `style-src` (`ShellNav.tsx:14-21`), which is why
the rail resizes by swapping Tailwind width classes (`ShellNav.tsx:47-55, 357-362`); this follows the
same pattern. Selection logic is pure and tested; the component is markup.

**Done when:** a surface can render `<CollectionColumn items={…} selectedId={…} onSelect={…}/>` and
get a consistent, collapsible, keyboard-navigable picker matching both shells' tokens.

### T2 — Contacts adopts it · *lowest-risk first, it is already closest*

Contacts already ships the pattern (`<aside class="sidebar"><ul class="book-list">`,
`ContactsApp.tsx:562-604`). Swap that hand-rolled aside for `<CollectionColumn>` fed by the address
books it already loads. Proves the component against a real surface with the least churn.

### T3 — Mail adopts it · *MailboxSidebar → CollectionColumn*

Replace `MailboxSidebar.tsx` with `<CollectionColumn>` fed by the mailbox tree. **Drop the inline
`style={{paddingLeft}}` tree indent** (`MailboxSidebar.tsx:35`) — it is the one live CSP-boundary
violation, and the class-swap discipline replaces it.

### T4 — Approvals promotes its status groups · *the full quad — Eric's "maybe"*

Pull the four stacked `HeaderGroup`s (`ApprovalsQueue.tsx:345-370`) OUT of the header column into a
`<CollectionColumn>` (Waiting on you / on the agent / Hold / Decided); selecting one filters the
header column to that group. Turns Approvals from its current 2-pane (`22rem 1fr`) into the full
rail + collection + header + detail. Optional and last: if the four groups stay few, stacked-in-header
is defensible — this is the "maybe" Eric flagged.

### T5 — the global search bar · *independent of T1–T4*

Add the search input to `ShellNav`'s header (`ShellNav.tsx:513`), submitting to `/search`. Retire the
per-surface cross-realm search forms. Keep scoped filters (Decision 2). Mind the `h-16` height.

### T6 — responsive · *the CollectionColumn on a narrow screen*

On mobile the CollectionColumn collapses to a drawer/toggle, mirroring the rail's existing mobile
drawer (`ShellNav.tsx:377-407`). The four-column desktop layout degrades to a navigable stack.

## Sequencing

```
T1 component ──┬── T2 Contacts ──┬── T4 Approvals (optional)
               └── T3 Mail ──────┘
T5 search (independent) ────────────
T6 responsive (rides each adoption)
```

T1 gates the adoptions. **T2 (Contacts) first** — closest to the shape, lowest risk, proves the
component. T5 (search) is independent and can land anytime. T4 (Approvals) is the "maybe", last.

## Decisions

1. ~~Shell-hoisted column or shared component?~~ **Shared component** (this plan's premise) — data
   locality + parallel-safety, same four-column result. Revisit only if a cross-surface collection
   behaviour appears that a component can't carry.
2. **Does the global bar absorb scoped syntax** (mail `from:/to:`)? *Recommendation: no, v1.* Global =
   cross-realm find; scoped filtering stays in-surface where the syntax is meaningful.
3. **Promote Approvals to the quad (T4)?** Eric's "maybe" — decide once T2/T3 show the component in use.
4. **Does the CollectionColumn get its own resize+collapse, or inherit the rail's width memory?**
   *Recommendation: its own, same class-swap mechanism, remembered per surface.*

## Constraints (from the landed shell)

- **CSP:** no `'unsafe-inline'` in `style-src` — resize/indent by class-swap, never inline `style`
  (`ShellNav.tsx:14-21`). T3 fixes the one existing violation.
- **The boundary holds:** chrome (ShellNav/AppTw) is Tailwind; interiors are hand-rolled `webmail.css`
  + per-page `<style>` (`AppTw.astro:34-41`). The shared CollectionColumn is a borderline case —
  build it Tailwind-first (it is shell-adjacent) but on the shared CSS tokens so it matches interiors.
- **Tokens** (`webmail.css:5-18`): `--bg`, `--bg-alt`, `--bg-sunken`, `--fg`, `--fg-muted`, `--line`,
  `--accent`, `--accent-soft`, `--row: 68px`. The column builds only on these, like every per-page block.
- **Two shells:** `App.astro` is legacy (`/login` only); all app surfaces are `AppTw.astro`. Touch
  only `AppTw`.

## References

- `webmail/src/components/{ShellNav,AppShell,ContactsApp,ApprovalsQueue,MailboxSidebar,SearchApp}.tsx`
- `webmail/src/layouts/AppTw.astro` — the current chrome + `frame` knob
- PRs #166 (shell polish) / #167 (approvals width) / #168 (signed-in identity) — the landed shell
- `.plans/s07-app-surface/` — the shell's origin sprint
