// @bullmoose/boundary — the PURE ENGINES of the s12 boundary cascade:
// stage 3 (sieve rules), stage 4 (two-threshold Bayes), and the graduation
// policy. No storage, no workers, no clocks — the ingest wiring calls these.
export type { BoundaryMessage } from "./message.js";
export {
  globMatch,
  sieveVerdict,
  type SieveField,
  type SieveMatch,
  type SieveRule,
} from "./sieve.js";
export {
  BAYES_HEADERS,
  DEFAULT_THRESHOLDS,
  VOCAB_CAP,
  bayesClassify,
  bayesTokens,
  bayesTrain,
  bayesVerdict,
  emptyBayesState,
  prunedTokens,
  type BayesState,
  type TokenCounts,
} from "./bayes.js";
export { DEFAULT_GRADUATION_POLICY, graduationDue, type GraduationPolicy } from "./graduation.js";
