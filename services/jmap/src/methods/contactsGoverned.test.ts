import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerContactsMethods } from "./contacts";
import type { RequestContext } from "./common";

/**
 * s10 T1 — the governed-book bound at the JMAP front door.
 *
 * The chokepoint lives in the Mailstore; these drive the REAL registered
 * `ContactCard/set` handler end-to-end to prove two things a store unit test
 * cannot: (1) an agent-marked principal is refused THROUGH the method — the
 * refusal surfaces as a proper SetError, not a serverFail or a 200; (2) a
 * human principal on the same book writes through, so the gate discriminates
 * on the writer, not on the surface.
 */

const ACCOUNT = "a_eric";
const GOV = "ab_gov";
const OPEN = "ab_open";

function harness(scopes: string[] = ["contacts"]) {
  const w = fakeEnv();
  w.db.seed("address_books", [
    {
      id: OPEN,
      account_id: ACCOUNT,
      name: "Contacts",
      sort_order: 0,
      is_default: 1,
      is_subscribed: 1,
      ctag: 1,
      created_at: 1,
      updated_at: 1,
      write_policy: "open",
    },
    {
      id: GOV,
      account_id: ACCOUNT,
      name: "photos@ may email",
      sort_order: 0,
      is_default: 0,
      is_subscribed: 1,
      ctag: 1,
      created_at: 1,
      updated_at: 1,
      write_policy: "governed",
    },
  ]);
  w.db.seed("contact_cards", [
    {
      id: "cc_seed",
      account_id: ACCOUNT,
      address_book_id: GOV,
      uid: "u_seed",
      card_json: JSON.stringify({ uid: "u_seed", emails: { e: { address: "bob@good.com" } } }),
      created_at: 1,
      updated_at: 1,
    },
  ]);

  const registry = new MethodRegistry<RequestContext>();
  registerContactsMethods(registry);
  const set = registry.get("ContactCard/set")!;

  const ctxFor = (tokenScopes: string[]): RequestContext => ({
    env: w.env,
    principal: {
      username: "someone@login.example",
      scopes: tokenScopes,
      accounts: [{ accountId: ACCOUNT, tenantId: "t_bm", name: "Eric" }],
    },
  });

  type SetResult = {
    created: Record<string, Record<string, unknown>>;
    notCreated: Record<string, { type: string; description?: string }>;
    updated: Record<string, null>;
    notUpdated: Record<string, { type: string; description?: string }>;
    destroyed: string[];
    notDestroyed: Record<string, { type: string; description?: string }>;
  };
  const call = (args: Record<string, unknown>, tokenScopes = scopes) =>
    set({ accountId: ACCOUNT, ...args }, ctxFor(tokenScopes)) as Promise<SetResult>;

  return { w, call };
}

const cardSpec = (bookId: string, address: string) => ({
  name: { full: "Somebody" },
  emails: { e1: { address } },
  addressBookIds: { [bookId]: true },
});

// The agent marker rides the token: same account, same scopes plus "agent".
const AGENT_SCOPES = ["contacts", "agent"];

describe("ContactCard/set against a governed book", () => {
  it("refuses an agent-marked principal's create with a forbidden SetError naming the proposal path", async () => {
    const h = harness();
    const res = await h.call({ create: { c1: cardSpec(GOV, "eve@evil.com") } }, AGENT_SCOPES);
    expect(res.created).toEqual({});
    expect(res.notCreated.c1!.type).toBe("forbidden");
    expect(res.notCreated.c1!.description).toMatch(/proposal/i);
    // Nothing landed, and no chain row claims it did.
    expect(h.w.db.count("contact_cards", "address_book_id = ? AND id != 'cc_seed'", GOV)).toBe(0);
    expect(h.w.db.count("book_membership_log")).toBe(0);
  });

  it("refuses the agent's update and destroy of an existing governed card", async () => {
    const h = harness();
    const upd = await h.call(
      { update: { cc_seed: { "emails/e/address": "eve@evil.com" } } },
      AGENT_SCOPES,
    );
    expect(upd.notUpdated.cc_seed!.type).toBe("forbidden");

    const del = await h.call({ destroy: ["cc_seed"] }, AGENT_SCOPES);
    expect(del.notDestroyed.cc_seed!.type).toBe("forbidden");
    expect(h.w.db.count("contact_cards", "id = 'cc_seed'")).toBe(1);
  });

  it("the same create by an UNMARKED (human) principal writes through, with a chain row", async () => {
    const h = harness();
    const res = await h.call({ create: { c1: cardSpec(GOV, "carol@good.com") } });
    expect(Object.keys(res.created)).toEqual(["c1"]);
    const log = h.w.db.query<{ event: string; address: string; actor: string }>(
      `SELECT event, address, actor FROM book_membership_log WHERE book_id = ?`,
      GOV,
    );
    expect(log).toEqual([
      { event: "added", address: "carol@good.com", actor: "someone@login.example" },
    ]);
  });

  it("the agent still writes OPEN books freely — the bound is per-book, not per-writer", async () => {
    const h = harness();
    const res = await h.call({ create: { c1: cardSpec(OPEN, "pal@x.com") } }, AGENT_SCOPES);
    expect(Object.keys(res.created)).toEqual(["c1"]);
  });
});
