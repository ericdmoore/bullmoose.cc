# s29 — optimizations

> **Status: DESIGN.** Two threads share this number; both are scratch until someone
> picks them up.

## Model selection — the main thread
Cost/quality routing for hosted agents: cheapest sufficiently-good model per task kind.

- [`model-selection-ladder.md`](./model-selection-ladder.md) — task schema, cheap→dear
  ladders, eval set, cascade router, and the path to s26 T5c (learned menu rewrite).

Neighbouring work: s26's frontier program (assignment + digest already landed; the
learned router is the piece this feeds) · s27 usage-and-spending · s28 full-SMB-cast.

## CI and hot paths — the smaller thread
Kept here rather than in a separate directory, because the directory it used to point
at (`.plans/s29-code-hygiene/`) does not exist.

Save CI minutes:
- https://vitest.dev/guide/parallelism
- https://vitest.dev/config/maxworkers
- https://vitest.dev/guide/coverage.html → `v8`

Hot paths / fast paths: identify them first, then look for optimizations.

> Both halves of this file were committed as an unresolved merge conflict on
> 2026-08-19 and reconciled on the same day — the two threads are kept, the dangling
> directory reference dropped.
