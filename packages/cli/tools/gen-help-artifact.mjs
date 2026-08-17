#!/usr/bin/env node
/**
 * Generate `cli-go/internal/help/artifact.txt` — every byte the CLI's help
 * surface can emit, captured by RUNNING the Node CLI.
 *
 *   npm run -w @bullmoose/cli gen:docs      # writes it, with man/ and docs/cli.md
 *   node tools/gen-help-artifact.mjs --check
 *
 * ── Why an artifact instead of a Go port of the renderers ────────────────────
 *
 * `packages/cli/src/help.ts` is a spec plus four renderers (human, --json,
 * --man, --markdown). Porting the renderers to Go would mean porting the word
 * wrap, the roff escaping and the Markdown table escaping, and then defending
 * three languages'-worth of off-by-one against a byte-identity requirement
 * forever. But the wrap is FIXED-WIDTH (`wrap(desc, 76)`,
 * `wrapHanging(…, 22, 78)`) — not terminal-width — so every one of these outputs
 * is a CONSTANT. A constant does not need a renderer; it needs to be shipped.
 *
 * So: Node renders, this file captures, Go looks up. Byte-identity is not
 * asserted, it is structural — the Go binary prints Node's own bytes.
 *
 * ── Why it EXECS rather than importing the renderers ─────────────────────────
 *
 * The unit of capture is an INVOCATION, not a function call: which stream each
 * byte went to and what the process exited with are as much a part of the
 * contract as the text (`arch.md` §1.1 — stdout carries records, stderr carries
 * chrome; §1.5 — the exit-code table). `bullmoose help` and `bullmoose` with no
 * command print the SAME overview to DIFFERENT streams with different exit
 * codes, and only main.ts knows that. Running it is how those bytes stay honest
 * without this file re-deriving main.ts's help block.
 *
 * ── The one thing that cannot be enumerated ──────────────────────────────────
 *
 * `unknown command: <x>` takes arbitrary user text, so it is captured ONCE with
 * a sentinel topic and stored as a template; the Go side substitutes. That keeps
 * even the error prose generated rather than transcribed.
 *
 * Not captured, and deliberately: `node:util`'s parseArgs refusals
 * (`log --no-such-flag`). Those strings are Node's, not bullmoose's — the Go
 * front door delegates any argv parseArgs would reject, so Node keeps printing
 * them. See cli-go/internal/delegate/help.go.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PKG = join(HERE, "..");
const REPO = join(PKG, "..", "..");

/** The CLI whose bytes are the truth. */
export const CLI_PATH = join(PKG, "bin", "bullmoose.mjs");
/** The spec the artifact is generated from; its hash is the drift check. */
export const SPEC_PATH = join(PKG, "src", "help.ts");
/** Where the Go binary embeds it from. `go:embed` cannot reach outside cli-go. */
export const ARTIFACT_PATH = join(REPO, "cli-go", "internal", "help", "artifact.txt");
/** The regenerate command every drift check names. */
export const REGENERATE = "npm run -w @bullmoose/cli gen:docs";

/**
 * The sentinel topic. It stands in for arbitrary user text in the two
 * unknown-command payloads, and the Go side replaces it. Chosen to be
 * argv-safe, greppable, and impossible in the rendered overview.
 */
const PLACEHOLDER = "__BM_TOPIC__";

const FORMAT = "bullmoose-help-artifact 1";

/** One invocation, run for real. */
function capture(args) {
  const db = join(mkdtempSync(join(tmpdir(), "bm-help-")), "mail.db");
  try {
    const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        // `bullmoose <unknown>` opens the mirror before it reaches the switch
        // default, so the capture must not touch the developer's real db.
        BULLMOOSE_DB: db,
        NO_COLOR: "",
      },
    });
    if (r.error) throw r.error;
    return { argv: args, exit: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(dirname(db), { recursive: true, force: true });
  }
}

const same = (a, b) => a.exit === b.exit && a.stdout === b.stdout && a.stderr === b.stderr;
const shape = (r) => `exit=${r.exit} stdout=${r.stdout.length}B stderr=${r.stderr.length}B`;

function fail(message) {
  process.stderr.write(`gen-help-artifact: ${message}\n`);
  process.exit(1);
}

/**
 * Build every entry, and check the invariants the Go lookup relies on.
 *
 * Returns entries in a fixed order so the artifact is a deterministic function
 * of the spec — regenerating without editing help.ts must produce zero diff, or
 * the drift check becomes noise nobody reads.
 */
export function buildArtifact() {
  const entries = [];
  const add = (key, r) => entries.push({ key, ...r });

  // `help --json` first: it carries the command list every other entry is
  // derived from, so the artifact's coverage comes from the spec itself rather
  // than from a list kept here.
  const json = capture(["help", "--json"]);
  if (json.exit !== 0) fail(`help --json exited ${json.exit}: ${json.stderr}`);
  let spec;
  try {
    spec = JSON.parse(json.stdout);
  } catch (e) {
    fail(`help --json is not JSON (${e.message}) — the artifact would be useless to an agent`);
  }
  const commands = spec.commands.map((c) => c.name);
  if (commands.length < 20) fail(`only ${commands.length} commands in the spec — did help --json change shape?`);

  add("json", json);
  add("man", capture(["help", "--man"]));
  add("markdown", capture(["help", "--markdown"]));

  // The overview, twice: help that was ASKED for is a record (stdout, exit 0);
  // help printed because the invocation was wrong is chrome (stderr, exit 2).
  // main.ts:205-237 is the only place that distinction lives.
  const overview = capture(["help"]);
  add("overview", overview);
  add("overview-usage", capture([]));
  // The three other spellings of "the overview, please" — all must land on the
  // one entry the Go side serves, or a route it takes is a route nothing pinned.
  for (const argv of [["--help"], ["-h"], ["help", "--help"]]) {
    const r = capture(argv);
    if (!same(overview, r)) {
      fail(`\`bullmoose ${argv.join(" ")}\` (${shape(r)}) is not the overview (${shape(overview)})`);
    }
  }

  // One entry per command. `bullmoose <cmd> --help` renders the same bytes, so
  // it is VERIFIED here and stored once rather than duplicated.
  //
  // `help` is the exception, and the check found it: main.ts:209 reads the topic
  // as `command !== "help" ? command : positionals[1]`, so `bullmoose help
  // --help` carries NO topic and is the overview, while `bullmoose help help` is
  // the `help` command's page. Both are pinned rather than papered over — the Go
  // router has to reproduce that same asymmetry.
  for (const name of commands) {
    const viaHelp = capture(["help", name]);
    if (name !== "help") {
      const viaFlag = capture([name, "--help"]);
      if (!same(viaHelp, viaFlag)) {
        fail(
          `\`help ${name}\` (${shape(viaHelp)}) and \`${name} --help\` (${shape(viaFlag)}) differ; ` +
            `the artifact stores one entry for both routes, so they must not`,
        );
      }
    }
    add(`command:${name}`, viaHelp);
  }

  // The two unknown-command paths, captured with a sentinel. They are rendered
  // by different code (main.ts:224 in the help block, main.ts:429 in the switch
  // default) and happen to agree; both are stored so a future divergence is
  // carried rather than lost.
  const unknownTopic = capture(["help", PLACEHOLDER]);
  const unknownCommand = capture([PLACEHOLDER]);
  for (const [key, r] of [
    ["unknown-topic", unknownTopic],
    ["unknown-command", unknownCommand],
  ]) {
    const hits = r.stderr.split(PLACEHOLDER).length - 1;
    if (hits !== 1) fail(`${key} must carry the sentinel exactly once, found ${hits}`);
    if (r.stdout !== "") fail(`${key} wrote to stdout — an error's help is chrome (§1.1)`);
    add(key, r);
  }

  for (const e of entries) {
    // The Go side writes one stream per entry and asserts nothing about
    // interleaving; that is only sound while no entry uses both.
    if (e.stdout !== "" && e.stderr !== "") {
      fail(`${e.key} wrote to BOTH streams — the lookup cannot reproduce the interleaving`);
    }
    if (e.exit !== 0 && e.exit !== 2) fail(`${e.key} exited ${e.exit}; help is only ever 0 or 2 (§1.5)`);
    if (e.stdout === "" && e.stderr === "") fail(`${e.key} produced nothing`);
  }

  return render(entries, commands);
}

/**
 * The file format. Length-framed rather than JSON-encoded so the artifact stays
 * diffable: a reviewer sees the help text change, not a wall of `\n` escapes.
 *
 *   bullmoose-help-artifact 1
 *   spec <path> sha256=<hex>
 *   placeholder <sentinel>
 *   commands <name> <name> …
 *   --
 *   entry <key> <exit> <stdout-bytes> <stderr-bytes>
 *   <stdout><LF><stderr><LF>
 *   …
 *
 * Byte counts, not delimiters: help text contains every plausible delimiter
 * (backticks, pipes, `---`, roff dots) and none of it may be escaped, because
 * escaping is where byte-identity goes to die.
 */
function render(entries, commands) {
  const enc = new TextEncoder();
  const parts = [];
  for (const e of entries) {
    const out = enc.encode(e.stdout).length;
    const err = enc.encode(e.stderr).length;
    parts.push(`entry ${e.key} ${e.exit} ${out} ${err}\n`, e.stdout, "\n", e.stderr, "\n");
  }
  const body = parts.join("");

  return (
    [
      FORMAT,
      // Two hashes, because there are two ways to be wrong and only one of them
      // needs a repo to detect. `spec` answers "were these bytes generated from
      // THIS help.ts?" — the drift the whole design turns on. `body` answers
      // "are these still the bytes that were generated?", which is the one check
      // that works in a bare cli-go checkout with no Node and no TypeScript
      // anywhere: a hand-edit or a corrupted copy fails it on its own.
      `spec packages/cli/src/help.ts sha256=${sha256(readFileSync(SPEC_PATH))}`,
      `body sha256=${sha256(Buffer.from(body, "utf8"))}`,
      `placeholder ${PLACEHOLDER}`,
      `commands ${commands.join(" ")}`,
      "--",
      "",
    ].join("\n") + body
  );
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function main() {
  const check = process.argv.includes("--check");
  const artifact = buildArtifact();
  const existing = (() => {
    try {
      return readFileSync(ARTIFACT_PATH, "utf8");
    } catch {
      return null;
    }
  })();

  if (check) {
    if (existing === artifact) {
      process.stderr.write(`gen-help-artifact: up to date (${artifact.length} bytes)\n`);
      return;
    }
    fail(
      `${ARTIFACT_PATH} is STALE — the Go CLI would print help the Node CLI no longer renders.\n` +
        `    fix: ${REGENERATE}`,
    );
  }

  mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
  writeFileSync(ARTIFACT_PATH, artifact);
  process.stderr.write(
    `gen-help-artifact: ${ARTIFACT_PATH} (${artifact.length} bytes)${existing === artifact ? " — unchanged" : ""}\n`,
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
