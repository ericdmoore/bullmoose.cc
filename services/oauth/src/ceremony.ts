import { assertionOptions, verifyAssertion, type WebAuthnEnv } from "./webauthn.js";

/**
 * /ceremony — "that you, Kevin?" (s33 slice 4, the tea ceremony proper).
 *
 * The page must state WHAT IT AUTHORIZES — "Approve: hr@ disclosing your
 * 401(k) balance in reply to a message sent at 3:04 AM" — because a
 * click-through means nothing: with the act described, the passkey stops
 * being authentication and becomes APPROVAL OF A DESCRIBED ACT, the same
 * principle the approvals queue runs on. The description renders from the
 * ROW the agent wrote, never from anything in the URL: what the human
 * approves is what was recorded as asked.
 *
 * The slow part is the point (a tea ceremony's steps are meant to be
 * observed): read the description, then one authenticator gesture. The
 * assertion is purpose-bound to THIS ceremony id, so a login challenge —
 * or another ceremony's — cannot satisfy it, however valid its signature.
 *
 * A PASS marks the row `passed`; the ROW is the capability (schema note:
 * no bearer is minted, so no plaintext exists to custody) — the agent-side
 * gate checks it directly and consumes it once. A FAIL marks the row
 * `failed` and the page says only that; the notice to the enrolled human
 * (s33 OQ5: "failed step-up is a signal the real person should see") rides
 * the agent-side slice, which owns outbound mail.
 */

interface CeremonyEnv extends WebAuthnEnv {
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
  .act { border: 1px solid #bbb; border-radius: .5rem; padding: 1rem 1.25rem; margin: 1.25rem 0; font-size: 1.05rem; }
  .meta { color: #666; font-size: .9rem; }
  .err { color: #b91c1c; font-weight: 600; min-height: 1.5em; }
  .ok { color: #15803d; font-weight: 600; }
  button { font: inherit; padding: .6rem 1.1rem; border-radius: .4rem; border: 1px solid transparent; cursor: pointer;
           background: #1d4ed8; color: #fff; font-weight: 600; }
  button:disabled { opacity: .5; cursor: default; }
`;

export function ceremonyPage(): Response {
  const body = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Approve this act?</title>
<style>${STYLE}</style>
<h1>Approve this act?</h1>
<p class="meta">An agent on your account is asking to do something that needs <em>you</em> —
read what it is, then approve with your passkey, or close this page to refuse by silence.</p>
<div class="act" id="act">Loading what you are being asked to approve…</div>
<p class="meta" id="expiry"></p>
<p id="err" class="err"></p>
<p id="outcome"></p>
<button id="go" disabled>Approve with my passkey</button>
<script src="/ceremony.js"></script>`;
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export function ceremonyScript(): Response {
  const js = `
const token = (location.hash || "").replace(/^#/, "");
try { history.replaceState(null, "", location.pathname); } catch {}
const act = document.getElementById("act");
const err = document.getElementById("err");
const expiry = document.getElementById("expiry");
const outcome = document.getElementById("outcome");
const go = document.getElementById("go");

const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/[+]/g, "-").replace(/[/]/g, "_").replace(/=+$/, "");

let publicKey = null;
(async () => {
  if (!token) { act.textContent = "This link is incomplete — ask for a fresh one."; return; }
  const res = await fetch("/ceremony/begin", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  });
  const data = await res.json();
  if (!res.ok) { act.textContent = data.error || "This ceremony is not available."; return; }
  act.textContent = data.description;
  expiry.textContent = "Expires " + new Date(data.expiresAt).toLocaleTimeString() + ". A pass authorizes this one act, once.";
  publicKey = data.publicKey;
  go.disabled = false;
})();

go.addEventListener("click", async () => {
  err.textContent = "";
  go.disabled = true;
  try {
    const pk = { ...publicKey, challenge: unb64u(publicKey.challenge) };
    const cred = await navigator.credentials.get({ publicKey: pk });
    const res = await fetch("/ceremony/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        assertion: {
          id: cred.id,
          response: {
            clientDataJSON: b64u(cred.response.clientDataJSON),
            authenticatorData: b64u(cred.response.authenticatorData),
            signature: b64u(cred.response.signature),
          },
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) { err.textContent = data.error || "That did not verify."; go.disabled = false; return; }
    outcome.className = "ok";
    outcome.textContent = "Approved. The agent may now do exactly what is written above, once. You can close this page.";
    go.remove();
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

interface CeremonyRow {
  id: string;
  principal_id: string;
  category: string;
  description: string;
  status: string;
  expires_at: number;
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** The gate every ceremony call runs: real link, still pending, still alive.
 *  Refusals are distinct but never leak whether other ceremonies exist. */
async function gate(env: CeremonyEnv, token: string): Promise<{ row: CeremonyRow } | { error: string }> {
  if (!token) return { error: "Something was missing — try the link again." };
  const row = await env.DB.prepare(
    `SELECT id, principal_id, category, description, status, expires_at
       FROM ceremonies WHERE secret_hash = ? LIMIT 1`,
  )
    .bind(await sha256hex(token))
    .first<CeremonyRow>();
  if (!row) return { error: "This ceremony is not recognized — ask the agent to start again." };
  if (row.status !== "pending") return { error: "This ceremony was already decided. Each link answers exactly once." };
  if (row.expires_at < Date.now())
    return { error: "This ceremony has expired — the ask was minutes-old for a reason. Start again." };
  return { row };
}

/** POST /ceremony/begin — the described act (from the ROW) + options bound
 *  to this ceremony's own purpose. */
export async function ceremonyBegin(request: Request, env: CeremonyEnv): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { token?: string };
  const gated = await gate(env, body.token ?? "");
  if ("error" in gated) return json({ error: gated.error }, 422);
  return json({
    description: gated.row.description,
    category: gated.row.category,
    expiresAt: gated.row.expires_at,
    publicKey: await assertionOptions(env, `ceremony:${gated.row.id}`),
  });
}

/** POST /ceremony/verify — the assertion, the principal match, the verdict. */
export async function ceremonyVerify(request: Request, env: CeremonyEnv): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    token?: string;
    assertion?: Parameters<typeof verifyAssertion>[2];
  };
  const gated = await gate(env, body.token ?? "");
  if ("error" in gated) return json({ error: gated.error }, 422);

  const outcome = await verifyAssertion(env, `ceremony:${gated.row.id}`, body.assertion ?? {});
  const now = Date.now();
  if ("refused" in outcome) {
    // A failed attempt DECIDES the ceremony: retrying a failed step-up on
    // the same link would give an attacker with the link unlimited tries at
    // convincing the wrong human. One link, one answer — and the fail is a
    // signal the agent-side slice relays to the enrolled address (OQ5).
    await env.DB.prepare(`UPDATE ceremonies SET status = 'failed', decided_at = ? WHERE id = ? AND status = 'pending'`)
      .bind(now, gated.row.id)
      .run();
    return json({ error: "That did not verify. This ask is now closed; the account owner will be told." }, 422);
  }
  if (outcome.principalId !== gated.row.principal_id) {
    // A VALID passkey belonging to someone else: cryptographically fine,
    // and exactly the wrong person. Decided as failed, same reasoning.
    await env.DB.prepare(`UPDATE ceremonies SET status = 'failed', decided_at = ? WHERE id = ? AND status = 'pending'`)
      .bind(now, gated.row.id)
      .run();
    return json({ error: "That passkey does not belong to this account's owner. This ask is now closed." }, 422);
  }

  // The atomic PASS: only a still-pending row flips, so a raced double
  // verify cannot approve twice.
  const passed = await env.DB.prepare(
    `UPDATE ceremonies SET status = 'passed', decided_at = ? WHERE id = ? AND status = 'pending'`,
  )
    .bind(now, gated.row.id)
    .run();
  if (passed.meta.changes === 0) {
    return json({ error: "This ceremony was already decided. Each link answers exactly once." }, 422);
  }
  return json({ passed: true, category: gated.row.category });
}
