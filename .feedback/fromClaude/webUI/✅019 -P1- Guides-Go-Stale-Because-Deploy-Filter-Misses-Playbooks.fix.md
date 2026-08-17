# FIX — 019 -P1- Guides go stale; deploy filter misses playbooks

## Proposal

One line:

```yaml
# .github/workflows/deploy.yml:17-19
paths:
  - "src/**"
  - "docs/playbooks/**" # ← the guides content source
  - ".github/workflows/deploy.yml"
```

## The general rule worth extracting

**A build's trigger filter must cover every path its inputs are read from.** `content.config.ts:8`
reaches outside `src/` with `base: "../docs/playbooks"`, so the filter has to reach outside too.

Worth a comment at `src/src/content.config.ts:8` pointing at the workflow, since the coupling is
invisible from either side:

```ts
// NOTE: sourced from outside src/ — .github/workflows/deploy.yml's `paths`
// filter must include docs/playbooks/** or edits here never deploy.
```

That comment is what stops it regressing the next time the workflow is edited.

## Verify after the fix

Touch a playbook, push, and confirm the workflow runs and the published page changes. That is a real
end-to-end check and takes a minute — worth doing rather than assuming, since the whole finding is
"the trigger silently didn't fire."

## While you're in that workflow

Two adjacent gaps, both worth folding into the same PR (see also webUI issue `020`):

- `deploy.yml:14-20` runs on **push to main**, not on PRs, and `mail-typecheck.yml:4-14` filters to
  `packages/**`/`services/**` — so **no workflow ever builds `src/` before it lands**. A broken
  `.astro` file reaches `main` and fails at deploy time.
- `cloudflare/wrangler-action@v3` (`deploy.yml:40`) runs with `workingDirectory: src`, where no
  `wrangler` is installed — so it installs its own unpinned version. Pin `wranglerVersion:` to match
  the root (4.107.0) for reproducibility.
