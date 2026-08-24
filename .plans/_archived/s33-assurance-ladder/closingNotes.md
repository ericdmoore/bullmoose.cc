---
plan: s33-assurance-ladder
status: closed
closed_at: 2026-08-24
closing_pr: none        # docs-only archive move; the build was #340 #342 #344 #348 #349 #350 (+ #341 the denylist retired into s38's namespace answer)
acceptance: partial     # the ladder and the ceremony are built end to end; no role@ calls them yet, and recovery rungs 2–3 are unbuilt
residues: 3
reversals: 0
---

# s33 — closing notes

Set out to answer "who is asking, and how sure are we?" for the 3am hr@
case, and became the credential architecture of the whole product: the
resolved rule (no passwords; two authenticators complete an account)
turned the enrollment door into the missing #213 onboarding path, login
into an assertion ceremony, and tier 3 into approval of a DESCRIBED ACT.
The Kevin Durant case — authentic and still not the identity — is a test
now, not an anecdote.

## Acceptance ledger

| Done-when (the plan's slices, verbatim) | verdict | evidence |
|---|---|---|
| "1. Record the positive assurance … absent ≠ unauthentic" | ✅ met | #340; `emails.assurance_json`, aligned mechanism recorded, topmost-header trust model shared with stage 2 |
| "2. Passkey enrollment on auth.bullmoose.cc: register/list/revoke, one-time enrollment link, RP ID pinned" | ✅ met | #342 (door, ×2 rule, none-attestation structural verify) + #350 (list/revoke: own-only, agents never, last-passkey-stays) |
| "3. The challenge + mint: a described-act page, ceremony, narrow single-use token" | ✅ met (one named deviation) | #348; the ROW is the capability — every binding the plan listed (account, message, category, single-use, TTL) with no bearer plaintext to custody |
| "4. Agent-side consumption: a role@ asks for tier 3, receives PASS|FAIL …" | ✅ machinery / ❌ caller | #349 (ask/consume/notify; PASS|FAIL only; row-after-relay; OQ5 notice); no pipeline CALLS it yet — #351 |
| "5. Directory import (tier 2) — only when a buyer with an IdP appears" | ⏸ deferred by design | #353 |
| (added by the credential rule) passkey sign-in | ✅ met | #344; usernameless, two heads one tail at /authorize |
| (named in the day-one design) recovery rungs: admin reset + notify-and-delay | ❌ unmet | designed only; the enroll door's arrival-only stance makes lost-both-devices rungless — #352 |

## Carried forward

| what | why it did not ship | owner |
|---|---|---|
| The first role@ ceremony caller (the hr@ product decision) | which role asks is Eric's call, not machinery | #351 |
| Recovery rungs 2–3 (admin reset for passkey-complete principals; external-address notify-and-delay) | the arc built arrival and use; recovery is its own consent design | #352 |
| Directory import (tier 2, CSV/SCIM) | deferred by the plan's own words until an IdP buyer appears | #353 |

## Reachability

- **Deployed?** rides deploy-mail.yml (jmap/ingest/agent/oauth) on next dispatch; nothing gates it. The `ceremonies`, `webauthn_credentials` tables and `assurance_json`/`notified_at` columns are in schema + migrations (one deploy-blocker: emails-assurance-json).
- **Verified live?** the crypto is tested against genuine P-256 keypairs (never its own forge); no live browser ceremony has run yet — that lands with the first real enrollment (Eric's own, presumably).

## Authority-surface delta

The largest of any section to date, all of it narrowing: no account
password at enrollment (nothing for the operator to know); tier 3 exists
and is a passkey ceremony over a described act; agent tokens cannot manage
authenticators; a sweep-born offer cannot ride the rung-3 grant; the
ceremony gate answers PASS|FAIL and nothing else.

## Deviations from the plan

- The PASS mints no bearer: the ROW is the capability (named in #348) —
  every binding the plan listed, zero secret custody.
- TOTP/SSH caps and the SiteKey rejection are recorded in the readme and
  stand unbuilt-by-design (they cap what may exist, not what must).

## Traps for the next section

- WebAuthn test forges must never grade their own homework: encode with an
  independent CBOR writer, re-encode WebCrypto's raw signatures as DER.
- An already-decided ceremony must stay decided — every failure path
  DECIDES the row, or a leaked link becomes unlimited tries.
