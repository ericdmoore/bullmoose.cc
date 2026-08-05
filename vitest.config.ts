import { defineConfig } from "vitest/config";

// Fast unit tests, no workerd/miniflare: per .plans/devPrinciples.md the core
// logic is pure and clients are injected, so tests run in plain Node with
// fakes and need no network. Worker-level integration (miniflare/D1) can be
// added later for the shell paths that resist faking.
export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "services/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "src/**", "webmail/**"],
    environment: "node",
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      // text → the CLI table locally; html → a browsable report (open
      // coverage/index.html); json-summary → coverage/coverage-summary.json,
      // which the CI workflow diffs across runs.
      reporter: ["text", "html", "json-summary"],
      // Report against the whole worker/package source tree — untested
      // files show as 0% so coverage reflects reality, not just what the
      // suite happens to touch (per .plans/devPrinciples.md: use coverage
      // to find the gaps).
      include: ["packages/**/src/**/*.ts", "services/**/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "packages/cli/**"],
    },
  },
});
