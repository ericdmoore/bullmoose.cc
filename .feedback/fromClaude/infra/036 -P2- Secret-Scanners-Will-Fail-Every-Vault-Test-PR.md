# 036 -P2- Secret scanners will fail every vault-test PR, and the obvious fixes are all wrong

**Subsystem:** infra · **Severity:** MEDIUM (recurring CI friction → alert fatigue) · **Fix class:** DECISION (operator, dashboard-only)

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
they are the subject matter.

## ⚠️ CORRECTION — the first version of this file recommended a fix that does not work

This file originally said: *"Recommended: per-match ignores in `.gitguardian.yaml`
(`secret.ignored-matches`, keyed by match hash)."* **That is wrong, and acting on it would
have wasted an afternoon.**

`.gitguardian.yaml` is read **only by the `ggshield` CLI**. The red check here comes from the
GitGuardian **GitHub App**, which scans server-side at the post-receive stage and never reads
the repository working tree. GitGuardian's own docs state the dashboard↔ggshield relationship
is one-directional — dashboard → CLI, never the reverse:

> "ggshield does not share its ignored secrets with the dashboard. Therefore … a secret
> ignored on ggshield will still show as a potential incident on your GitGuardian dashboard."
> — <https://docs.gitguardian.com/ggshield-docs/reference/secret/ignore>

There is no ggshield step in any workflow in `.github/workflows/`, so **100% of the signal is
the App** and no committed file can change it. Two further corrections to the original: the
config keys use underscores (`ignored_matches`, not `ignored-matches`), and `match` accepts
the literal string *or* a SHA256 — hashing was never required.

## What actually fixes it — all dashboard, Settings → Secrets → exclusion rules

1. **Secret pattern exclusions** scoped to this repo. Preferred, because it stays narrow: a
   *real* leaked key in a test file still alerts. Applies retroactively to open incidents.
   - `bm-canary-DO-NOT-USE-[A-Za-z0-9._-]+`
   - `test-vault-master-key-[0-9a-f]+`
   - `internal-test-token`
2. **Ignore the open incidents** with reason **"this is test credential"** — *Ignore*, not
   *Resolve*. Resolved incidents regress and reopen on a new occurrence; ignored ones do not,
   and closed incidents "will no longer be raised by GitHub checkruns."
3. Only if 1 proves insufficient: filepath exclusions `**/*.test.ts`, `**/test-fakes/**`.
   This is the tempting and dangerous one — a real key pasted into a test is the likeliest
   way one enters this repo, and this blinds the scanner to exactly that.

Developers can also self-unblock from the GitHub UI via **Skip: test credential**, if the
workspace Manager leaves skip actions enabled.

## The part that is not about GitGuardian

A security check that is **always red** is worse than no check, because it trains everyone to
merge past it — which is precisely what happened on #43, by me. That is the actual risk here,
not the 14 strings. Once the exclusions are in, GitGuardian is worth making a **required**
check so it can never be background noise again.

`.gitguardian.yaml` is committed anyway, with a comment saying plainly that it does nothing
for the App check. It costs nothing, it is correct the day a ggshield pre-commit hook is
added, and it documents this finding at the exact place the next person will look.
