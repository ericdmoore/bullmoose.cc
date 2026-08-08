/**
 * @bullmoose/test-fakes — the injected-client harness the test suite runs on.
 *
 * `.plans/devPrinciples.md`: *"leverage 3rd party fake-clients & fake-db-mocks,
 * and harnesses for testing - make them as needed"* and *"By injecting
 * fake-clients most of the shell code can get coverage too without the need for
 * real network access."* This package is that line being cashed, and sVOL unit
 * `002` is the unit that cashes it.
 *
 * TEST-ONLY. It imports `node:sqlite`, which does not exist in workerd — so it
 * must never be reachable from a worker entrypoint. That is enforced by
 * construction, and the mechanism is deliberate: this directory has **no
 * `package.json`**, so npm's `packages/*` workspace glob skips it and nothing
 * is ever linked into `node_modules/@bullmoose/`. Resolution exists only in
 * `tsconfig.json`'s `paths` and `vitest.config.ts`'s `resolve.alias` — i.e.
 * under `tsc` and under vitest, and nowhere else. A wrangler build that reached
 * this specifier fails loudly instead of bundling a Node builtin into a Worker.
 *
 * Do not add a `package.json` here. It would make the import resolvable from
 * production code, which is the one thing this layout is buying. (It also keeps
 * the unit at E2: `readme.md`'s E4 anchor is "new workspace", and this is not
 * one — see `002`'s Open Question #2.)
 *
 * It is still fully typechecked: root `tsconfig.json`'s `include` covers every
 * package's `src`, so the fakes are checked against the REAL `D1Database`,
 * `R2Bucket`, `KVNamespace` and `DurableObjectNamespace` — which is most of the
 * value, since that is exactly what the five local fakes could not do.
 *
 *   import { fakeEnv } from "@bullmoose/test-fakes";
 *
 *   const w = fakeEnv();
 *   w.db.seed("calendars", [{ id: "cal_1", account_id: "a_eric", ... }]);
 *   const ctx: RequestContext = { env: w.env, principal };
 *   ...
 *   expect(await w.accountDo.changes("a_eric", "CalendarEvent")).toMatchObject({
 *     created: ["ce_1"],
 *   });
 */

export { fakeD1, FakeD1, LIVE_SCHEMA } from "./d1";
export type { FakeD1Options, RecordedWrite } from "./d1";
export { fakeR2 } from "./r2";
export type { FakeR2, StoredObject } from "./r2";
export { fakeKV } from "./kv";
export type { FakeKV, KvEntry } from "./kv";
export { fakeAccountDo } from "./accountDo";
export type { FakeAccountDo, ChangesBody } from "./accountDo";
export { fakeEnv, fakeSubmit } from "./env";
export type { FakeEnv, FakeWorker, FakeWorkerOptions, FakeSubmit, RelayedEnvelope } from "./env";
