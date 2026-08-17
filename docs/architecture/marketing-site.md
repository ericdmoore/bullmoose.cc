# The bullmoose.cc site — apps + connection guides (Astro on Cloudflare)

Status: **design only.** A plan to rework `src/` from an empty Fresh stub
into the public site: what bullmoose is, which **apps** to use with it, and
**connection guides** for each. Companion to [`ai-surface.md`](ai-surface.md)
in the same forward-looking set; the guides reuse
[`docs/playbooks/`](../playbooks/README.md).

---

## 1. Today

`src/` is untouched Fresh (Deno) boilerplate — the landing page is the logo
and a wordmark, plus the demo `Counter` island. It builds with `deno task
build` and ships to **Deno Deploy** via `deployctl`
(`.github/workflows/deploy.yml`, project `bullmoose`). There is no real
content and nothing to preserve, so a framework change costs nothing.

## 2. Decision — Astro, deployed to Cloudflare Pages

Replace Fresh with [Astro](https://astro.build) + the
[`@astrojs/cloudflare`](https://docs.astro.build/en/guides/integrations-guide/cloudflare/)
adapter, deployed to **Cloudflare Pages**. Three reasons:

1. **Right tool for a content site.** Downloads + guides is content, not an
   app: Astro gives file-based routing, `.astro` + Markdown/MDX, typed
   **content collections**, and ~0 JS shipped by default (islands only where
   needed). Fresh is island/app-oriented and has no first-class Markdown
   pipeline.
2. **The guides already exist.** `docs/playbooks/` (Apple, JMAP/Mailtemi,
   family sharing) is exactly the "connection guide" content. An Astro
   content collection renders Markdown → pages, so the playbooks become
   **one source, two surfaces** (GitHub + the site). See §5.
3. **Consolidation.** `bullmoose.cc` is already a Cloudflare zone and the
   platform is all Workers/D1/R2. Astro on Pages puts the site on the same
   account, reusing the existing `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
   deploy secrets, and retires the standalone Deno Deploy pipeline.

Non-goal: interactivity that would argue for Fresh/an SPA. This is a
brochure + docs site; keep it static-first.

## 3. Structure

```
/                     landing — hero (logo, tagline, $0/mo), what-it-does, CTAs
/apps                 recommended clients by task (§4)
/guides               index of connection guides
/guides/<client>      one guide, rendered from a playbook (§5)
```

A top nav of **Apps · Guides · Docs(→ GitHub) · Deploy(→ GitHub)**. The
landing hero can lift straight from the README (logo, the Roosevelt-adjacent
tagline, the "$0/month" hook, the What-it-does bullets).

## 4. `/apps` — recommended clients, by task

Cards grouped by what the user wants to do; each card: platforms, what it
connects (mail / calendar / contacts), a one-line why, and **Set it up →**
linking to its guide.

| task | pick | notes |
|---|---|---|
| **Email (modern)** | **[Mailtemi](https://mailtemi.com)** | flagship rec — JMAP-native; calendaring shipping ([blog](https://mailtemi.com/blog/calendaring-progress/)). Verify current platforms + store links when building the page. |
| Email (terminal) | the `bullmoose` CLI | send/watch/search; power users |
| Calendar + Contacts (Apple) | Apple Calendar / Contacts | built-in CalDAV/CardDAV |
| Calendar + Contacts (Android) | [DAVx5](https://www.davx5.com/) | the Android CalDAV/CardDAV standard |
| Legacy mail | Apple Mail · Outlook · Thunderbird | POP3/SMTP via popcorn — **carry the $0-homelab / ~$5-VPS cost caveat** from the playbook |

The page leads with Mailtemi (mail is the headline), then the DAV clients,
then the legacy/popcorn row with its cost note.

## 5. `/guides` — reuse the playbooks (the one real decision)

The guides are `docs/playbooks/*.md`. Two ways to wire them:

- **Repo canonical (recommended).** `docs/playbooks/` stays the source of
  truth; the Astro content collection points at it (or a thin loader copies
  at build). Docs live with the code, contributors edit Markdown, the site
  is a *rendering*. Cost: a build-time **link-rewrite** — the playbooks use
  GitHub-relative links (`../carddav-setup.md`, `../../packages/…`); a
  remark/rehype step must rewrite them to site routes where a page exists,
  else to the GitHub blob URL. Front-matter (`title`, `client`, `cost`,
  `order`) gets added to each playbook.
- **Site canonical.** Author guides as MDX in `src/content/` (nicer web
  authoring, components, callouts); the repo `docs/playbooks/` then becomes
  a stub that links to the site. Cost: guides leave the repo tree.

Recommend **repo-canonical** — it keeps the "docs traverse in the repo"
property we just built and avoids a second home. New guides the site needs
(**Outlook, Thunderbird, Android/DAVx5**) get authored as playbooks first,
so they're useful on GitHub too.

## 6. Deployment

- **Build:** `astro build` → static output + the Cloudflare adapter.
- **Deploy:** `wrangler pages deploy` (wrangler is already a dev dep) or
  `cloudflare/pages-action`, from a rewritten `.github/workflows/deploy.yml`
  (drop `denoland/*`, drop the Deno Deploy `deployctl` step). Reuse the
  existing `CLOUDFLARE_*` repo secrets.
- **Domain:** serve the site on the **apex `bullmoose.cc`** (+ `www` →
  apex redirect). This coexists with the zone's MX (Email Routing), the
  `_jmap._tcp` SRV, and the `jmap.` / `dav.` worker hostnames — Pages adds
  A/AAAA on the apex; mail records are untouched.

## 7. Branding

Reuse the existing marks — the walking-moose logo
([`docs/assets/logo.svg`](../assets/logo.svg), sources in `art/`), the
stars-and-stripes palette, the favicon. When building the actual pages,
run the **frontend-design** skill for typography/layout so it doesn't read
as a template. Keep it fast and static; no heavy JS.

## 8. Non-goals, open questions, phasing

- **Non-goals:** a CMS, auth/accounts on the site, server rendering beyond
  what Pages needs. Static-first.
- **Open questions:** apex vs `www` as the primary (recommend apex);
  whether `/docs` should also publish `docs/architecture` later, or stay
  GitHub-only (start GitHub-only).
- **Phasing:** (1) scaffold Astro + CF Pages deploy + migrate the hero;
  (2) `/apps` with the cards in §4 (verify Mailtemi/DAVx5 links live);
  (3) `/guides` content collection + the link-rewrite, rendering the
  existing playbooks; (4) author the missing guides (Outlook, Thunderbird,
  DAVx5).
