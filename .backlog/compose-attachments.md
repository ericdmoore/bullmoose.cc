# Compose attachments (the outbound half of the sidestep)

Found 2026-08-13 while building `s03.B` T3: **`Email/set create` / `buildMime` have no
attachment path at all** — `services/jmap/src/methods/email.ts:517` hardcodes
`attachments: []`. You cannot attach a file to an outgoing message, which means:

- `s03.C` T3's "large-attachment compose path wired to s03.B's sidestep" is blocked;
- an agent cannot email you a report it generated (Eric's artifact use case);
- the sidestep is inbound-only by necessity, not by choice.

**Prefer the inversion where possible.** For *agent-authored* artifacts the better shape is
file-first: write the FileNode, then send mail that REFERENCES it via `/api/share`. Cheaper
(no MB through SMTP), revocable (a share link can be withdrawn; an attachment cannot), one
canonical copy the agent can revise, and `file_nodes.last_writer_binding` already records
which agent made it. Both `FileNode/set` and `/api/share` exist today.

Compose attachments are still needed for mail to the *outside world*, where the recipient
has no access to our drive and the bytes must travel. That is the case this task is for.

Related gap, worth deciding at the same time: **`file_nodes` has no `write_policy`** while
`address_books` does (data-plane.sql:442). We bounded agents' outbound mail (the governing
book) and their contact writes (propose/governed tiers) and never their file writes. The day
an agent writes artifacts into a human's drive, that is the same confused-deputy question,
and the same three tiers are the answer.
