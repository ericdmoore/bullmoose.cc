# FIX - 002 -P1- `EmailSubmission/set` trusts client-supplied envelope `mailFrom`

## Proposal

Make the selected JMAP identity authoritative for the sender.

```ts
const requestedMailFrom = spec.envelope?.mailFrom?.email?.toLowerCase();
const identityEmail = identity.email.toLowerCase();
if (requestedMailFrom && requestedMailFrom !== identityEmail) {
  throw new MethodError("invalidArguments", "envelope.mailFrom must match identityId");
}
const mailFrom = identity.email;
```

Then decide whether to support a separate bounce address later as an explicit server-side identity property, not a client-controlled override.

## Draft enforcement

Also require the submitted `emailId` to look like a draft:

- row contains `$draft`
- row is in a mailbox with role `drafts`
- preferably both

That keeps `EmailSubmission/set` aligned with the documented `Blob/upload -> Email/import into drafts -> EmailSubmission/set` flow.

## Tests

Add cases around `submitOne` or `EmailSubmission/set` with fake `Mailstore`/`SUBMIT`:

- explicit `mailFrom` matching identity succeeds
- explicit `mailFrom` not matching identity fails before `SUBMIT.fetch`
- missing `mailFrom` uses the identity email
- non-draft email cannot be submitted

## Docs

Update `docs/architecture/serverless-jmap.md` after the code matches it; today that doc is aspirational on this point.
