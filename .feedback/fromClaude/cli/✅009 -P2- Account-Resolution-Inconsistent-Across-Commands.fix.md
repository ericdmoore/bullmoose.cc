# FIX — 009 -P2- Account resolution inconsistent across commands

## Proposal

**Promote the strict resolver into `db.ts` and use it everywhere a single account is required.**

`contacts.ts:72-83` and `calendar.ts:89-97` already have the correct behaviour — refuse on ambiguity.
Lift it:

```ts
// packages/cli/src/db.ts
export function pickAccount(settings, selector) {
  const matches = selectAccounts(settings, selector);
  if (matches.length === 0) fail(`no account matches "${selector}"`);           // exit 3
  if (matches.length > 1) {
    fail(`--account "${selector}" matches ${matches.length} accounts:\n` +
         matches.map(a => `  ${accountLabel(a)}`).join("\n"));                   // exit 2
  }
  return matches[0];
}
```

Then replace the `[0]` takes at `main.ts:344-348` (send), `:688` (read), `:543` (vacation), and the
`identities[0]` fallback at `:370-373`.

**Rule to state in the help text:** *a selector that matches more than one account is an error, not a
choice.* Only an explicit `--account default` (or a single-account login) resolves implicitly.

## For `show` specifically

Copy `read`'s resolution (`main.ts:694-699`): look the id up across the accounts the selector allows,
and only then bind. Two commands one line apart in the docs should not disagree about what an id
means.

While there, fix the error text at `main.ts:849` — "not in local db (run: bullmoose sync)" should
distinguish *unknown id* from *id belongs to an account you didn't select*. The second case should
name the owning account.

## Breaking-change note

Scripts relying on substring-match-then-pick-first will start erroring. That is the intended
correction, but it deserves a line in the help text and a mention in the commit — someone's cron job
may depend on the sloppy behaviour.

## Bread-crumbs

- `selectAccounts` stays as-is (it is correct for the multi-account commands like `log` and `sync`
  that legitimately fan out); `pickAccount` is the single-account wrapper.
- **Test:** a two-account fixture where a substring matches both; assert `send` exits non-zero, and
  assert `log` still fans out to both.
- Ties into the s05 exit-code table (`.plans/s05-cli-crud/arch.md` §1.5): no-match → 3, ambiguous → 2.
