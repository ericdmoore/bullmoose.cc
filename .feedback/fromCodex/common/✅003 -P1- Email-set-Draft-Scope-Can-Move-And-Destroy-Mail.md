# 003 -P1- `Email/set` gates moves, flags, and destroys with only `draft`

**Subsystem:** common (`services/jmap` mail methods) · **Severity:** HIGH (authorization) · **Fix class:** CHANGE-CODE + ADD-TEST

## The defect

`services/jmap/src/methods/email.ts:226-230` gates the entire `Email/set` method with:

```ts
const access = await requireAccount(ctx, args, "draft");
```

That one check covers every operation in the method:

- create drafts (`email.ts:249-260`)
- update keywords and mailbox membership (`email.ts:262-277`)
- destroy emails (`email.ts:279-291`)

So a token intended only to draft mail can mark existing messages read/unread, move them between mailboxes, and permanently destroy them.

## Why it bites

The scope vocabulary is more granular than this method gate: `annotate`, `draft`, `move`, `send`, and `delete` exist separately. The current method collapses three different write classes into `draft`.

This matters for app-passwords and agents. A token granted to compose drafts should not be able to delete or reorganize the mailbox.

## Related path

`EmailSubmission/set` calls `applyEmailPatch` for `onSuccessUpdateEmail` at `services/jmap/src/methods/submission.ts:69-77` after only requiring `send` at `submission.ts:38`. The usual patch is "move Drafts -> Sent", but the patch helper itself can edit arbitrary mailboxIds/keywords on the submitted email.

## Cross-references

This is separate from Claude issue 001 (`mail` covers too many scopes). Even after `mail` becomes a closed alias, `draft` still unlocks delete/move through this method.
