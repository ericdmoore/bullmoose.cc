import { describe, expect, it, vi } from "vitest";

// index.ts imports the provider package, whose own imports use the
// `cloudflare:` scheme Node cannot load — mock it at the module seam. The
// class is only CONSTRUCTED by the default export; authorizeHandler (what
// these tests drive) never touches it.
vi.mock("@cloudflare/workers-oauth-provider", () => ({
  default: class {
    fetch() {
      return new Response("mocked");
    }
  },
}));

import { authorizeHandler, type Env } from "./index.js";
import { assertWorld, signAssertion } from "./webauthn.test.js";

// s33 slice 3, the whole door: an assertion riding the SAME /authorize POST
// the password path uses, through the real handler — two heads, one tail.
// The provider is faked at its narrowest seam (completeAuthorization); the
// signature, challenge, and principal resolution are all real.

const AUTH_REQ = JSON.stringify({ clientId: "c1", redirectUri: "https://app.bullmoose.cc/cb", scope: [] });

function envWith(base: { env: never }): Env {
  return {
    ...(base.env as object),
    MCP_RESOURCE_URI: "https://mcp.bullmoose.cc",
    ISSUER: "https://auth.bullmoose.cc",
    DEV_ACCOUNT_ID: "",
    DEV_TENANT_ID: "",
    DEV_USERNAME: "",
    WEBMAIL_CLIENT_ID: "webmail",
    OAUTH_PROVIDER: {
      completeAuthorization: async () => ({ redirectTo: "https://app.bullmoose.cc/cb?code=ok" }),
    },
  } as unknown as Env;
}

const post = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request("https://auth.bullmoose.cc/authorize", { method: "POST", body: form });
};

describe("passkey sign-in at /authorize", () => {
  it("a real assertion completes the authorization — no password anywhere", async () => {
    const world = await assertWorld();
    const assertion = await signAssertion(world.authn, world.challenge, { counter: 4 });
    const res = await authorizeHandler.fetch(
      post({ decision: "approve", authRequest: AUTH_REQ, scope: "", assertion: JSON.stringify(assertion) }),
      envWith(world),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("app.bullmoose.cc/cb");
  });

  it("a bad assertion re-renders the page with a generic sentence, never a 500", async () => {
    const world = await assertWorld();
    const assertion = await signAssertion(world.authn, world.challenge, { wrongKey: true });
    const res = await authorizeHandler.fetch(
      post({ decision: "approve", authRequest: AUTH_REQ, scope: "", assertion: JSON.stringify(assertion) }),
      envWith(world),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Passkey sign-in did not verify");
  });

  it("the options endpoint answers usernameless — no email in, no list out", async () => {
    const world = await assertWorld();
    const res = await authorizeHandler.fetch(
      new Request("https://auth.bullmoose.cc/webauthn/login/options", { method: "POST" }),
      envWith(world),
    );
    const body = (await res.json()) as { publicKey: { allowCredentials: unknown[]; challenge: string } };
    expect(body.publicKey.allowCredentials).toEqual([]);
    expect(body.publicKey.challenge.length).toBeGreaterThan(20);
  });
});
