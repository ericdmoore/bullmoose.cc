import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerIdentityMethods, requiredScopesForIdentitySet } from "./identity";
import { registerSubmissionMethods } from "./submission";
import type { RequestContext } from "./common";

// sVOL 006. Before this, signatures and send-as were unreachable on EVERY
// surface: `identities` had four columns, `Identity/get` hardcoded replyTo,
// bcc and both signatures, and nothing in the repository wrote an identity row
// after account creation.
//
// These drive the REGISTERED methods end to end — requireAccountScopes →
// Mailstore → AccountDO commit — over @bullmoose/test-fakes: real SQLite on
// the live schema (so the new columns are the deployed columns, and the
// UNIQUE (account_id, email) index really fires) and the REAL AccountDO (so
// the changelog is the thing under test, not a canned `{newState}`).
//
// The assertions that matter, in order of what they catch:
//
//   1. A write must appear in Identity/CHANGES and must move the state. A row
//      that lands in D1 without commitChanges reads back perfectly on a direct
//      Identity/get and is invisible to every state-caching client — the
//      signature is set and nobody ever sees it (_context.md §3). A passing
//      /get proves nothing on its own.
//   2. The synthesized `identity_default` must stay consistent between
//      Identity/get and EmailSubmission/set. Forking that logic is exactly
//      .feedback/fromCodex/002, where submitOne accepted `identity_default`
//      unconditionally while /get only offered it on an empty table — letting
//      a client send as its LOGIN email. So the submission method is
//      registered alongside here and asked directly.
//   3. Creating an identity on a domain the tenant does not own must be
//      refused and must write nothing.

const ACCOUNT = "a_eric";
const TENANT = "t_bm";
const LOGIN_EMAIL = "eric@login.example";
const PRIMARY = "eric@bullmoose.cc";

const DRAFTS_MB = {
  id: "mb_drafts",
  parent_id: null,
  name: "Drafts",
  role: "drafts",
  sort_order: 1,
};

const draftRow = {
  id: "e_1",
  blob_id: "b_1",
  thread_id: "t_1",
  message_id: "<m1@bullmoose.cc>",
  in_reply_to: null,
  subject: "hi",
  from_json: JSON.stringify([{ email: PRIMARY }]),
  to_json: JSON.stringify([{ email: "someone@example.com" }]),
  cc_json: "[]",
  bcc_json: "[]",
  preview: "hi",
  size: 42,
  received_at: 1,
  has_attachment: 0,
  attachments_json: "[]",
};

interface Fixture {
  /** Rows in `identities`. Omit for the empty-table (synthesis) case. */
  identities?: Array<Record<string, unknown>>;
  /** Domains this tenant owns, with their status. Defaults to one active. */
  domains?: Array<{ domain: string; status: string; tenant_id?: string }>;
  scopes?: string[];
  /** Reach the account through a grant instead of owning it. */
  granted?: boolean;
}

interface SetResponse {
  oldState: string;
  newState: string;
  created: Record<string, Record<string, unknown>>;
  notCreated: Record<string, { type: string; description?: string; properties?: string[] }>;
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string; properties?: string[] }>;
  destroyed: string[];
  notDestroyed: Record<string, { type: string; description?: string; properties?: string[] }>;
}

interface GetResponse {
  state: string;
  list: Array<Record<string, unknown>>;
  notFound: string[];
}

function harness(fx: Fixture = {}) {
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: ACCOUNT,
    tenantId: TENANT,
    loginEmail: LOGIN_EMAIL,
    displayName: "Eric",
  });
  const domains = fx.domains ?? [{ domain: "bullmoose.cc", status: "active" }];
  // domains.tenant_id REFERENCES tenants(id) and foreign keys are enforced, so
  // a rival tenant has to exist before its domain can.
  for (const d of domains) {
    if (d.tenant_id && d.tenant_id !== TENANT) {
      w.db.seedAccount({ accountId: `a_${d.tenant_id}`, tenantId: d.tenant_id });
    }
  }
  w.db.seed(
    "domains",
    domains.map((d) => ({
      domain: d.domain,
      tenant_id: d.tenant_id ?? TENANT,
      status: d.status,
      created_at: 1,
    })),
  );
  if (fx.identities) {
    w.db.seed(
      "identities",
      fx.identities.map((r) => ({ account_id: ACCOUNT, ...r })),
    );
  }
  // The draft EmailSubmission/set needs, so "can this account still send?" is
  // a real relayed envelope rather than an inference.
  w.db.seed("mailboxes", [{ account_id: ACCOUNT, ...DRAFTS_MB }]);
  w.db.seed("emails", [{ account_id: ACCOUNT, ...draftRow }]);
  w.db.seed("email_mailboxes", [
    { account_id: ACCOUNT, email_id: "e_1", mailbox_id: DRAFTS_MB.id },
  ]);
  w.db.seed("email_keywords", [{ account_id: ACCOUNT, email_id: "e_1", keyword: "$draft" }]);

  const registry = new MethodRegistry<RequestContext>();
  registerIdentityMethods(registry);
  registerSubmissionMethods(registry);

  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: LOGIN_EMAIL,
      scopes: fx.scopes ?? ["mail"],
      accounts: [
        {
          accountId: ACCOUNT,
          tenantId: TENANT,
          name: "Eric",
          ...(fx.granted
            ? {
                granted: [
                  { grantId: "g_1", scopes: ["mail"], collection: null, collectionId: null },
                ],
              }
            : {}),
        },
      ],
    },
  };

  const set = (args: Record<string, unknown>) =>
    registry.get("Identity/set")!(
      { accountId: ACCOUNT, ...args },
      ctx,
    ) as Promise<unknown> as Promise<SetResponse>;
  const get = (args: Record<string, unknown> = {}) =>
    registry.get("Identity/get")!(
      { accountId: ACCOUNT, ids: null, ...args },
      ctx,
    ) as Promise<unknown> as Promise<GetResponse>;
  const changes = (sinceState: string) =>
    registry.get("Identity/changes")!(
      { accountId: ACCOUNT, sinceState },
      ctx,
    ) as Promise<unknown> as Promise<{ created: string[]; updated: string[]; destroyed: string[] }>;
  /** Send the seeded draft as `identityId`. Returns the relayed envelopes. */
  const submit = async (identityId: string) => {
    const res = (await registry.get("EmailSubmission/set")!(
      {
        accountId: ACCOUNT,
        create: {
          s: { emailId: "e_1", identityId, envelope: { rcptTo: [{ email: "x@example.com" }] } },
        },
      },
      ctx,
    )) as unknown as SetResponse;
    return res;
  };

  const rows = () =>
    w.db.query<Record<string, unknown>>(`SELECT * FROM identities WHERE account_id = ?`, ACCOUNT);

  return { set, get, changes, submit, rows, relayCalls: w.submit.calls, w };
}

const primaryRow = (over: Record<string, unknown> = {}) => ({
  id: "id_primary",
  email: PRIMARY,
  name: "Eric",
  may_delete: 0,
  ...over,
});

// ---- the assertion that catches a skipped commitChanges ----------------

describe("Identity/set commits the write choreography", () => {
  it("reports a signature update through Identity/changes and moves the state", async () => {
    const h = harness({ identities: [primaryRow()] });
    const before = (await h.get()).state;

    const res = await h.set({ update: { id_primary: { textSignature: "-- Eric" } } });

    expect(res.notUpdated).toEqual({});
    expect(res.updated).toEqual({ id_primary: null });
    // The state actually moved...
    expect(res.newState).not.toBe(res.oldState);
    expect((await h.get()).state).toBe(res.newState);
    // ...and the changelog names the id. THIS is the assertion a raw
    // `UPDATE identities SET ...` passes /get but fails here.
    expect(await h.changes(before)).toMatchObject({ updated: ["id_primary"] });
  });

  it("reports a create and a destroy through Identity/changes", async () => {
    const h = harness({ identities: [primaryRow()] });
    const before = (await h.get()).state;

    const made = await h.set({ create: { c1: { email: "sales@bullmoose.cc", name: "Sales" } } });
    const newId = made.created.c1!.id as string;
    const afterCreate = made.newState;

    const gone = await h.set({ destroy: [newId] });

    expect(await h.changes(before)).toMatchObject({ created: [], destroyed: [] });
    // created-then-destroyed collapses to nothing across the whole window
    // (RFC 8620 §5.2), so ask each half separately.
    expect(await h.changes(afterCreate)).toMatchObject({ destroyed: [newId] });
    expect(gone.destroyed).toEqual([newId]);
  });

  it("does not burn a state bump on a /set that changed nothing", async () => {
    const h = harness({ identities: [primaryRow()] });
    const res = await h.set({});
    expect(res.newState).toBe(res.oldState);
  });

  it("refuses the whole call on a stale ifInState, writing nothing", async () => {
    const h = harness({ identities: [primaryRow()] });
    await expect(
      h.set({ ifInState: "not-the-state", update: { id_primary: { name: "X" } } }),
    ).rejects.toThrow(/stateMismatch/);
    expect(h.rows()[0]!.name).toBe("Eric");
  });
});

// ---- the four properties that had nowhere to go -----------------------

describe("Identity/get returns what Identity/set stored", () => {
  it("round-trips every property that used to be hardcoded", async () => {
    const h = harness({ identities: [primaryRow()] });

    await h.set({
      update: {
        id_primary: {
          textSignature: "Eric\nbullmoose.cc",
          htmlSignature: "<p>Eric</p>",
          replyTo: [{ email: "replies@bullmoose.cc", name: "Replies" }],
          bcc: [{ email: "archive@bullmoose.cc" }],
          name: "Eric M",
        },
      },
    });

    expect((await h.get()).list[0]).toEqual({
      id: "id_primary",
      email: PRIMARY,
      name: "Eric M",
      textSignature: "Eric\nbullmoose.cc",
      htmlSignature: "<p>Eric</p>",
      replyTo: [{ email: "replies@bullmoose.cc", name: "Replies" }],
      bcc: [{ email: "archive@bullmoose.cc" }],
      mayDelete: false,
    });
  });

  it("an account provisioned before this unit still reads clean, and does not error", async () => {
    // No signature columns were ever written for this row — exactly the state
    // an operator's database is in the moment the ALTER lands.
    const h = harness({ identities: [primaryRow()] });
    expect((await h.get()).list[0]).toMatchObject({
      textSignature: "",
      htmlSignature: "",
      replyTo: null,
      bcc: null,
    });
  });

  it("clears a signature back to empty rather than treating '' as absent", async () => {
    const h = harness({ identities: [primaryRow({ text_signature: "old" })] });
    await h.set({ update: { id_primary: { textSignature: "", replyTo: null } } });
    expect((await h.get()).list[0]).toMatchObject({ textSignature: "", replyTo: null });
  });
});

// ---- the synthesized default, and keeping submitOne in step -----------

describe("the synthesized identity_default is materialised, not forked", () => {
  it("a signature written against the synthetic id creates the row and keeps its id", async () => {
    const h = harness(); // empty identities table → Identity/get synthesizes
    expect((await h.get()).list[0]).toMatchObject({ id: "identity_default", email: LOGIN_EMAIL });
    expect(h.rows()).toHaveLength(0);

    const res = await h.set({ update: { identity_default: { textSignature: "-- Eric" } } });

    expect(res.notUpdated).toEqual({});
    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0]).toMatchObject({
      id: "identity_default",
      email: LOGIN_EMAIL,
      text_signature: "-- Eric",
      // The account's only sender must not become deletable by being written.
      may_delete: 0,
    });
    expect((await h.get()).list[0]).toMatchObject({
      id: "identity_default",
      textSignature: "-- Eric",
    });
  });

  it("materialising keeps EmailSubmission/set resolving identity_default", async () => {
    // The trap: `resolveIdentities` stops synthesizing the moment ANY row
    // exists. A /set that wrote a row without materialising would leave
    // submitOne unable to find `identity_default` — the account silently
    // loses the ability to send.
    const h = harness();
    await h.set({ update: { identity_default: { textSignature: "-- Eric" } } });

    const res = await h.submit("identity_default");

    expect(res.notCreated).toEqual({});
    expect(h.relayCalls).toEqual([{ mailFrom: LOGIN_EMAIL, rcptTo: ["x@example.com"] }]);
  });

  it("adding a second identity to an empty table does not strand the first", async () => {
    const h = harness();
    const res = await h.set({ create: { c1: { email: "sales@bullmoose.cc" } } });

    expect(res.notCreated).toEqual({});
    expect((await h.get()).list.map((i) => i.id).sort()).toEqual(
      ["identity_default", res.created.c1!.id as string].sort(),
    );
    // ...and the login identity still sends.
    expect((await h.submit("identity_default")).notCreated).toEqual({});
  });

  it("does not materialise on a failed write", async () => {
    const h = harness();
    const res = await h.set({ create: { c1: { email: "ceo@yourbank.com" } } });
    expect(res.notCreated.c1!.type).toBe("invalidProperties");
    expect(h.rows()).toHaveLength(0);
  });

  it("refuses a write to an id the account does not have", async () => {
    const h = harness();
    const res = await h.set({ update: { id_nope: { textSignature: "x" } } });
    expect(res.notUpdated.id_nope!.type).toBe("notFound");
    expect(h.rows()).toHaveLength(0);
  });

  it("never lets a grant-reached principal persist ITS login email as a sender", async () => {
    // fromCodex/002's shape: on a granted account `ctx.principal.username`
    // belongs to somebody else entirely, and the synthesis path is built from
    // it. Materialising that would make the sharee's address a permanent
    // send-as for the owner's account.
    const h = harness({ granted: true });
    await expect(h.set({ update: { identity_default: { textSignature: "x" } } })).rejects.toThrow(
      /only the account owner/,
    );
    expect(h.rows()).toHaveLength(0);
  });
});

// ---- create is an outbound-identity boundary --------------------------

describe("Identity/set create validates the address", () => {
  it("refuses an address on a domain this tenant does not own, and writes nothing", async () => {
    const h = harness({ identities: [primaryRow()] });
    const res = await h.set({ create: { c1: { email: "ceo@yourbank.com" } } });

    expect(res.created).toEqual({});
    expect(res.notCreated.c1).toMatchObject({ type: "invalidProperties", properties: ["email"] });
    expect(h.rows()).toHaveLength(1);
  });

  it("refuses a domain that belongs to a DIFFERENT tenant", async () => {
    const h = harness({
      identities: [primaryRow()],
      domains: [
        { domain: "bullmoose.cc", status: "active" },
        { domain: "rival.example", status: "active", tenant_id: "t_rival" },
      ],
    });
    const res = await h.set({ create: { c1: { email: "boss@rival.example" } } });
    expect(res.notCreated.c1!.type).toBe("invalidProperties");
  });

  it("refuses a domain that is onboarded but not yet active", async () => {
    const h = harness({
      identities: [primaryRow()],
      domains: [
        { domain: "bullmoose.cc", status: "active" },
        { domain: "soon.example", status: "pending_ses" },
      ],
    });
    const res = await h.set({ create: { c1: { email: "hello@soon.example" } } });
    expect(res.notCreated.c1!.type).toBe("invalidProperties");
  });

  it("accepts an address on an active domain and makes it deletable", async () => {
    const h = harness({ identities: [primaryRow()] });
    const res = await h.set({ create: { c1: { email: "Sales@BullMoose.cc", name: "Sales" } } });

    const id = res.created.c1!.id as string;
    expect(res.created.c1).toMatchObject({ mayDelete: true });
    // Normalised, so `UNIQUE (account_id, email)` is not case-blind.
    expect((await h.get({ ids: [id] })).list[0]).toMatchObject({
      email: "sales@bullmoose.cc",
      name: "Sales",
      mayDelete: true,
    });
  });

  it("maps a duplicate address to invalidProperties, not serverFail", async () => {
    const h = harness({ identities: [primaryRow()] });
    const res = await h.set({ create: { c1: { email: PRIMARY } } });
    expect(res.notCreated.c1).toMatchObject({ type: "invalidProperties", properties: ["email"] });
  });

  it("refuses a client-chosen id or mayDelete", async () => {
    const h = harness({ identities: [primaryRow()] });
    const res = await h.set({
      create: { c1: { email: "sales@bullmoose.cc", id: "id_mine", mayDelete: false } },
    });
    expect(res.notCreated.c1).toMatchObject({
      type: "invalidProperties",
      properties: ["id", "mayDelete"],
    });
  });

  it("refuses a create with no email at all", async () => {
    const h = harness({ identities: [primaryRow()] });
    const res = await h.set({ create: { c1: { name: "Nameless" } } });
    expect(res.notCreated.c1).toMatchObject({ properties: ["email"] });
  });

  it("one bad object does not fail the batch", async () => {
    const h = harness({ identities: [primaryRow()] });
    const res = await h.set({
      create: { good: { email: "sales@bullmoose.cc" }, bad: { email: "boss@elsewhere.example" } },
    });
    expect(Object.keys(res.created)).toEqual(["good"]);
    expect(Object.keys(res.notCreated)).toEqual(["bad"]);
  });
});

// ---- update / destroy semantics ---------------------------------------

describe("Identity/set update and destroy", () => {
  it("refuses to change the email, which is half the uniqueness key", async () => {
    const h = harness({ identities: [primaryRow()] });
    const res = await h.set({ update: { id_primary: { email: "other@bullmoose.cc" } } });
    expect(res.notUpdated.id_primary).toMatchObject({
      type: "invalidProperties",
      properties: ["email"],
    });
    expect(h.rows()[0]!.email).toBe(PRIMARY);
  });

  it("refuses an unknown property rather than silently dropping it", async () => {
    const h = harness({ identities: [primaryRow()] });
    const res = await h.set({ update: { id_primary: { signature: "oops" } } });
    expect(res.notUpdated.id_primary).toMatchObject({ properties: ["signature"] });
  });

  it("refuses a replyTo entry that is not an address", async () => {
    const h = harness({ identities: [primaryRow()] });
    const res = await h.set({ update: { id_primary: { replyTo: [{ email: "not-an-address" }] } } });
    expect(res.notUpdated.id_primary).toMatchObject({ properties: ["replyTo"] });
  });

  it("refuses to destroy the provisioned primary, and leaves it able to send", async () => {
    const h = harness({ identities: [primaryRow()] });
    const res = await h.set({ destroy: ["id_primary"] });

    expect(res.destroyed).toEqual([]);
    expect(res.notDestroyed.id_primary!.type).toBe("forbidden");
    expect(h.rows()).toHaveLength(1);
    expect((await h.submit("id_primary")).notCreated).toEqual({});
  });

  it("destroys an identity the user added, and stops it being a sender", async () => {
    const h = harness({ identities: [primaryRow()] });
    const made = await h.set({ create: { c1: { email: "sales@bullmoose.cc" } } });
    const id = made.created.c1!.id as string;

    expect((await h.set({ destroy: [id] })).destroyed).toEqual([id]);
    expect(h.rows()).toHaveLength(1);
    const blocked = await h.submit(id);
    expect(blocked.created).toEqual({});
    expect(h.relayCalls).toEqual([]);
  });
});

// ---- the scope gate ----------------------------------------------------

describe("requiredScopesForIdentitySet charges per operation", () => {
  it("charges send for a create, draft for an update, delete for a destroy", () => {
    expect(requiredScopesForIdentitySet({ create: { c1: {} } })).toEqual(["send"]);
    expect(requiredScopesForIdentitySet({ update: { x: {} } })).toEqual(["draft"]);
    expect(requiredScopesForIdentitySet({ destroy: ["x"] })).toEqual(["delete"]);
  });

  it("charges every operation a bundled call performs", () => {
    // hasScope is a FLAT SET (.feedback/fromClaude/common/027) — `send` does
    // not imply `draft` — so bundling must not buy an operation for free.
    expect(
      requiredScopesForIdentitySet({
        create: { c1: {} },
        update: { x: {} },
        destroy: ["y"],
      }).sort(),
    ).toEqual(["delete", "draft", "send"]);
  });

  it("asks for nothing when the call does nothing", () => {
    expect(requiredScopesForIdentitySet({})).toEqual([]);
    expect(requiredScopesForIdentitySet({ create: {}, destroy: [] })).toEqual([]);
  });

  it("a read-only token cannot set a signature", async () => {
    const h = harness({ identities: [primaryRow()], scopes: ["read"] });
    await expect(h.set({ update: { id_primary: { textSignature: "x" } } })).rejects.toThrow(
      /lacks the "draft" scope/,
    );
    expect(h.rows()[0]!.text_signature).toBe("");
  });

  it("a draft-scoped token may set a signature but may not mint a sender", async () => {
    const h = harness({ identities: [primaryRow()], scopes: ["draft"] });
    expect((await h.set({ update: { id_primary: { textSignature: "x" } } })).notUpdated).toEqual(
      {},
    );
    await expect(h.set({ create: { c1: { email: "sales@bullmoose.cc" } } })).rejects.toThrow(
      /lacks the "send" scope/,
    );
    expect(h.rows()).toHaveLength(1);
  });

  it("a send-scoped token may mint a sender but may not destroy one", async () => {
    const h = harness({ identities: [primaryRow()], scopes: ["send"] });
    const made = await h.set({ create: { c1: { email: "sales@bullmoose.cc" } } });
    await expect(h.set({ destroy: [made.created.c1!.id as string] })).rejects.toThrow(
      /lacks the "delete" scope/,
    );
    expect(h.rows()).toHaveLength(2);
  });
});
