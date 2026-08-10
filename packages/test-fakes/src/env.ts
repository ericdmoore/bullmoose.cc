import { fakeD1, type FakeD1, type FakeD1Options } from "./d1";
import { fakeR2, type FakeR2 } from "./r2";
import { fakeKV, type FakeKV } from "./kv";
import { fakeAccountDo, type FakeAccountDo } from "./accountDo";

/** One relayed envelope, as the submit worker received it. */
export interface RelayedEnvelope {
  mailFrom: string;
  rcptTo: string[];
}

export interface FakeSubmit {
  /** The binding itself — assign straight to `env.SUBMIT`. */
  readonly binding: Fetcher;
  /** Envelopes handed to `/internal/submit`, in order. */
  readonly calls: RelayedEnvelope[];
  /** Full request bodies, when the envelope alone is not enough. */
  readonly bodies: Array<Record<string, unknown>>;
}

/** The submit worker's `/internal/submit`, recording what it was handed. */
export function fakeSubmit(relayMessageId = "relay-1"): FakeSubmit {
  const calls: RelayedEnvelope[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const binding = {
    async fetch(_input: RequestInfo | URL, init?: RequestInit) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      calls.push(body.envelope as RelayedEnvelope);
      return new Response(JSON.stringify({ relayMessageId }), {
        headers: { "content-type": "application/json" },
      });
    },
    // Fetcher also declares connect()/queue()/scheduled(); nothing calls them.
  } as unknown as Fetcher;
  return { binding, calls, bodies };
}

/**
 * A BUREAU binding that refuses to be used by accident.
 *
 * `services/agent` requires the binding (s04 T3a moved the credential vault's
 * master key into `services/bureau`), so the fake env has to supply one — but
 * supplying a permissive stub would let a test believe it had sealed a
 * credential when no crypto ran anywhere. A test that genuinely exercises the
 * vault wires the REAL Bureau worker over the same D1 (see
 * `services/agent/src/vault.test.ts`); every other test should never touch this,
 * and finds out loudly if it does.
 */
function unwiredBureau(): Fetcher {
  return {
    async fetch() {
      throw new Error(
        "no Bureau wired into this fixture — a test that seals or uses a credential " +
          "must bind services/bureau's worker over the same D1 (see agent/src/vault.test.ts)",
      );
    },
  } as unknown as Fetcher;
}

/**
 * The bindings shared by `services/jmap` and `services/agent`.
 *
 * Deliberately a superset of both `Env` interfaces' REQUIRED members, so a test
 * can write `const ctx = { env: w.env, principal }` with no cast at all — the
 * `as unknown as Env` that every fake in this repo carried existed only because
 * the fakes were partial. `services/agent`'s optional `AI` and `GATEWAY_*`, and
 * `services/jmap`'s optional `SHARE_SIGNING_KEY`, are left unset; a test that
 * needs one sets it on the returned object.
 *
 * There is deliberately no `VAULT_MASTER_KEY` here any more: after s04 T3a no
 * worker this fixture serves is allowed to hold one.
 */
export interface FakeEnv {
  DB: D1Database;
  BLOBS: R2Bucket;
  ROUTES: KVNamespace;
  ACCOUNT_DO: DurableObjectNamespace;
  SUBMIT: Fetcher;
  BUREAU: Fetcher;
  INTERNAL_TOKEN: string;
  DEV_ACCOUNT_ID: string;
  DEV_TENANT_ID: string;
  DEV_USERNAME: string;
  SHARE_SIGNING_KEY?: string;
  DEV_BEARER_TOKEN?: string;
}

export interface FakeWorker {
  /** Assign to a worker's `Env`. */
  readonly env: FakeEnv;
  readonly db: FakeD1;
  readonly blobs: FakeR2;
  readonly kv: FakeKV;
  readonly accountDo: FakeAccountDo;
  readonly submit: FakeSubmit;
  /** Release the SQLite handle. Optional — vitest tears the process down. */
  close(): void;
}

export interface FakeWorkerOptions extends FakeD1Options {
  /** `relayMessageId` the fake submit worker returns. */
  relayMessageId?: string;
}

/**
 * A whole worker environment: D1 on the live schema, R2, KV, the real
 * `AccountDO` over in-memory storage, and a recording submit binding.
 */
export function fakeEnv(opts: FakeWorkerOptions = {}): FakeWorker {
  const db = fakeD1(opts);
  const blobs = fakeR2();
  const kv = fakeKV();
  const submit = fakeSubmit(opts.relayMessageId);
  // The DO gets the same bindings the jmap worker gives it, so a responder
  // fired through runAlarm() reads the same D1 rows the test seeded.
  const accountDo = fakeAccountDo({
    DB: db,
    BLOBS: blobs.bucket,
    SUBMIT: submit.binding,
    INTERNAL_TOKEN: "internal-test-token",
  });

  return {
    env: {
      DB: db,
      BLOBS: blobs.bucket,
      ROUTES: kv.ns,
      ACCOUNT_DO: accountDo.ns,
      SUBMIT: submit.binding,
      BUREAU: unwiredBureau(),
      INTERNAL_TOKEN: "internal-test-token",
      DEV_ACCOUNT_ID: "t_dev__a_local",
      DEV_TENANT_ID: "t_dev",
      DEV_USERNAME: "dev@localhost",
    },
    db,
    blobs,
    kv,
    accountDo,
    submit,
    close: () => db.close(),
  };
}
