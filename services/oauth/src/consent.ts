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
  /**
   * Is this bullmoose's OWN webmail (`WEBMAIL_CLIENT_ID`)? The stranger-danger
   * framing below is a defence against a client we cannot vouch for; aimed at
   * ourselves it manufactures suspicion about our own front door, which is
   * where the first phone tester stalled. First-party is a SAFE claim to make
   * here and only here: the client id is pinned by env to one exact CIMD URL,
   * and the code can still only be delivered to a redirect that document
   * itself declares — an impersonator cannot borrow the name and redirect
   * elsewhere. Anything else keeps the warning.
   */
  firstParty?: boolean;
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
  rules: "Read and rewrite your mail-filtering rules — the standing filters that decide where future mail goes",
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

/**
 * The browser half of the login, built once at module load.
 *
 * ⚠️ CACHE-BUSTED BY CONTENT. This file was served as a fixed `/derive.js`
 * with `max-age=3600`, and #253 showed why that is the wrong shape: a bug in
 * this script does not fail loudly, it makes sign-in do NOTHING (no request
 * leaves the browser, so no server log records it). Shipping the fix could
 * not reach a device that already had the broken hour-long copy, and there
 * was no way to force it. The name now changes whenever the bytes change, so
 * a stale copy is not merely unlikely — it is unaddressable.
 */
const DERIVE_JS = `${DERIVE_FN_SRC}
const form = document.getElementById("consent");
const approveButton = form.querySelector("button.approve");

// s33 slice 3 — the passkey path. Usernameless: the server sends no
// credential list (an empty one cannot leak which accounts exist), the
// authenticator offers what it holds, and the assertion rides the SAME
// /authorize POST the password path uses — one tail, two heads.
const passkeyButton = form.querySelector("button.passkey");
if (passkeyButton && typeof navigator !== "undefined" && navigator.credentials && navigator.credentials.get) {
  const unb64u = (t) => Uint8Array.from(atob(t.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/[+]/g, "-").replace(/[/]/g, "_").replace(/=+$/, "");
  passkeyButton.addEventListener("click", async () => {
    const label = passkeyButton.textContent;
    try {
      passkeyButton.disabled = true; passkeyButton.textContent = "Waiting for your passkey…";
      const optRes = await fetch("/webauthn/login/options", { method: "POST" });
      const opt = await optRes.json();
      if (!optRes.ok) throw new Error(opt.error || "could not start");
      const pk = opt.publicKey;
      pk.challenge = unb64u(pk.challenge);
      const cred = await navigator.credentials.get({ publicKey: pk });
      form.assertion.value = JSON.stringify({
        id: cred.id,
        response: {
          clientDataJSON: b64u(cred.response.clientDataJSON),
          authenticatorData: b64u(cred.response.authenticatorData),
          signature: b64u(cred.response.signature),
        },
      });
      form.password.value = "";
      const hidden = document.createElement("input");
      hidden.type = "hidden"; hidden.name = "decision"; hidden.value = "approve";
      form.appendChild(hidden);
      form.submit();
    } catch (err) {
      passkeyButton.disabled = false; passkeyButton.textContent = label;
      const slot = document.getElementById("err");
      if (slot) slot.textContent = "Passkey sign-in did not complete: " + err;
    }
  });
} else if (passkeyButton) {
  passkeyButton.remove(); // no WebAuthn here — the password path remains
}
form.addEventListener("submit", async (ev) => {
  // WARNING: ev.submitter is ABSENT on implicit submission — the iOS keyboard's
  // "Go", Enter from a text field — and in Safari before 15.4. Reading it
  // unguarded threw a TypeError *after* preventDefault(), so the handler died
  // with the form already cancelled: the button never changed, no error
  // appeared, and sign-in did nothing at all. On a phone, where hitting "Go"
  // after the password IS the natural gesture, that was the whole front door.
  const button = ev.submitter || approveButton;
  if (ev.submitter && ev.submitter.value === "deny") return; // let Cancel post natively
  ev.preventDefault();
  const email = form.email.value.trim();
  const password = form.password.value;
  const label = button ? button.textContent : "";
  try {
    if (button) { button.disabled = true; button.textContent = "Checking…"; }
    form.loginKey.value = await deriveLoginKey(email, password);
    // The raw password never reaches the network.
    form.password.value = "";
    const hidden = document.createElement("input");
    hidden.type = "hidden"; hidden.name = "decision"; hidden.value = "approve";
    form.appendChild(hidden);
    form.submit();
  } catch (err) {
    if (button) { button.disabled = false; button.textContent = label; }
    const slot = document.getElementById("err");
    if (slot) slot.textContent = "Could not sign in: " + err;
  }
});
`;

/**
 * FNV-1a, 32-bit. A CACHE KEY, not a security primitive: it only has to change
 * when the bytes change, and it has to be synchronous (`crypto.subtle` is not,
 * and the page render is). Collisions do not matter here — an attacker who can
 * choose this script's contents already owns the worker.
 */
function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The one URL the consent page points at. Changes with the script's bytes. */
export const DERIVE_PATH = `/derive.${contentHash(DERIVE_JS)}.js`;

/** The pre-#253 fixed name. Still served — a page rendered by the previous
 *  deployment is in someone's browser right now and asks for this — but with
 *  a lifetime short enough that it can never wedge a device again. */
export const DERIVE_LEGACY_PATH = "/derive.js";

export function deriveScript(pathname: string = DERIVE_PATH): Response {
  const immutable = pathname === DERIVE_PATH;
  return new Response(DERIVE_JS, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      // Content-addressed: safe to keep forever. The legacy name is not, and
      // a minute is enough to spare the worker a stampede without letting a
      // broken copy outlive its fix.
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=60",
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
  .passkey { background: #0f766e; color: #fff; font-weight: 600; }
  .deny { background: transparent; border-color: #bbb; }
`;

/** The origin of a redirect URI, or "" when it will not parse. */
function originOf(redirectUri: string): string {
  try {
    return new URL(redirectUri).origin;
  } catch {
    return "";
  }
}

export function consentPage(input: ConsentInput): Response {
  const { client, authReq, error, firstParty = false } = input;
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

  // "Connect bullmoose webmail to bullmoose?" — the client and the resource
  // were the same word, so the question read as nonsense. Name the ACCOUNT as
  // the thing being connected to; that reads correctly for a stranger and for
  // ourselves. (Eric, first phone test: "the text is obscure".)
  const host = escape(redirectHost(authReq.redirectUri));
  // The origin the 302 will land on. A redirectUri that cannot be parsed
  // leaves the directive at 'self': the request is malformed and will be
  // refused downstream anyway, and a CSP is not the place to be lenient.
  const formTarget = originOf(authReq.redirectUri);
  const title = firstParty ? "Sign in to bullmoose" : `Connect ${name} to your bullmoose account`;
  const heading = firstParty ? "Sign in to bullmoose" : `${name} wants to connect to your bullmoose account`;
  const where = firstParty
    ? `This is bullmoose's own webmail, at <strong>${host}</strong>. Your password is entered here, on
       <strong>auth.bullmoose.cc</strong>, and never reaches it.`
    : `If you approve, the access code is delivered to <strong>${host}</strong>.
       Only continue if you recognize that address.`;

  const body = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${STYLE}</style>
<h1>${heading}</h1>
<p class="sub">${firstParty ? "It will be able to:" : "It is asking to:"}</p>
<ul>
${lines || "<li>Nothing — this client requested no permissions.</li>"}
</ul>
<div class="where">${where}</div>
<form id="consent" method="post" action="/authorize">
  <input type="hidden" name="authRequest" value="${escape(JSON.stringify(authReq))}">
  <input type="hidden" name="scope" value="${escape(authReq.scope.join(" "))}">
  <input type="hidden" name="loginKey" value="">
  <input type="hidden" name="assertion" value="">
  <label for="email">Your bullmoose address</label>
  <input id="email" name="email" type="email" autocomplete="username" required spellcheck="false">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <p id="err" class="err">${error ? escape(error) : ""}</p>
  <div class="row">
    <button class="passkey" type="button">Sign in with a passkey</button>
    <button class="approve" type="submit" name="decision" value="approve">${firstParty ? "Sign in" : "Approve"}</button>
    <button class="deny" type="submit" name="decision" value="deny">Cancel</button>
  </div>
</form>
<script src="${DERIVE_PATH}"></script>`;
  return new Response(body, {
    status: error ? 401 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // `form-action 'self'` is the browser's own refusal to let this form
      // post anywhere else; `frame-ancestors 'none'` stops the approve button
      // being clickjacked. Both are the reason the script is a file and not
      // inline — 'unsafe-inline' on the password page is not a trade worth
      // making for one <script> tag.
      // ⚠️ `form-action` MUST name the redirect origin, and this is the least
      // obvious line on the page. Chrome enforces form-action against the
      // REDIRECT TARGET of a form submission, not just its action: with
      // `form-action 'self'` the POST to /authorize succeeded, returned its
      // 302 to app.bullmoose.cc with a valid code — and the browser then
      // refused to follow it. Sign-in hung on "Checking…" forever. Nothing
      // failed anywhere a log could see it: the AS recorded a successful
      // authorization, and the code was simply never delivered.
      //
      // Naming the origin is not a widening of trust. `authReq.redirectUri`
      // has ALREADY been validated against the client's registered redirects
      // before this page renders, so this says only "the destination the AS
      // just approved" — which is exactly what the directive should permit.
      "content-security-policy":
        `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; ` +
        `form-action 'self'${formTarget ? ` ${formTarget}` : ""}; frame-ancestors 'none'; base-uri 'none'`,
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
