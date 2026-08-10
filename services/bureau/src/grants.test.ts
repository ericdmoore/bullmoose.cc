import { beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { fakeD1, type FakeD1 } from "@bullmoose/test-fakes";
import provision from "../../provision/src/index";
import type { Env as ProvisionEnv } from "../../provision/src/index";
import worker from "./index";
import type { Env } from "./models";

/**
 * T2 — mint ≠ authorize (bureau.md §5.1).
 *
 * A grant is a capability over `(principal, credRef, verb)`, not access to a
 * credential. These tests are written to that sentence: the interesting claims
 * are all about what a grant does NOT authorize, because a capability model that
 * leaks sideways is just an access model with extra columns.
 *
 * Driven end to end through two real workers over ONE database — grants are
 * written by `services/provision`'s admin surface and read by the Bureau's
 * authorization spine. That split is the design (the writer is an operator
 * surface, the reader is a hot path), and testing across it is the only way to
 * catch the two of them disagreeing about the tuple.
 *
 * The caller is authenticated with a REALLY minted bearer, so `verifyBearer`'s
 * tokens⋈principals join and its token crypto run for real. Nothing here
 * asserts on a self-asserted principal id, because the product must never
 * accept one.
 */

const ADMIN_TOKEN = "admin-secret";
const MASTER = "test-vault-master-key-0123456789abcdef";
const INTERNAL = "internal-test-token";

const ALLEN = { principalId: "p_allen", email: "allen@bullmoose.cc", accountId: "a_allen" };
const EDITOR = { principalId: "p_editor", email: "editor@bullmoose.cc", accountId: "a_editor" };

let allenToken: { id: string; token: string; secretHash: string };
let editorToken: { id: string; token: string; secretHash: string };
beforeAll(async () => {
  allenToken = await mintToken();
  editorToken = await mintToken();
});

interface Harness {
  db: FakeD1;
  env: Env;
  /** POST /bureau/use as a given principal's invocation token. */
  use: (token: string, body: unknown) => Promise<Response>;
  /** The provision admin surface, over the same database. */
  admin: (method: string, path: string, body?: unknown) => Promise<Response>;
}

function harness(): Harness {
  const db = fakeD1();
  for (const p of [ALLEN, EDITOR]) {
    db.seedAccount({ accountId: p.accountId, principalId: p.principalId, loginEmail: p.email });
  }
  db.seed("tokens", [
    tokenRow(allenToken, ALLEN.principalId),
    tokenRow(editorToken, EDITOR.principalId),
  ]);
  // Two credentials on Allen, so "revoking one grant leaves the others" can be
  // asserted across credentials as well as across verbs.
  seedCredential(db, ALLEN.principalId, "aws-mcp", "aws-sigv4");
  seedCredential(db, ALLEN.principalId, "stripe", "api-key");

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
  };
}

function tokenRow(minted: { id: string; secretHash: string }, principalId: string) {
  return {
    id: minted.id,
    principal_id: principalId,
    kind: "bearer",
    secret_hash: minted.secretHash,
    name: "invocation",
    scopes: JSON.stringify(["mail"]),
    created_at: 1,
    expires_at: null,
    last_used_at: Date.now(),
  };
}

/** A credential row. `enc_json` is opaque here on purpose — every test in this
 *  file is about authorization, and authorization never decrypts anything. */
function seedCredential(db: FakeD1, principalId: string, name: string, kind: string) {
  db.seed("vault_credentials", [
    {
      id: `vc_${name}`,
      principal_id: principalId,
      name,
      kind,
      enc_json: JSON.stringify({ v: 1, iv: "x", ct: "y" }),
      meta_json: JSON.stringify({ allow: "https://*.amazonaws.com", scope: "actor" }),
      created_at: 1,
      updated_at: 1,
    },
  ]);
}

const jsonBody = async <T>(res: Response): Promise<T> => (await res.json()) as T;

async function grant(
  h: Harness,
  email: string,
  credRef: string,
  verb: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await h.admin("POST", "/bureau-grants", {
    principalEmail: email,
    credRef,
    verb,
    ...extra,
  });
  expect(res.status, `granting ${verb} on ${credRef}`).toBe(200);
  return (await jsonBody<{ grantId: string }>(res)).grantId;
}

/** Authorized-but-not-yet-implemented. T3 replaces the 501 with a real result;
 *  until then it is the unambiguous "the grant said yes" signal. */
const AUTHORIZED = 501;

describe("a grant authorizes exactly its (principal, credRef, verb)", () => {
  it("authorizes the granted tuple", async () => {
    const h = harness();
    await grant(h, ALLEN.email, "aws-mcp", "sign_sigv4");
    const res = await h.use(allenToken.token, { verb: "sign_sigv4", credRef: "aws-mcp" });
    expect(res.status).toBe(AUTHORIZED);
    expect(await jsonBody<{ authorized: boolean }>(res)).toMatchObject({ authorized: true });
  });

  it("refuses the SAME credential under a different verb", async () => {
    const h = harness();
    await grant(h, ALLEN.email, "aws-mcp", "sign_sigv4");
    // The credential is `aws-sigv4`, whose kind permits `fetch` too (§4.1) —
    // so this is refused by the GRANT, not by the kind gate. Minting never
    // authorized anything; only a grant does.
    const res = await h.use(allenToken.token, { verb: "fetch", credRef: "aws-mcp" });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no live grant/);
  });

  it("refuses the SAME verb against a different credential", async () => {
    const h = harness();
    await grant(h, ALLEN.email, "stripe", "fetch");
    const res = await h.use(allenToken.token, { verb: "fetch", credRef: "aws-mcp" });
    expect(res.status).toBe(403);
  });

  it("refuses a DIFFERENT principal holding an identical-looking token", async () => {
    const h = harness();
    await grant(h, ALLEN.email, "aws-mcp", "sign_sigv4");
    // The whole OQ1b problem in one assertion: editor@ and travel@ run in the
    // same agent worker and arrive over the same service binding. Only the
    // token distinguishes them, so only the token may.
    const res = await h.use(editorToken.token, { verb: "sign_sigv4", credRef: "aws-mcp" });
    expect(res.status).toBe(403);
  });

  it("refuses a caller with no token at all, and never reaches a grant", async () => {
    const h = harness();
    await grant(h, ALLEN.email, "aws-mcp", "sign_sigv4");
    const res = await worker.fetch(
      new Request("https://bureau.internal/bureau/use", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verb: "sign_sigv4", credRef: "aws-mcp" }),
      }),
      h.env,
    );
    expect(res.status).toBe(401);
    // Unauthenticated callers are not audited as uses: there is no principal to
    // attribute the attempt to, and inventing one would poison the trail.
    expect(h.db.count("grant_audit")).toBe(0);
  });

  it("refuses a verb outside the closed vocabulary", async () => {
    const h = harness();
    await grant(h, ALLEN.email, "aws-mcp", "sign_sigv4");
    const res = await h.use(allenToken.token, { verb: "exec", credRef: "aws-mcp" });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/unknown verb/);
  });

  it("403s rather than 404s for an ungranted, nonexistent credential", async () => {
    const h = harness();
    // Refusal precedes the credential lookup, so an ungranted caller cannot use
    // the status code to enumerate what is in someone's vault: a name that does
    // not exist is indistinguishable from one that does.
    const ghost = await h.use(allenToken.token, { verb: "fetch", credRef: "no-such-cred" });
    expect(ghost.status).toBe(403);
    expect((await h.use(allenToken.token, { verb: "fetch", credRef: "stripe" })).status).toBe(403);
  });

  it("404s when a GRANTED credential has since been deleted", async () => {
    const h = harness();
    await grant(h, ALLEN.email, "stripe", "fetch");
    // Deleting the credential does not revoke the grant — the two are separate
    // records by design — so the grant still resolves and the Bureau has to say
    // honestly that there is nothing to use it with.
    h.db.query(`DELETE FROM vault_credentials WHERE name = 'stripe'`);
    const res = await h.use(allenToken.token, { verb: "fetch", credRef: "stripe" });
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/no credential named/);
  });
});

describe("revoking a grant leaves the credential and its sibling grants intact", () => {
  it("cuts one verb and nothing else", async () => {
    const h = harness();
    const signing = await grant(h, ALLEN.email, "aws-mcp", "sign_sigv4");
    await grant(h, ALLEN.email, "aws-mcp", "fetch");
    await grant(h, ALLEN.email, "stripe", "fetch");

    expect((await h.admin("DELETE", `/bureau-grants/${signing}`)).status).toBe(200);

    // The revoked capability is gone...
    expect((await h.use(allenToken.token, { verb: "sign_sigv4", credRef: "aws-mcp" })).status).toBe(403);
    // ...its sibling on the same credential survives...
    expect((await h.use(allenToken.token, { verb: "fetch", credRef: "aws-mcp" })).status).toBe(AUTHORIZED);
    // ...as does the grant on the other credential...
    expect((await h.use(allenToken.token, { verb: "fetch", credRef: "stripe" })).status).toBe(AUTHORIZED);
    // ...and the credential row itself is untouched. Revocation drops a
    // capability, never a secret (bureau.md §5.1).
    expect(h.db.count("vault_credentials", "principal_id = ?", ALLEN.principalId)).toBe(2);
  });

  it("tombstones rather than deletes, and logs the transition", async () => {
    const h = harness();
    const id = await grant(h, ALLEN.email, "aws-mcp", "sign_sigv4");
    await h.admin("DELETE", `/bureau-grants/${id}`);

    // The row survives — "who could have signed with this key last Tuesday?"
    // stays answerable, exactly as `grants.revoked_at` does (s03.A T2).
    expect(h.db.count("bureau_grants", "id = ?", id)).toBe(1);
    expect(h.db.count("bureau_grants", "id = ? AND revoked_at IS NOT NULL", id)).toBe(1);
    expect(h.db.count("grant_lifecycle", "grant_id = ? AND event = 'created'", id)).toBe(1);
    expect(h.db.count("grant_lifecycle", "grant_id = ? AND event = 'revoked'", id)).toBe(1);
  });

  it("is idempotent, and a re-grant reinstates the capability", async () => {
    const h = harness();
    const id = await grant(h, ALLEN.email, "aws-mcp", "sign_sigv4");
    expect(await jsonBody(await h.admin("DELETE", `/bureau-grants/${id}`))).toEqual({ revoked: true });
    expect(await jsonBody(await h.admin("DELETE", `/bureau-grants/${id}`))).toEqual({ revoked: false });
    expect(h.db.count("grant_lifecycle", "grant_id = ? AND event = 'revoked'", id)).toBe(1);

    // A tombstone must not make a capability ungrantable forever.
    const again = await grant(h, ALLEN.email, "aws-mcp", "sign_sigv4");
    expect(again).toBe(id); // the row is reinstated, not duplicated
    expect((await h.use(allenToken.token, { verb: "sign_sigv4", credRef: "aws-mcp" })).status).toBe(AUTHORIZED);
    expect(h.db.count("grant_lifecycle", "grant_id = ? AND event = 'created'", id)).toBe(2);
  });

  it("stops resolving once expired, without being revoked", async () => {
    const h = harness();
    const id = await grant(h, ALLEN.email, "aws-mcp", "sign_sigv4", { expiresDays: 1 });
    expect((await h.use(allenToken.token, { verb: "sign_sigv4", credRef: "aws-mcp" })).status).toBe(AUTHORIZED);
    h.db.query(`UPDATE bureau_grants SET expires_at = ? WHERE id = ?`, Date.now() - 1000, id);
    expect((await h.use(allenToken.token, { verb: "sign_sigv4", credRef: "aws-mcp" })).status).toBe(403);
  });
});

describe("every attempted use is in grant_audit (invariant 6)", () => {
  it("audits an authorized use with its grant, verb and credRef", async () => {
    const h = harness();
    const id = await grant(h, ALLEN.email, "aws-mcp", "sign_sigv4");
    await h.use(allenToken.token, { verb: "sign_sigv4", credRef: "aws-mcp" });

    const rows = h.db.query<{ grant_id: string; principal: string; account_id: string; method: string }>(
      `SELECT grant_id, principal, account_id, method FROM grant_audit`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      grant_id: id,
      principal: ALLEN.email,
      account_id: ALLEN.accountId,
      method: "bureau:sign_sigv4:aws-mcp",
    });
  });

  it("audits a REFUSED use too — the probe is the interesting row", async () => {
    const h = harness();
    await h.use(allenToken.token, { verb: "sign_sigv4", credRef: "aws-mcp" });
    const rows = h.db.query<{ grant_id: string; method: string }>(
      `SELECT grant_id, method FROM grant_audit`,
    );
    expect(rows).toHaveLength(1);
    // No grant authorized it, so the row says so rather than naming a fiction.
    expect(rows[0]).toMatchObject({ grant_id: "none", method: "bureau:sign_sigv4:aws-mcp" });
  });

  it("keeps auditing after the grant is revoked", async () => {
    const h = harness();
    const id = await grant(h, ALLEN.email, "aws-mcp", "sign_sigv4");
    await h.use(allenToken.token, { verb: "sign_sigv4", credRef: "aws-mcp" });
    await h.admin("DELETE", `/bureau-grants/${id}`);
    await h.use(allenToken.token, { verb: "sign_sigv4", credRef: "aws-mcp" });

    expect(h.db.count("grant_audit")).toBe(2);
    expect(h.db.count("grant_audit", "grant_id = ?", id)).toBe(1);
    expect(h.db.count("grant_audit", "grant_id = 'none'")).toBe(1);
  });
});

describe("the admin surface refuses what it cannot honour", () => {
  it("rejects a verb outside the closed set", async () => {
    const h = harness();
    const res = await h.admin("POST", "/bureau-grants", {
      principalEmail: ALLEN.email,
      credRef: "aws-mcp",
      verb: "exec",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/verb must be one of/);
  });

  it("404s on an unknown principal or an unknown credential", async () => {
    const h = harness();
    expect(
      (await h.admin("POST", "/bureau-grants", {
        principalEmail: "nobody@bullmoose.cc",
        credRef: "aws-mcp",
        verb: "fetch",
      })).status,
    ).toBe(404);
    // A typo in credRef would otherwise mint a grant that authorizes nothing
    // and looks live in the console forever.
    expect(
      (await h.admin("POST", "/bureau-grants", {
        principalEmail: ALLEN.email,
        credRef: "typo-mcp",
        verb: "fetch",
      })).status,
    ).toBe(404);
  });

  it("lists live and revoked grants, filtered by principal and by credential", async () => {
    const h = harness();
    const id = await grant(h, ALLEN.email, "aws-mcp", "sign_sigv4");
    await grant(h, ALLEN.email, "stripe", "fetch");
    await h.admin("DELETE", `/bureau-grants/${id}`);

    const all = await jsonBody<{ bureauGrants: Array<Record<string, unknown>> }>(
      await h.admin("GET", "/bureau-grants"),
    );
    expect(all.bureauGrants).toHaveLength(2);
    // Tombstones are listed and labelled — an operator auditing what an agent
    // COULD do must see what it no longer can.
    expect(all.bureauGrants.filter((g) => g.revoked_at !== null)).toHaveLength(1);

    const byCred = await jsonBody<{ bureauGrants: unknown[] }>(
      await h.admin("GET", "/bureau-grants?credRef=stripe"),
    );
    expect(byCred.bureauGrants).toHaveLength(1);
    const byEmail = await jsonBody<{ bureauGrants: unknown[] }>(
      await h.admin(
        "GET",
        `/bureau-grants?email=${encodeURIComponent(EDITOR.email)}`,
      ),
    );
    expect(byEmail.bureauGrants).toHaveLength(0);
  });
});
