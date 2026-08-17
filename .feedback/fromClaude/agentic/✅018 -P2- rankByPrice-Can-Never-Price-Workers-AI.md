# 018 -P2- `rankByPrice` can never price a Workers AI model, inverting cost preference

**Subsystem:** agentic-components · **Severity:** MEDIUM (silent cost inversion) · **Fix class:** CHANGE-CODE

## The claim

- `docs/agents/README.md:125-129` — "Aliases with multiple candidates **rank by blended models.dev
  pricing** … `workers-ai` runs on the free allocation"
- `services/agent/src/index.ts:33-34` — same
- `docs/architecture/ai-surface.md:76-77` — "Add `{ provider: "gateway", model: "<provider>/<model>" }`
  candidates to an agent's `modelAliases`; ranked fallback picks them up for free"
  — i.e. the docs actively instruct you to build the mixed alias that triggers this bug.

## The defect

- `services/agent/src/models.ts:155` builds pricing cache keys as `` `${providerId}/${modelId}` ``
- `models.ts:134` looks up **bare** `cache.prices[c.model]`

A `gateway` candidate's `model` is *already* `provider/model` (e.g. `"anthropic/claude-opus-4-8"`,
`docs/examples/editor-emily.config.json:14`) — so it **can** hit the cache.

A `workers-ai` candidate's `model` is `"@cf/meta/llama-3.3-70b-instruct-fp8-fast"` — it can **never**
equal `provider/model`, so it always resolves to `Number.POSITIVE_INFINITY` (`models.ts:134-135`) and
**sorts last**.

## Consequence

In a mixed alias, the **paid route is tried first** and the **free route becomes the fallback** —
exactly inverted from the documented behaviour and from the intent.

It is invisible today because the only aliases shipped in `docs/examples/` are same-provider, so all
candidates tie at Infinity and config order is preserved. It bites the moment someone follows
`ai-surface.md:76-77`'s own advice.

The comment at `models.ts:132` ("unknown pricing sorts last") documents the *intent* — it does not
anticipate that one whole provider can never be priced.
