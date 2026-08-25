// The passkey tea ceremony, driven through a real browser (s33 slice 4).
//
// ## What this covers that the unit tests do not
//
// services/oauth/src/{ceremony,webauthn}.test.ts are thorough and use REAL
// P-256 crypto: clone detection, someone else's passkey, purpose binding,
// replay, lookalike origins, missing user presence. Do not duplicate them.
//
// What they cannot reach is the BROWSER HALF, because they build the assertion
// in Node and hand it straight to the verifier:
//
//   1. `/ceremony.js` — the page's own script. It reads the token from
//      `location.hash`, decodes `challenge` from base64url, calls
//      `navigator.credentials.get`, and re-encodes three fields on the way
//      back. Every one of those is a place a wrong field name or a missing
//      decode breaks every real ceremony while all unit tests pass. Today the
//      only assertion about this file is that it never embeds the act.
//
//   2. DISCOVERABILITY. `assertionOptions` sends `allowCredentials: []`, so
//      the browser must FIND the credential with no hint — it must be a
//      discoverable (resident) credential. A unit test never asks a browser
//      to find anything, so nothing checks that what enrollment created is
//      the kind of thing the ceremony can later use.
//
//   3. Chrome's real WebAuthn output satisfying our CBOR/COSE/DER parsing.
//      The unit tests use our own forge, so our assumptions are tested
//      against themselves.
//
// ## No thumbs required
//
// Chrome DevTools Protocol's WebAuthn domain provides a virtual authenticator.
// `automaticPresenceSimulation` IS the thumb: the "touch your key" gesture is
// satisfied by the browser. Everything else stays real — real WebAuthn, real
// signatures, real server verification.
//
// The seam is deliberately IN THE BROWSER, never in our code. A test-only
// bypass (`TEST_MODE`, a stubbed verifier) would hollow out precisely the code
// the ceremony exists to protect, and would ship a backdoor to production in
// order to test a security feature.
//
// ## Running it
//
//   infra/localDev.sh --seed      # oauth on :8790
//   node tools/e2e-ceremony.mjs
//
// CDP_URL connects to an already-running browser (e.g. Helium on :9333);
// otherwise a headless Chromium is launched and torn down.

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The RP ID and the expected origin are `auth.bullmoose.cc` / `https://auth.bullmoose.cc`,
// and webauthn.ts compares the origin with STRICT EQUALITY — as it should. So
// the page has to be served from exactly that origin, port and all.
//
// The alternative was making the expected origin configurable so a local port
// could match. That is a knob on the one check WebAuthn exists to perform, added
// to suit a test — so instead the browser is told to resolve the real hostname
// at our dev port, and the seam stays where it belongs: in the browser, never in
// the server. Nothing test-shaped ships.
const ORIGIN = process.env.ORIGIN ?? "https://auth.bullmoose.cc";
const LOCAL_PORT = Number(process.env.OAUTH_PORT ?? 8790);
const CDP_URL = process.env.CDP_URL ?? "";
const D1 = "bullmoose-mail-shard0";
const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

let failures = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m, detail) => {
  failures++;
  console.error(`  ✗ ${m}`);
  if (detail) console.error(`      ${String(detail).split("\n").slice(0, 4).join("\n      ")}`);
};
const assert = (cond, m, detail) => (cond ? pass(m) : fail(m, detail));

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

/** Local D1, through the same wrangler the dev servers use. */
function sql(statement) {
  try {
    return run(statement);
  } catch (e) {
    // execFileSync's default message is just the command line, so a schema
    // mismatch reads as "the insert failed" with no reason. wrangler puts the
    // SQLite error on stdout as JSON; surface it or lose the afternoon.
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    const m = /"text":\s*"([^"]+)"/.exec(out);
    throw new Error(`${m ? m[1] : out.trim().slice(0, 300)}\n      while running: ${statement.trim().split("\n")[0]}`);
  }
}

function run(statement) {
  return execFileSync(
    "npx",
    ["wrangler", "d1", "execute", D1, "--local", "--json", "--command", statement],
    // services/oauth, NOT services/jmap: wrangler keeps local D1 state beside
    // the config it was launched with, so seeding from a different service
    // writes a database the oauth dev server will never read — the tables
    // appear to exist and every query still fails.
    { cwd: join(ROOT, "services/oauth"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

// ---------------------------------------------------------------- CDP

/** One CDP session. Node 22 has a native WebSocket, so no dependency. */
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error(`cannot open ${wsUrl}`));
  });
  let next = 1;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { res, rej } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
    } else if (msg.method) events.push(msg);
  };
  return {
    send(method, params = {}, sessionId) {
      const id = next++;
      return new Promise((res, rej) => {
        waiting.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        setTimeout(() => waiting.has(id) && (waiting.delete(id), rej(new Error(`${method} timed out`))), 20_000);
      });
    },
    events,
    close: () => ws.close(),
  };
}

/** Evaluate in the page and return the value (throws on page-side throw). */
async function evaluate(sess, sessionId, expression) {
  const r = await sess.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result?.value;
}

/** Poll a page-side predicate. Browser work is asynchronous and unlogged; a
 *  fixed sleep is how these suites become flaky. */
async function until(sess, sessionId, expression, what, ms = 10_000) {
  const started = Date.now();
  for (;;) {
    if (await evaluate(sess, sessionId, expression)) return true;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ---------------------------------------------------------------- setup

async function preflight() {
  const { createConnection } = await import("node:net");
  const up = await new Promise((res) => {
    const sock = createConnection({ host: "127.0.0.1", port: LOCAL_PORT }, () => (sock.end(), res(true)));
    sock.on("error", () => res(false));
    setTimeout(() => (sock.destroy(), res(false)), 3000);
  });
  if (!up) {
    console.error(
      `nothing is listening on 127.0.0.1:${LOCAL_PORT}.\n` +
        `  Start oauth with TLS, so the browser can reach it as ${ORIGIN}:\n` +
        `    cd services/oauth && npx wrangler dev --port ${LOCAL_PORT} --local-protocol https\n` +
        `  (seed the local D1 first: packages/mailstore/sql/{control-plane,data-plane}.sql)`,
    );
    process.exit(2);
  }
}

/** A principal with an enrollment link, ready for a passkey. */
function seedPrincipal() {
  const suffix = randomBytes(4).toString("hex");
  const principal = `prin_e2e_${suffix}`;
  const email = `ceremony-${suffix}@test.local`;
  const enrollToken = randomBytes(24).toString("base64url");
  const now = Date.now();
  // principals is (id, tenant_id, login_email, created_at) — NOT `email`, and
  // tenant_id is NOT NULL with a real tenants row behind it.
  sql(
    `INSERT OR IGNORE INTO tenants (id, name, status, created_at) VALUES ('t_e2e', 'ceremony e2e', 'active', ${now})`,
  );
  sql(
    `INSERT OR REPLACE INTO principals (id, tenant_id, login_email, created_at)
     VALUES ('${principal}', 't_e2e', '${email}', ${now})`,
  );
  sql(
    `INSERT INTO enrollments (id, principal_id, secret_hash, created_at, expires_at)
     VALUES ('enr_${suffix}', '${principal}', '${sha256hex(enrollToken)}', ${now}, ${now + 3_600_000})`,
  );
  return { principal, email, enrollToken, suffix };
}

/** A pending ceremony for that principal, and the link's token. */
function seedCeremony(principal, suffix, description) {
  const token = randomBytes(24).toString("base64url");
  const id = `cer_e2e_${suffix}_${randomBytes(2).toString("hex")}`;
  const now = Date.now();
  sql(
    `INSERT INTO ceremonies (id, principal_id, account_id, binding_id, category, description, secret_hash, status, created_at, expires_at)
     VALUES ('${id}', '${principal}', 't_e2e', 'bind_e2e', 'benefits.balance', '${description}', '${sha256hex(token)}', 'pending', ${now}, ${now + 300_000})`,
  );
  return { id, token };
}

const statusOf = (id) => {
  const out = sql(`SELECT status FROM ceremonies WHERE id = '${id}'`);
  const m = /"status"\s*:\s*"([a-z]+)"/.exec(out);
  return m ? m[1] : null;
};

// ---------------------------------------------------------------- browser

async function openBrowser() {
  if (CDP_URL) return { base: CDP_URL, kill: () => {} };
  const bin = [
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].find((p) => existsSync(p));
  if (!bin) {
    console.error("no Chromium/Chrome found, and CDP_URL is not set");
    process.exit(2);
  }
  const profile = mkdtempSync(join(tmpdir(), "bm-ceremony-"));
  const proc = spawn(
    bin,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      // The page must BE https://auth.bullmoose.cc for the origin check to
      // pass. Mapping :443 to the dev port means the origin carries no port,
      // which is exactly what originOf() derives.
      `--host-resolver-rules=MAP ${new URL(ORIGIN).hostname}:443 127.0.0.1:${LOCAL_PORT}`,
      // wrangler's local TLS is self-signed; the certificate is not what this
      // suite is testing.
      "--ignore-certificate-errors",
      // The ceremony's RP ID is derived from the host it is served on; a
      // 127.0.0.1 origin is treated as secure, so WebAuthn is available
      // without a certificate.
      "--disable-features=Translate",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const port = await new Promise((res, rej) => {
    let buf = "";
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
      if (m) res(Number(m[1]));
    });
    proc.on("exit", (c) => rej(new Error(`browser exited (${c}) before listening:\n${buf.slice(0, 400)}`)));
    setTimeout(() => rej(new Error(`browser never printed a DevTools endpoint:\n${buf.slice(0, 400)}`)), 20_000);
  });
  return {
    base: `http://127.0.0.1:${port}`,
    kill: () => {
      proc.kill("SIGKILL");
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** A page attached, with a virtual authenticator of the requested shape. */
async function pageWithAuthenticator(browserBase, { hasResidentKey }) {
  const version = await (await fetch(`${browserBase}/json/version`)).json();
  const sess = await cdp(version.webSocketDebuggerUrl);
  const { targetId } = await sess.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await sess.send("Target.attachToTarget", { targetId, flatten: true });
  await sess.send("Page.enable", {}, sessionId);
  await sess.send("Runtime.enable", {}, sessionId);
  await sess.send("WebAuthn.enable", {}, sessionId);
  const { authenticatorId } = await sess.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey,
        hasUserVerification: true,
        // The thumb. Presence and verification are satisfied by the browser,
        // so nothing waits for a gesture that will never come.
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
    sessionId,
  );
  const goto = async (url) => {
    await sess.send("Page.navigate", { url }, sessionId);
    await until(sess, sessionId, "document.readyState === 'complete'", `${url} to load`);
  };
  return { sess, sessionId, authenticatorId, goto };
}

// ---------------------------------------------------------------- the flows

/** Register a passkey through the real endpoints, from the real origin. */
async function registerPasskey(sess, sessionId, goto, enrollToken, email) {
  await goto(`${ORIGIN}/enroll#${enrollToken}`);
  return evaluate(
    sess,
    sessionId,
    `(async () => {
      const token = ${JSON.stringify(enrollToken)};
      // The gate wants the token AND the address: holding the link is not by
      // itself proof of being the person it was sent to.
      const email = ${JSON.stringify(email)};
      const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
      const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
      const optRes = await fetch("/enroll/webauthn/options", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, email }),
      });
      const wrapped = await optRes.json();
      if (!optRes.ok) return { ok: false, where: "options", error: wrapped.error };
      // enrollOptions answers { publicKey: … }, not the options bare.
      const opt = wrapped.publicKey ?? wrapped;
      const pk = { ...opt, challenge: unb64u(opt.challenge), user: { ...opt.user, id: unb64u(opt.user.id) },
                   excludeCredentials: (opt.excludeCredentials ?? []).map(c => ({ ...c, id: unb64u(c.id) })) };
      let cred;
      try { cred = await navigator.credentials.create({ publicKey: pk }); }
      catch (e) { return { ok: false, where: "create", error: String(e && e.message || e) }; }
      const regRes = await fetch("/enroll/webauthn/register", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, email, credential: { id: cred.id, response: {
          clientDataJSON: b64u(cred.response.clientDataJSON),
          attestationObject: b64u(cred.response.attestationObject),
        } } }),
      });
      const body = await regRes.json().catch(() => ({}));
      return { ok: regRes.ok, where: "register", status: regRes.status, error: body.error };
    })()`,
  );
}

/** Drive the REAL ceremony page: load, read the act, press the button. */
async function runCeremony(sess, sessionId, goto, token) {
  // about:blank first. Navigating to a URL identical to the current one is a
  // same-document hash change, not a load — so a second run would re-inspect
  // the FINISHED page (whose button the success path removes) instead of
  // asking the server again. That looked like a null-deref, not like a
  // missing reload.
  await goto("about:blank");
  await goto(`${ORIGIN}/ceremony#${token}`);
  // The page fetches /ceremony/begin and enables the button only once the act
  // has rendered — waiting on that is waiting on the real flow.
  await until(
    sess,
    sessionId,
    "(() => { const g = document.getElementById('go'); return g && !g.disabled; })()",
    "the ceremony page to enable its button",
  ).catch(() => {});
  const act = await evaluate(sess, sessionId, "document.getElementById('act')?.textContent ?? ''");
  // An ABSENT button is not an enabled one — `!undefined` is true, which is
  // how this asked a null to click itself.
  const enabled = await evaluate(
    sess,
    sessionId,
    "(() => { const g = document.getElementById('go'); return !!g && !g.disabled; })()",
  );
  if (!enabled) {
    return { act, pressed: false, outcome: "", error: act };
  }
  await evaluate(sess, sessionId, "document.getElementById('go').click()");
  await until(
    sess,
    sessionId,
    "(() => (document.getElementById('outcome')?.textContent || document.getElementById('err')?.textContent))()",
    "the ceremony to resolve",
  );
  return {
    act,
    pressed: true,
    outcome: await evaluate(sess, sessionId, "document.getElementById('outcome')?.textContent ?? ''"),
    error: await evaluate(sess, sessionId, "document.getElementById('err')?.textContent ?? ''"),
  };
}

// ---------------------------------------------------------------- main

async function main() {
  await preflight();
  const browser = await openBrowser();
  try {
    console.log("\nthe ceremony, in a real browser");

    // ---- 1. a discoverable passkey completes the ceremony ----
    {
      const who = seedPrincipal();
      const { sess, sessionId, goto } = await pageWithAuthenticator(browser.base, { hasResidentKey: true });
      const reg = await registerPasskey(sess, sessionId, goto, who.enrollToken, who.email);
      assert(reg?.ok === true, "a passkey registers through the real enrollment endpoints", reg?.error);

      const DESC = "Read the benefits balance for Q3";
      const cer = seedCeremony(who.principal, who.suffix, DESC);
      const r = await runCeremony(sess, sessionId, goto, cer.token);

      assert(r.act === DESC, "the page renders the act from the ROW, not the URL", `got: ${r.act}`);
      assert(r.pressed && /Approved/.test(r.outcome), "the ceremony passes end to end in Chrome", r.error || r.act);
      assert(statusOf(cer.id) === "passed", "the row is decided `passed`", statusOf(cer.id));

      // ---- 2. one link, one answer ----
      const again = await runCeremony(sess, sessionId, goto, cer.token);
      assert(
        !again.pressed && /already decided/i.test(again.act),
        "replaying the same link refuses — each link answers exactly once",
        again.act,
      );
      sess.close();
    }

    // ---- 3. the coupling: assertion needs what registration must create ----
    {
      // `assertionOptions` sends allowCredentials: [], so the browser must
      // FIND the credential unaided. An authenticator with no resident-key
      // storage is the case that separates "registration preferred it" from
      // "the ceremony can use it".
      const who = seedPrincipal();
      const { sess, sessionId, goto } = await pageWithAuthenticator(browser.base, { hasResidentKey: false });
      const reg = await registerPasskey(sess, sessionId, goto, who.enrollToken, who.email);

      if (reg?.ok !== true) {
        // The honest outcome: enrollment refuses the authenticator it cannot
        // later assert with, at the moment a human can still do something.
        pass("a non-discoverable authenticator is refused at ENROLLMENT, not at ceremony time");
      } else {
        const cer = seedCeremony(who.principal, who.suffix, "Probe the discoverability coupling");
        const r = await runCeremony(sess, sessionId, goto, cer.token);
        const worked = r.pressed && /Approved/.test(r.outcome);
        assert(
          worked,
          "a credential enrollment accepted can still complete a ceremony",
          `enrollment succeeded but the ceremony could not use the credential — ` +
            `registration asks for residentKey "preferred" while assertionOptions sends ` +
            `allowCredentials: [], which REQUIRES a discoverable credential. ` +
            `page said: ${r.error || r.act}`,
        );
      }
      sess.close();
    }
  } finally {
    browser.kill();
  }

  console.log(failures ? `\n${failures} failure(s)\n` : "\nall ceremony checks passed\n");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`\ne2e-ceremony: ${e.message}\n`);
  process.exit(1);
});
