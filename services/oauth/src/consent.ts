import { effectiveScopes, LOGIN_KEY_ITERATIONS, LOGIN_SALT_LABEL } from "@bullmoose/auth-core";
import { redirectHost } from "./redirects.js";

/**
 * The consent screen — and the system's real login (s02 T3).
 *
 * `app.bullmoose.cc/login` was always interim: it asked a human to paste a
 * `bm_` device token, which is a credential they had to obtain some other way
 * first. This page takes what a human actually has — their email and password
 * — and the OAuth flow does the translation into a system token. That is the
 * whole point of an authorization server, and it is why the interim door can
 * be deleted rather than duplicated (`s07` T7).
 *
 * ## The password does not leave the browser
 *
 * bullmoose's login contract (auth-core `deriveLoginKey`) puts a 600k-iteration
 * PBKDF2 on the CLIENT: the browser derives a `loginKey` from email+password
 * and sends only that; the server stores and compares one SHA-256 of it. Two
 * reasons, both load-bearing:
 *
 *   - Workers Free caps CPU at 10ms, so a server-side KDF is not affordable;
 *   - the raw password is never transmitted, so it cannot be logged, cached in
 *     a proxy, or read out of a request trace.
 *
 * This page therefore MUST derive client-side. It re-implements the derivation
 * inline rather than importing it, because this string runs in the visitor's
 * browser and cannot import a workspace module — `deriveLoginKey.test` pins
 * the parameters, and the conformance vector (`conformance/login-key.json`)
 * pins the expected output, so a drift between the two implementations fails
 * a test rather than silently locking everyone out.
 *
 * ## What the screen must SAY
 *
 * Say what the scopes DO, not what they are called. "mail" is not a permission
 * a human can evaluate; "read, file, draft and delete your mail" is. The
 * vocabulary comes from `effectiveScopes` — the SAME expansion the gate uses —
 * so the explanation cannot drift from the enforcement. A consent screen that
 * describes something other than what the gate allows is worse than no screen,
 * because it converts a prompt into a false assurance.
 *
 * ⚠️ The redirect HOSTNAME is shown because the spec requires it and CIMD
 * cannot by itself prevent `localhost` impersonation: any process on the
 * user's machine can serve a metadata document claiming to be Claude Code.
 * Where the code gets delivered is the part an impersonator cannot forge.
 */

interface ConsentInput {
  client: { clientId: string; clientName?: string; redirectUris: string[]; clientUri?: string };
  authReq: { clientId: string; redirectUri: string; scope: string[]; state: string };
  /** Shown after a failed attempt, so the human is not left guessing. */
  error?: string;
}

/** What each scope actually permits, in a sentence a human can refuse. */
/**
 * Every scope a client can be GRANTED must have prose here, and the coupling
 * test holds this map to `OAUTH_SCOPES` — because this exact drift shipped
 * once: #128 added `files` to the grantable set, and this screen, whose
 * prose did not know the word, granted the scope while silently omitting it
 * from "It is asking to:". A permission the human never saw is not consent.
 * (`mail` is absent on purpose: the bundle is expanded through
 * `effectiveScopes` into its verbs before rendering, so the bundle name
 * itself never needs a line.)
 */
/**
 * Scopes the expansion CONFERS but the screen deliberately does not list.
 *
 * `send` is here because the `mail` bundle expands to all six mail verbs —
 * including send — yet no surface an OAuth token can reach exercises it:
 * there is no send tool (the invariant `mcpTools.test.ts` pins), and OAuth
 * tokens authenticate only at /mcp, never at JMAP where tier-3 approval
 * lives. Listing "send mail as you" on the consent screen would claim a
 * capability the app cannot use — overstatement is the mirror-image failure
 * of the silent omission this file just fixed. ⚠️ If a send-requiring tool
 * ever lands on the MCP surface, this exclusion MUST die with it, and the
 * coupling test on tool scopes below is what will say so.
 */
const NEVER_DISPLAYED: ReadonlySet<string> = new Set(["send"]);

export const SCOPE_PROSE: Record<string, string> = {
  read: "Read your mail, contacts, calendar and files",
  annotate: "Mark your mail read, flagged or categorized",
  draft: "Write drafts in your mailbox (it cannot send them)",
  move: "File your mail into other mailboxes",
  delete: "Delete your mail",
  contacts: "Read and change your contacts",
  calendar: "Read and change your calendar, including creating and deleting events",
  files: "Read and change your files, including uploading and deleting them",
};

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * Served at /derive.js so the CSP can stay `script-src 'self'` — an inline
 * script would need either a maintained hash or 'unsafe-inline', and on the
 * one page in the system that handles passwords, neither is worth it.
 *
 * It clears the password field before the form submits, so the raw password
 * is never in a serialized form body even momentarily.
 */
/**
 * The derivation itself, as source, with NO DOM references — split out so a
 * test can evaluate it and compare against `auth-core`'s `deriveLoginKey` and
 * the `conformance/login-key.json` vectors.
 *
 * The two tunables are interpolated FROM auth-core rather than retyped, so
 * they cannot drift; the algorithm shape around them is hand-written for the
 * browser and is what the conformance test exists to hold. A silent drift
 * here does not throw — it derives a different key and locks every user out
 * with a correct password.
 */
export const DERIVE_FN_SRC = `
const SALT_LABEL = ${JSON.stringify(LOGIN_SALT_LABEL)};
const ITERATIONS = ${LOGIN_KEY_ITERATIONS};
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function deriveLoginKey(email, password) {
  const enc = new TextEncoder();
  const salt = await crypto.subtle.digest("SHA-256", enc.encode(SALT_LABEL + email.toLowerCase()));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, key, 256);
  return hex(bits);
}
`;

export function deriveScript(): Response {
  const js = `${DERIVE_FN_SRC}
const form = document.getElementById("consent");
form.addEventListener("submit", async (ev) => {
  const decision = ev.submitter && ev.submitter.value;
  if (decision === "deny") return; // nothing to derive
  ev.preventDefault();
  const email = form.email.value.trim();
  const password = form.password.value;
  const button = ev.submitter;
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    form.loginKey.value = await deriveLoginKey(email, password);
    // The raw password never reaches the network.
    form.password.value = "";
    const hidden = document.createElement("input");
    hidden.type = "hidden"; hidden.name = "decision"; hidden.value = "approve";
    form.appendChild(hidden);
    form.submit();
  } catch (err) {
    button.disabled = false;
    button.textContent = "Approve";
    document.getElementById("err").textContent = "Could not sign in: " + err;
  }
});
`;
  return new Response(js, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.35rem; margin-bottom: .25rem; }
  .sub { color: #666; margin-top: 0; }
  ul { padding-left: 1.1rem; } li { margin: .35rem 0; }
  .where { background: #f4f4f5; border-radius: .5rem; padding: .75rem 1rem; margin: 1.25rem 0; }
  .err { color: #b91c1c; font-weight: 600; }
  @media (prefers-color-scheme: dark) { .where { background: #26262b; } .sub { color: #a1a1aa; } }
  label { display: block; margin: 1rem 0 .35rem; font-weight: 600; }
  input[type=email], input[type=password] { width: 100%; padding: .55rem .6rem; font: inherit;
    border-radius: .4rem; border: 1px solid #bbb; box-sizing: border-box; }
  .row { display: flex; gap: .6rem; margin-top: 1.5rem; }
  button { font: inherit; padding: .6rem 1.1rem; border-radius: .4rem; border: 1px solid transparent; cursor: pointer; }
  .approve { background: #1d4ed8; color: #fff; font-weight: 600; }
  .deny { background: transparent; border-color: #bbb; }
`;

export function consentPage(input: ConsentInput): Response {
  const { client, authReq, error } = input;
  const name = escape(client.clientName ?? client.clientId);
  // Expanded through the real gate vocabulary, so `mail` shows its verbs
  // rather than hiding them behind a bundle name.
  const effective = effectiveScopes(authReq.scope);
  // FAIL LOUD on a scope this screen cannot explain. The silent version of
  // this shipped once (#128 added `files`; the filter below just dropped it):
  // the scope was GRANTED while missing from "It is asking to:" — a
  // permission the human never saw is not consent. Refusing the whole page
  // turns the next such drift into a visible outage of the consent flow,
  // which someone fixes in an hour, instead of quiet uninformed consent,
  // which nobody notices at all.
  const unexplained = effective.filter((s) => !SCOPE_PROSE[s] && !NEVER_DISPLAYED.has(s));
  if (unexplained.length > 0) {
    return errorPage(
      "This request asks for a permission this screen cannot explain yet.",
      `Unexplained scope(s): ${unexplained.join(", ")}. Granting what cannot be described ` +
        "would be uninformed consent, so the request is refused. This is a bullmoose bug — " +
        "the scope list and the consent prose have drifted.",
      500,
    );
  }
  const lines = effective
    .filter((s) => !NEVER_DISPLAYED.has(s))
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
<form id="consent" method="post" action="/authorize">
  <input type="hidden" name="authRequest" value="${escape(JSON.stringify(authReq))}">
  <input type="hidden" name="scope" value="${escape(authReq.scope.join(" "))}">
  <input type="hidden" name="loginKey" value="">
  <label for="email">Your bullmoose address</label>
  <input id="email" name="email" type="email" autocomplete="username" required spellcheck="false">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <p id="err" class="err">${error ? escape(error) : ""}</p>
  <div class="row">
    <button class="approve" type="submit" name="decision" value="approve">Approve</button>
    <button class="deny" type="submit" name="decision" value="deny">Cancel</button>
  </div>
</form>
<script src="/derive.js"></script>`;
  return new Response(body, {
    status: error ? 401 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // `form-action 'self'` is the browser's own refusal to let this form
      // post anywhere else; `frame-ancestors 'none'` stops the approve button
      // being clickjacked. Both are the reason the script is a file and not
      // inline — 'unsafe-inline' on the password page is not a trade worth
      // making for one <script> tag.
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

export function errorPage(headline: string, detail: string, status = 400): Response {
  const body = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(headline)}</title>
<style>${STYLE}</style>
<h1>${escape(headline)}</h1>
<p class="sub">${escape(detail)}</p>`;
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "cache-control": "no-store",
    },
  });
}
