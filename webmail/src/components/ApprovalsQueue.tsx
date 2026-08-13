/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import { resolveClient } from "../lib/app/client";
import { correctDueAt, decide, loadQueue, type Verdict } from "../lib/approvals/api";
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
import {
  applyEdit,
  diffLines,
  editorFor,
  payloadDiff,
  type EditorForm,
} from "../lib/approvals/edit";
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
  REJECT_REASONS,
  TIER3_CAPABILITY_NOTE,
  approvalsAccountId,
  approvalsGate,
  approveVerb,
  describeReason,
  payloadText,
  summarizeProposal,
  tierLabel,
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
  /** Account state string — the `ifInState` guard on every decision. */
  const [state, setState] = useState("");
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
            const { demoApprovalsOptions, installApprovalsDemo } = await import(
              "../lib/approvals/demoApprovals"
            );
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
  const accountId = session ? approvalsAccountId(session) : "";

  // ── the queue ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!client || !accountId || gate.state !== "open") return;
    let cancelled = false;
    setLoading(true);
    void loadQueue(client, accountId)
      .then((res) => {
        if (cancelled) return;
        setProposals(res.proposals);
        setState(res.state);
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
  }, [client, accountId, gate.state]);

  const ordered = useMemo(() => orderQueue(proposals), [proposals]);
  const pending = ordered.filter((p) => p.status === "pending");
  const infoRequested = ordered.filter((p) => p.status === "info-requested");
  const held = ordered.filter((p) => p.status === "held");
  const history = ordered.filter(
    (p) => p.status !== "pending" && p.status !== "info-requested" && p.status !== "held",
  );

  async function reload(): Promise<void> {
    if (!client || !accountId) return;
    const res = await loadQueue(client, accountId);
    setProposals(res.proposals);
    setState(res.state);
  }

  async function act(id: string, verdict: Verdict): Promise<void> {
    if (!client || busyId) return;
    setBusyId(id);
    setRowErrors((prev) => ({ ...prev, [id]: "" }));
    const outcome = await decide(client, accountId, id, verdict, {
      ...(state ? { ifInState: state } : {}),
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
    setBusyId(id);
    setRowErrors((prev) => ({ ...prev, [id]: "" }));
    const outcome = await correctDueAt(client, accountId, id, dueAt, {
      ...(state ? { ifInState: state } : {}),
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
  if (fatal) {
    return (
      <main class="shell shell-error">
        <h1>Approvals</h1>
        <p role="alert">Could not reach the server: {fatal}</p>
      </main>
    );
  }
  if (!session) {
    return (
      <main class="shell">
        <p class="muted">Connecting…</p>
      </main>
    );
  }
  // The plain-client floor (arch.md §8.6): capability absent → an explanation,
  // not an error and not a dead region.
  if (gate.state !== "open") {
    return (
      <main class="shell">
        <h1>Approvals</h1>
        <p class="muted">{gate.reason}</p>
        <p class="muted">
          <a href="/mail">← back to mail</a>
        </p>
      </main>
    );
  }

  return (
    <main class="apq">
      {isDemo ? (
        <p class="banner">
          Sample data. Decisions here are kept in this browser tab and reach no server.
        </p>
      ) : null}

      <header class="apq-head">
        <h1>Approvals</h1>
        <p class="muted apq-sub">
          What agents want to do, waiting on you. Approve, edit, or decline — an edit is kept
          beside the agent's original, so the difference is never lost.
        </p>
      </header>

      {loading ? <p class="muted apq-pad">Loading the queue…</p> : null}

      {!loading && pending.length === 0 ? (
        <p class="muted apq-pad">Nothing is waiting on you.</p>
      ) : null}

      <section aria-label="Waiting on you">
        {pending.map((p) => (
          <PendingRow
            key={p.id}
            p={p}
            now={now}
            busy={busyId === p.id}
            error={rowErrors[p.id]}
            panel={panel && panel.id === p.id ? panel : undefined}
            setPanel={setPanel}
            onApprove={() => void act(p.id, { status: "approved" })}
            onDecline={(reason, note) =>
              void act(p.id, { status: "rejected", reason, ...(note ? { note } : {}) })
            }
            onNeedsInfo={(question) => void act(p.id, { status: "info-requested", question })}
            onSubmitEdit={(form) => submitEdit(p, form)}
            onCorrectDue={(dueAt) => void correctDue(p.id, dueAt)}
          />
        ))}
      </section>

      {infoRequested.length > 0 ? (
        <section aria-label="Waiting on the agent">
          <h2 class="apq-h2">Waiting on the agent</h2>
          <p class="muted apq-fine">
            You asked; the agent owes an answer. Each returns to the queue with its dialogue
            attached, and its decision deadline is paused meanwhile.
          </p>
          {infoRequested.map((p) => (
            <InfoRequestedRow key={p.id} p={p} />
          ))}
        </section>
      ) : null}

      {held.length > 0 ? (
        <section aria-label="Hold tray">
          <h2 class="apq-h2">Hold tray</h2>
          <p class="muted apq-fine">
            Approved, retractable, not yet committed. Nothing here has been sent.
          </p>
          {held.map((p) => (
            <HeldRow key={p.id} p={p} now={now} />
          ))}
        </section>
      ) : null}

      {history.length > 0 ? (
        <section aria-label="Decided">
          <h2 class="apq-h2">Decided</h2>
          {history.map((p) => (
            <HistoryRow key={p.id} p={p} now={now} />
          ))}
        </section>
      ) : null}
    </main>
  );
}

// ── rows ──────────────────────────────────────────────────────────────────

function PendingRow(props: {
  p: ActionProposal;
  now: number;
  busy: boolean;
  error: string | undefined;
  panel: Panel | undefined;
  setPanel: (panel: Panel | undefined) => void;
  onApprove: () => void;
  onDecline: (reason: RejectReason, note: string) => void;
  onNeedsInfo: (question: string) => void;
  onSubmitEdit: (form: EditorForm) => void;
  onCorrectDue: (dueAt: string | null) => void;
}) {
  const { p, now, busy, error, panel, setPanel } = props;
  const clocks = rowClocks(p, now);
  const editor = editorFor(p);
  const text = payloadText(p.payload);

  return (
    <article class={`apq-row${isNearExpiry(clocks) ? " apq-urgent" : ""}`}>
      <RowHead p={p} />
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
          onChange={(reason, note) => setPanel({ id: p.id, kind: "decline", reason, note })}
          onSubmit={() => panel.reason && props.onDecline(panel.reason, panel.note)}
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
function InfoRequestedRow({ p }: { p: ActionProposal }) {
  const open = openQuestion(p);
  return (
    <article class="apq-row apq-held">
      <RowHead p={p} />
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

function HeldRow({ p, now }: { p: ActionProposal; now: number }) {
  const clocks = rowClocks(p, now);
  return (
    <article class="apq-row apq-held">
      <RowHead p={p} />
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

function HistoryRow({ p, now }: { p: ActionProposal; now: number }) {
  const clocks = rowClocks(p, now);
  return (
    <article class="apq-row apq-done">
      <RowHead p={p} />
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

function RowHead({ p }: { p: ActionProposal }) {
  return (
    <header class="apq-rowhead">
      <span class="pill">{p.agent}</span>
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
              onInput={(e) =>
                props.onChange({ ...form, subject: (e.target as HTMLInputElement).value })
              }
            />
          </label>
          <label class="apq-label">
            Body
            <textarea
              rows={8}
              value={form.text}
              onInput={(e) =>
                props.onChange({ ...form, text: (e.target as HTMLTextAreaElement).value })
              }
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
  onChange: (reason: RejectReason | undefined, note: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div class="apq-editor">
      <p class="apq-fine">
        Why not? Each reason steers a different correction — the last one is a hard stop, not a
        stronger no.
      </p>
      {REJECT_REASONS.map((r) => (
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
        <button type="button" class="danger" disabled={props.busy || !props.reason} onClick={props.onSubmit}>
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
        When the work itself is due — the agent read it out of the message, so
        fix it if the reading is wrong. Clearing it means "no deadline": the
        work is never treated as urgent.
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
