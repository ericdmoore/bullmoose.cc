import {
  credentialCount,
  creationOptions,
  verifyRegistration,
  REQUIRED_AUTHENTICATORS,
  type WebAuthnEnv,
} from "./webauthn.js";

/**
 * /enroll — the door a SECOND HUMAN arrives through (s33 day-one, #213).
 *
 * The operator provisioned the account and holds a one-time link; the token
 * rides the URL FRAGMENT, which the browser never sends — the AS's own access
 * logs cannot see it, and no Referer can carry it. The page script moves it
 * from `location.hash` into memory, and it travels only in the ceremony
 * POSTs, where the row is validated each time and consumed at completion.
 *
 * The enrollee types the bullmoose address they were told, and it must match
 * the token's principal — a cheap confirmation that they know WHICH account
 * they are claiming, and the same defence-in-depth as the consent screen's
 * redirect line: what the link cannot prove, the human confirms.
 *
 * ⚠️ NO PASSWORD. The credential rule (Eric, 2026-08-21): there is no
 * account password at all — "the operator knows your password" evaporates
 * because there is nothing to know. The account completes with TWO WebAuthn
 * authenticators (any ONE satisfies a later ceremony); the second is
 * enrolled here and now because a single authenticator guarantees a
 * recovery event, and WebAuthn's hybrid (QR) transport means the phone can
 * be the second authenticator from the laptop's page.
 *
 * ⚠️ ALREADY-ENROLLED REFUSES. A principal with a completed enrollment (two
 * passkeys) or a legacy password credential cannot come through this door:
 * a leaked or replayed link must not become an account takeover. Changing a
 * credential is recovery's job — this door only ARRIVES. Between the first
 * and second passkey the link stays live (bounded by its expiry): both
 * registrations are one arrival, and the row is consumed when the second
 * lands.
 */

interface EnrollEnv extends WebAuthnEnv {
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
  .err { color: #b91c1c; font-weight: 600; min-height: 1.5em; }
  .ok { color: #15803d; font-weight: 600; }
  label { display: block; margin: 1rem 0 .35rem; font-weight: 600; }
  input { width: 100%; padding: .55rem .6rem; font: inherit; border-radius: .4rem; border: 1px solid #bbb; box-sizing: border-box; }
  button { font: inherit; padding: .6rem 1.1rem; border-radius: .4rem; border: 1px solid transparent; cursor: pointer;
           background: #1d4ed8; color: #fff; font-weight: 600; margin-top: 1.5rem; }
  button:disabled { opacity: .5; cursor: default; }
`;

export function enrollPage(): Response {
  const body = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Welcome to bullmoose</title>
<style>${STYLE}</style>
<h1>Welcome to bullmoose</h1>
<p class="sub">Your account is unlocked by passkeys — there is no password, so nobody (including us) can know one.
You will register <strong>two</strong>: this device now, and a second one (your phone works, via the QR your
browser shows) so losing one device never locks you out.</p>
<label for="email">Your new bullmoose address</label>
<input id="email" type="email" autocomplete="off" placeholder="you@your-domain">
<p id="err" class="err"></p>
<p id="progress"></p>
<button id="go">Register this device's passkey</button>
<script src="/enroll.js"></script>`;
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export function enrollScript(): Response {
  const js = `
const token = (location.hash || "").replace(/^#/, "");
try { history.replaceState(null, "", location.pathname); } catch {}
const err = document.getElementById("err");
const progress = document.getElementById("progress");
const go = document.getElementById("go");
const email = document.getElementById("email");
let done = 0;

// base64url <-> the ArrayBuffers the WebAuthn API insists on.
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/[+]/g, "-").replace(/[/]/g, "_").replace(/=+$/, "");

go.addEventListener("click", async () => {
  err.textContent = "";
  if (!token) { err.textContent = "This link is incomplete — ask for a fresh one."; return; }
  if (!email.value.trim()) { err.textContent = "Type the address you were invited to."; return; }
  go.disabled = true;
  try {
    const optRes = await fetch("/enroll/webauthn/options", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, email: email.value.trim() }),
    });
    const opt = await optRes.json();
    if (!optRes.ok) { err.textContent = opt.error || "That did not work — try again."; go.disabled = false; return; }
    const pk = opt.publicKey;
    pk.challenge = unb64u(pk.challenge);
    pk.user.id = unb64u(pk.user.id);
    pk.excludeCredentials = (pk.excludeCredentials || []).map((c) => ({ ...c, id: unb64u(c.id) }));
    const cred = await navigator.credentials.create({ publicKey: pk });
    const regRes = await fetch("/enroll/webauthn/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token, email: email.value.trim(),
        credential: {
          id: cred.id,
          response: {
            clientDataJSON: b64u(cred.response.clientDataJSON),
            attestationObject: b64u(cred.response.attestationObject),
          },
        },
      }),
    });
    const reg = await regRes.json();
    if (!regRes.ok) { err.textContent = reg.error || "Registration failed — try again."; go.disabled = false; return; }
    done = reg.count;
    if (reg.complete) {
      progress.className = "ok";
      progress.textContent = "Both passkeys registered — your account is complete. You can close this page.";
      go.remove(); email.disabled = true;
    } else {
      progress.textContent = "Passkey " + done + " of ${REQUIRED_AUTHENTICATORS} registered.";
      go.textContent = "Register your second device (phone via QR works)";
      go.disabled = false;
    }
  } catch (e) {
    err.textContent = "The passkey step did not complete: " + (e && e.message ? e.message : e);
    go.disabled = false;
  }
});
`;
  return new Response(js, {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=60" },
  });
}

interface EnrollmentRow {
  id: string;
  principal_id: string;
  expires_at: number;
  consumed_at: number | null;
  principal_email: string;
}

/**
 * The door's gate, run per ceremony call: the row must exist, be unexpired,
 * unconsumed, match the typed address — and the principal must still be
 * ARRIVING (no completed passkey set, no legacy password credential).
 * Refusal strings are distinct so the human knows which conversation to
 * have; they are the page's whole error surface.
 */
async function gate(env: EnrollEnv, token: string, email: string): Promise<{ row: EnrollmentRow } | { error: string }> {
  if (!token || !email) return { error: "Something was missing — try the link again." };
  const row = await env.DB.prepare(
    `SELECT e.id, e.principal_id, e.expires_at, e.consumed_at, p.login_email AS principal_email
       FROM enrollments e JOIN principals p ON p.id = e.principal_id
      WHERE e.secret_hash = ? LIMIT 1`,
  )
    .bind(await sha256hex(token))
    .first<EnrollmentRow>();
  if (!row) return { error: "This link is not recognized — ask for a fresh one." };
  if (row.consumed_at !== null) return { error: "This link was already used. If that wasn't you, say so now." };
  if (row.expires_at < Date.now()) return { error: "This link has expired — ask for a fresh one." };
  if (row.principal_email.toLowerCase() !== email.toLowerCase()) {
    return { error: "That address does not match this invitation — check what you were sent." };
  }
  if ((await credentialCount(env, row.principal_id)) >= REQUIRED_AUTHENTICATORS) {
    return { error: "This account is already set up. To change a passkey, use recovery instead." };
  }
  const legacy = await env.DB.prepare(`SELECT 1 AS hit FROM credentials WHERE principal_id = ? LIMIT 1`)
    .bind(row.principal_id)
    .first<{ hit: number }>();
  if (legacy) return { error: "This account is already set up. To change how you sign in, use recovery instead." };
  return { row };
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** POST /enroll/webauthn/options — the gate, then creation options. */
export async function enrollOptions(request: Request, env: EnrollEnv): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { token?: string; email?: string };
  const gated = await gate(env, body.token ?? "", body.email ?? "");
  if ("error" in gated) return json({ error: gated.error }, 422);
  return json({
    publicKey: await creationOptions(env, { id: gated.row.principal_id, email: gated.row.principal_email }),
  });
}

/** POST /enroll/webauthn/register — the gate, the ceremony, and — when this
 *  was the second authenticator — the atomic consume that closes the door. */
export async function enrollRegister(request: Request, env: EnrollEnv): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    token?: string;
    email?: string;
    credential?: { id?: string; response?: { clientDataJSON?: string; attestationObject?: string } };
  };
  const gated = await gate(env, body.token ?? "", body.email ?? "");
  if ("error" in gated) return json({ error: gated.error }, 422);

  const outcome = await verifyRegistration(env, gated.row.principal_id, body.credential ?? {});
  if ("refused" in outcome) return json({ error: outcome.refused }, 422);

  const complete = outcome.count >= REQUIRED_AUTHENTICATORS;
  if (complete) {
    // Consume on completion — the row is the audit record of one arrival.
    await env.DB.prepare(`UPDATE enrollments SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`)
      .bind(Date.now(), gated.row.id)
      .run();
  }
  return json({ credentialId: outcome.credentialId, count: outcome.count, complete });
}
