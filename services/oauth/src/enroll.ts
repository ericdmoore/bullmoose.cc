import { hashLoginKey, isLoginKey, loginSaltHex, LOGIN_KEY_ALGO, LOGIN_KEY_ITERATIONS } from "@bullmoose/auth-core";
import { DERIVE_PATH } from "./consent.js";

/**
 * /enroll — the door a SECOND HUMAN arrives through (s33 day-one, #213).
 *
 * The operator provisioned the account and holds a one-time link; the token
 * rides the URL FRAGMENT, which the browser never sends — the AS's own access
 * logs cannot see it, and no Referer can carry it. A small page script moves
 * it from `location.hash` into the form, and the POST is its only trip to the
 * server, where it is consumed atomically.
 *
 * The enrollee types the bullmoose address they were told, and it must match
 * the token's principal — a cheap confirmation that they know WHICH account
 * they are claiming, and the same defence-in-depth as the consent screen's
 * redirect line: what the link cannot prove, the human confirms.
 *
 * The password never leaves their browser. The SAME `/derive.<hash>.js` the
 * login page ships derives the PBKDF2 login key client-side, so this worker
 * stores a hash of a derivative and the operator, the logs and the wire never
 * hold the password itself.
 *
 * ⚠️ ALREADY-ENROLLED REFUSES. A principal with a credentials row cannot be
 * re-enrolled through this door: a leaked or replayed link must not become an
 * account takeover. Changing a credential is recovery's job, behind its own
 * ceremony — this door only ARRIVES.
 */

interface EnrollEnv {
  DB: D1Database;
}

const sha256hex = async (s: string): Promise<string> => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.35rem; margin-bottom: .25rem; }
  .sub { color: #666; margin-top: 0; }
  .err { color: #b91c1c; font-weight: 600; }
  label { display: block; margin: 1rem 0 .35rem; font-weight: 600; }
  input { width: 100%; padding: .55rem .6rem; font: inherit; border-radius: .4rem; border: 1px solid #bbb; box-sizing: border-box; }
  button { font: inherit; padding: .6rem 1.1rem; border-radius: .4rem; border: 1px solid transparent; cursor: pointer;
           background: #1d4ed8; color: #fff; font-weight: 600; margin-top: 1.5rem; }
`;

export function enrollPage(error?: string): Response {
  const body = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Welcome to bullmoose</title>
<style>${STYLE}</style>
<h1>Welcome to bullmoose</h1>
<p class="sub">Set your password. It is yours alone — it never leaves this page, and nobody else has ever known it.</p>
<form id="enroll" method="post" action="/enroll">
  <input type="hidden" name="token" value="">
  <input type="hidden" name="loginKey" value="">
  <label for="email">Your new bullmoose address</label>
  <input id="email" name="email" type="email" autocomplete="username" required spellcheck="false"
         placeholder="you@bullmoose.cc">
  <label for="password">Choose a password</label>
  <input id="password" name="password" type="password" autocomplete="new-password" required minlength="12">
  <label for="confirm">Type it again</label>
  <input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength="12">
  <p id="err" class="err">${error ? escapeHtml(error) : ""}</p>
  <button type="submit">Set my password</button>
</form>
<script src="${DERIVE_PATH}"></script>
<script src="/enroll.js"></script>`;
  return new Response(body, {
    status: error ? 400 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Same posture as consent: a credential page is never cached, never
      // framed, and its form posts only here.
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

/** The page script — external, like derive.js, so the CSP needs no inline. */
export function enrollScript(): Response {
  const js = `
const form = document.getElementById("enroll");
// The token rides the FRAGMENT so no server log ever saw it. Move it into the
// form, then clear the fragment so a shoulder-surfed address bar shows less.
form.token.value = (location.hash || "").slice(1);
try { history.replaceState(null, "", location.pathname); } catch {}
const approve = form.querySelector("button");
form.addEventListener("submit", async (ev) => {
  const button = ev.submitter || approve;
  ev.preventDefault();
  const err = document.getElementById("err");
  if (!form.token.value) { err.textContent = "This link is incomplete — ask for a fresh one."; return; }
  if (form.password.value !== form.confirm.value) { err.textContent = "The two passwords do not match."; return; }
  const label = button ? button.textContent : "";
  try {
    if (button) { button.disabled = true; button.textContent = "Setting…"; }
    form.loginKey.value = await deriveLoginKey(form.email.value.trim(), form.password.value);
    // The raw password never reaches the network.
    form.password.value = ""; form.confirm.value = "";
    form.submit();
  } catch (e) {
    if (button) { button.disabled = false; button.textContent = label; }
    err.textContent = "Could not set the password: " + e;
  }
});
`;
  return new Response(js, {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=60" },
  });
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** POST /enroll — consume the token, verify the claim, set the credential. */
export async function handleEnroll(request: Request, env: EnrollEnv): Promise<Response> {
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  const loginKey = String(form.get("loginKey") ?? "");
  if (!token || !email || !isLoginKey(loginKey)) {
    return enrollPage("Something was missing — try the link again.");
  }

  const row = await env.DB.prepare(
    `SELECT e.id, e.principal_id, e.expires_at, e.consumed_at, p.login_email AS principal_email
       FROM enrollments e JOIN principals p ON p.id = e.principal_id
      WHERE e.secret_hash = ? LIMIT 1`,
  )
    .bind(await sha256hex(token))
    .first<{
      id: string;
      principal_id: string;
      expires_at: number;
      consumed_at: number | null;
      principal_email: string;
    }>();

  // Distinct refusals, so the human knows which conversation to have.
  if (!row) return enrollPage("This link is not recognized — ask for a fresh one.");
  if (row.consumed_at !== null) return enrollPage("This link was already used. If that wasn't you, say so now.");
  if (row.expires_at < Date.now()) return enrollPage("This link has expired — ask for a fresh one.");
  if (row.principal_email.toLowerCase() !== email) {
    return enrollPage("That address does not match this invitation — check what you were sent.");
  }

  // A leaked link must not become a takeover: arrival only, never a reset.
  const existing = await env.DB.prepare(`SELECT 1 AS hit FROM credentials WHERE principal_id = ? LIMIT 1`)
    .bind(row.principal_id)
    .first<{ hit: number }>();
  if (existing) return enrollPage("This account is already set up. To change a password, use recovery instead.");

  // Consume FIRST, atomically — two tabs racing must set at most one credential.
  const consumed = await env.DB.prepare(`UPDATE enrollments SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`)
    .bind(Date.now(), row.id)
    .run();
  if (consumed.meta.changes === 0) return enrollPage("This link was already used. If that wasn't you, say so now.");

  await env.DB.prepare(
    `INSERT INTO credentials (principal_id, pw_algo, pw_hash, pw_salt, pw_iters, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.principal_id,
      LOGIN_KEY_ALGO,
      await hashLoginKey(loginKey),
      await loginSaltHex(email),
      LOGIN_KEY_ITERATIONS,
      Date.now(),
    )
    .run();

  return new Response(null, { status: 303, headers: { location: "https://app.bullmoose.cc/login" } });
}
