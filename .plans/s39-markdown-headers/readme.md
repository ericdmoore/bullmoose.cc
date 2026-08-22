# s39 — Markdown headers · *a message is a file you can keep*

> **Status: DESIGN.** Suppression shipped with the renderer (#284); honouring is
> unbuilt. Written 2026-08-22 from Eric's question — *"does goldmark support
> frontmatter?"* — and the answer that it does not, and that what it renders
> instead is worse than nothing.

## Where this came from

Frontmatter used to render straight into the message. CommonMark reads a
leading `---` as a thematic break and the line after it as a setext heading, so

```markdown
---
title: Notes
to: a@b.com
---
```

arrived in the recipient's mail as `<hr />` followed by an `<h2>` reading
"title: Notes to: a@b.com" — **with the address helpfully autolinked**. Not a
goldmark quirk: `marked` does the same, so the Node CLI has this today.

**Suppression is done** (`internal/markdown/frontmatter.go`): the block is
split off before rendering, recognised but deliberately NOT parsed, and handed
back raw so this section can use it.

## The proposal

Frontmatter keys become the message's headers:

```markdown
---
to: grace@example.test
cc: ops@example.test
subject: Project Elk kickoff
---

Monday works — I'll bring the draft agenda.
```

```
bullmoose send --file kickoff.md          # no flags at all
cat kickoff.md | bullmoose send           # a complete email on stdin
```

## Why it is worth building

It makes **a message a file you can keep, diff, review and version** rather
than a shell invocation that exists once in someone's history. That fits this
product's grain: the same argument that makes `workout.md` a file and
`swap-map` a schema, applied to correspondence.

It also closes the loop on the stdin idea already shipped — piping Markdown
works today, but the addressing still has to be typed as flags, so the file is
only half the message.

And it is the shape an **agent** wants. A drafted reply is currently a JMAP
object; a drafted reply as a Markdown file with frontmatter is reviewable in a
diff, which is the same insight [[s30-CHAP-ideas]] reaches from the other
direction — the human's edit should be inspectable, not a blob swap.

## 🔴 The security decision this turns on

**Frontmatter is attacker-controlled the moment a received file can be piped
to `send`.**

That is not hypothetical here: the attachment sidestep files inbound
attachments into Files, and `send --file` takes a path. A `.md` that arrives
by mail and is later piped becomes a **recipient-injection primitive** — the
same shape as the `editedPayload` hole (#158), where an edit could retarget an
agent's message, and it is worth remembering that one shipped for a while
looking perfectly reasonable.

So the design must decide, before anyone writes the parser:

**1. Which keys are honoured at all.** `to` / `cc` / `bcc` / `subject` are the
obvious set. **`from` is NOT** — it selects a sending identity, and taking that
from file content is a different risk class entirely: it is the difference
between "this file says where to send" and "this file says who I am".

**2. Precedence.** A flag should BEAT the file, and a conflict should be said
out loud on stderr rather than silently resolved. Silent override is how the
wrong subject goes out; silent merge is how an unnoticed `bcc:` does.

**3. Whether recipients from a file are a tier-1 act at all.** The honest
option is that they are not: a file-supplied `to:` could require confirmation
unless `--yes`, or be refused entirely when the file is not on a path the human
named. Cheapest sound version: **flags-only for recipients, frontmatter for
`subject` and body metadata**, which delivers most of the ergonomics with none
of the injection surface.

**4. `--dry-run` must show the RESOLVED envelope.** Whatever the rules, a
person must be able to see who this will actually reach before it goes, and
there is no unsend.

## Slices

**T1 — read and merge.** Parse the block, apply the precedence rule, print the
resolved envelope under `--dry-run`. Needs a YAML parser, which would be the
first in cli-go — or a deliberately tiny `key: value` reader, since the
supported keys are a closed set and full YAML brings anchors, aliases and
multi-document parsing that nothing here wants.

**T2 — the refusal path.** Whatever #3 decides, implemented as an explicit
refusal with a sentence, not a silent drop.

**T3 — `--emit`, maybe.** The inverse: render an existing message BACK to
Markdown-with-frontmatter, so a thread can be filed, diffed, or handed to an
agent. Speculative, and the most interesting of the three.

## Open questions

1. Does the Node CLI ever learn this? **No** — the freeze says new CLI surface
   is Go only, so this is the first feature that will exist in one CLI and not
   the other. Worth stating plainly because it ends the byte-identity contract
   for `send` in a second, larger way than the renderer already did.
2. YAML, or a closed-set `key: value` reader? Leaning the latter: a closed set
   cannot grow an injection surface through a parser feature nobody meant to
   enable.
3. What happens to unknown keys — ignored, or refused? Ignored invites silent
   typos (`subjcet:`); refused invites churn. Leaning: ignored, but **named on
   stderr**, the same way a conflict is.

## Related

- [[s08-go-cli]] — the port this rides on; `send --expandMD` is its last
  partially-delegating path
- [[s30-CHAP-ideas]] — a reviewable edit; a message-as-file is the same idea
- #158 — the recipient-rewrite hole this must not recreate
