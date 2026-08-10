# 036 -P2- Secret scanners will fail every vault-test PR, and the obvious fixes are all wrong

**Subsystem:** infra · **Severity:** MEDIUM (recurring CI friction → alert fatigue) · **Fix class:** DECISION

## What happened

PR #43 (Bureau T3) was blocked twice by scanners:

1. **GitHub push protection** — hard block. The leak-probe fixture was `sk_live_51…`, Stripe's
   real account-prefixed live-key shape. **This was a correct catch** and the fixture was
   changed; the branch was squashed so the literal exists in no pushed commit.
2. **GitGuardian** — soft fail, "3 secrets uncovered," still failing at merge.

Every long literal added by that branch was enumerated by hand. All 14 are test fixtures
(`test-vault-master-key-…`, `internal-test-token`, `bm-canary-DO-NOT-USE-…`) or HTTP header
names. **None is a credential.** `verify` — the only required check — passed, so the PR was
merged with GitGuardian red.

## Why this recurs

GitGuardian's generic detector keys on **variable name plus value shape**: `const SECRET =`,
`MASTER =`, `…token`. A test suite for a *credential vault* cannot avoid those identifiers —
they are the subject matter. So this fails on every PR touching `services/bureau/**` or
`services/agent/src/vault*`, forever.

## The three tempting fixes, and why each is worse

- **Click the allow-secret / dashboard-ignore URL.** Whitelists a credential-shaped string
  permanently and teaches the next person that the block is noise.
- **Build fixture values at runtime** (`"not-real-" + "key"`) to duck entropy detection. This
  is obfuscation, and it defeats the scanner for *real* secrets in the same files.
- **Ignore `**/*.test.ts` wholesale.** The cheapest and the most dangerous: a real key pasted
  into a test is the single most likely way one enters this repo.

## What to actually decide

Recommended: **per-match ignores** in `.gitguardian.yaml` (`secret.ignored-matches`, keyed by
match hash, one entry per fixture with a comment). Narrow, auditable, and adding one is a
deliberate act rather than a blanket exemption. Requires dashboard access to read the hashes.

Alternative worth considering: make GitGuardian a **required** check once the fixtures are
ignored — a soft-failing security check that is always red is worse than no check, because it
trains everyone to merge past it. That is the actual risk here, not these 14 strings.

Either way this is an operator decision, not a code change.
