# s45 — the capability menu · *declared facts, measured quality, human allocation*

> **Status: DESIGN. Nothing built.** From the 2026-08-22 conversation — Eric:
> *"why not communicate to the messaging plane from the CLI 'how smart the
> local models we can run are'… budget vs latency vs param count brought to
> bear on a task"*, then, conceded and sharpened: *"Totally understand that
> param count is a poor excuse for quality. The dimensional need though is
> real."*
>
> Sequenced AFTER the s43 registry flip. s43's invariant #3 pins the claimant
> declaration shape byte-exact THROUGH the port — this plan extends that
> shape, additively, in Go only, once the port has landed and soaked.

## The gap

The scheduler's entire economic knowledge of a homelab is one bit and three
facets: `isFree`, and `{vision, contextTokens, tools}`. That buys exactly one
allocation behaviour — "a free box is alive within 15 minutes, NULL-due work
waits for it" — and nothing finer. It cannot say *alive but too small for
this*. And the HUMAN tuning a binding (`agents budget`/`agents model`, the
session plane, #302) chooses a model with no evidence in front of them:
budget vs latency vs capability is decided from memory and vibes.

## The honesty rule — why there is no "smartness" field

Param count lies across quantizations and architectures; a self-declared
quality scalar is exactly the plausible-looking-but-unfounded number the
cost rule (NULL means "not recorded", never a guess; 0 means "known free")
exists to keep out of the ledger. Declared *facets* are checkable; declared
*rankings* are vibes, and a host grading itself invites drift the
trust-but-audit posture would then have to chase.

So the split is:

- **DECLARED: facts a probe can check.** The host's resolved model menu —
  alias, context window, modalities, measured tokens/sec. The `bullmoose
  local` ladder already probes the host (LiteLLM :4000 → Ollama :11434 →
  vLLM :8000 → llama.cpp :8080) and can measure at onboarding; the claim
  already carries `claimant_caps_json` (trust-but-audit, recorded verbatim).
  This plan adds the menu to that declaration — an additive field the server
  tolerates absent.
- **MEASURED: quality the ledger already accrues.** Per (model, pipeline):
  cost per invocation (stamped), latency (`claimed_at → done_at`, stamped),
  and outcome quality — approved-clean rate, approved-after-edit rate,
  decline reasons from the decisions ledger. The frontier-assignment
  machinery (s26 scouts/arms) already does this empirically for cloud
  models; the homelab menu is invisible to it only because nothing declares
  it.

Five dimensions — cost, latency, context, modality, measured outcome — none
self-flattering, none a scalar.

## Where it surfaces

The allocation table, on the surfaces that already exist:

    this pipeline on @local/qwen3-32b:  free    ~40s   91% approved-clean
                     @crof/haiku-4.5:   $0.002    2s   94% approved-clean

- `bullmoose agents model <binding>` (`--explore` already prints a menu —
  it gains the measured columns; the human picks with evidence).
- The dossier's economics section.
- Later, the scheduler MAY consume the declared facts (a `contextTokens`
  requirement already exists in the fit gate); it never consumes a ranking.

## Also in scope: the @local wiring gap

Found 2026-08-22: `bullmoose local` saves the discovered host under
`localHost`, but the agent runtime never reads it — `model.baseURL` in
`agent.json`/`fleet.json` is hand-copied, and `help.ts`'s claim that they
are connected documents an intent, not code. The Go daemon closes this:
`@local` in an agent config resolves through the saved `localHost`, and the
menu declaration is read from the same probe. One source of truth for "what
can this box run", declared upward from where it is measured.

## Explicitly not

- No smartness scalar, no param-count field, no self-assigned rank. If a
  reviewer finds one in a diff, this section is the veto.
- No scheduler auto-selection by quality in v1. The human allocates; the
  table informs. Auto-routing is a later conversation with its own honesty
  problems (drift, gaming, and who pays for a wrong guess).

Related: s43 (the daemon that declares), s27 (spend honesty — the WHY of a
spend needs the menu that chose it), s26 (frontier assignment — the measured
half), s44 (the `tools` facet this menu sits beside).
