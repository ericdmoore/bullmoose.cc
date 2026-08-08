# 002 -P1- `EmailSubmission/set` trusts client-supplied envelope `mailFrom`

**Subsystem:** common (`services/jmap` outbound) · **Severity:** HIGH (identity / abuse boundary) · **Fix class:** CHANGE-CODE + ADD-TEST

## The defect

`services/jmap/src/methods/submission.ts:119-128` verifies that `identityId` belongs to the account, but then `submission.ts:130-151` lets the caller override the SMTP envelope sender:

```ts
const mailFrom = spec.envelope?.mailFrom?.email ?? identity.email;
...
envelope: { mailFrom, rcptTo },
```

There is no check that `spec.envelope.mailFrom.email` equals the selected identity, belongs to another identity on the same account, or is on an active owned domain.

## Why it bites

The architecture doc says the submit path validates "identity <-> account <-> domain" and that envelope MAIL FROM ownership is checked before send (`docs/architecture/serverless-jmap.md:129`, `:173`). The implementation checks only the `identityId`; the actual envelope handed to the submit worker can be arbitrary.

Depending on the relay's behavior, this is either:

- a spoofing path if the relay accepts the envelope/header combination, or
- a reliable self-DoS/confusing failure path where SES rejects sends after the JMAP layer already accepted the request shape.

The same method also allows explicit `rcptTo`, which is required for Bcc, but the sender address needs a stricter rule than recipients.

## Secondary issue

`submitOne` accepts any existing `emailId` in the account (`submission.ts:116-117`). It does not require the email to be a draft or to carry `$draft`. That lets a send-scoped token resubmit inbound/stored messages through the outbound relay.

## Cross-references

Not the same as Claude issue 002 (MIME header injection). This is the SMTP/JMAP identity boundary.
