#!/usr/bin/env node
// Fold Go coverage into the same summary the ratchet already reads.
//
// The ratchet gates on `coverage/coverage-summary.json`, which vitest writes
// and which therefore describes JS/TS only. `cli-go` was invisible to it — so
// a Go-only PR got a green "Coverage ratchet" check that had measured nothing
// of what the PR changed. That is worse than no check: it reads as a
// guarantee, and #284 (354 new lines of Go) passed it without a single Go
// statement being counted.
//
// This converts `go test -coverprofile` output into summary entries and merges
// them in, so `cli-go` becomes an ordinary tracked package with a floor like
// any other.
//
// ## Statements, reported as lines — and why that is honest here
//
// Go's profile counts STATEMENTS per block; istanbul's `lines` counts lines.
// They are not the same metric. Two things make the substitution safe for a
// ratchet specifically:
//
//   - a ratchet compares a package against ITSELF over time, never against
//     another package. The absolute number need only be stable and move in the
//     right direction, which statement coverage does.
//   - Go's own tooling reports `-func` percentages from these same counts, so
//     the floor here is the number `go tool cover` would print. A reader
//     checking by hand sees the same figure.
//
// What it must NOT do is pretend to be line coverage in a context that mixes
// the two. It never sums across languages: `aggregate()` groups by package,
// and `cli-go/...` lands in its own bucket.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Parse `go test -coverprofile` text.
 *
 * Format after the `mode:` line, one block per line:
 *   <file>:<startLine>.<startCol>,<endLine>.<endCol> <numStatements> <count>
 *
 * A file may appear many times; blocks are summed. `count` is an execution
 * count, so ANY non-zero means covered — a block run 400 times is not more
 * covered than one run once, and treating it as such would let a hot loop
 * paper over an untested branch.
 */
export function parseProfile(text) {
  const files = new Map();
  for (const line of text.split("\n")) {
    const m = /^(.+):(\d+)\.\d+,(\d+)\.\d+ (\d+) (\d+)$/.exec(line.trim());
    if (!m) continue; // the `mode:` header and any blank tail
    const [, file, , , stmtsRaw, countRaw] = m;
    const stmts = Number.parseInt(stmtsRaw, 10);
    const covered = Number.parseInt(countRaw, 10) > 0 ? stmts : 0;
    const cur = files.get(file) ?? { total: 0, covered: 0 };
    cur.total += stmts;
    cur.covered += covered;
    files.set(file, cur);
  }
  return files;
}

/** `github.com/org/repo/cli-go/internal/cmd/local.go` → `cli-go/internal/cmd/local.go`,
 *  so `packageOf` buckets it as `cli-go/internal` alongside everything else. */
export function toRepoPath(goPath, modulePrefix) {
  return goPath.startsWith(modulePrefix) ? goPath.slice(modulePrefix.length).replace(/^\/+/, "") : goPath;
}

const pct = (covered, total) => (total === 0 ? 100 : Math.round((covered * 10000) / total) / 100);

/** One summary entry in the shape vitest emits. Branches and functions are
 *  reported as zero-of-zero rather than guessed: the ratchet gates on LINES
 *  and inventing the other two would put fiction in a file people read. */
export function summaryEntry({ total, covered }) {
  const m = { total, covered, skipped: 0, pct: pct(covered, total) };
  return {
    lines: m,
    statements: m,
    functions: { total: 0, covered: 0, skipped: 0, pct: 100 },
    branches: { total: 0, covered: 0, skipped: 0, pct: 100 },
  };
}

export function merge(summary, profileText, { modulePrefix, root }) {
  const out = { ...summary };
  for (const [goPath, counts] of parseProfile(profileText)) {
    out[resolve(root, toRepoPath(goPath, modulePrefix))] = summaryEntry(counts);
  }
  return out;
}

const MODULE = "github.com/ericdmoore/bullmoose.cc";

if (import.meta.url === `file://${process.argv[1]}`) {
  const [profilePath = "cli-go/cover.out", summaryPath = "coverage/coverage-summary.json"] = process.argv.slice(2);
  if (!existsSync(profilePath)) {
    console.error(`go-coverage: no profile at ${profilePath} — did \`go test -coverprofile\` run?`);
    process.exit(1);
  }
  const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : {};
  const merged = merge(summary, readFileSync(profilePath, "utf8"), { modulePrefix: MODULE, root: process.cwd() });
  writeFileSync(summaryPath, JSON.stringify(merged));
  const added = Object.keys(merged).length - Object.keys(summary).length;
  console.log(`go-coverage: merged ${added} Go files into ${summaryPath}`);
}
