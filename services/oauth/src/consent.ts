import { effectiveScopes } from "@bullmoose/auth-core";
import { redirectHost } from "./redirects.js";

/**
 * The consent screen (s02 T3's minimum; `s02` T4 makes it the product).
 *
 * The rule this page exists to honour: **say what the scopes DO, not what
 * they are called.** "mail" is not a permission a human can evaluate;
 * "read, file, draft and delete your mail" is. The vocabulary comes from
 * `effectiveScopes` — the SAME expansion the gate uses — so the explanation
 * cannot drift from the enforcement. A consent screen that describes
 * something other than what the gate allows is worse than no screen, because
 * it converts a permission prompt into a false assurance.
 *
 * ⚠️ The redirect HOSTNAME is displayed because the spec requires it and CIMD
 * cannot by itself prevent `localhost` impersonation: any process on the
 * user's machine can serve a metadata document claiming to be Claude Code.
 * Where the code gets delivered is the part an impersonator cannot forge.
 */

interface ConsentInput {
  client: { clientId: string; clientName?: string; redirectUris: string[]; clientUri?: string };
  authReq: { clientId: string; redirectUri: string; scope: string[]; state: string };
}

/** What each scope actually permits, in a sentence a human can refuse. */
const SCOPE_PROSE: Record<string, string> = {
  read: "Read your mail, contacts and calendar",
  annotate: "Mark your mail read, flagged or categorized",
  draft: "Write drafts in your mailbox (it cannot send them)",
  move: "File your mail into other mailboxes",
  delete: "Delete your mail",
  contacts: "Read and change your contacts",
  calendar: "Read and change your calendar, including creating and deleting events",
  mail: "Full access to your mail: read, mark, draft, file and delete",
};

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.35rem; margin-bottom: .25rem; }
  .sub { color: #666; margin-top: 0; }
  ul { padding-left: 1.1rem; }
  li { margin: .35rem 0; }
  .where { background: #f4f4f5; border-radius: .5rem; padding: .75rem 1rem; margin: 1.25rem 0; }
  @media (prefers-color-scheme: dark) { .where { background: #26262b; } .sub { color: #a1a1aa; } }
  label { display: block; margin: 1rem 0 .35rem; font-weight: 600; }
  input[type=password] { width: 100%; padding: .55rem .6rem; font: inherit; border-radius: .4rem;
    border: 1px solid #bbb; box-sizing: border-box; }
  .row { display: flex; gap: .6rem; margin-top: 1.5rem; }
  button { font: inherit; padding: .6rem 1.1rem; border-radius: .4rem; border: 1px solid transparent; cursor: pointer; }
  .approve { background: #1d4ed8; color: #fff; font-weight: 600; }
  .deny { background: transparent; border-color: #bbb; }
`;

export function consentPage(input: ConsentInput): Response {
  const { client, authReq } = input;
  const name = escape(client.clientName ?? client.clientId);
  // Expanded through the real gate vocabulary, so `mail` shows its six verbs
  // rather than hiding them behind a bundle name.
  const effective = effectiveScopes(authReq.scope);
  const lines = effective
    .filter((s) => SCOPE_PROSE[s])
    .map((s) => `<li>${escape(SCOPE_PROSE[s]!)}</li>`)
    .join("\n");

  const body = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Connect ${name} to bullmoose</title>
<style>${STYLE}</style>
<h1>Connect ${name} to bullmoose?</h1>
<p class="sub">It is asking to:</p>
<ul>
${lines || "<li>Nothing — this client requested no permissions.</li>"}
</ul>
<div class="where">
  If you approve, the access code is delivered to
  <strong>${escape(redirectHost(authReq.redirectUri))}</strong>.
  Only continue if you recognize that address.
</div>
<form method="post" action="/authorize">
  <input type="hidden" name="authRequest" value="${escape(JSON.stringify(authReq))}">
  <input type="hidden" name="scope" value="${escape(authReq.scope.join(" "))}">
  <label for="token">Your bullmoose device token</label>
  <input id="token" name="token" type="password" placeholder="bm_…" autocomplete="off" spellcheck="false" required>
  <div class="row">
    <button class="approve" type="submit" name="decision" value="approve">Approve</button>
    <button class="deny" type="submit" name="decision" value="deny">Cancel</button>
  </div>
</form>`;
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The token field must never reach a URL, and this page must never be
      // framed into a clickjacked approve button.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

export function errorPage(headline: string, detail: string): Response {
  const body = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(headline)}</title>
<style>${STYLE}</style>
<h1>${escape(headline)}</h1>
<p class="sub">${escape(detail)}</p>`;
  return new Response(body, {
    status: 400,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "cache-control": "no-store",
    },
  });
}
