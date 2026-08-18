// An in-memory bullmoose, wired into `FakeJmapClient`.
//
// Two jobs, both of which T1 anticipated ("the T2/T3 UI — develop mail surfaces
// against this before the real endpoints are reachable"):
//
//   • **Tests.** The mail modules are exercised end to end — open a thread,
//     archive it, watch the list change — with no network and no server.
//   • **`astro dev`.** The UI is drivable before a bullmoose is reachable, which
//     is what makes the surfaces reviewable at all.
//
// It mirrors the SERVER's semantics on purpose, warts included, because a fake
// that is kinder than the real thing hides exactly the bugs it should catch:
//
//   • `Email/queryChanges` throws `cannotCalculateChanges` and `Email/query`
//     reports `canCalculateChanges: false` (`services/jmap/src/methods/email.ts`).
//   • the `text` filter is a LIKE over subject / preview / from / to ONLY —
//     bodies are not searchable (`packages/mailstore/src/index.ts` `buildFilter`).
//   • `Email/set update` accepts only `keywords` and `mailboxIds` paths, and
//     refuses to leave a message in zero mailboxes (`applyEmailPatch`).
//   • `EmailSubmission/set` refuses a message that is not a draft (`submitOne`).
//   • per-operation scopes gate `Email/set` (`requiredScopesForEmailSet`).

import type { Email, Identity, Mailbox } from "../mail/types";
import type { EmailFilter, EmailFilterCondition } from "../mail/search";
import { AGENT_CAP } from "./capabilities";
import { FakeJmapClient, defaultSession } from "./FakeJmapClient";
import type { MethodHandler } from "./FakeJmapClient";

const ACCOUNT = "acct-fake";

/** The binding the verb door names (`lib/verbs/contract.ts VERB_BINDING_NAME`).
 *  Spelled here rather than imported so the demo stays a MIRROR of a server:
 *  when the two disagree, the "no agent is set up yet" path is what renders,
 *  which is exactly the behaviour worth being able to see. */
const DEMO_BINDING = "extractor";

export interface DemoOptions {
  /**
   * Mail verbs this session holds. Default: everything. Narrow it to prove the
   * scoped-token refusal path — `["read", "annotate"]` can flag but not move.
   */
  scopes?: string[];
  emails?: Email[];
  mailboxes?: Mailbox[];
  identities?: Identity[];
  /**
   * Advertise `urn:bullmoose:params:jmap:agent`? Default true. Set false to
   * DRIVE the plain-client floor (arch.md §8.6) rather than only unit-testing
   * it: with the capability absent, no agent surface may render, error, or
   * leave a dead region. Same intent as `scopes` above — a demo knob whose
   * whole purpose is to make a refusal path reachable in a browser.
   */
  agentCapability?: boolean;
}

export interface DemoBackend {
  client: FakeJmapClient;
  mailboxes: Mailbox[];
  emails: Email[];
  identities: Identity[];
  /** Submissions the demo "sent" — assert against this instead of a relay. */
  sent: Array<{ emailId: string; identityId: string; rcptTo: string[] }>;
  /** The margin's rows (s18 A3), anchored to the demo mail — mutated by
   *  `Annotation/set`, so a test can watch a dismissal land. */
  annotations: Array<Record<string, unknown>>;
  /** s20 T2 — what the verbs wrote: watches armed by `Watch/set`, and
   *  invocations queued by `AgentInvocation/set`. Assert against these
   *  instead of a runtime; the demo has none. */
  watches: Record<string, Record<string, unknown>>;
  invocations: Array<Record<string, unknown>>;
  state(): string;
}

// ── fixtures ──────────────────────────────────────────────────────────────

export function demoMailboxes(): Mailbox[] {
  const base = {
    parentId: null,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: false,
      mayDelete: false,
      maySubmit: true,
    },
    isSubscribed: true,
  };
  return [
    { ...base, id: "mb-inbox", name: "Inbox", role: "inbox", sortOrder: 0 },
    { ...base, id: "mb-drafts", name: "Drafts", role: "drafts", sortOrder: 1 },
    { ...base, id: "mb-sent", name: "Sent", role: "sent", sortOrder: 2 },
    { ...base, id: "mb-archive", name: "Archive", role: "archive", sortOrder: 3 },
    // The registered `junk` role, displayed with s12's vocabulary. The demo
    // keeps it in the Mailbox/get list on purpose — a standards client would
    // see it — and the sidebar filters it (`UNBROWSABLE_ROLES`), which is
    // exactly the split being demonstrated.
    { ...base, id: "mb-junk", name: "Quarantined", role: "junk", sortOrder: 4 },
    { ...base, id: "mb-trash", name: "Trash", role: "trash", sortOrder: 5 },
    {
      ...base,
      id: "mb-project",
      name: "Project Elk",
      role: null,
      sortOrder: 10,
      myRights: { ...base.myRights, mayRename: true, mayDelete: true },
    },
  ];
}

export function demoIdentities(): Identity[] {
  return [
    {
      id: "id-primary",
      name: "Eric Moore",
      email: "eric@bullmoose.test",
      replyTo: null,
      bcc: null,
      textSignature: "Eric\nbullmoose.cc",
      htmlSignature: "",
      mayDelete: false,
    },
  ];
}

let seq = 0;
function makeEmail(partial: Partial<Email> & Pick<Email, "subject">): Email {
  const n = ++seq;
  const id = partial.id ?? `e-${n}`;
  return {
    id,
    blobId: partial.blobId ?? `blob-${n}`,
    threadId: partial.threadId ?? `t-${n}`,
    mailboxIds: partial.mailboxIds ?? { "mb-inbox": true },
    keywords: partial.keywords ?? {},
    size: partial.size ?? 2048,
    receivedAt: partial.receivedAt ?? new Date(Date.UTC(2026, 6, 1, 9, 0, 0) + n * 3_600_000).toISOString(),
    messageId: partial.messageId ?? [`${id}@bullmoose.test`],
    inReplyTo: partial.inReplyTo ?? null,
    from: partial.from ?? [{ name: "Ada Lovelace", email: "ada@example.test" }],
    to: partial.to ?? [{ name: "Eric Moore", email: "eric@bullmoose.test" }],
    cc: partial.cc ?? [],
    bcc: partial.bcc ?? [],
    subject: partial.subject,
    sentAt: null,
    hasAttachment: partial.hasAttachment ?? false,
    preview: partial.preview ?? "",
    attachments: partial.attachments ?? [],
    ...(partial.bodyValues ? { bodyValues: partial.bodyValues } : {}),
    ...(partial.textBody ? { textBody: partial.textBody } : {}),
    ...(partial.htmlBody ? { htmlBody: partial.htmlBody } : {}),
  };
}

/** A small but structurally varied mailbox: a thread, HTML, a tracking pixel. */
export function demoEmails(): Email[] {
  seq = 0;
  return [
    makeEmail({
      id: "e-welcome",
      threadId: "t-welcome",
      subject: "Welcome to bullmoose",
      from: [{ name: "bullmoose", email: "hello@bullmoose.test" }],
      preview: "Your mail is now served over JMAP.",
      textBody: [{ partId: "t", blobId: null, type: "text/plain" }],
      bodyValues: {
        t: { value: "Your mail is now served over JMAP.\n\nNothing here polls.\n\n-- \nbullmoose" },
      },
    }),
    makeEmail({
      id: "e-newsletter",
      threadId: "t-newsletter",
      subject: "The Analytical Engine Weekly",
      from: [{ name: "Engine Weekly", email: "news@example.test" }],
      keywords: {},
      preview: "This week: punch cards, and why they still matter.",
      hasAttachment: false,
      htmlBody: [{ partId: "h", blobId: null, type: "text/html" }],
      bodyValues: {
        h: {
          value:
            "<div><h2>Punch cards</h2><p>Still <b>relevant</b>. " +
            '<a href="https://example.test/read">Read on</a>.</p>' +
            '<img src="https://tracker.example.test/open.gif" width="1" height="1"></div>',
        },
      },
    }),
    makeEmail({
      id: "e-thread-1",
      threadId: "t-elk",
      subject: "Project Elk kickoff",
      from: [{ name: "Grace Hopper", email: "grace@example.test" }],
      keywords: { $seen: true },
      preview: "Kicking this off Monday.",
      textBody: [{ partId: "t", blobId: null, type: "text/plain" }],
      bodyValues: { t: { value: "Kicking this off Monday. Agenda attached next time." } },
    }),
    makeEmail({
      id: "e-thread-2",
      threadId: "t-elk",
      subject: "Re: Project Elk kickoff",
      from: [{ name: "Eric Moore", email: "eric@bullmoose.test" }],
      to: [{ name: "Grace Hopper", email: "grace@example.test" }],
      keywords: { $seen: true },
      mailboxIds: { "mb-inbox": true, "mb-project": true },
      inReplyTo: ["e-thread-1@bullmoose.test"],
      preview: "Monday works.",
      textBody: [{ partId: "t", blobId: null, type: "text/plain" }],
      bodyValues: {
        t: {
          value:
            "Monday works.\n\nOn 2026-07-01 12:00 UTC, Grace Hopper <grace@example.test> wrote:\n> Kicking this off Monday.",
        },
      },
    }),
    makeEmail({
      id: "e-invoice",
      threadId: "t-invoice",
      subject: "Invoice 0042",
      from: [{ name: "Accounts", email: "billing@example.test" }],
      hasAttachment: true,
      preview: "Attached.",
      attachments: [
        {
          partId: null,
          blobId: "blob-invoice",
          size: 18_442,
          name: "invoice-0042.pdf",
          type: "application/pdf",
          cid: null,
          disposition: "attachment",
        },
      ],
      textBody: [{ partId: "t", blobId: null, type: "text/plain" }],
      bodyValues: { t: { value: "Attached." } },
    }),
  ];
}

/**
 * The margin's demo rows (s18 A3), anchored to the demo mail above so
 * `/mail?demo=1` shows a real margin: open the **Project Elk** thread for the
 * three voices (assert / "Sounds like" / a dismissed one rendering muted), the
 * **Invoice 0042** thread for the hedging register and a null rationale
 * ("Why: not stated"). Every anchor names an ORIGINAL message id — the reply
 * `e-thread-2` quotes Grace's kickoff sentence, and precisely because anchors
 * bind to the original, the quoted copy never grows a duplicate note.
 */
export function demoAnnotations(): Array<Record<string, unknown>> {
  const day = 86_400_000;
  const now = Date.UTC(2026, 6, 3, 12, 0, 0);
  return [
    {
      id: "an-elk-decision",
      authorKind: "agent",
      author: "scribe",
      anchor: { realm: "Email", objectId: "e-thread-1" },
      class: "decision",
      body: "Project Elk kicks off Monday",
      confidence: 0.95,
      status: "open",
      rationale: "“Kicking this off Monday.”",
      sourceRef: "e-thread-1",
      createdAt: now - 2 * day,
      updatedAt: now - 2 * day,
    },
    {
      id: "an-elk-commitment",
      authorKind: "agent",
      author: "scribe",
      anchor: { realm: "Email", objectId: "e-thread-2" },
      class: "commitment",
      body: "You told Grace Monday works for the kickoff",
      confidence: 0.72,
      status: "open",
      rationale: null,
      sourceRef: "e-thread-2",
      createdAt: now - 2 * day,
      updatedAt: now - 2 * day,
    },
    {
      // Dismissed: renders muted, no verbs — the judgment is the record.
      id: "an-elk-task-dismissed",
      authorKind: "agent",
      author: "scribe",
      anchor: { realm: "Email", objectId: "e-thread-1" },
      class: "task",
      body: "Prepare an agenda before the kickoff",
      confidence: 0.55,
      status: "dismissed",
      rationale: "“Agenda attached next time” sounded like a to-do",
      sourceRef: "e-thread-1",
      createdAt: now - 2 * day,
      updatedAt: now - 1 * day,
    },
    {
      id: "an-invoice-task",
      authorKind: "agent",
      author: "scribe",
      anchor: { realm: "Email", objectId: "e-invoice" },
      class: "task",
      body: "Invoice 0042 wants paying",
      confidence: 0.4,
      status: "open",
      rationale: null,
      sourceRef: "e-invoice",
      createdAt: now - 1 * day,
      updatedAt: now - 1 * day,
    },
  ];
}

// ── the backend ───────────────────────────────────────────────────────────

export function createDemoBackend(opts: DemoOptions = {}): DemoBackend {
  const mailboxes = opts.mailboxes ?? demoMailboxes();
  const emails = opts.emails ?? demoEmails();
  const identities = opts.identities ?? demoIdentities();
  const scopes = new Set(opts.scopes ?? ["read", "annotate", "draft", "move", "send", "delete"]);
  const sent: DemoBackend["sent"] = [];
  const annotations = demoAnnotations();
  let stateCounter = 0;
  const state = (): string => String(stateCounter);
  const bump = (): string => String(++stateCounter);

  /**
   * The `responders` row behind the `VacationResponse` facade — one row, five
   * columns, which is all `VacationResponse/set` ever writes
   * (`services/jmap/src/methods/vacation.ts:50-60`). Starts unset, the state a
   * freshly provisioned account is in.
   */
  let vacation: {
    isEnabled: boolean;
    subject: string | null;
    textBody: string | null;
    fromDate: string | null;
    toDate: string | null;
  } = { isEnabled: false, subject: null, textBody: null, fromDate: null, toDate: null };

  const findEmail = (id: string): Email | undefined => emails.find((e) => e.id === id);

  // s20 T2 — what the two verb doors write. Armed watches and queued
  // invocations, in this tab only: no runtime claims them here, so a demo
  // "Answer" ends where the real one begins — a row waiting for an agent.
  const watches: Record<string, Record<string, unknown>> = {};
  const invocations: Array<Record<string, unknown>> = [];

  const counts = (mailboxId: string) => {
    const inBox = emails.filter((e) => e.mailboxIds[mailboxId] === true);
    return {
      totalEmails: inBox.length,
      unreadEmails: inBox.filter((e) => e.keywords.$seen !== true).length,
      totalThreads: new Set(inBox.map((e) => e.threadId)).size,
      unreadThreads: new Set(inBox.filter((e) => e.keywords.$seen !== true).map((e) => e.threadId)).size,
    };
  };

  const handlers: Record<string, MethodHandler> = {
    "Mailbox/get": (args) => {
      const ids = args.ids as string[] | null | undefined;
      const rows = ids ? mailboxes.filter((m) => ids.includes(m.id)) : mailboxes;
      return {
        accountId: ACCOUNT,
        state: state(),
        list: rows.map((m) => ({ ...m, ...counts(m.id) })),
        notFound: (ids ?? []).filter((id) => !mailboxes.some((m) => m.id === id)),
      };
    },

    "Identity/get": () => ({
      accountId: ACCOUNT,
      state: state(),
      list: identities,
      notFound: [],
    }),

    /**
     * `Identity/set`, warts included — the three refusals a settings screen has
     * to survive (`services/jmap/src/methods/identity.ts`):
     *   • `ifInState` is COMPARED and a mismatch refuses the whole call (:207-210);
     *   • `id` / `mayDelete` in a patch fail it entirely (`rejectServerSet`, :430-437);
     *   • `email` is immutable and refused by name (:478-483).
     * Only `update` is modelled: `/settings` never creates or destroys an
     * identity, and a create would also need the active-domain check (:459-462)
     * which the demo has no domain table to answer.
     */
    "Identity/set": (args) => {
      if (!scopes.has("draft")) {
        return ["error", { type: "forbidden", description: "token lacks scope: draft" }];
      }
      const oldState = state();
      if (typeof args.ifInState === "string" && args.ifInState !== oldState) {
        return ["error", { type: "stateMismatch" }];
      }

      const updated: Record<string, null> = {};
      const notUpdated: Record<string, unknown> = {};
      for (const [id, patch] of Object.entries(
        (args.update as Record<string, Record<string, unknown>> | undefined) ?? {},
      )) {
        const row = identities.find((i) => i.id === id);
        if (!row) {
          notUpdated[id] = { type: "notFound" };
          continue;
        }
        const serverSet = ["id", "mayDelete"].filter((p) => p in patch);
        if (serverSet.length > 0) {
          notUpdated[id] = {
            type: "invalidProperties",
            description: `${serverSet.join(", ")} is set by the server`,
            properties: serverSet,
          };
          continue;
        }
        if ("email" in patch) {
          notUpdated[id] = {
            type: "invalidProperties",
            description: "email is immutable; destroy the identity and create another",
            properties: ["email"],
          };
          continue;
        }
        const unknownProps = Object.keys(patch).filter(
          (k) => !["name", "replyTo", "bcc", "textSignature", "htmlSignature"].includes(k),
        );
        if (unknownProps.length > 0) {
          notUpdated[id] = {
            type: "invalidProperties",
            description: `unknown properties: ${unknownProps.join(", ")}`,
            properties: unknownProps,
          };
          continue;
        }
        Object.assign(row, patch);
        updated[id] = null;
      }

      const touched = Object.keys(updated).length > 0;
      return {
        accountId: ACCOUNT,
        oldState,
        newState: touched ? bump() : oldState,
        created: {},
        notCreated: {},
        updated,
        notUpdated,
        destroyed: [],
        notDestroyed: {},
      };
    },

    "VacationResponse/get": () => ({
      accountId: ACCOUNT,
      state: state(),
      // Always exactly one row whether or not a responder has been configured
      // (`services/jmap/src/methods/vacation.ts:13-29`), and `htmlBody` is
      // hardcoded null there — so it is hardcoded null here too. A demo that
      // echoed an HTML body back would hide the one bug this screen was told
      // to avoid.
      list: [{ ...vacation, htmlBody: null }],
      notFound: [],
    }),

    "VacationResponse/set": (args) => {
      if (!scopes.has("draft")) {
        return ["error", { type: "forbidden", description: "token lacks scope: draft" }];
      }
      const oldState = state();
      const patch = (args.update as Record<string, Record<string, unknown>> | undefined)?.singleton;
      // `if (!patch) throw invalidArguments` (vacation.ts:36-39). Note there is
      // deliberately NO `ifInState` check: the real method never reads it, and a
      // fake that enforced a guard the server does not have would let a client
      // ship believing it was protected.
      if (!patch) {
        return ["error", { type: "invalidArguments", description: "VacationResponse/set updates the singleton" }];
      }

      // Merge exactly the five fields the server merges (vacation.ts:42-48),
      // with its fallback semantics: a string wins, an explicit null clears,
      // anything else keeps the stored value. `htmlBody` is not among them and
      // is silently dropped here for the same reason it is there.
      const keep = <T>(v: unknown, fallback: T, ok: (x: unknown) => boolean): T =>
        ok(v) ? (v as T) : v === null ? (null as T) : fallback;
      vacation = {
        isEnabled: typeof patch.isEnabled === "boolean" ? patch.isEnabled : vacation.isEnabled,
        subject: keep(patch.subject, vacation.subject, (x) => typeof x === "string"),
        textBody: keep(patch.textBody, vacation.textBody, (x) => typeof x === "string"),
        fromDate: demoDate(patch.fromDate, vacation.fromDate),
        toDate: demoDate(patch.toDate, vacation.toDate),
      };

      return {
        accountId: ACCOUNT,
        oldState,
        // The real method commits no ChangeEntry, so the account state does not
        // move on a vacation write (`vacation.ts:34,65` read the same value).
        newState: oldState,
        created: {},
        notCreated: {},
        updated: { singleton: null },
        notUpdated: {},
        destroyed: [],
        notDestroyed: {},
      };
    },

    "Email/query": (args) => {
      const filter = (args.filter as EmailFilter | null) ?? null;
      const matched = emails.filter((e) => matchesFilter(e, filter));
      matched.sort(sorter(args.sort as Array<{ property: string; isAscending: boolean }> | undefined));
      const position = typeof args.position === "number" ? args.position : 0;
      const limit = typeof args.limit === "number" ? args.limit : matched.length;
      return {
        accountId: ACCOUNT,
        queryState: state(),
        // Exactly what the server advertises — the reason the thread list
        // re-queries instead of asking for a delta.
        canCalculateChanges: false,
        position,
        ids: matched.slice(position, position + limit).map((e) => e.id),
        ...(args.calculateTotal === true ? { total: matched.length } : {}),
      };
    },

    // The server registers this only to answer per spec; it always throws.
    "Email/queryChanges": () => ["error", { type: "cannotCalculateChanges" }],
    "Mailbox/queryChanges": () => ["error", { type: "cannotCalculateChanges" }],

    "Email/get": (args) => {
      const ids = (args.ids as string[] | undefined) ?? [];
      const properties = args.properties as string[] | undefined;
      const wantBodies =
        properties?.some((p) => p === "bodyValues" || p === "textBody" || p === "htmlBody") ||
        args.fetchTextBodyValues === true ||
        args.fetchHTMLBodyValues === true;
      const list = ids
        .map(findEmail)
        .filter((e): e is Email => e !== undefined)
        .map((e) => projectEmail(e, properties, wantBodies === true));
      return {
        accountId: ACCOUNT,
        state: state(),
        list,
        notFound: ids.filter((id) => !findEmail(id)),
      };
    },

    "Thread/get": (args) => {
      const ids = (args.ids as string[] | undefined) ?? [];
      const list: Array<{ id: string; emailIds: string[] }> = [];
      const notFound: string[] = [];
      for (const id of ids) {
        const emailIds = emails
          .filter((e) => e.threadId === id)
          .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))
          .map((e) => e.id);
        if (emailIds.length === 0) notFound.push(id);
        else list.push({ id, emailIds });
      }
      return { accountId: ACCOUNT, state: state(), list, notFound };
    },

    "Email/set": (args) => {
      const needed = requiredScopes(args);
      const missing = needed.filter((s) => !scopes.has(s));
      if (missing.length > 0) {
        return ["error", { type: "forbidden", description: `token lacks scope: ${missing.join(", ")}` }];
      }

      const oldState = state();
      const created: Record<string, unknown> = {};
      const notCreated: Record<string, unknown> = {};
      const updated: Record<string, null> = {};
      const notUpdated: Record<string, unknown> = {};
      const destroyed: string[] = [];
      const notDestroyed: Record<string, unknown> = {};

      for (const [cid, spec] of Object.entries((args.create as Record<string, Record<string, unknown>>) ?? {})) {
        const mailboxIds = truthyKeys(spec.mailboxIds);
        if (mailboxIds.length === 0) {
          notCreated[cid] = { type: "invalidProperties", description: "mailboxIds is required" };
          continue;
        }
        const bodyValues = (spec.bodyValues as Record<string, { value?: string }> | undefined) ?? {};
        const textPartId = (spec.textBody as Array<{ partId?: string }> | undefined)?.[0]?.partId;
        const text = textPartId ? (bodyValues[textPartId]?.value ?? "") : "";
        const email = makeEmail({
          id: `e-draft-${++seq}`,
          threadId: `t-draft-${seq}`,
          subject: (spec.subject as string) ?? "",
          from: (spec.from as Email["from"]) ?? [],
          to: (spec.to as Email["to"]) ?? [],
          cc: (spec.cc as Email["cc"]) ?? [],
          bcc: (spec.bcc as Email["bcc"]) ?? [],
          mailboxIds: Object.fromEntries(mailboxIds.map((id) => [id, true])),
          keywords: Object.fromEntries(truthyKeys(spec.keywords).map((k) => [k, true])),
          preview: text.slice(0, 256),
          inReplyTo: (spec.inReplyTo as string[] | null) ?? null,
          textBody: [{ partId: "t", blobId: null, type: "text/plain" }],
          bodyValues: { t: { value: text } },
        });
        emails.push(email);
        created[cid] = {
          id: email.id,
          blobId: email.blobId,
          threadId: email.threadId,
          size: email.size,
        };
      }

      for (const [id, patch] of Object.entries((args.update as Record<string, Record<string, unknown>>) ?? {})) {
        const email = findEmail(id);
        if (!email) {
          notUpdated[id] = { type: "notFound" };
          continue;
        }
        const problem = applyPatch(email, patch);
        if (problem) notUpdated[id] = { type: "invalidProperties", description: problem };
        else updated[id] = null;
      }

      for (const id of (args.destroy as string[] | undefined) ?? []) {
        const idx = emails.findIndex((e) => e.id === id);
        if (idx < 0) notDestroyed[id] = { type: "notFound" };
        else {
          emails.splice(idx, 1);
          destroyed.push(id);
        }
      }

      const touched = Object.keys(created).length + Object.keys(updated).length + destroyed.length > 0;
      return {
        accountId: ACCOUNT,
        oldState,
        newState: touched ? bump() : oldState,
        created,
        notCreated,
        updated,
        notUpdated,
        destroyed,
        notDestroyed,
      };
    },

    "EmailSubmission/set": (args) => {
      if (!scopes.has("send")) {
        return ["error", { type: "forbidden", description: "token lacks scope: send" }];
      }
      const oldState = state();
      const created: Record<string, unknown> = {};
      const notCreated: Record<string, unknown> = {};
      const refs = new Map<string, string>();

      for (const [cid, spec] of Object.entries(
        (args.create as Record<
          string,
          {
            emailId?: string;
            identityId?: string;
            envelope?: { rcptTo?: Array<{ email: string }> };
          }
        >) ?? {},
      )) {
        const email = spec.emailId ? findEmail(spec.emailId) : undefined;
        if (!email) {
          notCreated[cid] = { type: "invalidProperties", description: "email not found" };
          continue;
        }
        // The server refuses to relay anything that is not an unsent draft.
        if (email.keywords.$draft !== true) {
          notCreated[cid] = { type: "forbidden", description: "email is not a draft" };
          continue;
        }
        if (!identities.some((i) => i.id === spec.identityId)) {
          notCreated[cid] = { type: "invalidProperties", description: "identity not found" };
          continue;
        }
        const rcptTo =
          spec.envelope?.rcptTo?.map((r) => r.email) ?? [...email.to, ...email.cc, ...email.bcc].map((a) => a.email);
        if (rcptTo.length === 0) {
          notCreated[cid] = { type: "invalidProperties", description: "no recipients" };
          continue;
        }
        const submissionId = `sub-${sent.length + 1}`;
        sent.push({ emailId: email.id, identityId: spec.identityId as string, rcptTo });
        created[cid] = { id: submissionId, undoStatus: "final", sendAt: new Date().toISOString() };
        refs.set(cid, email.id);
      }

      for (const [key, patch] of Object.entries(
        (args.onSuccessUpdateEmail as Record<string, Record<string, unknown>>) ?? {},
      )) {
        const emailId = key.startsWith("#") ? refs.get(key.slice(1)) : key;
        const email = emailId ? findEmail(emailId) : undefined;
        if (email) applyPatch(email, patch);
      }

      return {
        accountId: ACCOUNT,
        oldState,
        newState: Object.keys(created).length > 0 ? bump() : oldState,
        created,
        notCreated,
        updated: {},
        notUpdated: {},
        destroyed: [],
        notDestroyed: {},
      };
    },

    // ── Annotation/* (s18 A3) — the margin's substrate, warts included ────
    // Mirrors `services/jmap/src/methods/annotation.ts`: query defaults to
    // OPEN (a terminal status is asked for explicitly), a claim is immutable
    // (`set` update moves `status` only), and a claim closes ONCE — the second
    // write refuses, because a dismissal is a training signal already emitted.

    "Annotation/query": (args) => {
      const filter = (args.filter ?? {}) as { class?: string; status?: string; objectId?: string };
      const status = typeof filter.status === "string" ? filter.status : "open";
      const ids = annotations
        .filter((r) => r.status === status)
        .filter((r) => !filter.class || r.class === filter.class)
        .filter(
          (r) => !filter.objectId || (r.anchor as { objectId?: string } | undefined)?.objectId === filter.objectId,
        )
        .sort((a, b) => (b.createdAt as number) - (a.createdAt as number))
        .map((r) => r.id as string);
      return { accountId: ACCOUNT, queryState: state(), ids };
    },

    "Annotation/get": (args) => {
      const ids = args.ids === null || args.ids === undefined ? undefined : (args.ids as string[]);
      const list = ids ? annotations.filter((r) => ids.includes(r.id as string)) : annotations;
      return {
        accountId: ACCOUNT,
        state: state(),
        list,
        notFound: (ids ?? []).filter((id) => !annotations.some((r) => r.id === id)),
      };
    },

    "Annotation/set": (args) => {
      // The lightest mail-write verb gates the margin's verbs, exactly as the
      // server does (`requireAccount(ctx, args, "annotate")`).
      if (!scopes.has("annotate")) {
        return ["error", { type: "forbidden", description: "token lacks scope: annotate" }];
      }
      const oldState = state();
      const now = Date.now();
      const created: Record<string, unknown> = {};
      const notCreated: Record<string, unknown> = {};
      const updated: Record<string, null> = {};
      const notUpdated: Record<string, unknown> = {};

      for (const [cid, spec] of Object.entries((args.create as Record<string, Record<string, unknown>>) ?? {})) {
        const anchor = spec.anchor as { realm?: unknown; objectId?: unknown } | undefined;
        // The invariant, at the door: no anchor, no annotation.
        if (!anchor || typeof anchor.realm !== "string" || typeof anchor.objectId !== "string") {
          notCreated[cid] = {
            type: "invalidProperties",
            description: "anchor {realm, objectId} is required — an annotation is always about something",
          };
          continue;
        }
        const cls = String(spec.class ?? "");
        if (!["commitment", "decision", "task"].includes(cls)) {
          notCreated[cid] = {
            type: "invalidProperties",
            description: "class must be one of commitment | decision | task",
          };
          continue;
        }
        const body = typeof spec.body === "string" ? spec.body.trim() : "";
        if (!body) {
          notCreated[cid] = { type: "invalidProperties", description: "body (the claim) is required" };
          continue;
        }
        const id = `an-demo-${annotations.length + 1}`;
        annotations.push({
          id,
          authorKind: "human", // the demo session is a human token, so a filed
          author: "eric@bullmoose.test", // claim carries no confidence — it is
          anchor, //                        true because they said so.
          class: cls,
          body,
          confidence: null,
          status: "open",
          rationale: typeof spec.rationale === "string" ? spec.rationale : null,
          sourceRef: typeof spec.sourceRef === "string" ? spec.sourceRef : null,
          createdAt: now,
          updatedAt: now,
        });
        created[cid] = { id, status: "open" };
      }

      for (const [id, patch] of Object.entries((args.update as Record<string, Record<string, unknown>>) ?? {})) {
        if (Object.keys(patch).some((k) => k !== "status")) {
          notUpdated[id] = {
            type: "invalidProperties",
            description:
              "an annotation's claim is immutable — set `status` (resolved | dismissed); you do not rewrite it",
          };
          continue;
        }
        const status = String(patch.status ?? "");
        if (status !== "resolved" && status !== "dismissed") {
          notUpdated[id] = { type: "invalidProperties", description: "status must be resolved | dismissed" };
          continue;
        }
        const row = annotations.find((r) => r.id === id && r.status === "open");
        if (!row) {
          notUpdated[id] = {
            type: "invalidProperties",
            description: "no open annotation with that id (already resolved, dismissed or unknown)",
          };
          continue;
        }
        row.status = status;
        row.updatedAt = now;
        updated[id] = null;
      }

      const touched = Object.keys(created).length + Object.keys(updated).length > 0;
      return {
        accountId: ACCOUNT,
        oldState,
        newState: touched ? bump() : oldState,
        created,
        notCreated,
        updated,
        notUpdated,
        destroyed: [],
        notDestroyed: {},
      };
    },

    // ── AgentBinding/set (s26 T2) — the kill switch, demo-shaped ──────────
    // Mirrors `services/jmap/src/methods/agentBinding.ts`: `send` gates the
    // flip (the capability wall's scope — a supervisory grant's read/annotate/
    // draft never opens this door), and exactly ONE property is writable.
    // The demo keeps the flip in this tab only: the console fixture is a
    // separate in-memory store, so a reload re-reads the sample state — the
    // same bargain the settings demo banner already states.
    "AgentBinding/set": (args) => {
      if (!scopes.has("send")) {
        return [
          "error",
          {
            type: "forbidden",
            description:
              "flipping a binding's kill switch requires the send capability (a human action); " +
              "a supervisory grant does not carry it",
          },
        ];
      }
      const updated: Record<string, { enabled: boolean }> = {};
      const notUpdated: Record<string, unknown> = {};
      for (const [id, patch] of Object.entries((args.update as Record<string, Record<string, unknown>>) ?? {})) {
        const unknown = Object.keys(patch).filter((k) => k !== "enabled");
        if (unknown.length > 0) {
          notUpdated[id] = {
            type: "invalidProperties",
            description: `AgentBinding/set v1 writes exactly one property, "enabled"`,
            properties: unknown,
          };
          continue;
        }
        if (typeof patch.enabled !== "boolean") {
          notUpdated[id] = { type: "invalidProperties", description: "enabled must be true or false" };
          continue;
        }
        updated[id] = { enabled: patch.enabled };
      }
      return { accountId: ACCOUNT, updated, notUpdated };
    },

    // ── the mail verbs' two doors (s20 T2), demo-shaped ───────────────────
    // Mirrors the servers' gates, because the refusal paths are the point:
    // `Watch/set` takes `annotate` (arming a watch enrolls the account in
    // future cron work — services/jmap watch.ts), `AgentInvocation/set` takes
    // `draft` (creating one causes an agent to draft — agent.ts), and the
    // create branch refuses a binding this account does not have, by NAME, so
    // the "no agent is set up yet" sentence is reachable in a browser.
    "Watch/set": (args) => {
      if (!scopes.has("annotate")) {
        return ["error", { type: "forbidden", description: "token lacks scope: annotate" }];
      }
      const created: Record<string, unknown> = {};
      const notCreated: Record<string, unknown> = {};
      for (const [cid, spec] of Object.entries((args.create as Record<string, Record<string, unknown>>) ?? {})) {
        const condition = (spec.condition ?? {}) as { sender?: unknown };
        if (spec.conditionType === "no-reply-from" && typeof condition.sender !== "string") {
          notCreated[cid] = { type: "invalidProperties", description: "no-reply-from needs condition.sender" };
          continue;
        }
        if (!Number.isFinite(Number(spec.deadlineAt)) || Number(spec.deadlineAt) <= 0) {
          notCreated[cid] = { type: "invalidProperties", description: "deadlineAt (epoch ms) is required" };
          continue;
        }
        const id = `w_demo_${Object.keys(watches).length + 1}`;
        watches[id] = { ...spec, id, status: "armed" };
        created[cid] = { id, status: "armed" };
      }
      return { accountId: ACCOUNT, oldState: state(), newState: bump(), created, notCreated };
    },

    "AgentInvocation/set": (args) => {
      if (!scopes.has("draft")) {
        return ["error", { type: "forbidden", description: "token lacks scope: draft" }];
      }
      const created: Record<string, unknown> = {};
      const notCreated: Record<string, unknown> = {};
      for (const [cid, spec] of Object.entries((args.create as Record<string, Record<string, unknown>>) ?? {})) {
        const name = typeof spec.bindingName === "string" ? spec.bindingName : "";
        if (name !== DEMO_BINDING) {
          // The server's own wording — the sentence the door translates into
          // "no agent is set up on this mailbox yet".
          notCreated[cid] = { type: "notFound", description: `no such binding "${name}" on this account` };
          continue;
        }
        if (typeof spec.emailId !== "string" || !findEmail(spec.emailId)) {
          notCreated[cid] = { type: "invalidProperties", description: "emailId is required" };
          continue;
        }
        const id = `inv_demo_${invocations.length + 1}`;
        invocations.push({ id, bindingName: name, emailId: spec.emailId, status: "pending", params: spec.params });
        created[cid] = { id, bindingName: name, status: "pending", emailId: spec.emailId };
      }
      return { accountId: ACCOUNT, oldState: state(), newState: bump(), created, notCreated };
    },
  };

  // Drop the agent capability by rebuilding the capability map without it —
  // key PRESENCE is the gate (`capabilities.ts`), so deleting the key is the
  // only faithful way to simulate a server that does not advertise it.
  const base = defaultSession();
  const session =
    opts.agentCapability === false
      ? {
          capabilities: withoutAgentCap(base.capabilities),
          accounts: Object.fromEntries(
            Object.entries(base.accounts).map(([id, a]) => [
              id,
              { ...a, accountCapabilities: withoutAgentCap(a.accountCapabilities) },
            ]),
          ),
        }
      : undefined;

  const client = new FakeJmapClient({ handlers, ...(session ? { session } : {}) });
  return { client, mailboxes, emails, identities, sent, annotations, watches, invocations, state };
}

/** Every capability except the agent one. */
function withoutAgentCap(caps: Record<string, unknown>): Record<string, unknown> {
  const { [AGENT_CAP]: _dropped, ...rest } = caps;
  return rest;
}

/** Just the client, for callers that do not need to inspect the backend. */
export function createDemoClient(opts: DemoOptions = {}): FakeJmapClient {
  return createDemoBackend(opts).client;
}

// ── server-behaviour mirrors ──────────────────────────────────────────────

/**
 * Mirrors `dateMs` (`services/jmap/src/methods/vacation.ts:97-104`), including
 * the wart that matters: an unparseable date FALLS BACK to the stored value
 * rather than being refused, so a bad date is swallowed and the write still
 * reports success. `lib/settings/vacation.ts` rejects it client-side precisely
 * because of this, and the demo has to reproduce it or that guard looks
 * unnecessary.
 */
function demoDate(v: unknown, fallback: string | null): string | null {
  if (v === null) return null;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return fallback;
}

/** Mirrors `requiredScopesForEmailSet` (services/jmap/src/methods/email.ts). */
function requiredScopes(args: Record<string, unknown>): string[] {
  const need = new Set<string>();
  const create = args.create as Record<string, unknown> | undefined;
  const update = args.update as Record<string, Record<string, unknown>> | undefined;
  const destroy = args.destroy as string[] | undefined;
  if (create && Object.keys(create).length > 0) need.add("draft");
  if (update) {
    for (const patch of Object.values(update)) {
      const keys = Object.keys(patch ?? {});
      const isMailboxKey = (k: string): boolean => k === "mailboxIds" || k.startsWith("mailboxIds/");
      if (keys.some(isMailboxKey)) need.add("move");
      if (keys.length === 0 || keys.some((k) => !isMailboxKey(k))) need.add("annotate");
    }
  }
  if (destroy && destroy.length > 0) need.add("delete");
  return [...need];
}

/** Mirrors `applyEmailPatch`. Returns a problem string, or null on success. */
function applyPatch(email: Email, patch: Record<string, unknown>): string | null {
  const keywords = { ...email.keywords };
  const mailboxIds = { ...email.mailboxIds };
  let touchedMailboxes = false;

  for (const [path, value] of Object.entries(patch)) {
    const [head, sub, ...rest] = path.split("/");
    if (rest.length > 0) return `unsupported path "${path}"`;
    const target = head === "keywords" ? keywords : head === "mailboxIds" ? mailboxIds : null;
    if (!target) return `property "${path}" is immutable or unknown`;
    if (head === "mailboxIds") touchedMailboxes = true;

    if (sub === undefined) {
      if (value === null || typeof value !== "object") return `"${path}" must be an object`;
      for (const k of Object.keys(target)) delete target[k];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === true) target[k] = true;
      }
    } else if (value === true) {
      target[sub] = true;
    } else if (value === null || value === false) {
      delete target[sub];
    } else {
      return `"${path}" must be true or null`;
    }
  }

  if (touchedMailboxes && Object.keys(mailboxIds).length === 0) {
    return "an email must belong to at least one mailbox";
  }
  email.keywords = keywords;
  email.mailboxIds = mailboxIds;
  return null;
}

/**
 * Mirrors `buildFilter`. Note what `text` does NOT touch: message bodies. The
 * server's comment is "LIKE fallback until the FTS index is populated at
 * ingest", and the UI says so out loud (see `../mail/search.ts`).
 */
function matchesFilter(email: Email, filter: EmailFilter | null): boolean {
  if (!filter) return true;
  if ("operator" in filter) {
    const parts = filter.conditions.map((c) => matchesFilter(email, c));
    if (filter.operator === "AND") return parts.every(Boolean);
    if (filter.operator === "OR") return parts.some(Boolean);
    return !parts.some(Boolean);
  }

  const c = filter as EmailFilterCondition;
  const like = (haystack: string, needle: string): boolean => haystack.toLowerCase().includes(needle.toLowerCase());
  const addrText = (list: Email["from"]): string => list.map((a) => `${a.name ?? ""} ${a.email}`).join(" ");

  if (c.inMailbox !== undefined && email.mailboxIds[c.inMailbox] !== true) return false;
  if (c.hasKeyword !== undefined && email.keywords[c.hasKeyword] !== true) return false;
  if (c.notKeyword !== undefined && email.keywords[c.notKeyword] === true) return false;
  if (c.text !== undefined) {
    const hit =
      like(email.subject, c.text) ||
      like(email.preview, c.text) ||
      like(addrText(email.from), c.text) ||
      like(addrText(email.to), c.text);
    if (!hit) return false;
  }
  if (c.from !== undefined && !like(addrText(email.from), c.from)) return false;
  if (c.to !== undefined && !like(addrText(email.to), c.to)) return false;
  if (c.subject !== undefined && !like(email.subject, c.subject)) return false;
  if (c.before !== undefined && Date.parse(email.receivedAt) >= Date.parse(c.before)) return false;
  if (c.after !== undefined && Date.parse(email.receivedAt) < Date.parse(c.after)) return false;
  if (c.hasAttachment !== undefined && email.hasAttachment !== c.hasAttachment) return false;
  if (c.minSize !== undefined && email.size < c.minSize) return false;
  if (c.maxSize !== undefined && email.size > c.maxSize) return false;
  return true;
}

function sorter(sort: Array<{ property: string; isAscending: boolean }> | undefined) {
  const specs = sort ?? [{ property: "receivedAt", isAscending: false }];
  return (a: Email, b: Email): number => {
    for (const s of specs) {
      const dir = s.isAscending ? 1 : -1;
      let cmp = 0;
      if (s.property === "receivedAt") cmp = Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
      else if (s.property === "size") cmp = a.size - b.size;
      else if (s.property === "subject") cmp = a.subject.localeCompare(b.subject);
      else if (s.property === "from") {
        cmp = (a.from[0]?.email ?? "").localeCompare(b.from[0]?.email ?? "");
      }
      if (cmp !== 0) return cmp * dir;
    }
    return 0;
  };
}

function projectEmail(email: Email, properties: string[] | undefined, wantBodies: boolean): Email {
  const full: Email = { ...email };
  if (!wantBodies) {
    delete full.bodyValues;
    delete full.textBody;
    delete full.htmlBody;
  }
  if (!properties) return full;
  const out: Record<string, unknown> = { id: full.id };
  for (const p of properties) if (p in full) out[p] = (full as unknown as Record<string, unknown>)[p];
  return out as unknown as Email;
}

function truthyKeys(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
}
