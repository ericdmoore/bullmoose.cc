import { beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { describeBinding } from "../../agent/src/introspectTools";
import { HttpConsoleClient } from "../../../webmail/src/lib/console/ConsoleClient";
import { buildAgentView, grantState } from "../../../webmail/src/lib/console/perAgent";
import { buildResourceView, liveAt } from "../../../webmail/src/lib/console/perResource";
import { describeBindingConfig } from "./console";
import worker from "./index";
import type { Env } from "./index";

/**
 * The contract, driven end to end: the REAL `HttpConsoleClient` from
 * `webmail/`, over a `fetch` that is this worker, into the REAL
 * `buildAgentView` / `buildResourceView`.
 *
 * `webmail/src/lib/console/*.test.ts` are demo-fixture-driven by design — the
 * fixture exists to make the hard cases real — but a fixture agrees with itself
 * for free. Nothing there would notice if the server returned `createdAt` as an
 * ISO string (which `015`'s `renderGrant` does, and which would make every
 * point-in-time comparison in `perResource.ts` silently false), or omitted the
 * grantee side of a grant, or filtered tombstones away before the wire. This
 * file is where those would fail.
 *
 * It also pins the two derivations the console MIRRORS rather than imports:
 * `effectiveScopes` (through `buildAgentView`'s answers) and `describeBinding`.
 */

const TENANT = "t_bm";
const ERIC = "eric@bullmoose.cc";
const SITE = "https://app.bullmoose.cc";
const VAULT = "https://agent.example";
const NOW = Date.now();
const DAY = 86_400_000;
const ago = (d: number): number => NOW - d * DAY;

let minted: { id: string; token: string; secretHash: string };
beforeAll(async () => {
  minted = await mintToken();
});

function world(): { env: Env; seen: string[] } {
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: "acct_eric",
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: ERIC,
    displayName: "Eric",
  });
  w.db.seedAccount({
    accountId: "acct_allen",
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: ERIC,
    displayName: "Allen",
  });
  w.db.seedAccount({
    accountId: "acct_dana",
    tenantId: TENANT,
    principalId: "p_dana",
    loginEmail: "dana@example.com",
    displayName: "Dana (contractor)",
  });
  w.db.seed("identities", [
    { id: "id_eric", account_id: "acct_eric", email: ERIC },
    { id: "id_allen", account_id: "acct_allen", email: "allen@bullmoose.cc" },
    { id: "id_dana", account_id: "acct_dana", email: "dana@example.com" },
  ]);
  w.db.seed("tokens", [
    {
      id: minted.id,
      principal_id: "p_eric",
      kind: "bearer",
      secret_hash: minted.secretHash,
      name: "console",
      scopes: JSON.stringify(["mail", "vault"]),
      created_at: 1,
      expires_at: null,
      last_used_at: NOW,
    },
  ]);
  w.db.seed("grants", [
    {
      id: "g_allen_mail",
      tenant_id: TENANT,
      grantee_account_id: "acct_allen",
      target_account_id: "acct_eric",
      scopes: JSON.stringify(["mail", "contacts"]),
      collection: null,
      collection_id: null,
      created_by: "p_eric",
      created_at: ago(120),
      expires_at: null,
      revoked_at: null,
    },
    {
      id: "g_temp_vendors",
      tenant_id: TENANT,
      grantee_account_id: "acct_dana",
      target_account_id: "acct_eric",
      scopes: JSON.stringify(["contacts"]),
      collection: "AddressBook",
      collection_id: "ab_vendors",
      created_by: "p_eric",
      created_at: ago(30),
      expires_at: null,
      revoked_at: ago(4),
    },
  ]);
  w.db.seed("agent_bindings", [
    {
      id: "ab_1",
      account_id: "acct_allen",
      name: "allen",
      trigger_on: "mailbox-delivery",
      sla_seconds: 120,
      enabled: 1,
      config_json: JSON.stringify({ pipeline: "reply", replyMode: "send", persona: "p" }),
    },
  ]);
  w.db.seed("address_books", [
    {
      id: "ab_vendors",
      account_id: "acct_eric",
      name: "VendorsBook",
      created_at: ago(300),
      updated_at: ago(5),
    },
  ]);
  w.db.seed("contact_cards", [
    {
      id: "cc_101",
      account_id: "acct_eric",
      address_book_id: "ab_vendors",
      uid: "u101",
      card_json: "{}",
      name_full: "Sparkling Pools LLC",
      created_at: ago(40),
      updated_at: ago(6),
      last_writer_principal: "allen@bullmoose.cc",
      last_writer_binding: "allen",
      last_writer_invocation: "inv_8",
    },
    {
      id: "cc_102",
      account_id: "acct_eric",
      address_book_id: "ab_vendors",
      uid: "u102",
      card_json: "{}",
      name_full: "Midbury Hardware",
      created_at: ago(40),
      updated_at: ago(5),
    },
  ]);
  w.db.seed("grant_audit", [
    {
      grant_id: "g_temp_vendors",
      principal: "dana@example.com",
      account_id: "acct_eric",
      method: "contacts:contacts",
      at: ago(9),
    },
    {
      grant_id: "none",
      principal: "editor@bullmoose.cc",
      account_id: "acct_eric",
      method: "bureau:fetch:aws-mcp",
      at: ago(2),
    },
  ]);
  return { env: w.env as Env, seen: [] };
}

/** The console's own client, wired to this worker instead of the network. */
function client(env: Env, seen: string[]): HttpConsoleClient {
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    seen.push(req.url);
    return worker.fetch(req, env);
  }) as unknown as typeof fetch;
  return new HttpConsoleClient({
    origins: { vault: VAULT, site: SITE },
    token: minted.token,
    fetch: doFetch,
  });
}

describe("the console client, against the real routes", () => {
  it("addresses the four reads at the site backend, which is what serves them", async () => {
    const { env, seen } = world();
    const c = client(env, seen);
    await c.listAgents();
    await c.listResources("acct_allen");
    for (const url of seen) expect(new URL(url).origin).toBe(SITE);
  });

  it("builds the per-agent view — including the `mail`-is-a-superset answer", async () => {
    const { env, seen } = world();
    const c = client(env, seen);

    const agents = await c.listAgents();
    expect(agents.map((a) => a.accountId)).toEqual(["acct_allen"]);

    const view = buildAgentView(await c.agentDossier(agents[0]!.accountId), NOW);

    // The headline this screen exists for. Nothing NAMES `send`: the token is
    // scoped `mail` + `vault` and the grant is `mail` + `contacts`.
    const send = view.headline.find((h) => h.permission === "send")!;
    expect(send.can).toBe(true);
    expect(send.impliedOnly).toBe(true);
    expect(send.because).toContain("Nothing NAMES");
    // …and it extends to Eric's account through the grant, named by address —
    // which needs the `target` PartyRef the server puts on every grant.
    expect(send.via.map((v) => v.grant.target?.address)).toEqual([ERIC]);

    // A wire that returned ISO timestamps would make this NaN and the whole
    // point-in-time layer quietly wrong.
    const held = view.grantsHeld[0]!;
    expect(typeof held.grant.createdAt).toBe("number");
    expect(grantState(held.grant, NOW)).toBe("live");

    // The binding summary drives the same warnings the MCP surface emits.
    expect(view.bindings[0]!.warnings.join(" ")).toContain("replyMode is SEND");
    // `credentialRefs` is absent on the wire (nothing records them) and the
    // client's `?? []` is what keeps the panel honest rather than empty-looking.
    expect(view.bindings[0]!.credentialRefs).toEqual([]);
  });

  it("builds the forensic view, and the revoked grant answers for the instant it was live", async () => {
    const { env, seen } = world();
    const c = client(env, seen);
    const resources = await c.listResources("acct_allen");
    const vendors = resources.find((r) => r.collectionId === "ab_vendors")!;
    expect(vendors.accountId).toBe("acct_eric");

    // Six days ago: the narrow grant was live (revoked four days ago).
    const then = await c.resourceDossier(vendors, { at: ago(6), since: ago(90) });
    const back = buildResourceView(then, { at: ago(6), since: ago(90) }, NOW);
    const couldThen = back.could.map((c2) => c2.grant.grantId).sort();
    expect(couldThen).toEqual(["g_allen_mail", "g_temp_vendors"]);
    expect(back.could.find((c2) => c2.grant.grantId === "g_temp_vendors")!.stillLive).toBe(false);
    expect(liveAt(then.grants.find((g) => g.grantId === "g_temp_vendors")!, ago(3))).toBe(false);

    // Now: it is gone from the who-could set, without having vanished from the
    // wire — the distinction the tombstone exists to make.
    const now = await c.resourceDossier(vendors, { at: NOW, since: ago(90) });
    const view = buildResourceView(now, { at: NOW, since: ago(90) }, NOW);
    expect(view.could.map((c2) => c2.grant.grantId)).toEqual(["g_allen_mail"]);
    expect(now.grants.map((g) => g.grantId)).toContain("g_temp_vendors");

    // The findings the screen renders, from rows this server produced.
    const kinds = view.findings.map((f) => f.kind);
    // A DAV write with no stamp (common/033) reads as not-captured, not nobody.
    expect(kinds).toContain("not-captured");
    // The Bureau refusal (`grant_id = 'none'`) is called out as a refusal, and
    // is not mistaken for authorized access.
    expect(kinds).toContain("refused-attempt");
    // Dana's card write is attributed to the grant that was live at the time.
    expect(view.findings.some((f) => f.kind === "explained")).toBe(true);
    expect(view.emptyMeans).toBeNull();
  });

  it("names the endpoint when a route refuses, instead of rendering a blank panel", async () => {
    const { env, seen } = world();
    const c = client(env, seen);
    await expect(c.agentDossier("acct_dana")).rejects.toThrow(/not available/);
  });
});

describe("the binding summary does not drift from the MCP surface", () => {
  it("agrees with introspectTools.describeBinding on every shape", () => {
    // Both surfaces answer "will this thing SEND?" and an operator must not get
    // two answers. Mirrored rather than imported (worker boundaries), so the
    // mirror is held by this, not by discipline.
    for (const cfg of [
      "{}",
      "",
      "{not json",
      JSON.stringify({ pipeline: "ledger", replyMode: "draft" }),
      JSON.stringify({ pipeline: "reply", replyMode: "send", persona: "x" }),
      JSON.stringify({ persona: "", allowedSenders: [] }),
      JSON.stringify({ allowedSenders: ["a@b.c", "d@e.f"] }),
      JSON.stringify({ modelAliases: { cheap: [], smart: [] } }),
      JSON.stringify({ replyMode: "SEND" }),
    ]) {
      expect(describeBindingConfig(cfg), cfg).toEqual(describeBinding(cfg));
    }
  });
});
