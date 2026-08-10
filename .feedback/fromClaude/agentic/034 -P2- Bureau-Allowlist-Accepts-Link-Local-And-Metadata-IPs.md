# 034 -P2- The Bureau allowlist accepts link-local / metadata IP literals

**Subsystem:** agentic-components · **Severity:** MEDIUM (SSRF-to-metadata, one operator typo away) · **Fix class:** CHANGE-CODE

## The claim

`bureau.md` §6 makes destination binding **the** primary control: a credential is usable
only against origins the operator named. The design leans on that allowlist so hard that
nothing downstream re-checks the destination's *nature* — only its spelling.

## The defect

`services/bureau/src/binding.ts` parses an allowlist entry through `new URL()` and compares
protocol / port / hostname. It never asks what the hostname **resolves to or denotes**.
So all of these are mintable via `vault.ts` `normalizeAllow` and enforceable as legitimate:

- `http://169.254.169.254` — the cloud metadata address
- `http://127.0.0.1:8080`, `http://[::1]` — loopback
- `http://10.0.0.5`, `http://192.168.7.21` — RFC1918 (note: that second one is `alpaca` itself)

## Why it is not already a breach

The allowlist is **operator-minted**, not agent-chosen. An agent cannot widen its own
binding, so reaching metadata requires a human to have typed the metadata address into
`--allow`. And Cloudflare Workers expose no IMDS at `169.254.169.254`, so the classic
cloud-credential-theft payoff is absent *on the current runtime*.

That is a defensible position. The problem is it is currently an **omission** rather than a
decision — nothing in code or docs says "we considered private ranges and chose to permit
them," so the next person to read `binding.ts` cannot tell whether it is intentional.

## Why it still matters

1. Reference `017` — homelab and cloud runtimes are not interchangeable. The Bureau's own
   design admits a future where it proxies to internal services; `192.168.7.21` is a
   plausible real allowlist entry on this box, not a hypothetical.
2. The failure is **silent and total**: a credential bound to a metadata endpoint behaves
   exactly like a correctly-bound one, and invariant 1 still holds (the value never returns
   to the agent) — so no existing test or invariant would notice.

## Suggested fix

Refuse IP-literal allowlist entries in private / link-local / loopback ranges **at mint
time** (`normalizeAllow`, the human boundary, where a clear error can be shown) rather than
at use time, with an explicit `--allow-private` opt-out for the homelab case. That keeps the
decision visible in the audit trail instead of implicit in a parser.
