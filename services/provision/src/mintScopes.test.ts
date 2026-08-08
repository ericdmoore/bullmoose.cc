import { describe, expect, it } from "vitest";
import worker from "./index";

// POST /tokens on the operator plane. It had the same `body.scopes ??
// ["mail"]` default as the CLI and the jmap worker, plus a gap of its own:
// no validation whatsoever, so an operator (or a script with the admin
// token) could mint `["vault"]`, `["admin"]` or `["tpyo"]` and the string
// went into the row verbatim. GRANTABLE_SCOPES in the same file has always
// validated grants; tokens had no equivalent.
//
// Driven through the worker's fetch so the admin-token check, the route
// table and the handler are all real.

const ADMIN_TOKEN = "admin-secret";
const EMAIL = "hermes@bullmoose.cc";

function harness(principalExists = true) {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async first() {
        return sql.includes("FROM principals WHERE login_email") && principalExists
          ? { id: "p_hermes" }
          : null;
      },
      async all() {
        return { results: [] };
      },
      async run() {
        writes.push({ sql, args: bound });
        return { meta: { changes: 1 } };
      },
    };
  };
  const env = {
    DB: { prepare } as unknown as D1Database,
    ADMIN_TOKEN,
  } as unknown as Parameters<typeof worker.fetch>[1];

  const post = (body: Record<string, unknown>, token = ADMIN_TOKEN) =>
    worker.fetch(
      new Request("https://provision.bullmoose.cc/tokens", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
  return { post, writes };
}

/** The `scopes` column of the single INSERT INTO tokens, parsed. */
function insertedScopes(writes: Array<{ sql: string; args: unknown[] }>): string[] {
  const w = writes.filter((x) => x.sql.includes("INSERT INTO tokens"));
  expect(w).toHaveLength(1);
  return JSON.parse(String(w[0]?.args[4]));
}

describe("POST /tokens (provision) — explicit scopes required", () => {
  it("refuses a mint that omits scopes (was: silently ['mail'])", async () => {
    const h = harness();
    const res = await h.post({ email: EMAIL, name: "hermes-bridge" });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("required"),
    });
    expect(h.writes).toHaveLength(0);
  });

  it("mints exactly what was asked for", async () => {
    const h = harness();
    const res = await h.post({ email: EMAIL, name: "bridge", scopes: ["read", "send"] });
    expect(res.status).toBe(200);
    expect(insertedScopes(h.writes)).toEqual(["read", "send"]);
  });

  it("validates the vocabulary — an invented scope no longer reaches the row", async () => {
    const h = harness();
    const res = await h.post({ email: EMAIL, name: "bridge", scopes: ["read", "supervault"] });
    expect(res.status).toBe(400);
    expect((await res.text()).includes("supervault")).toBe(true);
    expect(h.writes).toHaveLength(0);
  });

  it("still allows `admin` — this is the one plane that may mint it", async () => {
    const h = harness();
    const res = await h.post({ email: EMAIL, name: "ops", scopes: ["admin"] });
    expect(res.status).toBe(200);
    expect(insertedScopes(h.writes)).toEqual(["admin"]);
  });

  it("allows realm scopes an operator legitimately needs", async () => {
    const h = harness();
    const res = await h.post({ email: EMAIL, name: "agent", scopes: ["mail", "vault"] });
    expect(res.status).toBe(200);
    expect(insertedScopes(h.writes)).toEqual(["mail", "vault"]);
  });

  it("refuses an empty scope array", async () => {
    const h = harness();
    expect((await h.post({ email: EMAIL, name: "x", scopes: [] })).status).toBe(400);
    expect(h.writes).toHaveLength(0);
  });

  it("still requires the admin token", async () => {
    const h = harness();
    const res = await h.post({ email: EMAIL, name: "x", scopes: ["read"] }, "wrong");
    expect(res.status).toBe(401);
    expect(h.writes).toHaveLength(0);
  });

  it("still 404s an unknown principal", async () => {
    const h = harness(false);
    const res = await h.post({ email: EMAIL, name: "x", scopes: ["read"] });
    expect(res.status).toBe(404);
    expect(h.writes).toHaveLength(0);
  });
});
