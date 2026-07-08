# bullmoose.cc — the site

The public marketing + connection-guides site. **Astro**, static output,
deployed to **Cloudflare Pages** (`.github/workflows/deploy.yml`). Design and
plan: [`../docs/architecture/marketing-site.md`](../docs/architecture/marketing-site.md).

```sh
cd src
npm install
npm run dev        # http://localhost:4321
npm run build      # → dist/
npm run preview    # serve dist/ locally
```

Structure:

```
public/            static assets (moose.svg, favicon, stripe)
src/layouts/       Base.astro — the html shell, fonts, meta
src/components/    Nav, Footer, Postmark (the $0/mo seal)
src/pages/         index.astro (landing) · apps.astro · guides.astro
src/styles/        global.css — the design system (tokens + sections)
```

Type: Big Shoulders Display (slogan) · Public Sans (body) · Space Mono
(technical). Palette: aged flag — navy, rag, oxblood, brass. Guides will be
sourced from [`../docs/playbooks/`](../docs/playbooks/README.md) in a later
phase.
