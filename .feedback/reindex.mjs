#!/usr/bin/env node
// reindex.mjs — the .feedback index generator.
//
// ONE script for the whole tree. It walks every provider folder (`from*/`),
// groups each one's issues by the subsystem folders declared in `config.yml`,
// and writes a single `.feedback/_index.md`.
//
// Usage:
//   node .feedback/reindex.mjs              # index every provider
//   node .feedback/reindex.mjs fromClaude   # index one provider
//   node .feedback/reindex.mjs --dry-run    # print the report, write nothing
//
// Zero dependencies. Idempotent — and a pure function of the tree: there is no
// timestamp in the output, so re-running it with nothing changed produces no
// diff. That matters because `_index.md` is committed.
//
// ---------------------------------------------------------------------------
// Three things this script used to get wrong, all inherited from the
// tensr.fitness original. See fromClaude/common/021.
//
//  1. Category discovery was `name.startsWith("for")`, because tensr's folders
//     were `forIOS/`, `forAndroid/`. Nothing in THIS repo starts with "for"
//     ("from" is a near-miss that reads as though it should match), so the
//     script indexed 0 items across 0 folders and reported that as success.
//     Categories now come from `config.yml`, which readme.md already called
//     the authoritative list but which nothing read.
//
//  2. Done-detection read the ✅ off the first LINE of the file. This repo
//     marks a closed issue with a ✅ prefix on the FILENAME
//     (`✅001 -P1- ….md`) — that matched 1 file out of 13. Both are accepted
//     now; the filename is canonical (see readme.md).
//
//  3. `numberOf` and `priorityOf` matched `001-P1-slug.md`. Every filename in
//     this repo is `001 -P1- slug.md`, WITH spaces, so both returned null for
//     every file on disk. The priority ordering and the `next:` bookkeeping
//     were dead code that silently produced nothing.
//
// It also no longer MOVES closed items into a `📦completed/` archive. That
// archive has never existed here: 13 issues were closed in place with a ✅
// filename prefix, and issues cross-reference each other by path
// (`common/021`, `cli/010`), which relocating them would break. Closed items
// are listed under a fold, not moved. This script's only write is _index.md.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run") || argv.includes("-n");
const onlyProvider = argv.find((a) => !a.startsWith("-")) ?? null;

// --- config -----------------------------------------------------------------
// readme.md: "use config.yml for the authoritative list of the TLCs". The
// folder on disk is `label ?? name` (`cloud-infra` → `infra`).
//
// A hand-rolled reader for this exact shape keeps the script dependency-free,
// which is worth more here than generality — it runs from a bare `node` with
// no install step.
function readCategories(configPath) {
  if (!fs.existsSync(configPath)) {
    console.error(`reindex: config not found: ${configPath}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(configPath, "utf8").split(/\r?\n/);
  const out = [];
  let inComponents = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (/^components:\s*$/.test(line)) {
      inComponents = true;
      continue;
    }
    // Any other unindented key ends the components block (e.g. `sources:`).
    if (/^\S/.test(line)) {
      if (inComponents) break;
      continue;
    }
    if (!inComponents) continue;

    const unquote = (v) => v.trim().replace(/^['"]|['"]$/g, "").trim();
    const item = line.match(/^\s*-\s*name:\s*(.+)$/);
    if (item) {
      out.push({ name: unquote(item[1]), label: null });
      continue;
    }
    const label = line.match(/^\s*label:\s*(.+)$/);
    if (label && out.length) out[out.length - 1].label = unquote(label[1]);
  }
  if (out.length === 0) {
    console.error(`reindex: no components found in ${configPath}`);
    process.exit(1);
  }
  // `unquote` trims, which also absorbs config.yml's trailing-space entry.
  return out.map((c) => c.label || c.name);
}

const CATEGORIES = readCategories(path.join(SCRIPT_DIR, "config.yml"));

// --- done-detection ---------------------------------------------------------
// Matching the base codepoint also catches the emoji-presentation forms
// (base char + U+FE0F variation selector).
const CHECK_GLYPHS = ["✅", "✔", "✓", "☑", "\u{1F5F9}"];

/**
 * Strip leading markdown hashes, whitespace and check glyphs, in any order.
 * Returns [text, sawCheckGlyph].
 *
 * Only LEADING glyphs count. `title.includes("✅")` — what this used to do —
 * would call an issue closed because its title happened to quote a checkmark.
 */
function stripLeading(input) {
  let s = input;
  let checked = false;
  let prev;
  do {
    prev = s;
    s = s.replace(/^[\s#]+/, "");
    for (const g of CHECK_GLYPHS) {
      while (s.startsWith(g)) {
        s = s.slice(g.length);
        checked = true;
      }
    }
    s = s.replace(/^️/, ""); // stray variation selector after a glyph
  } while (s !== prev);
  return [s.trim(), checked];
}

// --- file helpers -----------------------------------------------------------
const SKIP_FILES = new Set(["_index.md", "_refactors.md"]);
const isReadme = (name) => /^readme(\.md)?$/i.test(name);

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
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

/** First non-empty line of a file, minus a UTF-8 BOM. */
function titleLine(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^﻿/, "");
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() !== "") return line.trim();
  }
  return "";
}

/** Optional one-line summary: a leading blockquote ("> …") after the title. */
function summaryLine(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^﻿/, "");
  let seenTitle = false;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "") continue;
    if (!seenTitle) {
      seenTitle = true;
      continue;
    }
    return t.startsWith(">") ? t.replace(/^>\s?/, "").trim() : "";
  }
  return "";
}

// --- filename grammar -------------------------------------------------------
// `[✅]<num> -P<n>- <Slug>.md` — note the spaces around the priority, which is
// exactly what the original regexes missed.
const bare = (name) => stripLeading(name)[0];
const numberOf = (name) => {
  const m = bare(name).match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
};
const priorityOf = (name) => bare(name).match(/^\d+\s*-\s*(P\d+)\s*-/)?.[1] ?? null;

// A `<stem>.fix.md` is a fix PROPOSAL attached to issue `<stem>.md`. It is
// rendered inline on the issue's row (📝 proposal), not as its own item.
const FIX_SUFFIX = ".fix.md";
const isFix = (n) => n.endsWith(FIX_SUFFIX);
const issueForFix = (n) => n.slice(0, -FIX_SUFFIX.length) + ".md";
const fixForIssue = (n) => n.slice(0, -".md".length) + FIX_SUFFIX;

/** Markdown-safe relative link target (encode spaces, emoji, …). */
const mdLink = (rel) => encodeURI(rel.split(path.sep).join("/"));

// --- scan -------------------------------------------------------------------
const providers = listDirs(SCRIPT_DIR)
  .filter((d) => d.startsWith("from"))
  .filter((d) => (onlyProvider ? d === onlyProvider : true))
  .sort();

if (providers.length === 0) {
  console.error(
    onlyProvider
      ? `reindex: no such provider folder: ${onlyProvider}`
      : `reindex: no provider folders (from*/) under ${SCRIPT_DIR}`,
  );
  process.exit(1);
}

/**
 * One record per issue file. `closed` is true when the ✅ is on the filename
 * (canonical) or on the title line (tolerated).
 */
function scanCategory(provider, category) {
  const dirPath = path.join(SCRIPT_DIR, provider, category);
  const files = listMarkdown(dirPath);
  const fixes = new Set(files.filter(isFix));
  const issues = files.filter((n) => !isFix(n));
  const issueSet = new Set(issues);

  const rel = path.join(provider, category);
  const items = issues.map((name) => {
    const filePath = path.join(dirPath, name);
    const [title, checkedTitle] = stripLeading(titleLine(filePath));
    const fixName = fixForIssue(name);
    return {
      name,
      title: title || "(untitled)",
      summary: summaryLine(filePath),
      priority: priorityOf(name),
      number: numberOf(name),
      closed: stripLeading(name)[1] || checkedTitle,
      link: mdLink(path.join(rel, name)),
      fixLink: fixes.has(fixName) ? mdLink(path.join(rel, fixName)) : null,
    };
  });

  // A proposal whose issue file is gone still deserves a row, so it is not
  // orphaned silently.
  for (const fixName of [...fixes].filter((f) => !issueSet.has(issueForFix(f))).sort()) {
    const filePath = path.join(dirPath, fixName);
    const [title, checkedTitle] = stripLeading(titleLine(filePath));
    items.push({
      name: fixName,
      title: `${title || "(untitled)"} — _proposal (issue file missing)_`,
      summary: "",
      priority: priorityOf(fixName),
      number: numberOf(fixName),
      closed: stripLeading(fixName)[1] || checkedTitle,
      link: mdLink(path.join(rel, fixName)),
      fixLink: null,
    });
  }

  // Priority first (P1 before P2 …), then filename. Unprioritised files sink.
  items.sort((a, b) => {
    const pa = a.priority ?? "P9";
    const pb = b.priority ?? "P9";
    return pa === pb ? a.name.localeCompare(b.name) : pa.localeCompare(pb);
  });
  return items;
}

const tree = providers.map((provider) => {
  const present = new Set(listDirs(path.join(SCRIPT_DIR, provider)));
  const categories = CATEGORIES.filter((c) => present.has(c)).map((category) => ({
    category,
    items: scanCategory(provider, category),
  }));
  // A folder that is not in config.yml is a typo or a new component nobody
  // declared. Silence is how the old script hid its own bug; say it out loud.
  const undeclared = [...present].filter((d) => !CATEGORIES.includes(d)).sort();
  return { provider, categories, undeclared };
});

const allItems = tree.flatMap((p) => p.categories.flatMap((c) => c.items));
const totalOpen = allItems.filter((i) => !i.closed).length;
const totalClosed = allItems.filter((i) => i.closed).length;

// --- render -----------------------------------------------------------------
const out = [];

// Front matter: the next free issue number per provider. Numbering in this
// repo is ONE sequence per provider, shared across its subsystem folders —
// fromClaude runs 001–027 across common/cli/infra/agentic/webUI, and fromCodex
// runs its own 001–007. (The original's "severity bands" keyed off the issue
// number were a tensr convention this repo never adopted, and the data
// contradicts them: `024 -P1-` is a P1 sitting in what they called the medium
// band.)
out.push("---");
out.push("# reindex.mjs bookkeeping (auto-generated). Agents: before filing a new issue,");
out.push("# read next.<provider> and use it as the <num> prefix so numbers don't collide.");
out.push("# Numbering is one sequence per provider, shared across its subsystem folders.");
out.push("next:");
for (const p of tree) {
  const nums = p.categories.flatMap((c) => c.items.map((i) => i.number)).filter((n) => n !== null);
  out.push(`  ${p.provider}: ${nums.length ? Math.max(...nums) + 1 : 1}`);
}
out.push("---");
out.push("");
out.push("# Feedback index");
out.push("");
out.push("_Auto-generated by `reindex.mjs` — do not edit by hand. Run `node .feedback/reindex.mjs`._");
out.push("");
out.push(`**${totalOpen} open · ${totalClosed} closed** across ${providers.length} provider(s).`);
out.push("");
out.push(
  "To close an item: prepend `✅` (no space) to the filename of **both** the issue and " +
    "its `.fix.md`, then re-run the indexer. Closed items stay in their folder and move " +
    "under the fold here — nothing is relocated, because issues reference each other by path.",
);
out.push("");

for (const p of tree) {
  const items = p.categories.flatMap((c) => c.items);
  const open = items.filter((i) => !i.closed).length;
  const closed = items.length - open;
  out.push(`## ${p.provider} — ${open} open · ${closed} closed`);
  out.push("");

  if (p.undeclared.length) {
    out.push(
      `> ⚠️ Folder(s) not declared in \`config.yml\`: ${p.undeclared
        .map((d) => `\`${d}\``)
        .join(", ")} — items inside are NOT indexed.`,
    );
    out.push("");
  }
  if (items.length === 0) {
    out.push("_no items_");
    out.push("");
    continue;
  }

  for (const { category, items: catItems } of p.categories) {
    const openItems = catItems.filter((i) => !i.closed);
    const closedItems = catItems.filter((i) => i.closed);
    out.push(`### ${category} — ${openItems.length} open · ${closedItems.length} closed`);
    out.push("");
    if (openItems.length === 0) {
      out.push("_none open_");
      out.push("");
    } else {
      for (const i of openItems) {
        const pri = i.priority ? `**${i.priority}** ` : "";
        const fix = i.fixLink ? ` · 📝 [proposal](${i.fixLink})` : "";
        out.push(`- ${pri}[${i.title}](${i.link})${i.summary ? ` — ${i.summary}` : ""}${fix}`);
      }
      out.push("");
    }
    if (closedItems.length) {
      out.push(`<details><summary>${closedItems.length} closed</summary>`);
      out.push("");
      for (const i of closedItems) {
        const fix = i.fixLink ? ` · 📝 [proposal](${i.fixLink})` : "";
        out.push(`- ✅ [${i.title}](${i.link})${fix}`);
      }
      out.push("");
      out.push("</details>");
      out.push("");
    }
  }
}

if (!DRY_RUN) fs.writeFileSync(path.join(SCRIPT_DIR, "_index.md"), out.join("\n"));

// --- report -----------------------------------------------------------------
console.log(`reindex: ${SCRIPT_DIR}${DRY_RUN ? "  (dry-run)" : ""}`);
console.log(`  categories from config.yml: ${CATEGORIES.join(", ")}`);
for (const p of tree) {
  const items = p.categories.flatMap((c) => c.items);
  const open = items.filter((i) => !i.closed).length;
  console.log(
    `  ${p.provider}: ${open} open, ${items.length - open} closed ` +
      `across ${p.categories.length} folder(s)`,
  );
  for (const d of p.undeclared) {
    console.log(`    ⚠️  undeclared folder (not indexed): ${d}`);
  }
}
console.log(`  total: ${totalOpen} open, ${totalClosed} closed → _index.md`);
