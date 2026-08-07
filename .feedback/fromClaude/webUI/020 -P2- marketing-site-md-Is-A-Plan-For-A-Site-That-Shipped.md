# 020 -P2- `marketing-site.md` is a forward-looking plan for a site that already shipped

**Subsystem:** webUI · **Severity:** MEDIUM-HIGH · **Fix class:** UPDATE-DOC

## The drift

`docs/architecture/marketing-site.md:3` — "Status: **design only.** A plan to rework `src/` from an
empty Fresh stub". `:11-17` §1 "Today" asserts `src/` is "untouched Fresh (Deno) boilerplate… the
demo `Counter` island. It builds with `deno task build` and ships to **Deno Deploy** via `deployctl`".

`docs/architecture/README.md:14-15` points at it as "The public-site rework".

**Reality:** the site is built, styled, and deployed — Astro 7.1.6 with `@astrojs/preact` and three
`@fontsource` families (`src/package.json:6-19`), seven routes, ~1,772 lines of source, a working
`dist/`, and 15+ feature commits under `src/`. No `deno.json`, no `fresh.config.ts`, no `islands/`
anywhere in the tree.

## Specific claims that are now wrong

| Claim | Reality |
|---|---|
| `:44-49` four routes (`/`, `/apps`, `/guides`, `/guides/<client>`) | **seven** — plus `/connectors`, `/recipes`, `/deploy`, all undocumented |
| `:51` nav is "Apps · Guides · Docs(→GitHub) · Deploy(→GitHub)" | `Nav.astro:2-9` is *What is it · Apps · Guides · Recipes · Connectors · Deploy*, and `/deploy` is an **in-site Preact wizard** (`DeployWizard.tsx`, 267 lines), not a GitHub link |
| `:21-23, :95` "Astro + the `@astrojs/cloudflare` adapter" | `src/package.json` has **no** `@astrojs/cloudflare`, no `wrangler`, and **no `devDependencies` block at all**; `astro.config.mjs:6-7,46` is static output, `integrations: [preact()]`, no adapter |
| `:96` "wrangler is already a dev dep" | only at repo root, a different lockfile |
| `:34-37` reuses `CLOUDFLARE_API_TOKEN` | `deploy.yml:42` uses `BULLMOOSE_SITE_DEPLOY_TOKEN` — a deliberate token split, documented at `deploy.yml:7-10` |
| `:82-83` add front-matter to each playbook | implementation deliberately went the other way — `src/src/lib/guidesMeta.ts:1-2` keeps playbooks "frontmatter-free so GitHub renders them plainly" |

`src/README.md` is stale the same way: `:21` names a `guides.astro` that is a directory and omits
four pages; `:26-28` says guides are "a later phase" — they shipped.

## Note

The static-output-no-adapter choice is **better** than what the doc prescribes for this site. The
code is right; the doc never caught up.
