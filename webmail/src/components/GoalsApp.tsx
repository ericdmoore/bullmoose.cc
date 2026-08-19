/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import { resolveClient } from "../lib/app/client";
import { approvalsAccountId } from "../lib/approvals/accounts";
import { hasAgentCapability } from "../lib/jmap/capabilities";
import { budgetLine, contractLines } from "../lib/goals/contract";
import {
  cancelGoal,
  createGoal,
  decidePlan,
  loadGoals,
  loadPlanPayload,
  setCheckpoint,
  type NewGoal,
} from "../lib/goals/api";
import {
  redlineActionLabel,
  redlineActionNote,
  redlineDecision,
  sketchToRows,
  type RedlineRow,
} from "../lib/goals/redline";
import {
  GOALS_EMPTY,
  GOALS_SUB,
  checkpointLine,
  milestoneLine,
  openPlanCheckpoint,
  orderGoals,
  orderMilestones,
  progressLine,
  statusLabel,
  statusNote,
} from "../lib/goals/view";
import type { CheckpointClass, Goal, PlanPayload } from "../lib/goals/types";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Session } from "../lib/jmap/types";

/**
 * Goals (s20 T6) — the delegation contract, with an approvable plan.
 *
 * The apex of the agent-native arc: verbs are atoms, an intent is a sentence,
 * and a **goal is standing authority**. Which makes this the one screen in the
 * product that renders authority you have already handed over — so it is built
 * around the two questions that make that safe: *what did I hand over?* (the
 * contract, verbatim, at the top of every goal) and *which checkpoints still
 * stop for me?* (per class, with why).
 *
 * ── THE REDLINE IS THE APPROVAL ────────────────────────────────────────────
 * When a plan checkpoint is open, the sketch renders HERE — where the goal was
 * expressed — and is edited in place. An edit that leaves nothing unresolved IS
 * the approval; a question is the needsInfo cycle back to the planner. There is
 * no second "…and do you approve?" and no goal-specific decision endpoint: both
 * paths send the ordinary `ActionProposal/set` verb, so the identical proposal,
 * decision and provenance rows are written as if it had gone through the queue.
 * The venue moves; the ledger does not.
 *
 * Deliberately THIN, the split every island here follows: vitest runs in plain
 * Node with no jsdom, so every rule lives in `lib/goals/*` as tested pure
 * functions — the fetches in `api.ts`, the redline's verdict in `redline.ts`,
 * the wording in `view.ts`. This file is state plumbing and composition; if a
 * decision appears in it, it is in the wrong file.
 */

interface Props {
  client?: JmapClient;
}

export default function GoalsApp({ client: injectedClient }: Props) {
  const [client, setClient] = useState<JmapClient | undefined>(injectedClient);
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [fatal, setFatal] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const [goals, setGoals] = useState<Goal[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let jmap = injectedClient;
        if (!jmap) {
          const resolved = resolveClient();
          // The rule every section follows: no session → the door, never a
          // convincing sample delegation a stranger could mistake for theirs.
          if (resolved.mode === "unauthenticated") {
            location.assign("/login");
            return;
          }
          jmap = resolved.client;
        }
        const live = await jmap.session();
        if (cancelled) return;
        setSession(live);
        setClient(jmap);
      } catch (err) {
        if (!cancelled) setFatal(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [injectedClient]);

  const accountId = useMemo(() => (session ? approvalsAccountId(session) : ""), [session]);

  useEffect(() => {
    if (!client || !accountId) return;
    let cancelled = false;
    setLoading(true);
    void loadGoals(client, accountId).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) {
        setNotice(res.message);
        return;
      }
      setNotice(undefined);
      setGoals(res.value);
    });
    return () => {
      cancelled = true;
    };
  }, [client, accountId, reloads]);

  const ordered = useMemo(() => orderGoals(goals), [goals]);
  const selected = ordered.find((g) => g.id === selectedId) ?? ordered[0];
  const reload = () => setReloads((n) => n + 1);

  if (fatal) {
    return (
      <div class="shell shell-error">
        <h1>Goals</h1>
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
  if (!hasAgentCapability(session)) {
    return (
      <div class="shell">
        <h1>Goals</h1>
        <p class="muted">
          This server does not advertise the bullmoose agent capability, so nothing can act in your name and there is
          nothing to delegate. Mail, contacts and calendar are unaffected.
        </p>
        <p class="muted">
          <a href="/mail">← back to mail</a>
        </p>
      </div>
    );
  }

  return (
    <div class="goal">
      <header class="goal-head">
        <h1>Goals</h1>
        <p class="muted goal-sub">{GOALS_SUB}</p>
        {notice ? <p class="goal-error">{notice}</p> : null}
      </header>

      <div class="goal-panes">
        <section class="goal-pane goal-list" aria-label="Your goals">
          <NewGoalForm client={client} accountId={accountId} onCreated={reload} />
          {loading ? <p class="muted">Loading…</p> : null}
          {!loading && ordered.length === 0 ? <p class="muted goal-empty">{GOALS_EMPTY}</p> : null}
          <ul class="goal-rows">
            {ordered.map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  class={g.id === selected?.id ? "goal-row goal-row-on" : "goal-row"}
                  onClick={() => setSelectedId(g.id)}
                >
                  <span class="goal-row-statement">{g.statement}</span>
                  <span class="goal-row-status">{statusLabel(g.status)}</span>
                  <span class="goal-row-progress">{progressLine(g)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section class="goal-pane goal-detail" aria-label="Goal detail">
          {selected ? (
            <GoalDetail client={client} accountId={accountId} goal={selected} onChanged={reload} />
          ) : (
            <p class="muted">Select a goal.</p>
          )}
        </section>
      </div>
    </div>
  );
}

// ── one goal ───────────────────────────────────────────────────────────────

function GoalDetail(props: { client?: JmapClient; accountId: string; goal: Goal; onChanged: () => void }) {
  const { client, accountId, goal, onChanged } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const checkpoint = openPlanCheckpoint(goal);

  const act = async (run: () => Promise<{ ok: boolean; message?: string }>) => {
    if (!client) return;
    setBusy(true);
    setError(undefined);
    const res = await run();
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onChanged();
  };

  return (
    <article class="goal-card">
      <h2 class="goal-statement">{goal.statement}</h2>
      <p class="goal-status">{statusLabel(goal.status)}</p>
      {statusNote(goal) ? <p class="muted goal-statusnote">{statusNote(goal)}</p> : null}
      <p class="muted goal-fine">
        Stated by {goal.createdBy} · {progressLine(goal)}
      </p>
      <p class="muted goal-fine">{budgetLine(goal.budgetMicros, goal.spentMicros)}</p>

      {/* THE CONTRACT, verbatim and at the top: what you handed over is not a
          settings page you configure once — it is the thing to re-read every
          time you are asked to widen it. */}
      <dl class="goal-contract">
        {contractLines(goal.contract).map((line) => (
          <div key={line.label} class="goal-clause">
            <dt>{line.label}</dt>
            <dd>{line.value}</dd>
          </div>
        ))}
      </dl>

      {checkpoint && client ? (
        <PlanRedline
          client={client}
          accountId={accountId}
          goal={goal}
          proposalId={checkpoint.proposalId}
          onDecided={onChanged}
        />
      ) : null}

      <section class="goal-checkpoints" aria-label="Checkpoints">
        <h3>Checkpoints</h3>
        <p class="muted goal-fine">
          Checkpoints thin one class at a time, never all at once — a goal that graduated wholesale is exactly the
          silently-widening autonomy this product exists to prevent.
        </p>
        <ul>
          {(["plan", "email", "summary"] as CheckpointClass[]).map((cls) => (
            <li key={cls} class="goal-checkpoint">
              <span>{checkpointLine(cls, goal.checkpoints[cls])}</span>
              {goal.checkpoints[cls].graduable && goal.status !== "cancelled" ? (
                <button
                  type="button"
                  class="goal-mini"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      setCheckpoint(
                        client!,
                        accountId,
                        goal.id,
                        cls,
                        goal.checkpoints[cls].mode === "auto" ? "manual" : "auto",
                      ),
                    )
                  }
                >
                  {goal.checkpoints[cls].mode === "auto" ? "Stop for me again" : "Let it run without me"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section class="goal-milestones" aria-label="Milestones">
        <h3>Milestones</h3>
        {goal.milestones.length === 0 ? (
          <p class="muted">Nothing has happened yet.</p>
        ) : (
          <ol>
            {orderMilestones(goal.milestones).map((m) => (
              <li key={m.proposalId}>
                <span class="goal-milestone">{milestoneLine(m)}</span>
                <span class="muted goal-fine"> {m.summary}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {error ? <p class="goal-error">{error}</p> : null}

      {goal.status !== "cancelled" && goal.status !== "accepted" ? (
        <p>
          <button
            type="button"
            class="goal-danger"
            disabled={busy}
            onClick={() => void act(() => cancelGoal(client!, accountId, goal.id))}
          >
            Cancel this goal
          </button>
          <span class="muted goal-fine">
            {" "}
            Revokes the standing authority and stops every waiting task. The record stays.
          </span>
        </p>
      ) : null}
    </article>
  );
}

// ── the plan checkpoint, redlined in place ────────────────────────────────

function PlanRedline(props: {
  client: JmapClient;
  accountId: string;
  goal: Goal;
  proposalId: string;
  onDecided: () => void;
}) {
  const { client, accountId, goal, proposalId, onDecided } = props;
  const [payload, setPayload] = useState<PlanPayload | undefined>(undefined);
  const [rows, setRows] = useState<RedlineRow[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void loadPlanPayload(client, accountId, proposalId).then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setPayload(res.value);
      setRows(sketchToRows(res.value));
    });
    return () => {
      cancelled = true;
    };
  }, [client, accountId, proposalId]);

  const decision = redlineDecision({ rows, payload, contract: goal.contract, question });
  const blocked = decision.problems.length > 0;

  const send = async () => {
    setBusy(true);
    setError(undefined);
    const res = await decidePlan(
      client,
      accountId,
      proposalId,
      decision.verb === "needsInfo"
        ? { status: "info-requested", question: decision.question! }
        : { status: "approved", ...(decision.editedPayload ? { editedPayload: decision.editedPayload } : {}) },
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onDecided();
  };

  const decline = async () => {
    setBusy(true);
    setError(undefined);
    const res = await decidePlan(client, accountId, proposalId, { status: "rejected", reason: "wrongAction" });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onDecided();
  };

  if (!payload) {
    return (
      <section class="goal-plan" aria-label="Plan awaiting approval">
        <h3>The plan</h3>
        <p class="muted">{error ?? "Loading the sketch…"}</p>
      </section>
    );
  }

  return (
    <section class="goal-plan" aria-label="Plan awaiting approval">
      <h3>The plan, before anything runs</h3>
      <p class="muted goal-fine">
        Nothing below exists yet. Approving creates these tasks; each message they produce still comes back to you as
        its own approval.
      </p>

      <table class="goal-plantable">
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Does</th>
            <th scope="col">To</th>
            <th scope="col">Keep?</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.key} class={row.dropped ? "goal-dropped" : undefined}>
              <td>{row.key}</td>
              <td>{row.op}</td>
              <td>
                {row.op === "outreach" ? (
                  <input
                    type="text"
                    class="goal-input"
                    value={row.to}
                    aria-label={`Recipient for ${row.key}`}
                    disabled={row.dropped}
                    onInput={(e) => {
                      const to = (e.currentTarget as HTMLInputElement).value;
                      setRows(rows.map((r, j) => (j === i ? { ...r, to } : r)));
                    }}
                  />
                ) : (
                  <span class="muted">—</span>
                )}
              </td>
              <td>
                <button
                  type="button"
                  class="goal-mini"
                  onClick={() => setRows(rows.map((r, j) => (j === i ? { ...r, dropped: !r.dropped } : r)))}
                >
                  {row.dropped ? "Put back" : "Strike"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <label class="goal-question">
        <span>Still unclear? Ask the planner instead.</span>
        <textarea
          class="goal-input"
          rows={2}
          value={question}
          onInput={(e) => setQuestion((e.currentTarget as HTMLTextAreaElement).value)}
        />
      </label>

      {decision.problems.map((p) => (
        <p key={p} class="goal-error">
          {p}
        </p>
      ))}
      {error ? <p class="goal-error">{error}</p> : null}

      <p class="muted goal-fine">{redlineActionNote(decision)}</p>
      <p class="goal-actions">
        <button type="button" class="goal-primary" disabled={busy || blocked} onClick={() => void send()}>
          {redlineActionLabel(decision)}
        </button>
        <button type="button" class="goal-mini" disabled={busy} onClick={() => void decline()}>
          Not this workflow
        </button>
      </p>
    </section>
  );
}

// ── stating a goal ─────────────────────────────────────────────────────────

function NewGoalForm(props: { client?: JmapClient; accountId: string; onCreated: () => void }) {
  const { client, accountId, onCreated } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [form, setForm] = useState<NewGoal>({
    statement: "",
    contact: [],
    mayNot: [],
    doneWhen: "",
    budgetUsd: null,
    escalateAfterDays: null,
  });
  const [contact, setContact] = useState("");
  const [mayNot, setMayNot] = useState("");
  const [budget, setBudget] = useState("");

  const submit = async () => {
    if (!client) return;
    setBusy(true);
    setError(undefined);
    const res = await createGoal(client, accountId, {
      ...form,
      contact: contact
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
      mayNot: mayNot
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      budgetUsd: budget.trim() === "" ? null : Number(budget),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setOpen(false);
    setForm({ statement: "", contact: [], mayNot: [], doneWhen: "", budgetUsd: null, escalateAfterDays: null });
    setContact("");
    setMayNot("");
    setBudget("");
    onCreated();
  };

  if (!open) {
    return (
      <p>
        <button type="button" class="goal-primary" onClick={() => setOpen(true)}>
          State a goal
        </button>
      </p>
    );
  }

  return (
    <div class="goal-new">
      <label class="goal-field">
        <span>What do you want to be true?</span>
        <input
          type="text"
          class="goal-input"
          value={form.statement}
          placeholder="get three structural engineers willing to evaluate the attic"
          onInput={(e) => setForm({ ...form, statement: (e.currentTarget as HTMLInputElement).value })}
        />
      </label>
      <label class="goal-field">
        <span>May write to (addresses or @domains, comma separated)</span>
        <input
          type="text"
          class="goal-input"
          value={contact}
          onInput={(e) => setContact((e.currentTarget as HTMLInputElement).value)}
        />
      </label>
      <label class="goal-field">
        <span>May not (one per line — read at every checkpoint, never enforced by arithmetic)</span>
        <textarea
          class="goal-input"
          rows={2}
          value={mayNot}
          onInput={(e) => setMayNot((e.currentTarget as HTMLTextAreaElement).value)}
        />
      </label>
      <label class="goal-field">
        <span>Done when</span>
        <input
          type="text"
          class="goal-input"
          value={form.doneWhen}
          placeholder="three engineers have said yes"
          onInput={(e) => setForm({ ...form, doneWhen: (e.currentTarget as HTMLInputElement).value })}
        />
      </label>
      <label class="goal-field">
        <span>Spend bound, US$ (what the agent may spend pursuing this — not what anyone may promise)</span>
        <input
          type="text"
          class="goal-input"
          value={budget}
          placeholder="750"
          onInput={(e) => setBudget((e.currentTarget as HTMLInputElement).value)}
        />
      </label>
      <label class="goal-field">
        <span>Escalate after (days, blank for never)</span>
        <input
          type="text"
          class="goal-input"
          value={form.escalateAfterDays === null ? "" : String(form.escalateAfterDays)}
          onInput={(e) => {
            const raw = (e.currentTarget as HTMLInputElement).value.trim();
            setForm({ ...form, escalateAfterDays: raw === "" ? null : Number(raw) });
          }}
        />
      </label>
      {error ? <p class="goal-error">{error}</p> : null}
      <p class="goal-actions">
        <button type="button" class="goal-primary" disabled={busy} onClick={() => void submit()}>
          State it
        </button>
        <button type="button" class="goal-mini" disabled={busy} onClick={() => setOpen(false)}>
          Never mind
        </button>
      </p>
      <p class="muted goal-fine">
        Stating a goal does not start anything: the agent proposes how it would work, and you approve that plan first.
      </p>
    </div>
  );
}
