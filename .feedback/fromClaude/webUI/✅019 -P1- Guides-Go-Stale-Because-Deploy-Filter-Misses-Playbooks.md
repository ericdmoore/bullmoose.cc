# 019 -P1- Published guides go stale — the deploy filter never fires on playbook edits

**Subsystem:** webUI · **Severity:** HIGH · **Fix class:** CHANGE-CODE (one line)

## The defect

The site sources its guides from **outside** `src/`:

```ts
// src/src/content.config.ts:8
base: "../docs/playbooks";
```

But the deploy workflow only triggers on changes **inside** `src/`:

```yaml
# .github/workflows/deploy.yml:17-19
paths: ["src/**", ".github/workflows/deploy.yml"]
```

So editing `docs/playbooks/apple-mail-and-calendar.md` triggers **no workflow**, and the published
page keeps the old content indefinitely — until some unrelated `src/**` change happens to ship it.

## The site asserts the opposite, on the page itself

- `src/src/pages/guides/[slug].astro:27` renders: _"Source: `docs/playbooks/<id>.md` — **edit it in
  the repo and this page updates**."_
- `src/src/pages/guides/index.astro:23-24` — _"rendered straight from the repo playbooks — same
  source, so **they never drift**."_

Both statements are currently false, and they're the kind of claim a reader will rely on rather than
verify.

## Why HIGH

Silent staleness with an explicit promise of freshness. A user follows a setup guide that was
corrected weeks ago and hits the old, wrong instructions — and the page tells them it's current.
