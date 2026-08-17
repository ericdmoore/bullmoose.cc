#!/usr/bin/env node
// The coverage ratchet. Reads coverage/coverage-summary.json, folds it up to a
// per-package LINE percentage, and compares each package against a committed
// floor in .github/coverage-baseline.json. Fails the build when a package
// falls below its floor — and also when it climbs far enough above it that the
// gain deserves recording, because a floor nobody advances is not a ratchet.
//
// Four design choices, each made against a specific way ratchets rot:
//
// 1. PER PACKAGE, NOT TOTAL. services/jmap and services/agent are 51% of the
//    tracked lines between them, so a repo-wide total is mostly a reading of
//    those two. contacts-core sliding 29% → 20% moves the total by ~0.2pp and
//    would vanish under any tolerance worth having. Nineteen small numbers
//    catch "tests added to A while B rots"; one big number cannot.
//
// 2. LINES, NOT BRANCHES. Lines are the stabler signal: a branch denominator
//    moves whenever a conditional is refactored, so branch % drifts on changes
//    that alter no behaviour and remove no test. Line count tracks "is this
//    executed" and is what a ratchet can hold steady.
//
//    ⚠️ An earlier draft of this comment claimed something stronger — that two
//    consecutive runs on an UNCHANGED tree produced different branch counts
//    (auth-core/principal.ts 78/91 → 79/92). That did not reproduce: three
//    consecutive runs gave 79/92 every time. The observation may have come
//    from a tree that was not in fact identical. The decision stands on the
//    reasoning above, which is the ordinary case for preferring lines — not on
//    a non-determinism claim that has not been demonstrated here.
//
//    Branches and functions are still reported; they just do not gate.
//
// 3. WHOLE PERCENT. Floors are integers and the comparison floors the current
//    value before testing it, so sub-point drift cannot trip the gate. An
//    exact `>=` on a float would.
//
// 4. THE FLOOR IS A COMMITTED FILE. Lowering coverage stays possible — some
//    drops are correct, see below — but it costs an edit that shows up in the
//    diff and gets reviewed, rather than a number silently sliding in a cache.
//
// A percentage denominator moves when files are added or deleted, so two
// legitimate things still trip this: deleting a well-covered file, and adding
// a large module that resists unit testing (a new worker entrypoint). Both are
// meant to be answered the same way — lower the floor in the same PR, in the
// open. The run summary prints the exact file to paste, so neither case
// requires running anything locally.
//
// Usage:
//   node .github/scripts/coverage-ratchet.mjs            # check (CI)
//   node .github/scripts/coverage-ratchet.mjs --update    # rewrite the floors
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { pathToFileURL } from "node:url";

export const COVERAGE_PATH = "coverage/coverage-summary.json";
export const BASELINE_PATH = ".github/coverage-baseline.json";

// How far a package may climb above its recorded floor before CI asks for the
// gain to be written down. Zero would fail every coverage-improving PR; the
// floors would then never advance and this would be a floor, not a ratchet.
// Two points is roughly "a few tests" on the big packages and "one test" on
// the small ones.
export const DEFAULT_SLACK = 2;

/**
 * Which package a covered file belongs to. The coverage config only includes
 * `packages/<name>/src/**` and `services/<name>/src/**`, so the first two path
 * segments are the unit; anything shallower is its own bucket rather than a
 * silent drop.
 */
export function packageOf(relPath) {
  const parts = relPath.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? "");
}

/** Integer percent, floored. Integer math first: (83/100)*100 is 83.00000000000001. */
export function floorPct({ covered, total }) {
  return total === 0 ? 100 : Math.floor((covered * 100) / total);
}

/**
 * Fold a v8 json-summary into `{ "services/jmap": { covered, total }, … }`.
 * Summary keys are absolute paths, so they are relativised against the repo
 * root before grouping.
 */
export function aggregate(summary, root = process.cwd()) {
  const acc = new Map();
  for (const [file, metrics] of Object.entries(summary)) {
    if (file === "total") continue;
    const rel = isAbsolute(file) ? relative(root, file) : file;
    const pkg = packageOf(rel);
    const cur = acc.get(pkg) ?? { covered: 0, total: 0 };
    cur.covered += metrics.lines.covered;
    cur.total += metrics.lines.total;
    acc.set(pkg, cur);
  }
  return Object.fromEntries([...acc].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * Compare current per-package numbers against the committed floors.
 *
 * `regressed` and `unrecorded` fail the build; `new` and `gone` only report,
 * because adding a package and deleting one are both legitimate acts and
 * neither should be blocked by a bookkeeping file.
 */
export function evaluate(current, baseline) {
  const slack = Number.isFinite(baseline?.slack) ? baseline.slack : DEFAULT_SLACK;
  const floors = baseline?.packages ?? {};
  const names = [...new Set([...Object.keys(current), ...Object.keys(floors)])].sort();

  const rows = names.map((name) => {
    const cur = current[name];
    const floor = floors[name];
    if (!cur) return { name, status: "gone", floor };
    const pct = floorPct(cur);
    const row = { name, pct, covered: cur.covered, total: cur.total, floor };
    if (floor === undefined) return { ...row, status: "new" };
    if (pct < floor) return { ...row, status: "regressed" };
    if (pct > floor + slack) return { ...row, status: "unrecorded" };
    return { ...row, status: "ok" };
  });

  const failures = rows.filter((r) => r.status === "regressed" || r.status === "unrecorded");
  return { rows, slack, failures, ok: failures.length === 0 };
}

const NOTE =
  "Per-package LINE coverage floors, whole percent. CI fails if a package drops " +
  "below its floor, or climbs more than `slack` points above it without recording " +
  "the gain here. To move a floor: `npm run coverage:baseline`, or paste the block " +
  "the failing CI run prints. Lowering one is allowed and deliberate — say why in " +
  "the PR. See .github/scripts/coverage-ratchet.mjs.";

/** The baseline file this run would write: floors set to today's numbers. */
export function nextBaseline(current, baseline) {
  return {
    note: baseline?.note ?? NOTE,
    slack: Number.isFinite(baseline?.slack) ? baseline.slack : DEFAULT_SLACK,
    packages: Object.fromEntries(Object.entries(current).map(([k, v]) => [k, floorPct(v)])),
  };
}

/** Floors this branch lowered relative to the base branch — a deliberate act, made loud. */
export function lowered(before, after) {
  const a = before?.packages ?? {};
  const b = after?.packages ?? {};
  return Object.keys(a)
    .filter((k) => b[k] !== undefined && b[k] < a[k])
    .map((k) => ({ name: k, from: a[k], to: b[k] }));
}

const ICON = { ok: "✅", regressed: "🔴", unrecorded: "🟡", new: "🆕", gone: "🗑️" };

export function renderMarkdown({ rows, slack, ok, failures }, { total, lowerings = [], baseline = null } = {}) {
  const out = [];
  out.push(`## Coverage ratchet — ${ok ? "pass" : "FAIL"}`, "");

  if (total) {
    const cell = (m) => `${m.pct.toFixed(2)}% (${m.covered}/${m.total})`;
    out.push(
      "| Whole repo | Lines | Statements | Functions | Branches |",
      "|---|---|---|---|---|",
      `| | ${cell(total.lines)} | ${cell(total.statements)} | ${cell(total.functions)} | ${cell(total.branches)} |`,
      "",
      "_Reported, not gated. Only per-package **lines** gate — branch counts are not stable run to run._",
      "",
    );
  }

  if (lowerings.length > 0) {
    out.push(
      "> ### ⚠️ This branch LOWERS coverage floors",
      ">",
      ...lowerings.map((l) => `> - \`${l.name}\`: ${l.from}% → ${l.to}%`),
      ">",
      "> That is an allowed move, not an error. It should be explained in the PR description.",
      "",
    );
  }

  out.push("| Package | Floor | Now | Δ | |", "|---|---:|---:|---:|---|");
  for (const r of rows) {
    if (r.status === "gone") {
      out.push(`| \`${r.name}\` | ${r.floor}% | — | — | ${ICON.gone} no longer measured |`);
      continue;
    }
    const floor = r.floor === undefined ? "—" : `${r.floor}%`;
    const d = r.floor === undefined ? "—" : `${r.pct - r.floor >= 0 ? "+" : ""}${r.pct - r.floor}`;
    const note =
      r.status === "regressed"
        ? `${ICON.regressed} **below floor**`
        : r.status === "unrecorded"
          ? `${ICON.unrecorded} gain not recorded`
          : r.status === "new"
            ? `${ICON.new} not yet floored`
            : ICON.ok;
    out.push(`| \`${r.name}\` | ${floor} | ${r.pct}% (${r.covered}/${r.total}) | ${d} | ${note} |`);
  }
  out.push("");

  if (!ok) {
    const down = failures.filter((f) => f.status === "regressed");
    const up = failures.filter((f) => f.status === "unrecorded");
    if (down.length > 0) {
      out.push(
        `**${down.length} package(s) lost coverage.** Add tests, or — if the drop is correct ` +
          "(a well-covered file deleted, a new hard-to-test entrypoint) — lower the floor in " +
          "this PR and say why.",
        "",
      );
    }
    if (up.length > 0) {
      out.push(
        `**${up.length} package(s) climbed more than ${slack} points above their floor.** ` +
          "Record the gain so it cannot be given back.",
        "",
      );
    }
    out.push(
      `Paste this into \`${BASELINE_PATH}\` (or run \`npm run coverage:baseline\`):`,
      "",
      "```json",
      JSON.stringify(
        nextBaseline(
          Object.fromEntries(rows.filter((r) => r.status !== "gone").map((r) => [r.name, r])),
          baseline ?? { slack },
        ),
        null,
        2,
      ),
      "```",
      "",
    );
  }
  return out.join("\n");
}

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

/** Everything except process exit and stdout, so tests can drive it. */
export function run({ coverage = COVERAGE_PATH, baseline = BASELINE_PATH, before = null, root = process.cwd() } = {}) {
  const summary = readJson(coverage);
  if (!summary) {
    return { ok: false, log: `No coverage summary at ${coverage} — did \`npm run coverage\` run?`, markdown: "" };
  }
  const base = readJson(baseline);
  const current = aggregate(summary, root);

  if (!base) {
    // Bootstrap: no floors yet is not a regression, it is a missing file.
    const md = `## Coverage ratchet\n\nNo baseline at \`${baseline}\`. Run \`npm run coverage:baseline\` and commit it.\n`;
    return { ok: true, log: `No baseline at ${baseline}; nothing to ratchet against.`, markdown: md, current };
  }

  const result = evaluate(current, base);
  const lowerings = before ? lowered(readJson(before), base) : [];
  const markdown = renderMarkdown(result, { total: summary.total, lowerings, baseline: base });

  const log = [
    ...result.rows
      .filter((r) => r.status !== "ok")
      .map((r) =>
        r.status === "regressed"
          ? `::error::coverage ratchet: ${r.name} is ${r.pct}%, below its ${r.floor}% floor`
          : r.status === "unrecorded"
            ? `::error::coverage ratchet: ${r.name} rose to ${r.pct}% (floor ${r.floor}%) — record the gain in ${BASELINE_PATH}`
            : r.status === "new"
              ? `::warning::coverage ratchet: ${r.name} is not in ${BASELINE_PATH} (currently ${r.pct}%)`
              : `::warning::coverage ratchet: ${r.name} is in ${BASELINE_PATH} but no longer measured`,
      ),
    ...lowerings.map((l) => `::warning::coverage floor LOWERED in this branch: ${l.name} ${l.from}% → ${l.to}%`),
    result.ok
      ? `coverage ratchet: ${result.rows.length} packages, all at or above their floors.`
      : `coverage ratchet FAILED: ${result.failures.length} of ${result.rows.length} packages need attention (see the job summary).`,
  ].join("\n");

  return { ...result, markdown, log, current };
}

function main(argv) {
  const arg = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
  };
  const coverage = arg("--coverage", COVERAGE_PATH);
  const baseline = arg("--baseline", BASELINE_PATH);

  if (argv.includes("--update")) {
    const summary = readJson(coverage);
    if (!summary) {
      console.error(`No coverage summary at ${coverage} — run \`npm run coverage\` first.`);
      return 1;
    }
    const next = nextBaseline(aggregate(summary), readJson(baseline));
    writeFileSync(baseline, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Wrote ${Object.keys(next.packages).length} package floors to ${baseline}.`);
    return 0;
  }

  const { ok, log, markdown } = run({ coverage, baseline, before: process.env.BASELINE_BEFORE || null });
  console.log(log);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  else console.log(`\n${markdown}`);
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
