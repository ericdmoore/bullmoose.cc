import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import type { Principal } from "@bullmoose/auth-core/principal";
import { handleDav } from "./dav";
import type { Env } from "./index";

/**
 * s10 T1 — the governed bound holds over CardDAV.
 *
 * "A book governed by approval but writable over CardDAV is not governed"
 * (devPlan): the chokepoint lives in the Mailstore, and these drive the REAL
 * dispatcher — handleDav → requireWrite → store — to prove the DAV path
 * cannot route around it, and that the refusal is a 403 the client can show,
 * not a 500.
 */

const ACCOUNT = "a_eric";
const TENANT = "t_bm";
const GOV = "abgov";

const VCF = [
  "BEGIN:VCARD",
  "VERSION:4.0",
  "UID:u_eve",
  "FN:Eve",
  "EMAIL:eve@evil.com",
  "END:VCARD",
  "",
].join("\r\n");

function world() {
  const w = fakeEnv();
  w.db.seed("address_books", [
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
      id: "ccseed",
      account_id: ACCOUNT,
      address_book_id: GOV,
      uid: "u_seed",
      card_json: JSON.stringify({ uid: "u_seed", emails: { e: { address: "bob@good.com" } } }),
      created_at: 1,
      updated_at: 1,
    },
  ]);
  return w;
}

const principal = (scopes: string[]): Principal => ({
  username: "someone@login.example",
  scopes,
  accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
});

const AGENT = principal(["mail", "contacts", "agent"]);
const HUMAN = principal(["mail", "contacts"]);

async function dav(
  w: ReturnType<typeof fakeEnv>,
  p: Principal,
  method: string,
  path: string,
  body?: string,
): Promise<Response> {
  const url = new URL(`https://dav.bullmoose.cc${path}`);
  const request = new Request(url, {
    method,
    ...(body !== undefined ? { body, headers: { "content-type": "text/vcard" } } : {}),
  });
  return handleDav(request, url, w.env as Env, p);
}

describe("CardDAV against a governed book", () => {
  it("PUT of a new card by an agent-marked token is 403, and nothing lands", async () => {
    const w = world();
    const res = await dav(w, AGENT, "PUT", `/dav/addressbooks/${ACCOUNT}/${GOV}/eve.vcf`, VCF);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/proposal/i);
    expect(w.db.count("contact_cards", "account_id = ?", ACCOUNT)).toBe(1);
    expect(w.db.count("book_membership_log")).toBe(0);
  });

  it("DELETE of a governed card by an agent-marked token is 403 — narrowing is a write too", async () => {
    const w = world();
    const res = await dav(w, AGENT, "DELETE", `/dav/addressbooks/${ACCOUNT}/${GOV}/ccseed`);
    expect(res.status).toBe(403);
    expect(w.db.count("contact_cards", "id = 'ccseed'")).toBe(1);
  });

  it("the same PUT by a human token is 201, with a chain row naming the human", async () => {
    const w = world();
    const res = await dav(w, HUMAN, "PUT", `/dav/addressbooks/${ACCOUNT}/${GOV}/eve.vcf`, VCF);
    expect(res.status).toBe(201);
    const log = w.db.query<{ event: string; address: string; actor: string }>(
      `SELECT event, address, actor FROM book_membership_log WHERE book_id = ?`,
      GOV,
    );
    expect(log).toEqual([
      { event: "added", address: "eve@evil.com", actor: "someone@login.example" },
    ]);
  });
});
