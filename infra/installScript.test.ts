import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// cli-go/deploy/install.sh is the first thing a stranger runs, and it is the
// one place in the project where we ask someone to pipe a URL into a shell.
// The promise that makes that acceptable is narrow and absolute: it verifies
// the checksum, and it installs NOTHING if verification fails.
//
// That promise is a property of the script's control flow, not of its
// comments, so it is tested against a served fixture rather than read. The
// case that matters is the tampered one — a script that "checks" a checksum
// and installs anyway is worse than one that never claimed to.

const run = promisify(execFile);
const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const SCRIPT = join(ROOT, "cli-go/deploy/install.sh");

const VERSION = "v9.9.9";
/** A stand-in "binary" that is executable and answers `version`, so the happy
 *  path can assert the script's final self-check actually ran. */
const FAKE_BINARY = `#!/bin/sh\necho "bullmoose ${VERSION} test-fixture"\n`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Which asset name this machine's uname will ask for. */
function assetName(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return `bullmoose_${VERSION}_${os}_${arch}`;
}

let server: Server;
let base: string;
/** Swapped per test to serve a good, tampered, or absent checksum line. */
let checksums = "";

beforeAll(async () => {
  const asset = assetName();
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/latest.txt") return res.end(VERSION);
    if (url === `/${VERSION}/checksums.txt`) return res.end(checksums);
    if (url === `/${VERSION}/${asset}`) return res.end(FAKE_BINARY);
    res.statusCode = 404;
    res.end("no");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => server?.close());

/** Run the installer into a throwaway bin dir; never touches the real one. */
async function install(): Promise<{ code: number; out: string; dest: string; installed: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "bm-install-test-"));
  const dest = join(dir, "bin", "bullmoose");
  try {
    const { stdout, stderr } = await run("sh", [SCRIPT, "--bin-dir", join(dir, "bin")], {
      env: { ...process.env, BULLMOOSE_DL_BASE: base },
    });
    return { code: 0, out: stdout + stderr, dest, installed: existsSync(dest) };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return {
      code: err.code ?? 1,
      out: (err.stdout ?? "") + (err.stderr ?? ""),
      dest,
      installed: existsSync(dest),
    };
  } finally {
    // Read `installed` before this runs — it is captured above.
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 0);
  }
}

describe("the installer verifies before it installs", () => {
  it("installs when the checksum matches, and runs what it installed", async () => {
    checksums = `${sha(FAKE_BINARY)}  ${assetName()}\n`;
    const r = await install();
    expect(r.code, r.out).toBe(0);
    expect(r.installed).toBe(true);
    expect(r.out).toContain("checksum: OK");
    // The script's final self-check executes the binary; seeing its output
    // proves the file was placed executable, not merely copied.
    expect(r.out).toContain("test-fixture");
    expect(readFileSync(r.dest, "utf8")).toBe(FAKE_BINARY);
  });

  it("REFUSES a tampered download and leaves nothing behind", async () => {
    // The whole reason a curl|sh install is defensible.
    checksums = `${sha("something else entirely")}  ${assetName()}\n`;
    const r = await install();
    expect(r.code, "a checksum mismatch must be a non-zero exit").not.toBe(0);
    expect(r.installed, "a binary was placed despite a failed checksum").toBe(false);
  });

  it("REFUSES when the asset is absent from checksums.txt", async () => {
    // The subtle one: grep finds nothing, and a naive pipeline would verify
    // an empty list successfully and call that a pass.
    checksums = `${sha("x")}  some_other_file\n`;
    const r = await install();
    expect(r.code).not.toBe(0);
    expect(r.installed).toBe(false);
    expect(r.out).toContain("refusing to install unverified bytes");
  });

  it("refuses a version that has no build for this platform, naming the URL", async () => {
    checksums = `${sha(FAKE_BINARY)}  ${assetName()}\n`;
    const dir = mkdtempSync(join(tmpdir(), "bm-install-test-"));
    try {
      await run("sh", [SCRIPT, "--bin-dir", join(dir, "bin"), "--version", "v0.0.0-nope"], {
        env: { ...process.env, BULLMOOSE_DL_BASE: base },
      });
      throw new Error("expected a failure");
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      expect((err.stdout ?? "") + (err.stderr ?? "")).toContain("has no build for");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown option with exit 2 rather than guessing", async () => {
    try {
      await run("sh", [SCRIPT, "--not-a-flag"], { env: { ...process.env, BULLMOOSE_DL_BASE: base } });
      throw new Error("expected a failure");
    } catch (e) {
      const err = e as { code?: number; stderr?: string };
      expect(err.code).toBe(2);
      expect(err.stderr ?? "").toContain("unknown option");
    }
  });
});

describe("what the installer is published as", () => {
  it("release-cli.yml uploads it to the URL the docs tell people to curl", () => {
    // Two files, one promise. If the release stops publishing it, the
    // documented one-liner 404s and the only signal is a stranger's report.
    const wf = readFileSync(join(ROOT, ".github/workflows/release-cli.yml"), "utf8");
    expect(wf, "release-cli.yml does not publish cli/install.sh").toContain("cli/install.sh");
    expect(wf).toContain("cli-go/deploy/install.sh");

    const doc = readFileSync(join(ROOT, "docs/install-cli.md"), "utf8");
    expect(doc, "the docs should tell people to curl the published installer").toContain(
      "https://dl.bullmoose.cc/cli/install.sh",
    );
  });
});
