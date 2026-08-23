# Installing the bullmoose CLI

One static Go binary, no runtime. Releases are cut by
`.github/workflows/release-cli.yml` from tags matching `cli-go/v*` and land on
the [GitHub releases page](https://github.com/ericdmoore/bullmoose.cc/releases)
with a `checksums.txt`.

## Download a release

Pick the artifact for your platform:

| platform | artifact |
|---|---|
| macOS (Apple silicon) | `bullmoose_<version>_darwin_arm64` |
| macOS (Intel) | `bullmoose_<version>_darwin_amd64` |
| Linux (arm64) | `bullmoose_<version>_linux_arm64` |
| Linux (x86-64) | `bullmoose_<version>_linux_amd64` |
| Windows (x86-64) | `bullmoose_<version>_windows_amd64.exe` |

Then verify, rename, and put it on your PATH — for example, macOS on Apple
silicon:

```sh
V=v0.1.0   # the version you downloaded
curl -LO "https://github.com/ericdmoore/bullmoose.cc/releases/download/cli-go%2F$V/bullmoose_${V}_darwin_arm64"
curl -LO "https://github.com/ericdmoore/bullmoose.cc/releases/download/cli-go%2F$V/checksums.txt"
shasum -a 256 --check --ignore-missing checksums.txt   # must say OK
chmod +x "bullmoose_${V}_darwin_arm64"
mv "bullmoose_${V}_darwin_arm64" ~/bin/bullmoose
```

(`%2F` is the `/` in the tag `cli-go/v0.1.0`, URL-encoded — release asset URLs
embed the full tag name.)

On **macOS**, a browser- or curl-downloaded binary is quarantined by
Gatekeeper; releases are not (yet) notarized, so clear the flag once:

```sh
xattr -d com.apple.quarantine ~/bin/bullmoose
```

Confirm what you installed — the binary names its own build:

```sh
bullmoose version
# bullmoose v0.1.0 darwin/arm64 go1.26.7 2f89b4f1a2b3
```

## Build from source

Any Go ≥ the `toolchain` pin in `cli-go/go.mod` (GOTOOLCHAIN fetches the exact
one automatically):

```sh
git clone https://github.com/ericdmoore/bullmoose.cc
cd bullmoose.cc/cli-go
go build -trimpath -o ~/bin/bullmoose .
```

A source build reports `dev` plus its commit from the VCS stamp — so a support
conversation can still pin it to a tree.

## Nothing needs Node

Since `cli-go/v0.2.0` every help-listed command — login, send, read, sync,
watch, admin, `agent serve` and all — runs from the one static binary. The
Node CLI that this binary strangler-replaced was removed from the repository
on 2026-08-22 (`.plans/s08-go-cli`); there is no delegation, no `node` on the
PATH required, and no second implementation to disagree with this one.
