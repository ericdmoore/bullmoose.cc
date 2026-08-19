/**
 * A stub bullmoose server for the composition smoke test — loopback only,
 * in-memory, no dependencies.
 *
 * It exists because the I/O contract (`.plans/s05-cli-crud/arch.md` §1) is
 * about behaviour under pipes, and a process cannot observe its own EPIPE,
 * exit code, or `| xargs` composition. Driving the real binary needs a real
 * server, so here is the smallest one that answers what the CLI asks:
 * `/.well-known/jmap`, the JMAP method envelope for Mailbox and Email,
 * `/auth/tokens`, and the blob/share REST endpoints.
 *
 * It is deliberately NOT a JMAP implementation. Every method here is the
 * minimum that lets a command produce output; correctness of the protocol
 * lives in `services/jmap/**\/*.test.ts`.
 */

import { createServer } from "node:http";

const ACCOUNT = "t_smoke__a_you";
const TOKEN = "bm_smoke_token";

/**
 * Mailboxes, keyed by id. `mb_full` deliberately holds mail (exit-5 case). The
 * archive/junk/trash roles are seeded so the triage sugar verbs (sVOL 019) have
 * a real destination to resolve — provisioning seeds these on every account
 * (`services/provision/src/index.ts`).
 */
const mailboxes = new Map([
  ["mb_inbox", { id: "mb_inbox", parentId: null, name: "Inbox", role: "inbox", sortOrder: 0 }],
  ["mb_sent", { id: "mb_sent", parentId: null, name: "Sent", role: "sent", sortOrder: 1 }],
  ["mb_full", { id: "mb_full", parentId: null, name: "Full", role: null, sortOrder: 2 }],
  ["mb_empty", { id: "mb_empty", parentId: null, name: "Empty", role: null, sortOrder: 3 }],
  ["mb_archive", { id: "mb_archive", parentId: null, name: "Archive", role: "archive", sortOrder: 4 }],
  ["mb_junk", { id: "mb_junk", parentId: null, name: "Junk", role: "junk", sortOrder: 5 }],
  ["mb_trash", { id: "mb_trash", parentId: null, name: "Trash", role: "trash", sortOrder: 6 }],
]);
let mailboxState = "mbstate-1";
let created = 0;
/** Email state advances on every Email/set that mutates — the ifInState axis. */
let emailState = "emstate-1";

/** Calendar CRUD (sVOL 018). getOccurrences stays unimplemented on purpose —
 * the exit-5/§1.5 case above drives `agenda` through it as an unknownMethod. */
let calState = "calstate-1";
const calendars = new Map([["cal_default", { id: "cal_default", name: "Personal", isDefault: true }]]);
const calEvents = new Map();
let calSeq = 0;
const bumpCal = (res) => {
  calState = `calstate-${Number(calState.split("-")[1]) + 1}`;
  res.newState = calState;
};

/** Twelve messages, so `| head -3` has something to truncate. */
const emails = Array.from({ length: 12 }, (_, i) => ({
  id: `em_${String(i).padStart(3, "0")}`,
  blobId: `b_${i}`,
  threadId: `th_${i}`,
  mailboxIds: { mb_inbox: true },
  keywords: i % 2 === 0 ? { $seen: true } : {},
  size: 1024 + i,
  receivedAt: new Date(Date.UTC(2026, 0, 1 + i, 12)).toISOString(),
  messageId: [`<${i}@smoke.test>`],
  inReplyTo: null,
  from: [{ name: `Sender ${i}`, email: `s${i}@smoke.test` }],
  to: [{ name: null, email: "you@smoke.test" }],
  cc: null,
  bcc: null,
  subject: i === 3 ? "invoice for pipes" : `message number ${i}`,
  hasAttachment: false,
  preview: `preview of message ${i}`,
  attachments: [],
  bodyValues: { t: { value: `body of message ${i}` } },
  textBody: [{ partId: "t", type: "text/plain" }],
}));

/**
 * Contacts fixtures for the sVOL-017 pipes: two books and three cards, so
 * `export` has more than one line to stream, `--book` has something to filter,
 * and `--ids | xargs show` fans real ids back in. As with the mail methods,
 * this is the minimum that lets a command produce output, not a JMAP contacts
 * implementation.
 */
const addressBooks = [
  { id: "ab_personal", name: "Personal", isDefault: true, myRights: { mayWrite: true } },
  { id: "ab_work", name: "Work", isDefault: false, myRights: { mayWrite: true } },
];
const contactCards = [
  {
    id: "cc_ada",
    "@type": "Card",
    version: "1.0",
    uid: "urn:uuid:ada",
    name: { full: "Ada Lovelace" },
    emails: { e1: { address: "ada@smoke.test" } },
    addressBookIds: { ab_personal: true },
  },
  {
    id: "cc_grace",
    "@type": "Card",
    version: "1.0",
    uid: "urn:uuid:grace",
    name: { full: "Grace Hopper" },
    emails: { e1: { address: "grace@smoke.test" } },
    addressBookIds: { ab_personal: true },
  },
  {
    id: "cc_alan",
    "@type": "Card",
    version: "1.0",
    uid: "urn:uuid:alan",
    name: { full: "Alan Turing" },
    emails: { e1: { address: "alan@smoke.test" } },
    addressBookIds: { ab_work: true },
  },
];

/**
 * The agent plane (s26 T6b): two bindings and the console projection the
 * dossier verbs read, plus enough of `AgentBinding/set` to make `disable` a
 * REAL state change — the smoke needs `show` to reflect what `disable` wrote,
 * not to agree with a constant.
 *
 * `extractor` carries a menu, a budget and a ledger; `emily` deliberately
 * carries none of it, because "a binding with no config door" is one of the
 * refusals under test.
 */
const bindings = new Map([
  [
    "bind_extract",
    {
      bindingId: "bind_extract",
      name: "extractor",
      triggerOn: "mailbox-delivery",
      slaSeconds: null,
      enabled: true,
      config: { pipeline: "extract", replyMode: "draft", hasPersona: false, modelAliasCount: 1 },
      economics: {
        budgetMicros: 2_000_000,
        defaultModel: "extract",
        modelMenu: [{ alias: "extract", candidates: ["openrouter/minimax/minimax-m3", "openrouter/qwen/qwen3-30b"] }],
        exploreRate: 0.2,
      },
    },
  ],
  [
    "bind_emily",
    {
      bindingId: "bind_emily",
      name: "emily",
      triggerOn: "mailbox-delivery",
      slaSeconds: 3600,
      enabled: true,
      config: { pipeline: "reply", replyMode: "draft", hasPersona: true },
      economics: { budgetMicros: null, defaultModel: null, modelMenu: [], exploreRate: null },
    },
  ],
]);

const agentInvocations = [
  {
    invocationId: "inv_aaa",
    bindingId: "bind_extract",
    bindingName: "extractor",
    status: "done",
    emailId: "em_000",
    note: null,
    createdAt: 1_760_000_000_000,
    doneAt: 1_760_000_001_000,
    costMicros: 2100,
    model: "openrouter/minimax/minimax-m3",
  },
  {
    // NULL cost is "undetermined", not free — the dossier must not print $0.00.
    invocationId: "inv_bbb",
    bindingId: "bind_extract",
    bindingName: "extractor",
    status: "failed",
    emailId: "em_001",
    note: null,
    createdAt: 1_759_000_000_000,
    doneAt: 1_759_000_002_000,
    costMicros: null,
    model: null,
  },
];

const err = (type, description) => ["error", description ? { type, description } : { type }, "c0"];

/** RFC 8620 PatchObject set semantics: full-replace (no sub) or per-key add/remove. */
function applySetPatch(target, sub, value) {
  if (sub === undefined) {
    target.clear();
    for (const [k, v] of Object.entries(value ?? {})) if (v === true) target.add(k);
  } else if (value === true) {
    target.add(sub);
  } else {
    target.delete(sub); // null or false
  }
}

function invoke([name, args, callId]) {
  const reply = (result) => [name, result, callId];

  switch (name) {
    case "Mailbox/get":
      return reply({ accountId: ACCOUNT, state: mailboxState, list: [...mailboxes.values()] });

    case "Mailbox/set": {
      // The whole point of the exit-5 test: honour ifInState exactly as
      // services/jmap/src/methods/mailbox.ts does.
      if (typeof args.ifInState === "string" && args.ifInState !== mailboxState) {
        return err("stateMismatch");
      }
      const oldState = mailboxState;
      const res = {
        accountId: ACCOUNT,
        oldState,
        newState: mailboxState,
        created: {},
        updated: {},
        destroyed: [],
        notCreated: {},
        notUpdated: {},
        notDestroyed: {},
      };
      let mutated = false;
      for (const [cid, spec] of Object.entries(args.create ?? {})) {
        const id = `mb_new_${++created}`;
        mailboxes.set(id, {
          id,
          parentId: spec.parentId ?? null,
          name: spec.name,
          role: null,
          sortOrder: spec.sortOrder ?? 0,
        });
        res.created[cid] = { id, role: null, sortOrder: spec.sortOrder ?? 0 };
        mutated = true;
      }
      for (const [id, patch] of Object.entries(args.update ?? {})) {
        const box = mailboxes.get(id);
        if (!box) {
          res.notUpdated[id] = { type: "notFound" };
          continue;
        }
        Object.assign(box, patch);
        res.updated[id] = null;
        mutated = true;
      }
      for (const id of args.destroy ?? []) {
        if (!mailboxes.has(id)) {
          res.notDestroyed[id] = { type: "notFound" };
          continue;
        }
        // `Full` holds mail: refused without onDestroyRemoveEmails, which is
        // the RFC 8621 default and the exit-5-from-a-SetError case.
        if (id === "mb_full" && args.onDestroyRemoveEmails !== true) {
          res.notDestroyed[id] = { type: "mailboxHasEmail", description: "3 messages" };
          continue;
        }
        mailboxes.delete(id);
        res.destroyed.push(id);
        mutated = true;
      }
      if (mutated) {
        mailboxState = `mbstate-${Number(mailboxState.split("-")[1]) + 1}`;
        res.newState = mailboxState;
      }
      return reply(res);
    }

    case "Email/query": {
      const position = args.position ?? 0;
      const limit = args.limit ?? 50;
      const asc = args.sort?.[0]?.isAscending !== false;
      const ordered = asc ? emails : [...emails].reverse();
      return reply({
        accountId: ACCOUNT,
        queryState: emailState,
        position,
        ids: ordered.slice(position, position + limit).map((e) => e.id),
      });
    }

    case "Email/changes":
      return reply({
        accountId: ACCOUNT,
        oldState: args.sinceState,
        newState: emailState,
        hasMoreChanges: false,
        created: [],
        updated: [],
        destroyed: [],
      });

    case "Email/get": {
      const ids = args.ids ?? [];
      const list = emails.filter((e) => ids.includes(e.id));
      return reply({
        accountId: ACCOUNT,
        state: emailState,
        list,
        notFound: ids.filter((id) => !list.some((e) => e.id === id)),
      });
    }

    case "Email/set": {
      // sVOL 019's target. Honours ifInState exactly as
      // services/jmap/src/methods/email.ts does, and MUTATES the fixture so a
      // reconcile (Email/get) and a second client's sync both see the change —
      // the choreography and mirror assertions in the unit's done-when.
      if (typeof args.ifInState === "string" && args.ifInState !== emailState) {
        return err("stateMismatch");
      }
      const res = {
        accountId: ACCOUNT,
        oldState: emailState,
        newState: emailState,
        created: {},
        notCreated: {},
        updated: {},
        notUpdated: {},
        destroyed: [],
        notDestroyed: {},
      };
      let mutated = false;

      for (const [id, patch] of Object.entries(args.update ?? {})) {
        const e = emails.find((x) => x.id === id);
        if (!e) {
          res.notUpdated[id] = { type: "notFound" };
          continue;
        }
        const kw = new Set(Object.keys(e.keywords ?? {}));
        const mb = new Set(Object.keys(e.mailboxIds ?? {}));
        let touchedMb = false;
        let bad = null;
        for (const [path, value] of Object.entries(patch)) {
          const [head, sub] = path.split("/");
          if (head === "keywords") applySetPatch(kw, sub, value);
          else if (head === "mailboxIds") {
            touchedMb = true;
            applySetPatch(mb, sub, value);
          } else {
            bad = { type: "invalidProperties", description: `unknown path ${path}` };
            break;
          }
        }
        if (bad) {
          res.notUpdated[id] = bad;
          continue;
        }
        // The RFC 8621 guard the CLI is supposed to pre-empt client-side.
        if (touchedMb && mb.size === 0) {
          res.notUpdated[id] = {
            type: "invalidProperties",
            description: "an email must belong to at least one mailbox",
          };
          continue;
        }
        e.keywords = Object.fromEntries([...kw].map((k) => [k, true]));
        e.mailboxIds = Object.fromEntries([...mb].map((k) => [k, true]));
        res.updated[id] = null;
        mutated = true;
      }

      for (const id of args.destroy ?? []) {
        const idx = emails.findIndex((x) => x.id === id);
        if (idx === -1) {
          res.notDestroyed[id] = { type: "notFound" };
          continue;
        }
        emails.splice(idx, 1); // HARD delete — no tombstone, mirrors the store
        res.destroyed.push(id);
        mutated = true;
      }

      if (mutated) {
        emailState = `emstate-${Number(emailState.split("-")[1]) + 1}`;
        res.newState = emailState;
      }
      return reply(res);
    }

    case "Identity/get":
      return reply({
        accountId: ACCOUNT,
        state: "1",
        list: [{ id: "id_1", email: "you@smoke.test", name: "You" }],
      });

    // ---- the kill switch (s26 T2 / #198) --------------------------------
    // v1 writes exactly `enabled`; anything else is refused BY NAME, which is
    // the behaviour the CLI must surface verbatim rather than re-word.
    case "AgentBinding/set": {
      const updated = {};
      const notUpdated = {};
      for (const [id, patch] of Object.entries(args.update ?? {})) {
        const binding = bindings.get(id);
        if (!binding) {
          notUpdated[id] = { type: "notFound", description: "no such binding on this account" };
          continue;
        }
        const unknown = Object.keys(patch).filter((k) => k !== "enabled");
        if (unknown.length > 0) {
          notUpdated[id] = {
            type: "invalidProperties",
            description: `AgentBinding/set v1 writes exactly one property, "enabled" (the kill switch). Refused: ${unknown.join(", ")}`,
            properties: unknown,
          };
          continue;
        }
        binding.enabled = patch.enabled === true;
        updated[id] = { enabled: binding.enabled };
      }
      return reply({ accountId: ACCOUNT, updated, notUpdated });
    }

    // ---- contacts (sVOL 017) --------------------------------------------
    case "AddressBook/get":
      return reply({ accountId: ACCOUNT, state: "abstate-1", list: addressBooks, notFound: [] });

    case "ContactCard/query": {
      const bookId = args.filter?.inAddressBook;
      const matched = bookId ? contactCards.filter((c) => c.addressBookIds[bookId]) : contactCards;
      const position = args.position ?? 0;
      const limit = args.limit ?? 256;
      return reply({
        accountId: ACCOUNT,
        queryState: "ccstate-1",
        position,
        ids: matched.slice(position, position + limit).map((c) => c.id),
      });
    }

    case "ContactCard/get": {
      const ids = args.ids ?? [];
      const list = contactCards.filter((c) => ids.includes(c.id));
      return reply({
        accountId: ACCOUNT,
        state: "ccstate-1",
        list,
        notFound: ids.filter((id) => !list.some((c) => c.id === id)),
      });
    }
    // ---- calendar CRUD (sVOL 018) --------------------------------------
    case "Calendar/get": {
      const ids = args.ids == null ? null : args.ids;
      const list = [...calendars.values()].filter((c) => !ids || ids.includes(c.id));
      return reply({
        accountId: ACCOUNT,
        state: calState,
        list,
        notFound: (ids ?? []).filter((id) => !calendars.has(id)),
      });
    }

    case "Calendar/set": {
      if (typeof args.ifInState === "string" && args.ifInState !== calState) return err("stateMismatch");
      const res = {
        accountId: ACCOUNT,
        oldState: calState,
        newState: calState,
        created: {},
        updated: {},
        destroyed: [],
        notCreated: {},
        notUpdated: {},
        notDestroyed: {},
      };
      let mutated = false;
      for (const [cid, spec] of Object.entries(args.create ?? {})) {
        const id = `cal_new_${++calSeq}`;
        calendars.set(id, { id, name: spec.name, isDefault: false });
        res.created[cid] = { id, isDefault: false };
        mutated = true;
      }
      for (const [id, patch] of Object.entries(args.update ?? {})) {
        const c = calendars.get(id);
        if (!c) {
          res.notUpdated[id] = { type: "notFound" };
          continue;
        }
        Object.assign(c, patch);
        res.updated[id] = null;
        mutated = true;
      }
      for (const id of args.destroy ?? []) {
        if (!calendars.has(id)) {
          res.notDestroyed[id] = { type: "notFound" };
          continue;
        }
        const hasEvents = [...calEvents.values()].some((e) => e.calendarId === id);
        if (hasEvents && args.onDestroyRemoveEvents !== true) {
          res.notDestroyed[id] = { type: "calendarHasEvents", description: "has events" };
          continue;
        }
        for (const [eid, e] of [...calEvents]) if (e.calendarId === id) calEvents.delete(eid);
        calendars.delete(id);
        res.destroyed.push(id);
        mutated = true;
      }
      if (mutated) bumpCal(res);
      return reply(res);
    }

    case "CalendarEvent/set": {
      if (typeof args.ifInState === "string" && args.ifInState !== calState) return err("stateMismatch");
      const res = {
        accountId: ACCOUNT,
        oldState: calState,
        newState: calState,
        created: {},
        updated: {},
        destroyed: [],
        notCreated: {},
        notUpdated: {},
        notDestroyed: {},
      };
      let mutated = false;
      const defaultCal = [...calendars.values()].find((c) => c.isDefault)?.id ?? "cal_default";
      for (const [cid, spec] of Object.entries(args.create ?? {})) {
        const { calendarIds, ...event } = spec;
        const calId = calendarIds ? Object.keys(calendarIds)[0] : defaultCal;
        if (!calendars.has(calId)) {
          res.notCreated[cid] = {
            type: "invalidProperties",
            description: `no such calendar: ${calId}`,
          };
          continue;
        }
        const id = `ev_new_${++calSeq}`;
        const uid = event.uid ?? `urn:uuid:${id}`;
        calEvents.set(id, { id, calendarId: calId, uid, event: { ...event, uid } });
        res.created[cid] = { id, uid };
        mutated = true;
      }
      for (const [id, patch] of Object.entries(args.update ?? {})) {
        const e = calEvents.get(id);
        if (!e) {
          res.notUpdated[id] = { type: "notFound" };
          continue;
        }
        Object.assign(e.event, patch); // top-level PatchObject is all the CLI sends
        res.updated[id] = null;
        mutated = true;
      }
      for (const id of args.destroy ?? []) {
        if (!calEvents.has(id)) {
          res.notDestroyed[id] = { type: "notFound" };
          continue;
        }
        calEvents.delete(id);
        res.destroyed.push(id);
        mutated = true;
      }
      if (mutated) bumpCal(res);
      return reply(res);
    }

    case "CalendarEvent/get": {
      const ids = args.ids == null ? [...calEvents.keys()] : args.ids;
      const list = ids
        .filter((id) => calEvents.has(id))
        .map((id) => {
          const e = calEvents.get(id);
          return { ...e.event, id: e.id, calendarIds: { [e.calendarId]: true } };
        });
      return reply({
        accountId: ACCOUNT,
        state: calState,
        list,
        notFound: (args.ids ?? []).filter((id) => !calEvents.has(id)),
      });
    }

    case "CalendarEvent/query": {
      const inCal = args.filter?.inCalendar;
      const ids = [...calEvents.values()].filter((e) => !inCal || e.calendarId === inCal).map((e) => e.id);
      return reply({
        accountId: ACCOUNT,
        queryState: calState,
        canCalculateChanges: false,
        position: 0,
        ids,
      });
    }

    // Deliberately unimplemented, to exercise the method-error → exit-code path.
    case "CalendarEvent/getOccurrences":
      return err("unknownMethod");

    default:
      return err("unknownMethod", name);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const auth = req.headers.authorization ?? "";
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // Anything with `deny` in the path answers 403 — the exit-4 fixture.
  if (url.pathname.includes("deny")) return send(403, { error: "forbidden" });
  if (auth !== `Bearer ${TOKEN}`) return send(401, { error: "bad token" });

  if (url.pathname === "/.well-known/jmap") {
    return send(200, {
      username: "you@smoke.test",
      accounts: { [ACCOUNT]: { name: "you@smoke.test" } },
      primaryAccounts: {
        "urn:ietf:params:jmap:mail": ACCOUNT,
        "urn:ietf:params:jmap:submission": ACCOUNT,
      },
      apiUrl: `http://127.0.0.1:${server.address().port}/api`,
      downloadUrl: `http://127.0.0.1:${server.address().port}/api/download/{accountId}/{blobId}`,
    });
  }

  if (url.pathname === "/api" && req.method === "POST") {
    const body = JSON.parse(await text(req));
    return send(200, { methodResponses: (body.methodCalls ?? []).map(invoke) });
  }

  // The console projection (s03.E / s26 T1) — the dossier verbs' READ door.
  // Session-reachable on the ordinary mail token, which is the property the
  // smoke exercises: no operator credential is configured anywhere here.
  if (url.pathname.startsWith("/console/agents/")) {
    return send(200, {
      accountId: ACCOUNT,
      principalId: "p_you",
      principal: "you@smoke.test",
      tokenScopes: ["mail"],
      bindings: [...bindings.values()],
      credentials: [],
      bureauGrants: [],
      grantsHeld: [],
      grantsGiven: [],
      invocations: agentInvocations,
      spend: { currency: "USD", totalCents: 0, rows: 1, since: 1_759_000_000_000 },
      ledgers: [
        {
          bindingId: "bind_extract",
          pending: 3,
          running: 0,
          done: 128,
          failed: 1,
          oldestPendingAt: 1_760_100_000_000,
          monthSpendMicros: 410_000,
          monthOverageMicros: 100_000,
        },
      ],
      ledgerMonthStart: 1_754_006_400_000,
    });
  }

  if (url.pathname.startsWith("/api/blobs/")) {
    if (req.method === "DELETE") {
      // Content-addressed blobs are shared, so a referenced one is refused —
      // a 409, which the exit-code table maps to 5.
      const blobId = url.pathname.split("/").pop();
      // A refusal whose reason is named in a vocabulary the exit-code table does
      // NOT know: the 409 still has to decide the code.
      if (blobId === "b_0") return send(409, { type: "blobInUse", error: "blob in use by em_000" });
      // And a plain server fault, which nothing but exit 1 fits.
      if (blobId === "b_boom") return send(500, { error: "storage unavailable" });
      return send(200, { blobId });
    }
    return send(200, {
      accountId: ACCOUNT,
      blobs: emails.slice(0, 3).map((e, i) => ({
        blobId: e.blobId,
        size: 4096 * (i + 1),
        uploaded: "2026-01-01T00:00:00.000Z",
      })),
      totalSize: 4096 + 8192 + 12288,
    });
  }

  if (url.pathname.startsWith("/api/shares/")) {
    if (req.method === "POST") {
      return send(200, {
        shareId: url.pathname.split("/").at(-2),
        revoked: true,
        alreadyRevoked: false,
        blobId: "b_0",
        note: "allow up to a minute to reach every edge",
      });
    }
    return send(200, {
      accountId: ACCOUNT,
      shares: [
        {
          shareId: "sh_live",
          blobId: "b_0",
          name: "report.pdf",
          expiresAt: "2026-09-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          live: true,
        },
        {
          shareId: "sh_dead",
          blobId: "b_1",
          name: "old.pdf",
          expiresAt: "2026-02-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          live: false,
          revokedAt: "2026-01-15T00:00:00.000Z",
        },
      ],
    });
  }

  if (url.pathname === "/auth/tokens") {
    if (req.method === "POST") {
      const body = JSON.parse(await text(req));
      return send(200, { tokenId: "tk_new", token: "bm_minted_secret", scopes: body.scopes });
    }
    return send(200, {
      tokens: [
        { id: "tk_1", name: "laptop", scopes: '["read"]', created_at: 0, last_used_at: null },
        { id: "tk_2", name: "phone", scopes: '["read","send"]', created_at: 0, last_used_at: 0 },
      ],
    });
  }

  if (url.pathname.startsWith("/api/download/")) {
    res.writeHead(200, { "content-type": "message/rfc822" });
    return res.end("Subject: raw\r\n\r\nraw body\r\n");
  }

  send(404, { error: "no such endpoint" });
});

const text = (req) =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body || "{}"));
  });

server.listen(0, "127.0.0.1", () => {
  // The driver reads this line to learn the port, then keeps the pipe open.
  process.stdout.write(`READY ${server.address().port} ${ACCOUNT} ${TOKEN}\n`);
});
