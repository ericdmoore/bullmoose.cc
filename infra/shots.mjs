#!/usr/bin/env node
// Screenshot every app surface through Cloudflare Browser Rendering, so the
// dev loop closes without a local Chrome (which segfaults in the agent sandbox
// — the reason `/files` shipped unseen).
//
//   node infra/shots.mjs                 # every surface, to .shots/
//   node infra/shots.mjs files approvals # just these
//   node infra/shots.mjs --base https://app.bullmoose.cc --dark
//
// It shoots `?demo=1`, which is the point: demo fixtures are DETERMINISTIC and
// need no credential, so two runs differ only when the UI changed. Shooting
// live data would diff against your inbox.

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const API = "https://api.cloudflare.com/client/v4";

function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
      env[m[1]] = v;
    }
  } catch {
    /* rely on the ambient environment */
  }
  return env;
}

const env = loadEnv();
const TOKEN = env.BULLMOOSE_RUNTIME_TOKEN ?? env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = env.CLOUDFLARE_ACCOUNT_ID ?? "cf473a1c1e6f51585477ccf5216ae636";

/** Every surface, with the selector that proves IT is what rendered. */
const SURFACES = {
  login: { path: "/login", sel: "form, .door-label", demo: false },
  home: { path: "/", sel: "main" },
  approvals: { path: "/approvals/", sel: "main" },
  agents: { path: "/agents/", sel: "main" },
  mail: { path: "/mail/", sel: "main" },
  contacts: { path: "/contacts/", sel: "main" },
  calendar: { path: "/calendar/", sel: "main" },
  files: { path: "/files/", sel: "main" },
  search: { path: "/search/", sel: "main" },
  settings: { path: "/settings/", sel: "main" },
};

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? d : args[i + 1];
};
const base = flag("base", "https://app.bullmoose.cc");
const dark = args.includes("--dark");
const out = flag("out", ".shots");
const wanted = args.filter((a) => !a.startsWith("--") && SURFACES[a]);
const names = wanted.length ? wanted : Object.keys(SURFACES);

mkdirSync(out, { recursive: true });

/**
 * The viewport profiles every run shoots (s25 T1's unmet clause, #226).
 *
 * The phone profile is not a nicety: #205 fixed a duplicate create
 * affordance that existed ONLY at narrow widths — #200 shipped the FAB
 * `lg:hidden` but left CollectionColumn's header button unqualified, so a
 * phone showed two [New message] buttons. Every assertion about the button
 * passed, every assertion about the FAB passed, and the defect lived in the
 * relationship between them at one width. A human found it on a real
 * 390×844 hours after merge.
 */
const PROFILES = {
  desktop: { width: 1440, height: 900 },
  // 390×844 is the iPhone 14/15 logical viewport — the width s25 named.
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
};

async function shoot(name, profile = "desktop") {
  const s = SURFACES[name];
  const viewport = PROFILES[profile];
  const url = `${base}${s.path}${s.demo === false ? "" : "?demo=1"}`;
  const res = await fetch(`${API}/accounts/${ACCOUNT}/browser-rendering/screenshot`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      url,
      viewport,
      // Two waits, both load-bearing.
      //
      // Astro islands are `client:only`, so the markup arrives EMPTY and the UI
      // exists only after hydration — without a wait the shot is a blank page,
      // and a blank page diffs clean against another blank page, which is a
      // visual suite that can never fail.
      //
      // networkidle**2**, not 0: `/agents` holds a connection open (the push
      // channel), so "zero in-flight requests" never happens and the goto times
      // out on exactly the pages that are most alive. Tolerating two in-flight
      // is the difference between shooting a live app and shooting a brochure.
      gotoOptions: { waitUntil: "networkidle2", timeout: 30_000 },
      waitForSelector: { selector: s.sel, timeout: 15_000 },
      ...(dark ? { emulateMediaFeatures: [{ name: "prefers-color-scheme", value: "dark" }] } : {}),
      screenshotOptions: { type: "png", fullPage: true },
    }),
  });
  if (!res.ok) return { name, ok: false, detail: `${res.status} ${(await res.text()).slice(0, 160)}` };
  const png = Buffer.from(await res.arrayBuffer());
  // A hydrated page is tens of KB; a blank 1440×900 PNG is a few. Cheap guard
  // against the failure mode above silently returning to green.
  // A hydrated page is tens of KB; a blank one is a few. The phone shoots a
  // third of the pixels, so its floor is lower — one number for both widths
  // would either miss a blank desktop or fail every honest phone shot.
  const floor = profile === "phone" ? 4_000 : 10_000;
  if (png.length < floor)
    return { name, profile, ok: false, detail: `${png.length} bytes — blank? the wait did not hold` };
  const file = `${out}/${name}${profile === "desktop" ? "" : `.${profile}`}${dark ? ".dark" : ""}.png`;
  writeFileSync(file, png);
  return { name, profile, ok: true, detail: `${file} · ${(png.length / 1024).toFixed(0)} kB` };
}

// Every surface at every profile. `--desktop` / `--phone` narrows it when
// iterating; the default is BOTH, because the whole point of the phone
// profile is that nobody remembers to ask for it.
const asked = Object.keys(PROFILES).filter((p) => args.includes(`--${p}`));
const profiles = asked.length ? asked : Object.keys(PROFILES);

/**
 * WHICH ENGINE PRODUCED THESE PIXELS (#226).
 *
 * On 2026-08-19 this harness was found to have been driving Cloudflare's
 * Kitesurf browser — the Boa JS engine compiled to WASM — rather than
 * Chromium, for weeks. Preact wedges after two renders inside it, which
 * manufactured a convincing and entirely false "the mail list never loads"
 * bug that cost a full agent-hours diagnosis before the engine was
 * identified.
 *
 * The failure was not the engine. It was that the output looked identical
 * either way and nothing in the run said which one made it. So the run now
 * ASKS, prints the answer, and — because a visual gate that silently falls
 * back to a different renderer is worse than no gate — refuses to shoot
 * anything if the answer is not the engine we expect. `--any-engine` is the
 * deliberate override, and it says so out loud.
 */
async function engineOf() {
  const res = await fetch(`${API}/accounts/${ACCOUNT}/browser-rendering/content`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      html: "<script>document.title=navigator.userAgent</script>",
      gotoOptions: { waitUntil: "load" },
    }),
  });
  if (!res.ok) return { ok: false, detail: `${res.status} ${(await res.text()).slice(0, 120)}` };
  const html = await res.text();
  const ua = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
  return { ok: true, ua };
}

const engine = await engineOf();
if (!engine.ok) {
  console.error(`✗ could not identify the rendering engine: ${engine.detail}`);
  process.exit(1);
}
const isChromium = /Chrome\/|Chromium/i.test(engine.ua);
console.log(`engine: ${engine.ua || "(no user-agent reported)"}`);
if (!isChromium && !args.includes("--any-engine")) {
  console.error(
    "✗ this is not Chromium. Every screenshot below would be produced by a different\n" +
      "  renderer than the one users have — which is exactly the 2026-08-19 failure\n" +
      "  (Kitesurf/Boa wedged Preact after two renders and manufactured a false bug).\n" +
      "  Re-run with --any-engine ONLY if you mean it, and say so in the PR.",
  );
  process.exit(1);
}

const results = [];
for (const p of profiles) for (const n of names) results.push(await shoot(n, p));
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name.padEnd(11)} ${r.profile.padEnd(8)} ${r.detail}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
