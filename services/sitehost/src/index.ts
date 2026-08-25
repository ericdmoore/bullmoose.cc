/**
 * sitehost — the marketing + guides site at the apex, served from R2.
 *
 * The last Pages project (#375). `services/webhost` took the app in #368/#369
 * and `services/webpreview` took the previews in #371; this takes the front
 * door, so the whole platform is Workers/D1/R2 with no second serving
 * mechanism and no `Cloudflare Pages: Edit` scope left in the repo's secrets.
 *
 * ## It is NOT an SPA, and that is the point
 *
 * The reason to move this was not tidiness. On Pages, a build with no
 * `404.html` gets an SPA-style fallback by default — so `bullmoose.cc/anything`
 * answered **200 with the homepage**, for every nonexistent URL, for months.
 *
 * That is how `/.well-known/jmap` came to return a webpage. A JMAP client
 * doing RFC 8620 §2.2 autodiscovery reads a 200 as "found the server", so it
 * got HTML where it expected a session resource — worse than a 404, because
 * the failure is a success status. The fix at the time was a `_redirects` rule
 * patching that one path. This serves a real 404 instead, which fixes the
 * cause rather than the one symptom anybody noticed.
 *
 * The redirect rule still exists and still works — `_redirects` and `_headers`
 * are compiled by `bullmoose cloud site push` and applied by serve.ts — but it
 * is now a redirect because we want one, not a patch over a broken default.
 */

import { serveStatic } from "../../webhost/src/serve.js";

export interface Env {
  /** The built marketing site. Separate bucket from the app's: they have
   *  different release cadences, different audiences, and no reason to be one
   *  typo apart. */
  SITE: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return serveStatic(request, env.SITE, {
      bindingName: "SITE",
      // See the header: a brochure site that 200s on everything is broken in
      // a way that looks fine.
      spa: false,
      notFound: "not found",
    });
  },
} satisfies ExportedHandler<Env>;
