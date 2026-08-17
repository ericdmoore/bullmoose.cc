# 040 -P1- `primaryAccounts` is empty for a principal that only has grants

**Subsystem:** common · **Severity:** HIGH (sharing is broken for the user sharing was built for) · **Fix class:** CHANGE-CODE

## The defect

`services/jmap/src/session.ts:61`:

```ts
const primary = principal.accounts.find((a) => !a.granted)?.accountId ?? "";
```

`primaryAccounts` is derived from the first account the principal **owns**. A principal whose
every account arrives by grant — no owned account at all — gets `""`.

## Consequence

`primaryAccountId(CONTACTS_CAP)` (and every other capability) resolves to the empty string for
exactly the population sharing exists to serve: someone given access to another account's
contacts, calendar or mail and nothing of their own. A client that follows RFC 8620 §2 and
reads `primaryAccounts` to pick a default account gets an id that matches nothing, and the
first request fails in a way that looks like a permissions problem rather than a session bug.

`verifyBearer` handles this population correctly — `packages/auth-core/src/principal.ts`
resolves owned accounts and grant-reached accounts into one list, and `authorizeAccount`
authorizes either. So the authorization layer supports grant-only principals and the
**session document does not describe them.**

## Why it has not bitten yet

Every surface built so far enumerates `accounts` rather than trusting `primaryAccounts`, or
is driven by an operator who owns their account. `/contacts` (s07 T3a) hit it because it is
the first screen designed to be used by a grantee, and it works around it with
`contactsAccounts(session)`, which enumerates the account list.

## Suggested fix

Fall back to the first **reachable** account rather than the first owned one, preferring an
owned account when one exists:

```ts
const primary =
  principal.accounts.find((a) => !a.granted)?.accountId ??
  principal.accounts[0]?.accountId ??
  "";
```

And decide deliberately whether `""` should be possible at all — a principal with zero
reachable accounts is a real state (every grant revoked), and `primaryAccounts: { …: "" }` is
a worse answer than omitting the capability from the session entirely.
