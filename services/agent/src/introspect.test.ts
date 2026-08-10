import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { handleMcp } from "./mcp";
import { effectiveScopes } from "./introspectTools";

// sVOL 015 — self-introspection over MCP (`help@`), driven end to end through
// `handleMcp`: bearer → verifyBearer → per-tool authorizeAccount → the tool.
//
// The assertion that matters is NOT "the tool returns rows". These read
// AUTHORIZATION state, so the substance of the unit is the DISCLOSURE
// BOUNDARY: an agent asking what IT can do is fine; an agent enumerating
// other principals' grants is not. The gate that would be wrong here is the
// obvious one — `authorizeAccount` returns `ok` for a grant-reached account
// (`principal.ts:253-259`), so reusing the dispatcher's decision as the gate
// lets a one-job grantee walk out with the owner's whole access list.
// "5. the disclosure boundary" below is the test that catches that shortcut,
// and it keys on `access.granted` being present, never on the authorize
// result.
//
// Fakes are @bullmoose/test-fakes (sVOL 002): real node:sqlite over the live
// schema, so `verifyBearer`'s joins and every query in introspectTools.ts
// execute as written.

const V = "2026-07-28";
const TENANT = "t_bm";

let minted: { id: string; token: string; secretHash: string };
beforeAll(async () => {
  minted = await mintToken();
});

interface Grant {
  id: string;
  grantee: string;
  target: string;
  scopes: string[];
  collection?: string | null;
  collectionId?: string | null;
  expiresAt?: number | null;
  /** s03.A tombstone. A revoked grant keeps its row; only this is set. */
  revokedAt?: number | null;
}

interface Binding {
  id: string;
  accountId: string;
  name: string;
  enabled?: number;
  triggerOn?: string;
  config?: Record<string, unknown>;
}

interface Invocation {
  id: string;
  accountId: string;
  bindingId: string;
  bindingName: string;
  status?: string;
  emailId?: string | null;
  note?: string | null;
  result?: Record<string, unknown> | null;
}

interface Audit {
  grantId: string;
  principal: string;
  accountId: string;
  method: string;
  at?: number;
}

interface Fixture {
  principalId?: string;
  loginEmail?: string;
  scopes?: string[];
  /** Accounts the bearer's principal owns, id → identity address. */
  owns?: Array<{ id: string; address?: string; name?: string }>;
  /** Accounts belonging to someone else. */
  others?: Array<{ id: string; address?: string; name?: string }>;
  grants?: Grant[];
  bindings?: Binding[];
  invocations?: Invocation[];
  audit?: Audit[];
  spend?: Array<Record<string, unknown>>;
}

function world(fx: Fixture): FakeWorker {
  const principalId = fx.principalId ?? "p_eric";
  const w = fakeEnv();

  const seedIdentity = (accountId: string, address: string | undefined, n: number) => {
    w.db.seed("identities", [
      { id: `id_${accountId}`, account_id: accountId, email: address ?? `${accountId}@bullmoose.cc`, name: `n${n}` },
    ]);
  };

  (fx.owns ?? []).forEach((a, i) => {
    w.db.seedAccount({
      accountId: a.id,
      tenantId: TENANT,
      principalId,
      loginEmail: fx.loginEmail ?? "eric@bullmoose.cc",
      displayName: a.name ?? "Eric",
    });
    seedIdentity(a.id, a.address, i);
  });
  (fx.others ?? []).forEach((a, i) => {
    w.db.seedAccount({
      accountId: a.id,
      tenantId: TENANT,
      principalId: `p_owner_${a.id}`,
      loginEmail: `owner-${a.id}@bullmoose.cc`,
      displayName: a.name ?? "Someone",
    });
    seedIdentity(a.id, a.address, 100 + i);
  });

  w.db.seed("tokens", [
    {
      id: minted.id,
      principal_id: principalId,
      kind: "bearer",
      secret_hash: minted.secretHash,
      name: "test",
      scopes: JSON.stringify(fx.scopes ?? ["read"]),
      created_at: 1,
      expires_at: null,
      last_used_at: Date.now(),
    },
  ]);

  w.db.seed(
    "grants",
    (fx.grants ?? []).map((g) => ({
      id: g.id,
      tenant_id: TENANT,
      grantee_account_id: g.grantee,
      target_account_id: g.target,
      scopes: JSON.stringify(g.scopes),
      collection: g.collection ?? null,
      collection_id: g.collectionId ?? null,
      created_by: "admin",
      created_at: 1,
      expires_at: g.expiresAt ?? null,
      revoked_at: g.revokedAt ?? null,
    })),
  );

  w.db.seed(
    "agent_bindings",
    (fx.bindings ?? []).map((b) => ({
      id: b.id,
      account_id: b.accountId,
      name: b.name,
      trigger_on: b.triggerOn ?? "mailbox-delivery",
      sla_seconds: null,
      enabled: b.enabled ?? 1,
      config_json: JSON.stringify(b.config ?? {}),
    })),
  );

  w.db.seed(
    "agent_invocations",
    (fx.invocations ?? []).map((v) => ({
      id: v.id,
      account_id: v.accountId,
      binding_id: v.bindingId,
      binding_name: v.bindingName,
      status: v.status ?? "done",
      email_id: v.emailId ?? null,
      context_json: JSON.stringify({ envelopeTo: "secret+tag@bullmoose.cc" }),
      result_json: v.result === undefined ? null : JSON.stringify(v.result),
      note: v.note ?? null,
      created_at: 1000,
      claimed_at: 1001,
      done_at: 1002,
    })),
  );

  w.db.seed(
    "grant_audit",
    (fx.audit ?? []).map((a, i) => ({
      grant_id: a.grantId,
      principal: a.principal,
      account_id: a.accountId,
      method: a.method,
      at: a.at ?? Date.now() - i * 1000,
    })),
  );

  w.db.seed(
    "spend_facts",
    (fx.spend ?? []).map((s) => ({
      id: "sf_1",
      vendor: "v",
      amount_cents: 1,
      currency: "USD",
      txn_date: "2026-08-03",
      period_month: "2026-08",
      category: "home",
      confidence: 1,
      dedup_hash: "h1",
      created_at: 1,
      ...s,
    })),
  );
  return w;
}

const headers = () => ({
  Authorization: `Bearer ${minted.token}`,
  "MCP-Protocol-Version": V,
  "content-type": "application/json",
});
const meta = () => ({
  "io.modelcontextprotocol/protocolVersion": V,
  "io.modelcontextprotocol/clientCapabilities": {},
});

interface Called {
  status: number;
  /** Parsed tool result, when the call produced one. */
  out: any;
  /** The raw text the tool returned (a ToolError message on refusal). */
  text: string;
  isError: boolean;
  body: any;
  writes: Array<{ sql: string; args: unknown[] }>;
  db: FakeWorker["db"];
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  fx: Fixture,
  w = world(fx),
): Promise<Called> {
  const req = new Request("https://agent/mcp/analytics", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: meta() } }),
  });
  const res = await handleMcp(req, w.env);
  const body = (await res.json()) as any;
  const text = body.result?.content?.[0]?.text ?? "";
  let out: any = null;
  try {
    out = JSON.parse(text);
  } catch {
    /* a ToolError message is prose, not JSON */
  }
  return {
    status: res.status,
    out,
    text,
    isError: body.result?.isError === true,
    body,
    writes: w.db.writes,
    db: w.db,
  };
}

// Eric owns one account and nothing else is going on.
const eric = (over: Partial<Fixture> = {}): Fixture => ({
  principalId: "p_eric",
  loginEmail: "eric@bullmoose.cc",
  owns: [{ id: "a_eric", address: "eric@bullmoose.cc", name: "Eric" }],
  ...over,
});

// Allen owns a_allen and reaches Eric's account ONLY through a read grant.
// This is `mcp-auth.md` §12's worked example, and the fixture every
// disclosure assertion runs on.
const allenGrantedOnEric = (over: Partial<Fixture> = {}): Fixture => ({
  principalId: "p_allen",
  loginEmail: "allen@bullmoose.cc",
  scopes: ["read"],
  owns: [{ id: "a_allen", address: "allen@bullmoose.cc", name: "Allen" }],
  others: [{ id: "a_eric", address: "eric@bullmoose.cc", name: "Eric" }],
  grants: [{ id: "g_allen", grantee: "a_allen", target: "a_eric", scopes: ["read"] }],
  ...over,
});

// ---------------------------------------------------------------------------

describe("015 — the disclosure boundary", () => {
  it("1. who_can_access is refused on a GRANT-REACHED account", async () => {
    // The shortcut this catches: `handleToolCall` already ran
    // `authorizeAccount(principal, "a_eric", "read", "mail")` and it returned
    // ok — Allen holds a live read grant. A tool that trusted that decision
    // would now hand Allen every other grant on Eric's account.
    const r = await callTool("who_can_access", { accountId: "a_eric" }, allenGrantedOnEric());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/refused/i);
    expect(r.text).toMatch(/grant, not ownership/);
    expect(r.out).toBeNull();
  });

  it("2. access_log is refused on a GRANT-REACHED account", async () => {
    const r = await callTool("access_log", { accountId: "a_eric" }, allenGrantedOnEric());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/refused/i);
  });

  it("3. my_agents and invocation_history and explain_skip are refused too", async () => {
    for (const [name, args] of [
      ["my_agents", { accountId: "a_eric" }],
      ["invocation_history", { accountId: "a_eric" }],
      ["explain_skip", { accountId: "a_eric", emailId: "e1" }],
    ] as const) {
      const r = await callTool(name, args, allenGrantedOnEric());
      expect(r.isError, `${name} must refuse a grant-reached account`).toBe(true);
      expect(r.text).toMatch(/refused/i);
    }
  });

  it("4. the SAME token still reads ordinary data on the SAME account", async () => {
    // Without this half, "refused" could just mean the grant is broken. The
    // refusal must be specific to authorization-state tools — the delegation
    // Eric authorised ("read my mail") is intact; what is refused is reading
    // his org chart.
    const r = await callTool(
      "spend_by_month",
      { accountId: "a_eric" },
      allenGrantedOnEric({ spend: [{ account_id: "a_eric" }] }),
    );
    expect(r.status).toBe(200);
    expect(r.isError).toBe(false);
    expect(Array.isArray(r.out)).toBe(true);
  });

  it("5. no third-party row leaks in the refusal payload", async () => {
    // Eric has a second grantee, `mallory@`. Allen must not learn she exists
    // — not through rows, not through an error message, not through a count.
    const fx = allenGrantedOnEric({
      others: [
        { id: "a_eric", address: "eric@bullmoose.cc", name: "Eric" },
        { id: "a_mallory", address: "mallory@bullmoose.cc", name: "Mallory" },
      ],
      grants: [
        { id: "g_allen", grantee: "a_allen", target: "a_eric", scopes: ["read"] },
        { id: "g_mallory", grantee: "a_mallory", target: "a_eric", scopes: ["mail"] },
      ],
    });
    const r = await callTool("who_can_access", { accountId: "a_eric" }, fx);
    expect(r.isError).toBe(true);
    const whole = JSON.stringify(r.body);
    expect(whole).not.toContain("mallory");
    expect(whole).not.toContain("g_mallory");
  });

  it("6. a REFUSED enumeration attempt is still written to grant_audit", async () => {
    // Done-when #6, and the reason Rule 1 is enforced inside `run` rather
    // than in the dispatcher: `handleToolCall` writes the audit row before
    // the tool executes (`mcp.ts:345-352`), so the attempt lands even though
    // it was denied. An operator wants to see someone trying this.
    const r = await callTool("who_can_access", { accountId: "a_eric" }, allenGrantedOnEric());
    expect(r.isError).toBe(true);
    const audit = r.writes.find((w) => w.sql.includes("grant_audit"));
    expect(audit).toBeDefined();
    expect(audit!.args).toContain("g_allen");
    expect(audit!.args).toContain("a_eric");
    expect(audit!.args).toContain("mcp:who_can_access");
  });

  it("7. my_access IS answerable on a grant-reached account — it is self-description", async () => {
    // Rule 2's asymmetry, asserted in both directions in one place: "what can
    // I reach" is always fine, "who else can reach it" is not. Every row here
    // is a grant made TO Allen.
    const r = await callTool("my_access", { accountId: "a_eric" }, allenGrantedOnEric());
    expect(r.isError).toBe(false);
    expect(r.out.grants).toHaveLength(1);
    expect(r.out.grants[0].grantId).toBe("g_allen");
    expect(r.out.grants[0].target.accountId).toBe("a_eric");
  });

  it("8. my_access never returns a grant where someone else is the grantee", async () => {
    const fx = allenGrantedOnEric({
      others: [
        { id: "a_eric", address: "eric@bullmoose.cc" },
        { id: "a_mallory", address: "mallory@bullmoose.cc" },
      ],
      grants: [
        { id: "g_allen", grantee: "a_allen", target: "a_eric", scopes: ["read"] },
        // Mallory → Eric. Nothing to do with Allen.
        { id: "g_mallory", grantee: "a_mallory", target: "a_eric", scopes: ["mail"] },
      ],
    });
    const r = await callTool("my_access", { accountId: "a_eric" }, fx);
    expect(r.out.grants.map((g: any) => g.grantId)).toEqual(["g_allen"]);
    expect(JSON.stringify(r.out)).not.toContain("mallory");
  });
});

describe("015 — \"which agents can read my contacts?\"", () => {
  // The literal acceptance test from docs/agents/motivatingExamples.md:298.
  const ericWithGrantees = (): Fixture =>
    eric({
      others: [
        { id: "a_editor", address: "editor@bullmoose.cc", name: "editor@" },
        { id: "a_sched", address: "schedule@bullmoose.cc", name: "schedule@" },
        { id: "a_book", address: "books@bullmoose.cc", name: "books@" },
      ],
      grants: [
        // Whole-account, stored as the mail bundle.
        { id: "g_editor", grantee: "a_editor", target: "a_eric", scopes: ["mail"] },
        // Calendar-only: must NOT answer a contacts question.
        { id: "g_sched", grantee: "a_sched", target: "a_eric", scopes: ["calendar"], collection: "Calendar", collectionId: "cal_1" },
        // One shared address book, read-only.
        { id: "g_book", grantee: "a_book", target: "a_eric", scopes: ["read"], collection: "AddressBook", collectionId: "ab_1" },
      ],
    });

  it("9. names the agents that can read contacts, and excludes the one that cannot", async () => {
    const r = await callTool(
      "who_can_access",
      { accountId: "a_eric", domain: "contacts", scope: "read" },
      ericWithGrantees(),
    );
    expect(r.isError).toBe(false);
    const ids = r.out.grants.map((g: any) => g.grantId).sort();
    // g_editor: whole-account + ["mail"] ⊇ read → yes, contacts included.
    // g_book:   AddressBook-scoped + ["read"] → yes.
    // g_sched:  Calendar-scoped → grantCoversDomain says no for contacts.
    expect(ids).toEqual(["g_book", "g_editor"]);
    const addresses = r.out.grants.map((g: any) => g.grantee.address).sort();
    expect(addresses).toEqual(["books@bullmoose.cc", "editor@bullmoose.cc"]);
  });

  it("10. the same question about the calendar returns the other set", async () => {
    const r = await callTool(
      "who_can_access",
      { accountId: "a_eric", domain: "calendar", scope: "read" },
      ericWithGrantees(),
    );
    // g_sched holds ["calendar"], which — since common/027 — DOES confer
    // "read" (any write/realm capability implies read), and its grant covers
    // the calendar domain, so asking who can READ the calendar now includes it.
    // This is exactly 027 symptom 1 fixed: a calendar grant could write events
    // it could not list; now it can list them. g_editor's whole-account
    // ["mail"] also confers read; g_book is AddressBook-scoped, so excluded.
    expect(r.out.grants.map((g: any) => g.grantId)).toEqual(["g_editor", "g_sched"]);
  });

  it("11. filtering matches what the gate would actually decide", async () => {
    // `who_can_access` reuses `matchingGrants` — the same function
    // `authorizeAccount` runs — rather than re-deriving the predicate in SQL.
    // Asking "who can WRITE my calendar" must therefore find g_sched, whose
    // ["calendar"] scope is exactly the calendar write scope (_context.md §4).
    const r = await callTool(
      "who_can_access",
      { accountId: "a_eric", domain: "calendar", scope: "calendar" },
      ericWithGrantees(),
    );
    expect(r.out.grants.map((g: any) => g.grantId)).toEqual(["g_sched"]);
  });

  it("12. unfiltered, it returns every grantee with their address", async () => {
    const r = await callTool("who_can_access", { accountId: "a_eric" }, ericWithGrantees());
    expect(r.out.grants).toHaveLength(3);
    // The disclosure Rule 1 exists to justify: other principals' addresses.
    expect(r.out.grants.map((g: any) => g.grantee.address).sort()).toEqual([
      "books@bullmoose.cc",
      "editor@bullmoose.cc",
      "schedule@bullmoose.cc",
    ]);
  });
});

describe("015 — effective permissions, not raw scopes", () => {
  it("13. `mail` expands to the six verbs it actually confers", () => {
    // Done-when #3, and the claim the whole tool exists to make. Derived
    // through `hasScope` itself, so it cannot drift from the gate.
    expect(effectiveScopes(["mail"])).toEqual([
      "read",
      "annotate",
      "draft",
      "move",
      "send",
      "delete",
    ]);
  });

  it("14. `mail` does NOT confer the realm scopes (common/001 is closed)", () => {
    expect(effectiveScopes(["mail"])).not.toContain("contacts");
    expect(effectiveScopes(["mail"])).not.toContain("calendar");
    expect(effectiveScopes(["mail"])).not.toContain("vault");
    expect(effectiveScopes(["mail"])).not.toContain("admin");
  });

  it("15. a grant stored as [\"mail\"] is REPORTED as the six verbs", async () => {
    const r = await callTool(
      "who_can_access",
      { accountId: "a_eric" },
      eric({
        others: [{ id: "a_editor", address: "editor@bullmoose.cc" }],
        grants: [{ id: "g_editor", grantee: "a_editor", target: "a_eric", scopes: ["mail"] }],
      }),
    );
    const g = r.out.grants[0];
    expect(g.scopes).toEqual(["mail"]);
    expect(g.allows).toEqual(["read", "annotate", "draft", "move", "send", "delete"]);
    // And it says so in words, because "mail" reads as innocuous.
    expect(JSON.stringify(g.warnings)).toMatch(/send/);
    expect(JSON.stringify(g.warnings)).toMatch(/delete/);
  });

  it("16. whoami reports the TOKEN's effective permissions the same way", async () => {
    const r = await callTool(
      "whoami",
      { accountId: "a_eric" },
      eric({ scopes: ["mail", "contacts"] }),
    );
    expect(r.out.tokenScopes).toEqual(["mail", "contacts"]);
    expect(r.out.tokenAllows).toEqual([
      "read",
      "annotate",
      "draft",
      "move",
      "send",
      "delete",
      "contacts",
    ]);
  });

  it("17. on a grant-reached account, whoami reports token ∩ grant", async () => {
    // The grant is generous; the token is not. Reporting the grant's scopes
    // alone would overstate what the holder can do.
    const r = await callTool(
      "whoami",
      { accountId: "a_eric" },
      allenGrantedOnEric({
        scopes: ["read"],
        grants: [{ id: "g_allen", grantee: "a_allen", target: "a_eric", scopes: ["mail"] }],
      }),
    );
    expect(r.out.grantReachedAccounts[0].via[0].scopes).toEqual(["mail"]);
    expect(r.out.grantReachedAccounts[0].via[0].allows).toEqual(["read"]);
  });
});

describe("015 — whoami distinguishes owned from grant-reached", () => {
  it("18. lists both, in separate buckets", async () => {
    const r = await callTool("whoami", { accountId: "a_allen" }, allenGrantedOnEric());
    expect(r.out.principal).toBe("allen@bullmoose.cc");
    expect(r.out.ownedAccounts.map((a: any) => a.accountId)).toEqual(["a_allen"]);
    expect(r.out.grantReachedAccounts.map((a: any) => a.accountId)).toEqual(["a_eric"]);
    expect(r.out.grantReachedAccounts[0].via[0].grantId).toBe("g_allen");
  });

  it("19. an owner's grant-reached bucket is empty, not absent", async () => {
    const r = await callTool("whoami", { accountId: "a_eric" }, eric());
    expect(r.out.ownedAccounts).toHaveLength(1);
    expect(r.out.grantReachedAccounts).toEqual([]);
  });
});

describe("015 — my_agents does not disclose binding config", () => {
  const withEditor = (): Fixture =>
    eric({
      bindings: [
        {
          id: "b_editor",
          accountId: "a_eric",
          name: "editor",
          config: {
            persona: "SECRET-PERSONA-TEXT you are a terse editor",
            replyMode: "send",
            allowedSenders: ["confidential@partner.example"],
            modelAliases: { cheap: [{ provider: "workers-ai", model: "m" }] },
            digestTargets: { x: "secret-digest@partner.example" },
          },
        },
      ],
    });

  it("20. returns the safety-relevant shape", async () => {
    const r = await callTool("my_agents", { accountId: "a_eric" }, withEditor());
    const b = r.out.bindings[0];
    expect(b.name).toBe("editor");
    expect(b.enabled).toBe(true);
    expect(b.triggerOn).toBe("mailbox-delivery");
    expect(b.config.replyMode).toBe("send");
    expect(b.config.hasPersona).toBe(true);
    expect(b.config.senderAllowlist).toEqual({ active: true, count: 1 });
  });

  it("21. and none of the sensitive values", async () => {
    const r = await callTool("my_agents", { accountId: "a_eric" }, withEditor());
    const whole = JSON.stringify(r.out);
    expect(whole).not.toContain("SECRET-PERSONA-TEXT");
    expect(whole).not.toContain("confidential@partner.example");
    expect(whole).not.toContain("secret-digest@partner.example");
    expect(whole).not.toContain("config_json");
  });

  it("22. the projected key set is frozen — an added field cannot slip through", async () => {
    // Done-when #4 says to assert on the projection, not on a fixture's
    // output: "an absent value in one fixture proves nothing". A new key on
    // `BindingConfig` that someone passes through here fails HERE.
    const r = await callTool("my_agents", { accountId: "a_eric" }, withEditor());
    expect(Object.keys(r.out.bindings[0].config).sort()).toEqual([
      "hasPersona",
      "modelAliasCount",
      "pipeline",
      "replyMode",
      "senderAllowlist",
    ]);
    expect(Object.keys(r.out.bindings[0]).sort()).toEqual([
      "bindingId",
      "config",
      "enabled",
      "name",
      "slaSeconds",
      "triggerOn",
      "warnings",
    ]);
  });

  it("23. surfaces the dangerous combination rather than just the parts", async () => {
    const r = await callTool(
      "my_agents",
      { accountId: "a_eric" },
      eric({
        bindings: [
          { id: "b_x", accountId: "a_eric", name: "loose", config: { replyMode: "send" } },
        ],
      }),
    );
    const warnings = JSON.stringify(r.out.bindings[0].warnings);
    expect(warnings).toMatch(/no sender allowlist AND replyMode send/);
  });
});

describe("015 — never SELECT * from a control-plane table", () => {
  // Rule 3, asserted structurally. `AgentInvocation/get` does
  // `SELECT * FROM agent_invocations` and hand-projects (`agent.ts:54`); the
  // projection discipline is what this unit copies, not the `SELECT *`.
  //
  // Comments are stripped first, because the module explains at length what it
  // deliberately does not do — and a rule that forbade NAMING `secret_hash`
  // would forbid documenting why it is excluded. The assertion is about the
  // code that runs.
  const src = readFileSync(new URL("./introspectTools.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("24. the module contains no SELECT *", () => {
    expect(src).not.toMatch(/SELECT\s+\*/i);
  });

  it("25. it never names a secret-bearing column", () => {
    // `tokens.secret_hash` (control-plane.sql:66) and the vault. Rule 4: no
    // token enumeration either — `tokens` is not queried at all.
    expect(src).not.toContain("secret_hash");
    expect(src).not.toContain("pw_hash");
    expect(src).not.toContain("vault_credentials");
    expect(src).not.toMatch(/FROM\s+tokens/i);
  });

  it("26. it does not proxy the provision worker", () => {
    // `GET /grants` is gated by one shared ADMIN_TOKEN and filters only on a
    // caller-supplied ?email= (provision/src/index.ts:590-604). Proxying it
    // would hand an agent admin-plane reach through a read-shaped door.
    expect(src).not.toContain("ADMIN_TOKEN");
    expect(src).not.toContain("/agent-bindings");
    expect(src).not.toMatch(/fetch\(/);
  });
});

describe("015 — \"why did editor@ skip that email?\"", () => {
  it("27. reports the runtime's own recorded reason for a sender-filtered skip", async () => {
    // The cloud runtime records this as a real row:
    //   done("done", { note: `skipped: ${sender} not in allowedSenders` })
    // (services/agent/src/index.ts:172), and `finish()` writes the note to
    // agent_invocations.note (:330-335). So the question IS answerable here.
    const r = await callTool(
      "explain_skip",
      { accountId: "a_eric", emailId: "em_1", bindingName: "editor" },
      eric({
        bindings: [{ id: "b_editor", accountId: "a_eric", name: "editor" }],
        invocations: [
          {
            id: "inv_1",
            accountId: "a_eric",
            bindingId: "b_editor",
            bindingName: "editor",
            status: "done",
            emailId: "em_1",
            note: "skipped: spam@nowhere.example not in allowedSenders",
            result: { note: "skipped: spam@nowhere.example not in allowedSenders" },
          },
        ],
      }),
    );
    expect(r.isError).toBe(false);
    expect(r.out.bindings[0].outcome).toBe("skipped");
    expect(r.out.bindings[0].because).toContain("not in allowedSenders");
  });

  it("28. explains a never-ran binding from the binding row itself", async () => {
    // No invocation exists — but that is not a mystery. `services/ingest`
    // selects `WHERE enabled = 1 AND trigger_on = 'mailbox-delivery'`
    // (index.ts:167-172), so a disabled binding provably produced no row.
    const r = await callTool(
      "explain_skip",
      { accountId: "a_eric", emailId: "em_1" },
      eric({ bindings: [{ id: "b_editor", accountId: "a_eric", name: "editor", enabled: 0 }] }),
    );
    expect(r.out.bindings[0].outcome).toBe("never-ran");
    expect(r.out.bindings[0].because).toMatch(/disabled/);
  });

  it("29. says NO EVIDENCE rather than guessing when nothing was recorded", async () => {
    // The honest answer, and the one this unit was least sure it could give.
    const r = await callTool(
      "explain_skip",
      { accountId: "a_eric", emailId: "em_1" },
      eric({ bindings: [{ id: "b_editor", accountId: "a_eric", name: "editor" }] }),
    );
    expect(r.out.bindings[0].outcome).toBe("no-evidence");
    expect(r.out.bindings[0].because).toMatch(/absence of evidence/);
  });

  it("30. distinguishes 'did not skip — failed' from a skip", async () => {
    const r = await callTool(
      "explain_skip",
      { accountId: "a_eric", emailId: "em_1" },
      eric({
        bindings: [{ id: "b_editor", accountId: "a_eric", name: "editor" }],
        invocations: [
          {
            id: "inv_1",
            accountId: "a_eric",
            bindingId: "b_editor",
            bindingName: "editor",
            status: "failed",
            emailId: "em_1",
            note: "no drafts mailbox",
          },
        ],
      }),
    );
    expect(r.out.bindings[0].outcome).toBe("failed");
    expect(r.out.bindings[0].because).toMatch(/did not skip/);
  });

  it("31. always states what the system structurally cannot tell you", async () => {
    // The homelab runtime returns false on a name mismatch with no note
    // (packages/cli/src/agent.ts:156) and applies no allowedSenders gate at
    // all. Half this question is unanswerable and the tool must say so in the
    // answer, not in a doc.
    const r = await callTool(
      "explain_skip",
      { accountId: "a_eric", emailId: "em_1" },
      eric({ bindings: [{ id: "b_editor", accountId: "a_eric", name: "editor" }] }),
    );
    const limits = JSON.stringify(r.out.limitations);
    expect(limits).toMatch(/homelab runtime/);
    expect(limits).toMatch(/leaves no trace/);
    expect(limits).toMatch(/matched no binding/);
  });

  it("32. invocation_history never returns context_json", async () => {
    const r = await callTool(
      "invocation_history",
      { accountId: "a_eric" },
      eric({
        bindings: [{ id: "b_editor", accountId: "a_eric", name: "editor" }],
        invocations: [
          { id: "inv_1", accountId: "a_eric", bindingId: "b_editor", bindingName: "editor", emailId: "em_1" },
        ],
      }),
    );
    expect(r.out.invocations).toHaveLength(1);
    expect(JSON.stringify(r.out)).not.toContain("secret+tag@bullmoose.cc");
    expect(Object.keys(r.out.invocations[0]).sort()).toEqual([
      "bindingId",
      "bindingName",
      "claimedAt",
      "createdAt",
      "doneAt",
      "emailId",
      "invocationId",
      "note",
      "result",
      "status",
    ]);
  });
});

describe("015 — access_log is grant_audit's first reader", () => {
  const withAudit = (over: Partial<Fixture> = {}): Fixture =>
    eric({
      others: [{ id: "a_allen", address: "allen@bullmoose.cc" }],
      grants: [
        { id: "g_live", grantee: "a_allen", target: "a_eric", scopes: ["read"] },
        // Revoked, therefore tombstoned — the row survives with its scopes.
        {
          id: "g_revoked",
          grantee: "a_allen",
          target: "a_eric",
          scopes: ["mail", "send"],
          revokedAt: 1_700_000_000_000,
        },
      ],
      audit: [
        { grantId: "g_live", principal: "allen@bullmoose.cc", accountId: "a_eric", method: "mcp:contacts_search" },
        { grantId: "g_live", principal: "allen@bullmoose.cc", accountId: "a_eric", method: "mail:read" },
        // requireAccountScopes writes several scopes joined with "+"
        // (methods/common.ts:76) — a shape 015's bread-crumbs did not list.
        { grantId: "g_live", principal: "allen@bullmoose.cc", accountId: "a_eric", method: "mail:draft+delete" },
        // Two DIFFERENT ways a grant stops being live, which this fixture
        // could not tell apart before s03.A. `g_gone` has no row at all;
        // `g_revoked` has a row carrying a tombstone.
        { grantId: "g_gone", principal: "mallory@bullmoose.cc", accountId: "a_eric", method: "contacts:read" },
        { grantId: "g_revoked", principal: "trent@bullmoose.cc", accountId: "a_eric", method: "mail:read" },
      ],
      ...over,
    });

  it("33. parses all three method shapes the repo writes", async () => {
    const r = await callTool("access_log", { accountId: "a_eric" }, withAudit());
    const byTool = r.out.access.find((a: any) => a.surface === "mcp");
    expect(byTool.tool).toBe("contacts_search");
    const single = r.out.access.find((a: any) => a.domain === "mail" && a.scopes.length === 1);
    expect(single.scopes).toEqual(["read"]);
    const multi = r.out.access.find((a: any) => a.scopes?.length === 2);
    expect(multi.domain).toBe("mail");
    expect(multi.scopes).toEqual(["draft", "delete"]);
  });

  it("34. annotates access made under a since-revoked grant — never drops it", async () => {
    // Done-when #5. Audit rows outlive their grant either way, and dropping
    // them would hide exactly the access an operator wants while a dangling id
    // would be a puzzle. What changed since this test was written: s03.A made
    // revocation a TOMBSTONE, so "revoked" and "deleted" are now genuinely
    // different states and this asserts both. The old single
    // "revoked-or-deleted" status could not have distinguished them, and the
    // old note actively told an auditor the scopes were unrecoverable.
    const r = await callTool("access_log", { accountId: "a_eric" }, withAudit());

    // No row at all — not revoked, gone. That means something bypassed the
    // revocation path, which is a louder finding than a normal revocation.
    const gone = r.out.access.find((a: any) => a.grantId === "g_gone");
    expect(gone).toBeDefined();
    expect(gone.grantStatus).toBe("deleted");
    expect(gone.note).toMatch(/gone entirely/);
    expect(gone.principal).toBe("mallory@bullmoose.cc");

    // Tombstoned. The row survives, so the scopes it carried ARE recoverable —
    // this is the case the pre-s03.A note said was impossible.
    const revoked = r.out.access.find((a: any) => a.grantId === "g_revoked");
    expect(revoked).toBeDefined();
    expect(revoked.grantStatus).toBe("revoked");
    expect(revoked.revokedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(revoked.scopesAtAccess).toEqual(["mail", "send"]);
    expect(revoked.note).toMatch(/tombstone/);

    const live = r.out.access.find((a: any) => a.grantId === "g_live");
    expect(live.grantStatus).toBe("live");
    expect(live.note).toBeUndefined();

    // Was permanently 0 before: grant_live counted the tombstone.
    expect(r.out.summary.underRevokedGrants).toBe(2);
  });

  it("34b. a revoked grant is not an answer to \"who can reach me\"", async () => {
    // The defect the s03.E console found and pinned. Enforcement was always
    // right — auth-core's principal.ts filters `revoked_at IS NULL` on the
    // resolution path — so a revoked grant really had stopped working. This
    // surface said otherwise, which is worse than it sounds: these tools exist
    // so a human can check who can reach their mail.
    const r = await callTool("who_can_access", { accountId: "a_eric" }, withAudit());
    const ids = r.out.grants.map((g: any) => g.grantId);
    expect(ids).toContain("g_live");
    expect(ids).not.toContain("g_revoked");
    expect(r.out.grants.every((g: any) => g.live)).toBe(true);
  });

  it("35. windows on (account_id, at) and never crosses accounts", async () => {
    const r = await callTool(
      "access_log",
      { accountId: "a_eric" },
      withAudit({
        audit: [
          { grantId: "g_live", principal: "allen@bullmoose.cc", accountId: "a_eric", method: "mail:read" },
          // Another account's audit row must not appear.
          { grantId: "g_other", principal: "eve@bullmoose.cc", accountId: "a_someone", method: "mail:read" },
          // Outside the window.
          { grantId: "g_live", principal: "old@bullmoose.cc", accountId: "a_eric", method: "mail:read", at: Date.now() - 400 * 86_400_000 },
        ],
      }),
    );
    expect(r.out.summary.principals).toEqual(["allen@bullmoose.cc"]);
  });

  it("36. states that it records DELEGATED attempts, not everything", async () => {
    // The single most misreadable thing about this table: owner access is
    // never logged, and rows are written before the call runs, so an empty
    // result does not mean nothing happened and a row does not mean success.
    const r = await callTool("access_log", { accountId: "a_eric" }, eric());
    expect(r.out.access).toEqual([]);
    const limits = JSON.stringify(r.out.limitations);
    expect(limits).toMatch(/Only DELEGATED access is recorded/);
    expect(limits).toMatch(/ATTEMPTS, not outcomes/);
    expect(limits).toMatch(/No row says WHAT was read/);
  });
});

describe("015 — the tools are declared and reachable", () => {
  it("37. all seven are on the surface, all read-scoped", async () => {
    const req = new Request("https://agent/mcp/analytics", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta() } }),
    });
    const body = (await (await handleMcp(req, world(eric()).env)).json()) as any;
    const names = body.result.tools.map((t: any) => t.name);
    for (const n of [
      "whoami",
      "my_access",
      "who_can_access",
      "my_agents",
      "invocation_history",
      "explain_skip",
      "access_log",
    ]) {
      expect(names, `${n} must be listed`).toContain(n);
    }
  });

  it("38. a token with no `read` capability cannot call them", async () => {
    // The declared read scope has to bite. Since common/027 any write or realm
    // capability implies `read`, so the only token that is genuinely read-less
    // is `admin` — control-plane only, it implies nothing and nothing implies
    // it. (A `["calendar"]` token, by contrast, now DOES satisfy read.)
    const r = await callTool("whoami", { accountId: "a_eric" }, eric({ scopes: ["admin"] }));
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/lacks the "read" scope/);
  });
});
