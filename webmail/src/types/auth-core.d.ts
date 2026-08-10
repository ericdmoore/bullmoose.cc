// Type-only view of `@bullmoose/auth-core`, for the ONE test that imports it.
//
// `scopes.test.ts` drives the real `hasScope` to prove `lib/console/scopes.ts`'s
// mirror has not drifted from the gate every server-side check calls. That is a
// RUNTIME assertion, and vitest resolves the real module through its
// `resolve.alias` (see `vitest.config.ts`).
//
// tsc cannot follow the same path. `packages/auth-core` is Worker code and
// typechecks against `@cloudflare/workers-types`; pulled into webmail's program
// — which is `astro/tsconfigs/strict` with DOM libs — it fails on
// `BufferSource`/`Uint8Array<ArrayBufferLike>` variance inside `openSecret`,
// code this app never calls. That clash is exactly why the root `tsconfig.json`
// excludes `webmail` from the workers-typed program in the first place.
//
// So the two resolvers are deliberately pointed at different things, and each
// gets the half it can check:
//
//   tsc     → this file, via `paths` in `tsconfig.test.json`  (the SHAPE)
//   vitest  → the real package, via `resolve.alias`           (the BEHAVIOUR)
//
// Widening this file cannot weaken the test: a signature that disagrees with
// the real module produces a runtime failure in `scopes.test.ts`, not a silent
// pass. Do not add anything here that the test does not actually call.

export const MAIL_SCOPES: readonly string[];
export const REALM_SCOPES: readonly string[];
export function hasScope(granted: readonly string[], required: string): boolean;
