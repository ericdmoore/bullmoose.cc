# FIX - 003 -P1- `Email/set` gates moves, flags, and destroys with only `draft`

## Proposal

Authorize per operation instead of once for the whole method.

Suggested mapping:

- `create`: `draft`
- keyword-only update: `annotate`
- mailboxIds update: `move`
- mixed keyword + mailbox update: require both `annotate` and `move`
- `destroy`: `delete`

Implementation shape:

1. Resolve account existence once with a read-ish helper or a new `resolveAccount`.
2. Before each operation group, call an authorization helper with the operation's required scope.
3. For each update patch, inspect keys before applying. `keywords` requires `annotate`; `mailboxIds` requires `move`.
4. Keep `ifInState` evaluated once at method start.

## `onSuccessUpdateEmail`

For `EmailSubmission/set`, do not give arbitrary patch power to `send`. Either:

- restrict `onSuccessUpdateEmail` to the submitted draft and require it only removes `$draft` / moves to `sent`, or
- require the caller to also hold `move`/`annotate` for the requested patch.

The first option matches the CLI's send flow and reduces attack surface.

## Tests

Add authz cases:

- `draft` token can create but cannot update/destroy
- `annotate` token can change `$seen` but not mailboxIds
- `move` token can change mailboxIds but not keywords
- `delete` token can destroy
- `send` token cannot smuggle arbitrary mailbox/keyword edits via `onSuccessUpdateEmail`
