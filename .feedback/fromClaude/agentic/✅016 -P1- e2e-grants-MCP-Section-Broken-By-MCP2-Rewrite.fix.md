# FIX — 016 -P1- `e2e-grants.mjs` MCP section broken

## Proposal

Port §14 of `tools/e2e-grants.mjs` to MCP.2. The file already provisions tokens for its actors, so
the pieces are in hand.

```js
const mcp = (body, token) =>
  fetch(`${AGENT}/mcp/analytics`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": INTERNAL_TOKEN, // still required at the router
      Authorization: `Bearer ${token}`, // NEW — identity
      "MCP-Protocol-Version": "2026-07-28", // NEW — must equal _meta
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      ...body,
      params: {
        ...body.params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
```

Then:

- swap `initialize` → **`server/discover`**, asserting `supportedVersions: ["2026-07-28"]`
- keep `tools/list`, and additionally assert `ttlMs` is present
- `tools/call` with ERIC's bearer against ERIC's account → 200 with rows

## Add the cases that matter most — the ones unit tests can't prove

The value of an e2e over `mcp.test.ts` is that it runs against **real D1**, so add:

1. **Cross-account denial:** ALLEN's bearer calling `spend_by_month` for ERIC's account with **no
   grant** → 403, **and assert zero rows come back** (not just a non-200).
2. **Granted read + audit:** create a grant ALLEN→ERIC, repeat the call → 200, then **query
   `grant_audit`** and assert exactly one new row with the right `grant_id`/`account_id`. That is the
   invariant (`mcp-auth.md` §16.4) and the fake-D1 test can only assert the _intent_ to write.
3. **Version rejection:** send `2025-06-18` → 400 with `-32022` and a `supported[]` array.

## Bread-crumbs

- Mirror the case list in `.plans/s01-stateless-MCP/devPlan.md` T4 (the 10-case table) so the unit
  and e2e suites are talking about the same contract.
- `mcp.ts:48-53`'s `requireAccountId` is now a redundant inner check behind the real gate — while in
  here, consider removing it so there is one authorization path, not two.
- Wire this into CI only after issue `011` (no workflow runs tests today); `e2e-grants.mjs` needs a
  live stack, so it likely stays a manual/staged check rather than a PR gate — say so in
  `tools/README.md`.
