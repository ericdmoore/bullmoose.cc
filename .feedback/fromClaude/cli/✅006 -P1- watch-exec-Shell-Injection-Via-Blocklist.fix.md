# FIX — 006 -P1- `watch --exec` shell injection

## Proposal

**Stop interpolating. Pass the values as environment variables.**

```js
const child = spawn("sh", ["-c", template], {
  env: {
    ...process.env,
    BM_ID:      row.id,
    BM_FROM:    from,
    BM_SUBJECT: row.subject,
    BM_PREVIEW: row.preview.slice(0, 120),
    BM_ACCOUNT: accountLabel(ch.account),
  },
  stdio: ["ignore", "inherit", "inherit"],   // see below
});
```

Usage becomes:

```sh
bullmoose watch --exec 'notify-send "$BM_FROM: $BM_SUBJECT"'
```

The shell never *parses* attacker-controlled bytes — the value lands in the environment and the
user's quoting governs how it is expanded. This is the same reason `xargs -0` and `git`'s hook
environment work the way they do.

`shellSafe()` (`watch.ts:244-246`) can then be deleted rather than hardened. **Do not** try to fix it
by extending the blocklist — shell metacharacter escaping is a losing game, and the failure mode is
silent RCE.

## Breaking change — handle deliberately

`{id}`/`{from}`/`{subject}`/`{preview}` templates stop substituting. Options:

- **Preferred:** support both for one release — if the template contains `{`-placeholders, print a
  deprecation notice **to stderr** and substitute as today; env vars always set. Remove the
  substitution path next release.
- Cleaner but ruder: hard-switch and document it in the help text.

Either way `docs/cli.md:244`'s example must change in the same commit, since it *is* the
documentation people copy.

## Fix the stdio bleed at the same time

Give the hook its own stdout so it can't corrupt `--json`. `["ignore", "inherit", "inherit"]` keeps
hook output visible on the terminal but should be revisited: with `--json` active, the hook's stdout
should arguably go to stderr or `/dev/null`, since stdout is a data stream. See the s05 I/O contract
(`.plans/s05-cli-crud/arch.md` §1.1) — this is the same "stdout is data" rule.

## Bread-crumbs

- The `--exec` hook is fire-and-forget (`watch.ts:189` has an `error` handler but no `await`) — that
  is intentional and should stay; a slow hook must not stall the watch loop.
- **Test:** drive `runHook` with a subject of `` x; touch /tmp/pwned `` and assert the file is not
  created. Cheap, and it is the regression that matters.
- Check whether anything on the box already uses `--exec` with `{}` placeholders before choosing the
  hard-switch option — the hermes bridge is the likely consumer.
