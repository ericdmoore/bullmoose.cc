// Render a coverage summary as GitHub-flavoured markdown, diffing the
// current run against a previous run's summary when one was downloaded.
// Reads coverage/coverage-summary.json (current, always) and, if present,
// prev-cov/coverage-summary.json (the last successful run's artifact).
// Output goes to stdout; the workflow appends it to $GITHUB_STEP_SUMMARY.
import { existsSync, readFileSync } from "node:fs";

const totals = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).total : null);

const cur = totals("coverage/coverage-summary.json");
if (!cur) {
  console.log("No coverage summary found (coverage/coverage-summary.json missing).");
  process.exit(0);
}
const prev = totals("prev-cov/coverage-summary.json");

const cell = (m) => `${m.pct.toFixed(2)}% (${m.covered}/${m.total})`;
const delta = (c, p) => {
  if (!p) return "—";
  const d = c.pct - p.pct;
  const tag = d > 0.005 ? " 🟢" : d < -0.005 ? " 🔴" : "";
  return `${d >= 0 ? "+" : ""}${d.toFixed(2)}${tag}`;
};

const metrics = ["lines", "statements", "functions", "branches"];
const rows = metrics.map((k) => {
  const name = k[0].toUpperCase() + k.slice(1);
  return `| ${name} | ${prev ? cell(prev[k]) : "—"} | ${cell(cur[k])} | ${delta(cur[k], prev?.[k])} |`;
});

console.log(
  `## Coverage${prev ? " — vs. previous run" : " — baseline (no previous run to compare)"}`,
);
console.log("");
console.log("| Metric | Previous | Current | Δ (pp) |");
console.log("|---|---|---|---|");
console.log(rows.join("\n"));
console.log("");
console.log(
  "Browse the full report: **Actions → this run → Artifacts → `coverage-html`** " +
    "(download, open `index.html`).",
);
