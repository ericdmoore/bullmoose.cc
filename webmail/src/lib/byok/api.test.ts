import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { detachFromBinding, readByokStatus, revokeKey, sealKey } from "./api";

/**
 * s26 T4 — the BYOK client half.
 *
 * The interesting assertions here are all about the KEY: it goes into exactly
 * one request body, it comes back in nothing, and no refusal path composes a
 * message out of the arguments it was given. A canary is used and the module's
 * whole observable surface is swept for it — the browser-side twin of
 * `providerCredential.test.ts`'s server sweep.
 */

const KEY = "sk-or-v1-CANARY-c81f4a20be7736d5";

/** The same non-vacuous sweep the server suite uses: a full-length hit OR any
 *  prefix down to 8 characters, because a truncated key is not a redaction. */
function assertNoSecret(haystack: unknown, secret: string): void {
  const text = typeof haystack === "string" ? haystack : JSON.stringify(haystack);
  for (let len = secret.length; len >= 8; len--) {
    if (text.includes(secret.slice(0, len))) throw new Error(`the key (or a ${len}-char prefix) leaked`);
  }
}

const STATUS = {
  accountId: "acct_a",
  credentials: [],
  refs: [],
  platformKeyBindings: [],
  keyReadable: false,
  mayWrite: true,
  writeRefusal: null,
  sealableProviders: ["openrouter"],
};

describe("readByokStatus", () => {
  it("calls ProviderCredential/get with just the account", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = new FakeJmapClient({
      handlers: {
        "ProviderCredential/get": (args) => {
          seen.push(args);
          return STATUS;
        },
      },
    });
    const out = await readByokStatus(client, "acct_a");
    expect(out).toEqual({ ok: true, value: STATUS });
    expect(seen[0]).toEqual({ accountId: "acct_a" });
  });

  it("a refusal comes back as the SERVER's sentence, verbatim", async () => {
    // The refusals are the most educational text on the page: "this session
    // does not carry the vault scope" teaches where the boundary is, and a
    // paraphrase would teach nothing.
    const client = new FakeJmapClient({
      handlers: {
        "ProviderCredential/get": () => {
          throw new Error("forbidden: provider credentials are the account owner's");
        },
      },
    });
    expect(await readByokStatus(client, "acct_a")).toEqual({
      ok: false,
      message: "forbidden: provider credentials are the account owner's",
    });
  });
});

describe("sealKey — the key passes through and is not kept", () => {
  it("puts the key in exactly ONE request body and nowhere else", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = new FakeJmapClient({
      handlers: {
        "ProviderCredential/set": (args) => {
          seen.push(args);
          return {
            accountId: "acct_a",
            action: "seal",
            credRef: "openrouter",
            provider: "openrouter",
            allow: "https://openrouter.ai",
            created: true,
            rotated: false,
            grantId: "bg_1",
            bindings: [{ id: "ab_1", name: "extractor" }],
            keyReadable: false,
          };
        },
      },
    });
    const out = await sealKey(client, "acct_a", { provider: "openrouter" }, KEY);
    expect(out.ok).toBe(true);

    // The one place it is allowed to be.
    expect(seen).toHaveLength(1);
    expect((seen[0]!.seal as { key: string }).key).toBe(KEY);
    // …and nowhere in what comes back.
    assertNoSecret(out, KEY);
  });

  it("the sweep bites, so the assertion above is not vacuous", () => {
    expect(() => assertNoSecret({ ok: true, value: { echoed: KEY } }, KEY)).toThrow(/leaked/);
    expect(() => assertNoSecret({ ok: true, value: { hint: KEY.slice(0, 10) } }, KEY)).toThrow(/10-char prefix/);
  });

  it("a REFUSAL does not quote the key back — the message is the server's alone", async () => {
    const client = new FakeJmapClient({
      handlers: {
        "ProviderCredential/set": () => {
          throw new Error('forbidden: token lacks the "vault" scope');
        },
      },
    });
    const out = await sealKey(client, "acct_a", { provider: "openrouter" }, KEY);
    expect(out).toEqual({ ok: false, message: 'forbidden: token lacks the "vault" scope' });
    assertNoSecret(out, KEY);
  });

  it("optional arguments are OMITTED rather than sent as undefined", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = new FakeJmapClient({
      handlers: {
        "ProviderCredential/set": (args) => {
          seen.push(args);
          return {};
        },
      },
    });
    await sealKey(client, "acct_a", { provider: "openrouter" }, KEY);
    expect(Object.keys(seen[0]!.seal as object).sort()).toEqual(["key", "provider"]);

    await sealKey(client, "acct_a", { provider: "openrouter", bindingId: "ab_1", expiresDays: 30 }, KEY);
    expect(Object.keys(seen[1]!.seal as object).sort()).toEqual(["bindingId", "expiresDays", "key", "provider"]);
  });
});

describe("detach and revoke — one verb per call, and their meanings kept distinct", () => {
  it("detach names ONE binding and asks for nothing else", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = new FakeJmapClient({
      handlers: {
        "ProviderCredential/set": (args) => {
          seen.push(args);
          return {
            detached: [],
            credentialDeleted: false,
            grantRevoked: false,
            refs: [],
            credentials: [],
            platformKeyBindings: [],
          };
        },
      },
    });
    await detachFromBinding(client, "acct_a", "ab_1", "openrouter");
    expect(seen[0]).toEqual({ accountId: "acct_a", detach: { bindingId: "ab_1", provider: "openrouter" } });
    expect(seen[0]!.revoke).toBeUndefined();
    expect(seen[0]!.seal).toBeUndefined();
  });

  it("revoke names the credential, and the response's `credentialDeleted: false` rides through", async () => {
    // The one thing a person could reasonably assume and be wrong about: the
    // sealed value is NOT destroyed. It is on the wire so the client cannot
    // drift from the server's meaning of the verb.
    const client = new FakeJmapClient({
      handlers: {
        "ProviderCredential/set": () => ({
          detached: [{ id: "ab_1", name: "extractor", provider: "openrouter", credRef: "openrouter" }],
          credentialDeleted: false,
          grantRevoked: true,
          refs: [],
          credentials: [],
          platformKeyBindings: [{ id: "ab_1", name: "extractor", provider: "openrouter" }],
        }),
      },
    });
    const out = await revokeKey(client, "acct_a", "openrouter");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.credentialDeleted).toBe(false);
    expect(out.value.grantRevoked).toBe(true);
    // The recomputed status rides back with the mutation — there is no
    // /changes for this collection, so the response IS the reconcile.
    expect(out.value.platformKeyBindings).toEqual([{ id: "ab_1", name: "extractor", provider: "openrouter" }]);
  });
});
