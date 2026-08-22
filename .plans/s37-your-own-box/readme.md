# s37 — Your own box · *the machine you run it on, visible from the app*

> **Status: DESIGN.** Nothing built. Written 2026-08-22 from
> [#275](https://github.com/ericdmoore/bullmoose.cc/issues/275) — *"Register CLI
> into settings"* — after the constraint that would have blocked it was
> retracted in #279.

## The question

You install the CLI on a laptop, log it in, point it at a local model host —
and the web app knows none of it. Settings cannot tell you which machines are
registered, when one was last seen, or whether the box your `extractor` binding
depends on actually serves the model it names.

The product's own claim is that you own the hardware and the data. That claim
is unverifiable from the surface where a person would check it.

## Most of this is already built

The instinct on reading #275 is "this is a feature." It is mostly a **join**.

| piece | state |
|---|---|
| **Device registry** | ✅ `tokens` carries `name` (`"eric-laptop"`, `"hermes-runtime"`) and `last_used_at`. A named token IS a registered device. |
| **Model discovery** | ✅ `bullmoose local` probes LiteLLM :4000, Ollama :11434, vLLM :8000, llama.cpp :8080, sweeps `/v1/models`, handles keyed hosts (401/403 → up-but-keyed) and remembers a saved host. |
| **Capability vocabulary** | ✅ `fleet.json` declares host `capabilities` `{vision, contextTokens, tools}`, and the daemon already skips invocations it cannot satisfy. |
| **What a binding wants** | ✅ `modelAliases` / `defaultModel` in each binding's `config_json` (data-plane.sql:200). |
| **A report path, local → server** | ❌ the only missing piece. |

So this section is one write path and two read models, not a feature.

### The blocker was an invented rule, and it is gone

Until 2026-08-22 the CLI's help asserted:

> *Model configs stay local: they describe the host's capability, never an
> agent's identity.*

Eric never decided that. It came from `.plans/_archived/s11-scheduling`, rode
into the help text in `ef0b9ac` (#211), and got quoted back at him as settled
policy while he was considering this very issue. Retracted in **#279** — the
fact survives (a model config describes the host, which is why it lives in
`fleet.json`), the prohibition does not.

Recorded here because it is the reason this section reads as "obvious, why
wasn't it built": it was foreclosed by a sentence nobody wrote on purpose.

## The thing worth building is a reconciliation, not a list

A settings panel that lists installed models is a status page you look at once.
The server already knows what your bindings *reference*, so one join produces
the sentence people actually need:

> **`extractor` references `@local/llama3` — this host does not serve it.**
> *(last seen 4 hours ago)*

That answers the question you have when an agent silently does nothing, which
is the failure mode local runtimes actually produce. Same instinct as the
popcorn drift check and as `_meta.methods`: compare what is configured against
what is true, and say so.

**Ranking:** the reconcile view is T2 and the plain list is T1, but if only one
gets built it should be the reconcile.

## Slices

**T1 — the report.** `local setup` / `local connect`, and the daemon on start,
POST what they found: host, models, declared capabilities, timestamp. Stored
against the reporting **token**, because a device is already an entity here.

**T2 — the reconcile view.** Settings shows registered devices, last seen, what
each serves, and — the point — which binding references something its host does
not have.

**T3 — the install command.** Show every platform's command with the detected
one first and preselected, never only the detected one: browser platform
detection is a guess, and a *wrong* command is worse than a list. **Blocked on
[[s08-go-cli]] T7** — there is no `release-cli.yml` and nothing published, so
today the command would point at build-from-source.

## Decisions to make (none of them security)

1. **Where the report lands.** Token-scoped is natural. A column on `tokens`,
   or a `device_reports` row keyed by token id? A row survives schema churn
   better and keeps `tokens` about authorization.
2. **Staleness must be visible.** A model list is a snapshot and models come and
   go. Render **"as of ‹when›"**, and render the token line as **"last seen"**,
   never "installed" or "connected". A minted token is not a running CLI, and
   settings confidently listing a model uninstalled in June is worse than
   showing nothing.
3. **Cadence.** On `local` commands only → stale by dinner. On every claim →
   chatty but honest. Leaning: daemon start plus `local` commands, since the
   daemon already knows its own capabilities.
4. **Does a report ever change behaviour**, or is it strictly display? Display
   only, at first. The moment the server *routes* on a self-reported capability,
   a wrong report becomes a wrong decision rather than a wrong label.

## Not in scope

**Trust.** Eric, closing this down on 2026-08-22: *"for now its just running the
users own data — so if it says `GPToss-120B` but thats a typo and its really
Gemma3 — thats there loss."* Correct for a single operator, and the concern was
overweighted when first raised.

⚠️ It returns with a second human ([[s33-assurance-ladder]], #213): a device
report is then a claim by **one user's machine** that another user may read.
Not a reason to design for it now; a reason to know where the seam is.

**Retiring the Node CLI**, which #275 also raised. That is [[s08-go-cli]] T7 and
it already has a criterion better than a feeling:

> *Delete the Node CLI only when the delegation count has been zero for a
> release, not when it "feels done" — the trace metric is the criterion.*

Currently **112 of 113 invocations native, seven commands still delegating** —
so it is not eligible. And "retire" is the wrong verb while the Go CLI
*delegates to* the Node CLI: deleting it would remove the implementation of
those seven commands, not a redundancy. Order is T6 (finish the ports) → T7
(release) → delete.

## Related

- [[s08-go-cli]] — T7 owns the release pipeline and the Node retirement
- [[s26-agent-config]] — the binding config this reconciles against
- [[s33-assurance-ladder]] — where self-reported facts stop being harmless
- #275 (the issue), #279 (the retraction that unblocked it)
