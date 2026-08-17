# s22 — the operator surface

> **Status: design, not started.** Opened 2026-08-17 out of a conversation about
> whether grants and credentials belong in the WebUI.

## The gap

Everything an owner does *occasionally and carefully* requires the CLI:

```
admin tenant create      admin account create     admin token create
admin grant create       admin agent disable      admin agent list
creds set / rotate / rm
```

Everything a user does *daily* has a browser: `/mail`, `/calendar`, `/contacts`,
`/files`, `/agents`, `/approvals`, `/search`, `/settings` (s07).

So the product has a UI and the **operator** has a terminal. That is fine for a
homelab of one and wrong for anyone else — and it is already wrong here in one
concrete way: nothing in a browser can answer *"who has access to my mail?"*

## Why this is not s07

s07 is *"one surface over every realm"* — the product app, one Astro/Preact
bundle on `app.bullmoose.cc`. Some operator work fits inside it (a grants
section in `/settings`). Some **deliberately must not**: the credential entry
form is worker-served with its own strict CSP precisely *because* it should not
carry the app's build pipeline or npm tree.

That split is the reason this is its own section. The line already exists in the
code — `/console/*` is a separate read interface from `/api/*`, on purpose.

s22 owns the **theme and the safety rules**, not a single URL. A given feature
may land inside s07's app, beside it as a worker-served page, or in the console.

## The rules this section is for

Drawn from the first design (`control-plane-in-the-browser.md`) and meant to
apply to everything that follows:

1. **Read and narrow, freely. Widen, carefully.** Reading your own ACL and
   revoking access *to your account* are safe — narrowing is the fail-closed
   direction and is already tombstoned and logged. Creating access is the
   dangerous direction and keeps its ceremony.
2. **One decision function, two readers.** The server answers "may I?" with the
   same call the method gate runs (`authorizeAccount`). Never a second policy
   layer in the client — that is how you ship *"a button that fails at the round
   trip."*
3. **Secrets get a worker-served page, not a bundled component.** The two things
   that change in a browser are the shared DOM and the script supply chain. A
   page returned by a worker under `default-src 'none'` has neither. Precedent:
   the OAuth consent page already handles a login password this way.
4. **Show provenance, not verdicts.** `grant_lifecycle` knows who granted what
   and whether an agent asked for it. Render that and let the human judge; do
   not classify it for them.
5. **The control plane stays off the mail surface.** `bullmoose-provision` has no
   public route. Anything that reaches it does so through a worker that decides,
   never by handing a browser an admin token.

## Candidate work

Not a plan yet — a list of what this section would eventually cover.

| | what | notes |
|---|---|---|
| **T1** | grants: read both directions | the missing half is *"who can reach me"* — unanswerable in a browser today |
| **T2** | grants: revoke where I am the target | narrowing; must still write a `grant_lifecycle` row naming the actor |
| **T3** | credentials: `creds set` / `rotate` | worker-served form, consent-page CSP; `/settings` links, never embeds |
| **T4?** | token management | `admin token create` / revoke — same read-and-narrow shape as grants |
| **T5?** | agent binding config | `PATCH /agent-bindings` already exists and is typed; the risky field is `recipients_book_id`, which is a governing book and therefore a widening |
| — | tenant / account / domain creation | **out of scope.** Genuine admin, genuinely rare, and correctly a CLI-with-admin-token operation |

T1–T3 are designed in `control-plane-in-the-browser.md`. T4/T5 are named so the
section's shape is visible, not because they are worked out.

## Open question

**Who is the operator?** Today `ADMIN_TOKEN` is one shared secret with total
authority, and every `admin` verb sits behind it. A browser surface implies a
*person* with a session, which is a different model — closer to "this principal
may administer these accounts" than "this bearer may do anything."

T1–T3 dodge the question, because each is scoped to something the session
already proves you own or reach. T4 and especially T5 do not. That distinction
is worth settling before the section grows past T3.
