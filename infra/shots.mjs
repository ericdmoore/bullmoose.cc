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

async function shoot(name) {
  const s = SURFACES[name];
  const url = `${base}${s.path}${s.demo === false ? "" : "?demo=1"}`;
  const res = await fetch(`${API}/accounts/${ACCOUNT}/browser-rendering/screenshot`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      url,
      viewport: { width: 1440, height: 900 },
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
  if (!res.ok)
    return { name, ok: false, detail: `${res.status} ${(await res.text()).slice(0, 160)}` };
  const png = Buffer.from(await res.arrayBuffer());
  // A hydrated page is tens of KB; a blank 1440×900 PNG is a few. Cheap guard
  // against the failure mode above silently returning to green.
  if (png.length < 10_000)
    return { name, ok: false, detail: `${png.length} bytes — blank? the wait did not hold` };
  const file = `${out}/${name}${dark ? ".dark" : ""}.png`;
  writeFileSync(file, png);
  return { name, ok: true, detail: `${file} · ${(png.length / 1024).toFixed(0)} kB` };
}

const results = [];
for (const n of names) results.push(await shoot(n));
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name.padEnd(11)} ${r.detail}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
