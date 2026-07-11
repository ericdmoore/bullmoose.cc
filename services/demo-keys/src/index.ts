/**
 * bullmoose-demo-keys — issues and verifies demo key phrases for demo@bullmoose.cc.
 *
 * Two endpoints, deliberately asymmetric:
 *
 *   GET  /demo            self-serve page: Turnstile widget → mint → line to paste
 *   POST /demo/request    mint a phrase           (Turnstile-gated + IP rate-limited)
 *   POST /demo/verify     validate + record use   (INTERNAL_TOKEN, called by the
 *                                                  mail bridge on alpaca)
 *
 * The bridge holds a bearer token for /demo/verify and nothing else. It never gets
 * KV credentials, so a compromised mail box cannot mint itself keys or read the
 * key space — it can only ask "is this one phrase good?" and be told yes or no.
 *
 * Lifecycle: multi-use, expiring, leak-detecting.
 *   multi-use  — people reply, and the reply quotes the phrase; the thread keeps
 *                working. A single-use key would break on the second email.
 *   expiring   — 30 days, enforced here AND by KV TTL so dead keys self-collect.
 *   leak-detect— a phrase is issued to one person. If it shows up from more than
 *                MAX_SENDERS distinct addresses it has been forwarded or posted, so
 *                it revokes itself. This is what replaces "one-time-use": the key
 *                dies when it spreads, not when it's used.
 */
import { WORDS } from "./words";

export interface Env {
  DEMO_KEYS: KVNamespace;
  INTERNAL_TOKEN: string;
  // Cloudflare Turnstile. SECRET is a wrangler secret; SITEKEY is public and lives in
  // `vars` (it's embedded in the page HTML, so there's nothing to hide). Both must be
  // present or /demo/request fails closed — see turnstileOk. This is the only real
  // guard on public minting; the per-IP cap alone folds to a botnet.
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITEKEY?: string;
}

const WORDS_PER_PHRASE = 4;
const TTL_DAYS = 30;
const MAX_SENDERS = 3; // work + personal + phone is plausible; a mailing list is not
const MINTS_PER_IP_PER_DAY = 3;

interface KeyRecord {
  issued: string;
  expires: string;
  senders: string[];
  uses: number;
  lastUsed: string | null;
  revoked: boolean;
  revokedReason?: string;
}

/**
 * Fold a phrase to its canonical form. Applied identically at mint and at verify,
 * so quoting, capitalisation, smart punctuation and wrapped whitespace all survive
 * the round trip: "> Demo-Key: Bugfish, Colibri..." still matches what we stored.
 */
function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function mintPhrase(): string {
  // Rejection-sample so the modulo doesn't bias the tail of the wordlist. WORDS is
  // 4096 = 2^12, so a 16-bit draw is unbiased anyway, but don't rely on that staying
  // true if the list is ever resized.
  const out: string[] = [];
  const buf = new Uint32Array(WORDS_PER_PHRASE * 2);
  const limit = Math.floor(0xffffffff / WORDS.length) * WORDS.length;
  let i = buf.length; // force a fill on the first pass
  while (out.length < WORDS_PER_PHRASE) {
    if (i >= buf.length) {
      crypto.getRandomValues(buf);
      i = 0;
    }
    const n = buf[i++]!;
    if (n < limit) out.push(WORDS[n % WORDS.length]!);
  }
  return out.join(" ");
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function turnstileOk(env: Env, req: Request, token: string | undefined) {
  // Fail CLOSED: a misconfigured deploy (secret not set) must not silently drop the
  // challenge and mint to anyone. If Turnstile isn't wired, nobody gets a key.
  if (!env.TURNSTILE_SECRET) return false;
  if (!token) return false;
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET,
      response: token,
      remoteip: req.headers.get("cf-connecting-ip") ?? undefined,
    }),
  });
  const body = (await r.json()) as { success?: boolean };
  return body.success === true;
}

async function handleRequest(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const body = (await req.json().catch(() => ({}))) as { turnstile?: string };

  if (!(await turnstileOk(env, req, body.turnstile))) {
    return json({ error: "challenge_failed" }, 403);
  }

  const ipKey = `ip:${ip}`;
  const mints = Number((await env.DEMO_KEYS.get(ipKey)) ?? "0");
  if (mints >= MINTS_PER_IP_PER_DAY) {
    return json({ error: "rate_limited", retry: "24h" }, 429);
  }
  await env.DEMO_KEYS.put(ipKey, String(mints + 1), { expirationTtl: 86400 });

  const phrase = mintPhrase();
  const now = new Date();
  const expires = new Date(now.getTime() + TTL_DAYS * 86400_000);
  const rec: KeyRecord = {
    issued: now.toISOString(),
    expires: expires.toISOString(),
    senders: [],
    uses: 0,
    lastUsed: null,
    revoked: false,
  };
  await env.DEMO_KEYS.put(`k:${normalize(phrase)}`, JSON.stringify(rec), {
    // KV reaps the record on its own, so an abandoned key can't linger as a
    // credential just because nothing swept the namespace.
    expirationTtl: TTL_DAYS * 86400,
  });

  return json({ phrase, expires: rec.expires, line: `demo-key: ${phrase}` });
}

async function handleVerify(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // Constant-time-ish: compare full strings, never short-circuit on a prefix.
  if (!env.INTERNAL_TOKEN || presented.length !== env.INTERNAL_TOKEN.length) {
    return json({ ok: false, reason: "unauthorized" }, 401);
  }
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ env.INTERNAL_TOKEN.charCodeAt(i);
  }
  if (diff !== 0) return json({ ok: false, reason: "unauthorized" }, 401);

  const { phrase, sender } = (await req.json().catch(() => ({}))) as {
    phrase?: string;
    sender?: string;
  };
  if (!phrase || !sender) return json({ ok: false, reason: "bad_request" }, 400);

  const canonical = normalize(phrase);
  const raw = await env.DEMO_KEYS.get(`k:${canonical}`);
  if (!raw) return json({ ok: false, reason: "unknown" });

  const rec = JSON.parse(raw) as KeyRecord;
  if (rec.revoked) return json({ ok: false, reason: "revoked" });
  if (new Date(rec.expires) <= new Date()) return json({ ok: false, reason: "expired" });

  const from = sender.trim().toLowerCase();
  const known = rec.senders.includes(from);
  if (!known && rec.senders.length >= MAX_SENDERS) {
    // Seen from too many addresses — forwarded, posted publicly, or shared. Kill it,
    // and don't serve this request either.
    rec.revoked = true;
    rec.revokedReason = `leaked: used by >${MAX_SENDERS} senders`;
    await env.DEMO_KEYS.put(`k:${canonical}`, JSON.stringify(rec), {
      expirationTtl: TTL_DAYS * 86400,
    });
    return json({ ok: false, reason: "revoked_leaked" });
  }

  if (!known) rec.senders.push(from);
  rec.uses += 1;
  rec.lastUsed = new Date().toISOString();
  await env.DEMO_KEYS.put(`k:${canonical}`, JSON.stringify(rec), {
    expirationTtl: TTL_DAYS * 86400,
  });

  // Echo the canonical phrase back: the bridge strips exactly this string from the
  // body before the model sees it, and scrubs it from the reply on the way out.
  return json({ ok: true, phrase: canonical, uses: rec.uses });
}

function page(sitekey: string): string {
  return `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<title>bullmoose demo key</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<style>
 body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1rem}
 code{background:#f4f4f5;padding:.15em .4em;border-radius:4px}
 pre{background:#f4f4f5;padding:1rem;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
 button{font:inherit;padding:.6em 1.2em;border-radius:8px;border:1px solid #999;cursor:pointer}
 button[disabled]{opacity:.5;cursor:not-allowed}
 .cf-turnstile{margin:1rem 0}
 @media(prefers-color-scheme:dark){body{background:#111;color:#eee}code,pre{background:#222}}
</style>
<h1>Try the bullmoose demo</h1>
<p>Get a key phrase, then email <code>demo@bullmoose.cc</code> with the phrase on its
own line. Ask it anything about bullmoose.</p>
<div class=cf-turnstile data-sitekey="${sitekey}" data-callback=onTurnstile
     data-theme=auto data-expired-callback=onExpire data-error-callback=onExpire></div>
<button id=go disabled>Get a key phrase</button>
<div id=out></div>
<script>
// The widget solves on load; enable the button only once we hold a token, and drop it
// again if the token expires — so a click always carries a fresh challenge response.
let token = "";
window.onTurnstile = (t) => { token = t; document.getElementById('go').disabled = false; };
window.onExpire = () => { token = ""; document.getElementById('go').disabled = true; };
document.getElementById('go').onclick = async () => {
  const btn = document.getElementById('go');
  btn.disabled = true;
  const r = await fetch('/demo/request', {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ turnstile: token }),
  });
  const d = await r.json();
  document.getElementById('out').innerHTML = d.error
    ? '<p>Sorry — ' + d.error + '. Please solve the challenge again.</p>'
    : '<p>Include this line in your email:</p><pre>' + d.line + '</pre><p>Valid until ' + new Date(d.expires).toDateString() + '.</p>';
  // A token is single-use server-side; reset the widget for another go.
  token = ""; if (window.turnstile) window.turnstile.reset();
};
</script>`;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/demo") {
      // Treat a missing OR unreplaced-placeholder sitekey as "not configured" — don't
      // serve a page whose widget can't solve. (Minting fails closed regardless, on
      // TURNSTILE_SECRET; this guard is just so the page isn't visibly broken.)
      const sitekey = env.TURNSTILE_SITEKEY;
      if (!sitekey || sitekey.startsWith("REPLACE_")) {
        return new Response("demo temporarily unavailable", { status: 503 });
      }
      return new Response(page(sitekey), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (req.method === "POST" && pathname === "/demo/request") return handleRequest(req, env);
    if (req.method === "POST" && pathname === "/demo/verify") return handleVerify(req, env);
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
