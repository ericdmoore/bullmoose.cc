import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A literal NUL byte anywhere in a text file makes `grep` treat the WHOLE file
// as binary: it prints "Binary file … matches" at most, usually nothing, and
// exits 0. Not an error, not a warning — the file simply stops existing as far
// as every search in this repo is concerned.
//
// That is worse than it sounds, because the tool that hides the file is the
// same tool used to prove things about the codebase. `packages/scheduling/src/
// jobGraph.ts` carried one (a deliberate uncollidable sentinel, written as a
// raw byte) and it holds the claim gate and the budget SQL — so `grep -rn
// budget_micros` answered, convincingly and wrongly, that it is not there.
//
// The value is identical written as `\u0000`. Only the on-disk byte differs,
// and only the on-disk byte breaks the tooling. This test is the whole reason
// the escape survives someone "simplifying" it back.

/** Tracked, non-binary source. Binary assets legitimately contain NULs. */
const BINARY_EXT =
  /\.(png|jpg|jpeg|gif|ico|webp|avif|pdf|zip|gz|tgz|wasm|woff2?|ttf|otf|eot|mp[34]|mov|db|sqlite3?|bin|node|sketch)$/i;

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

function trackedTextFiles(): string[] {
  // -z: NUL-separated, so a filename with a newline cannot desync the list.
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((f) => f !== "" && !BINARY_EXT.test(f));
}

describe("source files stay greppable", () => {
  it("no tracked text file contains a literal NUL byte", () => {
    const offenders: string[] = [];
    for (const rel of trackedTextFiles()) {
      let buf: Buffer;
      try {
        buf = readFileSync(join(ROOT, rel));
      } catch {
        continue; // a submodule entry or a broken symlink is not our business
      }
      const at = buf.indexOf(0);
      if (at !== -1) {
        const line = buf.subarray(0, at).toString("utf8").split("\n").length;
        offenders.push(`${rel}:${line}`);
      }
    }

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These files contain a literal NUL, so grep skips them silently:\n` +
            offenders.map((o) => `  ${o}`).join("\n") +
            `\n\nWrite it as the escape \\u0000 instead — same value, and the file ` +
            `stays searchable. If a file here is genuinely binary, add its ` +
            `extension to BINARY_EXT rather than deleting this assertion.`,
    ).toEqual([]);
  });

  it("bites — a file with a raw NUL is detected where the escaped form is not", () => {
    // Proving the check works without writing a NUL into the tree: the same
    // two strings, one raw and one escaped, as this test's own fixture.
    const raw = Buffer.from(`const S = "\u0000x";\n`, "utf8");
    const escaped = Buffer.from(`const S = "\\u0000x";\n`, "utf8");
    expect(raw.indexOf(0)).not.toBe(-1);
    expect(escaped.indexOf(0)).toBe(-1);
    // …and both denote the identical runtime value, which is why the swap is safe.
    expect(JSON.parse('"\\u0000x"')).toBe("\u0000x");
  });
});
