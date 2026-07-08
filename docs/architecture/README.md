# Architecture

How bullmoose is wired, and — more importantly — **why** it's wired that
way. Deep dives live alongside this file: `serverless-jmap.md` (the core
design), `agent-integration.md` (agents), and
`capacity-and-scaling.md` (what the free tier holds, the quotas that
bind, and the shelved relief valves — blob compression and shard
rotation). This README is the map.

Forward-looking design docs — proposals, not yet built — sit here too:
`capability-roadmap.md` (the next layer), and the Cloudflare-AI evaluation
`ai-surface.md` with its companions `agents-sdk.md` (reject the framework,
cherry-pick the patterns) and `ai-search-rag.md` (opt-in retrieval,
isolation-first).

The whole system is a **serverless JMAP mail platform**: modern clients
speak JMAP directly; legacy clients reach it through a homelab protocol
shim; agents are just mailboxes with a runtime attached. State lives in
exactly one place per account, and every worker is stateless around it.

---

## 1. System topology

```mermaid
flowchart TB
  subgraph clients [Clients]
    JC[JMAP client / CLI]
    LC[Legacy POP3/SMTP client]
  end

  subgraph cf [Cloudflare -- free tier]
    ER[Email Routing]
    JW[jmap worker]
    IW[ingest worker]
    SW[submit worker]
    PW[provision worker]
    AW[agent worker]
    DO[AccountDO -- Durable Object]
    D1[(D1 -- metadata)]
    R2[(R2 -- raw blobs)]
    KV[(KV -- routes + suppression)]
  end

  subgraph homelab [alpaca -- homelab]
    PC[popcorn -- POP3S/SMTPS]
    HB[hermes bridge]
    HA[hermes agent]
  end

  SES[AWS SES]
  WORLD[the internet]

  JC -->|HTTPS JMAP| JW
  LC -->|POP3S / SMTPS| PC
  PC -->|JMAP| JW

  WORLD -->|inbound SMTP| ER --> IW
  IW --> R2 & D1
  IW --> DO
  IW -->|poke| AW
  JW --> DO
  JW --> D1 & R2
  DO -->|StateChange push| JC
  AW --> D1 & R2 --> DO
  JW -->|submission| SW
  AW -->|submission| SW
  DO -->|armed responder| SW
  SW -->|SigV4| SES --> WORLD
  PW -->|DNS + SES setup| KV
  IW -.->|route lookup| KV

  HB -->|watch + read| JW
  HB -->|invoke| HA
  HB -->|reply via SMTPS| PC
```

**Why this shape.** One rule drives everything: *state changes go through
a single writer per account (the Durable Object); everything else is
stateless and horizontally trivial.* Reads (Email/get, downloads) hit
D1/R2 directly and never touch the DO, so the single-writer bottleneck
only applies to the rare write path. The workers are deliberately small
and single-purpose because Cloudflare bills and rate-limits per worker
invocation, and because a circular service-binding graph can't deploy
(see §5).

---

## 2. Inbound: a message arriving

```mermaid
sequenceDiagram
  participant W as Sender (world)
  participant ER as Email Routing
  participant IW as ingest worker
  participant R2 as R2
  participant D1 as D1
  participant DO as AccountDO
  participant AW as agent worker
  participant C as Live client (watch)

  W->>ER: SMTP to eric@bullmoose.cc
  ER->>IW: deliver (catch-all / literal rule)
  IW->>D1: KV route lookup (exact->plus-strip->catch-all)
  IW->>R2: store raw RFC5322 (content-hash blobId)
  IW->>D1: insert metadata (normalized Message-ID)
  IW->>D1: create AgentInvocation (if bound)
  IW->>DO: commit(Email created, Mailbox updated)
  DO-->>C: StateChange push (WebSocket)
  IW->>AW: poke /drain (fire-and-forget)
  IW-->>ER: 250, then forward verified copies
```

**Why store-then-commit-then-push, in that order.** The raw blob and the
metadata row must exist *before* the DO announces the new state, or a
client woken by the push could fetch a message that isn't queryable yet.
The forward-a-copy step (`forwardTo`) happens **last**, after delivery
succeeds, so a forwarding failure can never bounce mail we've already
accepted — the message is safe the instant it's in R2+D1.

**Why a poke *and* a cron.** The `/drain` poke gives sub-second agent
latency, but pokes can die mid-flight. The `AgentInvocation` row in D1 is
the real queue; a `*/5` cron sweep is the retry net. The row is the
truth, the poke is just an optimization — so we never need Cloudflare
Queues (a paid feature).

---

## 3. The single-writer account (Durable Object)

```mermaid
flowchart LR
  subgraph DO [AccountDO -- one per account]
    SEQ[state sequence]
    LOG[bounded changelog -- 4096]
    WS[hibernatable WebSockets]
    AL[alarm -- armed responders]
  end

  IW[ingest] -->|POST /commit| SEQ
  JW[jmap Email/set] -->|POST /commit| SEQ
  AW[agent] -->|POST /commit| SEQ
  SEQ --> LOG
  SEQ --> WS
  LOG -->|GET /changes| JW
  WS -->|StateChange| CL[clients]
  AL -->|fire| SUB[submit worker]
```

**Why a Durable Object at all.** JMAP's sync model needs a *monotonic
per-account state* and a changelog so clients can ask "what changed since
state X." That demands a single serialization point per account — exactly
what a Durable Object is (a single-threaded actor with storage). SQLite-
backed DOs are free-tier eligible, so we get this for $0.

**Why a bounded changelog.** Keeping every change forever is unbounded
storage; keeping the last 4096 is enough that any reasonably-live client
resyncs incrementally, and anyone further behind gets a clean
`cannotCalculateChanges` → full resync (which the spec is built for). The
DO also owns **alarms**, which is how armed responders (vacation,
watchdogs) fire without any always-on process.

---

## 4. Outbound: sending

```mermaid
sequenceDiagram
  participant C as Client / CLI / agent
  participant JW as jmap worker
  participant DO as AccountDO
  participant SW as submit worker
  participant KV as KV suppression
  participant SES as AWS SES
  participant W as Recipient

  C->>JW: EmailSubmission/set (envelope + emailId)
  JW->>SW: POST /internal/submit (shared secret)
  SW->>KV: suppression check per rcpt
  SW->>SES: SendRawEmail (SigV4)
  SES->>W: deliver (DKIM-signed, SPF/DMARC aligned)
  SW-->>JW: submission id
  JW->>DO: commit (move Drafts -> Sent)
```

**Why a separate submit worker with no DO binding.** Cloudflare can't
originate SMTP, so outbound must egress through a cloud relay (SES). We
isolate that in one worker holding the SES credentials. Critically, the
`jmap` worker binds `submit` as a service — so if `submit` bound the
AccountDO back, the two deployments would be **circular and un-deployable**.
Instead the callers do the state commit. The suppression list (populated
by SES bounce/complaint webhooks) is checked here, at the last hop before
send, so a suppressed address is never re-mailed regardless of caller.

---

## 5. Why the worker graph is a DAG (deploy order)

```mermaid
flowchart LR
  SW[submit] --> JW[jmap -- declares AccountDO]
  JW --> IW[ingest -- binds AccountDO]
  JW --> AW[agent -- binds AccountDO]
  PW[provision]
  JW -.->|service binding| SW
  IW -.->|service binding| AW

  classDef d fill:#0a4d8c,color:#fff
  class SW,JW,IW,AW,PW d
```

**Why order matters.** `jmap` *declares* the `AccountDO` class (owns its
migrations); `ingest` and `agent` *bind* it cross-script by name — so
`jmap` must deploy first. `jmap` binds `submit` as a service, so `submit`
deploys before `jmap`. The result is a strict dependency order
(submit → jmap → ingest → agent → provision) and a graph with **no
cycles** — the constraint that forced submit to stay DO-free in §4.

---

## 6. Authentication

```mermaid
flowchart TB
  PW[password login] -->|client-side PBKDF2 600k| LK[loginKey]
  LK -->|POST /auth/login| JW[jmap worker]
  JW -->|one SHA-256| DBT[(tokens table -- hash at rest)]
  JW -->|mint| TOK["bm_&lt;id&gt;_&lt;secret&gt; token"]
  TOK --> B1[JMAP Bearer]
  TOK --> B2[HTTP Basic -- app password]
  TOK --> B3[POP3S / SMTPS via popcorn]

  classDef s fill:#0a4d8c,color:#fff
  class JW s
```

**Why stretch the password on the client.** The Workers free tier caps
CPU at 10ms per request — nowhere near enough for a 600k-iteration KDF.
So the *client* runs PBKDF2 and the server only ever sees (and does one
cheap SHA-256 over) the derived key. The password never crosses the wire.

**Why tokens double as app-passwords.** Legacy clients and third-party
JMAP apps only speak username+password. A minted `bm_` token *is* that
password (HTTP Basic / POP3 PASS / SMTP AUTH), scoped and individually
revocable — so a phone gets a throwaway credential, never the real one.

---

## 7. Agents: mailboxes with a runtime

```mermaid
flowchart TB
  M[mail to agent mailbox] --> INV[AgentInvocation -- D1 queue]
  INV --> CLAIM{optimistic claim -- pending to running}
  CLAIM -->|cloud| AW[agent worker]
  CLAIM -->|homelab| HR[bullmoose agent serve / hermes bridge]
  AW --> RP{pipeline}
  RP -->|reply| EM[EditorEmily -- persona reply]
  RP -->|ledger| AL[Allen -- extract, SQL aggregate, digest]
  SLA[SLA watchdog -- DO alarm] -.->|fires unless claimed| SUB[submit]
```

**Why the queue is just a D1 table.** An `AgentInvocation` row per
delivery, claimed with an optimistic `pending→running` UPDATE, means the
**cloud worker and a homelab runner can watch the same mailbox** and
whoever claims first wins — no coordination, no lock service. The SLA
watchdog (a DO-alarm armed responder) backstops both: if nobody claims in
time, the sender gets a "may be down" note.

**Why two runtimes.** Cloud agents (Emily, Allen) are stateless and cheap
and can't reach your homelab. hermes needs its local tools, memory, and
skills — so it runs on alpaca and is bridged in (§8). Same queue, same
guards, different muscle.

---

## 8. Client protocol coverage

```mermaid
flowchart LR
  subgraph modern [Modern]
    J[JMAP client] -->|HTTPS 443| JW[jmap.bullmoose.cc]
  end
  subgraph legacy [Legacy -- via popcorn on alpaca]
    P[POP3 client] -->|POP3S 9995| PC[popcorn]
    S[SMTP client] -->|SMTPS 9587| PC
    PC -->|JMAP| JW
  end
  JW --> CORE[(D1 + R2 + DO)]
```

**Why popcorn is a homelab shim, not a worker.** POP3 and SMTP are raw
TCP with a *server-speaks-first* greeting; Cloudflare's edge only
terminates HTTP(S)/WebSockets and waits for a request — so it can never
answer a POP3 client. popcorn (a tiny Go daemon) runs anywhere with a
real socket, holds zero state, and translates POP3/SMTP onto the same
JMAP API modern clients use. `DELE` becomes an archive move — the server
keeps every message.

---

## 9. The hermes homelab bridge

```mermaid
sequenceDiagram
  participant U as You
  participant JW as jmap worker
  participant HB as hermes bridge (alpaca)
  participant HA as hermes agent
  participant PC as popcorn SMTPS
  participant SES as SES

  U->>JW: email hermes@bullmoose.cc
  JW-->>HB: StateChange push (watch)
  HB->>JW: read full body
  HB->>HB: arm 45s watchdog
  HB->>HA: hermes -z --continue (per-sender session)
  HA-->>HB: reply
  HB->>PC: SMTPS submit (cancels watchdog)
  PC->>JW: EmailSubmission
  JW->>SES: send
  SES->>U: hermes replies
```

**Why compose primitives instead of a new worker.** Everything hermes@
needs already exists — `watch` (receive), `read` (body), popcorn's SMTP
(send). The bridge is glue, not infrastructure, so it stays out of the
deployed cloud and can't destabilize it. The 45s watchdog is local to the
bridge; the tradeoff is that an alpaca outage takes only hermes@ offline
while the cloud agents keep running.

---

## Cross-cutting rationale

- **Free tier as a forcing function.** The 10ms CPU cap moved key
  stretching client-side (§6); the lack of Queues made the D1 row the
  queue (§2); SQLite-backed DOs gave per-account serialization for $0
  (§3). Constraints shaped a leaner design, not a worse one.
- **One source of truth.** Every client (JMAP, POP3, SMTP, agents) reads
  and writes the same D1+R2+DO. There is no second copy to reconcile — the
  CLI's local SQLite is a cache, popcorn is stateless, agents commit back.
- **Fail-open, never lose mail.** Inbound that can't be processed is a
  temporary SMTP error (senders retry for days); forwards happen after
  durable storage; agent non-receipts forward rather than drop.
```
