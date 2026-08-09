// @ts-check
import preact from "@astrojs/preact";
import { defineConfig } from "astro/config";

// s03.C webmail shell. Static output for now (Cloudflare Pages, same proven
// path as the marketing site). The authenticated mail surfaces (T2) mount as
// Preact islands — the "SPA-in-an-island" shape from arch.md §1 — but T2/T3 are
// DEFERRED, so this build ships only a placeholder route today.
export default defineConfig({
  site: "https://mail.bullmoose.cc",
  integrations: [preact()],
});
