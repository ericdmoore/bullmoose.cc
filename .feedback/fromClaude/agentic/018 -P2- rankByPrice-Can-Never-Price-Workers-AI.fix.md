# FIX — 018 -P2- `rankByPrice` can never price Workers AI

## Proposal

**Price `workers-ai` candidates at 0 in `rankByPrice`.** They run on the account's free allocation —
that *is* the honest blended price, and it makes the free route sort first, which is what every doc
says happens.

```ts
// services/agent/src/models.ts — in rankByPrice
const priceOf = (c: ModelCandidate) => {
  if (c.provider === "workers-ai") return 0;              // free allocation
  return cache.prices[c.model] ?? Number.POSITIVE_INFINITY;
};
```

Two lines, no cache-shape change, and it removes the inversion.

### The alternative, if you want true blended ranking

Normalize the lookup key so Workers AI ids can hit the cache — either prefix-match `@cf/...` ids
during `refreshPricing` (`models.ts:155`), or key the cache by `(provider, model)` rather than a
concatenated string. More correct, more work, and only matters once Workers AI has a non-zero
metered price. Not worth it now.

⚠️ **Caveat worth writing into the code comment:** "free" holds only within the account's Workers AI
allocation. Past that it is metered. So `0` is a *policy* choice ("prefer the free tier"), not a
fact — say so, or a future reader will treat it as a pricing bug.

## Bread-crumbs

- **Test:** a mixed alias `[{workers-ai, @cf/…}, {gateway, anthropic/claude-opus-4-8}]` with a
  populated price cache; assert the Workers AI candidate ranks first. That test fails today.
- `models.ts:132`'s comment should be updated — "unknown pricing sorts last" is still true for
  `gateway` misses, but is no longer the whole rule.
- Same-provider aliases (all of `docs/examples/`) are unaffected either way, so this is safe to land
  without touching existing configs.
- While here: `docs/agents/README.md:125-129` and `ai-surface.md:76-77` become accurate rather than
  aspirational once this lands — no doc change needed, which is the sign it's the right fix.
