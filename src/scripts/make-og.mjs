// Regenerate the social-share card (public/og.png, 1200×630).
//
// The card mirrors the hero slogan so an unfurl reads like the front page.
// Fonts are embedded as data URIs and the moose mark is inlined, so the
// render is self-contained and reproducible — no network, no path deps.
// Rendered headless at 2× and downscaled with sharp for crisp type.
//
//   node scripts/make-og.mjs      # from the src/ dir (repo: src/scripts/…)
//
// Re-run whenever the hero slogan or brand palette changes.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, ".."); // src/
const scratch = process.env.OG_SCRATCH || "/tmp";
const CHROMIUM =
  process.env.CHROMIUM || "/Applications/Chromium.app/Contents/MacOS/Chromium";

const font = (pkg, file) =>
  `url(data:font/woff2;base64,${readFileSync(
    resolve(root, "node_modules/@fontsource", pkg, "files", file),
  ).toString("base64")}) format("woff2")`;

const bigShoulders = font("big-shoulders-display", "big-shoulders-display-latin-800-normal.woff2");
const spaceMono = font("space-mono", "space-mono-latin-700-normal.woff2");
const publicSans = font("public-sans", "public-sans-latin-600-normal.woff2");

// Inline the moose mark (fluid size, keep its viewBox).
const moose = readFileSync(resolve(root, "public/moose.svg"), "utf8")
  .replace(/<\?xml[^>]*\?>/, "")
  .replace(/width="1024px" height="1024px"/, 'width="100%" height="100%"');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Big Shoulders Display";font-weight:800;src:${bigShoulders};}
@font-face{font-family:"Space Mono";font-weight:700;src:${spaceMono};}
@font-face{font-family:"Public Sans";font-weight:600;src:${publicSans};}
*{margin:0;box-sizing:border-box;}
html,body{width:1200px;height:630px;background:#16223f;}
.card{position:relative;width:1200px;height:630px;background:#16223f;overflow:hidden;
  font-family:"Public Sans",sans-serif;color:#efe9db;}
/* flag hem */
.card::after{content:"";position:absolute;left:0;right:0;bottom:0;height:6px;
  background:linear-gradient(90deg,#8f2d2d,#b5892f 55%,#d8b45e);}
.stripes{position:absolute;inset:0;opacity:.05;
  background:repeating-linear-gradient(135deg,#d8b45e 0 2px,transparent 2px 26px);}
.frame{position:absolute;inset:26px;border:1.5px solid rgba(216,180,94,.32);}
/* every region absolutely placed so the tall moose can't shove the footer off-card */
.inner{position:absolute;inset:26px;}
.eyebrow{position:absolute;top:44px;left:56px;font-family:"Space Mono";font-weight:700;
  font-size:19px;letter-spacing:4px;text-transform:uppercase;color:#c19a3e;}
.slogan{position:absolute;left:56px;top:50%;transform:translateY(-50%);max-width:660px;line-height:.92;}
.slogan span{display:block;font-family:"Big Shoulders Display";font-weight:800;letter-spacing:-.5px;}
.l1,.l3{font-size:64px;color:#efe9db;}
.l2{font-size:100px;color:#d8b45e;}
.art{position:absolute;right:52px;top:50%;transform:translateY(-50%);width:320px;height:320px;}
.art svg{width:100%;height:100%;display:block;}
.bot{position:absolute;left:56px;right:56px;bottom:40px;display:flex;align-items:flex-end;
  justify-content:space-between;gap:24px;}
.tag{font-family:"Public Sans",sans-serif;font-weight:600;font-size:23px;color:#b7bccb;}
.mark{font-family:"Big Shoulders Display";font-weight:800;font-size:34px;letter-spacing:.5px;color:#d8b45e;}
</style></head><body>
<div class="card">
  <div class="stripes"></div>
  <div class="frame"></div>
  <div class="inner">
    <div class="eyebrow">Email for agents &middot; self-hosted &middot; $0/mo</div>
    <div class="slogan">
      <span class="l1">Your email domain.</span>
      <span class="l2">Agent-native.</span>
      <span class="l3">Your private data.</span>
    </div>
    <div class="art">${moose}</div>
    <div class="bot">
      <div class="tag">Mail, contacts &amp; calendar you actually own.</div>
      <div class="mark">bullmoose.cc</div>
    </div>
  </div>
</div>
</body></html>`;

const htmlPath = resolve(scratch, "og.html");
const shotPath = resolve(scratch, "og-2x.png");
const outPath = resolve(root, "public/og.png");
writeFileSync(htmlPath, html);

// Render into a viewport taller than the card, then crop the exact top
// 1200×630 (at 2× → 2400×1260). Headless capture height is unreliable, so we
// give it slack and crop deterministically rather than trust --window-size.
execFileSync(
  CHROMIUM,
  [
    "--headless=new",
    "--no-sandbox",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--force-device-scale-factor=2",
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=2000",
    "--window-size=1200,900",
    `--screenshot=${shotPath}`,
    `file://${htmlPath}`,
  ],
  { stdio: "inherit" },
);

await sharp(shotPath)
  .extract({ left: 0, top: 0, width: 2400, height: 1260 })
  .resize(1200, 630)
  .png({ compressionLevel: 9 })
  .toFile(outPath);
console.log("wrote", outPath);
