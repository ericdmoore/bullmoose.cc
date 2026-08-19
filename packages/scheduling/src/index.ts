export {
  ESCALATION_RETRY_FACTOR,
  ESCALATION_WINDOW_MAX_MS,
  ESCALATION_WINDOW_MIN_MS,
  ESCALATION_WINDOW_NO_HISTORY_MS,
  FREE_RUNTIME_LIVE_MS,
  backfillEnvelopeExhausted,
  budgetExhausted,
  effectiveBudgetExhausted,
  escalationWindowMs,
  fit,
  mayClaim,
  normalizeClaimant,
  policy,
  type BudgetState,
  type ClaimCapabilities,
  type ClaimFacets,
  type ClaimantIdentity,
  type PrivacyClass,
} from "./mayClaim.js";
export {
  JOB_MAX_DEPTH_CEILING,
  JOB_MAX_NODES_CEILING,
  RESERVED_CONTEXT_KINDS,
  attenuateChild,
  attenuatePlan,
  describeRefusals,
  isPrivacyClass,
  type AttenuatedChild,
  type AttenuationResult,
  type ChildRequest,
  type JobCaps,
  type JobUsage,
  type NodeAuthority,
  type NodeCeiling,
  type Refusal,
} from "./attenuation.js";
export {
  NO_AUTHORITY,
  describeDenial,
  foldChain,
  intersectAuthority,
  mayUse,
  parseEnvelope,
  type AuthorityDenial,
  type FoldResult,
  type Use,
  type UseResult,
} from "./useAuthority.js";
// The DB-backed half of the same question: `useAuthority.ts` is the arithmetic,
// `nodeAuthority.ts` walks the rows it folds. It moved here out of
// `services/agent/src/useGate.ts` when per-invocation tokens made more than one
// worker able to name the acting invocation — see that module's header.
export {
  authorizeNodeUse,
  bindingCeiling,
  effectiveNodeAuthority,
  effectiveNodeCeiling,
  type AuthorityDb,
  type BindingJobConfig,
  type JobNodeRow,
  type NodeUseDecision,
} from "./nodeAuthority.js";
// s20 T6 — the delegation contract: a Goal's four clauses, what they compile
// onto (which is entirely machinery that already exists), and the checkpoint
// classes that thin one at a time rather than all at once.
export {
  CHECKPOINT_CLASSES,
  GOAL_DEFAULT_MAX_DEPTH,
  GOAL_DEFAULT_MAX_NODES,
  GOAL_OUTREACH_KIND,
  GOAL_PLAN_KIND,
  GOAL_SUMMARY_KIND,
  GRADUABLE_CLASSES,
  attenuateContract,
  checkpointClassOf,
  compileContract,
  contactAllowed,
  contractRefusals,
  defaultCheckpoints,
  deriveGoalStatus,
  isCheckpointClass,
  microsToUsd,
  parseGoalContract,
  sketchFromContract,
  usdToMicros,
  type CheckpointClass,
  type CheckpointMode,
  type CheckpointPolicy,
  type CheckpointSetting,
  type ContractParse,
  type ContractTask,
  type GoalContract,
  type GoalStatus,
} from "./goalContract.js";
// The attenuated WRITE paths. They live here rather than in services/agent
// because s20 T6's plan-approval checkpoint creates a planner's tasks from
// inside the JMAP worker, and an approved plan must meet exactly the checks a
// planner's own output meets — one implementation, two callers.
export {
  expandPlanRows,
  getJobNodeRow,
  joinContextRows,
  startJobRows,
  type ExpandResult,
  type JobSpec,
  type PlanSpec,
  type StartJobResult,
} from "./jobWrite.js";
export {
  BLOCKED_SENTINEL,
  deriveJobStatus,
  jobBudgetExhausted,
  jobBudgetExhaustedSql,
  jobView,
  needsSatisfied,
  needsSatisfiedSql,
  nodeSettledSql,
  parseNeeds,
  type JobNodeState,
  type JobStatus,
  type JobView,
  type NodeStatus,
} from "./jobGraph.js";
export {
  backfillEnvelopeExhaustedSql,
  backfillEnvelopeSql,
  bindingDisabled,
  bindingDisabledSql,
  bindingEscalationWindowMs,
  bindingMedianCostMicros,
  budgetExhaustedSql,
  budgetMonthStartMs,
  budgetPeriodEndMs,
  budgetPeriodKey,
  claimFitBinds,
  claimFitSql,
  claimGateBinds,
  claimGateSql,
  dueWindowBinds,
  dueWindowSql,
  freeRuntimeLiveCutoff,
  freeRuntimeLiveSql,
  medianMicros,
  notPinnedSql,
  type ClaimGateParams,
} from "./claimGate.js";
// Deterministic due-date extraction at the boundary (s11 T1): a `due_at` must
// exist before any claim does, so it is stamped at enqueue, model-free. Now
// shared — ingest stamps it on delivery, and the remind@ door (s20 wave 2)
// reuses the SAME conservative parser so "by Friday" means the same instant on
// both surfaces.
export { EOD_UTC_HOUR, SCAN_LIMIT, extractDueAt, type DueExtractionInput } from "./dueDate.js";
