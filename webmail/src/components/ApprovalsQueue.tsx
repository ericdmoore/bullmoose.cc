/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import { resolveClient } from "../lib/app/client";
import { correctDueAt, decide, loadQueues, type Verdict } from "../lib/approvals/api";
import {
  dueFromInput,
  dueInputValue,
  dueLabel,
  expiryLabel,
  holdLabel,
  isNearExpiry,
  orderQueue,
  rowClocks,
  waitedLabel,
} from "../lib/approvals/clocks";
import { applyEdit, diffLines, editorFor, payloadDiff, type EditorForm } from "../lib/approvals/edit";
import {
  NEEDS_INFO_HINT,
  NEEDS_INFO_VERB,
  WAITING_ON_AGENT_NOTE,
  answeredRounds,
  openQuestion,
  questionProblem,
} from "../lib/approvals/needsInfo";
import {
  HOLD_UNWIRED_NOTE,
  declineNeedsReason,
  REJECT_REASONS,
  TIER3_CAPABILITY_NOTE,
  accountLabel,
  approvalsAccounts,
  approvalsGate,
  approveVerb,
  describeReason,
  payloadText,
  rowAuthority,
  summarizeProposal,
  tierLabel,
  type ApprovalsAccount,
} from "../lib/approvals/rows";
import type { ActionProposal, RejectReason } from "../lib/approvals/types";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Session } from "../lib/jmap/types";

// The approval queue (s07 T4) — the cross-agent review surface, and the
// section the nav leads with because deciding is what you arrive to do.
//
// Deliberately THIN, the split every island here follows (SettingsPanel.tsx:33,
// CalendarView.tsx): vitest runs in plain Node with no jsdom, so every rule
// lives in `lib/approvals/*` as a tested pure function — the two-clock
// arithmetic and the queue order in `clocks.ts`, the retained-diff edit
// contract in `edit.ts`, tier/verb/gate wording in `rows.ts`, the JMAP calls
// in `api.ts`. This file is state plumbing and markup; if a decision appears
// in it, it is in the wrong file.

interface Props {
  /** Injected in tests; the screen resolves its own otherwise. */
  client?: JmapClient;
  /** Fixes the clocks for a deterministic render; live ticking otherwise. */
  now?: number;
}

/** The one inline panel a row can have open: the editor, the decline form,
 * the needs-info question (s10 T3), or the due-date correction (s11 T1). */
type Panel =
  | { id: string; kind: "edit"; form: EditorForm }
  | { id: string; kind: "decline"; reason?: RejectReason; note: string }
  | { id: string; kind: "needs-info"; question: string }
  | { id: string; kind: "due"; value: string };

export default function ApprovalsQueue({ client: injectedClient, now: fixedNow }: Props) {
  const [client, setClient] = useState<JmapClient | undefined>(injectedClient);
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [isDemo, setIsDemo] = useState(false);
  const [fatal, setFatal] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const [proposals, setProposals] = useState<ActionProposal[]>([]);
  /** Per-account state strings — the `ifInState` guard on every decision. One
   *  per account, because the queue spans several and a state from account A
   *  would fail (or worse, pass) against account B (s10 T7). */
  const [states, setStates] = useState<Record<string, string>>({});
  /** accountId → why its queue is missing. Shown, never swallowed. */
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [panel, setPanel] = useState<Panel | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  // Both clocks tick off ONE `now`, once a second — often enough that
  // "waited for grows, expires in shrinks" is something you can watch.
  const [now, setNow] = useState<number>(() => fixedNow ?? Date.now());
  useEffect(() => {
    if (fixedNow !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [fixedNow]);

  // ── bootstrap ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let jmap = injectedClient;
        if (!jmap) {
          const resolved = resolveClient();
          // Same rule as every other section: no session → the door, never a
          // convincing sample queue a stranger could mistake for theirs
          // (lib/app/client.ts).
          if (resolved.mode === "unauthenticated") {
            location.assign("/login");
            return;
          }
          if (resolved.mode === "demo") {
            // Demo-only and loaded on demand, so the fixtures and the fake
            // `/set` never reach a live bundle (the demoCalendar.ts pattern).
            const { demoApprovalsOptions, installApprovalsDemo } = await import("../lib/approvals/demoApprovals");
            installApprovalsDemo(resolved.demo.client, demoApprovalsOptions(location.search));
            if (!cancelled) setIsDemo(true);
          }
          jmap = resolved.client;
        }
        const live = await jmap.session();
        if (cancelled) return;
        setSession(live);
        setClient(jmap);
      } catch (err) {
        if (!cancelled) setFatal(message(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [injectedClient]);

  const gate = approvalsGate(session);
  // EVERY account the human can reach, not just the session's default (s10
  // T7): an agent is its own principal, so its proposals live on its own
  // account and reach it only through the supervisory grant provisioning
  // mints. `accountKey` keeps the effect from re-firing on an equal array.
  const accounts = useMemo(() => (session ? approvalsAccounts(session) : []), [session]);
  const accountKey = accounts.map((a) => a.accountId).join(",");

  // ── the queue ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!client || accounts.length === 0 || gate.state !== "open") return;
    let cancelled = false;
    setLoading(true);
    void loadQueues(
      client,
      accounts.map((a) => a.accountId),
    )
      .then((res) => {
        if (cancelled) return;
        setProposals(res.proposals);
        setStates(res.states);
        setFailures(res.failures);
        setLoading(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setFatal(message(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, accountKey, gate.state]);

  const ordered = useMemo(() => orderQueue(proposals), [proposals]);
  const pending = ordered.filter((p) => p.status === "pending");
  const infoRequested = ordered.filter((p) => p.status === "info-requested");
  const held = ordered.filter((p) => p.status === "held");
  const history = ordered.filter((p) => p.status !== "pending" && p.status !== "info-requested" && p.status !== "held");

  // Master-detail (triple panel, s07 T10 / Eric 2026-08-15): the rail is the
  // shell, this island owns the middle "headers" column and the right detail.
  // `ordered` already sorts pending-first with the near-due at the top, so the
  // first item is the one most wanting a decision — the right default focus.
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const selected = ordered.find((p) => p.id === selectedId) ?? ordered[0];
  // Keep a valid selection as the queue changes under us (a decided row leaves,
  // a new proposal arrives) without yanking focus off something the human is
  // mid-decision on.
  useEffect(() => {
    if (ordered.length === 0) {
      if (selectedId !== undefined) setSelectedId(undefined);
      return;
    }
    if (!ordered.some((p) => p.id === selectedId)) setSelectedId(ordered[0]!.id);
  }, [ordered, selectedId]);

  async function reload(): Promise<void> {
    if (!client || accounts.length === 0) return;
    const res = await loadQueues(
      client,
      accounts.map((a) => a.accountId),
    );
    setProposals(res.proposals);
    setStates(res.states);
    setFailures(res.failures);
  }

  async function act(id: string, verdict: Verdict): Promise<void> {
    if (!client || busyId) return;
    const p = proposals.find((row) => row.id === id);
    if (!p) return;
    setBusyId(id);
    setRowErrors((prev) => ({ ...prev, [id]: "" }));
    // The proposal's OWN account — never the session default. A decision sent
    // to the wrong account is a `notFound` at best (s10 T7).
    const outcome = await decide(client, p.accountId, id, verdict, {
      ...(states[p.accountId] ? { ifInState: states[p.accountId] as string } : {}),
    });
    if (!outcome.ok) {
      // The server's sentence, verbatim — the tier-3 capability refusal in
      // particular should read as the wall it is, not as a generic failure.
      setRowErrors((prev) => ({ ...prev, [id]: outcome.message }));
      // A stateMismatch means the queue moved under us; re-read either way so
      // the next attempt runs against the real state.
      await reload().catch(() => undefined);
      setBusyId(undefined);
      return;
    }
    setPanel(undefined);
    await reload().catch((err) => setFatal(message(err)));
    setBusyId(undefined);
  }

  // The due-date CORRECTION (s11 T1) — deliberately not a verdict, so it does
  // not go through act(): the row stays pending, only the third clock moves.
  async function correctDue(id: string, dueAt: string | null): Promise<void> {
    if (!client || busyId) return;
    const p = proposals.find((row) => row.id === id);
    if (!p) return;
    setBusyId(id);
    setRowErrors((prev) => ({ ...prev, [id]: "" }));
    const outcome = await correctDueAt(client, p.accountId, id, dueAt, {
      ...(states[p.accountId] ? { ifInState: states[p.accountId] as string } : {}),
    });
    if (!outcome.ok) {
      setRowErrors((prev) => ({ ...prev, [id]: outcome.message }));
      await reload().catch(() => undefined);
      setBusyId(undefined);
      return;
    }
    setPanel(undefined);
    await reload().catch((err) => setFatal(message(err)));
    setBusyId(undefined);
  }

  function submitEdit(p: ActionProposal, form: EditorForm): void {
    const { editedPayload, problem } = applyEdit(p.payload, form);
    if (problem) {
      setRowErrors((prev) => ({ ...prev, [p.id]: problem }));
      return;
    }
    // No changes → a clean approve: `editedPayload` is deliberately absent so
    // the row does not masquerade as "approved after edit" (edit.ts).
    void act(p.id, { status: "approved", ...(editedPayload ? { editedPayload } : {}) });
  }

  // ── shells ──────────────────────────────────────────────────────────────
  // These are `div`, not `main`: AppTw.astro already renders the page's one
  // `<main>` around the slot, so an island that renders its own nests a
  // landmark inside a landmark — invalid HTML, and two "main" regions for a
  // screen reader to choose between. The island owns the CONTENT; the layout
  // owns the frame. (Every other island still does this — see the note in
  // AppTw.astro.)
  if (fatal) {
    return (
      <div class="shell shell-error">
        <h1>Approvals</h1>
        <p role="alert">Could not reach the server: {fatal}</p>
      </div>
    );
  }
  if (!session) {
    return (
      <div class="shell">
        <p class="muted">Connecting…</p>
      </div>
    );
  }
  // The plain-client floor (arch.md §8.6): capability absent → an explanation,
  // not an error and not a dead region.
  if (gate.state !== "open") {
    return (
      <div class="shell">
        <h1>Approvals</h1>
        <p class="muted">{gate.reason}</p>
        <p class="muted">
          <a href="/mail">← back to mail</a>
        </p>
      </div>
    );
  }

  return (
    <div class="apq">
      {isDemo ? (
        <p class="banner">Sample data. Decisions here are kept in this browser tab and reach no server.</p>
      ) : null}

      <header class="apq-head">
        <h1>Approvals</h1>
        <p class="muted apq-sub">
          What agents want to do, waiting on you. Approve, edit, or decline — an edit is kept beside the agent's
          original, so the difference is never lost.
        </p>
        {/* The queue spans every account you can reach — yours, and each agent
            account a supervisory grant opens (s10 T7). Saying so is what makes
            a row labelled "editor@…" legible rather than surprising. */}
        {accounts.length > 1 ? (
          <p class="muted apq-fine">
            Across {accounts.length} accounts: {accounts.map((a) => a.name).join(", ")}.
          </p>
        ) : null}
      </header>

      {/* One account failing must not take the queue down, and must not vanish
          either — "nothing is waiting on you" was the original lie. */}
      {Object.entries(failures).map(([id, why]) => (
        <p key={id} class="apq-error" role="alert">
          {accountLabel(accounts, id)}: {why}
        </p>
      ))}

      {loading ? <p class="muted apq-pad">Loading the queue…</p> : null}

      {!loading && pending.length === 0 ? <p class="muted apq-pad">Nothing is waiting on you.</p> : null}

      {ordered.length > 0 ? (
        <div class="apq-panes grid grid-cols-1 lg:grid-cols-[22rem_1fr]">
          {/* COLUMN 2 — the headers. A compact, grouped, selectable list:
              what needs you first, then the secondary states. This is the
              "second column" of the triple-panel; the rail is the first.

              It scrolls ITSELF (`apq-pane`) rather than sticking to the
              viewport. Sticky was the right tool when the document scrolled;
              now the page is exactly one window tall and each pane owns its
              own overflow, which is what Mail does and why its list and
              message move independently. */}
          <nav aria-label="Proposals" class="apq-pane">
            <HeaderGroup
              label="Waiting on you"
              tone="primary"
              items={pending}
              now={now}
              accounts={accounts}
              selectedId={selected?.id}
              onSelect={setSelectedId}
            />
            <HeaderGroup
              label="Waiting on the agent"
              items={infoRequested}
              now={now}
              accounts={accounts}
              selectedId={selected?.id}
              onSelect={setSelectedId}
            />
            <HeaderGroup
              label="Hold tray"
              items={held}
              now={now}
              accounts={accounts}
              selectedId={selected?.id}
              onSelect={setSelectedId}
            />
            <HeaderGroup
              label="Decided"
              items={history}
              now={now}
              accounts={accounts}
              selectedId={selected?.id}
              onSelect={setSelectedId}
              muted
            />
          </nav>

          {/* COLUMN 3 — the detail, subordinate to the header column: the full
              row for whatever is selected, its actions intact. Scrolls itself,
              so a long proposal never pushes the header list off-screen. */}
          <section aria-label="Detail" class="apq-pane min-w-0">
            {selected ? (
              selected.status === "pending" ? (
                <PendingRow
                  key={selected.id}
                  p={selected}
                  account={accounts.find((a) => a.accountId === selected.accountId)}
                  showAccount={accounts.length > 1}
                  now={now}
                  busy={busyId === selected.id}
                  error={rowErrors[selected.id]}
                  panel={panel && panel.id === selected.id ? panel : undefined}
                  setPanel={setPanel}
                  onApprove={() => void act(selected.id, { status: "approved" })}
                  onDecline={(reason, note) =>
                    void act(selected.id, { status: "rejected", reason, ...(note ? { note } : {}) })
                  }
                  onNeedsInfo={(question) => void act(selected.id, { status: "info-requested", question })}
                  onSubmitEdit={(form) => submitEdit(selected, form)}
                  onCorrectDue={(dueAt) => void correctDue(selected.id, dueAt)}
                />
              ) : selected.status === "info-requested" ? (
                <InfoRequestedRow
                  p={selected}
                  label={accounts.length > 1 ? accountLabel(accounts, selected.accountId) : ""}
                />
              ) : selected.status === "held" ? (
                <HeldRow
                  p={selected}
                  now={now}
                  label={accounts.length > 1 ? accountLabel(accounts, selected.accountId) : ""}
                />
              ) : (
                <HistoryRow
                  p={selected}
                  now={now}
                  label={accounts.length > 1 ? accountLabel(accounts, selected.accountId) : ""}
                />
              )
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One group in the header column (s07 T10). Compact, selectable rows — sender/
 * summary, a tier chip, and how long it has waited — under a small heading so
 * "waiting on you" reads apart from "decided". Renders nothing when empty, so
 * the column shows only the states that actually have items.
 */
function HeaderGroup(props: {
  label: string;
  items: ActionProposal[];
  now: number;
  accounts: ApprovalsAccount[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  tone?: "primary";
  muted?: boolean;
}) {
  const { label, items, now, accounts, selectedId, onSelect, tone, muted } = props;
  if (items.length === 0) return null;
  return (
    <div class="mb-4">
      <h2
        class={"px-2 pb-1 text-xs font-semibold tracking-wide uppercase " + (muted ? "text-gray-400" : "text-gray-500")}
      >
        {label} <span class="ml-1 font-normal text-gray-400">{items.length}</span>
      </h2>
      <ul role="list" class="space-y-0.5">
        {items.map((p) => {
          const active = p.id === selectedId;
          const waited = waitedLabel(p, rowClocks(p, now));
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onSelect(p.id)}
                aria-current={active ? "true" : undefined}
                class={
                  "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-2 text-left text-sm " +
                  (active
                    ? "bg-brand-50 ring-1 ring-brand-500/30 dark:bg-white/10"
                    : "hover:bg-gray-50 dark:hover:bg-white/5")
                }
              >
                <span class={"line-clamp-2 " + (muted ? "text-gray-500" : "font-medium text-gray-900 dark:text-white")}>
                  {summarizeProposal(p)}
                </span>
                <span class="flex items-center gap-x-2 text-xs text-gray-500">
                  <span
                    class={
                      "rounded px-1.5 py-0.5 " +
                      (tone === "primary"
                        ? "bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-100"
                        : "bg-gray-100 dark:bg-white/10")
                    }
                  >
                    {tierLabel(p.tier)}
                  </span>
                  {accounts.length > 1 ? <span>{accountLabel(accounts, p.accountId)}</span> : null}
                  {waited ? <span class="truncate">· {waited}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── rows ──────────────────────────────────────────────────────────────────

function PendingRow(props: {
  p: ActionProposal;
  /** The account this row came off — absent means unreachable (rowAuthority). */
  account: ApprovalsAccount | undefined;
  /** Label the row with its account? Only worth the pill on a merged queue. */
  showAccount: boolean;
  now: number;
  busy: boolean;
  error: string | undefined;
  panel: Panel | undefined;
  setPanel: (panel: Panel | undefined) => void;
  onApprove: () => void;
  onDecline: (reason: RejectReason | undefined, note: string) => void;
  onNeedsInfo: (question: string) => void;
  onSubmitEdit: (form: EditorForm) => void;
  onCorrectDue: (dueAt: string | null) => void;
}) {
  const { p, account, now, busy, error, panel, setPanel } = props;
  const clocks = rowClocks(p, now);
  const editor = editorFor(p);
  const text = payloadText(p.payload);
  // What this row may OFFER. A proposal on an account you merely READ must not
  // show a decide button you cannot use (s10 T7) — and a tier-3 on an account
  // whose access lacks `send` keeps decline/needsInfo, because the question is
  // still genuinely waiting on you.
  const authority = rowAuthority(p, account);

  return (
    <article class={`apq-row${isNearExpiry(clocks) ? " apq-urgent" : ""}`}>
      <RowHead p={p} label={props.showAccount ? (account?.name ?? p.accountId) : ""} />
      <p class="apq-summary">{summarizeProposal(p)}</p>
      <p class="apq-rationale">{p.rationale}</p>
      <Evidence evidence={p.evidence} />
      <Dialogue p={p} />
      {text ? <pre class="apq-body">{text}</pre> : null}

      {/* Three clocks, three sources, never conflated (clocks.ts): the two
          opposed decision marks, and beside them the WORK's own deadline
          (s11 T1) — inferred at the boundary, correctable right here, because
          a silently mis-read due date is the failure the readme warns about. */}
      <p class="apq-clocks">
        <span class="apq-waited">{waitedLabel(p, clocks)}</span>
        <span class={`apq-expiry${isNearExpiry(clocks) ? " apq-expiry-near" : ""}`}>
          {expiryLabel(clocks.expiresInMs)}
        </span>
        <span class="apq-due">
          {dueLabel(p.dueAt, now)}{" "}
          <button
            type="button"
            class="apq-due-correct"
            disabled={busy}
            title="The agent inferred this from the message — fix it if it mis-read"
            onClick={() => setPanel({ id: p.id, kind: "due", value: dueInputValue(p.dueAt) })}
          >
            correct
          </button>
        </span>
      </p>

      {p.tier === 3 ? <p class="apq-fine apq-warn">{TIER3_CAPABILITY_NOTE}</p> : null}
      {error ? (
        <p class="apq-error" role="alert">
          {error}
        </p>
      ) : null}

      {panel?.kind === "edit" ? (
        <EditPanel
          form={panel.form}
          original={p.payload}
          busy={busy}
          onChange={(form) => setPanel({ id: p.id, kind: "edit", form })}
          onSubmit={() => props.onSubmitEdit(panel.form)}
          onCancel={() => setPanel(undefined)}
        />
      ) : panel?.kind === "decline" ? (
        <DeclinePanel
          reason={panel.reason}
          note={panel.note}
          busy={busy}
          needsReason={declineNeedsReason(p.kind)}
          onChange={(reason, note) => setPanel({ id: p.id, kind: "decline", reason, note })}
          onSubmit={() => {
            if (declineNeedsReason(p.kind) && !panel.reason) return;
            props.onDecline(panel.reason, panel.note);
          }}
          onCancel={() => setPanel(undefined)}
        />
      ) : panel?.kind === "needs-info" ? (
        <NeedsInfoPanel
          question={panel.question}
          busy={busy}
          onChange={(question) => setPanel({ id: p.id, kind: "needs-info", question })}
          onSubmit={() => props.onNeedsInfo(panel.question.trim())}
          onCancel={() => setPanel(undefined)}
        />
      ) : panel?.kind === "due" ? (
        <DuePanel
          value={panel.value}
          busy={busy}
          onChange={(value) => setPanel({ id: p.id, kind: "due", value })}
          onSubmit={() => props.onCorrectDue(dueFromInput(panel.value))}
          onClear={() => props.onCorrectDue(null)}
          onCancel={() => setPanel(undefined)}
        />
      ) : (
        <div class="actions">
          {authority.canApprove ? (
            <>
              <button type="button" disabled={busy} onClick={props.onApprove}>
                {approveVerb(p.tier)}
              </button>
              {editor ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPanel({ id: p.id, kind: "edit", form: editor })}
                >
                  Edit
                </button>
              ) : null}
            </>
          ) : null}
          {authority.canDecline ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => setPanel({ id: p.id, kind: "needs-info", question: "" })}
              >
                {NEEDS_INFO_VERB}
              </button>
              <button
                type="button"
                class="danger"
                disabled={busy}
                onClick={() => setPanel({ id: p.id, kind: "decline", note: "" })}
              >
                Decline
              </button>
            </>
          ) : null}
          {/* Withheld verbs are EXPLAINED, never silently missing: a row with
              no buttons and no sentence reads as a broken screen. */}
          {authority.note ? <span class="apq-fine apq-warn">{authority.note}</span> : null}
        </div>
      )}
    </article>
  );
}

/**
 * An `info-requested` row (s10 T3): waiting on the AGENT, so no verbs and no
 * running clocks — the decision deadline is paused server-side, and rendering
 * the question is the point: the row must say what is owed and by whom.
 */
function InfoRequestedRow({ p, label }: { p: ActionProposal; label: string }) {
  const open = openQuestion(p);
  return (
    <article class="apq-row apq-held">
      <RowHead p={p} label={label} />
      <p class="apq-summary">{summarizeProposal(p)}</p>
      <p class="apq-rationale">{p.rationale}</p>
      <Dialogue p={p} />
      {open ? (
        <p class="apq-question">
          <span class="muted">you asked:</span> “{open.question}”
        </p>
      ) : null}
      <p class="apq-clocks">
        <span class="apq-hold">{WAITING_ON_AGENT_NOTE}</span>
      </p>
    </article>
  );
}

function HeldRow({ p, now, label }: { p: ActionProposal; now: number; label: string }) {
  const clocks = rowClocks(p, now);
  return (
    <article class="apq-row apq-held">
      <RowHead p={p} label={label} />
      <p class="apq-summary">{summarizeProposal(p)}</p>
      <p class="apq-clocks">
        <span class="apq-waited">{waitedLabel(p, clocks)}</span>
        <span class="apq-hold">{holdLabel(clocks.holdRemainingMs)}</span>
      </p>
      <EditedDiff p={p} />
      {/* The tray's exit exists in the design and NOT in the server: showing
          live buttons would claim an egress path this slice does not have, and
          hiding them would hide that held ≠ done. Disabled, with the reason. */}
      <div class="actions">
        <button type="button" disabled title={HOLD_UNWIRED_NOTE}>
          Commit now
        </button>
        <button type="button" class="danger" disabled title={HOLD_UNWIRED_NOTE}>
          Yank
        </button>
        <span class="apq-fine">{HOLD_UNWIRED_NOTE}</span>
      </div>
    </article>
  );
}

function HistoryRow({ p, now, label }: { p: ActionProposal; now: number; label: string }) {
  const clocks = rowClocks(p, now);
  return (
    <article class="apq-row apq-done">
      <RowHead p={p} label={label} />
      <p class="apq-summary">{summarizeProposal(p)}</p>
      <p class="apq-clocks">
        <span class="apq-waited">{waitedLabel(p, clocks)}</span>
        {p.status === "expired" ? (
          <span class="apq-expiry apq-expiry-near">expired undecided — the chance lapsed</span>
        ) : null}
      </p>
      {p.decision ? (
        <p class="apq-fine">
          {p.status} by {p.decision.by}
          {/* describeReason, not the raw value: a decision recorded under an
              older taxonomy renders as itself and marked retired, because
              history is not migrated (rows.ts, decline-taxonomy.md). */}
          {p.decision.reason ? ` — ${describeReason(p.decision.reason)}` : ""}
          {p.decision.note ? ` — “${p.decision.note}”` : ""}
        </p>
      ) : null}
      <Dialogue p={p} />
      <EditedDiff p={p} />
    </article>
  );
}

/**
 * The needsInfo dialogue (s10 T3) — every ANSWERED round, attached to the
 * proposal wherever it renders. A challenged-then-approved grant carrying its
 * question and answer is the strongest "why" the provenance chain can hold,
 * so the record travels with the row through pending, decided and history.
 */
function Dialogue({ p }: { p: ActionProposal }) {
  const rounds = answeredRounds(p);
  if (rounds.length === 0) return null;
  return (
    <div class="apq-dialogue">
      {rounds.map((a, i) => (
        <div key={i} class="apq-round">
          <p class="apq-question">
            <span class="muted">{a.askedBy} asked:</span> “{a.question}”
          </p>
          <p class="apq-answer">
            <span class="muted">{p.agent} answered:</span> {a.answer}
          </p>
        </div>
      ))}
    </div>
  );
}

/** `label` is the row's ACCOUNT, shown only on a merged queue — telling
 *  Emily's ask from Allen's is the whole point of spanning accounts, and the
 *  binding name alone does not say which account it ran on. */
function RowHead({ p, label }: { p: ActionProposal; label: string }) {
  return (
    <header class="apq-rowhead">
      <span class="pill">{p.agent}</span>
      {label ? <span class="pill apq-account">{label}</span> : null}
      <span class="pill">{p.kind}</span>
      <span class={`pill apq-tier-${p.tier}`}>{tierLabel(p.tier)}</span>
      {p.status !== "pending" ? <span class={`pill apq-status-${p.status}`}>{p.status}</span> : null}
    </header>
  );
}

function Evidence({ evidence }: { evidence: ActionProposal["evidence"] }) {
  if (evidence.length === 0) return null;
  return (
    <p class="apq-evidence">
      <span class="muted">looked at:</span>{" "}
      {evidence.map((e, i) => (
        <span key={i} class="apq-evidence-item">
          {e.realm} {e.objectId}
          {e.note ? ` — ${e.note}` : ""}
          {i < evidence.length - 1 ? "; " : ""}
        </span>
      ))}
    </p>
  );
}

/**
 * "Edited before approval" — the retained original against the human's
 * version. Renders only when an edit actually landed; a `<details>` so the
 * queue stays scannable and the diff costs a click, not a route.
 */
function EditedDiff({ p }: { p: ActionProposal }) {
  if (!p.editedPayload) return null;
  const fields = payloadDiff(p.payload, p.editedPayload);
  if (fields.length === 0) return null;
  return (
    <details class="apq-diff">
      <summary>edited before approval — the agent's version vs yours</summary>
      {fields.map((f) =>
        f.key === "text" && typeof f.before === "string" && typeof f.after === "string" ? (
          <pre key={f.key} class="apq-diff-text">
            {diffLines(f.before, f.after).map((line, i) => (
              <span key={i} class={`apq-diff-${line.op}`}>
                {line.op === "del" ? "− " : line.op === "add" ? "+ " : "  "}
                {line.text}
                {"\n"}
              </span>
            ))}
          </pre>
        ) : (
          <p key={f.key} class="apq-fine">
            <code>{f.key}</code>: {JSON.stringify(f.before ?? null)} → {JSON.stringify(f.after ?? null)}
          </p>
        ),
      )}
    </details>
  );
}

function EditPanel(props: {
  form: EditorForm;
  original: Record<string, unknown>;
  busy: boolean;
  onChange: (form: EditorForm) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { form, original, busy } = props;
  // Live preview of what will be retained: a no-op edit approves clean.
  const preview = applyEdit(original, form);
  return (
    <div class="apq-editor">
      {form.shape === "reply" ? (
        <>
          <label class="apq-label">
            Subject
            <input
              type="text"
              value={form.subject}
              onInput={(e) => props.onChange({ ...form, subject: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="apq-label">
            Body
            <textarea
              rows={8}
              value={form.text}
              onInput={(e) => props.onChange({ ...form, text: (e.target as HTMLTextAreaElement).value })}
            />
          </label>
        </>
      ) : (
        <label class="apq-label">
          Payload (JSON)
          <textarea
            rows={10}
            spellcheck={false}
            value={form.json}
            onInput={(e) => props.onChange({ ...form, json: (e.target as HTMLTextAreaElement).value })}
          />
        </label>
      )}
      <p class="apq-fine">
        {preview.problem
          ? preview.problem
          : preview.editedPayload
            ? "Your version is kept beside the agent's original — the diff is the signal."
            : "No changes yet — approving now approves the agent's version unchanged."}
      </p>
      <div class="actions">
        <button type="button" disabled={busy || Boolean(preview.problem)} onClick={props.onSubmit}>
          {preview.editedPayload ? "Approve with edits" : "Approve unchanged"}
        </button>
        <button type="button" disabled={busy} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function DeclinePanel(props: {
  reason: RejectReason | undefined;
  note: string;
  busy: boolean;
  /** False on a NO-FAULT kind: the server refuses a reason there, so asking
   * for one would make the verb unsendable (`declineNeedsReason`). */
  needsReason: boolean;
  onChange: (reason: RejectReason | undefined, note: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div class="apq-editor">
      <p class="apq-fine">
        {props.needsReason
          ? "Why not? Each reason steers a different correction — the last one is a hard stop, not a stronger no."
          : "Declining this is an answer, not a complaint: nothing negative is recorded about the agent."}
      </p>
      {(props.needsReason ? REJECT_REASONS : []).map((r) => (
        <label key={r.reason} class={r.severe ? "apq-reason apq-reason-severe" : "apq-reason"}>
          <input
            type="radio"
            name="decline-reason"
            checked={props.reason === r.reason}
            onChange={() => props.onChange(r.reason, props.note)}
          />
          <span>
            {r.label} <span class="muted">— {r.hint}</span>
          </span>
        </label>
      ))}
      <label class="apq-label">
        Note (optional)
        <input
          type="text"
          value={props.note}
          onInput={(e) => props.onChange(props.reason, (e.target as HTMLInputElement).value)}
        />
      </label>
      <div class="actions">
        <button
          type="button"
          class="danger"
          disabled={props.busy || (props.needsReason && !props.reason)}
          onClick={props.onSubmit}
        >
          Decline
        </button>
        <button type="button" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The due-date correction (s11 T1). Local wall time in, ISO out
 * (clocks.ts `dueFromInput`); Clear sets never-urgent explicitly. The row
 * stays PENDING through all of it — this panel never decides anything.
 */
function DuePanel(props: {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  onCancel: () => void;
}) {
  return (
    <div class="apq-editor">
      <p class="apq-fine">
        When the work itself is due — the agent read it out of the message, so fix it if the reading is wrong. Clearing
        it means "no deadline": the work is never treated as urgent.
      </p>
      <label class="apq-label">
        Due (your local time)
        <input
          type="datetime-local"
          value={props.value}
          onInput={(e) => props.onChange((e.target as HTMLInputElement).value)}
        />
      </label>
      <div class="actions">
        <button type="button" disabled={props.busy || props.value.trim().length === 0} onClick={props.onSubmit}>
          Save due date
        </button>
        <button type="button" disabled={props.busy} onClick={props.onClear}>
          Clear — no deadline
        </button>
        <button type="button" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function NeedsInfoPanel(props: {
  question: string;
  busy: boolean;
  onChange: (question: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  // The problem string gates the button, same shape as the edit panel: an
  // empty question is refused a keystroke away, not a round trip away.
  const problem = questionProblem(props.question);
  return (
    <div class="apq-editor">
      <p class="apq-fine">{NEEDS_INFO_HINT}</p>
      <label class="apq-label">
        Your question (required)
        <input
          type="text"
          value={props.question}
          placeholder="Why do you need this?"
          onInput={(e) => props.onChange((e.target as HTMLInputElement).value)}
        />
      </label>
      <div class="actions">
        <button type="button" disabled={props.busy || Boolean(problem)} onClick={props.onSubmit}>
          Ask the agent
        </button>
        <button type="button" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
