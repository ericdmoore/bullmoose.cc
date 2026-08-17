import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Fast unit tests, no workerd/miniflare: per .plans/devPrinciples.md the core
// logic is pure and clients are injected, so tests run in plain Node with
// fakes and need no network. Worker-level integration (miniflare/D1) can be
// added later for the shell paths that resist faking.
export default defineConfig({
  // Resolve workspace packages from THIS checkout, mirroring the `paths` in
  // tsconfig.json. Without it Node's upward node_modules lookup wins, and in
  // a git worktree (`.claude/worktrees/*`) that lookup lands on the PARENT
  // checkout's symlinks — so tests silently exercised a different branch's
  // source than the one being typechecked. Everything below is imported by
  // services/* through its bare specifier, so all of it needs pinning.
  resolve: {
    alias: {
      "@bullmoose/auth-core/principal": here("packages/auth-core/src/principal.ts"),
      "@bullmoose/auth-core/invocation": here("packages/auth-core/src/invocation.ts"),
      "@bullmoose/auth-core/loginThrottle": here("packages/auth-core/src/loginThrottle.ts"),
      "@bullmoose/auth-core": here("packages/auth-core/src/index.ts"),
      "@bullmoose/boundary": here("packages/boundary/src/index.ts"),
      "@bullmoose/contacts-core": here("packages/contacts-core/src/index.ts"),
      "@bullmoose/calendar-core": here("packages/calendar-core/src/index.ts"),
      "@bullmoose/jmap-core": here("packages/jmap-core/src/index.ts"),
      "@bullmoose/account-do": here("packages/account-do/src/index.ts"),
      // Subpath BEFORE the bare specifier: vite alias keys are matched as
      // prefixes in order, so `@bullmoose/mailstore` would otherwise swallow
      // `@bullmoose/mailstore/outboundBound` and resolve it to index.ts/…
      "@bullmoose/mailstore/outboundBound": here("packages/mailstore/src/outboundBound.ts"),
      "@bullmoose/mailstore": here("packages/mailstore/src/index.ts"),
      "@bullmoose/mime": here("packages/mime/src/index.ts"),
      "@bullmoose/outbound": here("packages/outbound/src/index.ts"),
      "@bullmoose/scheduling": here("packages/scheduling/src/index.ts"),
      // The shared fake-client harness (sVOL 002). Same reason as the rest,
      // plus one of its own: it is not linked into node_modules at all, so
      // this alias and tsconfig's `paths` are its ONLY resolution paths.
      "@bullmoose/test-fakes": here("packages/test-fakes/src/index.ts"),
    },
  },
  test: {
    // webmail/ (s03.C): the JmapClient is pure TS and unit-tested here in plain
    // Node against a fake fetch / FakeJmapClient — no browser. Its tests import
    // `@bullmoose/jmap-core` through the SAME alias block above (do not remove
    // it: a git-worktree lookup would otherwise resolve the wrong checkout).
    // The Astro/Preact SHELL is not unit-tested — `astro build` is its bar.
    // `infra/` is in here for migrations.test.ts, which applies the real .sql
    // files to node:sqlite and proves each drift check bites. Deploy DDL is the
    // one thing with no other test surface — it runs against a live D1 or not
    // at all — so it earns a place in the suite that gates `main`.
    // `conformance/` is here for the same reason and one more: it is the only
    // file that imports auth-core (workers-typed) and packages/cli/src/io.ts
    // (Node-typed) together, so vitest — which needs no tsc program — is the
    // ONLY place it can run. See conformance/README.md.
    include: [
      "packages/**/*.test.ts",
      "services/**/*.test.ts",
      "webmail/**/*.test.ts",
      "infra/**/*.test.ts",
      "tools/**/*.test.ts",
      "conformance/**/*.test.ts",
    ],
    // Still exclude the marketing site (src/) and any build output; webmail/dist
    // and webmail/node_modules are covered by the two globs that precede them.
    exclude: ["**/node_modules/**", "**/dist/**", "src/**"],
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
      // packages/test-fakes is the test harness itself — reporting coverage of
      // it measures the suite's scaffolding, not the product.
      exclude: ["**/*.test.ts", "**/dist/**", "packages/cli/**", "packages/test-fakes/**"],
    },
  },
});
