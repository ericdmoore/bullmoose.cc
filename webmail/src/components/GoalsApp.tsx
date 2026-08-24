/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import { resolveClient } from "../lib/app/client";
import { matchesQuery, useRealmSearch } from "../lib/shell/useRealmSearch";
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
  checkpointLine,
  milestoneLine,
  openPlanCheckpoint,
  orderGoals,
  orderMilestones,
  progressLine,
  statusLabel,
  statusNote,
} from "../lib/goals/view";
import type { CheckpointClass, Goal, GoalStatus, PlanPayload } from "../lib/goals/types";
import type { JmapClient } from "../lib/jmap/JmapClient";
import type { Session } from "../lib/jmap/types";
import { hrefWithParam, urlParam } from "../lib/shell/publish";
import { syncDetailUrl } from "../lib/ui/navigation";
import {
  Alert,
  Badge,
  Button,
  Column,
  DescList,
  DescRow,
  EmptyState,
  Field,
  Input,
  PageNotice,
  Skeleton,
  SkeletonRegion,
  StackedList,
  StackedRow,
  StatusDot,
  SurfaceFrame,
  Textarea,
} from "./ui";
import type { BadgeTone, StatusDotTone } from "../lib/ui/classes";
import { ChevronRightIcon } from "./icons";

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
  // `/goals?g=<id>` deep-links one goal — read once at mount, the MPA
  // detail-URL pattern every surface follows. A goal that is not in the list
  // (cancelled, or someone else's link) falls through to the first, the same
  // self-repair the selection already had.
  const [selectedId, setSelectedId] = useState<string | undefined>(() => urlParam("g"));
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
  const bar = useRealmSearch();
  // #225 — a goal IS its statement, so that is the whole match surface.
  const shown = useMemo(() => ordered.filter((g) => matchesQuery(bar, g.statement)), [ordered, bar]);
  const selected = ordered.find((g) => g.id === selectedId) ?? ordered[0];
  /** The row's detail URL — `/goals?g=<id>`, current query preserved. */
  const goalHref = (id: string): string => hrefWithParam("/goals", "g", id);
  const reload = () => setReloads((n) => n + 1);

  if (fatal) {
    return (
      <PageNotice title="Could not reach the server" error>
        <p role="alert">{fatal}</p>
      </PageNotice>
    );
  }
  if (!session) {
    return <PageNotice>Connecting…</PageNotice>;
  }
  if (!hasAgentCapability(session)) {
    return (
      <PageNotice title="Goals are not available">
        <p>
          This server does not advertise the bullmoose agent capability, so nothing can act in your name and there is
          nothing to delegate. Mail, contacts and calendar are unaffected.
        </p>
        <p class="mt-2">
          <a href="/mail" class="font-medium text-brand-600 hover:text-brand-500">
            Back to mail
          </a>
        </p>
      </PageNotice>
    );
  }

  return (
    <div class="flex h-full min-h-0 w-full flex-col">
      {notice ? (
        <Alert tone="error" class="m-4 shrink-0">
          {notice}
        </Alert>
      ) : null}

      <SurfaceFrame>
        <Column
          aria-label="Your goals"
          class="w-full shrink-0 border-gray-200 max-lg:border-b lg:w-96 lg:border-r dark:border-white/10"
          header={
            <div class="px-4 pt-4 pb-2">
              <NewGoalForm client={client} accountId={accountId} onCreated={reload} />
            </div>
          }
        >
          {loading ? (
            <SkeletonRegion label="your goals" class="px-4 py-3">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} variant="row" />
              ))}
            </SkeletonRegion>
          ) : null}
          {!loading && ordered.length === 0 ? <EmptyState title="No goals yet">{GOALS_EMPTY}</EmptyState> : null}
          {/* The rows are REAL links (`href`) AND stay in-page on a plain
              click (`onSelect`) — both, never one (ui/StackedList.tsx). A
              standing delegation is exactly the thing you want to hand to
              someone in a message, and cmd-click to read beside the one you
              have open. `syncDetailUrl` keeps the address bar on the goal
              being read, via replaceState. */}
          <StackedList>
            {shown.map((g) => {
              const tone = goalTone(g.status);
              return (
                <StackedRow
                  key={g.id}
                  active={g.id === selected?.id}
                  href={goalHref(g.id)}
                  onSelect={() => {
                    setSelectedId(g.id);
                    syncDetailUrl(goalHref(g.id));
                  }}
                >
                  <StatusDot tone={tone.dot} />
                  <div class="min-w-0 flex-auto">
                    <p class="line-clamp-2 text-sm/6 font-semibold text-gray-900 dark:text-white">{g.statement}</p>
                    <p class="mt-1 text-xs/5 text-gray-500 dark:text-gray-400">{progressLine(g)}</p>
                  </div>
                  <Badge tone={tone.badge}>{statusLabel(g.status)}</Badge>
                  <ChevronRightIcon class="size-5 flex-none text-gray-400" />
                </StackedRow>
              );
            })}
          </StackedList>
        </Column>

        <Column aria-label="Goal detail" class="min-w-0 grow">
          {selected ? (
            <GoalDetail client={client} accountId={accountId} goal={selected} onChanged={reload} />
          ) : (
            <EmptyState title="Select a goal">The contract and checkpoints show here.</EmptyState>
          )}
        </Column>
      </SurfaceFrame>
    </div>
  );
}

function goalTone(status: GoalStatus): { badge: BadgeTone; dot: StatusDotTone } {
  if (status === "accepted" || status === "done") return { badge: "success", dot: "success" };
  if (status === "cancelled" || status === "stalled") return { badge: "error", dot: "error" };
  if (status === "awaiting-plan" || status === "paused") return { badge: "warn", dot: "warn" };
  return { badge: "accent", dot: "neutral" };
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
    <article class="px-4 py-5 sm:px-6">
      <div class="flex flex-wrap items-center gap-2">
        <Badge tone={goalTone(goal.status).badge}>{statusLabel(goal.status)}</Badge>
      </div>
      <h2 class="mt-3 text-base/7 font-semibold text-gray-900 dark:text-white">{goal.statement}</h2>
      {statusNote(goal) ? <p class="mt-1 text-sm/6 text-gray-600 dark:text-gray-400">{statusNote(goal)}</p> : null}

      <DescList
        class="mt-4"
        title="The contract"
        description="What you handed over — re-read this every time you are asked to widen it."
      >
        <DescRow term="Stated by">
          {goal.createdBy} · {progressLine(goal)}
        </DescRow>
        <DescRow term="Spend">{budgetLine(goal.budgetMicros, goal.spentMicros)}</DescRow>
        {contractLines(goal.contract).map((line) => (
          <DescRow key={line.label} term={line.label}>
            {line.value}
          </DescRow>
        ))}
      </DescList>

      {checkpoint && client ? (
        <PlanRedline
          client={client}
          accountId={accountId}
          goal={goal}
          proposalId={checkpoint.proposalId}
          onDecided={onChanged}
        />
      ) : null}

      <section class="mt-8" aria-label="Checkpoints">
        <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Checkpoints</h3>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Checkpoints thin one class at a time, never all at once — a goal that graduated wholesale is exactly the
          silently-widening autonomy this product exists to prevent.
        </p>
        <ul class="mt-3 divide-y divide-gray-100 dark:divide-white/5">
          {(["plan", "email", "summary"] as CheckpointClass[]).map((cls) => (
            <li key={cls} class="flex flex-wrap items-baseline justify-between gap-2 py-3 text-sm">
              <span class="text-gray-700 dark:text-gray-300">{checkpointLine(cls, goal.checkpoints[cls])}</span>
              {goal.checkpoints[cls].graduable && goal.status !== "cancelled" ? (
                <Button
                  size="sm"
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
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section class="mt-8" aria-label="Milestones">
        <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Milestones</h3>
        {goal.milestones.length === 0 ? (
          <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">Nothing has happened yet.</p>
        ) : (
          <ol class="mt-3 list-decimal space-y-2 pl-5 text-sm">
            {orderMilestones(goal.milestones).map((m) => (
              <li key={m.proposalId}>
                <span class="font-medium text-gray-900 dark:text-white">{milestoneLine(m)}</span>
                <span class="text-gray-500 dark:text-gray-400"> {m.summary}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {error ? (
        <Alert tone="error" class="mt-4">
          {error}
        </Alert>
      ) : null}

      {goal.status !== "cancelled" && goal.status !== "accepted" ? (
        <p class="mt-6">
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void act(() => cancelGoal(client!, accountId, goal.id))}
          >
            Cancel this goal
          </Button>
          <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">
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
      <section class="mt-8 rounded-lg ring-1 ring-brand-500/30 ring-inset" aria-label="Plan awaiting approval">
        <div class="px-4 py-4">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">The plan</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{error ?? "Loading the sketch…"}</p>
        </div>
      </section>
    );
  }

  return (
    <section class="mt-8 rounded-lg ring-1 ring-brand-500/30 ring-inset" aria-label="Plan awaiting approval">
      <div class="px-4 py-4">
        <h3 class="text-sm font-semibold text-gray-900 dark:text-white">The plan, before anything runs</h3>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Nothing below exists yet. Approving creates these tasks; each message they produce still comes back to you as
          its own approval.
        </p>

        <div class="mt-4 overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-300 dark:divide-white/15">
            <thead>
              <tr>
                <th scope="col" class="py-2 pr-3 text-left text-xs font-semibold text-gray-900 dark:text-white">
                  Task
                </th>
                <th scope="col" class="px-3 py-2 text-left text-xs font-semibold text-gray-900 dark:text-white">
                  Does
                </th>
                <th scope="col" class="px-3 py-2 text-left text-xs font-semibold text-gray-900 dark:text-white">
                  To
                </th>
                <th scope="col" class="py-2 pl-3 text-left text-xs font-semibold text-gray-900 dark:text-white">
                  Keep?
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-white/10">
              {rows.map((row, i) => (
                <tr key={row.key} class={row.dropped ? "text-gray-400 line-through opacity-60" : undefined}>
                  <td class="py-2 pr-3 text-sm">{row.key}</td>
                  <td class="px-3 py-2 text-sm">{row.op}</td>
                  <td class="px-3 py-2 text-sm">
                    {row.op === "outreach" ? (
                      <Input
                        type="text"
                        value={row.to}
                        aria-label={`Recipient for ${row.key}`}
                        disabled={row.dropped}
                        onInput={(e) => {
                          const to = (e.currentTarget as HTMLInputElement).value;
                          setRows(rows.map((r, j) => (j === i ? { ...r, to } : r)));
                        }}
                      />
                    ) : (
                      <span class="text-gray-500">—</span>
                    )}
                  </td>
                  <td class="py-2 pl-3">
                    <Button
                      size="sm"
                      onClick={() => setRows(rows.map((r, j) => (j === i ? { ...r, dropped: !r.dropped } : r)))}
                    >
                      {row.dropped ? "Put back" : "Strike"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Field label="Still unclear? Ask the planner instead." class="mt-4">
          <Textarea
            rows={2}
            value={question}
            onInput={(e) => setQuestion((e.currentTarget as HTMLTextAreaElement).value)}
          />
        </Field>

        {decision.problems.map((p) => (
          <Alert key={p} tone="error" class="mt-2">
            {p}
          </Alert>
        ))}
        {error ? (
          <Alert tone="error" class="mt-2">
            {error}
          </Alert>
        ) : null}

        <p class="mt-3 text-xs text-gray-500 dark:text-gray-400">{redlineActionNote(decision)}</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy || blocked} onClick={() => void send()}>
            {redlineActionLabel(decision)}
          </Button>
          <Button disabled={busy} onClick={() => void decline()}>
            Not this workflow
          </Button>
        </div>
      </div>
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
      <Button variant="primary" onClick={() => setOpen(true)}>
        State a goal
      </Button>
    );
  }

  return (
    <div class="rounded-lg p-3 ring-1 ring-gray-200 ring-inset dark:ring-white/10">
      <Field label="What do you want to be true?">
        <Input
          type="text"
          value={form.statement}
          placeholder="get three structural engineers willing to evaluate the attic"
          onInput={(e) => setForm({ ...form, statement: (e.currentTarget as HTMLInputElement).value })}
        />
      </Field>
      <Field label="May write to (addresses or @domains, comma separated)" class="mt-3">
        <Input type="text" value={contact} onInput={(e) => setContact((e.currentTarget as HTMLInputElement).value)} />
      </Field>
      <Field label="May not (one per line — read at every checkpoint, never enforced by arithmetic)" class="mt-3">
        <Textarea rows={2} value={mayNot} onInput={(e) => setMayNot((e.currentTarget as HTMLTextAreaElement).value)} />
      </Field>
      <Field label="Done when" class="mt-3">
        <Input
          type="text"
          value={form.doneWhen}
          placeholder="three engineers have said yes"
          onInput={(e) => setForm({ ...form, doneWhen: (e.currentTarget as HTMLInputElement).value })}
        />
      </Field>
      <Field
        label="Spend bound, US$ (what the agent may spend pursuing this — not what anyone may promise)"
        class="mt-3"
      >
        <Input
          type="text"
          value={budget}
          placeholder="750"
          onInput={(e) => setBudget((e.currentTarget as HTMLInputElement).value)}
        />
      </Field>
      <Field label="Escalate after (days, blank for never)" class="mt-3">
        <Input
          type="text"
          value={form.escalateAfterDays === null ? "" : String(form.escalateAfterDays)}
          onInput={(e) => {
            const raw = (e.currentTarget as HTMLInputElement).value.trim();
            setForm({ ...form, escalateAfterDays: raw === "" ? null : Number(raw) });
          }}
        />
      </Field>
      {error ? (
        <Alert tone="error" class="mt-3">
          {error}
        </Alert>
      ) : null}
      <div class="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>
          State it
        </Button>
        <Button disabled={busy} onClick={() => setOpen(false)}>
          Never mind
        </Button>
      </div>
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
        Stating a goal does not start anything: the agent proposes how it would work, and you approve that plan first.
      </p>
    </div>
  );
}
