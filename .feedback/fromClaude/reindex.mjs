#!/usr/bin/env node
// reindex.mjs — feedback folder janitor + indexer.
//
// What it does, in one pass over a feedback root (default: this script's own
// directory):
//   1. CLEAN  — any feedback file whose TITLE (first non-empty line) contains a
//               checkmark glyph (✅ ✔ ✓ ☑) is treated as "done" and moved into
//               the `📦completed/` folder. This applies to the `for*` category
//               folders AND their `refactors/` subfolders.
//   2. INDEX  — every remaining feedback file is listed in one of two indexes,
//               grouped by folder, clickable:
//                 • `_index.md`     — the review items in each `for*` folder.
//                 • `_refactors.md` — the items in each `for*/refactors/` folder.
//
// A `refactors/` subfolder is a sibling of the issue files inside a category
// folder (e.g. `forIOS/refactors/`). It uses the exact same file format and the
// same "prepend ✅, run this script" completion flow as a regular item. The
// `📦completed/` archive is shared — a done refactor lands there alongside
// everything else.
//
// Marking an item done is intentionally trivial for an agent: prepend a "✅ " as
// the very first characters of the file, then run this script. That's it.
//
// Usage:
//   node reindex.mjs            # operate on the folder this script lives in
//   node reindex.mjs <root>     # operate on some other feedback root
//   node reindex.mjs --dry-run  # print what would happen, change nothing
//
// Zero dependencies. Idempotent — safe to run repeatedly.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run") || argv.includes("-n");
const rootArg = argv.find((a) => !a.startsWith("-"));
const ROOT = rootArg ? path.resolve(rootArg) : SCRIPT_DIR;

// --- constants --------------------------------------------------------------
// Checkmark glyphs that mark a file "done". Matching the base codepoint also
// catches the emoji-presentation forms (base char + U+FE0F variation selector).
const CHECK_GLYPHS = ["✅", "✔", "✓", "☑", "\u{1F5F9}"]; // ✅ ✔ ✓ ☑ 🗹
const isDoneTitle = (title) => CHECK_GLYPHS.some((g) => title.includes(g));

// The refactors sub-track: a `refactors/` folder inside each category folder.
const REFACTORS_DIR = "refactors";

// Files we never treat as feedback items.
const SKIP_FILES = new Set([
  "_index.md",
  "_refactors.md",
  path.basename(fileURLToPath(import.meta.url)),
]);
const isReadme = (name) => /^readme(\.md)?$/i.test(name);
const isCategoryDir = (name) => name.startsWith("for");
const isCompletedDir = (name) => name.toLowerCase().includes("completed");

// --- helpers ----------------------------------------------------------------
function listDirs(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function listMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .filter((name) => !SKIP_FILES.has(name) && !isReadme(name))
    .sort((a, b) => a.localeCompare(b));
}

function isDir(p) {
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

// First non-empty line of a file, minus a UTF-8 BOM. This is the "title line".
function titleLine(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^﻿/, "");
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() !== "") return line.trim();
  }
  return "";
}

// Turn a raw title line into clean display text: drop leading check glyphs,
// markdown "#" markers, and whitespace (in any order).
function displayTitle(line) {
  let s = line;
  let prev;
  do {
    prev = s;
    s = s.replace(/^\s+/, "");
    s = s.replace(/^#+/, "");
    for (const g of CHECK_GLYPHS) {
      while (s.startsWith(g)) s = s.slice(g.length);
    }
    s = s.replace(/^️/, ""); // stray variation selector after a glyph
  } while (s !== prev);
  return s.trim() || "(untitled)";
}

// Optional one-line summary: a leading blockquote ("> …") after the title.
function summaryLine(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^﻿/, "");
  const lines = raw.split(/\r?\n/);
  let seenTitle = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === "") continue;
    if (!seenTitle) {
      seenTitle = true;
      continue;
    }
    if (t.startsWith(">")) return t.replace(/^>\s?/, "").trim();
    return ""; // summary must immediately follow the title
  }
  return "";
}

function ensureDir(dir) {
  if (!fs.existsSync(dir) && !DRY_RUN) fs.mkdirSync(dir, { recursive: true });
}

// Move `src` into `destDir`, avoiding clobbering an existing file of the same name.
function moveInto(src, destDir) {
  ensureDir(destDir);
  const base = path.basename(src);
  let dest = path.join(destDir, base);
  if (fs.existsSync(dest)) {
    const ext = path.extname(base);
    const stem = base.slice(0, -ext.length || undefined);
    let i = 2;
    do {
      dest = path.join(destDir, `${stem}-${i}${ext}`);
      i += 1;
    } while (fs.existsSync(dest));
  }
  if (!DRY_RUN) fs.renameSync(src, dest);
  return dest;
}

// Markdown-safe relative link target (encode spaces, emoji, etc.).
const mdLink = (relPath) => encodeURI(relPath.split(path.sep).join("/"));

// Filenames may carry a priority component: `<num>-<P0..P5>-<slug>.md`.
// P0 = drop everything … P5 = trivial/someday. Parsed for display + sort.
const priorityOf = (name) => name.match(/^\d+-(P[0-5])-/)?.[1] ?? null;

// A `<stem>.fix.md` is a fix PROPOSAL attached to issue `<stem>.md`. We render
// it inline on the issue row (📝 proposal) rather than as its own list item.
const FIX_SUFFIX = ".fix.md";
const isFix = (n) => n.endsWith(FIX_SUFFIX);
const issueFileForFix = (fixName) => fixName.slice(0, -FIX_SUFFIX.length) + ".md";
const fixFileForIssue = (issueName) => issueName.slice(0, -".md".length) + FIX_SUFFIX;

// Issue number: the leading `<num>` in `<num>-<P?>-<slug>.md`.
const numberOf = (name) => {
  const m = name.match(/^(\d+)-/);
  return m ? parseInt(m[1], 10) : null;
};

// Severity bands mirror the filename convention (see README): high = P0–P2
// (01–20), medium = P3 (21–50), low = P4–P5 (51+). [label, lo, hi].
const NUMBER_BANDS = [
  ["high", 1, 20],
  ["medium", 21, 50],
  ["low", 51, 9999],
];

// Next free issue number per band for a folder, from its OPEN items. An agent
// filing a new item plucks next.<folder>.<band> from the summary front matter.
function nextNumbersFor(dirPath) {
  const nums = listMarkdown(dirPath).map(numberOf).filter((n) => n !== null);
  const out = {};
  for (const [label, lo, hi] of NUMBER_BANDS) {
    const inBand = nums.filter((n) => n >= lo && n <= hi);
    out[label] = inBand.length ? Math.max(...inBand) + 1 : lo;
  }
  return out;
}

// YAML front-matter block for a summary file: per-folder next numbers + the
// global max. `groups` = [{ rel, dirPath }]. Reads module-level `maxIssueNumber`.
function frontMatterLines(groups) {
  const out = ["---"];
  out.push("# reindex.mjs bookkeeping (auto-generated). Agents: before filing a new");
  out.push("# issue, read next.<folder>.<band> and use it as the <num> prefix so");
  out.push("# numbers don't collide. Bands: high P0–P2 (01–20) · medium P3 (21–50)");
  out.push("# · low P4–P5 (51+).");
  out.push("next:");
  for (const g of groups) {
    const n = nextNumbersFor(g.dirPath);
    out.push(`  ${g.rel}: { high: ${n.high}, medium: ${n.medium}, low: ${n.low} }`);
  }
  out.push(`maxIssueNumber: ${maxIssueNumber}`);
  out.push("---");
  out.push("");
  return out;
}

// Render one folder's items into `lines`. `label` heads the section; `relDir`
// prefixes the (repo-relative) links. Returns the number of open rows emitted.
function renderGroup(lines, label, dirPath, relDir) {
  const files = listMarkdown(dirPath);
  const fixSet = new Set(files.filter(isFix));
  const issues = files.filter((n) => !isFix(n));
  const issueSet = new Set(issues);
  // Fixes whose issue isn't in this folder (e.g. the issue was archived) still
  // deserve a row so the proposal isn't orphaned silently.
  const orphanFixes = [...fixSet].filter((fn) => !issueSet.has(issueFileForFix(fn))).sort();
  const shown = issues.length + orphanFixes.length;

  lines.push(`## ${label} (${shown})`);
  lines.push("");
  if (shown === 0) {
    lines.push("_none_");
    lines.push("");
    return 0;
  }
  let count = 0;
  // Priority-first ordering (P2 before P3 …); unprioritized files sink to
  // the bottom of their folder. Ties break on filename (= severity band).
  const ordered = [...issues].sort((a, b) => {
    const pa = priorityOf(a) ?? "P9";
    const pb = priorityOf(b) ?? "P9";
    return pa === pb ? a.localeCompare(b) : pa.localeCompare(pb);
  });
  for (const name of ordered) {
    const filePath = path.join(dirPath, name);
    const title = displayTitle(titleLine(filePath));
    const summary = summaryLine(filePath);
    const link = mdLink(path.join(relDir, name));
    const pri = priorityOf(name);
    const priTag = pri ? `**${pri}** ` : "";
    const fixName = fixFileForIssue(name);
    const fixTag = fixSet.has(fixName)
      ? ` · 📝 [proposal](${mdLink(path.join(relDir, fixName))})`
      : "";
    lines.push(`- ${priTag}[${title}](${link})${summary ? ` — ${summary}` : ""}${fixTag}`);
    count += 1;
  }
  for (const name of orphanFixes) {
    const title = displayTitle(titleLine(path.join(dirPath, name)));
    const link = mdLink(path.join(relDir, name));
    lines.push(`- 📝 [${title}](${link}) — _proposal (issue archived)_`);
    count += 1;
  }
  lines.push("");
  return count;
}

// Append the shared completed roll-up (count + collapsed list).
function pushCompleted(lines, note) {
  let completedFiles = [];
  if (fs.existsSync(completedPath)) completedFiles = listMarkdown(completedPath);
  lines.push(`## ${completedDir} (${completedFiles.length})`);
  lines.push("");
  if (note) {
    lines.push(`_${note}_`);
    lines.push("");
  }
  if (completedFiles.length === 0) {
    lines.push("_none_");
  } else {
    lines.push("<details><summary>Show completed</summary>");
    lines.push("");
    for (const name of completedFiles) {
      const title = displayTitle(titleLine(path.join(completedPath, name)));
      lines.push(`- ${title}`);
    }
    lines.push("");
    lines.push("</details>");
  }
  lines.push("");
  return completedFiles.length;
}

// --- main -------------------------------------------------------------------
if (!fs.existsSync(ROOT)) {
  console.error(`reindex: root not found: ${ROOT}`);
  process.exit(1);
}

const dirNames = listDirs(ROOT);
const categoryDirs = dirNames.filter((d) => isCategoryDir(d)).sort();
const completedDir = dirNames.find((d) => isCompletedDir(d)) ?? "\u{1F4E6}completed"; // 📦completed
const completedPath = path.join(ROOT, completedDir);

// Category folders that carry a `refactors/` sub-track.
const refactorDirs = categoryDirs.filter((d) => isDir(path.join(ROOT, d, REFACTORS_DIR)));

// Every folder we clean/scan: the category folders and their refactors subfolders.
const scanTargets = [
  ...categoryDirs.map((d) => ({ dirPath: path.join(ROOT, d), rel: d })),
  ...refactorDirs.map((d) => ({
    dirPath: path.join(ROOT, d, REFACTORS_DIR),
    rel: path.join(d, REFACTORS_DIR),
  })),
];

let moved = 0;
const moves = [];

// 1) CLEAN — move done items out of every scanned folder into the shared archive.
for (const { dirPath, rel } of scanTargets) {
  for (const name of listMarkdown(dirPath)) {
    const filePath = path.join(dirPath, name);
    if (isDoneTitle(titleLine(filePath))) {
      const dest = moveInto(filePath, completedPath);
      moves.push(`${rel}/${name} → ${completedDir}/${path.basename(dest)}`);
      moved += 1;
    }
  }
}

// Highest issue number in use anywhere (open in both tracks + the completed
// archive) — the collision-safe ceiling advertised in each summary's front matter.
let maxIssueNumber = 0;
for (const { dirPath } of scanTargets) {
  for (const n of listMarkdown(dirPath).map(numberOf)) {
    if (n !== null && n > maxIssueNumber) maxIssueNumber = n;
  }
}
if (fs.existsSync(completedPath)) {
  for (const n of listMarkdown(completedPath).map(numberOf)) {
    if (n !== null && n > maxIssueNumber) maxIssueNumber = n;
  }
}

// 2) INDEX — one file per track.
const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");

// 2a) _index.md — the review items in each `for*` folder.
const idx = [];
idx.push(
  ...frontMatterLines(
    categoryDirs.map((d) => ({ rel: d, dirPath: path.join(ROOT, d) })),
  ),
);
idx.push("# Feedback index");
idx.push("");
idx.push(`_Auto-generated by \`reindex.mjs\` — do not edit by hand. Last run: ${now}_`);
idx.push("");
idx.push(
  "To close an item: prepend `✅ ` to its first line, then run `node reindex.mjs`. " +
    "It moves to `" + completedDir + "/` and drops off this list.",
);
idx.push("");
idx.push(
  "A 📝 proposal link means the item has a `<name>.fix.md` beside it. When the fix " +
    "is committed, mark **both** the issue and its `.fix.md` with a leading `✅ `.",
);
idx.push("");
if (refactorDirs.length) {
  idx.push("Refactor-track items live in `for*/refactors/` and are indexed in `_refactors.md`.");
  idx.push("");
}
let openCount = 0;
for (const dir of categoryDirs) {
  openCount += renderGroup(idx, dir, path.join(ROOT, dir), dir);
}
const completedCount = pushCompleted(idx, null);
if (!DRY_RUN) fs.writeFileSync(path.join(ROOT, "_index.md"), idx.join("\n"));

// 2b) _refactors.md — the items in each `for*/refactors/` folder.
let refactorCount = 0;
if (refactorDirs.length) {
  const ref = [];
  ref.push(
    ...frontMatterLines(
      refactorDirs.map((d) => ({
        rel: `${d}/${REFACTORS_DIR}`,
        dirPath: path.join(ROOT, d, REFACTORS_DIR),
      })),
    ),
  );
  ref.push("# Refactor index");
  ref.push("");
  ref.push(`_Auto-generated by \`reindex.mjs\` — do not edit by hand. Last run: ${now}_`);
  ref.push("");
  ref.push(
    "Refactors are a sub-track of the feedback queue: structural cleanups that live " +
      "in a `refactors/` subfolder of each area (`forIOS/refactors/`, …). Same file " +
      "format, same priorities, same close flow as `_index.md`.",
  );
  ref.push("");
  ref.push(
    "To close a refactor: prepend `✅ ` to its first line, then run `node reindex.mjs`. " +
      "It moves to `" + completedDir + "/` and drops off this list.",
  );
  ref.push("");
  ref.push(
    "A 📝 proposal link means the item has a `<name>.fix.md` beside it. Mark **both** " +
      "with a leading `✅ ` once the refactor is committed.",
  );
  ref.push("");
  for (const dir of refactorDirs) {
    refactorCount += renderGroup(ref, dir, path.join(ROOT, dir, REFACTORS_DIR), path.join(dir, REFACTORS_DIR));
  }
  pushCompleted(ref, "shared archive — includes non-refactor items for now");
  if (!DRY_RUN) fs.writeFileSync(path.join(ROOT, "_refactors.md"), ref.join("\n"));
}

// --- report -----------------------------------------------------------------
console.log(`reindex: root ${path.relative(process.cwd(), ROOT) || "."}${DRY_RUN ? "  (dry-run)" : ""}`);
if (moves.length) {
  console.log(`  moved ${moved} completed file(s):`);
  for (const m of moves) console.log(`    ${m}`);
} else {
  console.log("  moved 0 completed files");
}
console.log(`  indexed ${openCount} open item(s) across ${categoryDirs.length} folder(s) → _index.md`);
if (refactorDirs.length) {
  console.log(`  indexed ${refactorCount} open refactor(s) across ${refactorDirs.length} folder(s) → _refactors.md`);
}
console.log(`  completed archive holds ${completedCount} file(s)`);
