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

## What still needs Node (temporary)

The binary answers every help-listed command natively **except `agent`**,
which transparently delegates to the Node CLI (`packages/cli`) until its port
lands (`.plans/s42-go-native`). On a machine without Node, everything else —
login, send, read, sync, watch, admin, the works — runs from the one binary;
only `bullmoose agent …` would refuse.

The Node CLI itself is retired only when the trace metric
(`BULLMOOSE_TRACE`) has reported zero delegated invocations for a full
release — `.plans/s08-go-cli/devPlan.md` T7 is the criterion, not vibes.
