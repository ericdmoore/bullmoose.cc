/**
 * webhost — the webmail's static files, served from R2.
 *
 * ## Why this exists (and what it replaced)
 *
 * The app used to be a Pages project, which meant `cloud install` ended by
 * telling a human to run `npx wrangler pages deploy`. That one line was the
 * only place in the whole install where someone learned this platform is
 * built in TypeScript — and reimplementing Pages' upload to remove it would
 * have meant copying an undocumented wrangler-internal protocol (BLAKE3
 * over base64-plus-extension, a JWT dance, four private endpoints) that
 * Cloudflare can change under us at any time.
 *
 * R2 + a worker uses only surfaces we already call: object PUT to upload,
 * script PUT to deploy. The whole install becomes one Go binary against
 * documented APIs, and the Pages project — plus its DNS attach and its
 * token scope — leaves the stack.
 *
 * ## Coexistence on app.<zone>
 *
 * `services/jmap` owns the API paths on this same hostname
 * (`/api/*`, `/auth/*`, `/console/*`, `/share/*`, `/.well-known/jmap`).
 * Worker routes match most-specific-first, so this worker's `app.<zone>/*`
 * sits UNDER those and serves everything else. That is the same-origin
 * arrangement s07 chose deliberately: no CORS surface, no preflight, no
 * second origin for a credential to cross.
 *
 * ## Where the rules live
 *
 * In `./serve.ts`, shared with services/webpreview — the SPA-fallback,
 * content-type and caching decisions are identical for the app and its
 * previews, and a second copy would drift until a preview stopped behaving
 * like the thing it previews. This file is now just the binding.
 */

import { serveStatic } from "./serve.js";

export { cacheControlFor, contentTypeFor, isNavigation, keyFor } from "./serve.js";

export interface Env {
  /** The bucket holding one deployment's files, keys relative to the site
   *  root with no leading slash (`index.html`, `_astro/app.abc123.js`). */
  SITE: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return serveStatic(request, env.SITE, {
      notFound: "not found",
    });
  },
} satisfies ExportedHandler<Env>;
