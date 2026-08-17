// Grants + sharing + vault + analytics-MCP e2e (Phase 3). Needs three
// local dev servers sharing one state dir (see tools/README.md):
//   jmap :8787, agent :8789, provision :8790
// seeded with tools/fixtures/grants-e2e-seed.sql (eric owner, carol
// sharee, editor read-delegated agent; fixed dev tokens).
const JMAP = "http://127.0.0.1:8787";
const AGENT = "http://127.0.0.1:8789";
const PROV = "http://127.0.0.1:8790";
const ADMIN = "admintoken";
const INTERNAL = "internal";

const ERIC = {
  acct: "t_test__a_eric",
  token: "bm_aaaaaaaaaaaa_" + "a".repeat(48),
  email: "eric@test.local",
};
const CAROL = {
  acct: "t_test__a_carol",
  token: "bm_bbbbbbbbbbbb_" + "b".repeat(48),
  email: "carol@test.local",
};
const EDITOR = {
  acct: "t_test__a_editor",
  token: "bm_cccccccccccc_" + "c".repeat(48),
  email: "editor@test.local",
};

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
};
const USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:contacts",
];
const jmap = async (who, methodCalls) => {
  const res = await fetch(`${JMAP}/api/jmap`, {
    method: "POST",
    headers: { Authorization: `Bearer ${who.token}`, "content-type": "application/json" },
    body: JSON.stringify({ using: USING, methodCalls }),
  });
  if (!res.ok) {
    console.error(`FAIL: api/jmap HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  return (await res.json()).methodResponses;
};
const session = async (who) =>
  (
    await fetch(`${JMAP}/.well-known/jmap`, { headers: { Authorization: `Bearer ${who.token}` } })
  ).json();

// ---- 1. owner setup: Family book + one private, one shared card -------
// First touch auto-creates the default "Contacts" book, so Family below
// is NOT the default and private cards stay out of it.
const [[, abInit]] = await jmap(ERIC, [
  ["AddressBook/get", { accountId: ERIC.acct, ids: null }, "i0"],
]);
assert(
  abInit.list.some((b) => b.isDefault && b.name === "Contacts"),
  "owner default book exists",
);
const [[, fam]] = await jmap(ERIC, [
  [
    "AddressBook/set",
    {
      accountId: ERIC.acct,
      create: {
        f: { name: "Family" },
      },
    },
    "c0",
  ],
]);
const famId = fam.created?.f?.id;
assert(famId, `family book created: ${JSON.stringify(fam.notCreated)}`);

const [[, cards]] = await jmap(ERIC, [
  [
    "ContactCard/set",
    {
      accountId: ERIC.acct,
      create: {
        gm: {
          name: { full: "Grandma Moore" },
          uid: "e2e-grandma",
          addressBookIds: { [famId]: true },
        },
        pv: { name: { full: "Private Pete" }, uid: "e2e-private" },
      },
    },
    "c1",
  ],
]);
const grandmaId = cards.created?.gm?.id;
const privateId = cards.created?.pv?.id;
assert(grandmaId && privateId, `cards created: ${JSON.stringify(cards.notCreated)}`);
const stateBeforeShare = cards.newState;

// ---- 2. carol has no access before sharing ----------------------------
const carolPre = await session(CAROL);
assert(!carolPre.accounts[ERIC.acct], "carol does not see eric pre-share");

// ---- 3. owner shares Family with carol (mayWrite) ---------------------
const [[, shareRes]] = await jmap(ERIC, [
  [
    "AddressBook/set",
    {
      accountId: ERIC.acct,
      update: {
        [famId]: { shareWith: { [CAROL.acct]: { mayRead: true, mayWrite: true } } },
      },
    },
    "c2",
  ],
]);
assert(
  shareRes.updated && famId in shareRes.updated,
  `share applied: ${JSON.stringify(shareRes.notUpdated)}`,
);

const [[, abOwner]] = await jmap(ERIC, [
  ["AddressBook/get", { accountId: ERIC.acct, ids: [famId] }, "c3"],
]);
const ownerView = abOwner.list[0];
assert(
  ownerView.shareWith?.[CAROL.acct]?.mayWrite === true,
  `owner sees shareWith: ${JSON.stringify(ownerView.shareWith)}`,
);
assert(ownerView.myRights.mayShare === true, "owner keeps full rights");

// ---- 4. carol's session now includes eric's account -------------------
const carolSess = await session(CAROL);
const carolEric = carolSess.accounts[ERIC.acct];
assert(carolEric, "granted account appears in carol session");
assert(carolEric.isPersonal === false, "granted account is not personal");
assert(
  carolEric.accountCapabilities["urn:ietf:params:jmap:contacts"],
  "contacts capability granted",
);
assert(
  !carolEric.accountCapabilities["urn:ietf:params:jmap:mail"],
  "book-scoped grant exposes NO mail capability",
);

// ---- 5. carol sees exactly the shared book ----------------------------
const [[, abCarol]] = await jmap(CAROL, [
  ["AddressBook/get", { accountId: ERIC.acct, ids: null }, "c4"],
]);
assert(
  abCarol.list.length === 1 && abCarol.list[0].id === famId,
  `carol sees only Family: ${JSON.stringify(abCarol.list.map((b) => b.name))}`,
);
assert(
  abCarol.list[0].myRights.mayWrite === true && abCarol.list[0].myRights.mayShare === false,
  "sharee rights from grant",
);
assert(abCarol.list[0].shareWith === null, "sharee sees shareWith null");

// ---- 6. card visibility is book-scoped --------------------------------
const [[, qCarol]] = await jmap(CAROL, [
  ["ContactCard/query", { accountId: ERIC.acct, calculateTotal: true }, "c5"],
]);
assert(
  qCarol.total === 1 && qCarol.ids[0] === grandmaId,
  `carol queries only shared cards: ${JSON.stringify(qCarol)}`,
);
const [[, gPriv]] = await jmap(CAROL, [
  ["ContactCard/get", { accountId: ERIC.acct, ids: [privateId] }, "c6"],
]);
assert(gPriv.notFound.includes(privateId), "private card reads as notFound for carol");

// ---- 7. carol writes into the shared book -----------------------------
const [[, cCreate]] = await jmap(CAROL, [
  [
    "ContactCard/set",
    {
      accountId: ERIC.acct,
      create: {
        n: { name: { full: "Nephew Ned" }, uid: "e2e-ned" },
      },
    },
    "c7",
  ],
]);
const nedId = cCreate.created?.n?.id;
assert(nedId, `carol created in shared book: ${JSON.stringify(cCreate.notCreated)}`);
const [[, gNed]] = await jmap(ERIC, [
  ["ContactCard/get", { accountId: ERIC.acct, ids: [nedId] }, "c8"],
]);
assert(gNed.list[0]?.addressBookIds?.[famId] === true, "owner sees carol-created card in Family");

// ---- 8. the grant does NOT unlock mail or book management -------------
const [mailTry] = await jmap(CAROL, [["Email/query", { accountId: ERIC.acct }, "c9"]]);
assert(
  mailTry[0] === "error" && mailTry[1].type === "forbidden",
  `mail blocked for carol: ${JSON.stringify(mailTry[1])}`,
);
const [abTry] = await jmap(CAROL, [
  ["AddressBook/set", { accountId: ERIC.acct, create: { x: { name: "Nope" } } }, "c10"],
]);
assert(abTry[0] === "error" && abTry[1].type === "forbidden", "sharee cannot manage books");

// ---- 9. changes are filtered for the sharee ----------------------------
const [[, chCarol]] = await jmap(CAROL, [
  ["ContactCard/changes", { accountId: ERIC.acct, sinceState: stateBeforeShare }, "c11"],
]);
assert(chCarol.created.includes(nedId), "carol sees her create in changes");
assert(
  !chCarol.created.includes(privateId) && !chCarol.updated.includes(privateId),
  "private card never appears in carol changes",
);

// ---- 10. rights downgrade: read-only ----------------------------------
await jmap(ERIC, [
  [
    "AddressBook/set",
    {
      accountId: ERIC.acct,
      update: {
        [famId]: { [`shareWith/${CAROL.acct}/mayWrite`]: false },
      },
    },
    "c12",
  ],
]);
const [roTry] = await jmap(CAROL, [
  [
    "ContactCard/set",
    {
      accountId: ERIC.acct,
      create: {
        x: { name: { full: "Blocked" } },
      },
    },
    "c13",
  ],
]);
assert(roTry[0] === "error" && roTry[1].type === "forbidden", "downgraded sharee cannot write");
const [[, roRead]] = await jmap(CAROL, [["ContactCard/query", { accountId: ERIC.acct }, "c14"]]);
assert(roRead.ids.length === 2, "read still works after downgrade");

// ---- 11. unshare revokes access entirely --------------------------------
await jmap(ERIC, [
  [
    "AddressBook/set",
    {
      accountId: ERIC.acct,
      update: {
        [famId]: { [`shareWith/${CAROL.acct}`]: null },
      },
    },
    "c15",
  ],
]);
const [gone] = await jmap(CAROL, [["AddressBook/get", { accountId: ERIC.acct, ids: null }, "c16"]]);
assert(
  gone[0] === "error" && gone[1].type === "accountNotFound",
  "unshared: account vanishes for carol",
);
const carolPost = await session(CAROL);
assert(!carolPost.accounts[ERIC.acct], "session no longer lists eric");

// ---- 12. operator grant via provision: editor reads eric's mail --------
const prov = async (method, path, body) => {
  const res = await fetch(`${PROV}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok)
    assert(false, `provision ${method} ${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
};
const grant = await prov("POST", "/grants", {
  granteeEmail: EDITOR.email,
  targetEmail: ERIC.email,
  scopes: ["read", "draft"],
});
assert(grant.grantId?.startsWith("g_"), `grant minted: ${JSON.stringify(grant)}`);

const edSess = await session(EDITOR);
assert(
  edSess.accounts[ERIC.acct]?.accountCapabilities["urn:ietf:params:jmap:mail"],
  "whole-account grant exposes mail capability",
);

const [[, edQuery]] = await jmap(EDITOR, [
  ["Email/query", { accountId: ERIC.acct, calculateTotal: true }, "c17"],
]);
assert(edQuery.total === 1, `editor reads eric mail: ${JSON.stringify(edQuery)}`);
const [[, edContacts]] = await jmap(EDITOR, [
  ["ContactCard/query", { accountId: ERIC.acct, calculateTotal: true }, "c18"],
]);
assert(edContacts.total === 3, "whole-account grant covers contacts reads too");

// Token ∩ grant: the grant carries draft, but editor's TOKEN is read-only.
const [edSet] = await jmap(EDITOR, [["Email/set", { accountId: ERIC.acct, create: {} }, "c19"]]);
assert(edSet[0] === "error" && edSet[1].type === "forbidden", "token scopes clamp granted rights");

const listed = await prov("GET", `/grants?email=${encodeURIComponent(EDITOR.email)}`);
assert(
  listed.grants.some((g) => g.id === grant.grantId),
  "grant listed by email",
);
const revoked = await prov("DELETE", `/grants/${grant.grantId}`);
assert(revoked.revoked === true, "grant revoked");
const [edGone] = await jmap(EDITOR, [["Email/query", { accountId: ERIC.acct }, "c20"]]);
assert(
  edGone[0] === "error" && edGone[1].type === "accountNotFound",
  "revoked grant removes access",
);

// ---- 13. credential vault ------------------------------------------------
const vault = async (who, method, path, body) => {
  const res = await fetch(`${AGENT}${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const noAuth = await fetch(`${AGENT}/vault/credentials`);
assert(noAuth.status === 401, "vault rejects unauthenticated");

const put = await vault(ERIC, "PUT", "/vault/credentials", {
  name: "anthropic-api",
  kind: "api-key",
  secret: "sk-test-secret-123",
  meta: { provider: "anthropic" },
});
assert(
  put.status === 200 && put.body.ok === true && !JSON.stringify(put.body).includes("sk-test"),
  `vault stores without echoing: ${JSON.stringify(put.body)}`,
);

const list = await vault(ERIC, "GET", "/vault/credentials");
assert(
  list.body.credentials.length === 1 &&
    list.body.credentials[0].name === "anthropic-api" &&
    !JSON.stringify(list.body).includes("sk-test"),
  "list is metadata-only",
);

const carolList = await vault(CAROL, "GET", "/vault/credentials");
assert(carolList.body.credentials.length === 0, "vault is per-principal");

const verify = await fetch(`${AGENT}/internal/vault/verify`, {
  method: "POST",
  headers: { "x-internal-token": INTERNAL, "content-type": "application/json" },
  body: JSON.stringify({ principalEmail: ERIC.email, name: "anthropic-api" }),
});
assert((await verify.json()).ok === true, "sealed secret decrypts under the master key");

const del = await vault(ERIC, "DELETE", "/vault/credentials/anthropic-api");
assert(del.body.deleted === true, "credential deleted");

// ---- 14. mailstore-analytics MCP (stateless MCP.2, 2026-07-28) ------------
// Mirrors services/agent/src/mcp.ts request handling: the router still gates on
// x-internal-token (a coarse network ACL), but IDENTITY is now a per-request
// bearer, and the protocol version rides both a header AND params._meta (they
// must be equal). There is no `initialize`/session anymore — `server/discover`
// replaces it. See docs/architecture/mcp-auth.md §7a for the wire contract.
const MCP_PROTO = "2026-07-28";
const mcp = async (body, token) => {
  const res = await fetch(`${AGENT}/mcp/analytics`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": INTERNAL, // router ACL (unchanged)
      Authorization: `Bearer ${token}`, // identity (MCP.2)
      "MCP-Protocol-Version": MCP_PROTO, // MUST equal _meta below
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      ...body,
      params: {
        ...(body.params ?? {}),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTO,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// server/discover replaces the dead `initialize` handshake.
const disc = await mcp({ method: "server/discover" }, ERIC.token);
assert(
  disc.status === 200 && disc.body?.result?.serverInfo?.name === "bullmoose-mailstore-analytics",
  `MCP server/discover: ${disc.status} ${JSON.stringify(disc.body)}`,
);
assert(
  JSON.stringify(disc.body.result?.supportedVersions) === JSON.stringify([MCP_PROTO]),
  `server/discover advertises only MCP.2: ${JSON.stringify(disc.body.result?.supportedVersions)}`,
);

// tools/list — the surface grew well past the original four (analytics + calendar/
// contacts/email CRUD + introspection), so assert the analytics reads are present
// rather than an exact count, and that the MCP.2 cache hint (ttlMs) rides along.
const tools = await mcp({ method: "tools/list" }, ERIC.token);
const toolNames = (tools.body?.result?.tools ?? []).map((t) => t.name);
assert(
  ["spend_by_month", "spend_by_vendor", "top_senders", "message_volume"].every((n) =>
    toolNames.includes(n),
  ),
  `MCP lists the analytics tools: ${JSON.stringify(toolNames)}`,
);
assert(
  typeof tools.body.result?.ttlMs === "number",
  `tools/list carries a cache ttl: ${JSON.stringify(tools.body.result)}`,
);

// owner read: ERIC's bearer on ERIC's own account → 200 + rows, no grant needed.
const spend = await mcp(
  {
    method: "tools/call",
    params: {
      name: "spend_by_month",
      arguments: { accountId: ERIC.acct },
    },
  },
  ERIC.token,
);
assert(spend.status === 200, `spend_by_month owner read is 200: ${JSON.stringify(spend.body)}`);
const spendRows = JSON.parse(spend.body.result.content[0].text);
assert(
  spendRows.length === 2 && spendRows[0].period_month === "2026-07",
  `spend_by_month: ${JSON.stringify(spendRows)}`,
);
const senders = await mcp(
  {
    method: "tools/call",
    params: {
      name: "top_senders",
      arguments: { accountId: ERIC.acct, days: 365 },
    },
  },
  ERIC.token,
);
assert(
  JSON.parse(senders.body.result.content[0].text)[0]?.sender === "cfo@example.com",
  "top_senders",
);

// cross-account denial: CAROL holds no grant on ERIC's account (unshared back in
// §11) → 403 and ZERO rows leak (authorizeAccount fails before the tool runs).
const denied = await mcp(
  {
    method: "tools/call",
    params: {
      name: "spend_by_month",
      arguments: { accountId: ERIC.acct },
    },
  },
  CAROL.token,
);
assert(
  denied.status === 403 && denied.body?.error && denied.body?.result === undefined,
  `cross-account MCP read denied with no rows: ${denied.status} ${JSON.stringify(denied.body)}`,
);

// grant-reached read: re-grant EDITOR read on ERIC, then EDITOR's bearer reads
// ERIC's ledger THROUGH the grant → 200 + rows. This exercises the live
// token ∩ grant path end-to-end; the grant_audit WRITE it triggers is asserted
// directly by the fake-D1 unit test (services/agent/src/mcp.test.ts case 10) —
// this harness has no HTTP path to read grant_audit rows back.
const mcpGrant = await prov("POST", "/grants", {
  granteeEmail: EDITOR.email,
  targetEmail: ERIC.email,
  scopes: ["read"],
});
assert(mcpGrant.grantId?.startsWith("g_"), `mcp grant minted: ${JSON.stringify(mcpGrant)}`);
const edSpend = await mcp(
  {
    method: "tools/call",
    params: {
      name: "spend_by_month",
      arguments: { accountId: ERIC.acct },
    },
  },
  EDITOR.token,
);
assert(edSpend.status === 200, `grant-reached MCP read is 200: ${JSON.stringify(edSpend.body)}`);
assert(
  JSON.parse(edSpend.body.result.content[0].text).length === 2,
  `grant-reached read returns ERIC's rows: ${edSpend.body.result.content[0].text}`,
);
await prov("DELETE", `/grants/${mcpGrant.grantId}`);

// version rejection: an old protocol string → 400 / -32022 with a supported[] set.
const badVer = await fetch(`${AGENT}/mcp/analytics`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-internal-token": INTERNAL,
    Authorization: `Bearer ${ERIC.token}`,
    "MCP-Protocol-Version": "2025-06-18",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2025-06-18",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  }),
});
const badVerBody = await badVer.json();
assert(
  badVer.status === 400 &&
    badVerBody.error?.code === -32022 &&
    Array.isArray(badVerBody.error?.data?.supported),
  `unsupported version rejected with supported[]: ${badVer.status} ${JSON.stringify(badVerBody)}`,
);

// the dead handshake is gone: `initialize` is just an unknown method now (-32601).
const legacy = await mcp({ method: "initialize" }, ERIC.token);
assert(
  legacy.status === 404 && legacy.body?.error?.code === -32601,
  `initialize is no longer a method: ${legacy.status} ${JSON.stringify(legacy.body)}`,
);

// still valid: no internal token → the route stays hidden (404), unchanged by s01.
const noTokenMcp = await fetch(`${AGENT}/mcp/analytics`, { method: "POST", body: "{}" });
assert(noTokenMcp.status === 404, "MCP hidden without internal token");

console.log("E2E GRANTS OK — sharing, delegation, vault, and analytics MCP verified");
