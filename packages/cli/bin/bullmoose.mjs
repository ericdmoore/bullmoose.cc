#!/usr/bin/env node
// Launcher: node:sqlite is unflagged on recent Node but experimental-flagged
// on some 22.x builds — probe, then either run in-process or re-exec.
const entry = new URL("../dist/main.js", import.meta.url);

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
  const res = spawnSync(
    process.execPath,
    ["--experimental-sqlite", fileURLToPath(entry), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(res.status ?? 1);
}
