# s10 — the Agents area: dev plan

> Ordered build for [`readme.md`](./readme.md): the agent **configuration** surface (CLI +
> WebUI) and the two controls it depends on. Activity (queue/dossier/score) is linked, not
> rebuilt — it lives in `/approvals` (s07 T4) and the `s03.E` console.
>
> **Guiding constraint:** the config surface must never offer a control that does not enforce.
> The reason T1 comes before any CRUD is that a "who it responds to" field with no backing
> store is a lie the moment it renders — and for a *social* agent that lie is a
> confused-deputy hole, not a cosmetic one.

---

## Tasks (in dependency order)

### T1 — `allowedRecipients` + the typed config core · *the controls the surface needs*

**Files:** `services/agent/src/index.ts` (enforcement), `services/agent/src/models.ts` (the
config type), `packages/mailstore/sql/data-plane.sql` + `infra/migrations.mjs` (the typed
columns), `webmail/src/lib/console/perAgent.ts` (surface the new bound).

Two things, and neither is UI:

- **`allowedRecipients`, fail-closed.** An agent that sends mail is bounded to the addresses
  it may send to; **unbound ⇒ cannot send**, matching the Bureau's invariant 5
  (`services/bureau/src/binding.ts` — refuse when no allowlist, never default-allow). This is
  `s07` decision 5, resolved. `allowedSenders` (inbound) is enforced at `index.ts:209`; this
  is its outbound twin. Harmless for `analyst@` (fixed `digestTargets`); load-bearing for
  `photos@`.
- **A typed config core.** Promote `allowedSenders`, `allowedRecipients`, `replyMode`,
  `enabled` out of the untyped `config_json` blob into typed columns the console reads and the
  runtime enforces uniformly; leave the agent-specific remainder (`persona`, `modelAliases`,
  `digestTargets`, `pipeline`) in the blob, shown read-only. This is `s07` decision 7,
  resolved. Migration via `infra/migrations.mjs` with an executable check.

**Done when:** an agent with no `allowedRecipients` is refused on send (a test, mirroring the
Bureau's fail-closed tests); the console renders the outbound bound beside the inbound one;
the typed core round-trips through the migration test.

### T2 — `bullmoose agents` · *the CLI config surface* — Go-native

**Files:** `cli-go/internal/cmd/agents.go` (+ tests), reusing the JMAP client from the
`approvals` command.

- `list` — bindings, human table + `--json`, showing enabled/replyMode/the two allowlists at a
  glance.
- `show <name>` — the config core + the read-only remainder, clearly separated. **Activity is
  a pointer, not a panel:** print "for activity: `bullmoose approvals --agent <name>`". Do not
  reimplement the dossier in the CLI.
- `edit <name>` — set the typed core only (`--reply-mode`, `--allow-sender`, `--allow-recipient`,
  `--enabled`). Refuse to blind-edit the blob; if a caller wants to change `persona`, that is a
  named flag or it is out of scope. Never write an `allowedRecipients` that is empty-but-present
  in a way that reads as "send anywhere" — empty means fail-closed.
- `create --kind <analyst|photos|newsletters|custom>` — provisioning-from-a-kind. The kind
  seeds the config core and the blob; `custom` is the blank case and must still set a
  fail-closed outbound bound. If create must mint an identity/scopes, that is a provision-worker
  call — surface it, do not fake it.
- `remove <name>` — `disable` by default (sets `enabled=0`, reversible); `--destroy` tombstones
  the binding and says what happens to its outstanding proposals.

Go-native, no Node counterpart (like `approvals`) — the contract suite stays 61/0 (additive),
and `agents` gets its own Go tests against a fake JMAP server.

**Done when:** the five verbs drive a fake server; `edit` cannot set an unbounded recipient
list; `create --kind photos` produces a fail-closed binding; `remove` defaults to reversible.

### T3 — `/agents/<id>` config panel · *the WebUI config surface*

**Files:** `webmail/src/pages/agents.astro` / the existing console island,
`webmail/src/lib/agents/` (new, config logic), `webmail/src/lib/console/` (compose, don't fork).

- The per-agent page gains a **config panel** beside the existing activity/permissions view
  (`perAgent.ts`). Two panels, labelled *what it is* vs *what it's doing* — not two pages.
- Edit the typed core with the same fail-closed discipline as T2; the remainder read-only.
- **The "who it responds to" row now has a backing field** (T1), so it can finally be an
  editable control rather than a warning about its absence.
- ListView / Create(from kind) / Disable-Remove, mirroring T2's semantics so the two surfaces
  agree.

⚠️ **`/agents` live mode is separately blocked**, and this task does not unblock it: the
console reads `/console/*`, four routes that are *requested, not served* (s03.E rough edge).
Until they are served the config panel is drivable via `?demo=1` only. Serving those four
routes is a small server task worth doing first or alongside — it lights up the whole existing
console, not just this panel.

**Done when:** the config panel edits the typed core in `?demo=1`; the outbound-bound control
writes a real field; the plain-client floor (no agent capability) hides it without a dead
region.

### T4 — The agent score · *depends on s07 T5, flagged not owned*

The dossier's score (acceptance rate, **cost-of-declined**, cost-per-approved, `provider` not
`modelName`) is designed in `s07` §"Edit is the load-bearing verb" and T5. It needs the
`agent_invocations` cost columns (`tokenCount`/`costAmt`/`provider`) that **s07 T5 owns** —
they do not exist yet, so the dossier shows no score today. s10 does not build the score; it
is named here so the agent area's completeness is not overstated. When s07 T5 lands, the score
renders in the activity panel this section built the frame for.

---

## Sequencing

```
T1 allowedRecipients + typed core ──┬─→ T2 CLI agents
   (the controls the surface needs) └─→ T3 WebUI config panel
                                          (also wants /console/* served — separate)
s07 T5 invocation cost ─────────────────→ T4 score renders (not owned here)
```

**T1 is non-negotiably first.** Everything after it offers to edit controls; T1 is what makes
those controls real. Building the CRUD first would ship a form with a field that writes
nowhere.

## Decisions needed

1. **Does `create` mint an identity, or only a binding?** A real `analyst@` needs an address;
   a lightweight in-account agent may not. *Recommendation: `--kind` decides — `analyst`/`photos`
   provision an identity via the provision worker; `custom` is binding-only until the operator
   adds an address.*
2. **Is `allowedRecipients` addresses, domains, or both?** `photos@`'s invitees are individual
   addresses; a newsletter agent might want a domain. *Recommendation: both, parsed like the
   Bureau's allowlist (exact host or `*.host`), so the two outbound-bound models stay one
   idea.*
3. **Does `remove --destroy` cascade to proposals, or orphan-and-tombstone?** *Recommendation:
   tombstone the binding, keep the proposals (they are audit), and render them under a "removed
   agent" heading rather than deleting history — the same stance grant revocation takes.*

## Out of scope

- **The activity dossier itself** — `/approvals` and the `s03.E` console own it; s10 links.
- **The score** — s07 T5 (T4 above names the dependency).
- **Serving `/console/*`** — a server task that unblocks the *existing* console; flagged in T3,
  not owned here.
