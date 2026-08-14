import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  helpJson,
  renderCommand,
  renderMan,
  renderMarkdown,
  renderOverview,
} from "./help.js";

/**
 * The Go CLI does not render help — it ships Node's. `gen-help-artifact.mjs`
 * runs this CLI once per help invocation and captures each one's exact bytes
 * into `cli-go/internal/help/artifact.txt`, which the Go binary embeds and looks
 * up. That is what makes `bullmoose help` byte-identical across two languages
 * without a word-wrap, a roff escaper or a Markdown table escaper existing twice.
 *
 * The design has exactly one failure mode: help.ts moves and the artifact does
 * not. So it is checked twice, from both sides —
 *
 *   - here, by re-rendering every entry from the spec IN PROCESS and
 *     byte-comparing the whole file. Fast (no build, no spawn), and it catches
 *     any edit to the spec or the renderers;
 *   - in `cli-go/internal/help/artifact_test.go`, by comparing this file's hash
 *     against the one recorded in the artifact header — the check that still
 *     runs where there is no Node at all.
 *
 * The expected bytes are rebuilt here rather than imported from the generator on
 * purpose: a check that reuses the thing it is checking cannot see a bug in it.
 * The table below is the only knowledge duplicated — main.ts:205-237's stream
 * and exit code per help invocation, which is six lines and is exactly what the
 * Go router has to reproduce.
 */

const ARTIFACT = fileURLToPath(new URL("../../../cli-go/internal/help/artifact.txt", import.meta.url));
const SPEC = fileURLToPath(new URL("./help.ts", import.meta.url));
const REGENERATE = "npm run -w @bullmoose/cli gen:docs";
const PLACEHOLDER = "__BM_TOPIC__";

interface Entry {
  key: string;
  exit: number;
  stdout: string;
  stderr: string;
}

/** `out(x)` and `note(x)` append the newline; `outRaw` does not (io.ts:206). */
const asked = (key: string, text: string): Entry => ({ key, exit: 0, stdout: text, stderr: "" });
const chrome = (key: string, text: string): Entry => ({ key, exit: 2, stdout: "", stderr: text });

/** main.ts:224 / :429 — the message, a blank line, then the whole overview. */
const unknown = (key: string) =>
  chrome(key, `unknown command: ${PLACEHOLDER}\n\n${renderOverview()}\n`);

function expectedEntries(): Entry[] {
  return [
    asked("json", `${helpJson()}\n`), // outRaw, main.ts:211
    asked("man", renderMan()), // outRaw, and renderMan already ends in \n
    asked("markdown", `${renderMarkdown()}\n`),
    asked("overview", `${renderOverview()}\n`), // help that was ASKED for: stdout, 0
    chrome("overview-usage", `${renderOverview()}\n`), // help because the invocation was wrong: stderr, 2
    ...COMMANDS.map((c) => asked(`command:${c.name}`, `${renderCommand(c)}\n`)),
    unknown("unknown-topic"),
    unknown("unknown-command"),
  ];
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** The length-framed format, rebuilt. Byte counts, so multibyte help text frames right. */
function expectedArtifact(): string {
  const body = expectedEntries()
    .map(
      (e) =>
        `entry ${e.key} ${e.exit} ${Buffer.byteLength(e.stdout)} ${Buffer.byteLength(e.stderr)}\n` +
        `${e.stdout}\n${e.stderr}\n`,
    )
    .join("");
  const head = [
    "bullmoose-help-artifact 1",
    `spec packages/cli/src/help.ts sha256=${sha256(readFileSync(SPEC))}`,
    `body sha256=${sha256(Buffer.from(body, "utf8"))}`,
    `placeholder ${PLACEHOLDER}`,
    `commands ${COMMANDS.map((c) => c.name).join(" ")}`,
    "--",
    "",
  ].join("\n");
  return head + body;
}

/** Split at the header terminator, so a hash change and a text change report separately. */
function split(artifact: string): { head: string; body: string } {
  const at = artifact.indexOf("\n--\n");
  return { head: artifact.slice(0, at), body: artifact.slice(at + 4) };
}

describe("the embedded help artifact", () => {
  it("was generated from THIS help.ts", () => {
    const committed = split(readFileSync(ARTIFACT, "utf8")).head;
    const rebuilt = split(expectedArtifact()).head;
    if (committed !== rebuilt) {
      expect.fail(
        `cli-go/internal/help/artifact.txt was generated from a different ${"packages/cli/src/help.ts"}.\n` +
          `    committed: ${committed.split("\n").find((l) => l.startsWith("spec "))}\n` +
          `    this spec:  ${rebuilt.split("\n").find((l) => l.startsWith("spec "))}\n` +
          `    fix: ${REGENERATE}`,
      );
    }
  });

  it("is exactly what this spec renders — regenerate it or the Go CLI drifts", () => {
    const committed = split(readFileSync(ARTIFACT, "utf8")).body;
    const rebuilt = split(expectedArtifact()).body;
    if (committed !== rebuilt) {
      // Name the entry that moved: a 220 KB diff is not a message.
      let at = 0;
      while (at < committed.length && committed[at] === rebuilt[at]) at++;
      const before = committed.slice(0, at);
      const key = before.slice(before.lastIndexOf("entry ")).split(" ")[1] ?? "?";
      expect.fail(
        `cli-go/internal/help/artifact.txt is STALE — the Go CLI would print help this CLI no longer renders.\n` +
          `    first difference: entry ${key}, ${at} bytes into the body\n` +
          `    fix: ${REGENERATE}`,
      );
    }
  });

  it("covers every command, so `bullmoose help <cmd>` can never miss", () => {
    const keys = new Set(expectedEntries().map((e) => e.key));
    for (const c of COMMANDS) expect(keys).toContain(`command:${c.name}`);
    // The four invocations with no command of their own.
    for (const k of ["overview", "overview-usage", "json", "man", "markdown"]) expect(keys).toContain(k);
  });

  it("keeps help that was asked for on stdout and help-as-refusal on stderr (§1.1)", () => {
    for (const e of expectedEntries()) {
      expect(e.stdout === "" || e.stderr === "", `${e.key} uses both streams`).toBe(true);
      expect(e.exit === 0 ? e.stdout : e.stderr, `${e.key} wrote to the wrong stream`).not.toBe("");
    }
  });

  it("carries the sentinel exactly once in each unenumerable entry", () => {
    // `unknown command: <x>` takes arbitrary user text, so it is the one help
    // output captured as a template. The Go side substitutes; a second
    // occurrence, or none, would put the sentinel in front of a user.
    for (const e of [unknown("unknown-topic"), unknown("unknown-command")]) {
      expect(e.stderr.split(PLACEHOLDER)).toHaveLength(2);
    }
    expect(renderOverview()).not.toContain(PLACEHOLDER);
  });
});
