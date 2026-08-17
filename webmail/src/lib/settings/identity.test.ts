import { describe, expect, it } from "vitest";
import { createDemoBackend } from "../jmap/demo";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import type { Identity } from "../mail/types";
import {
  IDENTITY_WRITABLE,
  SYNTHETIC_IDENTITY_ID,
  deleteVerdict,
  describeIdentityRefusal,
  identityFieldNote,
  identityPatch,
  identityToForm,
  isSynthetic,
  loadIdentitySettings,
  saveIdentity,
} from "./identity";

const ACCOUNT = "acct-fake";

/** A provisioned identity: a real row, undeletable, nothing set yet. */
function stored(over: Partial<Identity> = {}): Identity {
  return {
    id: "id_primary",
    name: "Eric Moore",
    email: "eric@bullmoose.cc",
    replyTo: null,
    bcc: null,
    textSignature: "",
    htmlSignature: "",
    mayDelete: false,
    ...over,
  };
}

/** Exactly what `Identity/get` synthesizes from an empty table (identity.ts:78-95). */
function synthetic(): Identity {
  return stored({ id: SYNTHETIC_IDENTITY_ID, name: "Eric", email: "eric@bullmoose.cc" });
}

describe("which fields a person may actually edit", () => {
  it("mirrors the server's writable list exactly", () => {
    // IDENTITY_WRITABLE at services/jmap/src/methods/identity.ts:33-39. If the
    // server gains a property this is the test that says so.
    expect([...IDENTITY_WRITABLE]).toEqual(["name", "replyTo", "bcc", "textSignature", "htmlSignature"]);
  });

  it("marks email immutable, because the server refuses to change it", () => {
    // validateIdentityPatch: `invalid("email is immutable; destroy the identity
    // and create another")` — identity.ts:478-483.
    expect(identityFieldNote("email")?.status).toBe("immutable");
    expect(identityFieldNote("email")?.note).toMatch(/cannot be changed/i);
  });

  it("marks id and mayDelete server-set, which is what makes a diff mandatory", () => {
    // rejectServerSet (identity.ts:430-437) fails the WHOLE patch if either
    // appears, so `{...identity, name}` is refused every time.
    expect(identityFieldNote("id")?.status).toBe("server-set");
    expect(identityFieldNote("mayDelete")?.status).toBe("server-set");
  });

  it("marks every writable property writable, with no excuse attached", () => {
    for (const property of IDENTITY_WRITABLE) {
      const note = identityFieldNote(property);
      expect(note?.status, property).toBe("writable");
      expect(note?.note, property).toBe("");
    }
  });

  it("counts htmlSignature as writable — unlike the vacation body it looks like", () => {
    // The trap this screen is most likely to fall into: VacationResponse.htmlBody
    // is never stored, Identity.htmlSignature is. Treating them alike in either
    // direction is wrong.
    expect(identityFieldNote("htmlSignature")?.status).toBe("writable");
  });
});

describe("delete is offered only when the server would allow it", () => {
  it("refuses on a provisioned identity, which is every pre-migration row", () => {
    // `UPDATE identities SET may_delete = 0` closes the
    // identities-jmap-properties migration (infra/migrations.mjs:143-148), and
    // Identity/set destroy throws forbidden on !mayDelete (identity.ts:305-312).
    const verdict = deleteVerdict(stored({ mayDelete: false }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/unable to send/);
  });

  it("refuses on the synthesized default, which materialises with may_delete 0", () => {
    // materialise() writes `may_delete: 0` (identity.ts:249).
    expect(deleteVerdict(synthetic()).allowed).toBe(false);
  });

  it("allows one the user added", () => {
    expect(deleteVerdict(stored({ id: "identity_abc", mayDelete: true })).allowed).toBe(true);
  });
});

describe("the synthesized default is named, not hidden", () => {
  it("recognises identity_default", () => {
    expect(isSynthetic(synthetic())).toBe(true);
    expect(isSynthetic(stored())).toBe(false);
  });
});

describe("identityPatch sends a diff, never a snapshot", () => {
  it("sends nothing when nothing changed", () => {
    const original = stored({ name: "Eric Moore", textSignature: "Eric\n" });
    expect(identityPatch(original, identityToForm(original)).patch).toEqual({});
  });

  it("never emits id, email or mayDelete, even though the form was built from them", () => {
    // The whole reason for a diff: rejectServerSet fails the entire update if
    // `id` or `mayDelete` appear, and `email` is refused by name.
    const original = stored();
    const form = { ...identityToForm(original), name: "Eric D. Moore" };
    const { patch } = identityPatch(original, form);
    expect(Object.keys(patch)).toEqual(["name"]);
    expect(patch).not.toHaveProperty("id");
    expect(patch).not.toHaveProperty("email");
    expect(patch).not.toHaveProperty("mayDelete");
  });

  it("carries only the properties that moved", () => {
    const original = stored({ textSignature: "old" });
    const { patch, changed } = identityPatch(original, {
      ...identityToForm(original),
      textSignature: "new",
    });
    expect(patch).toEqual({ textSignature: "new" });
    expect(changed).toEqual(["textSignature"]);
  });

  it("clears a signature with '' rather than dropping the key", () => {
    // identity.test.ts:273 server-side: "clears a signature back to empty rather
    // than treating '' as absent". Omitting the key would leave the old one.
    const original = stored({ textSignature: "Eric\nbullmoose.cc" });
    const { patch } = identityPatch(original, { ...identityToForm(original), textSignature: "" });
    expect(patch).toEqual({ textSignature: "" });
  });

  it("does not trim signatures — a trailing newline is part of one", () => {
    const original = stored({ textSignature: "Eric" });
    const { patch } = identityPatch(original, {
      ...identityToForm(original),
      textSignature: "Eric\n",
    });
    expect(patch).toEqual({ textSignature: "Eric\n" });
  });

  it("parses an address list into RFC 8621 EmailAddress objects", () => {
    const original = stored();
    const { patch } = identityPatch(original, {
      ...identityToForm(original),
      replyTo: "Dana Scully <dana@example.com>, ops@example.com",
    });
    expect(patch.replyTo).toEqual([
      { name: "Dana Scully", email: "dana@example.com" },
      { name: null, email: "ops@example.com" },
    ]);
  });

  it("clears an address list with null, which is what the server stores as unset", () => {
    // addressListJson returns null for null/undefined (identity.ts:401-403).
    const original = stored({ replyTo: [{ name: null, email: "ops@example.com" }] });
    const { patch } = identityPatch(original, { ...identityToForm(original), replyTo: "  " });
    expect(patch).toEqual({ replyTo: null });
  });

  it("round-trips an address list without re-sending it", () => {
    // The formatted display value must parse back to the same thing, or every
    // save re-sends every field and every save burns a state bump.
    const original = stored({
      replyTo: [{ name: "Dana Scully", email: "dana@example.com" }],
      bcc: [{ name: null, email: "archive@example.com" }],
    });
    expect(identityPatch(original, identityToForm(original)).patch).toEqual({});
  });

  it("refuses an address the server's own regex would refuse", () => {
    // Mirror of isEmail (identity.ts:418-423). Without this the save comes back
    // as invalidProperties from three layers away.
    const original = stored();
    const { patch, problems } = identityPatch(original, {
      ...identityToForm(original),
      bcc: "not-an-address",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Bcc/);
    expect(patch).toEqual({});
  });

  it("accepts what the server's LOOSE regex accepts, rather than being stricter", () => {
    // "Rejecting more than that is how a mail system refuses addresses that
    // work" — identity.ts:419-422. A plus-tag and a multi-label domain are fine.
    const original = stored();
    const { problems } = identityPatch(original, {
      ...identityToForm(original),
      replyTo: "eric+ooo@mail.co.uk",
    });
    expect(problems).toEqual([]);
  });

  it("lets the synthesized default be edited, because /set materialises it", () => {
    // The stale claim in sVOL 024 is that these fields can never be written.
    // identity.ts:242-252 writes the row on first patch and then updates it.
    const { patch, problems } = identityPatch(synthetic(), {
      ...identityToForm(synthetic()),
      textSignature: "Eric",
    });
    expect(problems).toEqual([]);
    expect(patch).toEqual({ textSignature: "Eric" });
  });
});

// ── server round trip ─────────────────────────────────────────────────────

function clientWith(handler: (args: Record<string, unknown>) => unknown): FakeJmapClient {
  return new FakeJmapClient({
    handlers: {
      "Identity/get": () => ({ accountId: ACCOUNT, state: "s1", list: [stored()], notFound: [] }),
      "Identity/set": handler as never,
    },
  });
}

describe("loadIdentitySettings", () => {
  it("returns the state string, which the composer's loader throws away", () => {
    const client = clientWith(() => ({}));
    return loadIdentitySettings(client, ACCOUNT).then((settings) => {
      expect(settings.state).toBe("s1");
      expect(settings.identities).toHaveLength(1);
    });
  });
});

describe("saveIdentity", () => {
  it("passes ifInState, so a stale form cannot clobber a concurrent change", async () => {
    // Identity/set DOES compare it (identity.ts:207-210) and throws
    // stateMismatch before writing anything.
    const client = clientWith(() => ({
      accountId: ACCOUNT,
      oldState: "s1",
      newState: "s2",
      updated: { id_primary: null },
      notUpdated: {},
    }));
    await saveIdentity(client, ACCOUNT, "id_primary", { name: "Eric" }, { ifInState: "s1" });
    const args = client.sentBatches.at(-1)?.[0]?.[1] as { ifInState?: string };
    expect(args.ifInState).toBe("s1");
  });

  it("does not send a call at all when the patch is empty", async () => {
    const client = clientWith(() => ({}));
    const result = await saveIdentity(client, ACCOUNT, "id_primary", {}, { ifInState: "s1" });
    expect(result).toEqual({ ok: true, newState: "s1", noop: true });
    expect(client.sentBatches).toHaveLength(0);
  });

  it("reports the new state so the next save guards on a current value", async () => {
    const client = clientWith(() => ({
      accountId: ACCOUNT,
      oldState: "s1",
      newState: "s2",
      updated: { id_primary: null },
      notUpdated: {},
    }));
    const result = await saveIdentity(client, ACCOUNT, "id_primary", { name: "E" }, { ifInState: "s1" });
    expect(result).toEqual({ ok: true, newState: "s2", noop: false });
  });

  it("turns a stale state into an instruction, not a stack trace", async () => {
    const client = clientWith(() => ["error", { type: "stateMismatch" }] as never);
    const result = await saveIdentity(client, ACCOUNT, "id_primary", { name: "E" }, { ifInState: "s0" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("stale");
    expect(result.message).toMatch(/nothing was written/i);
  });

  it("names the scope when the token cannot write identities", async () => {
    // requiredScopesForIdentitySet charges `draft` for an update
    // (identity.ts:133-143).
    const result = describeIdentityRefusal({ type: "forbidden" });
    expect(result.kind).toBe("forbidden");
    expect(result.message).toMatch(/draft/);
  });

  it("keeps the server's own words when a sharee is refused", async () => {
    // "only the account owner manages identities" (identity.ts:203) is more
    // specific than anything we could guess, so it is not overwritten.
    const result = describeIdentityRefusal({
      type: "forbidden",
      description: "only the account owner manages identities",
    });
    expect(result.message).toBe("only the account owner manages identities");
  });

  it("refuses a snapshot the way the real server does", async () => {
    // The demo mirrors rejectServerSet (identity.ts:430-437) so that the
    // diff-not-snapshot rule is enforced somewhere a browser can reach, not
    // only in a unit test of the diff itself.
    const demo = createDemoBackend();
    const result = await saveIdentity(demo.client, ACCOUNT, "id-primary", {
      name: "Eric",
      mayDelete: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.properties).toEqual(["mayDelete"]);
  });

  it("refuses a stale ifInState against the demo too, unlike VacationResponse/set", async () => {
    const demo = createDemoBackend();
    const result = await saveIdentity(
      demo.client,
      ACCOUNT,
      "id-primary",
      { name: "Eric" },
      { ifInState: "wildly-stale" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("stale");
  });

  it("round-trips a real save, which is what /settings?demo=1 drives", async () => {
    const demo = createDemoBackend();
    const before = await loadIdentitySettings(demo.client, ACCOUNT);
    const identity = before.identities[0]!;
    const { patch } = identityPatch(identity, {
      ...identityToForm(identity),
      replyTo: "ops@example.com",
    });
    const saved = await saveIdentity(demo.client, ACCOUNT, identity.id, patch, {
      ifInState: before.state,
    });
    expect(saved.ok).toBe(true);
    const after = await loadIdentitySettings(demo.client, ACCOUNT);
    expect(after.identities[0]?.replyTo).toEqual([{ name: null, email: "ops@example.com" }]);
    // A write that landed must move the state, or the next save guards on a
    // value the server has already left behind.
    expect(after.state).not.toBe(before.state);
  });

  it("separates a per-identity refusal from a refusal of the whole call", async () => {
    const client = clientWith(() => ({
      accountId: ACCOUNT,
      oldState: "s1",
      newState: "s1",
      updated: {},
      notUpdated: {
        id_primary: {
          type: "invalidProperties",
          description: "email is immutable; destroy the identity and create another",
          properties: ["email"],
        },
      },
    }));
    const result = await saveIdentity(client, ACCOUNT, "id_primary", { name: "E" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("invalid");
    expect(result.properties).toEqual(["email"]);
  });
});
