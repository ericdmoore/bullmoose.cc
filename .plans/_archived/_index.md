List of Archived Work Sections
========================

A plan lands here when every task it defines is **built and verified in the code** —
not merely marked done. Audited 2026-08-19 against the source and against merged PRs,
because the landing notes in these files are hand-written by whoever shipped, and half
of any given plan's units were shipped by a different section. (sVOL's own post-mortem
diagnosed exactly this drift; see its closing note.)

**Nothing here is a graveyard.** Where an archived plan still carried an open thread,
that thread is named in the *Carried forward* column below and re-homed to a living
owner. An archived plan with a nameless loose end is a buried one.

| plan | what it was | carried forward |
|---|---|---|
| `s01-stateless-MCP` | the stateless MCP contract | — its acceptance #1 and decision D2 were deliberately **reversed** by s02, which is itself closed |
| `s02-mcp-facade` | the public MCP front door | — both open decisions signed off 2026-08-15; real Claude clients completed `tools/call` three ways |
| `s03.A-foundations` | provenance + the mailstore floor | ⚠️ **DAV writes still land NULL provenance** — `services/anglebrackets/src/dav.ts:131,163` construct `new Mailstore(db, blobs)` bare. Open as `.feedback/…/common/033` |
| `s03.E-console` | the permission console | ⚠️ **`POST /vault/oauth/start` is unserved.** Also named in sVOL's residue list — both are archived, so this is the only remaining record. **Unowned** |
| `s05-cli-crud` | CLI CRUD across the nouns | ⚠️ **`--occurrence` is deferred in BOTH CLIs** (`packages/cli/src/calendar.ts:293`, `cli-go/internal/cmd/calendar.go:28`). T3's Done-when — writing a `recurrenceOverrides` entry — is **unmet**, not merely refused |
| `s07-app-surface` | the app shell and its realms | ⚠️ the **three-number score** → owned by **s10 T6** (still open). ⚠️ the **`connect-src` tightening**, marked "cannot be done as written" — **unowned** |
| `s11-scheduling` | the queue, budgets, jobs DAG | T5 `$/work` optimiser → **s29 `model-selection-ladder.md`** + s26 T5c. (Its headline warning that Jobs had no production entry point is now stale: `Goal/set` → `startJobRows` since #216) |
| `s12-boundary` | the boundary + quarantine | — waves 1+2 complete (#95–#97, #107) |
| `s21-explorer` | the explorer surface | ⚠️ **code-complete but never switched on**: route commented at `wrangler.jsonc:104`, `EXPLORE_HOST` unset. Never verified against a live host |
| `s24-collection-column` | the quad-panel consolidation | ⚠️ **Files and Settings never adopted `CollectionColumn`** (Agents did). T6 responsive was closed by s25's #189 |
| `s25-mobile` | phone-first, six tasks | ⚠️ **the realm tray is 3/8 wired**: only Mail, Approvals and Contacts publish to `lib/shell/publish.ts` — Notes, Activity, Agents, Finder and Files render no leaf-nodes |
| `sVOL-CapSurNoun` | the capability-surface sweep | 27/27 (25 shipped, 2 wontfix); self-declared CLOSED at #159. Residues listed in its closing note, one of which is s03.E's above |

## Why the rest are still live

Design-only, nothing built: `s09-messaging` (a deliberate *don't build XMPP* record) · `s13-blogging-agent` · `s14-public-calendar-bookings` · `s15-local-mcp` · `s16-crm` · `s22-operator-surface` · `s27-usage-and-spending` · `s28-full-SMB-cast` · `s29-optimizations`.

Real open work: `s03-webAccess` (index; 2 of 5 arc criteria fail) · `s03.B-files` (outbound sidestep unbuilt — **its stated blocker is gone since #133**, so this is now actionable) · `s03.C-webmail-floor` (no compose attachments, no webmail copy-link) · `s03.D-coexistence` (**3.5 of 5 unbuilt** — bulk dispatch was never built at all, and it is the arc's differentiator) · `s04-AgentOS` (T4 redaction is a wired-but-inert seam; T5 Class B unbuilt) · `s06-codehygiene` (only perf/bench is genuinely missing) · `s08-go-cli` (T7 release + Node retirement not begun) · `s10-agents` (T5 panel writes `enabled` only though the server accepts five fields; T6 score absent) · `s17-chief-of-staff` (CJ does not exist; #214's machinery has **no production caller**) · `s18-notes` (N2 `mention` trigger and N3 federation unbuilt) · `s19-transports` (a standing invariant, not finished work — archiving it would hide the rule) · `s20-agent-native-ux` (**Delegate is not built and not parseable**: `MAIL_VERBS` has four entries) · `s23-activity` (v1 shipped; the file is the v2 design source and holds four open questions) · `s26-agent-config` (T5 outcome join + learned router, plus three self-named gaps).
