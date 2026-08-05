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
  },
});
