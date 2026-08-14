import { describeRefusals } from "@bullmoose/scheduling";
import { expandPlan, getJobNode, joinContext, type JobNodeRow } from "./jobs.js";
import type { Env, InvocationCost } from "./models.js";

/**
 * s11 T7 — the harness side of a Job node, dispatched by CONTEXT KIND from
 * `runInvocation` exactly as `answer-info-request` and `bouncer-classify` are.
 *
 * That dispatch point is the whole integration: a Job node is an ORDINARY
 * invocation, so a node whose context carries no `kind` runs the binding's
 * ordinary pipeline (reply, ledger, bouncer) and egresses through
 * `/approvals` like every other invocation — a Job reorganizes work, it never
 * changes how the work gets out (§8.3). Only the two structural node types
 * need machinery, and this is it.
 *
 * ── What a planner is, and is deliberately not ─────────────────────────────
 * `op: "plan"` reads its decomposition from `context.plan` — a FIXED plan,
 * supplied when the Job was created. There is no prompt here and no model call:
 * the model-driven planner is a later task, and building it now would prove
 * nothing this file can prove. What matters is that `expandPlan` treats the
 * plan as UNTRUSTED DATA regardless of who wrote it, so the day a model writes
 * one, the attenuation chain, the caps and the aggregate budget are already the
 * things standing between it and the household. The only line that changes is
 * where `plan` comes from.
 *
 * A planner whose plan is REFUSED fails its node. It does not proceed with a
 * truncated plan (rule 1 of attenuation.ts: refuse, never truncate), and the
 * failure propagates by derivation — its dependents are permanently blocked and
 * the Job reads `stalled` — with the refused axes recorded on the row for the
 * human who wants to know what the planner tried to do.
 */

/** No model was called, so the cost is KNOWN and it is zero (not "unrecorded"). */
const FREE: InvocationCost = {
  provider: "harness",
  model: "job-node",
  tokensIn: null,
  tokensOut: null,
  costMicros: 0,
};

/** The `Job` shape services/agent's drain hands to a pipeline. */
interface DrainJob {
  id: string;
  account_id: string;
  binding_name: string;
}

type Done = (
  status: "done" | "failed",
  result: Record<string, unknown>,
  cost?: InvocationCost,
) => Promise<void>;

/**
 * Run one structural node. Four ops, each the minimum that makes a DAG
 * property observable end-to-end:
 *
 *   plan   expand this node's fixed decomposition into tasks (the planner).
 *   join   synthesize the results of this node's `needs` (the join step). Its
 *          inputs arrive as context because the DAG says they are done — the
 *          claim gate would not have released this node otherwise.
 *   echo   a leaf that does deterministic work.
 *   fail   a leaf that fails, so "a failed node blocks its dependents" can be
 *          proven rather than asserted.
 */
export async function runJobNode(
  env: Env,
  job: DrainJob,
  context: Record<string, unknown>,
  done: Done,
): Promise<void> {
  const node = await getJobNode(env, job.account_id, job.id);
  if (!node) return done("failed", { note: "job node vanished mid-claim" }, FREE);

  const op = typeof context.op === "string" ? context.op : "";
  switch (op) {
    case "plan":
      return runPlanner(env, node, context, done);
    case "join":
      return runJoin(env, node, context, done);
    case "echo":
      return done("done", { kind: "job-node", op, text: String(context.text ?? "") }, FREE);
    case "fail":
      return done("failed", { kind: "job-node", op, note: String(context.note ?? "planned failure") }, FREE);
    default:
      return done("failed", { kind: "job-node", note: `unknown job-node op: ${op || "(none)"}` }, FREE);
  }
}

async function runPlanner(
  env: Env,
  node: JobNodeRow,
  context: Record<string, unknown>,
  done: Done,
): Promise<void> {
  const expanded = await expandPlan(env, node, context.plan);
  if (!expanded.ok) {
    console.warn(
      `job ${node.job_id}: planner ${node.id} refused — ${describeRefusals(expanded.refusals)}`,
    );
    return done(
      "failed",
      {
        kind: "job-node",
        op: "plan",
        note: `plan refused: ${describeRefusals(expanded.refusals)}`.slice(0, 500),
        // The full list, structured, so an audit can count refusals by axis
        // instead of grepping a sentence.
        refusals: expanded.refusals,
      },
      FREE,
    );
  }
  return done(
    "done",
    { kind: "job-node", op: "plan", created: expanded.created.map((c) => c.id), tasks: expanded.created },
    FREE,
  );
}

async function runJoin(
  env: Env,
  node: JobNodeRow,
  context: Record<string, unknown>,
  done: Done,
): Promise<void> {
  const inputs = await joinContext(env, node);
  const texts = inputs.map((i) => {
    const r = i.result as { text?: unknown } | null;
    return typeof r?.text === "string" ? r.text : "";
  });
  const separator = typeof context.separator === "string" ? context.separator : "\n";
  return done(
    "done",
    {
      kind: "job-node",
      op: "join",
      // The synthesis. Deterministic on purpose: what is being proven is that
      // a join node SEES its dependencies' results, not that a model can
      // summarize them.
      text: texts.join(separator),
      inputs: inputs.map((i) => i.id),
    },
    FREE,
  );
}
