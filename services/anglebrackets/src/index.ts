import { authenticate, type AuthEnv, type Principal } from "@bullmoose/auth-core/principal";
import { handleDav } from "./dav.js";

/**
 * anglebrackets — CardDAV over the contacts core (devPlan-handoff
 * Phase 2). A STATELESS worker: no sessions, no locks — ETags and the
 * sync-token carry all state, which lives in the core (D1 + the
 * AccountDO changelog, bound cross-script from the jmap worker).
 *
 * Deliberately barely-conforming (locked decision Q4): the verb subset
 * CardDAV clients actually use — OPTIONS, PROPFIND, REPORT
 * (sync-collection / addressbook-multiget / addressbook-query),
 * GET/PUT/DELETE with ETags — plus /.well-known/carddav discovery.
 * LOCK/UNLOCK, COPY/MOVE, and ACLs are intentionally absent.
 *
 * Cost shape (why ctag exists): native clients POLL. An idle poll is
 * one PROPFIND reading address_books.ctag — O(1); only a changed ctag
 * triggers a sync-collection REPORT, which reads O(delta) from the DO
 * changelog. Auth is the same app-password Basic (user = login email,
 * password = bm_ token) the jmap worker and popcorn accept, and grants
 * resolve identically — a shared book appears in the sharee's
 * addressbook-home-set automatically.
 */

export interface Env extends AuthEnv {
  DB: D1Database;
  BLOBS: R2Bucket;
  ACCOUNT_DO: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // RFC 6764 discovery: clients try the well-known paths first.
    if (url.pathname === "/.well-known/carddav" || url.pathname === "/.well-known/caldav") {
      return new Response(null, { status: 301, headers: { Location: "/dav/" } });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          DAV: "1, 3, addressbook, calendar-access",
          Allow: "OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT",
        },
      });
    }

    const principal = await authenticate(request, env);
    if (!principal) {
      return new Response("unauthorized", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="bullmoose dav"' },
      });
    }

    if (url.pathname === "/" || url.pathname.startsWith("/dav")) {
      return handleDav(request, url, env, principal);
    }
    return new Response("bullmoose-anglebrackets", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export type { Principal };
