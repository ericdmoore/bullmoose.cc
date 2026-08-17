# 032 -P3- Arch says the CLI imports core packages; at runtime it cannot, so it vendors codecs

**Subsystem:** cli · **Severity:** LOW (doc drift + a small design debt) · **Fix class:** UPDATE-DOCS or CHANGE-BUILD

## The mismatch

`.plans/s05-cli-crud/arch.md:117-119` (and similar prose) says the CLI **imports `calendar-core`
rather than reimplementing** the iCal/RRULE logic. It cannot.

The compiled CLI runs as raw `dist/*.js` with **no bundler** and no `node_modules/@bullmoose`.
Workspace packages resolve only via `tsc` `paths` (typecheck) and vitest `alias` (tests) —
**never at runtime**. `packages/cli/tsconfig.json` is Node-typed with no `paths`, and
`@bullmoose/auth-core` even pulls in `CryptoKey`, which is why `scopes.ts` already mirrors the
scope vocabulary by hand.

## What actually happens

Every CLI unit that needs core logic **vendors a compact copy**:

- `packages/cli/src/vcard.ts` — vCard ⇄ JSContact, copied from `packages/contacts-core`
  (sVOL `017` added the serialize direction to the copy).
- `packages/cli/src/calendar.ts` — a compact iCal/RRULE codec, vendored by sVOL `018`
  rather than importing `calendar-core`.
- `packages/cli/src/scopes.ts` — the scope vocabulary, mirrored from `@bullmoose/auth-core`
  (guarded by a source-parsing drift test).

Three copies now, three drift risks. The drift tests catch _vocabulary_ drift; they do not
catch a _codec_ diverging from `calendar-core`'s expander — which matters, because
`calendar-core` is exactly where `common/003`'s RRULE guard lives. A vendored CLI codec that
accepts a rule the server rejects is a confusing round-trip.

## The decision

Two honest options:

1. **Correct the docs.** State that the CLI vendors compact codecs by design, because it ships
   as unbundled `dist/*.js`. Cheapest; accepts the drift risk, mitigated by the server being
   the source of truth (it re-validates every write, so a lax CLI codec produces a clean 4xx,
   not a silent bad write).
2. **Give the CLI a bundle step.** Add an esbuild/rollup pass so it can `import` compiled
   `calendar-core`/`contacts-core`, and delete the three vendored copies. Removes the drift
   permanently but adds a build tool this package has so far avoided.

I lean (1) for now — the server-revalidates-everything property (which `common/003` and the
`016` exit-code mapping already lean on) makes CLI-side codec drift _loud_, not silent — with
(2) filed as the real fix when the vendored-copy count makes it worth the build tooling.

## Related

- `common/027` — the scope model; `scopes.ts` is the third vendored copy.
- `common/003` — the RRULE guard the vendored calendar codec must not diverge from.
- sVOL `017`/`018` — the units that vendored `vcard`/`calendar` and flagged this.
