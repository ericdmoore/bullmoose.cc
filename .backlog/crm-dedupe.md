# crm@ — contact curation (dedupe first)

Design is written: `.plans/s16-crm/readme.md`. Backlogged 2026-08-13 — not scheduled.

The prompt was a real 3,559-card book with visible duplicates (`Adam Naryka /
anaryka@mail.smu.edu`, twice, adjacent). Dedupe is the first verb; enrichment,
missing-contact, staleness and group suggestions are named in the same note.

Why it is cheap when it comes up: it needs **no new authority** — s10's
`write_policy: 'propose'` tier was built for exactly this and still has no
occupant. `crm@` holds `contacts` scope, the human's book is `propose`, and the
chokepoint turns every agent write into a reviewable, chained proposal.

Two things not to lose when it is picked up:
- **Batch by confidence tier.** Hundreds of pairs as hundreds of proposals would
  make `/approvals` useless (the s11 T9 lesson). Exact duplicates batch into one
  ask; only the ambiguous middle earns a proposal per cluster.
- **A new `merge-contacts` kind, not `create-contact`.** The apply path is
  merge+tombstone and the surface must render a *diff*, because
  edit-before-approve is where the value is.

Companion gap, same screenshot: contacts search is unindexed (every search reads
every card — the page says so itself; s07 T6). Dedupe makes the book smaller;
it does not make search scale.
