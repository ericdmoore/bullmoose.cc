import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { mintToken } from "@bullmoose/auth-core";
import { verifyBearer } from "@bullmoose/auth-core/principal";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import bureauWorker from "../../../bureau/src/index";
import type { Env as BureauEnv } from "../../../bureau/src/models";
import { GRANTABLE_SCOPES, SUPERVISORY_GRANT_SCOPES } from "../../../provision/src/index";
import type { Env } from "../index";
import { registerProviderCredentialMethods } from "./providerCredential";
import type { RequestContext } from "./common";

/**
 * s26 T4's surface — `ProviderCredential/{get,set}`, the session-reachable BYOK
 * door — driven against the REAL Bureau worker over the SAME database.
 *
 * Not a stub, and that is the whole point of the fixture: s04 T3a's claim is
 * that a boundary exists between the worker that renders untrusted email and
 * the worker that holds `VAULT_MASTER_KEY`, and a faked boundary proves nothing
 * about it. The jmap env here carries NO master key, because in production it
 * will not have one, so every seal below has to survive the hop and the
 * ciphertext in `vault_credentials` is really sealed.
 *
 * What each block asserts:
 *
 *   WRITE-ONLY  the key goes in and nothing anywhere gives it back — swept
 *               across the response, every control-plane table and every
 *               refusal message. The sweep is proven NON-VACUOUS by feeding it
 *               a response that did leak.
 *   SCOPE       `vault`, not `send`. A supervisory grant cannot carry it, and
 *               — the extension over #198 — NO grant can, because
 *               GRANTABLE_SCOPES omits it. Driven through the real resolution
 *               path (minted bearer → verifyBearer → token ∩ grant).
 *   MARKER      no agent hand on the tenant's key, whatever scopes it holds.
 *   OWNERSHIP   another account's binding answers like one that never existed.
 *   THREE STEPS seal + grant + attach, and the status that says so.
 *   REFUSAL     the states in which a binding refuses rather than spending the
 *               platform key, each surfaced as a legible status.
 *   AUDIT       binding_lifecycle + grant_lifecycle, naming the actor, never
 *               naming the key.
 */

const MASTER = "test-vault-master-key-0123456789abcdef";
const TENANT = "t_bm";
const ERIC = "a_eric";
const STRANGER = "a_stranger";

/** The canary. Never printed, never asserted `toContain`-style against a
 *  payload — only ever swept FOR and expected absent. */
const KEY = "sk-or-v1-CANARY-fd0a9c3b7e1148d2a6f5";

interface Harness {
  w: FakeWorker;
  call: <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) => Promise<T>;
}

function harness(
  opts: {
    scopes?: string[];
    agent?: { binding?: string; invocation?: string };
    bureau?: boolean;
    bindings?: Array<{ id: string; name: string; enabled?: 0 | 1; config?: Record<string, unknown> }>;
  } = {},
): Harness {
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: ERIC,
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: "eric@bullmoose.cc",
    displayName: "Eric",
  });
  w.db.seedAccount({
    accountId: STRANGER,
    tenantId: TENANT,
    principalId: "p_stranger",
    loginEmail: "stranger@bullmoose.cc",
  });
  const bindings = opts.bindings ?? [
    {
      id: "ab_extractor",
      name: "extractor",
      config: { modelAliases: { extract: [{ provider: "openrouter", model: "x" }] } },
    },
  ];
  for (const b of bindings) {
    w.db.seed("agent_bindings", [
      {
        id: b.id,
        account_id: ERIC,
        name: b.name,
        enabled: b.enabled ?? 1,
        config_json: JSON.stringify(b.config ?? {}),
      },
    ]);
  }

  const env: Env = { ...w.env, ...(opts.bureau === false ? { BUREAU: undefined } : { BUREAU: realBureau(w) }) } as Env;
  const registry = new MethodRegistry<RequestContext>();
  registerProviderCredentialMethods(registry);
  const ctx: RequestContext = {
    env,
    principal: {
      username: "eric@bullmoose.cc",
      scopes: opts.scopes ?? ["vault"],
      accounts: [{ accountId: ERIC, tenantId: TENANT, name: "Eric" }],
    },
    ...(opts.agent ? { agent: opts.agent } : {}),
  };
  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!(args, ctx) as Promise<T>;
  return { w, call };
}

/** The REAL Bureau, same D1, sole holder of the master key. */
function realBureau(w: FakeWorker): Fetcher {
  const bureauEnv: BureauEnv = {
    DB: w.env.DB,
    VAULT_MASTER_KEY: MASTER,
    INTERNAL_TOKEN: w.env.INTERNAL_TOKEN,
  };
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      bureauWorker.fetch(new Request(input as RequestInfo, init), bureauEnv),
  } as unknown as Fetcher;
}

const seal = (h: Harness, extra: Record<string, unknown> = {}) =>
  h.call("ProviderCredential/set", { accountId: ERIC, seal: { provider: "openrouter", key: KEY, ...extra } });

const status = (h: Harness, account = ERIC) => h.call("ProviderCredential/get", { accountId: account });

function configOf(w: FakeWorker, bindingId: string): Record<string, unknown> {
  const row = w.db.query<{ config_json: string }>(`SELECT config_json FROM agent_bindings WHERE id = ?`, bindingId)[0]!;
  return JSON.parse(row.config_json) as Record<string, unknown>;
}

// ── the write-only sweep ──────────────────────────────────────────────────

/** Every table in the control plane, as the schema declares them. Read off
 *  sqlite_master rather than listed by hand so a table added later is swept
 *  automatically instead of quietly escaping the guarantee. */
function everyRowAsText(w: FakeWorker): string {
  const tables = w.db.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  return tables.map((t) => JSON.stringify(w.db.query(`SELECT * FROM "${t.name}"`))).join("\n");
}

/**
 * The assertion itself, as a function, so the suite can prove it BITES.
 *
 * A sweep that cannot fail is not evidence, and "we checked the response does
 * not contain the key" is exactly the shape of assertion that silently stops
 * checking anything when the haystack changes. `haystack` is stringified whole
 * and searched for the canary AND for every prefix of it down to 8 characters —
 * because a truncated key is not a redaction, it is the substring that confirms
 * which key an attacker is holding.
 */
export function assertNoSecret(haystack: unknown, secret: string): void {
  const text = typeof haystack === "string" ? haystack : JSON.stringify(haystack);
  for (let len = secret.length; len >= 8; len--) {
    const fragment = secret.slice(0, len);
    if (text.includes(fragment)) {
      throw new Error(`the key (or a ${len}-character prefix of it) appears in the swept material`);
    }
  }
}

describe("ProviderCredential — the key is write-only", () => {
  it("the sweep BITES: a response that echoed the key fails it, and one prefix-truncated is not a redaction", () => {
    // Non-vacuity, proven both ways. Without this the sweep below could be
    // asserting nothing at all and nobody would find out.
    expect(() => assertNoSecret({ ok: true, key: KEY }, KEY)).toThrow(/appears in the swept material/);
    expect(() => assertNoSecret({ ok: true, hint: `${KEY.slice(0, 12)}…` }, KEY)).toThrow(/12-character prefix/);
    expect(() => assertNoSecret({ ok: true, credRef: "openrouter" }, KEY)).not.toThrow();
  });

  it("seals for real, and the key appears in NO response, NO row and NO error", async () => {
    const h = harness();
    const res = await seal(h);
    expect(res).toMatchObject({ action: "seal", credRef: "openrouter", created: true, keyReadable: false });

    // 1 — the response.
    assertNoSecret(res, KEY);
    // 2 — every row of every table, including the vault row itself (which
    //     holds ciphertext, because the seal really ran in the Bureau).
    assertNoSecret(everyRowAsText(h.w), KEY);
    // 3 — the read surface, which is what a client would actually poll.
    assertNoSecret(await status(h), KEY);
    // 4 — and the refusal path: a seal with a malformed body must not quote
    //     what it was given, nor say anything about its shape or length.
    const refusal = await h
      .call("ProviderCredential/set", { accountId: ERIC, seal: { provider: "openrouter", key: "" } })
      .then(() => "did not refuse")
      .catch((err: Error) => err.message);
    assertNoSecret(refusal, KEY);
    expect(refusal).toContain("write-only");

    // And the ciphertext is really ciphertext: the vault row exists and does
    // not contain the plaintext anywhere in it.
    const vault = h.w.db.query<{ enc_json: string; kind: string }>(
      `SELECT enc_json, kind FROM vault_credentials WHERE principal_id = 'p_eric' AND name = 'openrouter'`,
    );
    expect(vault).toHaveLength(1);
    expect(vault[0]!.kind).toBe("api-key");
    assertNoSecret(vault[0]!.enc_json, KEY);
  });

  it("no method returns a value field, whatever is asked for", async () => {
    const h = harness();
    await seal(h);
    const read = (await status(h)) as { credentials: Array<Record<string, unknown>>; keyReadable: boolean };
    expect(read.keyReadable).toBe(false);
    for (const cred of read.credentials) {
      // Enumerated rather than sampled: the shape must not grow a value field
      // by accident, and `header`/`meta` stay on the vault's own door.
      expect(Object.keys(cred).sort()).toEqual(
        ["allow", "credRef", "grant", "kind", "provider", "rotatedAt", "sealedAt"].sort(),
      );
    }
  });
});

// ── the scope wall ────────────────────────────────────────────────────────

describe("ProviderCredential/set — the custody scope is `vault`", () => {
  it("a plain `mail` device token is refused — the bundle does not cover the credential realm", async () => {
    const h = harness({ scopes: ["mail"] });
    await expect(seal(h)).rejects.toMatchObject({ type: "forbidden" });
    expect(h.w.db.query(`SELECT * FROM vault_credentials`)).toHaveLength(0);
  });

  it("a read+annotate+draft token — the supervisory scope set — is refused", async () => {
    // The exact effective-scope set a supervisory grant yields, presented on
    // the TOKEN, which is the strictly more permissive of the two shapes.
    const h = harness({ scopes: [...SUPERVISORY_GRANT_SCOPES] });
    await expect(seal(h)).rejects.toMatchObject({ type: "forbidden" });
  });

  it("`send` — the kill switch's scope — is NOT enough: custody is not the same decision as arming", async () => {
    const h = harness({ scopes: ["send", "mail"] });
    await expect(seal(h)).rejects.toMatchObject({ type: "forbidden" });
  });

  it("`vault` passes", async () => {
    const h = harness({ scopes: ["vault"] });
    await expect(seal(h)).resolves.toMatchObject({ action: "seal" });
  });

  it("the premise, pinned: no grant can EVER confer `vault` — the extension over #198", () => {
    // #198 gates the kill switch on `send`, which an operator CAN deliberately
    // widen a grant to carry (agentBinding.test.ts asserts that widening
    // works). `vault` cannot be widened onto a grant at all: provision's
    // allow-list has no entry for it, so there is no operator act that makes a
    // grant-derived session able to seal. If that ever changes, this fails
    // here rather than the door silently opening.
    expect([...SUPERVISORY_GRANT_SCOPES]).not.toContain("vault");
    expect([...GRANTABLE_SCOPES]).not.toContain("vault");
  });
});

/** The grant half, against the REAL resolution path: minted bearer,
 *  verifyBearer, real `grants` rows — nothing hand-assembled. */
async function grantHarness(grantScopes: readonly string[]) {
  const w = fakeEnv();
  w.db
    .seedAccount({ accountId: ERIC, tenantId: TENANT, principalId: "p_eric", loginEmail: "eric@bullmoose.cc" })
    .seedAccount({ accountId: STRANGER, tenantId: TENANT, principalId: "p_emily", loginEmail: "emily@bullmoose.cc" });
  w.db.seed("agent_bindings", [{ id: "ab_emily", account_id: STRANGER, name: "emily", enabled: 1, config_json: "{}" }]);

  const minted = await mintToken();
  w.db.seed("tokens", [
    {
      id: minted.id,
      principal_id: "p_eric",
      kind: "bearer",
      secret_hash: minted.secretHash,
      name: "eric-laptop",
      // The WIDEST token a human can hold: every mail verb AND the credential
      // realm. So the refusal below can only be the grant's.
      scopes: JSON.stringify(["mail", "vault"]),
      created_at: 1,
    },
  ]);
  w.db.seed("grants", [
    {
      id: "g_sup",
      tenant_id: TENANT,
      grantee_account_id: ERIC,
      target_account_id: STRANGER,
      scopes: JSON.stringify(grantScopes),
      created_by: "provision:supervisory",
      created_at: 1,
    },
  ]);

  const env: Env = { ...w.env, BUREAU: realBureau(w) } as Env;
  const registry = new MethodRegistry<RequestContext>();
  registerProviderCredentialMethods(registry);
  const call = async (method: string, args: Record<string, unknown>) => {
    const principal = await verifyBearer(w.env.DB, minted.token);
    if (!principal) throw new Error("token failed to resolve — fixture bug");
    return registry.get(method)!(args, { env, principal }) as Promise<Record<string, unknown>>;
  };
  return { w, call };
}

describe("ProviderCredential — the supervisory grant, resolved for real", () => {
  it("token ∩ supervisory grant lacks vault: the grant-reached seal is refused, nothing written", async () => {
    const h = await grantHarness(SUPERVISORY_GRANT_SCOPES);
    await expect(
      h.call("ProviderCredential/set", { accountId: STRANGER, seal: { provider: "openrouter", key: KEY } }),
    ).rejects.toMatchObject({ type: "forbidden" });
    expect(h.w.db.query(`SELECT * FROM vault_credentials`)).toHaveLength(0);
    expect(h.w.db.query(`SELECT * FROM bureau_grants`)).toHaveLength(0);
  });

  it("a grant widened as far as an operator CAN widen it still cannot seal", async () => {
    // Every scope provision will write onto a grant. `vault` is not among
    // them, so this is the maximum a delegated session can ever be — and it is
    // still not custody. This is the assertion #198 could not make.
    const h = await grantHarness([...GRANTABLE_SCOPES]);
    await expect(
      h.call("ProviderCredential/set", { accountId: STRANGER, seal: { provider: "openrouter", key: KEY } }),
    ).rejects.toMatchObject({ type: "forbidden" });
    expect(h.w.db.query(`SELECT * FROM vault_credentials`)).toHaveLength(0);
  });

  it("and the STATUS read is owner-only too: a grant-reached dossier does not show the tenant's credentials", async () => {
    const h = await grantHarness([...GRANTABLE_SCOPES]);
    await expect(h.call("ProviderCredential/get", { accountId: STRANGER })).rejects.toMatchObject({
      type: "forbidden",
    });
  });
});

// ── the agent refusal ─────────────────────────────────────────────────────

describe("ProviderCredential/set — no agent hand on the tenant's key", () => {
  it("an agent-marked principal is refused even holding `vault`", async () => {
    const h = harness({ scopes: ["vault", "agent"] });
    await expect(seal(h)).rejects.toMatchObject({ type: "forbidden" });
    expect(h.w.db.query(`SELECT * FROM vault_credentials`)).toHaveLength(0);
  });

  it("an agent-PROVENANCE call is refused (the MCP bridge / proposal executor shape)", async () => {
    const h = harness({ scopes: ["vault"], agent: { binding: "ab_extractor" } });
    await expect(seal(h)).rejects.toMatchObject({ type: "forbidden" });
  });

  it("the refusal precedes account resolution — an unreachable account gives the SAME error", async () => {
    const h = harness({ scopes: ["vault", "agent"] });
    await expect(
      h.call("ProviderCredential/set", { accountId: STRANGER, seal: { provider: "openrouter", key: KEY } }),
    ).rejects.toMatchObject({ type: "forbidden" });
  });
});

// ── ownership ─────────────────────────────────────────────────────────────

describe("ProviderCredential — ownership", () => {
  it("an account the principal cannot reach is accountNotFound, before anything else", async () => {
    const h = harness();
    await expect(
      h.call("ProviderCredential/set", { accountId: STRANGER, seal: { provider: "openrouter", key: KEY } }),
    ).rejects.toMatchObject({ type: "accountNotFound" });
    await expect(h.call("ProviderCredential/get", { accountId: STRANGER })).rejects.toMatchObject({
      type: "accountNotFound",
    });
  });

  it("a binding id on ANOTHER account is indistinguishable from one that never existed", async () => {
    const h = harness();
    h.w.db.seed("agent_bindings", [
      { id: "ab_theirs", account_id: STRANGER, name: "theirs", enabled: 1, config_json: "{}" },
    ]);
    const real = await h
      .call("ProviderCredential/set", {
        accountId: ERIC,
        seal: { provider: "openrouter", key: KEY, bindingId: "ab_theirs" },
      })
      .catch((e: Error) => e.message);
    const invented = await h
      .call("ProviderCredential/set", {
        accountId: ERIC,
        seal: { provider: "openrouter", key: KEY, bindingId: "ab_nope" },
      })
      .catch((e: Error) => e.message);
    expect(real).toBe(invented);
    // And the stranger's binding was not touched.
    expect(configOf(h.w, "ab_theirs")).toEqual({});
  });
});

// ── the three steps ───────────────────────────────────────────────────────

describe("ProviderCredential/set seal — seal, grant, attach", () => {
  it("does all three, and the status says the binding will resolve", async () => {
    const h = harness();
    const res = (await seal(h)) as { grantId: string; bindings: Array<{ id: string }> };
    expect(res.bindings.map((b) => b.id)).toEqual(["ab_extractor"]);

    // 1 — sealed.
    expect(h.w.db.query(`SELECT * FROM vault_credentials WHERE name = 'openrouter'`)).toHaveLength(1);
    // 2 — granted. Mint ≠ authorize: without this the key silently does nothing.
    const grants = h.w.db.query<{ verb: string; created_by: string; revoked_at: number | null }>(
      `SELECT verb, created_by, revoked_at FROM bureau_grants WHERE cred_name = 'openrouter'`,
    );
    expect(grants).toEqual([{ verb: "fetch", created_by: "eric@bullmoose.cc", revoked_at: null }]);
    // 3 — attached: the Bureau's check 2 reads exactly this.
    expect(configOf(h.w, "ab_extractor").providerCredentials).toEqual({ openrouter: "openrouter" });

    const read = (await status(h)) as { refs: Array<{ status: string; credRef: string }> };
    expect(read.refs).toEqual([
      {
        bindingId: "ab_extractor",
        bindingName: "extractor",
        enabled: true,
        provider: "openrouter",
        credRef: "openrouter",
        status: "live",
      },
    ]);
  });

  it("re-sealing ROTATES in place: same handle, same grant, new ciphertext", async () => {
    const h = harness();
    await seal(h);
    const before = h.w.db.query<{ enc_json: string; created_at: number }>(
      `SELECT enc_json, created_at FROM vault_credentials WHERE name = 'openrouter'`,
    )[0]!;
    const grantBefore = h.w.db.query<{ id: string }>(`SELECT id FROM bureau_grants`)[0]!;

    const res = (await seal(h, { key: "sk-or-v1-SECOND-9182bcde4455" })) as { created: boolean; rotated: boolean };
    expect(res).toMatchObject({ created: false, rotated: true, credRef: "openrouter" });

    const after = h.w.db.query<{ enc_json: string; created_at: number }>(
      `SELECT enc_json, created_at FROM vault_credentials WHERE name = 'openrouter'`,
    )[0]!;
    expect(after.enc_json).not.toBe(before.enc_json); // the ciphertext moved
    expect(h.w.db.query(`SELECT * FROM vault_credentials`)).toHaveLength(1); // one row, not two
    expect(h.w.db.query<{ id: string }>(`SELECT id FROM bureau_grants`)[0]!.id).toBe(grantBefore.id);
    // Nothing re-attached, because nothing needed to: the handle never moved.
    expect(configOf(h.w, "ab_extractor").providerCredentials).toEqual({ openrouter: "openrouter" });
    assertNoSecret(res, "sk-or-v1-SECOND-9182bcde4455");
  });

  it("attaches only to bindings that ROUTE to the provider, and says so when none do", async () => {
    const h = harness({
      bindings: [
        {
          id: "ab_local",
          name: "local",
          config: { modelAliases: { reply: [{ provider: "workers-ai", model: "y" }] } },
        },
      ],
    });
    const res = (await seal(h)) as { bindings: unknown[]; note?: string };
    expect(res.bindings).toEqual([]);
    expect(res.note).toMatch(/nothing names the key and nothing will spend it/);
    // Sealed and granted all the same — the operator can attach later, and the
    // status read makes the dangling state visible rather than silent.
    const read = (await status(h)) as { credentials: Array<{ credRef: string }>; refs: unknown[] };
    expect(read.credentials.map((c) => c.credRef)).toEqual(["openrouter"]);
    expect(read.refs).toEqual([]);
  });

  it("`gateway` is refused at the SESSION door: a caller-chosen allowlist is the control handed to the caller", async () => {
    const h = harness();
    await expect(
      h.call("ProviderCredential/set", { accountId: ERIC, seal: { provider: "gateway", key: KEY } }),
    ).rejects.toMatchObject({ type: "invalidArguments" });
    expect(h.w.db.query(`SELECT * FROM vault_credentials`)).toHaveLength(0);
  });

  it("without the BUREAU binding the door refuses and writes NOTHING — no grant pointing at an unsealed key", async () => {
    const h = harness({ bureau: false });
    await expect(seal(h)).rejects.toMatchObject({ type: "unknownMethod" });
    expect(h.w.db.query(`SELECT * FROM bureau_grants`)).toHaveLength(0);
    expect(configOf(h.w, "ab_extractor").providerCredentials).toBeUndefined();
  });

  it("exactly one verb per call", async () => {
    const h = harness();
    await expect(h.call("ProviderCredential/set", { accountId: ERIC })).rejects.toMatchObject({
      type: "invalidArguments",
    });
    await expect(
      h.call("ProviderCredential/set", {
        accountId: ERIC,
        seal: { provider: "openrouter", key: KEY },
        revoke: { credRef: "openrouter" },
      }),
    ).rejects.toMatchObject({ type: "invalidArguments" });
  });
});

// ── detach and revoke ─────────────────────────────────────────────────────

describe("ProviderCredential/set — detach is not delete, and revoke is not either", () => {
  it("detach drops the binding's REFERENCE and leaves credential + grant standing", async () => {
    const h = harness();
    await seal(h);
    const res = (await h.call("ProviderCredential/set", {
      accountId: ERIC,
      detach: { bindingId: "ab_extractor" },
    })) as { detached: Array<{ credRef: string }>; credentialDeleted: boolean; grantRevoked: boolean };

    expect(res.detached).toEqual([
      { id: "ab_extractor", name: "extractor", provider: "openrouter", credRef: "openrouter" },
    ]);
    expect(res.credentialDeleted).toBe(false);
    expect(res.grantRevoked).toBe(false);
    // The ref is gone — and the empty map with it, rather than left as `{}`.
    expect(configOf(h.w, "ab_extractor").providerCredentials).toBeUndefined();
    // The credential and its grant survive: re-attaching is a config change,
    // not a re-seal.
    expect(h.w.db.query(`SELECT * FROM vault_credentials`)).toHaveLength(1);
    expect(h.w.db.query(`SELECT * FROM bureau_grants WHERE revoked_at IS NULL`)).toHaveLength(1);
    // And the credential stays VISIBLE (via its live grant), so a sealed key
    // nothing references is not an invisible live capability.
    const read = (await h.call("ProviderCredential/get", { accountId: ERIC })) as {
      credentials: Array<{ credRef: string }>;
      refs: unknown[];
    };
    expect(read.credentials.map((c) => c.credRef)).toEqual(["openrouter"]);
    expect(read.refs).toEqual([]);
  });

  it("revoke tombstones the grant, detaches everywhere, and does NOT destroy the sealed value", async () => {
    const h = harness({
      bindings: [
        { id: "ab_one", name: "one", config: { modelAliases: { extract: [{ provider: "openrouter", model: "x" }] } } },
        { id: "ab_two", name: "two", config: { modelAliases: { reply: [{ provider: "openrouter", model: "x" }] } } },
      ],
    });
    await seal(h);
    const res = (await h.call("ProviderCredential/set", {
      accountId: ERIC,
      revoke: { credRef: "openrouter" },
    })) as { grantRevoked: boolean; credentialDeleted: boolean; detached: Array<{ id: string }> };

    expect(res.grantRevoked).toBe(true);
    expect(res.credentialDeleted).toBe(false);
    expect(res.detached.map((d) => d.id).sort()).toEqual(["ab_one", "ab_two"]);
    // Tombstone, not DELETE (s03.A) — the row and its history survive.
    expect(h.w.db.query(`SELECT * FROM bureau_grants`)).toHaveLength(1);
    expect(h.w.db.query(`SELECT * FROM bureau_grants WHERE revoked_at IS NULL`)).toHaveLength(0);
    // The ciphertext survives. A hard delete exists elsewhere (the agent
    // worker's `DELETE /vault/credentials/{name}`) and is deliberately not one
    // of this door's verbs — revoke is the REVERSIBLE stop.
    expect(h.w.db.query(`SELECT * FROM vault_credentials`)).toHaveLength(1);
    expect(configOf(h.w, "ab_one").providerCredentials).toBeUndefined();
  });

  it("revoke is idempotent — a second click reports honestly rather than inventing a tombstone", async () => {
    const h = harness();
    await seal(h);
    await h.call("ProviderCredential/set", { accountId: ERIC, revoke: { credRef: "openrouter" } });
    const again = (await h.call("ProviderCredential/set", {
      accountId: ERIC,
      revoke: { credRef: "openrouter" },
    })) as { grantId: string | null; grantRevoked: boolean };
    expect(again.grantId).toBeNull();
    expect(again.grantRevoked).toBe(false);
    expect(h.w.db.query(`SELECT * FROM grant_lifecycle WHERE event = 'revoked'`)).toHaveLength(1);
  });

  it("re-sealing after a revoke REINSTATES the same grant row (a tombstone is not a permanent ban)", async () => {
    const h = harness();
    await seal(h);
    const grantId = h.w.db.query<{ id: string }>(`SELECT id FROM bureau_grants`)[0]!.id;
    await h.call("ProviderCredential/set", { accountId: ERIC, revoke: { credRef: "openrouter" } });
    await seal(h);
    const rows = h.w.db.query<{ id: string; revoked_at: number | null }>(`SELECT id, revoked_at FROM bureau_grants`);
    expect(rows).toEqual([{ id: grantId, revoked_at: null }]);
  });

  it("detach requires a binding on THIS account", async () => {
    const h = harness();
    await seal(h);
    await expect(
      h.call("ProviderCredential/set", { accountId: ERIC, detach: { bindingId: "ab_nope" } }),
    ).rejects.toMatchObject({ type: "invalidArguments" });
  });
});

// ── the honest failure states ─────────────────────────────────────────────

describe("ProviderCredential/get — the refusal states, made legible", () => {
  const named = {
    id: "ab_extractor",
    name: "extractor",
    config: {
      modelAliases: { extract: [{ provider: "openrouter", model: "x" }] },
      providerCredentials: { openrouter: "openrouter" },
    },
  };

  it("a binding NAMING a credential that was never sealed reads `no-credential`", async () => {
    // The exact shape of the bug this surface exists for: the agent refuses
    // every call rather than spending the platform key, which is correct and
    // invisible. Here it is a status.
    const h = harness({ bindings: [named] });
    const read = (await status(h)) as { refs: Array<{ status: string }>; credentials: unknown[] };
    expect(read.refs[0]!.status).toBe("no-credential");
    expect(read.credentials).toEqual([]);
  });

  it("sealed but NOT granted reads `no-grant` — mint ≠ authorize, surfaced", async () => {
    const h = harness({ bindings: [named] });
    await seal(h);
    h.w.db.sqlite.prepare(`DELETE FROM bureau_grants`).run();
    const read = (await status(h)) as { refs: Array<{ status: string }> };
    expect(read.refs[0]!.status).toBe("no-grant");
  });

  it("a revoked grant reads `grant-revoked`, an expired one `grant-expired`", async () => {
    const h = harness({ bindings: [named] });
    await seal(h);
    h.w.db.sqlite.prepare(`UPDATE bureau_grants SET revoked_at = 5`).run();
    expect(((await status(h)) as { refs: Array<{ status: string }> }).refs[0]!.status).toBe("grant-revoked");

    h.w.db.sqlite.prepare(`UPDATE bureau_grants SET revoked_at = NULL, expires_at = 5`).run();
    expect(((await status(h)) as { refs: Array<{ status: string }> }).refs[0]!.status).toBe("grant-expired");
  });

  it("a credential with no destination reads `no-destination` — invariant 5 refuses it at use time", async () => {
    const h = harness({ bindings: [named] });
    await seal(h);
    h.w.db.sqlite.prepare(`UPDATE vault_credentials SET meta_json = '{}'`).run();
    const read = (await status(h)) as { refs: Array<{ status: string }>; credentials: Array<{ allow: string | null }> };
    expect(read.refs[0]!.status).toBe("no-destination");
    expect(read.credentials[0]!.allow).toBeNull();
  });

  it("names the bindings running on the PLATFORM key — the honest empty state", async () => {
    const h = harness();
    const read = (await status(h)) as { platformKeyBindings: Array<{ name: string; provider: string }> };
    expect(read.platformKeyBindings).toEqual([{ id: "ab_extractor", name: "extractor", provider: "openrouter" }]);
    // …and once a key is sealed they move off the list.
    await seal(h);
    expect(((await status(h)) as { platformKeyBindings: unknown[] }).platformKeyBindings).toEqual([]);
  });

  it("reports the session's own write authority so the UI greys rather than offers-then-refuses", async () => {
    const readable = (await status(harness({ scopes: ["mail"] }))) as { mayWrite: boolean; writeRefusal: string };
    expect(readable.mayWrite).toBe(false);
    expect(readable.writeRefusal).toMatch(/"vault" scope/);
    const writable = (await status(harness({ scopes: ["vault"] }))) as { mayWrite: boolean; writeRefusal: null };
    expect(writable.mayWrite).toBe(true);
    expect(writable.writeRefusal).toBeNull();
  });

  it("the read needs only `read` — the failure state must be visible to an ordinary session", async () => {
    const h = harness({ scopes: ["read"], bindings: [named] });
    const read = (await status(h)) as { refs: Array<{ status: string }>; mayWrite: boolean };
    expect(read.refs[0]!.status).toBe("no-credential");
    expect(read.mayWrite).toBe(false);
  });

  it("a disabled binding is reported as such: the kill switch refuses BEFORE any of this", async () => {
    const h = harness({ bindings: [{ ...named, enabled: 0 }] });
    await seal(h);
    const read = (await status(h)) as { refs: Array<{ enabled: boolean; status: string }> };
    expect(read.refs[0]).toMatchObject({ enabled: false, status: "live" });
  });
});

// ── audit ─────────────────────────────────────────────────────────────────

describe("ProviderCredential — the audit trail names the actor and never the key", () => {
  it("attach, detach and revoke each leave a row attributed to the acting principal", async () => {
    const h = harness();
    await seal(h);
    await h.call("ProviderCredential/set", { accountId: ERIC, detach: { bindingId: "ab_extractor" } });
    await seal(h);
    await h.call("ProviderCredential/set", { accountId: ERIC, revoke: { credRef: "openrouter" } });

    const chain = h.w.db.query<{ event: string; old_value: string | null; new_value: string | null; actor: string }>(
      `SELECT event, old_value, new_value, actor FROM binding_lifecycle ORDER BY id`,
    );
    expect(chain).toEqual([
      {
        event: "provider-credential-attached",
        old_value: null,
        new_value: "openrouter=openrouter",
        actor: "eric@bullmoose.cc",
      },
      {
        event: "provider-credential-detached",
        old_value: "openrouter=openrouter",
        new_value: null,
        actor: "eric@bullmoose.cc",
      },
      {
        event: "provider-credential-attached",
        old_value: null,
        new_value: "openrouter=openrouter",
        actor: "eric@bullmoose.cc",
      },
      {
        event: "provider-credential-detached",
        old_value: "openrouter=openrouter",
        new_value: null,
        actor: "eric@bullmoose.cc",
      },
    ]);

    const grantChain = h.w.db.query<{ event: string; actor: string }>(
      `SELECT event, actor FROM grant_lifecycle ORDER BY id`,
    );
    expect(grantChain.map((r) => r.event)).toEqual(["created", "created", "revoked"]);
    expect(new Set(grantChain.map((r) => r.actor))).toEqual(new Set(["eric@bullmoose.cc"]));

    // The whole forensic record, swept.
    assertNoSecret(everyRowAsText(h.w), KEY);
  });

  it("a rotate writes NO binding_lifecycle row — a chain that records non-events is unreadable", async () => {
    const h = harness();
    await seal(h);
    await seal(h, { key: "sk-or-v1-THIRD-aa11bb22cc33" });
    expect(h.w.db.query(`SELECT * FROM binding_lifecycle`)).toHaveLength(1);
  });
});
