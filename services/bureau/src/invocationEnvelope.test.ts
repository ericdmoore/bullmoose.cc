import { beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { issueInvocationToken } from "@bullmoose/auth-core/invocation";
import { fakeD1, type FakeD1 } from "@bullmoose/test-fakes";
import provision from "../../provision/src/index";
import type { Env as ProvisionEnv } from "../../provision/src/index";
import worker from "./index";
import type { Env } from "./models";

/**
 * s17 (c) — THE BUREAU'S CREDENTIAL GATE, driven as an attacker would drive it.
 *
 * `grants.test.ts` proves the standing half: a grant authorizes exactly its
 * `(principal, credRef, verb)`. This proves the half that had NO consumer
 * anywhere in the tree until now — the delegation envelope's `credentials`
 * axis — and, more importantly, proves the two COMPOSE the right way round.
 *
 * Everything here turns on one sentence, so it is worth stating before the
 * fixtures:
 *
 *   **The envelope is ANDed after the standing check, never substituted for
 *   it.** `mayUse` is a DENIAL function. `credentials: null` means "no level of
 *   this chain declared the axis", NEVER "granted". A consumer that read
 *   `effective` as a grant would turn a capability model into an access model
 *   that anyone who can write `authority_json` can widen.
 *
 * Both directions are asserted below, because only asserting one of them is how
 * a substitution bug survives: an envelope that OMITS a granted credential must
 * refuse, and an envelope that NAMES an ungranted one must refuse too.
 *
 * The grants are written by the REAL `services/provision` admin surface over
 * the same database, exactly as `grants.test.ts` does. That is not ceremony: it
 * is what proves `bureau_grants.cred_name` and the envelope's `credentials`
 * entries are the same vocabulary — both are the public
 * `vault_credentials.name` handle — with no translation layer between the
 * writer and the reader to get wrong.
 *
 * Every chain is hand-seeded with direct INSERTs rather than built through
 * `startJob`. That is the threat model rather than a shortcut: `authority_json`
 * is an ordinary TEXT column, so a gate that is only correct when the harness
 * wrote the column is not a gate.
 */

const ADMIN_TOKEN = "admin-secret";
const MASTER = "test-vault-master-key-0123456789abcdef";
const INTERNAL = "internal-test-token";

const ALLEN = { principalId: "p_allen", email: "allen@bullmoose.cc", accountId: "a_allen" };
const BINDING = "bind_allen";

/** Two real credential handles, one of which the leaf's delegation gave up. */
const KEPT = "aws-mcp";
const DROPPED = "stripe";

/** Class B, so an authorized call answers 501 — see `grants.test.ts`. */
const VERB = "sign_sigv4";
/** Authorized-but-not-yet-implemented: the unambiguous "the gate said yes". */
const AUTHORIZED = 501;

/** The binding's own ceiling — the FIRST term of every fold below. */
const CONFIG = JSON.stringify({
  pipeline: "reply",
  jobs: { tools: [], credentials: [KEPT, DROPPED], budgetMicros: 1_000_000 },
});

const envelope = (credentials: string[]) =>
  JSON.stringify({ tools: [], credentials, budgetMicros: 100_000 });

let allenToken: { id: string; token: string; secretHash: string };
beforeAll(async () => {
  allenToken = await mintToken();
});

interface Harness {
  db: FakeD1;
  env: Env;
  /** POST /bureau/use with whichever credential is being tested. */
  use: (token: string, body: unknown) => Promise<Response>;
  admin: (method: string, path: string, body?: unknown) => Promise<Response>;
  /** The `bmi_` token for a node, minted the way the claim mints it. */
  mint: (invocationId: string) => Promise<string>;
  /** Rewrite a hop's envelope behind the harness's back. */
  corrupt: (id: string, authorityJson: string | null) => void;
}

/**
 * root ── leaf   envelope [KEPT]      ← who we mint for
 *
 * Plus `inv_plain`, an ordinary mail-triggered invocation with NO `job_id` —
 * the DefaultCase, and the boundary this gate stops at.
 */
function harness(): Harness {
  const db = fakeD1();
  db.seedAccount({
    accountId: ALLEN.accountId,
    principalId: ALLEN.principalId,
    loginEmail: ALLEN.email,
  });
  db.seed("tokens", [
    {
      id: allenToken.id,
      principal_id: ALLEN.principalId,
      kind: "bearer",
      secret_hash: allenToken.secretHash,
      name: "device",
      scopes: JSON.stringify(["mail"]),
      created_at: 1,
      expires_at: null,
      last_used_at: Date.now(),
    },
  ]);
  // BOTH are `aws-sigv4`, so the §4.1 KIND gate permits `sign_sigv4` on either
  // and every refusal below is attributable to the grant or the envelope rather
  // than to the verb/kind table.
  for (const name of [KEPT, DROPPED]) {
    db.seed("vault_credentials", [
      {
        id: `vc_${name}`,
        principal_id: ALLEN.principalId,
        name,
        kind: "aws-sigv4",
        enc_json: JSON.stringify({ v: 1, iv: "x", ct: "y" }),
        meta_json: JSON.stringify({ allow: "https://*.amazonaws.com", scope: "actor" }),
        created_at: 1,
        updated_at: 1,
      },
    ]);
  }
  db.seed("agent_bindings", [
    {
      id: BINDING,
      account_id: ALLEN.accountId,
      name: "allen",
      config_json: CONFIG,
      recipients_book_id: null,
    },
  ]);
  const node = (id: string, parent: string | null, creds: string[]) => ({
    id,
    account_id: ALLEN.accountId,
    binding_id: BINDING,
    binding_name: "allen",
    status: "running",
    context_json: "{}",
    created_at: 1,
    job_id: "job_1",
    parent_id: parent,
    depth: parent === null ? 0 : 1,
    authority_json: envelope(creds),
  });
  db.seed("agent_invocations", [
    node("inv_root", null, [KEPT, DROPPED]),
    node("inv_leaf", "inv_root", [KEPT]),
    {
      id: "inv_plain",
      account_id: ALLEN.accountId,
      binding_id: BINDING,
      binding_name: "allen",
      status: "running",
      context_json: "{}",
      created_at: 1,
    },
  ]);

  const env: Env = { DB: db, VAULT_MASTER_KEY: MASTER, INTERNAL_TOKEN: INTERNAL };
  const provisionEnv: ProvisionEnv = {
    DB: db,
    ROUTES: undefined as unknown as KVNamespace,
    ADMIN_TOKEN,
    SES_REGION: "us-east-1",
    INGEST_WORKER_NAME: "bullmoose-ingest",
    CF_API_TOKEN: "cf",
    SES_ACCESS_KEY_ID: "ak",
    SES_SECRET_ACCESS_KEY: "sk",
  };

  return {
    db,
    env,
    use: (token, body) =>
      worker.fetch(
        new Request("https://bureau.internal/bureau/use", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
      ),
    admin: (method, path, body) =>
      provision.fetch(
        new Request(`https://provision.bullmoose.cc${path}`, {
          method,
          headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        provisionEnv,
      ),
    mint: async (invocationId) =>
      (await issueInvocationToken(db, { invocationId, accountId: ALLEN.accountId }))!,
    corrupt: (id, authorityJson) => {
      db.sqlite
        .prepare(`UPDATE agent_invocations SET authority_json = ? WHERE account_id = ? AND id = ?`)
        .run(authorityJson, ALLEN.accountId, id);
    },
  };
}

async function grant(h: Harness, credRef: string, verb = VERB): Promise<void> {
  const res = await h.admin("POST", "/bureau-grants", {
    principalEmail: ALLEN.email,
    credRef,
    verb,
  });
  expect(res.status, `granting ${verb} on ${credRef}`).toBe(200);
}

// ---------------------------------------------------------------------------

describe("the envelope's credentials axis finally bites at /bureau/use", () => {
  it("REFUSES a credential the delegation dropped — while the standing grant is still live", async () => {
    const h = harness();
    await grant(h, KEPT);
    await grant(h, DROPPED);
    const leaf = await h.mint("inv_leaf");

    // The delegation carried KEPT and gave up DROPPED. Both are granted.
    expect((await h.use(leaf, { verb: VERB, credRef: KEPT })).status).toBe(AUTHORIZED);

    const refused = await h.use(leaf, { verb: VERB, credRef: DROPPED });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toMatch(/inv_leaf/);

    // THE CONTROL, and the point of the whole test: the standing grant on
    // DROPPED is untouched and still resolves. The 403 above is the ENVELOPE
    // and nothing else — an ordinary `bm_` bearer for the same principal, the
    // same credential and the same verb goes straight through.
    expect((await h.use(allenToken.token, { verb: VERB, credRef: DROPPED })).status).toBe(
      AUTHORIZED,
    );
  });

  it("the two vocabularies are ONE vocabulary — provision's cred_name IS the envelope's handle", async () => {
    const h = harness();
    // `bureau_grants.cred_name` is written here by the real admin surface;
    // `authority_json.credentials` was written by the fixture. Neither knows
    // about the other, and they agree because both are the public
    // `vault_credentials.name` handle. If either side ever started carrying a
    // row id (`vc_aws-mcp`) this call would 403 with an envelope denial.
    await grant(h, KEPT);
    const leaf = await h.mint("inv_leaf");
    expect((await h.use(leaf, { verb: VERB, credRef: "aws-mcp" })).status).toBe(AUTHORIZED);
    expect(
      h.db.query<{ cred_name: string }>(`SELECT cred_name FROM bureau_grants`)[0]!.cred_name,
    ).toBe("aws-mcp");
  });

  it("a refused use is AUDITED — invariant 6 counts attempts, not successes", async () => {
    const h = harness();
    await grant(h, DROPPED);
    const leaf = await h.mint("inv_leaf");
    expect((await h.use(leaf, { verb: VERB, credRef: DROPPED })).status).toBe(403);
    // An agent reaching for a credential its delegation did not carry is
    // precisely what the trail exists to show.
    expect(h.db.count("grant_audit", "method = ?", `bureau:${VERB}:${DROPPED}`)).toBe(1);
  });
});

describe("THE COMPOSITION INVARIANT — ANDed after, never substituted for", () => {
  /**
   * ⚠️ THE MUTATION THIS TEST EXISTS FOR.
   *
   * Replace `grant && envelope` with `invocation ? envelope : grant` — a
   * plausible-looking refactor, since "the invocation knows what it may use" —
   * and this is the assertion that fails. Nothing else in the file would: every
   * other case here has a standing grant, so a substituted gate answers them
   * all correctly and only this one wrong.
   *
   * It is also the whole difference between a capability model and an access
   * model. `authority_json` is a TEXT column on a row inside the data plane;
   * `bureau_grants` is an operator-written row in the control plane. If the
   * envelope could stand in for the grant, anyone who could widen the former
   * would have granted themselves the latter.
   */
  it("an envelope that NAMES a credential with no standing grant is still refused", async () => {
    const h = harness();
    // No grant at all. The leaf's envelope carries KEPT, which is exactly what
    // a substituted gate would read as permission.
    const leaf = await h.mint("inv_leaf");
    const refused = await h.use(leaf, { verb: VERB, credRef: KEPT });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toMatch(/no live grant/);
  });

  it("a grant for the WRONG VERB is not rescued by an envelope that carries the handle", async () => {
    const h = harness();
    // The envelope axis is credentials only — it has no verb dimension — so
    // the verb half of the tuple has to keep coming from the grant.
    await grant(h, KEPT, "fetch");
    const leaf = await h.mint("inv_leaf");
    expect((await h.use(leaf, { verb: VERB, credRef: KEPT })).status).toBe(403);
  });

  it("revoking the grant refuses a bmi_ token whose envelope never changed", async () => {
    const h = harness();
    await grant(h, KEPT);
    const leaf = await h.mint("inv_leaf");
    expect((await h.use(leaf, { verb: VERB, credRef: KEPT })).status).toBe(AUTHORIZED);

    const list = await h.admin("GET", `/bureau-grants?email=${encodeURIComponent(ALLEN.email)}`);
    const [row] = ((await list.json()) as { bureauGrants: Array<{ id: string }> }).bureauGrants;
    expect((await h.admin("DELETE", `/bureau-grants/${row!.id}`)).status).toBe(200);

    expect((await h.use(leaf, { verb: VERB, credRef: KEPT })).status).toBe(403);
  });
});

describe("the envelope is LIVE, and an unreadable one denies", () => {
  it("narrowing the BINDING mid-flight bites a token that is already open", async () => {
    const h = harness();
    await grant(h, KEPT);
    const leaf = await h.mint("inv_leaf");
    expect((await h.use(leaf, { verb: VERB, credRef: KEPT })).status).toBe(AUTHORIZED);

    // The operator narrows the binding's ceiling — the first term of the fold.
    // Nothing about the token row or the node's own envelope changed.
    h.db.sqlite
      .prepare(`UPDATE agent_bindings SET config_json = ? WHERE account_id = ? AND id = ?`)
      .run(
        JSON.stringify({ pipeline: "reply", jobs: { tools: [], credentials: [DROPPED] } }),
        ALLEN.accountId,
        BINDING,
      );
    expect((await h.use(leaf, { verb: VERB, credRef: KEPT })).status).toBe(403);
  });

  it("a corrupt authority_json MID-CHAIN denies — it does NOT read as 'no envelope'", async () => {
    const h = harness();
    await grant(h, KEPT);
    const leaf = await h.mint("inv_leaf");
    // The ROOT, not the leaf: the corruption is a hop the token holder does not
    // name, and the fold must deny for the whole chain. A gate that treated
    // `ok: false` as "nothing to enforce" would AUTHORIZE here — the most
    // permissive answer for the least readable chain.
    h.corrupt("inv_root", "{ truncated");
    const refused = await h.use(leaf, { verb: VERB, credRef: KEPT });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toMatch(/unresolvable/);

    // A hop carrying NO envelope at all denies identically — an unbounded link
    // is not an unrestricted one.
    const h2 = harness();
    await grant(h2, KEPT);
    const leaf2 = await h2.mint("inv_leaf");
    h2.corrupt("inv_root", null);
    expect((await h2.use(leaf2, { verb: VERB, credRef: KEPT })).status).toBe(403);
  });

  it("a token whose invocation reached `done` stops resolving — 401, not 403", async () => {
    const h = harness();
    await grant(h, KEPT);
    const leaf = await h.mint("inv_leaf");
    expect((await h.use(leaf, { verb: VERB, credRef: KEPT })).status).toBe(AUTHORIZED);

    h.db.sqlite
      .prepare(`UPDATE agent_invocations SET status = 'done' WHERE id = 'inv_leaf'`)
      .run();
    const dead = await h.use(leaf, { verb: VERB, credRef: KEPT });
    // AUTHENTICATION fails, not authorization: the lifetime is a JOIN condition
    // on the resolver, so a finished invocation's token is not a refused
    // credential, it is not a credential.
    expect(dead.status).toBe(401);
  });

  it("the 008 kill switch on the binding reaches a token that is already open", async () => {
    const h = harness();
    await grant(h, KEPT);
    const leaf = await h.mint("inv_leaf");
    h.db.sqlite.prepare(`UPDATE agent_bindings SET enabled = 0 WHERE id = ?`).run(BINDING);
    expect((await h.use(leaf, { verb: VERB, credRef: KEPT })).status).toBe(401);
  });
});

describe("what this does NOT narrow, asserted so it is a boundary and not an oversight", () => {
  /**
   * Gap 2 closes for JOB NODES and merely NARROWS for everything else — the
   * same shape as the MCP tool axis, and for the same reason.
   *
   * An invocation with no `job_id` is not a delegation:
   * `effectiveNodeAuthority` answers `{credentials: null, …}` — the DefaultCase
   * `data-plane.sql` states as "NULL = no envelope = an ordinary invocation" —
   * and `mayUse` then admits every handle. Denying there would strand every
   * ordinary agent on the platform to enforce a ceiling nobody set.
   *
   * So for an ordinary mail-triggered invocation, a `bmi_` token at the Bureau
   * narrows the LIFETIME (the credential dies with the work) and nothing else:
   * `bureau_grants` governs exactly as it did before s17. Closing the rest
   * means redefining `config_json.jobs.credentials` as bounding every
   * invocation of the binding rather than only its Job nodes — a decision about
   * what that key MEANS, not a patch.
   */
  it("an ordinary (non-Job) invocation is NOT a delegation — the credentials axis is unbounded", async () => {
    const h = harness();
    await grant(h, DROPPED);
    const plain = await h.mint("inv_plain");
    // DROPPED is outside the binding's `jobs.credentials`… which is never
    // consulted, because that ceiling is defined as the top of a JOB's chain.
    expect((await h.use(plain, { verb: VERB, credRef: DROPPED })).status).toBe(AUTHORIZED);
    // …and the standing grant still governs it completely.
    expect((await h.use(plain, { verb: VERB, credRef: KEPT })).status).toBe(403);
  });

  it("an ORDINARY bm_ bearer is untouched — no envelope, no narrowing", async () => {
    const h = harness();
    await grant(h, KEPT);
    await grant(h, DROPPED);
    // Both, including the one every invocation token on this account is
    // narrowed away from. s17 changed what an INVOCATION may do, not what a
    // principal may do.
    expect((await h.use(allenToken.token, { verb: VERB, credRef: KEPT })).status).toBe(AUTHORIZED);
    expect((await h.use(allenToken.token, { verb: VERB, credRef: DROPPED })).status).toBe(
      AUTHORIZED,
    );
  });
});
