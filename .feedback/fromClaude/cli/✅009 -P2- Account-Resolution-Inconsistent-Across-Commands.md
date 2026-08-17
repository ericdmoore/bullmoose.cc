# 009 -P2- Account resolution is inconsistent across commands

**Subsystem:** cli · **Severity:** MEDIUM · **Fix class:** CHANGE-CODE

Two related defects in how `--account` is interpreted. Both are "the same selector means different
things depending on which command you typed".

## A. `show` ignores `--account` entirely

`docs/cli.md:40` declares `--account` a **global** selector; `:425` documents `show <emailId> [--json]`.

But `main.ts:845-847` queries `WHERE account_id = ? AND id = ?` bound to `settings.accountId` only.
It never reads `opts.account`, and never does the owner lookup that `read` performs one command
earlier (`main.ts:694-699`, `SELECT account_id FROM emails WHERE id = ?`).

**The failure is actively misleading:** `bullmoose log` defaults to _all_ accounts (`main.ts:781`),
so it prints ids from every account. Feeding a non-default account's id to `show` yields:

> `<id> not in local db (run: bullmoose sync)` (`main.ts:849`)

which is **false**, and sends the user to re-sync data they already have. `--account` doesn't help.

## B. Ambiguous selectors resolve silently on the write path, and hard-error on the read path

`selectAccounts()` (`db.ts:171-194`) matches by **substring** (`:183-189`) and returns an array.

| Command                          | On multiple matches                                  |
| -------------------------------- | ---------------------------------------------------- |
| `send` (`main.ts:344-348`)       | takes `[0]` **silently**                             |
| `read` (`main.ts:688`)           | takes `[0]` silently                                 |
| `vacation` (`main.ts:543`)       | takes `[0]` silently                                 |
| `contacts` (`contacts.ts:72-83`) | **refuses** — `--account "<sel>" matches N accounts` |
| `calendar` (`calendar.ts:89-97`) | **refuses**                                          |

So on a multi-account login, `bullmoose send --account @bullmoose.cc` **silently picks a sender**,
while `bullmoose contacts list --account @bullmoose.cc` refuses to guess.

Guessing on the _send_ path is exactly backwards — sending from the wrong identity is the one
outcome you can't undo.

Related: `main.ts:370-373` falls back to `identities[0]` when `--from` matches no identity, while a
bad `--identity` is a hard error at `:374-379`. Same inconsistency, one function apart.
