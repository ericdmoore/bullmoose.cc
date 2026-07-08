// @ts-check
import { defineConfig } from "astro/config";

// Static output (default) — the site is a brochure + guides, no SSR needed.
// Deploys as plain static assets to Cloudflare Pages (see
// .github/workflows/deploy.yml and docs/architecture/marketing-site.md).
export default defineConfig({
  site: "https://bullmoose.cc",
});
