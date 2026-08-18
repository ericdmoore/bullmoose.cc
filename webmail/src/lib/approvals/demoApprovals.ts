// An in-memory `ActionProposal` collection for the `FakeJmapClient` — the
// approvals realm of the demo backend, so `/approvals?demo=1` is fully
// drivable with no server.
//
// It lives here, next to the surface, rather than inside `../jmap/demo.ts`,
// following `../calendar/demoCalendar.ts` and `../contacts/demo.ts` — one
// realm per module, attached through `FakeJmapClient.setHandler`
// (../jmap/FakeJmapClient.ts:109), so parallel section work never edits one
// shared fake. And the same discipline as those two: **mirror the server's
// semantics, warts included** (services/jmap/src/methods/actionProposal.ts).
// The ones deliberately reproduced:
//
//   • `/set` is `update` only — a `create` is refused with the server's own
//     sentence: proposals are produced by the agent worker (:191-197).
//   • only `pending` is decidable, and only to `approved`/`rejected`
//     (:211-219). `held` is NOT re-decidable through this backend's `/set` —
//     the server grew the yank verb in s03.D T2 and this fake has not; what it
//     DOES carry is a `yanked` FIXTURE (`ap-yanked-boards`), so the terminal
//     state the history grouping handles is demonstrable in demo mode instead
//     of being a branch only production data ever reaches.
//   • a tier-2 approve enters the hold tray: status `held`,
//     `holdUntil = now + 5min` (:61, :268-289). Nothing egresses.
//   • a tier-3 approve demands the `send` scope — the capability wall
//     (:252-266). `?send=0` drops the scope so the refusal is DRIVABLE, the
//     same reason `?agentcap=0` and `?shared=1` exist.
//   • `editedPayload` lands beside the retained `payload`, never over it
//     (:222-243) — the diff is the point.
//   • an approved tier-1/3 row records what applying DID (`applied` / `sent`
//     below) the way `demo.ts` records submissions: assert against the array
//     instead of a relay.
//   • destroying a `pending` row is refused — decide it, don't drop it (:327).
//   • the expiry sweep is a WORKER cron (services/agent/src/proposals.ts:153),
//     not a read-path side effect — so reads here never auto-flip an overdue
//     row either; `sweep()` is exposed for tests and mirrors the cron.
//   • needsInfo (s10 T3): `status: "info-requested"` from pending only, a
//     non-empty question required, NO decision (it is an action, not a
//     reject), the deadline pauses (banked; expiresAt null) and the round
//     APPENDS to amendments. The ANSWER is the agent worker's job
//     (`answerInfoRequest`), so — like the sweep — it is exposed as
//     `answer()` and never a read-path side effect.

import type { FakeJmapClient, MethodHandler } from "../jmap/FakeJmapClient";
import type { ActionProposal, ProposalDecision } from "./types";

const ACCOUNT = "acct-fake";
/** Who a demo decision is recorded as — the fake session's principal. */
const USERNAME = "fake@bullmoose.test";
/** Mirrors HOLD_WINDOW_MS (actionProposal.ts:61). */
const HOLD_WINDOW_MS = 5 * 60_000;

/** Mirrors the server's enum (actionProposal.ts). `notNow` is retired — refused
 * on a new decision here exactly as the server refuses it, while the retired
 * fixture below proves an already-recorded one still reads. */
const REJECT_REASONS = new Set(["wrongContent", "wrongAction", "unsafe"]);

export interface ApprovalsDemoOptions {
  /** Anchor for the fixtures' clocks; defaults to wall time. */
  now?: number;
  /** Mail verbs this session holds — same knob as `demo.ts:235`. */
  scopes?: string[];
  proposals?: ActionProposal[];
}

export interface ApprovalsDemoBackend {
  proposals: ActionProposal[];
  /** Tier-1 applications, with the undo handle the server would keep. */
  applied: Array<{ id: string; kind: string; undo: Record<string, unknown> }>;
  /** Tier-3 egress the demo "sent" — the stand-in for the submit relay. */
  sent: Array<{ id: string; to: string; subject: string }>;
  state(): string;
  /** Mirrors `expireStaleProposals` — call it; reads never run it. */
  sweep(nowMs?: number): void;
  /**
   * Mirrors the agent worker's `answerInfoRequest` (s10 T3): the answer round
   * is a WORKER job, never a read-path side effect, so — like `sweep` — it is
   * exposed for tests and driven manually. Fills the open round, returns the
   * row to `pending`, resumes the banked expiry clock. Refuses (a no-op) when
   * the row is not `info-requested` — one round per human action.
   */
  answer(id: string, text?: string): void;
}

/** The demo knobs this section reads from the URL (see module header). */
export function demoApprovalsOptions(search: string): Pick<ApprovalsDemoOptions, "scopes"> {
  if (new URLSearchParams(search).get("send") === "0") {
    return { scopes: ["read", "annotate", "draft", "move", "delete"] };
  }
  return {};
}

// ── fixtures ──────────────────────────────────────────────────────────────

/**
 * The queue a first visit should show, anchored to `now` so the clocks are
 * always mid-flight: every tier pending, a `grant-request` in the same list
 * (arch.md §1 — one review surface), a near-expiry row, one already `held`,
 * and one of each historical outcome — including "approved after edit", so the
 * retained-diff rendering is reachable without interacting.
 *
 * People and subjects line up with `../jmap/demo.ts`'s mailbox (Grace, the
 * invoice, Engine Weekly) so a demo visitor who has seen `/mail` recognizes
 * the threads these proposals hang off.
 */
export function demoProposals(now: number): ActionProposal[] {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const min = 60_000;
  const hour = 3600_000;
  const day = 24 * hour;

  // `accountId` is stamped once at the end rather than typed into a dozen
  // fixtures: the demo has ONE account, and a per-row literal would be a dozen
  // chances to drift from the account the fake backend answers as (s10 T7).
  const rows: Omit<ActionProposal, "accountId">[] = [
    {
      // The marquee row: tier 2, editable, and NEAR EXPIRY — both clocks loud.
      id: "ap-reply-elk",
      agent: "Emily",
      kind: "reply-draft",
      tier: 2,
      subject: { realm: "Email", objectId: "e-thread-1" },
      payload: {
        to: "grace@example.test",
        self: "eric@bullmoose.test",
        subject: "Re: Project Elk kickoff",
        text:
          "Monday works — I'll bring the draft agenda.\n\n" +
          "One ask: can we keep the first half hour for scope? " +
          "The kickoff doc still lists three integrations and we have budget for one.\n\n" +
          "— Eric",
        blobId: "blob-prop-elk",
        inReplyTo: "e-thread-1@bullmoose.test",
        messageId: "prop-elk@bullmoose.test",
        mode: "send",
      },
      editedPayload: null,
      rationale:
        "Grace asked for a yes/no on Monday and the thread has sat a day. " +
        "Sending a reply is tier-2 (retractable) — it waits for your approval before it goes out.",
      evidence: [{ realm: "Email", objectId: "e-thread-1", note: "the message being replied to" }],
      status: "pending",
      decision: null,
      createdAt: iso(now - 26 * hour),
      decidedAt: null,
      holdUntil: null,
      expiresAt: iso(now + 35 * min), // near expiry: under the 1h urgency line
      dueAt: iso(now + 22 * hour), // inferred from "a yes/no on Monday" — the boundary's proposal, correctable
      question: null,
      amendments: [],
      invocationStatus: "done",
      claimedAt: null,
      costMicros: 2140,
      tokensIn: 1832,
      tokensOut: 412,
      costModel: "openrouter/minimax/minimax-m3",
    },
    {
      // Tier 1: reversible, applies immediately on approve, undo handle kept.
      id: "ap-contact-dana",
      agent: "Allen",
      kind: "create-contact",
      tier: 1,
      subject: { realm: "ContactCard", objectId: "new" },
      payload: {
        card: {
          name: { full: "Dana Calloway" },
          emails: { email1: { address: "dana@calloway.test" } },
          notes: { note1: { note: "Vendor contact from the invoice thread." } },
        },
      },
      editedPayload: null,
      rationale:
        "dana@calloway.test has appeared in six threads this quarter and is not in your address book. " +
        "Creating a contact is tier-1 (reversible) — approving applies it immediately with an undo handle.",
      evidence: [
        { realm: "Email", objectId: "e-invoice", note: "signed the invoice cover note" },
        { realm: "Email", objectId: "e-newsletter", note: "listed as the reply-to" },
      ],
      status: "pending",
      decision: null,
      createdAt: iso(now - 3 * day), // the long-waiting row: the human's clock
      decidedAt: null,
      holdUntil: null,
      expiresAt: iso(now + 4 * day),
      dueAt: null,
      question: null,
      amendments: [],
      invocationStatus: "done",
      claimedAt: null,
      costMicros: null,
      tokensIn: null,
      tokensOut: null,
      costModel: null,
    },
    {
      // Tier 3: the irreversible egress applyProposal actually handles
      // (actionProposal.ts:424-427). Approving calls the real send gate.
      id: "ap-reply-invoice",
      agent: "Emily",
      kind: "reply-draft",
      tier: 3,
      subject: { realm: "Email", objectId: "e-invoice" },
      payload: {
        to: "billing@example.test",
        self: "eric@bullmoose.test",
        subject: "Re: Invoice 0042 — payment confirmation",
        text:
          "Confirming payment of invoice 0042 by wire on Friday.\n" +
          "Reference: BM-0042. Please acknowledge receipt.\n\n— Eric",
        blobId: "blob-prop-invoice",
        inReplyTo: "e-invoice@bullmoose.test",
        messageId: "prop-invoice@bullmoose.test",
        mode: "send",
      },
      editedPayload: null,
      rationale:
        "Accounts asked for written confirmation before releasing the order. " +
        "This commits a payment reference to an external party — tier 3: once read it cannot be " +
        "retracted, so there is no hold window and approval is a human send every time.",
      evidence: [{ realm: "Email", objectId: "e-invoice", note: "the invoice requesting confirmation" }],
      status: "pending",
      decision: null,
      createdAt: iso(now - 4 * hour),
      decidedAt: null,
      holdUntil: null,
      expiresAt: iso(now + 2 * day),
      dueAt: iso(now + 2 * day), // "payment … by wire on Friday"
      question: null,
      amendments: [],
      invocationStatus: "done",
      claimedAt: null,
      costMicros: null,
      tokensIn: null,
      tokensOut: null,
      costModel: null,
    },
    {
      // grant-request shares the queue (arch.md §1): what / why / approve-deny,
      // in the same list as the replies. Deliberately NOT a separate surface.
      id: "ap-grant-photos",
      agent: "photos",
      kind: "grant-request",
      tier: 1,
      subject: { realm: "FileNode", objectId: "folder-fair" },
      payload: {
        scope: "read",
        realm: "files",
        target: "Events/2026-08 Midbury Fair",
        durationDays: 30,
      },
      editedPayload: null,
      rationale:
        "I was CC'd into the fair folder to collect arrivals. I need read on that folder for the " +
        "next month; I hold no standing permissions, so I am asking rather than assuming.",
      evidence: [{ realm: "Email", objectId: "e-welcome", note: "the CC that invited photos@" }],
      status: "pending",
      decision: null,
      createdAt: iso(now - 3 * min), // freshly asked: this row's waited-for visibly grows
      decidedAt: null,
      holdUntil: null,
      expiresAt: iso(now + 5 * day),
      dueAt: null,
      question: null,
      amendments: [],
      invocationStatus: "done",
      claimedAt: null,
      costMicros: null,
      tokensIn: null,
      tokensOut: null,
      costModel: null,
    },
    {
      // needsInfo, ANSWERED (s10 T3): a recipient widening that was challenged
      // and came back to the queue with the dialogue attached — the
      // challenged-then-approvable grant, the strongest "why" the chain can
      // hold. Pending again, clock resumed.
      id: "ap-grant-crm",
      agent: "crm",
      kind: "grant-request",
      tier: 1,
      subject: { realm: "AddressBook", objectId: "book-crm-allow" },
      payload: {
        grantType: "recipient",
        bookId: "book-crm-allow",
        address: "dana@calloway.test",
        name: "Dana Calloway",
      },
      editedPayload: null,
      rationale:
        "Dana signed the last two invoices and I cannot reach her: she is not in my allowlist. " +
        "Approving adds her to my governing book — a contact write that carries this proposal as its why.",
      evidence: [{ realm: "Email", objectId: "e-invoice", note: "the invoice Dana signed" }],
      status: "pending",
      decision: null,
      createdAt: iso(now - 5 * hour),
      decidedAt: null,
      holdUntil: null,
      expiresAt: iso(now + 6 * day), // resumed when the answer landed
      dueAt: null,
      question: null,
      amendments: [
        {
          question: "Why Dana and not the billing@ alias you already have?",
          answer:
            "billing@ is a ticket queue that strips threading; both signed invoices came from " +
            "dana@calloway.test directly, and the open question is addressed to her by name.",
          askedAt: iso(now - 4 * hour),
          answeredAt: iso(now - 3 * hour),
          askedBy: USERNAME,
        },
      ],
      invocationStatus: "done",
      claimedAt: null,
      costMicros: null,
      tokensIn: null,
      tokensOut: null,
      costModel: null,
    },
    {
      // needsInfo, OPEN (s10 T3): the ball is in the agent's court. No verbs,
      // no expiry clock — expiresAt is NULL because the server BANKED the
      // remaining window when the question was asked.
      id: "ap-info-subscribe",
      agent: "Allen",
      kind: "unsubscribe",
      tier: 2,
      subject: { realm: "Email", objectId: "e-newsletter" },
      payload: { listName: "The Analytical Engine Weekly", to: "news@example.test" },
      editedPayload: null,
      rationale: "You have not opened the last nine issues; unsubscribing stops the noise.",
      evidence: [{ realm: "Email", objectId: "e-newsletter", note: "the unopened run" }],
      status: "info-requested",
      decision: null,
      createdAt: iso(now - 2 * hour),
      decidedAt: null,
      holdUntil: null,
      expiresAt: null, // paused — the remainder is banked server-side
      dueAt: null,
      question: "Which nine issues? I read it on my phone — does that count as opened here?",
      amendments: [
        {
          question: "Which nine issues? I read it on my phone — does that count as opened here?",
          answer: null,
          askedAt: iso(now - 20 * min),
          answeredAt: null,
          askedBy: USERNAME,
        },
      ],
      invocationStatus: "pending",
      claimedAt: null,
      costMicros: null,
      tokensIn: null,
      tokensOut: null,
      costModel: null,
    },
    {
      // Already in the hold tray: approved 2 minutes ago, retraction window
      // ticking. Nothing has been sent — the commit out of the tray is s03.D
      // T2, so this row can only be watched.
      id: "ap-held-agenda",
      agent: "Emily",
      kind: "start-thread",
      tier: 2,
      subject: { realm: "Email", objectId: "t-agenda" },
      payload: {
        to: "katherine@example.test",
        self: "eric@bullmoose.test",
        subject: "Agenda for Thursday",
        text: "Katherine — three items for Thursday: launch date, the vendor quote, hiring.\n\n— Eric",
        blobId: "blob-prop-agenda",
        messageId: "prop-agenda@bullmoose.test",
        mode: "send",
      },
      editedPayload: null,
      rationale: "You asked me Monday to set Thursday's agenda thread once the quote arrived. It has.",
      evidence: [{ realm: "Email", objectId: "e-invoice", note: "the quote that unblocked the agenda" }],
      status: "held",
      decision: { by: USERNAME },
      createdAt: iso(now - 90 * min),
      decidedAt: iso(now - 2 * min),
      holdUntil: iso(now + 3 * min),
      expiresAt: iso(now + 6 * day), // moot once held — rendered from holdUntil, never this
      dueAt: null,
      question: null,
      amendments: [],
      invocationStatus: "done",
      claimedAt: null,
      costMicros: null,
      tokensIn: null,
      tokensOut: null,
      costModel: null,
    },
    {
      // History: approved AFTER EDIT — the middle outcome (s07 §T4's table).
      // `payload` is the agent's original, `editedPayload` the human's word;
      // the diff between them is renderable because both survived.
      id: "ap-edited-weekly",
      agent: "Emily",
      kind: "reply-draft",
      tier: 3,
      subject: { realm: "Email", objectId: "e-newsletter" },
      payload: {
        to: "news@example.test",
        self: "eric@bullmoose.test",
        subject: "Re: The Analytical Engine Weekly",
        text:
          "Happy to contribute a piece on punch-card archival.\n" +
          "I could have a draft to you by the 20th if that suits your schedule.\n\n— Eric",
        blobId: "blob-prop-weekly",
        messageId: "prop-weekly@bullmoose.test",
        mode: "send",
      },
      editedPayload: {
        to: "news@example.test",
        self: "eric@bullmoose.test",
        subject: "Re: The Analytical Engine Weekly",
        text:
          "Happy to contribute a piece on punch-card archival.\n" +
          "I can have a draft to you by the 27th — the 20th is too tight.\n\n— Eric",
        blobId: "blob-prop-weekly",
        messageId: "prop-weekly@bullmoose.test",
        mode: "send",
      },
      rationale: "The editor asked twice; a short yes with a date closes the loop.",
      evidence: [{ realm: "Email", objectId: "e-newsletter", note: "the request being answered" }],
      status: "approved",
      decision: { by: USERNAME, note: "moved the date — the 20th was never real" },
      createdAt: iso(now - 30 * hour),
      decidedAt: iso(now - 26 * hour),
      holdUntil: null,
      expiresAt: iso(now - 26 * hour + 7 * day),
      dueAt: null,
      question: null,
      amendments: [],
      invocationStatus: "done",
      claimedAt: null,
      costMicros: null,
      tokensIn: null,
      tokensOut: null,
      costModel: null,
    },
    {
      // History: rejected, with the no-thanks signal recorded (arch.md §3).
      id: "ap-event-webinar",
      agent: "Allen",
      kind: "create-event",
      tier: 2,
      subject: { realm: "CalendarEvent", objectId: "new" },
      payload: { title: "Engine Weekly webinar", start: iso(now + 2 * day), durationMinutes: 60 },
      editedPayload: null,
      rationale: "The newsletter announced a webinar; you have attended two of the last three.",
      evidence: [{ realm: "Email", objectId: "e-newsletter", note: "the announcement" }],
      status: "rejected",
      decision: { by: USERNAME, reason: "wrongAction", note: "It's marketing, not a meeting." },
      createdAt: iso(now - 2 * day - 5 * hour),
      decidedAt: iso(now - 2 * day),
      holdUntil: null,
      expiresAt: iso(now + 5 * day),
      dueAt: null,
      question: null,
      amendments: [],
      invocationStatus: "done",
      claimedAt: null,
      costMicros: null,
      tokensIn: null,
      tokensOut: null,
      costModel: null,
    },
    {
      // History under the OLD taxonomy: declined `notNow`, a reason the enum no
      // longer accepts (decline-taxonomy.md). Deliberately left exactly as it
      // was recorded — a human's decision is a fact, and migrating it to a
      // reason they never chose would put words in their mouth. The queue must
      // render it as itself: `describeReason` shows "notNow (retired)". A
      // fixture rather than a comment, so the tolerance is exercised, not
      // asserted.
      id: "ap-thread-vendor",
      agent: "Emily",
      kind: "start-thread",
      tier: 3,
      subject: { realm: "Email", objectId: "new" },
      payload: {
        to: "vendor@example.test",
        subject: "Spring order",
        text: "Following up on the quote.",
      },
      editedPayload: null,
      rationale: "The quote expires Friday and nobody has replied to it.",
      evidence: [{ realm: "Email", objectId: "e-quote", note: "the quote" }],
      status: "rejected",
      decision: { by: USERNAME, reason: "notNow", note: "I'll ring them instead." },
      createdAt: iso(now - 30 * day - 2 * hour),
      decidedAt: iso(now - 30 * day),
      holdUntil: null,
      expiresAt: iso(now - 23 * day),
      dueAt: null,
      question: null,
      amendments: [],
      invocationStatus: "done",
      claimedAt: null,
      costMicros: null,
      tokensIn: null,
      tokensOut: null,
      costModel: null,
    },
    {
      // History: expired — the chance the human lost. The sweep flipped it;
      // note there is NO decidedAt: nobody decided, the clock did.
      id: "ap-files-receipts",
      agent: "Allen",
      kind: "organize-files",
      tier: 1,
      subject: { realm: "FileNode", objectId: "folder-receipts" },
      payload: { target: "Receipts/2026", moves: 14 },
      editedPayload: null,
      rationale: "Fourteen receipt PDFs are loose in the inbox folder; they match last year's filing scheme.",
      evidence: [{ realm: "FileNode", objectId: "folder-receipts", note: "the existing scheme" }],
      status: "expired",
      decision: null,
      createdAt: iso(now - 9 * day),
      decidedAt: null,
      holdUntil: null,
      expiresAt: iso(now - 2 * day),
      dueAt: null,
      question: null,
      amendments: [],
      invocationStatus: "done",
      claimedAt: null,
      costMicros: null,
      tokensIn: null,
      tokensOut: null,
      costModel: null,
    },
    {
      // History: YANKED — approved into the hold tray, then pulled back before
      // the window closed (s03.D T2). The state the tray exists FOR, and the
      // one the demo backend could not previously produce at all: the fixture
      // set went straight from `held` to the two verdicts, so `yanked` was a
      // status the terminal grouping claimed to handle and no demo visitor
      // (or screenshot, or test of the history rendering) had ever seen.
      //
      // Everything about it mirrors the server's yank write
      // (actionProposal.ts): `status: "yanked"`, a `decidedAt` — a human DID
      // decide, twice — and the `holdUntil` it was retracted inside, left in
      // the past so the row reads as history rather than as a live tray entry.
      // It is deliberately NOT a decline: a yank is a retraction of an
      // approval, so it carries no `reason` from the decline enum, and the
      // learning loop counts it as neither an approve nor a reject.
      id: "ap-yanked-boards",
      agent: "Emily",
      kind: "reply-draft",
      tier: 2,
      subject: { realm: "Email", objectId: "e-quote" },
      payload: {
        to: "vendor@example.test",
        self: "eric@bullmoose.test",
        subject: "Re: Spring order — confirming quantities",
        text: "Confirming 40 units at the quoted price — please go ahead.\n\n— Eric",
        blobId: "blob-prop-boards",
        messageId: "prop-boards@bullmoose.test",
        mode: "send",
      },
      editedPayload: null,
      rationale: "The vendor asked for written confirmation and the thread carries the quote and the quantities.",
      evidence: [{ realm: "Email", objectId: "e-quote", note: "the quote being confirmed" }],
      status: "yanked",
      decision: { by: USERNAME, note: "the quantities were wrong — pulled it back to recount" },
      createdAt: iso(now - 8 * hour),
      decidedAt: iso(now - 6 * hour),
      // Approved 6h ago, so the 5-minute window shut 5h55m ago: the yank
      // landed inside it, and nothing was ever sent.
      holdUntil: iso(now - 6 * hour + HOLD_WINDOW_MS),
      expiresAt: iso(now - 6 * hour + 7 * day),
      dueAt: null,
      question: null,
      amendments: [],
      invocationStatus: "done",
      claimedAt: null,
      costMicros: 1730,
      tokensIn: 1204,
      tokensOut: 288,
      costModel: "openrouter/minimax/minimax-m3",
    },
  ];
  return rows.map((r) => ({ ...r, accountId: ACCOUNT }));
}

// ── the backend ───────────────────────────────────────────────────────────

export function installApprovalsDemo(client: FakeJmapClient, opts: ApprovalsDemoOptions = {}): ApprovalsDemoBackend {
  const anchor = opts.now ?? Date.now();
  const proposals = opts.proposals ?? demoProposals(anchor);
  const scopes = new Set(opts.scopes ?? ["read", "annotate", "draft", "move", "send", "delete"]);
  const applied: ApprovalsDemoBackend["applied"] = [];
  const sent: ApprovalsDemoBackend["sent"] = [];
  // The banked pre-decision windows (s10 T3): the server keeps this in
  // `expires_remaining_ms`; the demo keeps it beside the rows because the
  // client-facing ActionProposal shape deliberately does not carry it.
  const pausedRemaining = new Map<string, number | null>();
  let stateCounter = 0;
  const state = (): string => String(stateCounter);
  const bump = (): string => String(++stateCounter);

  const byCreatedDesc = (a: ActionProposal, b: ActionProposal): number =>
    Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id);
  const find = (id: string): ActionProposal | undefined => proposals.find((p) => p.id === id);

  const handlers: Record<string, MethodHandler> = {
    "ActionProposal/get": (args) => {
      const ids = args.ids as string[] | null | undefined;
      const properties = Array.isArray(args.properties) ? (args.properties as string[]) : null;
      const rows =
        ids == null ? [...proposals].sort(byCreatedDesc).slice(0, 256) : proposals.filter((p) => ids.includes(p.id));
      return {
        accountId: ACCOUNT,
        state: state(),
        list: rows.map((p) => pickProps(p as unknown as Record<string, unknown>, properties)),
        notFound: (ids ?? []).filter((id) => !find(id)),
      };
    },

    "ActionProposal/query": (args) => {
      const filter = (args.filter as Record<string, unknown> | null | undefined) ?? null;
      if (filter) {
        for (const key of Object.keys(filter)) {
          if (key !== "status") {
            // The server's filter knows exactly one property (:134-139).
            return ["error", { type: "unsupportedFilter", description: `unknown filter property "${key}"` }];
          }
        }
      }
      const wanted =
        filter && filter.status !== undefined
          ? new Set(Array.isArray(filter.status) ? (filter.status as string[]) : [filter.status as string])
          : null;
      const rows = [...proposals].filter((p) => !wanted || wanted.has(p.status)).sort(byCreatedDesc);
      return {
        accountId: ACCOUNT,
        queryState: state(),
        canCalculateChanges: false,
        position: 0,
        ids: rows.slice(0, 256).map((p) => p.id),
      };
    },

    // Registered only to answer per spec; always throws (:175-177).
    "ActionProposal/queryChanges": () => ["error", { type: "cannotCalculateChanges" }],

    "ActionProposal/set": (args) => {
      // Base gate: deciding is a `draft`-tier action (:179-183) — same scope
      // AgentInvocation/set takes. Tier 3 demands `send` further down.
      if (!scopes.has("draft")) {
        return ["error", { type: "forbidden", description: "token lacks scope: draft" }];
      }
      const oldState = state();
      if (typeof args.ifInState === "string" && args.ifInState !== oldState) {
        return ["error", { type: "stateMismatch" }];
      }
      if (args.create && Object.keys(args.create as object).length > 0) {
        return [
          "error",
          {
            type: "invalidArguments",
            description:
              "ActionProposal has no create: proposals are produced by the agent worker, " +
              "not created over JMAP. ActionProposal/set is the human decision surface (update).",
          },
        ];
      }

      const updated: Record<string, null> = {};
      const notUpdated: Record<string, unknown> = {};
      const destroyed: string[] = [];
      const notDestroyed: Record<string, unknown> = {};
      const now = Date.now();

      for (const [id, patch] of Object.entries(
        (args.update as Record<string, Record<string, unknown>> | undefined) ?? {},
      )) {
        const row = find(id);
        if (!row) {
          notUpdated[id] = { type: "notFound" };
          continue;
        }
        // T1 decides only from `pending` (:211-215): `held` waits for T2's yank.
        if (row.status !== "pending") {
          notUpdated[id] = {
            type: "invalidProperties",
            description: `proposal is ${row.status}, not pending`,
            properties: ["status"],
          };
          continue;
        }
        // ---- s11 T1: the due-date CORRECTION, mirroring the server — a
        // status-free { dueAt } patch fixes the boundary's read and leaves
        // the row pending; riding it on a decision is refused whole.
        if (patch.dueAt !== undefined && patch.status === undefined) {
          if (patch.dueAt !== null && (typeof patch.dueAt !== "string" || !Number.isFinite(Date.parse(patch.dueAt)))) {
            notUpdated[id] = {
              type: "invalidProperties",
              description: "dueAt must be null (no deadline) or an ISO 8601 date string",
              properties: ["dueAt"],
            };
            continue;
          }
          row.dueAt = patch.dueAt === null ? null : new Date(Date.parse(patch.dueAt)).toISOString();
          updated[id] = null;
          continue;
        }
        if (patch.dueAt !== undefined) {
          notUpdated[id] = {
            type: "invalidProperties",
            description: "dueAt is a correction, not part of a decision — send it in its own update, without status",
            properties: ["dueAt"],
          };
          continue;
        }

        const status = patch.status;
        if (status !== "approved" && status !== "rejected" && status !== "info-requested") {
          notUpdated[id] = {
            type: "invalidProperties",
            description: 'status must be "approved", "rejected" or "info-requested"',
            properties: ["status"],
          };
          continue;
        }

        // ---- needsInfo (s10 T3), mirroring the server's branch: only a
        // question rides on the verb (a decision here is the RL-poisoning
        // path); the deadline PAUSES (banked, expiresAt null); the round
        // APPENDS to amendments — never a rewrite of rationale/evidence.
        if (status === "info-requested") {
          if (patch.decision !== undefined || patch.editedPayload !== undefined) {
            notUpdated[id] = {
              type: "invalidProperties",
              description: "needsInfo carries only a question — no decision (it is not a reject) and no editedPayload",
              properties: ["status"],
            };
            continue;
          }
          const question = typeof patch.question === "string" ? patch.question.trim() : "";
          if (question.length === 0) {
            notUpdated[id] = {
              type: "invalidProperties",
              description: "needsInfo requires a non-empty human-authored question",
              properties: ["question"],
            };
            continue;
          }
          pausedRemaining.set(row.id, row.expiresAt !== null ? Math.max(0, Date.parse(row.expiresAt) - now) : null);
          row.status = "info-requested";
          row.question = question;
          row.expiresAt = null;
          row.amendments = [
            ...row.amendments,
            {
              question,
              answer: null,
              askedAt: new Date(now).toISOString(),
              answeredAt: null,
              askedBy: USERNAME,
            },
          ];
          updated[id] = null;
          continue;
        }
        const editedPayload = patch.editedPayload;
        if (editedPayload !== undefined && (editedPayload === null || typeof editedPayload !== "object")) {
          notUpdated[id] = {
            type: "invalidProperties",
            description: "editedPayload must be an object",
            properties: ["editedPayload"],
          };
          continue;
        }
        const decision = buildDecision(patch.decision);
        if ("problem" in decision) {
          notUpdated[id] = decision.problem;
          continue;
        }

        if (status === "rejected") {
          row.status = "rejected";
          row.decidedAt = new Date(now).toISOString();
          row.decision = decision.value;
          if (editedPayload !== undefined) row.editedPayload = editedPayload as Record<string, unknown>;
          updated[id] = null;
          continue;
        }

        // ---- approve ----
        if (row.tier === 3 && !scopes.has("send")) {
          // THE CAPABILITY WALL, verbatim (:257-265): same sentence the server
          // sends, so the UI's refusal rendering is honest in demo too.
          notUpdated[id] = {
            type: "forbidden",
            description:
              "approving a tier-3 proposal requires the send capability (a human action); " +
              "an agent token cannot auto-commit irreversible egress",
            properties: ["status"],
          };
          continue;
        }

        if (row.tier === 2) {
          // Into the hold tray; nothing egresses (:268-289).
          row.status = "held";
          row.decidedAt = new Date(now).toISOString();
          row.holdUntil = new Date(now + HOLD_WINDOW_MS).toISOString();
          row.decision = decision.value;
          if (editedPayload !== undefined) row.editedPayload = editedPayload as Record<string, unknown>;
          updated[id] = null;
          continue;
        }

        // tier 1 / tier 3 with send: apply now, mirroring `applyProposal`.
        const effective = (editedPayload as Record<string, unknown> | undefined) ?? row.payload;
        const outcome = applyDemo(row, effective, applied, sent);
        if (outcome) {
          notUpdated[id] = outcome;
          continue;
        }
        row.status = "approved";
        row.decidedAt = new Date(now).toISOString();
        row.decision = decision.value;
        if (editedPayload !== undefined) row.editedPayload = editedPayload as Record<string, unknown>;
        updated[id] = null;
      }

      for (const id of (args.destroy as string[] | undefined) ?? []) {
        const row = find(id);
        if (!row) {
          notDestroyed[id] = { type: "notFound" };
          continue;
        }
        if (row.status === "pending") {
          notDestroyed[id] = {
            type: "forbidden",
            description: "decide a pending proposal rather than destroying it",
          };
          continue;
        }
        proposals.splice(proposals.indexOf(row), 1);
        destroyed.push(id);
      }

      const touched = Object.keys(updated).length + destroyed.length > 0;
      return {
        accountId: ACCOUNT,
        oldState,
        newState: touched ? bump() : oldState,
        created: {},
        notCreated: {},
        updated,
        notUpdated,
        destroyed,
        notDestroyed,
      };
    },
  };

  for (const [name, handler] of Object.entries(handlers)) client.setHandler(name, handler);

  return {
    proposals,
    applied,
    sent,
    state,
    sweep(nowMs = Date.now()) {
      let flipped = false;
      for (const p of proposals) {
        if (p.status === "pending" && p.expiresAt !== null && Date.parse(p.expiresAt) < nowMs) {
          p.status = "expired";
          flipped = true;
        }
      }
      if (flipped) bump();
    },
    answer(id, text) {
      const row = find(id);
      // One round per human action: only an info-requested row with an OPEN
      // round answers; anything else refuses (the worker fails the invocation
      // with a "refused" note — here, a no-op).
      if (!row || row.status !== "info-requested") return;
      const open = row.amendments[row.amendments.length - 1];
      if (!open || open.answer !== null) return;
      const nowMs = Date.now();
      open.answer = text ?? `(demo answer) The recorded rationale stands: ${row.rationale}`;
      open.answeredAt = new Date(nowMs).toISOString();
      row.status = "pending";
      row.question = null;
      // RESUME the banked clock — the remainder from the moment of the ask.
      const remaining = pausedRemaining.get(row.id);
      row.expiresAt = remaining !== null && remaining !== undefined ? new Date(nowMs + remaining).toISOString() : null;
      pausedRemaining.delete(row.id);
      bump();
    },
  };
}

// ── server-behaviour mirrors ──────────────────────────────────────────────

/** Mirrors `buildDecision` (:536-558): who + reason enum + optional note. */
function buildDecision(raw: unknown): { value: ProposalDecision } | { problem: Record<string, unknown> } {
  const decision: ProposalDecision = { by: USERNAME };
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (r.reason !== undefined) {
      if (typeof r.reason !== "string" || !REJECT_REASONS.has(r.reason)) {
        return {
          problem: {
            type: "invalidProperties",
            description: "decision.reason must be wrongContent | wrongAction | unsafe",
            properties: ["decision"],
          },
        };
      }
      decision.reason = r.reason as ProposalDecision["reason"];
    }
    if (r.note !== undefined) {
      if (typeof r.note !== "string") {
        return {
          problem: {
            type: "invalidProperties",
            description: "decision.note must be a string",
            properties: ["decision"],
          },
        };
      }
      decision.note = r.note;
    }
  }
  return { value: decision };
}

/**
 * Mirrors `applyProposal` (:375-494) far enough for the queue: which kinds
 * apply, what they record, and the refusal for the rest. Returns a SetError
 * object or null on success.
 */
function applyDemo(
  row: ActionProposal,
  payload: Record<string, unknown>,
  applied: ApprovalsDemoBackend["applied"],
  sent: ApprovalsDemoBackend["sent"],
): Record<string, unknown> | null {
  switch (row.kind) {
    case "create-contact": {
      if (!payload.card || typeof payload.card !== "object") {
        return {
          type: "invalidProperties",
          description: "create-contact payload needs a `card`",
          properties: ["payload"],
        };
      }
      applied.push({
        id: row.id,
        kind: row.kind,
        undo: { action: "destroy-contact", cardId: `cc-${row.id}` },
      });
      return null;
    }
    case "reply-draft": {
      const to = typeof payload.to === "string" ? payload.to : "";
      const self = typeof payload.self === "string" ? payload.self : "";
      const blobId = typeof payload.blobId === "string" ? payload.blobId : "";
      if (!to || !self || !blobId) {
        return {
          type: "invalidProperties",
          description: "reply-draft payload needs to/self/blobId",
          properties: ["payload"],
        };
      }
      sent.push({
        id: row.id,
        to,
        subject: typeof payload.subject === "string" ? payload.subject : "",
      });
      return null;
    }
    case "grant-request":
      // Recorded here; MINTING the grant is provision's job (:481-485).
      return null;
    default:
      return {
        type: "invalidProperties",
        description: `approving a "${row.kind}" proposal is not applied in this slice (s03.D T1)`,
        properties: ["kind"],
      };
  }
}

function pickProps(full: Record<string, unknown>, properties: string[] | null): Record<string, unknown> {
  if (!properties) return { ...full };
  const picked: Record<string, unknown> = { id: full.id };
  for (const p of properties) if (p in full) picked[p] = full[p];
  return picked;
}
