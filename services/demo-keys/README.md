# bullmoose-demo-keys

Issues and verifies the per-visitor key phrases that gate `demo@bullmoose.cc`, backed
by Cloudflare KV. This is the **edge half** of the demo; the mail agent that answers
email lives on the box (`~/.bullmoose-demo/`, runs as the `bmdemo` user) and calls this
Worker's `/demo/verify` to check phrases.

## Endpoints

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/demo` | public | Turnstile-gated page; click to mint a phrase, copy it, open a prefilled email |
| POST | `/demo/request` | public | mint a phrase (Turnstile + per-IP daily cap; **fails closed** if `TURNSTILE_SECRET` unset) |
| POST | `/demo/verify` | the bridge | validate + record use (`INTERNAL_TOKEN` bearer) |

The bridge holds **only** the `/demo/verify` bearer token — it cannot mint phrases or
read the namespace.

## Phrase model

Generated, not enumerated: 4 words from a 4096-word list (`words.ts`) = 2^48. The list
is public; security is the size of the space. Multi-use (so quoted replies keep a thread
alive), 30-day expiry (enforced logically *and* pinned as the KV record's collection
time), auto-revoked if seen from more than 3 sender addresses — leak detection instead of
one-time-use. A leaked key dies when it spreads, not when it's used.

## Deploy

All from the repo root. Needs `wrangler` auth to the Cloudflare account and one Turnstile
widget created in the dashboard.

1. **KV namespace**
   ```
   wrangler kv namespace create DEMO_KEYS
   ```
   Put the returned id into `wrangler.jsonc` → `kv_namespaces[0].id`.

2. **Turnstile widget** (Cloudflare dash → Turnstile → Add widget, hostname `bullmoose.cc`)
   - copy the **site key** into `wrangler.jsonc` → `vars.TURNSTILE_SITEKEY`
   - set the **secret**:
     ```
     wrangler secret put TURNSTILE_SECRET -c services/demo-keys/wrangler.jsonc
     ```

3. **Internal token** — shared secret the box uses to call `/demo/verify`. Generate one,
   set it here, and keep the SAME value for the box's `.verify_token` (step 5):
   ```
   openssl rand -hex 32        # copy this
   wrangler secret put INTERNAL_TOKEN -c services/demo-keys/wrangler.jsonc
   ```

4. **Route** — uncomment the `routes` block in `wrangler.jsonc` (needs the `bullmoose.cc`
   zone on Cloudflare) so it serves at `bullmoose.cc/demo*` rather than `*.workers.dev`.
   The bridge defaults `DEMO_VERIFY_URL` to `https://bullmoose.cc/demo/verify`.

5. **Deploy**
   ```
   npm run deploy -w services/demo-keys
   ```
   Then, on the box, give `bmdemo` the same INTERNAL_TOKEN value from step 3:
   ```
   sudo -u bmdemo sh -c 'umask 077; cat > ~/.bullmoose-demo/.verify_token'   # paste, Ctrl-D
   ```

## Smoke test after deploy

```
# page renders with the widget
curl -s https://bullmoose.cc/demo | grep -q cf-turnstile && echo page-ok

# minting without a Turnstile token must be refused
curl -s https://bullmoose.cc/demo/request -X POST -d '{}' | grep -q challenge_failed && echo gate-ok

# verify auth: wrong bearer must 401
curl -s -o /dev/null -w '%{http_code}\n' https://bullmoose.cc/demo/verify \
  -H 'authorization: Bearer wrong' -d '{"phrase":"x","sender":"y@z.com"}'   # -> 401
```

Mint a real phrase from the page, then confirm `/demo/verify` accepts it with the
`INTERNAL_TOKEN` bearer and a `sender`.

## Local development

```
cd services/demo-keys
printf 'INTERNAL_TOKEN=dev\nTURNSTILE_SECRET=1x0000000000000000000000000000000AA\nTURNSTILE_SITEKEY=1x00000000000000000000AA\n' > .dev.vars
npx wrangler dev
```
`1x…` are Cloudflare's always-passes Turnstile test keys (`2x…` always fails). `.dev.vars`
is gitignored. Miniflare persists KV under `.wrangler/` — delete it to reset the per-IP
mint cap between test runs.

## Known limitations (acceptable for a demo)

- **KV is eventually consistent** (~60s global) with no compare-and-swap. Concurrent
  verifies of the *same* phrase can lose an update, so leak detection and the `uses`
  counter are best-effort. In practice verify is driven by serialized inbound mail, so
  same-phrase concurrency is near zero. Not worth a Durable Object for a demo.
- A freshly minted phrase may need a few seconds to be verifiable at a different edge
  location — masked here by normal email delivery latency.
