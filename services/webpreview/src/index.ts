/**
 * webpreview — one hostname per open PR, serving that PR's built webmail.
 *
 * ## Why not Pages (#371)
 *
 * Previews were the last thing holding Cloudflare Pages in the stack, and
 * with it the `Cloudflare Pages: Edit` scope on a repository secret. The app
 * itself moved to R2 in #368/#369; this moves its previews, so the Pages
 * project and that token scope can both go.
 *
 * ## Why the hostname is `preview-<n>.<zone>` and not `<n>.preview.<zone>`
 *
 * The nicer-looking nested form is a MULTI-LEVEL wildcard, and Cloudflare's
 * free Universal SSL does not cover `*.preview.<zone>` — only one level
 * (`*.<zone>`) plus the apex. A nested preview host would serve a cert error
 * on every PR, on the free plan this platform targets. One level it is.
 *
 * ## A preview is deliberately INERT
 *
 * `services/jmap` answers the API only on `app.<zone>`, and no jmap route is
 * added for preview hosts. So a preview is a different origin from the API,
 * every data request fails, and the lists stay empty.
 *
 * That is a SAFETY PROPERTY, not an oversight, and it is why this file must
 * never grow an API route. A preview serves unreviewed code from a pull
 * request — including one from a fork. Same-origin with the real mail API
 * would mean that code runs with the reviewer's live session and can read
 * their mail. The inconvenience of a preview that cannot show data is the
 * price of previews that cannot exfiltrate it.
 *
 * So a preview is good for chrome, layout, copy, and loading states — the
 * skeletons in particular are easy to study, because without data they
 * simply stay up.
 */

import { serveStatic } from "../../webhost/src/serve.js";

export interface Env {
  /** One bucket, many PRs — keys are `pr-<n>/index.html` and so on. A
   *  separate bucket from the production site: a preview must never be one
   *  typo'd prefix away from overwriting what app.<zone> serves. */
  PREVIEWS: R2Bucket;
}

/**
 * `preview-123.bullmoose.cc` → `pr-123/`.
 *
 * Returns null for anything else, INCLUDING `preview-abc` — the number is
 * the PR, the workflow only ever writes numeric prefixes, and accepting a
 * free-form label would let any hostname under the wildcard route address any
 * prefix in the bucket.
 */
export function prefixForHost(hostname: string): string | null {
  const m = /^preview-(\d+)\./.exec(hostname);
  return m ? `pr-${m[1]}/` : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const host = new URL(request.url).hostname;
    const prefix = prefixForHost(host);
    if (!prefix) {
      // The route pattern is `preview-*`, so arriving here means a hostname
      // that matched the wildcard but is not a PR — say which, rather than
      // serving PR #1 because a regex was lenient.
      return new Response(`${host} is not a preview host (expected preview-<pr number>)`, { status: 404 });
    }
    return serveStatic(request, env.PREVIEWS, {
      prefix,
      bindingName: "PREVIEWS",
      // A preview is a real, public hostname serving an unreleased build.
      // Without this, search engines index it and the PR's copy outranks the
      // app's own pages for a while after the branch is deleted.
      extraHeaders: { "x-robots-tag": "noindex, nofollow" },
      notFound: `no preview build for this path — the PR may have been closed, or its build may not have finished`,
    });
  },
} satisfies ExportedHandler<Env>;
