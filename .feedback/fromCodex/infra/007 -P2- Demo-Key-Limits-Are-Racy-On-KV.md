# 007 -P2- Demo key mint/use limits are racy on KV

**Subsystem:** cloud-infra (`services/demo-keys`) · **Severity:** MEDIUM (abuse-control bypass) · **Fix class:** CHANGE-CODE + UPDATE-DOC

## The defect

`services/demo-keys/src/index.ts:130-135` enforces `MINTS_PER_IP_PER_DAY` with KV read-modify-write:

```ts
const mints = Number((await env.DEMO_KEYS.get(ipKey)) ?? "0");
if (mints >= MINTS_PER_IP_PER_DAY) ...
await env.DEMO_KEYS.put(ipKey, String(mints + 1), { expirationTtl: 86400 });
```

`handleVerify` does the same pattern for per-phrase sender/usage state at `services/demo-keys/src/index.ts:173-196`: read record, mutate `senders`/`uses`, write record.

KV does not provide compare-and-swap or strongly consistent read-modify-write semantics for concurrent requests. Two requests can read the same value, both pass the check, and the later write wins.

## Why it bites

The README says Turnstile plus per-IP cap and leak detection are the public minting controls. Under bursty or intentionally concurrent traffic, the cap and sender leak threshold are best-effort, not enforced.

This service is intentionally public-facing. Even if Turnstile filters most automation, the server-side limit should not rely on non-atomic KV mutation.

## Impact

- Multiple concurrent `/demo/request` calls can mint more than three phrases per IP/day.
- Multiple concurrent `/demo/verify` calls from new senders can exceed the leak threshold or lose sender/uses updates.

The blast radius is demo access, not core mailbox data, so this is P2 rather than P1.
