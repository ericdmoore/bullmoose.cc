# FIX — 020 -P2- `marketing-site.md` is a plan for a shipped site

## Proposal: reframe as **as-built**, with a short decision log

Don't delete the plan — the *reasoning* in it is worth keeping. Restructure:

1. **Status line** (`:3`) → `**Status: built.** The site is live at bullmoose.cc; this documents it
   as built. Decisions that changed during implementation are in §Decision log.`
2. **§1 "Today"** (`:11-17`) → past tense, one paragraph: *"`src/` was a Fresh/Deno stub; it was
   replaced by Astro + Preact."* The Fresh narrative has no present-tense value.
3. **Routes** (`:44-49`) → the actual seven, and document the three that aren't there:
   `/connectors`, `/recipes`, and especially `/deploy` — the site's only interactive island and its
   primary CTA, currently documented nowhere.
4. **Nav** (`:51`) → match `Nav.astro:2-9`.
5. **Stack** (`:21-23`, `:95-96`) → static output, **no adapter**, `@astrojs/preact` only; deployed
   via `wrangler pages deploy` in CI using `BULLMOOSE_SITE_DEPLOY_TOKEN` (not `CLOUDFLARE_API_TOKEN`;
   the split is deliberate and documented at `deploy.yml:7-10`).

## Add a decision log — this is the part with lasting value

Three implementation choices deliberately diverged from the plan and are *better*. Record them so
nobody "fixes" the code back toward the doc:

- **Static output, no Cloudflare adapter.** The site has no SSR needs; static is simpler and faster.
- **Playbooks stay frontmatter-free** (`guidesMeta.ts:1-2`) so they render plainly on GitHub; the
  metadata lives in a side table instead of in each file. The plan prescribed front-matter.
- **A separate deploy token** for the site, isolated from the platform token.

## Also fix `src/README.md`

`:21` (route list — `guides.astro` is a directory; four pages missing) and `:26-28` ("guides will be
sourced … in a later phase" — they shipped and render at `dist/guides/*/index.html`).

## Bread-crumbs / smaller items to fold in

- **`npm run check` is broken.** `src/package.json:9` runs `astro check`, which needs `@astrojs/check`
  + `typescript` — neither is in `src/package.json`, its lockfile, or `node_modules`. Either add them
  or drop the script; a documented command that always fails is worse than none.
- **`guidesMeta.ts` fails open silently** (`:26-27`): an unknown slug falls back to `{ title: id,
  tag: "connection guide", blurb: "" }`, so a new playbook publishes with a raw-slug `<h1>` and an
  **empty meta description** (fed to `<meta name="description">` and `og:description` via
  `[slug].astro:19` → `Base.astro:36,45`). `marketing-site.md:88-91` anticipates three more playbooks
  and `apps.astro:27-28` already ships a DAVx5 card pointing at a guide that doesn't exist — so this
  path *will* be hit. A build-time assert that every collection entry has a `GUIDES` entry is cheap.
- **`scripts/make-og.mjs` is undeclared and unwired** — imports `sharp` (`:16`), which is not in
  `src/package.json` (resolves only transitively via astro), hardcodes
  `/Applications/Chromium.app/…` (`:24-25`), has no npm script, and is documented nowhere — yet
  regenerating `public/og.png` is required "whenever the hero slogan or brand palette changes".
- **`/demo` routing needs documenting**: `services/demo-keys` claims `bullmoose.cc/demo*` on the same
  apex the Pages project serves (`marketing-site.md:100-103` covers DNS coexistence but not
  same-hostname *path* routing). Also there is **no `/demo` link anywhere in the site** — grep of
  `src/src` for `/demo` returns nothing, so the public demo funnel has no entry point. ⚠️ I could not
  verify Worker-route-vs-Pages precedence offline; confirm before relying on it.
