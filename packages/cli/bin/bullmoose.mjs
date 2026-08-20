#!/usr/bin/env node
// Launcher: node:sqlite is unflagged on recent Node but experimental-flagged
// on some 22.x builds — probe, then either run in-process or re-exec.
const entry = new URL("../dist/main.js", import.meta.url);

// The probe below is OURS, and on builds where node:sqlite is experimental it
// emits an ExperimentalWarning we knowingly cause — which lands wherever the
// user happens to be, including on top of `login`'s hidden password prompt
// (2026-08-20: read as "did the CLI just break?", which is the only sensible
// reading of a warning over a prompt). Suppress exactly that one and nothing
// else: a blanket NODE_NO_WARNINGS would also hide deprecations we DO want to
// see, and other ExperimentalWarnings are somebody telling us something true.
const defaultWarningListeners = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name === "ExperimentalWarning" && /sqlite/i.test(w.message)) return;
  for (const listener of defaultWarningListeners) listener(w);
});

let hasSqlite = true;
try {
  await import("node:sqlite");
} catch {
  hasSqlite = false;
}

if (hasSqlite) {
  await import(entry.href);
} else {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const res = spawnSync(process.execPath, ["--experimental-sqlite", fileURLToPath(entry), ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(res.status ?? 1);
}
