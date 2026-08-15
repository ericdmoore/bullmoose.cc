import { beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { issueInvocationToken } from "@bullmoose/auth-core/invocation";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { handleMcp } from "./mcp";

/**
 * s10 T1 — the governed bound over MCP, end to end through `handleMcp`.
 *
 * Two distinct refusals, and the difference matters:
 *
 *  1. write_policy — the STORE's chokepoint: every `callJmap` write carries
 *     agent context (the bridge is the agent tool surface), so a governed
 *     book refuses it exactly as it refuses agent JMAP/DAV writes.
 *  2. the self-write rule — enforced HERE, where recipients_book_id is
 *     legible: a book that governs a binding's outbound reach is refused to
 *     MCP contact writes even when its write_policy was never flipped, so a
 *     misconfigured book is still not self-widenable.
 *
 * s17 (d) rule 1 changed HOW an agent reaches this surface, not what it finds
 * there: an `agent`-marked bearer may no longer call a tool with its device
 * token, so every call below authenticates with the `bmi_` token a claim
 * minted. That is worth more than the old shape, not less — it proves the
 * marker survives the invocation path (`INVOCATION_STANDING_SCOPES` carries
 * `agent`, so `isAgentPrincipal` is true and the chokepoint fires) rather than
 * riding on a device token's scope list. The agent-marked device token is still
 * seeded, and `invocationToken.test.ts` asserts one is REFUSED at this surface.
 */

const V = "2026-07-28";
const TENANT = "t_bm";
const ACCOUNT = "a_photos";
const GOV = "ab_gov";
const REFD = "ab_referenced_but_open";
const OPEN = "ab_plain";

let minted: { id: string; token: string; secretHash: string };
beforeAll(async () => {
  minted = await mintToken();
});

interface World {
  w: FakeWorker;
  /** The `bmi_` credential every call below presents (s17 (d) rule 1). */
  token: string;
}

async function world(): Promise<World> {
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: ACCOUNT,
    tenantId: TENANT,
    principalId: "p_photos",
    loginEmail: "photos@bullmoose.cc",
    displayName: "Photos",
  });
  w.db.seed("tokens", [
    {
      id: minted.id,
      principal_id: "p_photos",
      kind: "bearer",
      secret_hash: minted.secretHash,
      name: "photos-runtime",
      scopes: JSON.stringify(["read", "contacts", "agent"]),
      created_at: 1,
      expires_at: null,
      last_used_at: Date.now(),
    },
  ]);
  const book = (id: string, writePolicy: string, isDefault = 0) => ({
    id,
    account_id: ACCOUNT,
    name: id,
    sort_order: 0,
    is_default: isDefault,
    is_subscribed: 1,
    ctag: 1,
    created_at: 1,
    updated_at: 1,
    write_policy: writePolicy,
  });
  w.db.seed("address_books", [
    book(OPEN, "open", 1),
    book(GOV, "governed"),
    // The misconfiguration case: referenced as a governing book, never
    // flipped to 'governed'. The self-write rule must still refuse it.
    book(REFD, "open"),
  ]);
  w.db.seed("contact_cards", [
    {
      id: "cc_in_refd",
      account_id: ACCOUNT,
      address_book_id: REFD,
      uid: "u_in_refd",
      card_json: JSON.stringify({ uid: "u_in_refd", emails: { e: { address: "bob@x.com" } } }),
      created_at: 1,
      updated_at: 1,
    },
  ]);
  w.db.seed("agent_bindings", [
    {
      id: "bind_photos",
      account_id: ACCOUNT,
      name: "photos",
      config_json: "{}",
      recipients_book_id: REFD,
    },
  ]);
  // An ordinary (non-Job) invocation this binding is mid-flight on, claimed —
  // which is exactly the state the mint requires and the only state in which an
  // agent has a tool surface at all.
  w.db.seed("agent_invocations", [
    {
      id: "inv_photos",
      account_id: ACCOUNT,
      binding_id: "bind_photos",
      binding_name: "photos",
      status: "running",
      context_json: "{}",
      created_at: 1,
    },
  ]);
  const token = await issueInvocationToken(w.env.DB, {
    invocationId: "inv_photos",
    accountId: ACCOUNT,
  });
  return { w, token: token! };
}

async function callTool(
  { w, token }: World,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const req = new Request("https://agent/mcp/analytics", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
      "MCP-Protocol-Version": V,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": V,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const res = await handleMcp(req, w.env);
  const body = (await res.json()) as {
    result?: { content: Array<{ text: string }>; isError?: boolean };
  };
  return { isError: body.result?.isError === true, text: body.result?.content[0]?.text ?? "" };
}

describe("MCP contact writes against governed books", () => {
  it("contacts_create_card into a write_policy 'governed' book is refused via the chokepoint", async () => {
    const s = await world();
    const r = await callTool(s, "contacts_create_card", {
      accountId: ACCOUNT,
      addressBookId: GOV,
      name: "Eve",
      emails: ["eve@evil.com"],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/proposal/i);
    expect(s.w.db.count("contact_cards", "address_book_id = ?", GOV)).toBe(0);
  });

  it("the SELF-WRITE rule: a recipients_book_id book is refused even though its policy is 'open'", async () => {
    const s = await world();
    const r = await callTool(s, "contacts_create_card", {
      accountId: ACCOUNT,
      addressBookId: REFD,
      name: "Eve",
      emails: ["eve@evil.com"],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/governs which recipients agent "photos" may email/);
    expect(s.w.db.count("contact_cards", "address_book_id = ?", REFD)).toBe(1); // only the seed
  });

  it("update and delete of a card inside the governing book are refused the same way", async () => {
    const s = await world();
    const upd = await callTool(s, "contacts_update_card", {
      accountId: ACCOUNT,
      cardId: "cc_in_refd",
      emails: ["eve@evil.com"],
    });
    expect(upd.isError).toBe(true);
    expect(upd.text).toMatch(/governing book/);

    const del = await callTool(s, "contacts_delete_card", {
      accountId: ACCOUNT,
      cardId: "cc_in_refd",
    });
    expect(del.isError).toBe(true);
    expect(s.w.db.count("contact_cards", "id = 'cc_in_refd'")).toBe(1);
  });

  it("moving a card INTO the governing book is refused too", async () => {
    const s = await world();
    // A card in the plain book, then an update that names REFD as target.
    const created = await callTool(s, "contacts_create_card", {
      accountId: ACCOUNT,
      addressBookId: OPEN,
      name: "Pal",
      emails: ["pal@x.com"],
    });
    expect(created.isError).toBe(false);
    const id = (JSON.parse(created.text) as { id: string }).id;
    const moved = await callTool(s, "contacts_update_card", {
      accountId: ACCOUNT,
      cardId: id,
      addressBookId: REFD,
    });
    expect(moved.isError).toBe(true);
    expect(moved.text).toMatch(/governing book|governs which recipients/);
  });

  it("ordinary open books stay writable — the agent keeps its working contacts", async () => {
    const s = await world();
    const r = await callTool(s, "contacts_create_card", {
      accountId: ACCOUNT,
      addressBookId: OPEN,
      name: "Pal",
      emails: ["pal@x.com"],
    });
    expect(r.isError).toBe(false);
    expect(s.w.db.count("contact_cards", "address_book_id = ?", OPEN)).toBe(1);
  });
});
