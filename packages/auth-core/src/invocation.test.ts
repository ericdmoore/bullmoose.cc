import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import { parseToken } from "./index";
import {
  INVOCATION_STANDING_SCOPES,
  INVOCATION_TOKEN_TTL_MS,
  issueInvocationToken,
  mintInvocationToken,
  parseInvocationToken,
  principalForInvocation,
  resolveInvocationToken,
} from "./invocation";

/**
 * s17 — THE `bmi_` CREDENTIAL, at the grammar and at the row.
 *
 * The cross-surface half of the argument (a `bmi_` token 401s at the vault, at
 * JMAP and at CalDAV) is `services/agent/src/invocationToken.test.ts`, which
 * has those workers to drive. What is proven HERE is the property those 401s
 * rest on — that `parseToken` and `parseInvocationToken` are DISJOINT — plus
 * the lifetime, which is the other half of what makes this credential safe:
 * it stops resolving when the work stops, with no revocation bookkeeping.
 */

const ACCOUNT = "t_bm__a_cj";
const OTHER = "t_bm__a_other";
const BINDING = "bind_cj";
const PRINCIPAL = "p_cj";

function world() {
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: ACCOUNT,
    tenantId: "t_bm",
    principalId: PRINCIPAL,
    loginEmail: "cj@bullmoose.cc",
  });
  w.db.seed("agent_bindings", [
    { id: BINDING, account_id: ACCOUNT, name: "cj", config_json: "{}", recipients_book_id: null },
  ]);
  const seedInvocation = (id: string, over: Record<string, unknown> = {}) =>
    w.db.seed("agent_invocations", [
      {
        id,
        account_id: ACCOUNT,
        binding_id: BINDING,
        binding_name: "cj",
        status: "running",
        context_json: "{}",
        created_at: 1,
        ...over,
      },
    ]);
  const setStatus = (id: string, status: string) =>
    w.db.sqlite
      .prepare(`UPDATE agent_invocations SET status = ? WHERE account_id = ? AND id = ?`)
      .run(status, ACCOUNT, id);
  const disableBinding = () =>
    w.db.sqlite
      .prepare(`UPDATE agent_bindings SET enabled = 0 WHERE account_id = ? AND id = ?`)
      .run(ACCOUNT, BINDING);
  return { w, db: w.env.DB, seedInvocation, setStatus, disableBinding };
}

// ---------------------------------------------------------------------------

describe("the two grammars are DISJOINT — the whole reason bmi_ is safe", () => {
  it("parseToken refuses a well-formed invocation token", async () => {
    const minted = await mintInvocationToken();
    // If this ever passes, every surface in the tree — the vault, JMAP,
    // CalDAV, and anything a future author writes on top of verifyBearer —
    // silently starts accepting a credential it cannot bound.
    expect(parseToken(minted.token)).toBeNull();
  });

  it("parseInvocationToken refuses a well-formed bearer token", () => {
    const bm = `bm_${"a".repeat(12)}_${"b".repeat(48)}`;
    expect(parseToken(bm)).not.toBeNull();
    expect(parseInvocationToken(bm)).toBeNull();
  });

  it("no string satisfies both parsers", async () => {
    const candidates = [
      (await mintInvocationToken()).token,
      `bm_${"0".repeat(12)}_${"f".repeat(48)}`,
      `bmi_${"0".repeat(12)}_${"f".repeat(48)}`,
      "bmi_",
      "bm_",
      "",
      "Bearer bmi_x",
    ];
    for (const c of candidates) {
      expect(parseToken(c) !== null && parseInvocationToken(c) !== null).toBe(false);
    }
  });

  it("is ANCHORED — no prefix, no suffix, no near-miss length", async () => {
    const good = (await mintInvocationToken()).token;
    expect(parseInvocationToken(good)).not.toBeNull();
    for (const bad of [
      `x${good}`,
      `${good}x`,
      `${good}\nbmi_evil`,
      good.replace("bmi_", "bmI_"),
      good.toUpperCase(),
      good.slice(0, -1),
      `${good}0`,
      good.replace("_", "-"),
    ]) {
      expect(parseInvocationToken(bad)).toBeNull();
    }
  });

  it("trims surrounding whitespace, exactly as parseToken does", async () => {
    const good = (await mintInvocationToken()).token;
    expect(parseInvocationToken(`  ${good}\n`)).not.toBeNull();
  });

  it("round-trips: the parsed id is the row id, and the secret is not stored", async () => {
    const minted = await mintInvocationToken();
    const parsed = parseInvocationToken(minted.token)!;
    expect(parsed.id).toBe(minted.id);
    expect(minted.id.startsWith("it_")).toBe(true);
    expect(minted.token.includes(minted.secretHash)).toBe(false);
  });
});

describe("the mint", () => {
  it("writes one identity row and returns the plaintext once", async () => {
    const { w, db, seedInvocation } = world();
    seedInvocation("inv_1");
    const token = await issueInvocationToken(db, {
      invocationId: "inv_1",
      accountId: ACCOUNT,
      now: 1_000,
    });
    expect(token).not.toBeNull();
    expect(parseInvocationToken(token!)).not.toBeNull();

    const rows = w.db.query<{
      invocation_id: string;
      account_id: string;
      principal_id: string;
      secret_hash: string;
      issued_at: number;
      expires_at: number;
    }>(`SELECT * FROM agent_invocation_tokens`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.invocation_id).toBe("inv_1");
    expect(rows[0]!.account_id).toBe(ACCOUNT);
    // Denormalized from accounts.principal_id, so the resolver's hot path
    // never leaves the data plane.
    expect(rows[0]!.principal_id).toBe(PRINCIPAL);
    expect(rows[0]!.expires_at).toBe(1_000 + INVOCATION_TOKEN_TTL_MS);
    // NO envelope, NO scope list — the row carries identity and nothing else.
    const columns = Object.keys(rows[0]!);
    expect(columns).not.toContain("authority_json");
    expect(columns).not.toContain("scopes");
    // The secret itself is never stored.
    expect(token!.includes(rows[0]!.secret_hash)).toBe(false);
  });

  it("refuses to mint for a deleted account, and writes nothing", async () => {
    const { w, db, seedInvocation } = world();
    seedInvocation("inv_1");
    w.db.sqlite.prepare(`UPDATE accounts SET deleted_at = 1 WHERE id = ?`).run(ACCOUNT);
    expect(await issueInvocationToken(db, { invocationId: "inv_1", accountId: ACCOUNT })).toBeNull();
    expect(w.db.count("agent_invocation_tokens")).toBe(0);
  });
});

describe("LIFETIME IS DERIVED — the token stops resolving when the work does", () => {
  const openToken = async () => {
    const h = world();
    h.seedInvocation("inv_1");
    const token = (await issueInvocationToken(h.db, {
      invocationId: "inv_1",
      accountId: ACCOUNT,
    }))!;
    return { ...h, token };
  };

  it("resolves while the invocation is running, carrying the LIVE node row", async () => {
    const { w, db, token } = await openToken();
    w.db.sqlite
      .prepare(`UPDATE agent_invocations SET job_id = 'job_1', authority_json = ? WHERE id = ?`)
      .run(JSON.stringify({ tools: ["files.read"], credentials: [], budgetMicros: 1 }), "inv_1");

    const id = await resolveInvocationToken(db, token);
    expect(id).not.toBeNull();
    expect(id!.invocationId).toBe("inv_1");
    expect(id!.accountId).toBe(ACCOUNT);
    expect(id!.principalId).toBe(PRINCIPAL);
    // Re-read per request: the column edited a line ago is the one returned.
    expect(id!.node.job_id).toBe("job_1");
    expect(JSON.parse(id!.node.authority_json!)).toMatchObject({ tools: ["files.read"] });
  });

  for (const status of ["done", "failed", "pending"]) {
    it(`stops resolving the moment the invocation reaches ${status} — no revocation step`, async () => {
      const { db, token, setStatus } = await openToken();
      expect(await resolveInvocationToken(db, token)).not.toBeNull();
      setStatus("inv_1", status);
      expect(await resolveInvocationToken(db, token)).toBeNull();
    });
  }

  it("stops resolving when the 008 kill switch disables the binding", async () => {
    const { db, token, disableBinding } = await openToken();
    expect(await resolveInvocationToken(db, token)).not.toBeNull();
    disableBinding();
    expect(await resolveInvocationToken(db, token)).toBeNull();
  });

  it("expires — the belt against a row failStaleRunning never sweeps", async () => {
    const { db, seedInvocation } = world();
    seedInvocation("inv_1");
    const token = (await issueInvocationToken(db, {
      invocationId: "inv_1",
      accountId: ACCOUNT,
      now: 1_000,
    }))!;
    expect(await resolveInvocationToken(db, token, 1_000 + INVOCATION_TOKEN_TTL_MS)).not.toBeNull();
    expect(await resolveInvocationToken(db, token, 1_000 + INVOCATION_TOKEN_TTL_MS + 1)).toBeNull();
  });

  it("a right id with a wrong secret does not resolve", async () => {
    const { db, token } = await openToken();
    const forged = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    expect(parseInvocationToken(forged)).not.toBeNull(); // well-formed…
    expect(await resolveInvocationToken(db, forged)).toBeNull(); // …and unusable
  });

  it("a bm_ bearer never resolves as an invocation, whatever rows exist", async () => {
    const { db } = await openToken();
    expect(await resolveInvocationToken(db, `bm_${"0".repeat(12)}_${"f".repeat(48)}`)).toBeNull();
  });
});

describe("the standing identity a bmi_ token authenticates as", () => {
  it("reaches EXACTLY ONE account — its own — and no grant-reached account", async () => {
    const { w, db, seedInvocation } = world();
    // A second owned account, and a grant reaching a third. A bm_ device token
    // for this principal would reach all three.
    w.db.seedAccount({ accountId: "t_bm__a_second", tenantId: "t_bm", principalId: PRINCIPAL });
    w.db.seedAccount({ accountId: OTHER, tenantId: "t_bm", principalId: "p_other" });
    w.db.seed("grants", [
      {
        id: "g_1",
        tenant_id: "t_bm",
        grantee_account_id: ACCOUNT,
        target_account_id: OTHER,
        scopes: JSON.stringify(["mail"]),
        collection: null,
        collection_id: null,
        created_by: "admin",
        created_at: 1,
        expires_at: null,
      },
    ]);
    seedInvocation("inv_1");
    const token = (await issueInvocationToken(db, { invocationId: "inv_1", accountId: ACCOUNT }))!;
    const identity = (await resolveInvocationToken(db, token))!;

    const principal = await principalForInvocation(db, identity);
    expect(principal).not.toBeNull();
    expect(principal!.accounts.map((a) => a.accountId)).toEqual([ACCOUNT]);
    expect(principal!.accounts[0]!.granted).toBeUndefined();
    expect(principal!.username).toBe("cj@bullmoose.cc");
  });

  it("carries the agent marker and NOT vault / admin / send", () => {
    expect(INVOCATION_STANDING_SCOPES).toContain("agent");
    for (const forbidden of ["vault", "admin", "send", "mail"]) {
      expect(INVOCATION_STANDING_SCOPES).not.toContain(forbidden);
    }
  });
});
