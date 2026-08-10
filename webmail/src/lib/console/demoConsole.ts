// An in-memory deployment for the console — the same role `lib/jmap/demo.ts`
// plays for mail: it drives the tests AND `astro dev`, so the screen can be
// opened and used before the read interface exists.
//
// Everything here is shaped to make the two views' hard cases REAL rather than
// hypothetical, because a demo dataset where nothing is wrong proves a screen
// renders and nothing else:
//
//   • `allen@` holds a grant stored as `["mail"]` — the superset case. Nothing
//     names `send` or `delete`; both are conferred.
//   • one grant is REVOKED (tombstoned, s03.A) after having been used. It must
//     still appear in the who-could set for the instant it was live, and the
//     action taken under it must render as explained-then-revoked.
//   • one `grant_audit` row is a Bureau REFUSAL (`grant_id = 'none'`) — an agent
//     probing for a credential it was never granted.
//   • one contact card has NULL provenance — the `common/033` gap, which must
//     read as "not captured", never as "nobody".
//   • `aws-mcp` is `enforcement: broad` with a wildcard destination, held with a
//     live `fetch` grant by an agent that also sends. That is `readme.md`'s
//     exfiltration combination, assembled from parts that each look fine.

import type { FakeConsoleData } from "./ConsoleClient";
import { FakeConsoleClient } from "./ConsoleClient";
import type {
  AgentDossier,
  ConsoleCredential,
  ConsoleGrant,
  ConsoleResource,
  ResourceDossier,
} from "./types";

const DAY = 86_400_000;
/** A fixed "now" so the demo is deterministic across runs and screenshots. */
export const DEMO_NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

const ago = (days: number): number => DEMO_NOW - days * DAY;

export const VENDORS_BOOK: ConsoleResource = {
  collection: "AddressBook",
  collectionId: "ab_vendors",
  name: "VendorsBook",
  accountId: "acct_eric",
};

const grants: ConsoleGrant[] = [
  {
    // The superset case: stored as ["mail"], confers six permissions.
    grantId: "g_allen_mail",
    // Both sides are carried. The SAME grant renders from opposite directions
    // in the two views — the per-agent view asks "what does Allen reach?" (the
    // target) and the forensic view asks "who reached VendorsBook?" (the
    // grantee) — and a one-sided row makes whichever view it was not shaped for
    // render "another account".
    grantee: { accountId: "acct_allen", name: "Allen", address: "allen@bullmoose.cc" },
    target: { accountId: "acct_eric", name: "Eric", address: "eric@bullmoose.cc" },
    scopes: ["mail", "contacts"],
    allows: [],
    collection: null,
    collectionId: null,
    createdBy: "p_eric",
    createdAt: ago(120),
    expiresAt: null,
    revokedAt: null,
  },
  {
    // Narrow, and REVOKED four days ago — after it was used.
    grantId: "g_temp_vendors",
    grantee: { accountId: "acct_contractor", name: "Dana (contractor)", address: "dana@example.com" },
    target: { accountId: "acct_eric", name: "Eric", address: "eric@bullmoose.cc" },
    scopes: ["contacts"],
    allows: [],
    collection: "AddressBook",
    collectionId: "ab_vendors",
    createdBy: "p_eric",
    createdAt: ago(30),
    expiresAt: null,
    revokedAt: ago(4),
  },
  {
    // Live, narrow, never used — the over-permissioning finding.
    grantId: "g_analyst_read",
    grantee: { accountId: "acct_analyst", name: "analyst@", address: "analyst@bullmoose.cc" },
    target: { accountId: "acct_eric", name: "Eric", address: "eric@bullmoose.cc" },
    scopes: ["read"],
    collection: "AddressBook",
    collectionId: "ab_vendors",
    allows: [],
    createdBy: "p_eric",
    createdAt: ago(60),
    expiresAt: DEMO_NOW + 90 * DAY,
    revokedAt: null,
  },
];

const credentials: ConsoleCredential[] = [
  {
    name: "aws-mcp",
    kind: "aws-sigv4",
    allow: "https://*.amazonaws.com",
    header: null,
    scope: "actor",
    enforcement: "broad",
    createdAt: ago(200),
    updatedAt: ago(12),
    meta: { provider: "aws", region: "us-east-1" },
  },
  {
    name: "stripe-key",
    kind: "api-key",
    allow: "https://api.stripe.com",
    header: "Authorization: Bearer {}",
    scope: "actor",
    enforcement: "narrow",
    createdAt: ago(90),
    updatedAt: ago(90),
    meta: { provider: "stripe" },
  },
  {
    name: "google-oauth",
    kind: "oauth-refresh",
    allow: "https://oauth2.googleapis.com",
    header: "Authorization: Bearer {}",
    scope: "actor",
    enforcement: "federated",
    createdAt: ago(45),
    updatedAt: ago(2),
    meta: { token_url: "https://oauth2.googleapis.com/token", client_id: "demo.apps.googleusercontent.com" },
  },
  {
    name: "unbound-key",
    kind: "api-key",
    allow: null,
    header: "Authorization: Bearer {}",
    scope: "actor",
    enforcement: "broad",
    createdAt: ago(7),
    updatedAt: ago(7),
    meta: {},
  },
];

const allen: AgentDossier = {
  accountId: "acct_allen",
  principalId: "p_allen",
  principal: "allen@bullmoose.cc",
  tokenScopes: ["mail", "vault"],
  bindings: [
    {
      bindingId: "ab_1",
      name: "allen",
      triggerOn: "mailbox-delivery",
      slaSeconds: 120,
      enabled: true,
      config: {
        pipeline: "reply",
        replyMode: "send",
        hasPersona: true,
        senderAllowlist: { active: false },
        modelAliasCount: 3,
      },
      credentialRefs: ["aws-mcp", "google-oauth"],
    },
    {
      bindingId: "ab_2",
      name: "allen-digest",
      triggerOn: "schedule",
      slaSeconds: null,
      enabled: false,
      config: { pipeline: "ledger", replyMode: "draft", senderAllowlist: { active: true, count: 4 } },
      credentialRefs: [],
    },
  ],
  credentials,
  bureauGrants: [
    {
      grantId: "bg_1",
      principalId: "p_allen",
      credRef: "aws-mcp",
      verb: "fetch",
      createdBy: "p_eric",
      createdAt: ago(200),
      expiresAt: null,
      revokedAt: null,
    },
    {
      grantId: "bg_2",
      principalId: "p_allen",
      credRef: "aws-mcp",
      verb: "sign_sigv4",
      createdBy: "p_eric",
      createdAt: ago(200),
      expiresAt: DEMO_NOW + 30 * DAY,
      revokedAt: null,
    },
    {
      grantId: "bg_3",
      principalId: "p_allen",
      credRef: "google-oauth",
      verb: "oauth_token",
      createdBy: "p_eric",
      createdAt: ago(45),
      expiresAt: null,
      revokedAt: null,
    },
    {
      grantId: "bg_4",
      principalId: "p_allen",
      credRef: "unbound-key",
      verb: "fetch",
      createdBy: "p_eric",
      createdAt: ago(7),
      expiresAt: null,
      revokedAt: null,
    },
    {
      grantId: "bg_5",
      principalId: "p_allen",
      credRef: "stripe-key",
      verb: "fetch",
      createdBy: "p_eric",
      createdAt: ago(90),
      expiresAt: null,
      revokedAt: ago(20),
    },
  ],
  grantsHeld: [grants[0] as ConsoleGrant],
  grantsGiven: [],
  invocations: [
    {
      invocationId: "inv_9",
      bindingId: "ab_1",
      bindingName: "allen",
      status: "done",
      emailId: "em_412",
      note: null,
      createdAt: ago(0.2),
      doneAt: ago(0.19),
    },
    {
      invocationId: "inv_8",
      bindingId: "ab_1",
      bindingName: "allen",
      status: "done",
      emailId: "em_410",
      note: "skipped: noreply@vendor.example not in allowedSenders",
      createdAt: ago(1),
      doneAt: ago(1),
    },
    {
      invocationId: "inv_7",
      bindingId: "ab_1",
      bindingName: "allen",
      status: "failed",
      emailId: "em_401",
      note: "model provider returned 429",
      createdAt: ago(3),
      doneAt: ago(3),
    },
  ],
  spend: { currency: "USD", totalCents: 4_211, rows: 38, since: ago(90) },
};

const analyst: AgentDossier = {
  accountId: "acct_analyst",
  principalId: "p_analyst",
  principal: "analyst@bullmoose.cc",
  tokenScopes: ["read", "contacts"],
  bindings: [
    {
      bindingId: "ab_3",
      name: "analyst",
      triggerOn: "mailbox-delivery",
      slaSeconds: null,
      enabled: true,
      config: { pipeline: "ledger", replyMode: "draft", senderAllowlist: { active: true, count: 2 } },
      credentialRefs: [],
    },
  ],
  credentials: [],
  bureauGrants: [],
  grantsHeld: [grants[2] as ConsoleGrant],
  grantsGiven: [],
  invocations: [],
  spend: { currency: "USD", totalCents: 118, rows: 6, since: ago(90) },
};

const vendorsDossier: ResourceDossier = {
  resource: VENDORS_BOOK,
  grants,
  bureauGrants: [],
  audit: [
    {
      // Under the grant that has SINCE been revoked — the point-in-time case.
      id: 3301,
      at: ago(9),
      principal: "dana@example.com",
      method: "contacts:contacts",
      grantId: "g_temp_vendors",
      accountId: "acct_eric",
    },
    {
      id: 3302,
      at: ago(6),
      principal: "allen@bullmoose.cc",
      method: "mcp:contacts_upsert_card",
      grantId: "g_allen_mail",
      accountId: "acct_eric",
    },
    {
      // A Bureau REFUSAL — nothing authorized it, so grant_id is 'none'.
      id: 3303,
      at: ago(2),
      principal: "editor@bullmoose.cc",
      method: "bureau:fetch:aws-mcp",
      grantId: "none",
      accountId: "acct_eric",
    },
  ],
  provenance: [
    {
      realm: "contact_cards",
      recordId: "cc_101",
      label: "Sparkling Pools LLC",
      lastWriterPrincipal: "allen@bullmoose.cc",
      lastWriterBinding: "allen",
      lastWriterInvocation: "inv_8",
      updatedAt: ago(6),
    },
    {
      realm: "contact_cards",
      recordId: "cc_102",
      label: "Midbury Hardware",
      // common/033: a DAV write. Authenticated, and stamped with nothing.
      lastWriterPrincipal: null,
      lastWriterBinding: null,
      lastWriterInvocation: null,
      updatedAt: ago(5),
    },
    {
      realm: "contact_cards",
      recordId: "cc_103",
      label: "Northgate Fuel",
      // The owner's own write — invisible to grant_audit by construction.
      lastWriterPrincipal: "eric@bullmoose.cc",
      lastWriterBinding: null,
      lastWriterInvocation: null,
      updatedAt: ago(11),
    },
  ],
  parties: [
    { accountId: "acct_allen", name: "Allen", address: "allen@bullmoose.cc" },
    { accountId: "acct_contractor", name: "Dana (contractor)", address: "dana@example.com" },
    { accountId: "acct_analyst", name: "analyst@", address: "analyst@bullmoose.cc" },
  ],
};

export function demoConsoleData(): FakeConsoleData {
  return {
    agents: [
      {
        accountId: "acct_allen",
        principalId: "p_allen",
        principal: "allen@bullmoose.cc",
        displayName: "Allen",
        bindingCount: 2,
        enabledBindingCount: 1,
      },
      {
        accountId: "acct_analyst",
        principalId: "p_analyst",
        principal: "analyst@bullmoose.cc",
        displayName: "analyst@",
        bindingCount: 1,
        enabledBindingCount: 1,
      },
    ],
    dossiers: { acct_allen: allen, acct_analyst: analyst },
    resources: {
      acct_allen: [VENDORS_BOOK],
      acct_analyst: [VENDORS_BOOK],
    },
    resourceDossiers: { "AddressBook:ab_vendors": vendorsDossier },
    credentials,
  };
}

export function createDemoConsole(): FakeConsoleClient {
  return new FakeConsoleClient(demoConsoleData());
}
